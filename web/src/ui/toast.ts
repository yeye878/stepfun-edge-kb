/** 轻量 toast 提示。 */

import { el } from '../dom';

export type ToastLevel = 'info' | 'ok' | 'warn' | 'err';

let root: HTMLElement | null = null;

function getRoot(): HTMLElement {
  if (!root) root = document.getElementById('toast-root') ?? document.body;
  return root;
}

export function toast(message: string, level: ToastLevel = 'info', ttlMs = 4200): void {
  const node = el('div', { class: 'toast ' + level, text: message });
  getRoot().appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s ease';
    setTimeout(() => node.remove(), 220);
  }, ttlMs);
}
