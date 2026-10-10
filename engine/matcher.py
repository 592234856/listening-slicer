# -*- coding: utf-8 -*-
"""英文材料文本 ↔ ASR 词流的对齐（LCS）与句子级时间切分。"""
from __future__ import annotations

import difflib
import re
from collections import namedtuple
from dataclasses import dataclass, field
from typing import List, Optional

from asr_align import Word
from parser import Material

NON_ALNUM_RE = re.compile(r"[^a-z0-9\s]")
DEFAULT_MIN_MATCH = 0.8
# 匹配块主链的最大时间间隔：段间答题停顿一般 10s+，材料内部停顿一般 <3s。
# whisper 在长静音中常产生幻听词（重复短语/无关词），会以零散小块形式混入
# LCS 结果，把句子/材料的起点拖早，造成切片开头一段空白——按时间主链剔除。
MATERIAL_MAX_GAP = 6.0
SENTENCE_MAX_GAP = 4.0
# LCS 块内相邻词的时间间隔超过此值即切断：whisper 在停顿中会产生幻听词，
# 且幻听词与后一段真实语音在 token 序列上是连续的，会被 LCS 拼进同一块
# （如幻听 "How"@251.9 与真实 "much are these bags"@264.9 连成一块），
# 按词间大间隔切开才能剔除幻听头部。
WORD_GAP = 1.5
# 整体匹配率过低时的强锚回退阈值：存在 ≥ 此 token 数的连续命中块即给出估计区间
STRONG_ANCHOR = 4
# 插值估算语速：听力材料约 3 词/秒，每 token 0.32s
EST_SEC_PER_TOK = 0.32


def norm_tokens(text: str) -> List[str]:
    """归一化为可比较的 token 序列：小写、去标点。"""
    text = NON_ALNUM_RE.sub(" ", text.lower())
    return [t for t in text.split() if t]


@dataclass
class SentenceSpan:
    text: str
    speaker: Optional[str]
    start: float
    end: float
    matched: bool = True


@dataclass
class MaterialSpan:
    id: int
    title: str
    text: str
    start: float
    end: float
    match_rate: float
    needs_review: bool
    sentences: List[SentenceSpan] = field(default_factory=list)


def _lcs_blocks(query: List[str], cand: List[str], min_block: int) -> list:
    """在 cand 中找 query 的 LCS 匹配块列表（b 升序），无匹配返回 []。"""
    if not query or not cand:
        return []
    sm = difflib.SequenceMatcher(None, query, cand, autojunk=False)
    return [b for b in sm.get_matching_blocks() if b.size >= max(1, min_block)]


def _chain_blocks(blocks: list, words: List[Word], tok2word: List[int],
                  offset: int, max_gap: float) -> list:
    """按时间距离保留主链块：以最大块为锚向两侧扩展，相邻块时间间隔超过
    max_gap 即截断。返回保留块（按 b 升序）。"""
    if len(blocks) <= 1:
        return blocks
    bl = sorted(blocks, key=lambda b: b.b)

    def t0(b) -> float:
        return words[tok2word[b.b + offset]].start

    def t1(b) -> float:
        return words[tok2word[b.b + offset + b.size - 1]].end

    anchor = max(range(len(bl)), key=lambda i: bl[i].size)
    keep = [False] * len(bl)
    keep[anchor] = True
    j = anchor
    for i in range(anchor - 1, -1, -1):
        if t0(bl[j]) - t1(bl[i]) <= max_gap:
            keep[i] = True
            j = i
        else:
            break
    j = anchor
    for i in range(anchor + 1, len(bl)):
        if t0(bl[i]) - t1(bl[j]) <= max_gap:
            keep[i] = True
            j = i
        else:
            break
    return [b for b, k in zip(bl, keep) if k]


_SubBlk = namedtuple("_SubBlk", ["b", "size"])


def _split_blocks_by_gap(blocks: list, words: List[Word], tok2word: List[int],
                         offset: int, min_block: int) -> list:
    """把每个 LCS 块按词间时间间隔切成子块（幻听与真实语音的拼接处断开），
    并丢弃小于 min_block 的子块。返回按 b 升序的子块列表。"""
    out: list = []
    for b in blocks:
        seg_start = 0  # 块内起点
        for i in range(1, b.size):
            prev_end = words[tok2word[offset + b.b + i - 1]].end
            cur_start = words[tok2word[offset + b.b + i]].start
            if cur_start - prev_end > WORD_GAP:
                if i - seg_start >= min_block:
                    out.append(_SubBlk(b.b + seg_start, i - seg_start))
                seg_start = i
        if b.size - seg_start >= min_block:
            out.append(_SubBlk(b.b + seg_start, b.size - seg_start))
    return sorted(out, key=lambda x: x.b)


