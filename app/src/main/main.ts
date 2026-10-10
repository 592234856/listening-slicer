// Electron 主进程：窗口管理 + 首次运行环境准备（uv 引导）+ Python sidecar 生命周期 + IPC
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SidecarClient } from './sidecar';

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarClient | null = null;

const isDev = !app.isPackaged;

// 引擎环境状态（首次运行 bootstrap 用）
const engineState = { ready: false, installing: false, error: '' };

function getEngineDir(): string {
  // 引擎 .py 文件在 extraResources 中（asar 内的路径 python 无法读取）
  return isDev
    ? path.join(__dirname, '..', '..', '..', 'engine')
    : path.join(process.resourcesPath, 'engine');
}

/** 引擎 venv：开发用仓库内 .venv；打包后放 userData（用户可写） */
function getVenvDir(): string {
  return isDev
    ? path.join(getEngineDir(), '.venv')
    : path.join(app.getPath('userData'), 'engine-env');
}

function getVenvPython(): string {
  const venv = getVenvDir();
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

function sendBootstrap(status: 'progress' | 'done' | 'failed', message?: string) {
  mainWindow?.webContents.send('bootstrap:status', { status, message });
}

function runCapture(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { env, windowsHide: true });
    let lastLine = '';
    const feed = (raw: string) => {
      for (const ln of raw.replace(/\r/g, '\n').split('\n')) {
        const t = ln.trim();
        if (t) {
          lastLine = t;
          sendBootstrap('progress', t.slice(-160));
        }
      }
    };
    p.stdout?.on('data', (d) => feed(String(d)));
    p.stderr?.on('data', (d) => feed(String(d)));
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(lastLine || `命令退出码 ${code}`)),
    );
    p.on('error', (e) => reject(e));
  });
}

/** requirements.txt 的哈希戳，用于判断已装环境是否需要增量更新依赖 */
function getReqsStampPath(): string {
  return path.join(getVenvDir(), '.yp_reqs_hash');
}

function currentReqsHash(): string {
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(getEngineDir(), 'requirements.txt')))
    .digest('hex');
}

function depsNeedInstall(): boolean {
  const stamp = getReqsStampPath();
  try {
    return fs.readFileSync(stamp, 'utf8').trim() !== currentReqsHash();
  } catch {
    return true;
  }
}

/** 环境就绪检查；首次运行用内置 uv 创建 venv；依赖清单变化时增量更新 */
async function ensureEngineEnv() {
  if (engineState.installing) return;

  const venvExists = fs.existsSync(getVenvPython());

  if (isDev) {
    if (venvExists) {
      engineState.ready = true;
      sendBootstrap('done');
      startSidecar();
    } else {
      engineState.error = '未找到 engine/.venv。请先执行：uv venv engine/.venv --python 3.11 && uv pip install --python engine/.venv -r engine/requirements.txt';
      sendBootstrap('failed', engineState.error);
    }
    return;
  }

  const needCreate = !venvExists;
  const needDeps = needCreate || depsNeedInstall();
  if (!needDeps) {
    engineState.ready = true;
    sendBootstrap('done');
    startSidecar();
    return;
  }

  engineState.installing = true;
  engineState.error = '';
  sendBootstrap('progress', needCreate ? '正在准备 Python 环境…' : '正在更新引擎组件…');
  try {
    const uvName =
      process.platform === 'win32' ? 'uv.exe' : process.arch === 'arm64' ? 'uv-arm64' : 'uv-x64';
    const uvBin = path.join(process.resourcesPath, 'uv', uvName);
    if (!fs.existsSync(uvBin)) throw new Error(`未找到内置 uv 工具: ${uvName}`);
    if (process.platform !== 'win32') fs.chmodSync(uvBin, 0o755);

    // 国内默认走镜像：Python 解释器走 npmmirror，PyPI 依赖走清华源；可用环境变量覆盖
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      UV_PYTHON_INSTALL_MIRROR:
        process.env.UV_PYTHON_INSTALL_MIRROR ||
        'https://registry.npmmirror.com/-/binary/python-build-standalone',
      UV_DEFAULT_INDEX:
        process.env.UV_DEFAULT_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple',
      UV_LINK_MODE: 'copy',
    };

    if (needCreate) {
      sendBootstrap('progress', '创建虚拟环境（如需下载 Python 约 60MB）…');
      await runCapture(uvBin, ['venv', getVenvDir(), '--python', '3.11'], env);
    }

    sendBootstrap(
      'progress',
      needCreate ? '安装引擎依赖（约 200MB，请耐心等待）…' : '正在更新引擎依赖（增量安装）…',
    );
    await runCapture(uvBin, [
      'pip', 'install', '--python', getVenvPython(),
      '-r', path.join(getEngineDir(), 'requirements.txt'),
    ], env);

    if (!fs.existsSync(getVenvPython())) throw new Error('虚拟环境创建异常，未找到 python');
    fs.writeFileSync(getReqsStampPath(), currentReqsHash(), 'utf8');

    engineState.ready = true;
    engineState.installing = false;
    sendBootstrap('done');
    startSidecar();
  } catch (e: any) {
    engineState.installing = false;
    engineState.error = e?.message || String(e);
    sendBootstrap('failed', engineState.error);
  }
}

