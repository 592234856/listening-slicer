# -*- coding: utf-8 -*-
"""faster-whisper 词级时间戳转录封装（含可选 WhisperX 精对齐开关）。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Callable, List, Optional

# 国内默认走 hf-mirror，可用环境变量覆盖
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")


def _is_model_cached(model_size: str, download_root: Optional[str]) -> bool:
    """检查模型是否已完整下载（有快照目录且含 model.bin），避免断网时联网校验失败。"""
    import glob

    base = download_root or os.environ.get(
        "HF_HOME",
        os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub"),
    )
    repo = f"models--Systran--faster-whisper-{model_size}"
    bins = glob.glob(os.path.join(base, repo, "snapshots", "*", "model.bin"))
    return bool(bins)


@dataclass
class Word:
    text: str
    start: float
    end: float


@dataclass
class Transcription:
    words: List[Word] = field(default_factory=list)
    duration: float = 0.0
    language: str = "en"


class ASREngine:
    def __init__(
        self,
        model_size: str = "small",
        model_dir: Optional[str] = None,
        device: Optional[str] = None,
        compute_type: Optional[str] = None,
    ):
        from faster_whisper import WhisperModel

        self.device = device or "cpu"
        if compute_type is None:
            compute_type = "int8" if self.device == "cpu" else "float16"
        # 模型已在本地时强制离线，防止 faster-whisper 联网校验因网络抖动报错
        if _is_model_cached(model_size, model_dir):
            os.environ.setdefault("HF_HUB_OFFLINE", "1")
            os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
        self.model = WhisperModel(
            model_size,
            device=self.device,
            compute_type=compute_type,
            download_root=model_dir,
        )

    def transcribe(
        self,
        audio_path: str,
        language: str = "en",
        use_whisperx: bool = False,
        cancel_check: Optional[Callable[[], bool]] = None,
        progress_cb: Optional[Callable[[float, str], None]] = None,
    ) -> Transcription:
        segments, info = self.model.transcribe(
            audio_path,
            language=language,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
        )
        duration = float(getattr(info, "duration", 0.0) or 0.0)

        words: List[Word] = []
        seg_dicts = []  # whisperx 精对齐用
        for seg in segments:
            if cancel_check and cancel_check():
                raise InterruptedError("已取消")
            seg_words = []
            for w in (seg.words or []):
                if w.start is None or w.end is None:
                    continue
                wd = Word(text=w.word, start=float(w.start), end=float(w.end))
                words.append(wd)
                seg_words.append({"word": w.word, "start": wd.start, "end": wd.end})
            seg_dicts.append({"start": seg.start, "end": seg.end, "text": seg.text, "words": seg_words})
            if progress_cb and duration > 0:
                progress_cb(min(0.99, float(seg.end) / duration), "识别中")

        if use_whisperx:
            refined = _try_whisperx_align(seg_dicts, audio_path, language)
            if refined is not None:
                words = refined

        return Transcription(words=words, duration=duration, language=language)


def _try_whisperx_align(seg_dicts, audio_path: str, language: str) -> Optional[List[Word]]:
    """可选 WhisperX forced alignment；未安装或失败时回退 None。"""
    try:
        import whisperx  # noqa: 依赖较重，懒加载
    except ImportError:
        return None
    try:
        device = "cpu"
        model_a, metadata = whisperx.load_align_model(language_code=language, device=device)
        audio = whisperx.load_audio(audio_path)
        result = whisperx.align(seg_dicts, model_a, metadata, audio, device, return_char_alignments=False)
        out: List[Word] = []
        for seg in result.get("segments", []):
            for w in seg.get("words", []):
                if w.get("start") is not None and w.get("end") is not None:
                    out.append(Word(text=w["word"], start=float(w["start"]), end=float(w["end"])))
        return out or None
    except Exception:
        return None
