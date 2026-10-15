import React, { useState } from 'react';
import { AiSettings } from '../types';

interface Props {
  onStart: (params: {
    text: string;
    textIsPath: boolean;
    audioPath: string;
    outDir: string;
    title: string;
    modelSize: string;
    ai: AiSettings;
    cutMode: string;
    cutNotes: string;
    materials: ParsedMaterial[] | null;
  }) => void;
  /** 打开已有课件文件夹，直接进入精听界面 */
  onOpenCourseware: () => Promise<void>;
  error: string;
}

/** AI/规则解析出的材料（可校对编辑） */
export interface ParsedSentence {
  speaker: string | null;
  text: string;
}
export interface ParsedMaterial {
  title: string;
  sentences: ParsedSentence[];
}

/** 平台预设：均为 OpenAI 兼容接口 */
const PROVIDERS: Record<string, { label: string; baseUrl: string; model: string }> = {
  siliconflow: {
    label: '硅基流动（免费模型，推荐）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
  },
  zhipu: {
    label: '智谱 GLM（GLM-4-Flash 免费）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
  },
  custom: {
    label: '自定义（OpenAI 兼容接口）',
    baseUrl: '',
    model: '',
  },
};

/** 截取规则预设（配合 AI 解析） */
const CUT_MODES: Record<string, string> = {
  question: '按题号范围划分（默认：每段材料对应一个题号范围）',
  marker: '按标记划分（Conversation / Passage / Text N）',
  auto: 'AI 自动判断',
};

const AI_SETTINGS_KEY = 'yp_ai_settings';
const CUT_SETTINGS_KEY = 'yp_cut_settings';