function startSidecar() {
  const engineDir = getEngineDir();
  const mainPy = path.join(engineDir, 'main.py');
  const modelDir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(modelDir, { recursive: true });

  sidecar = new SidecarClient(getVenvPython(), [mainPy], {
    cwd: engineDir,
    env: {
      ...process.env,
      YP_MODEL_DIR: modelDir,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    },
  });

  sidecar.onProgress = (params) => {
    mainWindow?.webContents.send('engine:progress', params);
  };
  sidecar.onExit = (code) => {
    mainWindow?.webContents.send('engine:exit', code);
    sidecar = null;
  };
  sidecar.start();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '听力精切',
    backgroundColor: '#1e1f24',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 允许渲染进程通过 file:// 读课件音频（打包后走自定义协议更安全，此处先简单处理）
      webSecurity: false,
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------- IPC ----------

ipcMain.handle('engine:status', () => ({ ...engineState }));
ipcMain.handle('bootstrap:retry', () => {
  if (!engineState.ready && !engineState.installing) ensureEngineEnv();
});

ipcMain.handle('dialog:selectTextFile', async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择试卷文本',
    filters: [
      { name: '文稿文件', extensions: ['txt', 'pdf', 'docx'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  const lower = p.toLowerCase();
  // .pdf / .docx 交给引擎解析；.txt 直接读出内容
  if (lower.endsWith('.pdf') || lower.endsWith('.docx')) {
    return { path: p, isBinary: true, content: null };
  }
  const content = fs.readFileSync(p, 'utf-8');
  return { path: p, isBinary: false, content };
});

ipcMain.handle('dialog:selectAudioFile', async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择听力音频',
    filters: [
      { name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return { path: r.filePaths[0] };
});

ipcMain.handle('dialog:selectOutDir', async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择课件保存位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return null;
  return { path: r.filePaths[0] };
});

ipcMain.handle('engine:ping', async () => {
  if (!sidecar) return { ok: false };
  return sidecar.call('ping', {});
});

ipcMain.handle('engine:parseText', async (_e, text: string) => {
  if (!sidecar) throw new Error('引擎未启动');
  return sidecar.call('parse_text', { text });
});

ipcMain.handle('engine:parseTextAi', async (_e, params: any) => {
  if (!sidecar) throw new Error('引擎未启动');
  return sidecar.call('parse_text_ai', params);
});
ipcMain.handle('engine:aiTest', async (_e, params: any) => {
  if (!sidecar) throw new Error('引擎未启动');
  return sidecar.call('ai_test', params);
});
ipcMain.handle('engine:readText', async (_e, path: string) => {
  if (!sidecar) throw new Error('引擎未启动');
  return sidecar.call('read_text', { path });
});
ipcMain.handle('engine:reExport', async (_e, params: any) => {
  if (!sidecar) throw new Error('引擎未启动');
  return sidecar.call('re_export', params);
});

ipcMain.handle('engine:process', async (_e, params: any) => {
  if (!sidecar) throw new Error('引擎未启动');
  return sidecar.call('process', params);
});

ipcMain.handle('engine:cancel', async () => {
  if (!sidecar) return { ok: false };
  return sidecar.call('cancel', {});
});

ipcMain.handle('courseware:load', async (_e, dir: string) => {
  const jsonPath = path.join(dir, 'courseware.json');
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  return { path: jsonPath, courseware: JSON.parse(raw) };
});

ipcMain.handle('courseware:save', async (_e, dir: string, courseware: any) => {
  const jsonPath = path.join(dir, 'courseware.json');
  fs.writeFileSync(jsonPath, JSON.stringify(courseware, null, 2), 'utf-8');
  return { ok: true, path: jsonPath };
});

ipcMain.handle('shell:openPath', async (_e, p: string) => {
  return shell.openPath(p);
});

app.whenReady().then(() => {
  createWindow();
  ensureEngineEnv();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sidecar?.kill();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  sidecar?.kill();
});
