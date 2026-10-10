# -*- coding: utf-8 -*-
"""PDF 文本提取（PyMuPDF）+ OCR 回退（RapidOCR）。

策略：
1. 先用文字层提取；
2. 扫描版（无文字层）或文字层乱码（特殊字体编码，如方正 FzBookMaker）→ 自动 OCR；
3. OCR 文本做页眉页脚过滤、说话人标签/换行连字符等清洗。
"""
from __future__ import annotations

import re
from typing import Callable, Optional, Tuple

# 常用英文功能词：用于判断提取内容是否为正常英语文本
COMMON_EN_WORDS = {
    "the", "be", "to", "of", "and", "a", "in", "that", "have", "it",
    "for", "not", "on", "with", "he", "as", "you", "do", "at", "this",
    "but", "his", "by", "from", "they", "we", "say", "her", "she", "or",
    "an", "will", "my", "one", "all", "would", "there", "their", "what",
    "is", "are", "was", "were", "has", "had", "can", "could", "about",
    "when", "which", "how", "who", "if", "out", "so", "no", "him", "them",
}

# OCR 文本噪声行：页眉页脚（如「【高二英语·参考答案第1页(共8页)】」「·24-196B·」）
_NOISE_LINE_RES = [
    re.compile(r"^[【\[]?.*第\s*\d+\s*页.*[】\]]?$"),
    re.compile(r"^[·・.\-]*\s*\d{2,4}[-–]\d+[A-Za-z]?\s*[·・.\-]*$"),
]
# OCR 说话人标签规范化：M. / M．/ M: → M:
_SPEAKER_PREFIX_RE = re.compile(
    r"^\s*([MW])\s*[\.．:：、]\s*(?=[A-Za-z\"])"
)


def looks_like_garbage(text: str) -> bool:
    """检测英文内容是否疑似乱码。

    判据：文本确有一定量中文（说明是中英混排试卷）且有英文字符，
    但英文常用功能词几乎不出现（正常英语材料 the/and/you 等会大量出现）。
    对纯中文/极短文本不判乱码。
    """
    cjk = len(re.findall(r"[一-鿿]", text))
    tokens = re.findall(r"[A-Za-z]{2,}", text)
    alpha_chars = sum(len(t) for t in tokens)
    if cjk < 50 or alpha_chars < 40:
        return False
    hits = sum(1 for t in tokens if t.lower() in COMMON_EN_WORDS)
    # 正常英文材料常用词命中率通常 15%+ 且数量多；乱码只有零星随机碰撞
    return (hits / max(1, len(tokens))) < 0.08 and hits < 8


def _clean_ocr_lines(lines: list[str]) -> str:
    """清洗 OCR 结果：去页眉页脚、规范说话人标签、还原换行连字符。"""
    out: list[str] = []
    for raw in lines:
        ln = raw.strip()
        if not ln:
            continue
        if any(rx.search(ln) for rx in _NOISE_LINE_RES):
            continue
        m = _SPEAKER_PREFIX_RE.match(ln)
        if m:
            ln = f"{m.group(1)}: " + ln[m.end():].lstrip()
        # W:Oh → W: Oh（标签后缺空格）
        ln = re.sub(r"^([MW]):(?=[A-Za-z])", r"\1: ", ln)
        out.append(ln)

    text = "\n".join(out)
    # 换行连字符还原：prac-\ntice → practice
    text = re.sub(r"([A-Za-z])-\n([A-Za-z])", r"\1\2", text)
    return text.strip()


_OCR_SINGLETON = None


def _get_ocr():
    global _OCR_SINGLETON
    if _OCR_SINGLETON is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as e:
            raise RuntimeError(
                "该 PDF 需要 OCR 识别，请确认已安装 rapidocr-onnxruntime"
            ) from e
        _OCR_SINGLETON = RapidOCR()
    return _OCR_SINGLETON


def _ocr_pdf(path: str, dpi: int = 200,
             progress_cb: Optional[Callable[[int, int], None]] = None) -> str:
    try:
        try:
            import pymupdf as fitz
        except ImportError:
            import fitz  # type: ignore
    except ImportError as e:
        raise RuntimeError("解析 PDF 需要安装 PyMuPDF") from e

    ocr = _get_ocr()
    doc = fitz.open(path)
    page_lines: list[str] = []
    try:
        n = doc.page_count
        for i, page in enumerate(doc):
            if progress_cb:
                progress_cb(i, n)
            pix = page.get_pixmap(dpi=dpi)
            result, _ = ocr(pix.tobytes("png"))
            if result:
                for item in result:
                    try:
                        page_lines.append(item[1])
                    except (IndexError, TypeError):
                        continue
            page_lines.append("")  # 页间空行
        if progress_cb:
            progress_cb(n, n)
    finally:
        doc.close()
    return _clean_ocr_lines(page_lines)


def extract_pdf_text(
    path: str,
    progress_cb: Optional[Callable[[str, int, int], None]] = None,
) -> Tuple[str, bool]:
    """提取 PDF 文本，必要时自动 OCR。

    返回 (文本, 是否使用了 OCR)。
    progress_cb(stage, done, total)：OCR 时回报页码进度。
    """
    try:
        try:
            import pymupdf as fitz  # PyMuPDF >= 1.24 新包名
        except ImportError:
            import fitz  # type: ignore  # 旧版包名
    except ImportError as e:
        raise RuntimeError("解析 PDF 需要安装 PyMuPDF：pip install PyMuPDF") from e

    parts: list[str] = []
    total_chars = 0
    doc = fitz.open(path)
    try:
        for page in doc:
            t = page.get_text("text") or ""
            total_chars += len(t.strip())
            parts.append(t)
        page_count = doc.page_count
    finally:
        doc.close()

    is_scanned = (total_chars / max(1, page_count)) < 20
    raw_text = "\n".join(parts)
    garbage = looks_like_garbage(raw_text)

    if is_scanned or garbage:
        def _cb(done: int, total: int):
            if progress_cb:
                progress_cb("ocr", done, total)
        return _ocr_pdf(path, progress_cb=_cb), True

    # 合并多余空行，保留段落间隔
    lines = [ln.rstrip() for ln in raw_text.replace("\r\n", "\n").split("\n")]
    cleaned: list[str] = []
    blank = 0
    for ln in lines:
        if ln.strip():
            cleaned.append(ln)
            blank = 0
        else:
            blank += 1
            if blank <= 1:
                cleaned.append("")
    return "\n".join(cleaned).strip(), False