function loadCutSettings(): { mode: string; notes: string } {
  try {
    const raw = localStorage.getItem(CUT_SETTINGS_KEY);
    if (raw) return { mode: 'question', notes: '', ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { mode: 'question', notes: '' };
}

function loadAiSettings(): AiSettings {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_KEY);
    if (raw) return { ...defaultAi(), ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return defaultAi();
}

function defaultAi(): AiSettings {
  return {
    enabled: false,
    provider: 'siliconflow',
    apiKey: '',
    baseUrl: PROVIDERS.siliconflow.baseUrl,
    model: PROVIDERS.siliconflow.model,
  };
}

export default function ImportPage({ onStart, onOpenCourseware, error }: Props) {
  const [text, setText] = useState('');
  const [textPath, setTextPath] = useState('');
  const [isBinary, setIsBinary] = useState(false); // pdf / docx 走引擎解析
  const [audioPath, setAudioPath] = useState('');
  const [outDir, setOutDir] = useState('');
  const [title, setTitle] = useState('精听课件');
  const [modelSize, setModelSize] = useState('small');
  const [mats, setMats] = useState<ParsedMaterial[] | null>(null);
  const [ocrMsg, setOcrMsg] = useState('');
  const [fallbackMsg, setFallbackMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [openBusy, setOpenBusy] = useState(false);
  const [localErr, setLocalErr] = useState('');
  const [ai, setAi] = useState<AiSettings>(loadAiSettings);
  const [testStatus, setTestStatus] = useState<{ state: 'idle' | 'testing' | 'ok' | 'fail'; msg: string }>({
    state: 'idle',
    msg: '',
  });
  const [cut, setCut] = useState(loadCutSettings);
  const [filePreview, setFilePreview] = useState<{
    text: string;
    is_scanned: boolean;
    garbage: boolean;
    ocr_used?: boolean;
  } | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const saveCut = (next: { mode: string; notes: string }) => {
    setCut(next);
    try {
      localStorage.setItem(CUT_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const testConnection = async () => {
    if (!window.api) return;
    if (!ai.apiKey.trim()) {
      setTestStatus({ state: 'fail', msg: '请先填写 API Key' });
      return;
    }
    setTestStatus({ state: 'testing', msg: '正在连接…' });
    try {
      const r = await window.api.aiTest({
        ai_api_key: ai.apiKey.trim(),
        ai_base_url: ai.baseUrl.trim(),
        ai_model: ai.model.trim(),
      });
      if (r.model_available === false) {
        setTestStatus({
          state: 'fail',
          msg: `连接成功，但账户下未找到模型 ${ai.model}（共 ${r.model_count} 个可用），请检查模型名`,
        });
      } else {
        setTestStatus({ state: 'ok', msg: `连接成功，Key 有效，模型可用` });
      }
    } catch (e: any) {
      setTestStatus({ state: 'fail', msg: e?.message || String(e) });
    }
  };

  const saveAi = (next: AiSettings) => {
    setAi(next);
    try {
      localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const pickText = async () => {
    const r = await window.api?.selectTextFile();
    if (!r) return;
    setTextPath(r.path);
    setIsBinary(r.isBinary);
    setFilePreview(null);
    setShowPreview(false);
    setMats(null);
    setFallbackMsg('');
    if (!r.isBinary) {
      setText(r.content || '');
    } else {
      setText('');
      // PDF/Word：调用引擎提取内容预览（乱码 PDF 会自动 OCR，约每分钟 8 页）
      const off = window.api?.onProgress((p) => {
        if (p.stage === 'ocr') setOcrMsg(p.message || '正在 OCR 识别 PDF…');
      });
      try {
        setOcrMsg(r.path.toLowerCase().endsWith('.pdf') ? '正在读取 PDF（若需 OCR 约 1 分钟）…' : '');
        const p = await window.api?.readText(r.path);
        if (p) setFilePreview(p);
      } catch (e: any) {
        setLocalErr(e?.message || String(e));
      } finally {
        setOcrMsg('');
        off?.();
      }
    }
  };

  const pickAudio = async () => {
    const r = await window.api?.selectAudioFile();
    if (r) setAudioPath(r.path);
  };

  const pickOutDir = async () => {
    const r = await window.api?.selectOutDir();
    if (r) setOutDir(r.path);
  };

  const previewParse = async () => {
    if (!window.api) return;
    const usePath = isBinary && textPath;
    // PDF/Word 已在选文件时提取出文本
    const fileText = isBinary ? filePreview?.text || '' : text;
    setBusy(true);
    setLocalErr('');
    setFallbackMsg('');
    try {
      let rawMats: any[] = [];
      let aiErr = '';
      if (ai.enabled) {
        if (!ai.apiKey.trim()) {
          setLocalErr('请先填写 AI API Key');
          return;
        }
        // 已有提取文本时直接传文本（避免重复 OCR）；否则传路径让引擎自行读取
        const req: any = fileText
          ? { text: fileText, text_is_path: false }
          : { text: usePath ? textPath : text, text_is_path: !!usePath };
        try {
          const r = await window.api.parseTextAi({
            ...req,
            ai_api_key: ai.apiKey.trim(),
            ai_base_url: ai.baseUrl.trim(),
            ai_model: ai.model.trim(),
            cut_mode: cut.mode,
            custom_notes: cut.notes,
          });
          rawMats = r.materials || [];
        } catch (e: any) {
          // AI 失败不阻断流程：自动回退内置规则解析
          aiErr = e?.message || String(e);
        }
      }
      if (!rawMats.length) {
        const src = fileText.trim();
        if (!src) {
          setLocalErr(aiErr || '请先粘贴文本或选择文稿文件（PDF 会自动识别文字）');
          return;
        }
        const r = await window.api.parseText(src);
        rawMats = r.materials || [];
        if (aiErr && rawMats.length) {
          setFallbackMsg(`AI 解析失败，已自动改用规则解析，结果可在下方校对。原因：${aiErr}`);
        }
      }
      if (!rawMats.length) {
        setMats([]);
        setLocalErr(aiErr || '未识别到英文听力原文，请检查文稿或改用 AI 智能解析');
      } else {
        setMats(
          rawMats.map((m: any) => ({
            title: m.title || '材料',
            sentences: (m.sentences || []).map((s: any) => ({
              speaker: s.speaker ?? null,
              text: s.text || '',
            })),
          })),
        );
      }
    } catch (e: any) {
      setLocalErr(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- 校对编辑 ----
  const updateMatTitle = (mi: number, v: string) =>
    setMats((prev) => prev!.map((m, i) => (i === mi ? { ...m, title: v } : m)));
  const updateSent = (mi: number, si: number, patch: Partial<ParsedSentence>) =>
    setMats((prev) =>
      prev!.map((m, i) =>
        i === mi
          ? { ...m, sentences: m.sentences.map((s, j) => (j === si ? { ...s, ...patch } : s)) }
          : m,
      ),
    );
  const deleteSent = (mi: number, si: number) =>
    setMats((prev) =>
      prev!.map((m, i) =>
        i === mi ? { ...m, sentences: m.sentences.filter((_, j) => j !== si) } : m,
      ),
    );
  const deleteMat = (mi: number) => setMats((prev) => prev!.filter((_, i) => i !== mi));

  const start = () => {
    const usePath = isBinary && textPath;
    if (!usePath && !text.trim() && !(isBinary && filePreview?.text)) {
      setLocalErr('请提供试卷文稿（粘贴文本，或选择 .txt / .pdf / .docx 文件）');
      return;
    }
    if (!audioPath) {
      setLocalErr('请选择听力音频文件');
      return;
    }
    if (!outDir) {
      setLocalErr('请选择课件保存位置');
      return;
    }
    if (ai.enabled && !ai.apiKey.trim()) {
      setLocalErr('已启用 AI 智能解析，请先填写 API Key');
      return;
    }
    setLocalErr('');
    onStart({
      text: usePath ? textPath : text,
      textIsPath: !!usePath,
      audioPath,
      outDir,
      title: title.trim() || '精听课件',
      modelSize,
      ai,
      cutMode: cut.mode,
      cutNotes: cut.notes,
      // 已校对的材料直接使用；过滤掉空句
      materials: mats
        ? mats
            .map((m) => ({
              title: m.title,
              sentences: m.sentences.filter((s) => s.text.trim()),
            }))
            .filter((m) => m.sentences.length > 0)
        : null,
    });
  };

  const fileExt = textPath.split('.').pop()?.toUpperCase() || '';

  // 打开已有课件：选文件夹 → 读 courseware.json → 直达精听界面
  const openCourseware = async () => {
    setLocalErr('');
    setOpenBusy(true);
    try {
      await onOpenCourseware();
    } finally {
      setOpenBusy(false);
    }
  };

  return (
    <div className="import-page">
      <div className="step-block open-courseware-block">
        <div className="file-row" style={{ marginBottom: 0 }}>
          <button className="primary" onClick={openCourseware} disabled={openBusy}>
            {openBusy ? '正在打开…' : '打开已有课件'}
          </button>
          <div className="hint" style={{ alignSelf: 'center' }}>
            之前生成过课件？选择课件文件夹（含 courseware.json）直接进入精听界面，支持单句循环、听写、调整起止时间，无需重新处理
          </div>
        </div>
      </div>

      <div className="step-block">
        <h3>1. 试卷文稿（中文题干 + 英文听力原文，支持 PDF）</h3>
        <div className="file-row">
          <button onClick={pickText}>选择文稿文件</button>
          <div className={`file-path ${textPath ? '' : 'empty'}`}>
            {textPath ? textPath : '支持 .txt / .pdf / .docx，也可以直接粘贴到下方'}
          </div>
        </div>
        {!isBinary && (
          <textarea
            className="text-input"
            placeholder="把包含中文题干和英文听力原文的文本粘贴到这里…"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setMats(null);
              setFallbackMsg('');
            }}
          />
        )}
        {isBinary && ocrMsg && <div className="preview-warn">⏳ {ocrMsg}</div>}
        {isBinary && (
          <div className="hint">
            已选择 {fileExt} 文件。{fileExt === 'PDF' && '文字层正常直接读取；乱码或扫描版会自动 OCR 识别。'}
          </div>
        )}
        {isBinary && filePreview && (
          <div className="extract-preview">
            {filePreview.ocr_used ? (
              <div className="preview-ok">
                ✓ 该 PDF 文字层异常，已自动 OCR 识别（共 {filePreview.text.length} 字符，可校对原文）
              </div>
            ) : (
              <div className="preview-ok">✓ 文字提取正常（共 {filePreview.text.length} 字符）</div>
            )}
            <button className="link-btn" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? '收起提取内容' : '查看提取内容（校对原文）'}
            </button>
            {showPreview && (
              <pre className="text-preview">{filePreview.text.slice(0, 6000) || '（未提取到文字）'}</pre>
            )}
          </div>
        )}

        <div className="ai-box">
          <label className="ai-toggle">
            <input
              type="checkbox"
              checked={ai.enabled}
              onChange={(e) => saveAi({ ...ai, enabled: e.target.checked })}
            />
            <span>
              使用 AI 智能解析文稿（推荐：先让 AI 识别英文材料，再据此切分音频，复杂排版更准）
            </span>
          </label>
          {ai.enabled && (
            <div className="ai-settings">
              <div className="options-row" style={{ marginBottom: 10 }}>
                <label>
                  平台
                  <select
                    value={ai.provider}
                    onChange={(e) => {
                      const p = e.target.value;
                      const preset = PROVIDERS[p];
                      saveAi({
                        ...ai,
                        provider: p,
                        baseUrl: preset.baseUrl,
                        model: preset.model,
                      });
                    }}
                  >
                    {Object.entries(PROVIDERS).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1, minWidth: 240 }}>
                  API Key
                  <input
                    type="text"
                    style={{ width: '100%' }}
                    placeholder="在此粘贴你的 API Key（仅保存在本机）"
                    value={ai.apiKey}
                    onChange={(e) => {
                      saveAi({ ...ai, apiKey: e.target.value });
                      setTestStatus({ state: 'idle', msg: '' });
                    }}
                  />
                </label>
                <label style={{ justifyContent: 'flex-end' }}>
                  <span style={{ visibility: 'hidden' }}>·</span>
                  <button onClick={testConnection} disabled={testStatus.state === 'testing'}>
                    {testStatus.state === 'testing' ? '测试中…' : '测试连接'}
                  </button>
                </label>
              </div>
              {testStatus.msg && (
                <div
                  className="hint"
                  style={{ color: testStatus.state === 'fail' ? '#ff8080' : '#7bd88f', marginTop: 8 }}
                >
                  {testStatus.msg}
                </div>
              )}
              <div className="options-row">
                <label style={{ flex: 1, minWidth: 200 }}>
                  模型
                  <input
                    type="text"
                    style={{ width: '100%' }}
                    value={ai.model}
                    onChange={(e) => saveAi({ ...ai, model: e.target.value })}
                  />
                </label>
                <label style={{ flex: 1, minWidth: 200 }}>
                  接口地址
                  <input
                    type="text"
                    style={{ width: '100%' }}
                    value={ai.baseUrl}
                    onChange={(e) => saveAi({ ...ai, baseUrl: e.target.value })}
                  />
                </label>
              </div>
              <div className="hint">
                免费 Key 获取：硅基流动注册后在 cloud.siliconflow.cn「API 密钥」中创建（Qwen2.5-7B
                长期免费）；智谱在 open.bigmodel.cn 创建（GLM-4-Flash 免费）。也支持任何 OpenAI
                兼容接口（含本地 Ollama）。
              </div>
            </div>
          )}
        </div>

        <div className="ai-box">
          <label className="ai-toggle" style={{ marginBottom: 10 }}>
            <span>
              截取规则{ai.enabled ? '（AI 解析时生效）' : '（不勾 AI 时按 Text/Conversation 标记自动分组）'}
            </span>
          </label>
          <div className="options-row" style={{ marginBottom: 10 }}>
            <label style={{ flex: 1, minWidth: 240 }}>
              划分方式
              <select
                value={cut.mode}
                onChange={(e) => saveCut({ ...cut, mode: e.target.value })}
              >
                {Object.entries(CUT_MODES).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: '#8a8d98', fontSize: 12.5 }}>
            自定义需求（可选，会连同规则一起告诉 AI）
            <textarea
              className="text-input"
              style={{ minHeight: 60, fontSize: 12.5 }}
              placeholder={'例如：\n· 第1~4题是第一段材料，第5~10题是第二段\n· 只保留对话部分\n· 超过 10 句的独白按话题拆成两段'}
              value={cut.notes}
              onChange={(e) => saveCut({ ...cut, notes: e.target.value })}
            />
          </label>
        </div>

        <div className="actions-row" style={{ marginTop: 10, justifyContent: 'flex-start' }}>
          <button onClick={previewParse} disabled={busy}>
            {busy ? '解析中…' : '预览识别结果'}
          </button>
        </div>
        {fallbackMsg && <div className="preview-warn">⚠ {fallbackMsg}</div>}
        {mats && mats.length > 0 && (
          <div className="review-box">
            <div className="review-head">
              <b>识别出 {mats.length} 段材料，请校对后再开始处理</b>
              <span className="hint">可直接修改标题/句子、删除多余内容；校对结果会用于音频切分</span>
            </div>
            {mats.map((m, mi) => (
              <div key={mi} className="review-mat">
                <div className="review-mat-head">
                  <input
                    className="review-title-input"
                    value={m.title}
                    onChange={(e) => updateMatTitle(mi, e.target.value)}
                  />
                  <span className="hint">{m.sentences.length} 句</span>
                  <button className="mini-danger" onClick={() => deleteMat(mi)}>
                    删除整段
                  </button>
                </div>
                {m.sentences.map((s, si) => (
                  <div key={si} className="review-sent">
                    <input
                      className="review-speaker"
                      value={s.speaker ?? ''}
                      placeholder="说话人"
                      onChange={(e) =>
                        updateSent(mi, si, { speaker: e.target.value || null })
                      }
                    />
                    <input
                      className="review-text-input"
                      value={s.text}
                      onChange={(e) => updateSent(mi, si, { text: e.target.value })}
                    />
                    <button
                      className="mini-danger"
                      title="删除该句"
                      onClick={() => deleteSent(mi, si)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="step-block">
        <h3>2. 原始听力音频</h3>
        <div className="file-row">
          <button onClick={pickAudio}>选择音频文件</button>
          <div className={`file-path ${audioPath ? '' : 'empty'}`}>
            {audioPath ? audioPath : '支持 mp3 / wav / m4a / flac 等常见格式'}
          </div>
        </div>
      </div>

      <div className="step-block">
        <h3>3. 输出设置</h3>
        <div className="file-row" style={{ marginBottom: 12 }}>
          <button onClick={pickOutDir}>选择保存位置</button>
          <div className={`file-path ${outDir ? '' : 'empty'}`}>
            {outDir ? outDir : '课件（courseware.json + 切片音频）将保存到此目录'}
          </div>
        </div>
        <div className="options-row">
          <label>
            课件标题
            <input
              type="text"
              style={{ width: 180 }}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            识别模型
            <select value={modelSize} onChange={(e) => setModelSize(e.target.value)}>
              <option value="base">base（快，精度一般）</option>
              <option value="small">small（推荐，首次需下载约 500MB）</option>
              <option value="medium">medium（最准，较慢）</option>
            </select>
          </label>
        </div>
        <div className="hint">
          流程：{ai.enabled ? 'AI 先解析文稿中的英文材料 →' : '规则解析文稿 →'}
          语音识别音频 → 文本对齐 → 自动切分。语音识别耗时与音频时长有关。
        </div>
      </div>

      {(localErr || error) && (
        <div className="progress-error">{localErr || error}</div>
      )}

      <div className="actions-row">
        <button className="primary" onClick={start}>
          {mats && mats.length > 0
            ? `使用校对后的 ${mats.length} 段材料开始处理`
            : '开始处理'}
        </button>
        {!(mats && mats.length > 0) && (
          <span className="hint" style={{ marginLeft: 12 }}>
            建议先点「预览识别结果」校对内容
          </span>
        )}
      </div>
    </div>
  );
}
