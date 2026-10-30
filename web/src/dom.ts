/** 极简 DOM 构造工具（无框架）。 */

export type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  on?: {
    [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void;
  };
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    if (props.class) node.className = props.class;
    if (props.text != null) node.textContent = props.text;
    if (props.html != null) node.innerHTML = props.html;
    if (props.title) node.title = props.title;
    if (props.attrs) {
      for (const [k, v] of Object.entries(props.attrs)) {
        if (v == null || v === false) continue;
        node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (props.dataset) {
      for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
    }
    if (props.style) Object.assign(node.style, props.style);
    if (props.on) {
      for (const [k, fn] of Object.entries(props.on)) {
        if (fn) node.addEventListener(k, fn as EventListener);
      }
    }
  }
  appendChildren(node, children);
  return node;
}

export function appendChildren(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function mount(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  appendChildren(parent, children);
}

export function qs<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(sel);
  if (!node) throw new Error('找不到元素: ' + sel);
  return node;
}

export function qsa<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(sel));
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/** 让长文本在 3 行内折叠，点击展开/收起。 */
export function clampedText(text: string, lines = 3): HTMLElement {
  const wrap = el('div', { class: 'result-text clamp', text });
  wrap.style.setProperty('-webkit-line-clamp', String(lines));
  wrap.style.cursor = 'pointer';
  wrap.title = '点击展开/收起';
  wrap.addEventListener('click', () => {
    wrap.classList.toggle('clamp');
  });
  return wrap;
}
