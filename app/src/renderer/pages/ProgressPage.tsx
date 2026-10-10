import React from 'react';
import { ProgressParams } from '../types';

interface Props {
  progress: ProgressParams | null;
  onCancel: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  parse: '解析文本',
  ocr: 'OCR 识别 PDF',
  ai: 'AI 智能解析文稿',
  model: '加载模型',
  asr: '语音识别',
  align: '对齐文本',
  cut: '切分音频',
  done: '完成',
};

export default function ProgressPage({ progress, onCancel }: Props) {
  const pct = progress ? Math.round(progress.percent * 100) : 0;
  const stageLabel = progress ? STAGE_LABELS[progress.stage] || progress.stage : '准备中';

  return (
    <div className="progress-page">
      <h2>正在处理…</h2>
      <div className="progress-bar">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="stage-msg">
        {stageLabel} {pct}%
        {progress?.message ? ` · ${progress.message}` : ''}
      </div>
      <div style={{ marginTop: 30 }}>
        <button className="danger" onClick={onCancel}>
          取消
        </button>
      </div>
      <div className="hint" style={{ marginTop: 18, color: '#6a6d78', fontSize: 12.5 }}>
        首次使用较大模型时需要下载模型文件，请保持网络畅通
      </div>
    </div>
  );
}
