/** 数据层面板：docCount / 刷新索引 / DDL / 索引 / 库信息 / 示例 SQL。 */

import { store } from '../appStore';
import { el, mount } from '../dom';
import { fmtMs } from '../format';
import { describeApiError, loadDbInfo, loadStats, refreshIndex } from '../services';
import { toast } from './toast';

export function setupDataPanel(root: HTMLElement, refreshBtn: HTMLButtonElement): { render: () => void } {
  let lastRefresh: { docCount: number; refreshMs: number; at: number } | null = null;
  let localError: string | null = null;

  const docSlot = el('div');
  const infoSlot = el('div');
  const ddlSlot = el('div');
  const indexSlot = el('div');
  const sampleSqlSlot = el('div');

  mount(root, docSlot, infoSlot, ddlSlot, indexSlot, sampleSqlSlot);

  async function doRefresh(): Promise<void> {
    const kb = store.activeKb();
    if (!kb) {
      toast('请先新建或选择知识库', 'warn');
      return;
    }
    refreshBtn.disabled = true;
    localError = null;
    render();
    try {
      const res = await refreshIndex(kb.id);
      lastRefresh = { docCount: res.docCount, refreshMs: res.refreshMs, at: Date.now() };
      await Promise.all([loadStats(kb.id).catch(() => null), loadDbInfo().catch(() => null)]);
      toast('索引已刷新：' + res.docCount + ' 篇，' + fmtMs(res.refreshMs), 'ok');
    } catch (err) {
      localError = describeApiError(err);
      store.log('err', '刷新索引失败：' + localError, undefined, 'db');
      toast('刷新失败：' + localError, 'err');
    } finally {
      refreshBtn.disabled = false;
      render();
    }
  }

  refreshBtn.addEventListener('click', () => void doRefresh());

  function renderDocCount(): void {
    const kb = store.activeKb();
    if (!kb) {
      mount(docSlot, el('div', { class: 'empty' }, el('strong', { text: '未选择知识库' }), el('span', { text: '在导入面板新建或选择一个知识库。' })));
      return;
    }
    const refreshMeta = lastRefresh
      ? '最近刷新：' + lastRefresh.docCount + ' 篇 · ' + fmtMs(lastRefresh.refreshMs)
      : '写入后需显式刷新索引（就绪探针）';
    mount(
      docSlot,
      el('div', { class: 'row', attrs: { 'data-testid': 'doc-count' } },
        el('div', { class: 'doc-count' },
          el('span', { class: 'num', text: String(kb.docCount) }),
          el('span', { class: 'unit', text: '篇文档' }),
        ),
        el('span', { class: 'grow' }),
        el('span', { class: 'small muted', text: refreshMeta }),
      ),
      el('div', { class: 'kv' },
        el('span', { class: 'k', text: '知识库' }), el('span', { class: 'v', text: kb.name + '（' + kb.id + '）' }),
        el('span', { class: 'k', text: '数据表' }), el('span', { class: 'v mono', text: kb.table }),
        el('span', { class: 'k', text: '模型 / 维度' }), el('span', { class: 'v', text: kb.model + ' · ' + kb.dim + ' 维' }),
      ),
    );
  }

  function renderInfo(): void {
    const db = store.dbInfo;
    if (!db) {
      mount(infoSlot);
      return;
    }
    const rows: HTMLElement[] = [
      el('span', { class: 'k', text: '模式' }), el('span', { class: 'v', text: db.mode }),
      el('span', { class: 'k', text: '版本' }), el('span', { class: 'v', text: db.version }),
    ];
    if (db.bindings) rows.push(el('span', { class: 'k', text: '原生绑定' }), el('span', { class: 'v mono', text: db.bindings }));
    if (db.path) rows.push(el('span', { class: 'k', text: '数据目录' }), el('span', { class: 'v mono', text: db.path }));
    mount(infoSlot, el('div', { class: 'kv', attrs: { 'data-testid': 'db-info' } }, ...rows));
  }

  function renderDdl(): void {
    const stats = store.stats;
    if (!stats || !stats.createTableSql) {
      mount(ddlSlot);
      return;
    }
    mount(
      ddlSlot,
      el('details', { class: 'disclosure', attrs: { 'data-testid': 'ddl-details' } },
        el('summary', {}, el('span', { text: '建表 DDL（FULLTEXT + VECTOR 索引）' })),
        el('pre', { text: stats.createTableSql }),
      ),
    );
  }

  function renderIndexes(): void {
    const stats = store.stats;
    if (!stats || !Array.isArray(stats.indexes) || stats.indexes.length === 0) {
      mount(indexSlot);
      return;
    }
    mount(
      indexSlot,
      el('div', { class: 'table-wrap', attrs: { 'data-testid': 'index-table' } },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {},
            el('th', { text: '索引' }), el('th', { text: '类型' }), el('th', { text: '列' }),
          )),
          el('tbody', {}, ...stats.indexes.map((idx) =>
            el('tr', {},
              el('td', { class: 'mono', text: idx.name }),
              el('td', { text: idx.type }),
              el('td', { class: 'mono', text: idx.columns ?? (idx as unknown as { column?: string }).column ?? '—' }),
            ),
          )),
        ),
      ),
    );
  }

  function renderSampleSql(): void {
    const stats = store.stats;
    if (!stats || !stats.sampleHybridSql) {
      mount(sampleSqlSlot);
      return;
    }
    mount(
      sampleSqlSlot,
      el('details', { class: 'disclosure', attrs: { 'data-testid': 'sample-sql' } },
        el('summary', {}, el('span', { text: '示例混合检索 SQL' }), el('span', { class: 'sum-note', text: 'MATCH + l2_distance(APPROXIMATE) 单条完成' })),
        el('pre', { text: stats.sampleHybridSql }),
      ),
    );
  }

  function render(): void {
    renderDocCount();
    renderInfo();
    renderDdl();
    renderIndexes();
    renderSampleSql();
    if (localError) {
      mount(infoSlot, el('div', { class: 'notice notice-danger', text: localError }));
    }
  }

  render();
  return { render };
}
