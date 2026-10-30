/** 评测面板：3 配置 × 5 次 → 体积/压缩比/吞吐/检索延迟/端到端/Recall@10/nDCG@10 + 导出 JSON。 */

import { store } from '../appStore';
import {
  BENCH_CONFIGS,
  benchmarkFileName,
  downloadJson,
  runBenchmark,
  type BenchProgress,
} from '../bench';
import { el, mount } from '../dom';
import { fmtBytes, fmtFixed, fmtMs, fmtNum, fmtPct, fmtRatio, fmtTime } from '../format';
import type { BenchConfigResult, BenchmarkResult } from '../types';
import { toast } from './toast';

const CONFIG_HINT = BENCH_CONFIGS.map((c) => c.label).join(' / ');

export interface BenchPanelApi {
  render: () => void;
  /** 运行评测；selector 支持 config id / 关键字（v1.1 hook 传配置名）。 */
  run: (selector?: string | string[], runs?: number) => Promise<BenchmarkResult>;
}

export function setupBenchPanel(root: HTMLElement, runBtn: HTMLButtonElement, exportBtn: HTMLButtonElement): BenchPanelApi {
  let localError: string | null = null;

  const introSlot = el('div');
  const progressSlot = el('div');
  const tableSlot = el('div');
  const logSlot = el('div');
  mount(root, introSlot, progressSlot, tableSlot, logSlot);

  function renderIntro(): void {
    mount(
      introSlot,
      el('div', { class: 'notice', attrs: { 'data-testid': 'bench-intro' } },
        el('strong', { text: '配置：' }), el('span', { text: CONFIG_HINT }),
        el('span', { text: '　·　每配置 5 次检索 · 每次 30 条查询 · 评估 Recall@10 / nDCG@10 · 混合检索（单条 SQL）' }),
        el('span', { text: '　·　体积取模型文件实际字节，压缩比 = FP32 字节 / 该档字节' }),
      ),
    );
  }

  function renderProgress(): void {
    const p = store.benchProgress;
    if (p && p.running) {
      const pct = p.progress != null ? Math.min(100, Math.max(0, p.progress)) : null;
      const fill = el('div', {
        class: 'progress-fill' + (pct == null ? ' indeterminate' : ''),
        style: pct != null ? { width: pct.toFixed(1) + '%' } : {},
      });
      mount(
        progressSlot,
        el('div', { class: 'progress-wrap', attrs: { 'data-testid': 'bench-progress' } },
          el('div', { class: 'progress-meta' },
            el('span', { text: (p.label ? '[' + p.label + '] ' : '') + p.detail }),
            el('span', { text: p.configIndex && p.configTotal ? '配置 ' + p.configIndex + '/' + p.configTotal : '' }),
          ),
          el('div', { class: 'progress-track' }, fill),
        ),
      );
    } else {
      mount(progressSlot);
    }
  }

  function statusCell(row: BenchConfigResult): HTMLElement {
    if (row.status === 'ok') return el('span', { class: 'badge-mini ok', text: '完成' });
    if (row.status === 'skipped') return el('span', { class: 'badge-mini warn', text: '跳过', title: row.statusReason ?? '' });
    return el('span', { class: 'badge-mini err', text: '失败', title: row.statusReason ?? '' });
  }

  function renderTable(): void {
    const result = store.benchmark;
    if (!result) {
      mount(
        tableSlot,
        el('div', { class: 'empty', attrs: { 'data-testid': 'bench-table' } },
          el('strong', { text: '尚未运行评测' }),
          el('span', { text: '点击右上角“运行评测”。首次需逐配置加载模型，预计 1–3 分钟；WebGPU 不可用时 FP16 行会标记跳过。' }),
        ),
      );
      return;
    }

    const rows = BENCH_CONFIGS.map((cfg) => {
      const found = result.configs.find((r) => r.id === cfg.id);
      if (!found) {
        return el('tr', { class: 'row-skip' },
          el('td', { class: 'cell-strong', text: cfg.label }),
          el('td', {}, el('span', { class: 'badge-mini', text: '未运行' })),
          el('td', { class: 'num', text: '—' }), el('td', { class: 'num', text: '—' }),
          el('td', { class: 'num', text: '—' }), el('td', { class: 'num', text: '—' }),
          el('td', { class: 'num', text: '—' }), el('td', { class: 'num', text: '—' }),
          el('td', { class: 'num', text: '—' }), el('td', { class: 'num', text: '—' }),
        );
      }
      const m = found.model;
      const s = found.summary;
      const ratioText = m?.compressionRatio != null ? fmtRatio(m.compressionRatio) : found.dtype === 'fp32' ? '基线' : '—';
      const titleParts: string[] = [];
      if (found.statusReason) titleParts.push(found.statusReason);
      if (m?.loadMs != null) titleParts.push('模型加载 ' + fmtMs(m.loadMs) + (m.warmupMs != null ? ' / 预热 ' + fmtMs(m.warmupMs) : ''));
      if (found.vectorize) titleParts.push('语料向量化 ' + fmtMs(found.vectorize.ms) + '（' + found.vectorize.docs + ' 篇 / ' + found.vectorize.batches + ' 批）');
      if (found.write) titleParts.push('写库 ' + fmtMs(found.write.writeMs) + '，刷新 ' + fmtMs(found.write.refreshMs) + '，docCount=' + found.write.docCount);
      if (s) titleParts.push('预热后中位：向量化 ' + fmtMs(s.embedMsMedian) + '，SQL ' + fmtMs(s.dbMsMedian));
      return el('tr', { class: found.status === 'ok' ? '' : 'row-skip', title: titleParts.join('；') },
        el('td', { class: 'cell-strong', text: cfg.label }),
        el('td', {}, statusCell(found)),
        el('td', { class: 'num', text: m?.onnxBytes ? fmtBytes(m.onnxBytes) : '—' }),
        el('td', { class: 'num', text: ratioText }),
        el('td', { class: 'num', text: found.vectorize ? fmtNum(found.vectorize.docsPerSec) + ' docs/s' : '—' }),
        el('td', { class: 'num', text: s ? fmtMs(s.dbMsMedian) : '—' }),
        el('td', { class: 'num', text: s ? fmtMs(s.firstRunE2eMs) : '—' }),
        el('td', { class: 'num', text: s ? fmtMs(s.e2eMsMedian) : '—' }),
        el('td', { class: 'num', text: s ? fmtPct(s.recall10) : '—' }),
        el('td', { class: 'num', text: s ? fmtFixed(s.ndcg10, 4) : '—' }),
      );
    });

    mount(
      tableSlot,
      el('div', { class: 'table-wrap', attrs: { 'data-testid': 'bench-table' } },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: '配置' }),
            el('th', { text: '状态' }),
            el('th', { class: 'num', text: '模型体积' }),
            el('th', { class: 'num', text: '压缩比' }),
            el('th', { class: 'num', text: '向量化吞吐' }),
            el('th', { class: 'num', text: 'seekdb 检索' }),
            el('th', { class: 'num', text: '端到端 首次' }),
            el('th', { class: 'num', text: '端到端 中位' }),
            el('th', { class: 'num', text: 'Recall@10' }),
            el('th', { class: 'num', text: 'nDCG@10' }),
          )),
          el('tbody', {}, ...rows),
        ),
      ),
      el('div', { class: 'small muted', attrs: { 'data-testid': 'bench-note' } },
        el('span', { text:
          '生成时间 ' + fmtTime(Date.parse(result.generatedAt)) +
          ' · 语料 ' + result.dataset.corpus + ' 篇 · 查询 ' + result.dataset.queries + ' 条 · ' +
          'crossOriginIsolated=' + result.env.crossOriginIsolated +
          ' · WebGPU=' + (result.env.webgpuAvailable ? '可用' : '不可用') +
          (result.env.webgpuAdapter ? '（' + result.env.webgpuAdapter + '）' : '')
        }),
      ),
      el('div', { class: 'small muted', text: '“端到端 首次”为第 1 次运行的单查询中位耗时；“中位”为第 2–5 次预热后的中位。Recall@10 / nDCG@10 为各次运行均值再取中位。' }),
      el('div', { class: 'small muted', text: '⚠ 评测向量与检索均在本机完成：浏览器向量化 + seekdb 单条 SQL；数字为本次运行实测，不代表云端服务。' }),
    );
  }

  function renderLogs(): void {
    const logs = store.logs.filter((l) => l.phase === 'bench').slice(-8);
    if (logs.length === 0) {
      mount(logSlot);
      return;
    }
    mount(
      logSlot,
      el('div', { class: 'log-list', attrs: { 'data-testid': 'bench-logs' } },
        ...logs.map((l) =>
          el('div', { class: 'log-line ' + (l.level === 'err' ? 'err' : l.level === 'warn' ? 'warn' : l.level === 'ok' ? 'ok' : '') },
            el('span', { class: 'log-time', text: fmtTime(l.ts) }),
            el('span', { text: l.msg }),
          ),
        ),
      ),
    );
  }

  function render(): void {
    renderIntro();
    renderProgress();
    if (localError) {
      mount(tableSlot, el('div', { class: 'notice notice-danger', text: localError }));
    } else {
      renderTable();
    }
    renderLogs();
    const running = store.busy.bench;
    runBtn.disabled = running;
    runBtn.textContent = running ? '评测中…' : '运行评测';
    exportBtn.disabled = !store.benchmark;
  }

  async function run(selector?: string | string[], runs = 5): Promise<BenchmarkResult> {
    if (store.busy.bench) throw new Error('评测正在进行中');
    localError = null;
    store.setBusy('bench', true);
    store.benchProgress = { running: true, detail: '准备评测…', progress: null };
    store.notify();
    render();
    try {
      const configs = selector == null ? undefined : Array.isArray(selector) ? selector : [selector];
      const result = await runBenchmark({
        runs,
        configs,
        onProgress: (p: BenchProgress) => {
          store.benchProgress = {
            running: true,
            configId: p.configId,
            label: p.label,
            detail: p.detail,
            progress: p.progress ?? null,
            configIndex: p.index,
            configTotal: p.total,
          };
          store.notify();
        },
        onLog: (level, msg, data) => store.log(level, msg, data, 'bench'),
      });
      store.benchmark = result;
      store.log('ok', '评测结果已生成：' + result.configs.map((c) => c.label + '=' + c.status).join('，'), undefined, 'bench');
      toast('评测完成：' + result.configs.filter((c) => c.status === 'ok').length + '/' + result.configs.length + ' 个配置成功', 'ok', 5000);
      return result;
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
      store.log('err', '评测失败：' + localError, undefined, 'bench');
      toast('评测失败：' + localError, 'err', 7000);
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      store.setBusy('bench', false);
      store.benchProgress = null;
      store.notify();
      render();
    }
  }

  runBtn.addEventListener('click', () => {
    void run().catch(() => undefined);
  });
  exportBtn.addEventListener('click', () => {
    if (!store.benchmark) {
      toast('还没有评测结果', 'warn');
      return;
    }
    downloadJson(benchmarkFileName(), store.benchmark);
    toast('已导出评测 JSON', 'ok');
  });

  render();
  return { render, run };
}
