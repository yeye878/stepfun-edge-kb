/** 全局状态（无框架，轻量 observable）。 */

import type {
  BenchmarkResult,
  DbInfoResponse,
  HealthResponse,
  ImportSummary,
  KbInfo,
  KbStatsResponse,
  ModelRuntimeState,
  SearchResultView,
  StepKbLogEntry,
  StepKbStateSnapshot,
} from './types';

const MAX_LOGS = 400;

function newModelState(): ModelRuntimeState {
  return {
    status: 'idle',
    progress: null,
    backend: null,
    dtype: null,
    fallbackReason: null,
    attempts: [],
    info: null,
    error: null,
    stub: false,
  };
}

export class AppStore {
  ready = false;
  webgpu: StepKbStateSnapshot['webgpu'] = null;
  model: ModelRuntimeState = newModelState();
  db: { status: 'unknown' | 'ok' | 'error'; health: HealthResponse | null; error: string | null } = {
    status: 'unknown',
    health: null,
    error: null,
  };
  kbs: KbInfo[] = [];
  activeKbId: string | null = null;
  /** 当前知识库的 /stats（DDL、索引、示例 SQL） */
  stats: KbStatsResponse | null = null;
  /** /api/db/info */
  dbInfo: DbInfoResponse | null = null;
  lastSearch: SearchResultView | null = null;
  lastImport: ImportSummary | null = null;
  benchmark: BenchmarkResult | null = null;
  /** 导入进行中的实时进度（仅 UI 使用） */
  importProgress: {
    phase: 'idle' | 'embed' | 'write' | 'refresh';
    vectorized: number;
    written: number;
    total: number;
    embedMs: number;
    writeMs: number;
    message: string;
  } | null = null;
  /** 评测进行中的实时进度（仅 UI 使用） */
  benchProgress: {
    running: boolean;
    configId?: string;
    label?: string;
    detail: string;
    progress?: number | null;
    configIndex?: number;
    configTotal?: number;
  } | null = null;
  busy = { model: false, import: false, search: false, bench: false };
  logs: StepKbLogEntry[] = [];

  private listeners = new Set<() => void>();
  private scheduled = false;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 合并同一帧内的多次变更，避免重复渲染。 */
  notify(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    requestAnimationFrame(() => {
      this.scheduled = false;
      for (const fn of this.listeners) {
        try {
          fn();
        } catch (err) {
          console.error('[store] listener error', err);
        }
      }
    });
  }

  log(level: StepKbLogEntry['level'], msg: string, data?: Record<string, unknown>, phase?: string): void {
    this.logs.push({ ts: Date.now(), level, msg, data, phase });
    if (this.logs.length > MAX_LOGS) this.logs.splice(0, this.logs.length - MAX_LOGS);
    console[level === 'err' ? 'error' : level === 'warn' ? 'warn' : 'log']('[stepkb]', msg, data ?? '');
    this.notify();
  }

  getLogs(limit = 200): StepKbLogEntry[] {
    return this.logs.slice(-limit);
  }

  snapshot(): StepKbStateSnapshot {
    return {
      ready: this.ready,
      webgpu: this.webgpu ? { ...this.webgpu } : null,
      model: {
        ...this.model,
        attempts: this.model.attempts.map((a) => ({ ...a, config: { ...a.config } })),
        info: this.model.info ? { ...this.model.info } : null,
      },
      db: { status: this.db.status, health: this.db.health, error: this.db.error },
      kbs: this.kbs.map((kb) => ({ ...kb })),
      activeKbId: this.activeKbId,
      lastSearch: this.lastSearch,
      lastImport: this.lastImport,
      benchmark: this.benchmark,
      busy: { ...this.busy },
    };
  }

  activeKb(): KbInfo | null {
    if (!this.activeKbId) return null;
    return this.kbs.find((kb) => kb.id === this.activeKbId) ?? null;
  }

  setActiveKb(id: string | null): void {
    this.activeKbId = id;
    if (id) {
      try {
        localStorage.setItem('stepkb.kbId', id);
      } catch {
        /* ignore */
      }
    }
    this.notify();
  }

  restoreKbChoice(): string | null {
    try {
      return localStorage.getItem('stepkb.kbId');
    } catch {
      return null;
    }
  }

  setBusy(key: keyof AppStore['busy'], value: boolean): void {
    this.busy = { ...this.busy, [key]: value };
    this.notify();
  }
}

export const store = new AppStore();
