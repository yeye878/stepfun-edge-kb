/**
 * 后端 HTTP 客户端（严格按 notes/APP-CONTRACT.md §3 字段）。
 * 后端只做 SQL 转发与结果整形；向量始终由浏览器 Worker 计算。
 */

import type {
  ApiErrorPayload,
  CreateKbRequest,
  CreateKbResponse,
  DbInfoResponse,
  HealthResponse,
  ImportDocsRequest,
  ImportDocsResponse,
  KbInfo,
  KbListResponse,
  KbStatsResponse,
  RefreshResponse,
  SearchRequest,
  SearchResponse,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: unknown;

  constructor(status: number, code: string, message: string, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 60_000;

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, timeoutMs = DEFAULT_TIMEOUT } = opts;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    throw new ApiError(
      0,
      'NETWORK',
      '无法连接后端 ' + path + '：' + (err instanceof Error ? err.message : String(err)) +
        '（确认 server/index.mjs 已在 127.0.0.1:18270 启动）',
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const payload = (json ?? {}) as ApiErrorPayload;
    const code = payload.error?.code ?? 'HTTP_' + res.status;
    const message = (payload.error?.message ?? text.slice(0, 300)) || 'HTTP ' + res.status;
    throw new ApiError(res.status, code, message, payload);
  }

  if (json == null) {
    throw new ApiError(res.status, 'BAD_JSON', '后端返回非 JSON：' + text.slice(0, 200));
  }
  return json as T;
}

export const api = {
  health(): Promise<HealthResponse> {
    return request<HealthResponse>('/api/health', { timeoutMs: 8_000 });
  },
  listKbs(): Promise<KbListResponse> {
    return request<KbListResponse>('/api/kbs', { timeoutMs: 15_000 });
  },
  createKb(body: CreateKbRequest): Promise<CreateKbResponse> {
    return request<CreateKbResponse>('/api/kbs', { method: 'POST', body, timeoutMs: 30_000 });
  },
  deleteKb(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/api/kbs/' + encodeURIComponent(id), {
      method: 'DELETE',
      timeoutMs: 30_000,
    });
  },
  importDocs(kbId: string, body: ImportDocsRequest): Promise<ImportDocsResponse> {
    // 批量写入可能较大；单批 100 篇 × 384 维 ≈ 2MB JSON
    return request<ImportDocsResponse>('/api/kbs/' + encodeURIComponent(kbId) + '/docs', {
      method: 'POST',
      body,
      timeoutMs: 180_000,
    });
  },
  refresh(kbId: string): Promise<RefreshResponse> {
    return request<RefreshResponse>('/api/kbs/' + encodeURIComponent(kbId) + '/refresh', {
      method: 'POST',
      body: {},
      timeoutMs: 60_000,
    });
  },
  search(kbId: string, body: SearchRequest): Promise<SearchResponse> {
    return request<SearchResponse>('/api/kbs/' + encodeURIComponent(kbId) + '/search', {
      method: 'POST',
      body,
      timeoutMs: 60_000,
    });
  },
  stats(kbId: string): Promise<KbStatsResponse> {
    return request<KbStatsResponse>('/api/kbs/' + encodeURIComponent(kbId) + '/stats', {
      timeoutMs: 30_000,
    });
  },
  dbInfo(): Promise<DbInfoResponse> {
    return request<DbInfoResponse>('/api/db/info', { timeoutMs: 15_000 });
  },
};

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function kbToOptionText(kb: KbInfo): string {
  return kb.name + '（' + kb.docCount + ' 篇）';
}
