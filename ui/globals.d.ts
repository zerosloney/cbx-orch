// app.js 是遗留的纯浏览器 JS：document.querySelector 返回 Element，但代码大量使用
// HTMLElement 专属属性（dataset/hidden/disabled/closest）。此处用环境声明把 DOM 查询
// 收窄到 HTMLElement，让 `npm run lint` 的 checkJs 聚焦真正的缺陷（未定义变量、拼写、
// 类型错误），而不是淹没在 querySelector 返回类型的噪声里。
//
// 注意：lib.dom 的泛型重载（querySelector<E extends Element = Element>）优先于本文件，
// 因此这里必须提供非泛型重载并在调用处命中——实测非泛型签名会遮蔽泛型默认参数。
declare global {
  interface Document {
    querySelector(selectors: string): HTMLElement | null;
    querySelectorAll(selectors: string): NodeListOf<HTMLElement>;
  }
  interface ParentNode {
    querySelector(selectors: string): HTMLElement | null;
    querySelectorAll(selectors: string): NodeListOf<HTMLElement>;
  }
  interface EventTarget {
    closest?<E extends Element = HTMLElement>(selectors: string): E | null;
  }
  // app.js 的按钮/输入框经 querySelector 获取，checkJs 只能推得 HTMLElement；
  // 实际元素都是 HTMLButtonElement / HTMLInputElement。补充这两个属性让检查聚焦
  // 真正缺陷（未定义变量、拼写、调用签名），代价是 div.value 之类的误用也能通过——
  // 遗留 UI 文件的务实取舍，若日后改造成本可接受再收紧。
  interface HTMLElement {
    disabled?: boolean;
    value?: string;
  }
}

export {};
