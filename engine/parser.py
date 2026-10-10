# -*- coding: utf-8 -*-
"""试卷文本清洗与中英文分离。

输入混杂文本（中文题干 + 选项 + 英文听力原文），输出按材料分组的英文段落。
规则：
1. 剔除选项行（A. B. C. D. / 全角字母）、题号行（6. ...）、结构性标题行。
2. 剔除 CJK 占比 >30% 或命中中文题干关键词的行。
3. 按 "Text N" / "Conversation N" / "Passage N" / "第X段..." 标记分组；
   无标记时按空行切出的连续英文块各自成组。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

CJK_RE = re.compile(r"[一-鿿　-〿]")
OPTION_LINE_RE = re.compile(r"^\s*[A-EＡ-Ｅ]\s*[\.．、,:：]")
MULTI_OPTION_RE = re.compile(r"[A-EＡ-Ｅ]\s*[\.．、]")
QNUM_LINE_RE = re.compile(r"^\s*\d{1,2}\s*[\.．、]")
STRUCT_LINE_RE = re.compile(
    r"^\s*(Part|Section|Questions?\s+\d|Directions|Listening\s+Comprehension)\b",
    re.IGNORECASE,
)
# 材料分组标记（允许行首带括号，如 OCR 识别出的 "(Text 1)"）
# 注意：只认明确的材料标记；「听下面X段对话」是中文题干，不能当材料标记
MARKER_RES = [
    re.compile(r"^\s*[(（]?\s*(Text\s+\d+)\s*[)）]?\b\s*[:：.]?", re.IGNORECASE),
    re.compile(r"^\s*[(（]?\s*(Conversation\s+(One|Two|Three|Four|\d+))\s*[)）]?\b\s*[:：.]?", re.IGNORECASE),
    re.compile(r"^\s*[(（]?\s*(Passage\s+(One|Two|Three|Four|\d+))\s*[)）]?\b\s*[:：.]?", re.IGNORECASE),
    re.compile(r"^\s*[(（]?\s*(第\s*[一二三四五六七八九十\d]+\s*段\s*(对话|独白|材料|短文))\s*[)）]?\s*[:：.]?"),
]
CN_STEM_KEYWORDS = (
    "听下面", "回答", "选出", "最佳选项", "小题", "满分", "注意事项",
    "听力考试", "试音", "第一节", "第二节", "第三节", "第四节",
)
SPEAKER_RE = re.compile(
    r"^\s*(M|W|Man|Woman|Narrator|Reporter|Host|Guest|Interviewer|Boy|Girl|Speaker\s*\d*)\s*[:：]\s*",
    re.IGNORECASE,
)
SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[\"'“‘(\[]*[A-Z0-9])")


# 答案串：如 "21-23ACB24-27BDBA28-31ADCD36-40FGDEB"
# 听力原文之后紧跟参考答案区，命中后后面的范文/解析都不应再收入
ANSWER_KEY_RE = re.compile(r"(?:\d{1,2}\s*[-–]\s*\d{1,2}\s*[A-H]{1,6}\s*){2,}")


@dataclass
class Sentence:
    text: str
    speaker: Optional[str] = None


@dataclass
class Material:
    id: int
    title: str
    text: str
    sentences: List[Sentence] = field(default_factory=list)


def _cjk_ratio(s: str) -> float:
    chars = [c for c in s if not c.isspace()]
    if not chars:
        return 0.0
    return len(CJK_RE.findall(s)) / len(chars)


def _is_option_line(line: str) -> bool:
    if OPTION_LINE_RE.match(line):
        return True
    # 一行内出现 2 个及以上选项标记（如 "A. ... B. ... C. ..."）
    if len(MULTI_OPTION_RE.findall(line)) >= 2 and _cjk_ratio(line) < 0.3:
        if len(line.split()) <= 40:
            return True
    return False


def _match_marker(line: str) -> Optional[re.Match]:
    for rx in MARKER_RES:
        m = rx.match(line)
        if m:
            return m
    return None


def _is_cn_stem(line: str) -> bool:
    return any(k in line for k in CN_STEM_KEYWORDS)


def _is_kept_english(line: str) -> bool:
    """判断一行是否为应保留的英文听力原文。"""
    if _is_option_line(line):
        return False
    if QNUM_LINE_RE.match(line):
        return False
    if _is_cn_stem(line):
        return False
    if _cjk_ratio(line) > 0.3:
        return False
    if STRUCT_LINE_RE.match(line) and len(line.split()) <= 8:
        return False
    # 至少含一个英文字母才算英文内容
    return any(c.isascii() and c.isalpha() for c in line)


def split_sentences(text: str) -> List[Sentence]:
    """把英文材料正文切成句子，识别对白说话人标签。"""
    out: List[Sentence] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        speaker = None
        m = SPEAKER_RE.match(line)
        if m:
            speaker = m.group(1).strip()
            line = line[m.end():].strip()
        if not line:
            continue
        for p in SENT_SPLIT_RE.split(line):
            p = p.strip()
            if p:
                out.append(Sentence(text=p, speaker=speaker))
    return out


def _build_materials(items: List[tuple]) -> List[Material]:
    out: List[Material] = []
    for i, (title, body) in enumerate(items, 1):
        body = body.strip()
        if not body:
            continue
        sentences = split_sentences(body)
        if not sentences:
            continue
        flat_text = " ".join(s.text for s in sentences)
        out.append(Material(id=len(out) + 1, title=title, text=flat_text, sentences=sentences))
    return out


def parse_paper_text(raw_text: str) -> List[Material]:
    """主入口：解析试卷文本，返回英文材料分组列表。"""
    lines = [ln.strip() for ln in raw_text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    has_marker = any(_match_marker(ln) for ln in lines if ln)

    if has_marker:
        groups: List[tuple] = []  # (title, [lines])
        cur_title: Optional[str] = None
        cur: List[str] = []

        def flush():
            nonlocal cur_title, cur
            if cur:
                groups.append((cur_title, cur))
            cur_title, cur = None, []

        for line in lines:
            if not line:
                continue
            m = _match_marker(line)
            if m:
                flush()
                cur_title = re.sub(r"\s+", " ", m.group(1)).strip()
                rest = line[m.end():].strip()
                # 标记行剩余内容只有确实是英文原文时才收入（中文指令行直接丢弃）
                if rest and _is_kept_english(rest):
                    cur.append(rest)
                continue
            # 进入听力材料区后遇到答案串 → 听力原文结束，后面的范文/解析全部丢弃
            if cur_title is not None and ANSWER_KEY_RE.search(line):
                flush()
                break
            # 第一个材料标记之前的内容（试音、例题等）不属于任何材料，丢弃
            if cur_title is not None and _is_kept_english(line):
                cur.append(line)
        flush()
        return _build_materials([(t or f"Text {i + 1}", "\n".join(bl)) for i, (t, bl) in enumerate(groups)])

    # 无标记：空行分块，每块一个材料
    blocks: List[List[str]] = []
    cur_block: List[str] = []
    for line in lines:
        if not line:
            if cur_block:
                blocks.append(cur_block)
                cur_block = []
            continue
        if _is_kept_english(line):
            cur_block.append(line)
    if cur_block:
        blocks.append(cur_block)
    return _build_materials([(f"Text {i + 1}", "\n".join(b)) for i, b in enumerate(blocks)])
