import React, { useCallback, useEffect, useRef, useState } from 'react';
import ImportPage from './pages/ImportPage';
import ProgressPage from './pages/ProgressPage';
import CoursewarePage from './pages/CoursewarePage';
import BootstrapPage from './pages/BootstrapPage';
import { Courseware, ProgressParams, AiSettings } from './types';

// 浏览器调试模式：注入 mock API，加载示例课件
if (!window.api) {
  (async () => {
    try {
      const res = await fetch('/mock/courseware.json');
      let cwStore = await res.json(); // 可变存储：模拟保存后再次打开能读到新值
      (window as any).api = {
        selectTextFile: async () => null,
        selectAudioFile: async () => null,
        selectOutDir: async () => ({ path: '/mock' }),
        ping: async () => ({ ok: true, version: 'mock' }),
        parseText: async () => ({ materials: [] }),
        parseTextAi: async () => ({ materials: [] }),
        aiTest: async () => ({ ok: true, model_available: true, model_count: -1 }),
        readText: async () => ({ text: '', is_scanned: false, garbage: false, ocr_used: false }),
        reExport: async () => ({ courseware_path: '/mock/courseware.json', courseware: cwStore }),
        process: async () => ({ courseware_path: '/mock/courseware.json', courseware: cwStore }),
        cancel: async () => ({ ok: true }),
        loadCourseware: async () => ({ path: '/mock/courseware.json', courseware: cwStore }),
        saveCourseware: async (_dir: string, cw: any) => {
          cwStore = cw;
          return { ok: true };
        },
        openPath: async () => '',
        onProgress: () => () => {},
        engineStatus: async () => ({ ready: true, installing: false, error: '' }),
        retryBootstrap: async () => {},
        onBootstrapStatus: () => () => {},
      };
      // 调试：#courseware 直达课件页
      if (location.hash === '#courseware') {
        window.dispatchEvent(new CustomEvent('mock:goto-courseware', { detail: cwStore }));
      }
    } catch {
      /* 无 mock 数据 */
    }
  })();
}

type Stage = 'import' | 'processing' | 'courseware';

export interface ProcessResult {
  coursewarePath: string;
  courseware: Courseware;
  coursewareDir: string;
}

