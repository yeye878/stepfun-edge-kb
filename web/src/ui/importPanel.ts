/** 导入面板：知识库选择/新建、文本与文件导入、批量进度、写入耗时。 */

import { store } from '../appStore';
import { el, mount } from '../dom';
import { fmtMs } from '../format';
import {
  createKb,
  deleteKb,
  describeApiError,
  importTexts,
  refreshKbList,
  selectKb,
  type ImportInputItem,
} from '../services';
import { toast } from './toast';

const EXAMPLE_PLACEHOLDER =
  '粘贴文本，空行分隔多篇文档。例如：\n\nseekdb 是 OceanBase 推出的 AI 原生数据库，支持向量、全文与标量混合检索。\n\n向量索引（HNSW）通过近似最近邻搜索，在召回率与延迟之间取得平衡。';

function parseTextBlob(raw: string, splitByBlankLine: boolean): string[] {
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const parts = splitByBlankLine ? text.split(/\n\s*\n/) : text.split(/\n/);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function parseJsonDocs(raw: string): ImportInputItem[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error('JSON 解析失败：' + (err instanceof Error ? err.message : String(err)));
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { docs?: unknown[] }).docs)
      ? ((data as { docs: unknown[] }).docs)
      : [];
  if (list.length === 0) throw new Error('JSON 中没有找到文档数组（支持 [{text,...}] 或 {docs:[...]}）');
  const items: ImportInputItem[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) items.push({ text });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const text = typeof obj.text === 'string' ? obj.text.trim() : typeof obj.content === 'string' ? obj.content.trim() : '';
      if (!text) continue;
      items.push({
        id: typeof obj.id === 'string' ? obj.id : undefined,
        text,
        category: typeof obj.category === 'string' ? obj.category : undefined,
        meta: (obj.meta && typeof obj.meta === 'object' ? (obj.meta as Record<string, unknown>) : undefined),
      });
    }
  }
  if (items.length === 0) throw new Error('JSON 文档数组里没有可用文本（需要 text 字段）');
  return items;
}

