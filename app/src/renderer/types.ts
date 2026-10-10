// 渲染进程类型定义
export interface Sentence {
  text: string;
  speaker: string | null;
  start: number;
  end: number;
  matched: boolean;
}

export interface Material {
  id: number;
  title: string;
  text: string;
  start: number;
  end: number;
  clip: string | null;
  match_rate: number;
  needs_review: boolean;
  sentences: Sentence[];
}

export interface Courseware {
  version: number;
  title: string;
  source_audio: string;
  duration: number;
  materials: Material[];
}

export interface ProgressParams {
  stage: string;
  percent: number;
  message: string;
}

export interface BootstrapStatus {
  status: 'progress' | 'done' | 'failed';
  message?: string;
}

export interface EngineStatus {
  ready: boolean;
  installing: boolean;
  error: string;
}

export interface AiSettings {
  enabled: boolean;
  provider: string; // siliconflow | zhipu | custom
  apiKey: string;
  baseUrl: string;
  model: string;
}

declare global {
  interface Window {
    api?: {
      engineStatus(): Promise<EngineStatus>;
      retryBootstrap(): Promise<void>;
      onBootstrapStatus(cb: (p: BootstrapStatus) => void): () => void;
      selectTextFile(): Promise<{ path: string; isBinary: boolean; content: string | null } | null>;
      selectAudioFile(): Promise<{ path: string } | null>;
      selectOutDir(): Promise<{ path: string } | null>;
      ping(): Promise<any>;
      parseText(text: string): Promise<any>;
      parseTextAi(params: {
        text: string;
        text_is_path: boolean;
        ai_api_key: string;
        ai_base_url: string;
        ai_model: string;
        cut_mode?: string;
        custom_notes?: string;
      }): Promise<any>;
      aiTest(params: { ai_api_key: string; ai_base_url: string; ai_model: string }): Promise<any>;
      readText(path: string): Promise<{
        text: string;
        is_scanned: boolean;
        garbage: boolean;
        ocr_used?: boolean;
      }>;
      reExport(params: {
        out_dir: string;
        courseware: Courseware;
        audio_path?: string;
      }): Promise<{ courseware_path: string; courseware: Courseware }>;
      process(params: any): Promise<{ courseware_path: string; courseware: Courseware }>;
      cancel(): Promise<any>;
      loadCourseware(dir: string): Promise<{ path: string; courseware: Courseware }>;
      saveCourseware(dir: string, courseware: Courseware): Promise<any>;
      openPath(p: string): Promise<string>;
      onProgress(cb: (params: ProgressParams) => void): () => void;
    };
  }
}

export {};
