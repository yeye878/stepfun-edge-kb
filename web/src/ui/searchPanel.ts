/** 检索面板：查询 + 模式 + 结果 + 单条 SQL + 分阶段耗时。 */

import { store } from '../appStore';
import { clampedText, el, mount } from '../dom';
import { fmtFixed, fmtMs } from '../format';
import { describeApiError, search } from '../services';
import type { SearchMode, SearchResultView } from '../types';
import { toast } from './toast';

const MODE_LABEL: Record<SearchMode, string> = {
  hybrid: '混合检索',
  vector: '纯向量',
  fulltext: '纯全文',
};

export function setupSearchPanel(root: HTMLElement, headFlag: HTMLElement): { render: () => void } {
  let localError: string | null = null;

  const input = el('input', {
    class: 'input',
    attrs: {
      placeholder: '输入查询，例如：向量数据库如何保证检索性能？',
      'data-testid': 'search-input',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const modeSelect = el('select', { class: 'select select-sm', attrs: { 'data-testid': 'search-mode' } },
    el('option', { attrs: { value: 'hybrid' }, text: '混合 hybrid' }),
    el('option', { attrs: { value: 'vector' }, text: '纯向量 vector' }),
    el('option', { attrs: { value: 'fulltext' }, text: '纯全文 fulltext' }),
  );
  const kInput = el('input', {
    class: 'input input-sm',
    attrs: { type: 'number', min: '1', max: '50', step: '1', value: '10', style: 'width:76px', title: '返回条数 k' },
  });
  const btnSearch = el('button', {
    class: 'btn btn-primary',
    text: '检索',
    attrs: { 'data-testid': 'search-button' },
  });

  const timingsSlot = el('div');
  const resultSlot = el('div');
  const sqlSlot = el('div');

  mount(
    root,
    el('div', { class: 'row' },
      el('div', { class: 'field grow' }, el('label', { text: '查询' }), input),
      el('div', { class: 'field' }, el('label', { text: '模式' }), modeSelect),
      el('div', { class: 'field' }, el('label', { text: 'k' }), kInput),
      el('div', { class: 'field' }, el('label', { text: ' ' }), btnSearch),
    ),
    timingsSlot,
    resultSlot,
    sqlSlot,
  );

  function currentMode(): SearchMode {
    const v = modeSelect.value;
    return v === 'vector' || v === 'fulltext' ? v : 'hybrid';
  }

  function currentK(): number {
    const n = Number.parseInt(kInput.value, 10);
    if (!Number.isFinite(n)) return 10;
    return Math.min(50, Math.max(1, n));
  }

  async function doSearch(): Promise<void> {
    const kb = store.activeKb();
    if (!kb) {
      toast('请先新建或选择知识库', 'warn');
      return;
    }
    const query = input.value.trim();
    if (!query) {
      toast('请输入查询内容', 'warn');
      input.focus();
      return;
    }
    const mode = currentMode();
    if (mode !== 'fulltext' && store.model.status !== 'ready') {
      toast('模型尚未就绪，无法向量化查询', 'warn');
      return;
    }
    localError = null;
    store.setBusy('search', true);
    render();
    try {
      await search(kb.id, { mode, query, k: currentK() });
    } catch (err) {
      localError = describeApiError(err);
      store.log('err', '检索失败：' + localError, undefined, 'search');
      toast('检索失败：' + localError, 'err', 6000);
    } finally {
      store.setBusy('search', false);
      render();
    }
  }

  btnSearch.addEventListener('click', () => void doSearch());
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void doSearch();
  });
  kInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void doSearch();
  });
  modeSelect.addEventListener('change', () => render());

  function renderTimings(view: SearchResultView | null): void {
    if (!view) {
      mount(timingsSlot);
      return;
    }
    const t = view.timings;
    const mode = view.response.mode;
    const embedText = mode === 'fulltext' ? '跳过' : fmtMs(t.embedMs);
    mount(
      timingsSlot,
      el('div', { class: 'timing-row', attrs: { 'data-testid': 'search-timings' } },
        el('div', { class: 'timing' },
          el('div', { class: 't-label', text: '查询向量化' }),
          el('div', { class: 't-value', text: embedText }),
        ),
        el('div', { class: 'timing' },
          el('div', { class: 't-label', text: 'seekdb 检索（SQL）' }),
          el('div', { class: 't-value', text: fmtMs(t.dbMs) }),
        ),
        el('div', { class: 'timing' },
          el('div', { class: 't-label', text: 'HTTP 往返' }),
          el('div', { class: 't-value', text: fmtMs(t.apiMs) }),
        ),
        el('div', { class: 'timing accent' },
          el('div', { class: 't-label', text: '端到端' }),
          el('div', { class: 't-value', text: fmtMs(t.e2eMs) }),
        ),
      ),
    );
  }

  function renderRows(view: SearchResultView | null): void {
    if (!view) {
      mount(
        resultSlot,
        el('div', { class: 'empty', attrs: { 'data-testid': 'result-list' } },
          el('strong', { text: '等待检索' }),
          el('span', { text: '导入文档后输入查询；混合检索会在一条 SQL 内完成全文过滤 + 向量排序。' }),
        ),
      );
      return;
    }
    const rows = view.response.rows ?? [];
    if (rows.length === 0) {
      mount(
        resultSlot,
        el('div', { class: 'empty', attrs: { 'data-testid': 'result-list' } },
          el('strong', { text: '没有命中结果' }),
          el('span', { text: '可尝试更换查询词或切换到纯向量模式（混合模式要求全文条件先命中）。' }),
        ),
      );
      return;
    }
    const items = rows.map((row, idx) => {
      const meta = row.meta && typeof row.meta === 'object' ? (row.meta as Record<string, unknown>) : null;
      const title = meta && typeof meta.title === 'string' ? meta.title : null;
      const pills: HTMLElement[] = [];
      if (row.score != null && Number.isFinite(row.score)) {
        pills.push(el('span', { class: 'score-pill', text: 'score ' + fmtFixed(row.score, 4) }));
      }
      if (row.distance != null && Number.isFinite(row.distance)) {
        pills.push(el('span', { class: 'score-pill', text: 'distance ' + fmtFixed(row.distance, 4) }));
      }
      return el('div', { class: 'result-item', attrs: { 'data-rank': String(idx + 1), 'data-id': row.id } },
        el('div', { class: 'result-head' },
          el('span', { class: 'rank' + (idx < 3 ? ' top' : ''), text: String(idx + 1) }),
          ...pills,
          title ? el('span', { class: 'tag', text: title }) : null,
          row.category ? el('span', { class: 'tag', text: row.category }) : null,
        ),
        clampedText(row.text ?? '', 3),
        el('div', { class: 'result-meta' },
          el('span', { class: 'mono', text: row.id }),
          el('span', { text: (row.text ?? '').length + ' 字' }),
        ),
      );
    });
    mount(resultSlot, el('div', { class: 'result-list', attrs: { 'data-testid': 'result-list' } }, ...items));
  }

  function renderSql(view: SearchResultView | null): void {
    if (!view || !view.response.sql) {
      mount(sqlSlot);
      return;
    }
    const copyBtn = el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '复制',
      attrs: { type: 'button' },
    });
    copyBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void navigator.clipboard
        .writeText(view.response.sql)
        .then(() => toast('SQL 已复制', 'ok'))
        .catch(() => toast('复制失败（剪贴板不可用）', 'warn'));
    });
    mount(
      sqlSlot,
      el('details', { class: 'disclosure', attrs: { 'data-testid': 'sql-details' } },
        el('summary', {},
          el('span', { text: '单条 SQL（服务端实际执行）' }),
          el('span', { class: 'sum-note', text: '混合检索在库内完成，非客户端拼合' }),
          el('span', { class: 'grow' }),
          copyBtn,
        ),
        el('pre', { text: view.response.sql }),
      ),
    );
  }

  function renderHead(view: SearchResultView | null): void {
    if (!view) {
      headFlag.textContent = '尚未检索';
      headFlag.classList.remove('active');
      return;
    }
    headFlag.textContent = MODE_LABEL[view.response.mode] + ' · ' + view.response.rows.length + ' 条 · k=' + view.response.k;
    headFlag.classList.add('active');
  }

  function render(): void {
    const kb = store.activeKb();
    const mode = currentMode();
    const needModel = mode !== 'fulltext';
    const modelReady = store.model.status === 'ready';
    btnSearch.disabled = !kb || store.busy.search || (needModel && !modelReady);
    btnSearch.textContent = store.busy.search ? '检索中…' : '检索';
    input.disabled = store.busy.search;

    const view = store.lastSearch;
    renderHead(view);
    renderTimings(view);
    if (localError) {
      mount(resultSlot, el('div', { class: 'notice notice-danger', text: localError }));
      mount(sqlSlot);
      return;
    }
    renderRows(view && view.kbId === store.activeKbId ? view : null);
    renderSql(view && view.kbId === store.activeKbId ? view : null);
  }

  render();
  return { render };
}
