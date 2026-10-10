import React from 'react';

interface Props {
  logs: string[];
  error: string;
  onRetry: () => void;
}

/** 首次运行环境准备页：用内置 uv 创建 Python venv 并安装引擎依赖 */
export default function BootstrapPage({ logs, error, onRetry }: Props) {
  return (
    <div className="progress-page">
      <h2>{error ? '环境准备失败' : '正在准备运行环境'}</h2>
      <div className="progress-bar">
        <div
          className={`fill ${error ? '' : 'indeterminate'}`}
          style={{ width: error ? '100%' : '40%' }}
        />
      </div>
      <div className="stage-msg">
        {error
          ? '请检查网络后重试'
          : '首次运行需初始化 Python 环境并下载引擎依赖（约 200MB），请保持网络畅通'}
      </div>
      {logs.length > 0 && (
        <div className="parse-preview" style={{ textAlign: 'left', marginTop: 16 }}>
          {logs.map((l, i) => (
            <div key={i} className="mat-item">{l}</div>
          ))}
        </div>
      )}
      {error && <div className="progress-error">{error}</div>}
      {error && (
        <div style={{ marginTop: 20 }}>
          <button className="primary" onClick={onRetry}>重试</button>
        </div>
      )}
    </div>
  );
}
