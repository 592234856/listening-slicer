# -*- coding: utf-8 -*-
"""ffmpeg 音频切片 + 课件 JSON 导出。"""
from __future__ import annotations

import json
import os
import subprocess
from typing import List, Optional

from matcher import MaterialSpan


def find_ffmpeg() -> str:
    """优先级：环境变量 YP_FFMPEG > imageio-ffmpeg 内置 > PATH。"""
    env = os.environ.get("YP_FFMPEG")
    if env and os.path.isfile(env):
        return env
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    return "ffmpeg"


def cut_clip(ffmpeg: str, src: str, start: float, end: float, out_path: str) -> None:
    """切出 [start, end] 区间。mp3 输出重编码以保证边界精确；wav 直接 copy。"""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    if out_path.lower().endswith(".wav"):
        codec_args = ["-c", "copy"]
    else:
        codec_args = ["-acodec", "libmp3lame", "-q:a", "4"]
    cmd = [
        ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
        "-i", src, *codec_args, out_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg 切片失败: {proc.stderr.strip()[:300]}")


def export_courseware(
    spans: List[MaterialSpan],
    src_audio: str,
    out_dir: str,
    duration: float,
    title: str = "精听课件",
    ffmpeg: Optional[str] = None,
    make_clips: bool = True,
) -> str:
    """切分音频并生成 courseware.json，返回 JSON 路径。"""
    ffmpeg = ffmpeg or find_ffmpeg()
    os.makedirs(out_dir, exist_ok=True)
    clips_dir = os.path.join(out_dir, "clips")
    if make_clips:
        os.makedirs(clips_dir, exist_ok=True)

    # 源音频拷入课件目录（整段播放用）
    src_name = os.path.basename(src_audio)
    src_ext = os.path.splitext(src_name)[1].lower() or ".mp3"
    course_src = os.path.join(out_dir, f"source{src_ext}")
    if os.path.abspath(src_audio) != os.path.abspath(course_src):
        import shutil
        shutil.copyfile(src_audio, course_src)

    materials = []
    for sp in spans:
        clip_rel = None
        if make_clips and sp.end > sp.start:
            clip_name = f"material_{sp.id:02d}.mp3"
            cut_clip(ffmpeg, src_audio, sp.start, sp.end, os.path.join(clips_dir, clip_name))
            clip_rel = f"clips/{clip_name}"
        materials.append({
            "id": sp.id,
            "title": sp.title,
            "text": sp.text,
            "start": sp.start,
            "end": sp.end,
            "clip": clip_rel,
            "match_rate": sp.match_rate,
            "needs_review": sp.needs_review,
            "sentences": [
                {"text": s.text, "speaker": s.speaker, "start": s.start, "end": s.end, "matched": s.matched}
                for s in sp.sentences
            ],
        })

    data = {
        "version": 1,
        "title": title,
        "source_audio": f"source{src_ext}",
        "duration": round(duration, 3),
        "materials": materials,
    }
    json_path = os.path.join(out_dir, "courseware.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return json_path
