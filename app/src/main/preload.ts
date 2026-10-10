// Preload：以 contextBridge 暴露受控 API 给渲染进程
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface ProgressParams {
  stage: string;
  percent: number;
  message: string;
}

export interface BootstrapStatus {
  status: 'progress' | 'done' | 'failed';
  message?: string;
}

const api = {
  // 环境准备
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  retryBootstrap: () => ipcRenderer.invoke('bootstrap:retry'),
  onBootstrapStatus: (cb: (p: BootstrapStatus) => void) => {
    const listener = (_e: IpcRendererEvent, p: BootstrapStatus) => cb(p);
    ipcRenderer.on('bootstrap:status', listener);
    return () => ipcRenderer.removeListener('bootstrap:status', listener);
  },
  // 文件选择
  selectTextFile: () => ipcRenderer.invoke('dialog:selectTextFile'),
  selectAudioFile: () => ipcRenderer.invoke('dialog:selectAudioFile'),
  selectOutDir: () => ipcRenderer.invoke('dialog:selectOutDir'),
  // 引擎
  ping: () => ipcRenderer.invoke('engine:ping'),
  parseText: (text: string) => ipcRenderer.invoke('engine:parseText', text),
  parseTextAi: (params: unknown) => ipcRenderer.invoke('engine:parseTextAi', params),
  aiTest: (params: unknown) => ipcRenderer.invoke('engine:aiTest', params),
  readText: (path: string) => ipcRenderer.invoke('engine:readText', path),
  reExport: (params: unknown) => ipcRenderer.invoke('engine:reExport', params),
  process: (params: any) => ipcRenderer.invoke('engine:process', params),
  cancel: () => ipcRenderer.invoke('engine:cancel'),
  // 课件
  loadCourseware: (dir: string) => ipcRenderer.invoke('courseware:load', dir),
  saveCourseware: (dir: string, courseware: any) =>
    ipcRenderer.invoke('courseware:save', dir, courseware),
  openPath: (p: string) => ipcRenderer.invoke('shell:openPath', p),
  // 进度
  onProgress: (cb: (params: ProgressParams) => void) => {
    const listener = (_e: IpcRendererEvent, params: ProgressParams) => cb(params);
    ipcRenderer.on('engine:progress', listener);
    return () => ipcRenderer.removeListener('engine:progress', listener);
  },
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
