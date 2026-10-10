# -*- coding: utf-8 -*-
"""AI 文稿解析：调用 OpenAI 兼容接口，从混杂试卷文本中结构化提取英文听力材料。

兼容：硅基流动、智谱、阿里百炼、DeepSeek、OpenAI、本地 Ollama 等任何
OpenAI /v1/chat/completions 兼容服务。
"""
from __future__ import annotations

import json
import re
from typing import Callable, List, Optional

from parser import Material, Sentence
from pdf_reader import looks_like_garbage

SYSTEM_PROMPT = (
    "你是专业的英语试卷解析助手。用户会给你一段试卷文本，其中混杂中文题干、"
    "题目选项、答题说明和英文听力原文（对话/独白/短文）。"
    "你的任务是只提取英文听力原文部分，剔除全部中文、题号、A/B/C/D 选项、"
    "Directions 等非听力正文内容。"
)

# 截取规则预设（cut_mode）
CUT_MODE_PROMPTS = {
    "auto": "",
    "question": (
        "划分规则（必须遵守）：试卷中每段英文听力材料对应一个题号范围。"
        "请根据中文题干中的题号信息（如「听下面一段对话，回答第1至2题」「第3至7小题」等）"
        "把英文材料按题号范围划分成独立材料；每个材料的 title 用「第X-Y题」格式"
        "（能判断类型时可写成「第X-Y题 对话」或「第X-Y题 独白」）。"
    ),
    "marker": (
        "划分规则（必须遵守）：按试卷文本中已有的 Conversation/Passage/Text 等标记划分材料，"
        "title 保留原标记名（如 Conversation 1）。"
    ),
}

USER_PROMPT_TMPL = """请从下面的试卷文本中提取全部英文听力材料。

{rules}{notes}严格要求：
1. 只输出一个 JSON 对象，不要输出 markdown 代码块或任何解释文字。
2. JSON 格式为：
{{"materials":[{{"title":"材料标题","sentences":[{{"speaker":"说话人标签 M/W/Man/Woman/Narrator 等，没有则为 null","text":"一句完整的英文"}}]}}]}}
3. 英文必须逐字照抄原文，不得翻译、改写、纠错、省略或合并；每句话单独成一项。
4. 说话人标签放入 speaker 字段，不要留在 text 里。
5. 若文本中确实没有任何英文听力原文，返回 {{"materials":[]}}。
6. 文本若出现参考答案区（如「21-23ACB24-27BDBA」格式的题号答案串），答案串及
   之后的全部内容（作文范文、评分标准等）一律忽略，不属于听力原文。

试卷文本：
<<<
{text}
>>>
"""

MAX_CHARS_PER_CALL = 5000  # 单次调用文本上限：输出 JSON 约为输入 1.2 倍体积，块太大免费小模型会截断


def _split_units(text: str, limit: int) -> list:
    """把文本切成不超过 limit 的最小单元：段落 → 行 → 句子逐级降级。

    OCR/试卷文本常无空行分段，不能只按空行切块。
    """
    units: list = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= limit:
            units.append(para)
            continue
        for line in para.splitlines():
            line = line.strip()
            if not line:
                continue
            if len(line) <= limit:
                units.append(line)
                continue
            # 单行仍超限：尽量在句子边界断开
            start, n = 0, len(line)
            while start < n:
                end = min(start + limit, n)
                if end < n:
                    cut = max(
                        line.rfind(". ", start, end),
                        line.rfind("! ", start, end),
                        line.rfind("? ", start, end),
                    )
                    if cut > start + limit // 2:
                        end = cut + 1
                piece = line[start:end].strip()
                if piece:
                    units.append(piece)
                start = end
    return units


def _pack_chunks(units: list, limit: int) -> list:
    """把最小单元贪心打包成 ≤limit 的块（单元保持顺序，不跨块合并句子）。"""
    chunks: list = []
    buf = ""
    for u in units:
        if len(buf) + len(u) + 2 > limit and buf:
            chunks.append(buf)
            buf = u
        else:
            buf = f"{buf}\n\n{u}" if buf else u
    if buf:
        chunks.append(buf)
    return chunks


def _strip_json(raw: str) -> dict:
    """从模型输出中截取 JSON（容忍 ```json 包裹或前后多余文字），并做常见修复。"""
    s = raw.strip().lstrip("\ufeff")
    fence = re.search(r"```(?:json)?\s*(\{.*\})\s*```", s, re.DOTALL)
    if fence:
        s = fence.group(1).strip()
    else:
        i, j = s.find("{"), s.rfind("}")
        if i >= 0 and j > i:
            s = s[i : j + 1]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # 常见小问题修复：尾逗号
        repaired = re.sub(r",\s*([}\]])", r"\1", s)
        return json.loads(repaired)


def _build_materials(data: dict) -> List[Material]:
    out: List[Material] = []
    for mi, m in enumerate(data.get("materials", []) or []):
        sents: List[Sentence] = []
        for sn in m.get("sentences", []) or []:
            text = (sn.get("text") or "").strip()
            if not text:
                continue
            speaker = sn.get("speaker")
            speaker = speaker.strip() if isinstance(speaker, str) and speaker.strip() else None
            sents.append(Sentence(text=text, speaker=speaker))
        if not sents:
            continue
        title = (m.get("title") or f"Text {mi + 1}").strip()
        flat = " ".join(s.text for s in sents)
        out.append(Material(id=len(out) + 1, title=title, text=flat, sentences=sents))
    return out


