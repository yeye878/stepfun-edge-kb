/** 展示格式化与通用小工具（不做任何数据加工，仅格式化真实值）。 */

const MB = 1_000_000;

/** 十进制 MB（与 HF 页面一致，便于对照下载体积） */
export function fmtBytes(bytes: number | null | undefined, digits = 2): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return bytes + ' B';
  if (bytes < MB) return (bytes / 1000).toFixed(1) + ' KB';
  return (bytes / MB).toFixed(digits) + ' MB';
}

export function fmtBytesShort(bytes: number | null | undefined): string {
  return fmtBytes(bytes, 1);
}

/** 毫秒格式化：< 1s 显示 ms，否则 s */
export function fmtMs(ms: number | null | undefined, digits = 1): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return ms.toFixed(digits) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

/** 压缩比：fp32 基线 / 当前档 */
export function fmtRatio(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return '—';
  return ratio.toFixed(2) + '×';
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return (v * 100).toFixed(digits) + '%';
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function fmtFixed(v: number | null | undefined, digits = 3): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

export function median(values: number[]): number {
  const arr = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return NaN;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

export function mean(values: number[]): number {
  const arr = values.filter((v) => Number.isFinite(v));
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function shortId(id: string, n = 16): string {
  return id.length > n ? id.slice(0, n) + '…' : id;
}

/** 文档内容 → 稳定 id（SHA-256 前 16 hex），保证同一文本重复导入走 ON DUPLICATE KEY UPDATE。 */
export async function contentId(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.trim());
  const digest = await crypto.subtle.digest('SHA-256', data);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return 'd_' + hex.slice(0, 16);
}

/** 生成 HTML 转义文本（仅在必须用 innerHTML 的极少数场景使用）。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