def _lcs_span(query: List[str], cand: List[str], words: List[Word],
              tok2word: List[int], offset: int, min_block: int = 3,
              max_gap: float = MATERIAL_MAX_GAP) -> tuple:
    """LCS + 块内密度切分 + 时间主链过滤。返回 (cand_start, cand_end_inclusive,
    matched_tokens)，未匹配返回 (-1, -1, 0)。"""
    blocks = _lcs_blocks(query, cand, min_block)
    if not blocks:
        return -1, -1, 0
    blocks = _split_blocks_by_gap(blocks, words, tok2word, offset, min_block)
    if not blocks:
        return -1, -1, 0
    blocks = _chain_blocks(blocks, words, tok2word, offset, max_gap)
    if not blocks:
        return -1, -1, 0
    start = blocks[0].b
    end = blocks[-1].b + blocks[-1].size - 1
    matched = sum(b.size for b in blocks)
    return start, end, matched


def align_materials(
    materials: List[Material],
    words: List[Word],
    duration: float,
    min_match: float = DEFAULT_MIN_MATCH,
    pad_head: float = 1.2,
    pad_tail: float = 0.25,
) -> List[MaterialSpan]:
    """把每个英文材料对齐到词流，返回带起止时间与句子时间轴的结果。"""
    # ASR token 序列（跳过归一化为空的词，如纯标点）
    tok2word: List[int] = []
    tokens: List[str] = []
    for i, w in enumerate(words):
        t = norm_tokens(w.text)
        if t:
            # 一个 whisper word 可能拆出多个 token（如 don't → don t）
            for tk in t:
                tokens.append(tk)
                tok2word.append(i)

    results: List[MaterialSpan] = []
    search_from = 0  # 顺序约束：下一段只在上一段之后找

    for mat in materials:
        q = norm_tokens(mat.text)
        cand = tokens[search_from:]
        s, e, matched = _lcs_span(q, cand, words, tok2word, search_from,
                                  min_block=2, max_gap=MATERIAL_MAX_GAP)
        rate = (matched / len(q)) if q else 0.0

        if s < 0 or rate < 0.3:
            # 整体匹配率过低（多为 ASR 漏录整段语音）：尝试强锚回退——
            # 只要存在 ≥ STRONG_ANCHOR 个 token 的连续命中块，就用它的位置
            # 给出估计区间并标记需人工确认，而不是直接给 0（人工微调更有据可依）
            s2, e2, _m2 = _lcs_span(q, cand, words, tok2word, search_from,
                                    min_block=STRONG_ANCHOR, max_gap=MATERIAL_MAX_GAP)
            if s2 >= 0:
                abs_s2, abs_e2 = search_from + s2, search_from + e2
                w_s2 = words[tok2word[abs_s2]].start
                w_e2 = words[tok2word[abs_e2]].end
                start2 = max(0.0, w_s2 - 1.2)
                end2 = min(duration, w_e2 + 0.5) if duration > 0 else w_e2 + 0.5
                sent_spans2 = _align_sentences(mat, tokens, tok2word, words, abs_s2, abs_e2)
                results.append(MaterialSpan(
                    id=mat.id, title=mat.title, text=mat.text,
                    start=round(start2, 3), end=round(end2, 3),
                    match_rate=round(rate, 4), needs_review=True,
                    sentences=sent_spans2,
                ))
                search_from = abs_e2 + 1
                continue
            # 完全找不到：标记待人工处理，时间先给 0
            results.append(MaterialSpan(
                id=mat.id, title=mat.title, text=mat.text,
                start=0.0, end=0.0, match_rate=rate, needs_review=True,
                sentences=[SentenceSpan(text=sn.text, speaker=sn.speaker, start=0.0, end=0.0, matched=False)
                           for sn in mat.sentences],
            ))
            continue

        abs_s, abs_e = search_from + s, search_from + e
        w_start = words[tok2word[abs_s]].start
        w_end = words[tok2word[abs_e]].end

        # 第二节材料会读两遍：LCS 把 query 全部消耗在第一遍上，需在 span 之后
        # 再找一次高强度匹配（第二遍朗读），把材料终点扩展到第二遍结尾
        span_e_sent = abs_e  # 句子对齐仍限定在第一遍内，避免锚到第二遍
        look_end = min(len(tokens), abs_e + 1 + int(len(q) * 1.4) + 10)
        cand2 = tokens[abs_e + 1: look_end]
        s2, e2, m2 = _lcs_span(q, cand2, words, tok2word, abs_e + 1,
                               min_block=3, max_gap=MATERIAL_MAX_GAP)
        if s2 >= 0 and q and (m2 / len(q)) >= 0.6:
            abs_e = abs_e + 1 + e2
            w_end = words[tok2word[abs_e]].end

        start = max(0.0, w_start - pad_head)
        end = min(duration, w_end + pad_tail) if duration > 0 else w_end + pad_tail

        sent_spans = _align_sentences(mat, tokens, tok2word, words, abs_s, span_e_sent)
        results.append(MaterialSpan(
            id=mat.id, title=mat.title, text=mat.text,
            start=round(start, 3), end=round(end, 3),
            match_rate=round(rate, 4), needs_review=rate < min_match,
            sentences=sent_spans,
        ))
        search_from = abs_e + 1  # 下一段从本段末尾之后继续

    # 修正相邻段重叠（前段 end 不得晚于后段 start）
    for i in range(1, len(results)):
        prev, cur = results[i - 1], results[i]
        if prev.end > 0 and cur.end > 0 and cur.start < prev.end:
            mid = (prev.end + cur.start) / 2
            prev.end = round(mid, 3)
            cur.start = round(mid, 3)
    return results