def _call_chat(
    base_url: str,
    api_key: str,
    model: str,
    messages: list,
    timeout: float = 120,
) -> str:
    import requests

    url = base_url.rstrip("/")
    if not url.endswith("/chat/completions"):
        url = url.removesuffix("/") + "/chat/completions"

    try:
        resp = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={"model": model, "messages": messages, "temperature": 0, "max_tokens": 4096},
            timeout=timeout,
        )
    except requests.exceptions.Timeout:
        raise RuntimeError("AI 接口响应超时，请稍后重试或更换平台/模型")
    except requests.exceptions.ConnectionError:
        raise RuntimeError(f"无法连接 AI 接口：{url}，请检查接口地址和网络")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"调用 AI 接口失败：{e}")

    if resp.status_code in (401, 403):
        raise RuntimeError("AI API Key 无效、无权限或已欠费，请检查 Key 与账户额度")
    if resp.status_code == 404:
        raise RuntimeError(f"模型不存在或接口地址错误（404）：{model}")
    if resp.status_code == 429:
        raise RuntimeError("AI 平台触发限速或额度不足（429），请稍后重试或更换平台")
    if resp.status_code != 200:
        raise RuntimeError(f"AI 接口返回 {resp.status_code}: {resp.text[:300]}")
    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise RuntimeError(f"AI 接口返回格式异常: {json.dumps(data, ensure_ascii=False)[:300]}")


def ai_test_connection(base_url: str, api_key: str, model: str = "") -> dict:
    """测试连接：拉取 /models 列表验证 Key，并检查指定模型是否可用。

    返回 {"ok": True, "model_available": bool, "model_count": int}
    """
    import requests

    if not api_key:
        raise RuntimeError("请先填写 API Key")
    if not base_url:
        raise RuntimeError("请先填写接口地址")

    url = base_url.rstrip("/")
    if not url.endswith("/models"):
        url = url.removesuffix("/") + "/models"

    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=15,
        )
    except requests.exceptions.Timeout:
        raise RuntimeError("连接超时，请检查接口地址和网络")
    except requests.exceptions.ConnectionError:
        raise RuntimeError(f"无法连接接口：{url}，请检查接口地址和网络")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"连接失败：{e}")

    if resp.status_code in (401, 403):
        raise RuntimeError("API Key 无效或无权限，请检查 Key 是否正确")
    if resp.status_code != 200:
        raise RuntimeError(f"接口返回 {resp.status_code}: {resp.text[:200]}")

    try:
        data = resp.json()
        ids = [m.get("id", "") for m in data.get("data", []) or []]
    except Exception:
        # 个别平台 /models 结构不标准，能通即可
        return {"ok": True, "model_available": True, "model_count": -1}

    model_available = (not model) or (model in ids)
    return {"ok": True, "model_available": model_available, "model_count": len(ids)}


def _call_with_retry(
    base_url: str,
    api_key: str,
    model: str,
    messages: list,
) -> dict:
    """调用一次并解析 JSON；失败时带错误反馈自动重试一次。"""
    raw = _call_chat(base_url, api_key, model, messages)
    try:
        return _strip_json(raw)
    except json.JSONDecodeError:
        retry_msgs = messages + [
            {"role": "assistant", "content": raw[:2000]},
            {
                "role": "user",
                "content": "你上一次的输出不是有效 JSON（可能被截断或混入了多余文字）。"
                           "请重新输出：只输出一个完整、合法的 JSON 对象，不要任何其他文字。",
            },
        ]
        raw2 = _call_chat(base_url, api_key, model, retry_msgs)
        try:
            return _strip_json(raw2)
        except json.JSONDecodeError:
            raise RuntimeError(
                "AI 返回内容无法解析为 JSON（已自动重试一次），通常是输出被平台截断所致。"
                "可尝试更换更强的模型（如 Qwen/Qwen2.5-32B-Instruct）后重试；"
                "也可以直接取消勾选「AI 智能解析」，用内置规则解析后在下方校对。"
            )


def ai_parse_materials(
    raw_text: str,
    api_key: str,
    base_url: str,
    model: str,
    progress_cb: Optional[Callable[[str], None]] = None,
    cut_mode: str = "auto",
    custom_notes: str = "",
) -> List[Material]:
    """用 AI 解析试卷文本，返回 Material 列表（与 parser.parse_paper_text 同构）。"""
    if not api_key:
        raise RuntimeError("未配置 AI API Key")
    if not base_url:
        raise RuntimeError("未配置 AI 接口地址")
    if not model:
        raise RuntimeError("未配置 AI 模型名")

    text = raw_text.strip()
    if not text:
        return []

    # 输入本身是乱码时提前拦截，避免浪费 API 额度
    if looks_like_garbage(text):
        raise RuntimeError(
            "文稿内容疑似乱码（常见于扫描版 PDF 或特殊字体编码，提取出的不是正常文字）。"
            "请在「文稿提取预览」中确认；若为乱码请换文字版 PDF，或直接复制原文粘贴为文本。"
        )

    rules = CUT_MODE_PROMPTS.get(cut_mode) or ""
    if rules:
        rules += "\n"
    notes = custom_notes.strip()
    notes = f"用户额外要求（必须遵守）：\n{notes}\n\n" if notes else ""

    chunks = _pack_chunks(_split_units(text, MAX_CHARS_PER_CALL), MAX_CHARS_PER_CALL)

    all_materials: List[Material] = []
    for i, chunk in enumerate(chunks):
        if progress_cb:
            progress_cb(f"AI 解析文稿（第 {i + 1}/{len(chunks)} 段）")
        prompt = USER_PROMPT_TMPL.format(rules=rules, notes=notes, text=chunk)
        data = _call_with_retry(
            base_url, api_key, model,
            [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
        )
        all_materials.extend(_build_materials(data))

    # 重新编号
    for i, m in enumerate(all_materials, 1):
        m.id = i
    return all_materials
