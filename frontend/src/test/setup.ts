/**
 * vitest 的全局 setup：把 jsdom 缺的那几件浏览器设施补齐。
 *
 * 补在这里而不是每个测试文件里 `vi.mock` 掉用到它们的模块。差别不是行数：
 * mock 掉共享包的主题模块的话，被测的就不再是 ThemeProvider 与 useTheme 的
 * 真实接线，而是一份手写的返回值——顶栏能不能从 context 里拿到主题，
 * 单测就再也答不上来了。环境缺什么就补什么，被测代码保持原样。
 *
 * 四处缺口：
 *
 * 1. localStorage。Node 22 起 globalThis 上有一个内置的 localStorage getter，
 *    没给 `--localstorage-file` 时它解析成 undefined，而且盖住了 jsdom 自己的
 *    实现（vitest 只往 globalThis 上补 jsdom 没被占用的键）。于是
 *    `window.localStorage` 和裸 `localStorage` 都是 undefined，
 *    主题的存储读取一上来就 TypeError。
 * 2. matchMedia。jsdom 从来没实现过它，ThemeProvider 要靠它读系统深浅色。
 *
 * 3. scrollIntoView。jsdom 没有实现，Radix 的 Select 打开时要用它把选中项滚进视野。
 *
 * 4. ResizeObserver。jsdom 没有实现，而转录的行虚拟化（@tanstack/react-virtual）
 *    拿它测量视口与行高——缺了它，虚拟器在装配的第一步就抛。
 *
 * 5. isSecureContext。jsdom 没有实现（是 undefined，不是 false）。通行密钥那条
 *    「不能用是因为浏览器太老，还是因为这个源信不过」的判断要读它。
 *
 * 6. Range 的取矩形。jsdom 只在 Element 上实现了 getClientRects /
 *    getBoundingClientRect，Range 上一个都没有，而输入框每派发一次事务，
 *    ProseMirror 都要量选区的位置好把它滚进视野。
 *
 * 六处都只在「当前环境确实没有」时才安装，真浏览器行为优先。
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

function installStorage(name: "localStorage" | "sessionStorage") {
  let usable = false;
  try {
    usable = typeof (globalThis as Record<string, unknown>)[name] === "object";
  } catch {
    // 内置 getter 也可能直接抛，一样算不可用
  }
  if (usable) return;
  const storage = new MemoryStorage();
  // configurable，所以能盖掉 Node 那个内置 getter；window 与 globalThis
  // 在 jsdom 环境下是同一个对象，定义一次两边都认。
  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
    writable: true,
  });
}

installStorage("localStorage");
installStorage("sessionStorage");

if (typeof window.matchMedia !== "function") {
  // 只回答「不偏好深色」，并接住监听器的注册与注销。测试要断言深色时
  // 自己往 documentElement 上挂 class，不靠这层。
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (typeof Element.prototype.scrollIntoView !== "function") {
  // 3. scrollIntoView。jsdom 没有实现，而 Radix 的 Select 打开时会把选中项滚进
  //    视野——缺了它整颗下拉一打开就抛，连带把用例的失败原因说成「找不到那一项」。
  Element.prototype.scrollIntoView = () => {};
}

if (typeof globalThis.ResizeObserver !== "function") {
  // 4. ResizeObserver。只接住注册与注销，**从不回调** —— jsdom 里没有布局，回调
  //    能报的也只有一堆 0。虚拟器因此一直用 estimateSize 的估算值，与
  //    Transcript 里「量不出视口高度就整列渲染」那条回落合起来，用例看到的是
  //    完整的行列表（见那段注释）。
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}

if (typeof Range.prototype.getClientRects !== "function") {
  // 6. Range 的取矩形。缺了它，TipTap 每次 dispatch 事务后 ProseMirror 的
  //    scrollToSelection 都会在 singleRect 里抛。那一抛发生在 ProseMirror 内部、
  //    不在任何 await 的调用栈上，所以用例照旧全绿、整轮 vitest 却因为未捕获异常
  //    退非零——症状与被测行为对不上，最难找的就是这一类。
  //
  //    jsdom 里没有布局，只能给零矩形（Element 上那份实现给的也是零），与
  //    ResizeObserver 那处同一取舍：接住调用，不假装量得出东西。
  const emptyRectList = () =>
    Object.assign([] as DOMRect[], {
      item: () => null,
    }) as unknown as DOMRectList;
  Range.prototype.getClientRects = emptyRectList;
  // singleRect 在 getClientRects() 为空时回落到这一个，所以两个都要装。
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

if (!("isSecureContext" in window)) {
  // 5. isSecureContext。**装的时候按当时的源算一次**，之后不再跟着 location 走：
  //    好几个用例会把 window.location 整个换成一个字面量对象（Login.tsx 直接读
  //    window.location.search），跟着它走的话那些用例会莫名其妙地变成「不安全的源」。
  //
  //    算法照浏览器的可信源规则：https，或 localhost / 环回地址。vitest 的 jsdom
  //    默认跑在 http://localhost:3000 上，真浏览器在那里报的正是 true。
  //    装成取值器而不是数据属性，这样用例能用 vi.spyOn(window, "isSecureContext",
  //    "get") 把它换掉。
  const secure =
    location.protocol === "https:" ||
    ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    get: () => secure,
  });
}