export default function App() {
  const [stage, setStage] = useState<Stage>('import');
  const [progress, setProgress] = useState<ProgressParams | null>(null);
  const [error, setError] = useState<string>('');
  const [result, setResult] = useState<ProcessResult | null>(null);
  const jobRef = useRef<{ cancelled: boolean }>({ cancelled: false });

  // 引擎环境：null=检测中 true=就绪 false=需准备
  const [engineReady, setEngineReady] = useState<boolean | null>(null);
  const [bootLogs, setBootLogs] = useState<string[]>([]);
  const [bootErr, setBootErr] = useState('');

  useEffect(() => {
    if (!window.api) {
      setEngineReady(true);
      return;
    }
    let alive = true;
    window.api.engineStatus().then((st) => {
      if (!alive) return;
      if (st.ready) {
        setEngineReady(true);
      } else {
        setEngineReady(false);
        if (st.error) setBootErr(st.error);
      }
    });
    const offBoot = window.api.onBootstrapStatus((p) => {
      if (p.status === 'done') {
        setEngineReady(true);
      } else if (p.status === 'failed') {
        setBootErr(p.message || '环境准备失败');
      } else if (p.message) {
        setBootLogs((m) => [...m.slice(-8), p.message as string]);
      }
    });
    const offProg = window.api.onProgress((p) => setProgress(p));
    return () => {
      alive = false;
      offBoot();
      offProg();
    };
  }, []);

  // 浏览器调试：监听 mock 跳转课件页
  useEffect(() => {
    const handler = (e: any) => {
      const cw = e.detail as Courseware;
      setResult({
        coursewarePath: '/mock/courseware.json',
        courseware: cw,
        coursewareDir: '/mock',
      });
      setStage('courseware');
    };
    window.addEventListener('mock:goto-courseware', handler);
    return () => window.removeEventListener('mock:goto-courseware', handler);
  }, []);

  // 调试/快捷方式：#open=<课件目录> 启动后直接进入精听界面
  useEffect(() => {
    if (!engineReady || !window.api?.loadCourseware) return;
    const m = location.hash.match(/^#open=(.+)$/);
    if (!m) return;
    const dir = decodeURIComponent(m[1]);
    window.api
      .loadCourseware(dir)
      .then((r) => {
        setResult({ coursewarePath: r.path, courseware: r.courseware, coursewareDir: dir });
        setStage('courseware');
      })
      .catch(() => setError('无法打开课件目录，请确认其中有 courseware.json'));
  }, [engineReady]);

  const handleStart = useCallback(async (params: {
    text: string;
    textIsPath: boolean;
    audioPath: string;
    outDir: string;
    title: string;
    modelSize: string;
    ai: AiSettings;
    cutMode: string;
    cutNotes: string;
    materials: unknown;
  }) => {
    if (!window.api) {
      setError('当前环境未连接桌面引擎（请在 Electron 中运行）');
      return;
    }
    setError('');
    setProgress({ stage: params.ai.enabled ? 'ai' : 'parse', percent: 0, message: '准备中' });
    setStage('processing');
    jobRef.current.cancelled = false;
    try {
      const r = await window.api.process({
        text: params.text,
        text_is_path: params.textIsPath,
        audio_path: params.audioPath,
        out_dir: params.outDir,
        title: params.title,
        model_size: params.modelSize,
        use_ai: params.ai.enabled,
        ai_api_key: params.ai.apiKey,
        ai_base_url: params.ai.baseUrl,
        ai_model: params.ai.model,
        cut_mode: params.cutMode,
        custom_notes: params.cutNotes,
        materials: params.materials,
      });
      if (jobRef.current.cancelled) return;
      // courseware.json 所在目录即课件目录
      const dir = r.courseware_path.replace(/[\\/]courseware\.json$/i, '');
      setResult({ coursewarePath: r.courseware_path, courseware: r.courseware, coursewareDir: dir });
      setStage('courseware');
    } catch (e: any) {
      if (jobRef.current.cancelled) return;
      setError(e?.message || String(e));
      setStage('import');
    }
  }, []);

  const handleCancel = useCallback(async () => {
    jobRef.current.cancelled = true;
    try {
      await window.api?.cancel();
    } catch {
      // ignore
    }
    setStage('import');
    setProgress(null);
  }, []);

  const handleBack = useCallback(() => {
    setStage('import');
    setResult(null);
    setProgress(null);
    setError('');
  }, []);

  // 打开已有课件：选择课件文件夹（含 courseware.json）直接进入精听界面
  const handleOpenCourseware = useCallback(async () => {
    if (!window.api) return;
    const dir = await window.api.selectOutDir();
    if (!dir) return;
    setError('');
    try {
      const r = await window.api.loadCourseware(dir.path);
      setResult({
        coursewarePath: r.path,
        courseware: r.courseware,
        coursewareDir: dir.path,
      });
      setStage('courseware');
    } catch {
      setError('该文件夹中没有找到 courseware.json，请选择之前生成课件时保存的文件夹');
    }
  }, []);

  const handleRetryBoot = useCallback(() => {
    setBootErr('');
    setBootLogs([]);
    window.api?.retryBootstrap();
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>听力精切</h1>
        <span className="subtitle">试卷文本 + 听力音频 → 自动切分精听课件</span>
        {stage === 'courseware' && engineReady !== false && (
          <div className="topbar-actions">
            <button onClick={handleBack}>新建任务</button>
          </div>
        )}
      </header>
      <div className="app-body">
        {engineReady === null && <div className="empty-state">正在连接引擎…</div>}
        {engineReady === false && (
          <BootstrapPage logs={bootLogs} error={bootErr} onRetry={handleRetryBoot} />
        )}
        {engineReady === true && (
          <>
            {stage === 'import' && (
              <ImportPage onStart={handleStart} onOpenCourseware={handleOpenCourseware} error={error} />
            )}
            {stage === 'processing' && (
              <ProgressPage progress={progress} onCancel={handleCancel} />
            )}
            {stage === 'courseware' && result && (
              <CoursewarePage
                courseware={result.courseware}
                coursewareDir={result.coursewareDir}
                onCoursewareChange={(cw) => setResult({ ...result, courseware: cw })}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