def _align_sentences(
    mat: Material,
    tokens: List[str],
    tok2word: List[int],
    words: List[Word],
    span_s: int,
    span_e: int,
) -> List[SentenceSpan]:
    """在材料 span 内逐句对齐；失败的句子后续按比例插值。"""
    spans: List[SentenceSpan] = []
    cursor = span_s
    for sn in mat.sentences:
        q = norm_tokens(sn.text)
        cand = tokens[cursor: span_e + 1]
        s, e, matched = _lcs_span(q, cand, words, tok2word, cursor,
                                  min_block=1, max_gap=SENTENCE_MAX_GAP)
        rate = (matched / len(q)) if q else 0.0
        if s >= 0 and rate >= 0.5:
            abs_s, abs_e = cursor + s, cursor + e
            spans.append(SentenceSpan(
                text=sn.text, speaker=sn.speaker,
                start=round(words[tok2word[abs_s]].start, 3),
                end=round(words[tok2word[abs_e]].end, 3),
                matched=rate >= 0.5,
            ))
            cursor = abs_e + 1
        else:
            spans.append(SentenceSpan(text=sn.text, speaker=sn.speaker, start=-1.0, end=-1.0, matched=False))

    # 插值修补未匹配句子：在前后已知边界间按 token 数比例分配
    mat_start = words[tok2word[span_s]].start
    mat_end = words[tok2word[span_e]].end
    n = len(spans)
    filled = [False] * n
    i = 0
    while i < n:
        if spans[i].matched or filled[i]:
            i += 1
            continue
        # 找该连续失败段的前后锚点
        j = i
        while j < n and not spans[j].matched and not filled[j]:
            j += 1
        group = list(range(i, j))
        prev_end = mat_start
        for k in range(i - 1, -1, -1):
            if spans[k].matched or filled[k]:
                prev_end = spans[k].end
                break
        next_start = mat_end
        for k in range(j, n):
            if spans[k].matched or filled[k]:
                next_start = spans[k].start
                break
        total_tok = sum(max(1, len(norm_tokens(spans[k].text))) for k in group) or 1
        gap = next_start - prev_end
        est_dur = total_tok * EST_SEC_PER_TOK
        if gap < max(0.3, est_dur * 0.5):
            # 区间过窄或倒挂（ASR 漏录导致锚点挤在一起，如整句只认出尾部）：
            # 按正常语速以后锚点为界向左估算，避免插出 0 时长句子
            t = max(0.0, next_start - est_dur)
            for k in group:
                ntok = max(1, len(norm_tokens(spans[k].text)))
                seg_end = t + ntok * EST_SEC_PER_TOK
                spans[k].start, spans[k].end = round(t, 3), round(seg_end, 3)
                filled[k] = True
                t = seg_end
        else:
            t = prev_end
            for k in group:
                share = max(1, len(norm_tokens(spans[k].text))) / total_tok
                seg_end = t + gap * share
                spans[k].start, spans[k].end = round(t, 3), round(seg_end, 3)
                filled[k] = True
                t = seg_end
        i = j
    # 插值结果标记为可用
    for k, sp in enumerate(spans):
        if filled[k]:
            sp.matched = True
        elif not sp.matched:
            sp.start, sp.end = 0.0, 0.0
    return spans
