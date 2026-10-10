// Python sidecar 子进程封装：spawn + 行分隔 JSON-RPC 客户端
import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';

export interface ProgressParams {
  stage: string;
  percent: number;
  message: string;
}

interface PendingCall {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

export class SidecarClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingCall>();

  onProgress: ((params: ProgressParams) => void) | null = null;
  onExit: ((code: number | null) => void) | null = null;

  constructor(
    private command: string,
    private args: string[],
    private options: SpawnOptions,
  ) {
    super();
  }

  start() {
    this.proc = spawn(this.command, this.args, {
      ...this.options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.setEncoding('utf-8');
    this.proc.stdout!.on('data', (chunk: string) => this._onData(chunk));
    this.proc.stderr!.setEncoding('utf-8');
    this.proc.stderr!.on('data', (chunk: string) => {
      // stderr 只作日志，不阻断
      console.error('[engine]', chunk.trim());
    });
    this.proc.on('exit', (code) => {
      const err = new Error(`引擎进程退出 (code=${code})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.onExit?.(code);
    });
    this.proc.on('error', (err) => {
      console.error('引擎启动失败:', err);
      this.onExit?.(-1);
    });
  }

  private _onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method === 'progress') {
        this.onProgress?.(msg.params as ProgressParams);
      } else if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error));
          else p.resolve(msg.result);
        }
      }
    }
  }

  call<T = any>(method: string, params: any): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc || !this.proc.stdin?.writable) {
        reject(new Error('引擎未启动'));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  kill() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      this.proc = null;
    }
  }
}
