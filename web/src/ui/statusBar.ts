/** 顶部状态栏：后端徽标 / 模型体积与压缩比 / seekdb 状态。 */

import { store } from '../appStore';
import { el, mount } from '../dom';
import { fmtBytes, fmtRatio } from '../format';
import type { Dtype, Device } from '../types';

const DTYPE_LABEL: Record<Dtype, string> = {
  fp32: 'FP32',
  fp16: 'FP16',
  int8: 'INT8',
  q8: 'INT8',
};

export function backendBadgeText(device: Device, dtype: Dtype): string {
  return (device === 'webgpu' ? 'WebGPU' : 'WASM') + ' · ' + DTYPE_LABEL[dtype];
}

export function setupStatusBar(root: HTMLElement): { render: () => void } {
  function render(): void {
    const model = store.model;
    const nodes: HTMLElement[] = [];

    /* --- 后端徽标 --- */
    let badgeClass = 'badge badge-neutral';
    let badgeText = '模型未初始化';
    let badgeTitle = '';
    if (model.status === 'loading') {
      badgeClass = 'badge badge-neutral';
      badgeText = '模型加载中' + (model.progress != null ? ' ' + Math.round(model.progress) + '%' : '…');
      badgeTitle = model.progressText ?? '正在加载端侧模型';
    } else if (model.status === 'ready' && model.backend && model.dtype) {
      const isGpu = model.backend === 'webgpu';
      badgeClass = 'badge ' + (isGpu ? 'badge-gpu' : 'badge-wasm') + (model.stub ? ' badge-warn' : '');
      badgeText = model.stub ? 'WASM · 桩模式' : backendBadgeText(model.backend, model.dtype);
      badgeTitle =
        '实际推理后端：' + badgeText +
        (model.info ? '；WASM 线程数 ' + (model.info.wasmThreads ?? '—') + '；crossOriginIsolated=' + model.info.crossOriginIsolated : '');
    } else if (model.status === 'error') {
      badgeClass = 'badge badge-danger';
      badgeText = '模型加载失败';
      badgeTitle = model.error ?? '';
    }
    nodes.push(
      el('span', {
        class: badgeClass,
        title: badgeTitle,
        attrs: { 'data-testid': 'backend-badge', 'data-backend': model.backend ?? 'none', 'data-dtype': model.dtype ?? 'none' },
      }, el('span', { class: 'dot' }), el('span', { text: badgeText })),
    );

    /* --- 模型信息 --- */
    let modelText = 'bge-small-zh-v1.5';
    let modelTitle = '自托管 bge-small-zh-v1.5（Xenova ONNX）';
    if (model.status === 'ready' && model.info) {
      const info = model.info;
      if (model.stub) {
        modelText = '桩模式 · 无真实模型文件';
        modelTitle = '开发联调桩：未加载 ONNX 模型，向量为确定性哈希（不是推理结果）';
      } else {
        const size = fmtBytes(info.onnxBytes);
        const ratio = info.compressionRatio ? ' · 压缩比 ' + fmtRatio(info.compressionRatio) : '';
        modelText = info.modelId + ' · ' + info.dim + ' 维 · ' + size + ratio;
        modelTitle =
          'ONNX 文件：' + (info.onnxFile ?? '') + '（' + info.onnxBytes + ' B）' +
          (info.fp32Bytes ? '；FP32 基线 ' + info.fp32Bytes + ' B' : '') +
          '；池化 ' + info.pooling + ' + ' + info.normalize + ' 归一化；加载 ' + info.loadMs.toFixed(0) + 'ms / 预热 ' + info.warmupMs.toFixed(0) + 'ms';
      }
    } else if (model.status === 'loading') {
      modelText = 'bge-small-zh-v1.5 · 加载中…';
    } else if (model.status === 'error') {
      modelText = '模型未加载';
    }
    nodes.push(
      el('span', { class: 'stat-chip', attrs: { 'data-testid': 'model-info' }, title: modelTitle },
        el('span', { class: 'chip-label', text: '模型' }),
        el('span', { class: 'chip-value', text: modelText }),
      ),
    );

    /* --- DB 状态 --- */
    let dbText = 'seekdb · 未连接';
    let dbClass = 'stat-chip';
    let dbTitle = '等待后端 /api/health';
    if (store.db.status === 'ok' && store.db.health) {
      const h = store.db.health;
      dbText = 'seekdb ' + h.dbMode + ' · ' + h.dbVersion;
      dbTitle = '数据库模式：' + h.dbMode + '；版本：' + h.dbVersion + (h.uptimeMs ? '；后端运行 ' + Math.round(h.uptimeMs / 1000) + 's' : '');
    } else if (store.db.status === 'error') {
      dbText = 'seekdb · 未连接';
      dbClass = 'stat-chip';
      dbTitle = store.db.error ?? '后端不可达';
    }
    nodes.push(
      el('span', { class: dbClass, attrs: { 'data-testid': 'db-status' }, title: dbTitle },
        el('span', { class: 'chip-label', text: 'DB' }),
        el('span', { class: 'chip-value', text: dbText }),
      ),
    );

    /* --- 当前知识库 --- */
    const kb = store.activeKb();
    nodes.push(
      el('span', { class: 'stat-chip', attrs: { 'data-testid': 'kb-status' }, title: store.activeKbId ?? '' },
        el('span', { class: 'chip-label', text: '知识库' }),
        el('span', { class: 'chip-value', text: kb ? kb.name + ' · ' + kb.docCount + ' 篇' : '未选择' }),
      ),
    );

    mount(root, ...nodes);
  }
  return { render };
}
