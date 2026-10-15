import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Courseware, Material, Sentence } from '../types';

interface Props {
  courseware: Courseware;
  coursewareDir: string;
  onCoursewareChange: (cw: Courseware) => void;
}

function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

function toFileUrl(p: string): string {
  // 浏览器调试：/ 开头视为 vite public 相对路径
  if (p.startsWith('/')) return p;
  // Windows 路径转 file:// URL
  let u = p.replace(/\\/g, '/');
  if (!u.startsWith('/')) u = '/' + u;
  return 'file://' + u.split('/').map(encodeURIComponent).join('/').replace(/%3A/, ':');
}

// 单句播放/循环的有效停止点：句尾时间若偏晚吞并了下一句开头（或与下一句
// 无缝衔接），用下一句起点截断，并预留提前量补偿音频输出延迟，
// 避免把下一句带出来
function sentStop(mat: Material, idx: number): number {
  const s = mat.sentences[idx];
  if (!s) return 0;
  let end = s.end - 0.08;
  const next = mat.sentences[idx + 1];
  if (next && next.start > s.start && next.start <= s.end + 0.05) {
    end = Math.min(end, next.start - 0.12);
  }
  return Math.max(s.start + 0.2, end);
}

export default function CoursewarePage({ courseware, coursewareDir, onCoursewareChange }: Props) {
  const [curId, setCurId] = useState<number>(courseware.materials[0]?.id ?? 0);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const cur: Material | undefined = useMemo(
    () => courseware.materials.find((m) => m.id === curId),
    [courseware, curId],
  );

  // 手动调整后：按当前时间重新切分导出切片音频
  const reExport = useCallback(async () => {
    if (!window.api?.reExport || exporting) return;
    setExporting(true);
    setExportMsg('');
    try {
      await window.api.reExport({ out_dir: coursewareDir, courseware });
      setExportMsg('✓ 已按当前时间重新导出切片');
      setTimeout(() => setExportMsg(''), 4000);
    } catch (e: any) {
      setExportMsg(e?.message || String(e));
    } finally {
      setExporting(false);
    }
  }, [courseware, coursewareDir, exporting]);

  return (
    <div className="courseware-page">
      <aside className="material-list">
        {courseware.materials.map((m) => (
          <div
            key={m.id}
            className={`mat-item ${m.id === curId ? 'active' : ''} ${m.needs_review ? 'needs-review' : ''}`}
            onClick={() => setCurId(m.id)}
          >
            <div className="mat-title">
              {m.title}
              {m.needs_review && <span className="review-tag">需确认</span>}
            </div>
            <div className="mat-meta">
              {fmtTime(m.start)} ~ {fmtTime(m.end)} · {m.sentences.length} 句
            </div>
          </div>
        ))}
        <div style={{ padding: '10px 6px' }}>
          <button
            style={{ width: '100%' }}
            className="primary"
            onClick={reExport}
            disabled={exporting}
          >
            {exporting ? '导出中…' : '重新导出切片音频'}
          </button>
          {exportMsg && (
            <div style={{ fontSize: 12, marginTop: 6, color: exportMsg.startsWith('✓') ? '#7bd88f' : '#ff8080' }}>
              {exportMsg}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#8a8d98', margin: '6px 0 10px' }}>
            调整起止时间后点击可重新生成切片文件
          </div>
          <button
            style={{ width: '100%' }}
            onClick={() => window.api?.openPath(coursewareDir)}
          >
            打开课件目录
          </button>
        </div>
      </aside>
      {cur ? (
        <MaterialDetail
          key={cur.id}
          material={cur}
          courseware={courseware}
          coursewareDir={coursewareDir}
          onCoursewareChange={onCoursewareChange}
        />
      ) : (
        <div className="empty-state">没有可选材料</div>
      )}
    </div>
  );
}

interface DetailProps {
  material: Material;
  courseware: Courseware;
  coursewareDir: string;
  onCoursewareChange: (cw: Courseware) => void;
}

function MaterialDetail({ material, courseware, coursewareDir, onCoursewareChange }: DetailProps) {
  const waveRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [curTime, setCurTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [loopSentIdx, setLoopSentIdx] = useState<number | null>(null);
  const [playingSentIdx, setPlayingSentIdx] = useState<number | null>(null);
  const [showText, setShowText] = useState(true);
  // 单句隐藏覆盖：记录与全局「隐藏原文」相反的句子（全局显示时单独隐藏，
  // 全局隐藏时单独显示），切换材料后自动重置
  const [sentOverride, setSentOverride] = useState<Record<number, boolean>>({});
  const [dictation, setDictation] = useState(false);
  const [dictInputs, setDictInputs] = useState<Record<number, string>>({});
  const [dictChecked, setDictChecked] = useState<Record<number, boolean>>({});

  const [editStart, setEditStart] = useState(material.start);
  const [editEnd, setEditEnd] = useState(material.end);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  // 所有材料都可以手动微调起止时间；需确认的默认展开
  const [showAdjust, setShowAdjust] = useState(material.needs_review);

  const loopRef = useRef<number | null>(null);
  const playingSentRef = useRef<number | null>(null);
  loopRef.current = loopSentIdx;
  playingSentRef.current = playingSentIdx;
  // 最新 material 的 ref：监视器回调只注册一次，直接闭包 material
  // 会在「保存调整」后仍读旧句子时间，导致循环错位
  const materialRef = useRef(material);
  materialRef.current = material;

  // 音频源：优先切片，否则源音频（句子时间为绝对时间，直接用源音频最一致）
  const audioPath = useMemo(() => {
    const rel = courseware.source_audio;
    const sep = coursewareDir.includes('\\') ? '\\' : '/';
    return coursewareDir + sep + rel;
  }, [courseware, coursewareDir]);

  useEffect(() => {
    if (!waveRef.current) return;
    const ws = WaveSurfer.create({
      container: waveRef.current,
      waveColor: '#4a5568',
      progressColor: '#4f7cff',
      cursorColor: '#e6e6eb',
      height: 90,
      normalize: true,
      url: toFileUrl(audioPath),
    });
    wsRef.current = ws;
    ws.on('ready', () => {
      setReady(true);
      // 跳到本材料起点
      ws.setTime(material.start);
    });
    ws.on('play', () => setPlaying(true));
    ws.on('pause', () => setPlaying(false));
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioPath, material.id]);

  // 统一播放监视器：rAF 轮询 getCurrentTime，不依赖 wavesurfer 事件。
  // timeupdate 在部分环境下会被 seeking 抑制或频率过低（实测仅约 6 次/秒），
  // 曾导致单句循环跳回失效、表现为"点了循环却播完整段"。
  // 这里同时负责：时间显示、单句循环跳回、单句播放到点暂停、整段播完自动暂停。
  useEffect(() => {
    let raf = 0;
    let lastShown = -1;
    const tick = () => {
      const ws = wsRef.current;
      if (ws) {
        const t = ws.getCurrentTime();
        if (Math.abs(t - lastShown) > 0.05) {
          lastShown = t;
          setCurTime(t);
        }
        const mat = materialRef.current;
        const li = loopRef.current;
        if (li != null) {
          // 单句循环：到有效停止点或被拖出句外立即跳回句首
          const s = mat.sentences[li];
          if (s && s.end - s.start >= 0.15 && (t >= sentStop(mat, li) || t < s.start - 0.3)) {
            ws.setTime(s.start);
          }
        } else {
          // 单句播放：到有效停止点自动暂停并清除高亮
          const pi = playingSentRef.current;
          if (pi != null) {
            const s = mat.sentences[pi];
            if (s && t >= sentStop(mat, pi)) {
              ws.pause();
              setPlayingSentIdx(null);
            }
          } else if (t >= mat.end && ws.isPlaying()) {
            // 播放到本材料末尾自动暂停
            ws.pause();
            setPlaying(false);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    wsRef.current?.setPlaybackRate(rate);
  }, [rate, ready]);

  const togglePlay = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (ws.isPlaying()) {
      ws.pause();
    } else {
      if (ws.getCurrentTime() >= material.end || ws.getCurrentTime() < material.start) {
        ws.setTime(material.start);
      }
      ws.play();
    }
  }, [ready, material]);

  // 单句播放：只播放这一句，播完由监视器自动暂停（同时取消单句循环）
  const playSentence = useCallback(
    (idx: number) => {
      const ws = wsRef.current;
      const s = materialRef.current.sentences[idx];
      if (!ws || !s || !ready) return;
      setLoopSentIdx(null);
      setPlayingSentIdx(idx);
      if (s.end - s.start >= 0.15) ws.setTime(s.start);
      ws.play();
    },
    [ready],
  );

  // 单句循环：反复播放该句，直到再次点击停止
  const toggleLoop = useCallback(
    (idx: number) => {
      const ws = wsRef.current;
      if (!ws || !ready) return;
      if (loopSentIdx === idx) {
        // 已在循环该句 → 停止
        setLoopSentIdx(null);
        setPlayingSentIdx(null);
        ws.pause();
        return;
      }
      setPlayingSentIdx(idx);
      setLoopSentIdx(idx);
      const s = materialRef.current.sentences[idx];
      if (s && s.end - s.start >= 0.15) ws.setTime(s.start);
      ws.play();
    },
    [loopSentIdx, ready],
  );

  // 保存调整：写入 courseware.json + 句子时间同步收进新边界 + 自动重切切片音频，
  // 一步到位，保证「保存后即生效」（重开课件、单句循环、切片文件都用新时间）
  const saveAdjust = useCallback(async () => {
    if (saving) return;
    const cw: Courseware = JSON.parse(JSON.stringify(courseware));
    const m = cw.materials.find((x) => x.id === material.id);
    if (!m) return;
    m.start = editStart;
    m.end = editEnd;
    m.needs_review = false;
    // 句子时间仍指向源音频绝对位置；材料边界收窄后，越界句子收进新范围，
    // 否则单句循环/单句播放仍会播到调整前的音频位置
    for (const s of m.sentences) {
      s.start = Math.min(Math.max(s.start, m.start), m.end);
      s.end = Math.min(Math.max(s.end, m.start), m.end);
    }
    setSaving(true);
    setSaveErr('');
    try {
      await window.api?.saveCourseware(coursewareDir, cw);
      onCoursewareChange(cw);
      // 自动重切切片音频（通常几秒到几十秒，与总时长有关）
      if (window.api?.reExport) {
        await window.api.reExport({ out_dir: coursewareDir, courseware: cw });
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setSaveErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [courseware, coursewareDir, material.id, editStart, editEnd, onCoursewareChange, saving]);

  const checkDictation = (idx: number) => {
    setDictChecked((p) => ({ ...p, [idx]: true }));
  };

  const renderDictationResult = (s: Sentence, idx: number) => {
    if (!dictChecked[idx]) return null;
    const norm = (t: string) =>
      t.toLowerCase().replace(/[^a-z0-9\s']/g, ' ').split(/\s+/).filter(Boolean);
    const ref = norm(s.text);
    const inp = norm(dictInputs[idx] || '');
    const maxLen = Math.max(ref.length, inp.length);
    const parts: React.ReactNode[] = [];
    for (let i = 0; i < maxLen; i++) {
      const r = ref[i];
      const w = inp[i];
      if (r === w && r !== undefined) {
        parts.push(
          <span key={i} className="ok">{r} </span>,
        );
      } else {
        parts.push(
          <span key={i} className="miss" title={w ? `你写的: ${w}` : '漏词'}>
            {r ?? '—'}{' '}
          </span>,
        );
      }
    }
    const correct = ref.filter((t, i) => inp[i] === t).length;
    const acc = ref.length ? Math.round((correct / ref.length) * 100) : 0;
    return (
      <div className="dictation-result">
        <div>{parts}</div>
        <div style={{ marginTop: 4, color: '#8a8d98' }}>
          正确率 {acc}% · 原文：{s.text}
        </div>
      </div>
    );
  };

  return (
    <div className="material-detail">
      <div className="detail-header">
        <h2>{material.title}</h2>
        <span className="time-range">
          {fmtTime(material.start)} ~ {fmtTime(material.end)}（{fmtTime(material.end - material.start)}）
        </span>
        <span className={`match-badge ${material.needs_review ? 'warn' : ''}`}>
          匹配率 {Math.round(material.match_rate * 100)}%
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => setShowAdjust((v) => !v)}>
            {showAdjust ? '收起调整' : '调整起止时间'}
          </button>
          <button onClick={() => setShowText((v) => !v)}>
            {showText ? '隐藏原文' : '显示原文'}
          </button>
          <button
            className={dictation ? 'primary' : ''}
            onClick={() => {
              setDictation((v) => !v);
              setDictChecked({});
            }}
          >
            {dictation ? '退出听写' : '听写模式'}
          </button>
        </div>
      </div>

      <div className="waveform-area">
        <div className="wave-container" ref={waveRef} />
      </div>

      <div className="player-bar">
        <button className="primary" onClick={togglePlay} disabled={!ready}>
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <span className="time-display">
          {fmtTime(curTime)} / {fmtTime(courseware.duration)}
        </span>
        <label>
          倍速
          <select value={rate} onChange={(e) => setRate(parseFloat(e.target.value))}>
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
              <option key={r} value={r}>
                {r}x
              </option>
            ))}
          </select>
        </label>
        {loopSentIdx != null && (
          <span style={{ color: '#7ddc8e', fontSize: 13 }}>
            循环第 {loopSentIdx + 1} 句
            <button
              style={{ marginLeft: 8, padding: '2px 10px', fontSize: 12 }}
              onClick={() => {
                setLoopSentIdx(null);
                setPlayingSentIdx(null);
              }}
            >
              取消循环
            </button>
          </span>
        )}
      </div>

      {showAdjust && (
        <div className="review-panel">
          <span>
            {material.needs_review
              ? '⚠ 该段匹配率较低，请人工确认起止时间：'
              : '微调本段起止时间（秒），保存后立即生效（自动重切切片音频）：'}
          </span>
          <label>
            起点(秒)
            <input
              type="number"
              step={0.1}
              value={editStart}
              onChange={(e) => setEditStart(parseFloat(e.target.value) || 0)}
            />
          </label>
          <label>
            终点(秒)
            <input
              type="number"
              step={0.1}
              value={editEnd}
              onChange={(e) => setEditEnd(parseFloat(e.target.value) || 0)}
            />
          </label>
          <button
            onClick={() => {
              wsRef.current?.setTime(editStart);
              wsRef.current?.play();
            }}
          >
            试听起点
          </button>
          <button
            onClick={() => {
              const ws = wsRef.current;
              if (!ws) return;
              ws.setTime(Math.max(0, editEnd - 2));
              ws.play();
              const check = () => {
                if (!wsRef.current) return;
                if (wsRef.current.getCurrentTime() >= editEnd) {
                  wsRef.current.pause();
                  return;
                }
                requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            }}
          >
            试听终点
          </button>
          <button className="primary" onClick={saveAdjust} disabled={saving}>
            {saving ? '保存并重切中…' : saved ? '✓ 已保存并重切' : '保存调整'}
          </button>
          {saveErr && <span style={{ color: '#ff8080', fontSize: 12 }}>{saveErr}</span>}
        </div>
      )}

      <div className="sentence-list">
        {material.sentences.map((s, idx) => (
          <div
            key={idx}
            className={`sentence-item ${playingSentIdx === idx ? 'playing' : ''}`}
            onClick={() => playSentence(idx)}
          >
            <span className="sent-idx">{idx + 1}</span>
            <div className="sent-body">
              <div className={`sent-text ${!(sentOverride[idx] ? !showText : showText) && !dictation ? 'hidden-text' : ''}`}>
                {s.speaker && <span className="speaker">{s.speaker}</span>}
                {dictation ? (
                  <span style={{ color: '#8a8d98' }}>
                    （{s.text.split(/\s+/).length} 个词）
                  </span>
                ) : (
                  s.text
                )}
              </div>
              <div className="sent-time">
                {fmtTime(s.start)} ~ {fmtTime(s.end)}
                {!s.matched && <span style={{ color: '#f0b355' }}> · 时间为估算</span>}
              </div>
              {dictation && (
                <div onClick={(e) => e.stopPropagation()}>
                  <input
                    className="dictation-input"
                    type="text"
                    placeholder="输入你听到的句子…"
                    value={dictInputs[idx] || ''}
                    onChange={(e) =>
                      setDictInputs((p) => ({ ...p, [idx]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') checkDictation(idx);
                    }}
                  />
                  <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
                    <button
                      style={{ padding: '3px 12px', fontSize: 12 }}
                      onClick={() => checkDictation(idx)}
                    >
                      核对
                    </button>
                    <button
                      style={{ padding: '3px 12px', fontSize: 12 }}
                      onClick={() => {
                        setDictInputs((p) => ({ ...p, [idx]: '' }));
                        setDictChecked((p) => ({ ...p, [idx]: false }));
                      }}
                    >
                      重写
                    </button>
                  </div>
                  {renderDictationResult(s, idx)}
                </div>
              )}
            </div>
            <button
              style={{
                padding: '3px 10px',
                fontSize: 12,
                flexShrink: 0,
                background: !(sentOverride[idx] ? !showText : showText) ? '#555b6e' : undefined,
                color: !(sentOverride[idx] ? !showText : showText) ? '#c9cdd8' : undefined,
              }}
              title="只切换这一句的原文显示/隐藏"
              onClick={(e) => {
                e.stopPropagation();
                setSentOverride((p) => {
                  const q = { ...p };
                  if (q[idx]) delete q[idx];
                  else q[idx] = true;
                  return q;
                });
              }}
            >
              {sentOverride[idx] ? (showText ? '显示' : '隐藏') : showText ? '隐藏' : '显示'}
            </button>
            <button
              style={{
                padding: '3px 10px',
                fontSize: 12,
                flexShrink: 0,
                background: loopSentIdx === idx ? '#4f7cff' : undefined,
                color: loopSentIdx === idx ? '#fff' : undefined,
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleLoop(idx);
              }}
            >
              {loopSentIdx === idx ? '停止循环' : '单句循环'}
            </button>
            <button
              style={{
                padding: '3px 10px',
                fontSize: 12,
                flexShrink: 0,
                background: playingSentIdx === idx && loopSentIdx == null ? '#3a9e63' : undefined,
                color: playingSentIdx === idx && loopSentIdx == null ? '#fff' : undefined,
              }}
              onClick={(e) => {
                e.stopPropagation();
                playSentence(idx);
              }}
            >
              单句播放
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
