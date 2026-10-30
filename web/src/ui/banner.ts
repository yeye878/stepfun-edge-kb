/** 顶部提示条：模型降级原因 / 模型加载失败 / 后端不可达 / 桩模式。 */

import { store } from '../appStore';
import { el, mount } from '../dom';

export interface BannerActions {
  retryModel: () => void;
  retryDb: () => void;
}

export function setupBanner(root: HTMLElement, actions: BannerActions): { render: () => void } {
  function render(): void {
    const nodes: HTMLElement[] = [];
    const model = store.model;
    const retryModelBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '重试加载模型', on: { click: () => actions.retryModel() } });
    const retryDbBtn = el('button', { class: 'btn btn-ghost btn-sm', text: '重连后端', on: { click: () => actions.retryDb() } });

    if (model.status === 'ready' && model.stub) {
      nodes.push(
        el('div', { class: 'banner banner-danger', attrs: { 'data-testid': 'stub-banner' } },
          el('div', { class: 'banner-body' },
            el('strong', { text: '桩模式（仅 UI/接口联调）' }),
            el('span', { text: '　未找到真实 ONNX 模型文件，向量为确定性哈希，不能用于任何精度/性能结论。请先执行 npm run fetch:models 后点“重试加载模型”。' }),
          ),
          el('div', { class: 'banner-actions' }, retryModelBtn),
        ),
      );
    } else if (model.status === 'error') {
      nodes.push(
        el('div', { class: 'banner banner-danger', attrs: { 'data-testid': 'model-error-banner' } },
          el('div', { class: 'banner-body' },
            el('strong', { text: '模型初始化失败' }),
            el('span', { text: '　' + (model.error ?? '未知错误') + '　（检查 web/public/models/bge-small-zh-v1.5/ 是否完整）' }),
          ),
          el('div', { class: 'banner-actions' }, retryModelBtn),
        ),
      );
    } else if (model.status === 'ready' && model.fallbackReason) {
      nodes.push(
        el('div', { class: 'banner', attrs: { 'data-testid': 'fallback-banner' } },
          el('div', { class: 'banner-body' },
            el('strong', { text: '已自动降级至 ' + (model.backend === 'webgpu' ? 'WebGPU' : 'WASM') + ' · ' + (model.dtype ?? '').toUpperCase() }),
            el('span', { text: '　原因：' + model.fallbackReason + '。界面与评测均以实际后端为准。' }),
          ),
          el('div', { class: 'banner-actions' }, retryModelBtn),
        ),
      );
    }

    if (store.db.status === 'error') {
      nodes.push(
        el('div', { class: 'banner banner-danger', attrs: { 'data-testid': 'db-error-banner' } },
          el('div', { class: 'banner-body' },
            el('strong', { text: '后端 / seekdb 不可达' }),
            el('span', { text: '　' + (store.db.error ?? '') + '　请先启动 node server/index.mjs（127.0.0.1:18270）。' }),
          ),
          el('div', { class: 'banner-actions' }, retryDbBtn),
        ),
      );
    }

    mount(root, ...nodes);
  }
  return { render };
}