export function setupImportPanel(root: HTMLElement): { render: () => void } {
  const headFlag = document.getElementById('import-kb-flag');
  let pending: ImportInputItem[] = [];
  let pendingSource = '';
  let showCreate = false;
  let autoOpenedCreate = false;
  let localError: string | null = null;

  /* ---------- 静态骨架 ---------- */
  const kbSelect = el('select', { class: 'select select-sm', attrs: { 'data-testid': 'kb-select' } });
  const btnNew = el('button', { class: 'btn btn-ghost btn-sm', text: '新建' });
  const btnDelete = el('button', { class: 'btn btn-ghost btn-sm', text: '删除', title: '删除当前知识库（DROP TABLE）' });

  const createRow = el('div', { class: 'row' },
    el('input', { class: 'input input-sm grow', attrs: { placeholder: '新知识库名称，例如：产品手册' } }),
    el('button', { class: 'btn btn-primary btn-sm', text: '创建' }),
    el('button', { class: 'btn btn-ghost btn-sm', text: '取消' }),
  );
  const createInput = createRow.querySelector('input') as HTMLInputElement;
  const createBtn = createRow.children[1] as HTMLButtonElement;
  const cancelBtn = createRow.children[2] as HTMLButtonElement;
  createRow.classList.add('hidden');

  const textarea = el('textarea', {
    class: 'textarea',
    attrs: {
      placeholder: EXAMPLE_PLACEHOLDER,
      rows: '6',
      'data-testid': 'import-textarea',
      spellcheck: 'false',
    },
  });

  const checkBlank = el('input', { attrs: { type: 'checkbox', checked: true } });
  const checkLine = el('label', { class: 'checkline' }, checkBlank, el('span', { text: '按空行分段' }));
  const parseHint = el('span', { class: 'small muted', text: '解析到 0 篇文档' });

  const fileInput = el('input', { attrs: { type: 'file', accept: '.txt,.md,.json,text/plain,application/json' } });
  const fileBtn = el('label', { class: 'btn btn-ghost btn-sm file-btn' }, el('span', { text: '选择文件 .txt / .md / .json' }), fileInput);
  const fileHint = el('span', { class: 'small muted' });

  const btnImport = el('button', {
    class: 'btn btn-primary',
    text: '导入并写入 seekdb',
    attrs: { 'data-testid': 'import-button' },
  });

  const hint = el('span', { class: 'small muted' });
  const progressSlot = el('div');
  const resultSlot = el('div');

  mount(
    root,
    el('div', { class: 'row' },
      el('div', { class: 'field grow' }, el('label', { text: '知识库' }), kbSelect),
      btnNew,
      btnDelete,
    ),
    createRow,
    el('div', { class: 'field' },
      el('label', { text: '文本导入' }),
      textarea,
    ),
    el('div', { class: 'row row-tight' },
      checkLine,
      parseHint,
      el('span', { class: 'grow' }),
      fileBtn,
    ),
    el('div', { class: 'row row-tight' }, fileHint),
    el('div', { class: 'row' }, btnImport, hint),
    progressSlot,
    resultSlot,
  );

  /* ---------- 行为 ---------- */

  function refreshFromTextarea(): void {
    pending = parseTextBlob(textarea.value, checkBlank.checked).map((text) => ({ text }));
    pendingSource = '文本框';
    localError = null;
    render();
  }

  textarea.addEventListener('input', refreshFromTextarea);
  checkBlank.addEventListener('change', refreshFromTextarea);

  kbSelect.addEventListener('change', () => {
    const id = kbSelect.value;
    if (id) {
      void selectKb(id)
        .then(() => render())
        .catch((err) => toast(describeApiError(err), 'err'));
    }
  });

  btnNew.addEventListener('click', () => {
    showCreate = !showCreate;
    autoOpenedCreate = false;
    if (showCreate) {
      createRow.classList.remove('hidden');
      createInput.focus();
    } else {
      createRow.classList.add('hidden');
    }
    render();
  });
  cancelBtn.addEventListener('click', () => {
    showCreate = false;
    createRow.classList.add('hidden');
    render();
  });
  const doCreate = async (): Promise<void> => {
    const name = createInput.value.trim();
    if (!name) {
      toast('请输入知识库名称', 'warn');
      return;
    }
    createBtn.disabled = true;
    try {
      const kb = await createKb(name);
      createInput.value = '';
      showCreate = false;
      autoOpenedCreate = false;
      createRow.classList.add('hidden');
      toast('知识库已就绪：' + kb.name, 'ok');
    } catch (err) {
      toast(describeApiError(err), 'err');
      store.log('err', '新建知识库失败：' + describeApiError(err), undefined, 'db');
    } finally {
      createBtn.disabled = false;
      render();
    }
  };
  createBtn.addEventListener('click', () => void doCreate());
  createInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void doCreate();
  });

  btnDelete.addEventListener('click', async () => {
    const kb = store.activeKb();
    if (!kb) return;
    if (!window.confirm('确认删除知识库「' + kb.name + '」？将 DROP 该库的数据表，不可恢复。')) return;
    try {
      await deleteKb(kb.id);
      toast('已删除：' + kb.name, 'ok');
    } catch (err) {
      toast(describeApiError(err), 'err');
    }
    render();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.json')) {
        pending = parseJsonDocs(raw);
        pendingSource = file.name;
        textarea.value = '';
      } else {
        textarea.value = raw;
        pending = parseTextBlob(raw, checkBlank.checked).map((text) => ({ text }));
        pendingSource = file.name;
      }
      fileHint.textContent = '已读取 ' + file.name + '（' + (file.size / 1024).toFixed(1) + ' KB）';
      localError = null;
      toast('文件已解析：' + file.name, 'ok');
    } catch (err) {
      localError = err instanceof Error ? err.message : String(err);
      toast(localError, 'err');
      fileHint.textContent = '';
      pending = [];
    }
    render();
  });

  btnImport.addEventListener('click', async () => {
    const kbId = store.activeKbId;
    if (!kbId) {
      toast('请先新建或选择知识库', 'warn');
      return;
    }
    if (pending.length === 0) {
      toast('没有可导入的文本', 'warn');
      return;
    }
    const modelReady = store.model.status === 'ready';
    if (!modelReady) {
      toast('模型尚未就绪，无法在浏览器内向量化', 'warn');
      return;
    }
    store.setBusy('import', true);
    localError = null;
    render();
    try {
      const summary = await importTexts(kbId, pending);
      toast('导入完成：写入 ' + summary.inserted + ' 篇', 'ok');
      textarea.value = '';
      pending = [];
      pendingSource = '';
      fileInput.value = '';
      fileHint.textContent = '';
      await refreshKbList().catch(() => undefined);
    } catch (err) {
      localError = describeApiError(err);
      store.log('err', '导入失败：' + localError, undefined, 'import');
      toast('导入失败：' + localError, 'err', 6000);
    } finally {
      store.setBusy('import', false);
      render();
    }
  });

  /* ---------- 渲染 ---------- */

  function renderKbSelect(): void {
    const current = store.activeKbId;
    mount(
      kbSelect,
      el('option', { attrs: { value: '' }, text: store.kbs.length === 0 ? '（暂无知识库，请先新建）' : '请选择知识库' }),
      ...store.kbs.map((kb) =>
        el('option', { attrs: { value: kb.id, selected: kb.id === current }, text: kb.name + '（' + kb.docCount + ' 篇）' }),
      ),
    );
    kbSelect.value = current ?? '';
    kbSelect.disabled = store.busy.import;
    btnDelete.disabled = !store.activeKb() || store.busy.import;
  }

  function renderParseHint(): void {
    const mode = checkBlank.checked ? '按空行分段' : '按行分段';
    parseHint.textContent =
      '解析到 ' + pending.length + ' 篇文档（' + mode + (pendingSource ? ' · 来源：' + pendingSource : '') + '）';
  }

  function renderProgress(): void {
    const progress = store.importProgress;
    const busy = store.busy.import;
    if (busy && progress) {
      const pct = progress.total > 0 ? Math.min(100, (progress.vectorized / progress.total) * 100) : 0;
      const fill = el('div', {
        class: 'progress-fill' + (progress.phase === 'embed' && progress.total === 0 ? ' indeterminate' : ''),
        style: { width: pct.toFixed(1) + '%' },
      });
      mount(
        progressSlot,
        el('div', { class: 'progress-wrap', attrs: { 'data-testid': 'import-progress' } },
          el('div', { class: 'progress-meta' },
            el('span', { text: progress.message }),
            el('span', {
              text:
                '已向量化 ' + progress.vectorized + '/' + progress.total +
                ' · 已写入 ' + progress.written + '/' + progress.total +
                ' · 向量化 ' + fmtMs(progress.embedMs) + ' · 写入 ' + fmtMs(progress.writeMs),
            }),
          ),
          el('div', { class: 'progress-track' }, fill),
        ),
      );
    } else if (store.lastImport && store.lastImport.kbId === store.activeKbId) {
      const last = store.lastImport;
      mount(
        progressSlot,
        el('div', { class: 'timing-row', attrs: { 'data-testid': 'import-summary' } },
          el('div', { class: 'timing' }, el('div', { class: 't-label', text: '本次写入' }), el('div', { class: 't-value', text: last.inserted + ' 篇' })),
          el('div', { class: 'timing' }, el('div', { class: 't-label', text: '向量化' }), el('div', { class: 't-value', text: fmtMs(last.vectorizeMs) })),
          el('div', { class: 'timing' }, el('div', { class: 't-label', text: '写入 seekdb' }), el('div', { class: 't-value', text: fmtMs(last.writeMs) })),
          el('div', { class: 'timing' }, el('div', { class: 't-label', text: '刷新索引' }), el('div', { class: 't-value', text: fmtMs(last.refreshMs) })),
          el('div', { class: 'timing accent' }, el('div', { class: 't-label', text: '端到端' }), el('div', { class: 't-value', text: fmtMs(last.totalMs) })),
        ),
      );
    } else {
      mount(progressSlot);
    }
  }

  function renderResult(): void {
    if (localError) {
      mount(resultSlot, el('div', { class: 'notice notice-danger', text: localError }));
    } else {
      mount(resultSlot);
    }
  }

  function renderHeadFlag(): void {
    if (!headFlag) return;
    const kb = store.activeKb();
    if (kb) {
      headFlag.textContent = kb.name + ' · ' + kb.docCount + ' 篇';
      headFlag.classList.add('active');
    } else {
      headFlag.textContent = '未选择知识库';
      headFlag.classList.remove('active');
    }
    headFlag.title = kb ? kb.id + ' / ' + kb.table : '';
  }

  function render(): void {
    renderKbSelect();
    renderHeadFlag();
    renderParseHint();
    renderProgress();
    renderResult();

    const modelReady = store.model.status === 'ready';
    const kb = store.activeKb();
    btnImport.disabled = !kb || pending.length === 0 || !modelReady || store.busy.import;
    btnImport.textContent = store.busy.import ? '导入中…' : '导入并写入 seekdb';

    if (!modelReady && store.model.status === 'loading') {
      hint.textContent = '模型加载中，加载完成后可导入';
    } else if (!modelReady) {
      hint.textContent = '模型未就绪';
    } else if (!kb) {
      hint.textContent = '请先新建知识库';
    } else {
      hint.textContent = '向量在浏览器内计算，后端只负责写入 seekdb';
    }

    if (store.kbs.length === 0 && !showCreate) {
      showCreate = true;
      autoOpenedCreate = true;
      createRow.classList.remove('hidden');
    } else if (store.kbs.length > 0 && showCreate && autoOpenedCreate) {
      // 有知识库后自动收起「新建」表单（用户手动打开的保持显示）
      showCreate = false;
      autoOpenedCreate = false;
      createRow.classList.add('hidden');
    }
  }

  render();
  return { render };
}
