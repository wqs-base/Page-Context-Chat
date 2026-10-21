(() => {
  // 扩展被重新加载/更新后，已打开页面里的旧内容脚本会失去 chrome.runtime 通道（孤儿脚本）。
  // 后台会检测到并重新注入本脚本；此时旧 UI 节点还在，必须先清掉再重建，
  // 否则新脚本会被下面的判断挡住直接退出，消息监听根本不会注册。
  document.getElementById("page-context-chat-root")?.remove();
  document.getElementById("page-context-chat-cursor")?.remove();

  const MAX_TEXT_LENGTH = 30000;
  const MAX_ELEMENTS = 80;

  const host = document.createElement("div");
  host.id = "page-context-chat-root";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .launcher, .panel, button { font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .launcher {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      height: 44px; padding: 0 16px; border: 1px solid #1c5f4a; border-radius: 6px;
      background: #176b52; color: #fff; font-size: 14px; font-weight: 650; letter-spacing: 0;
      box-shadow: 0 8px 24px rgba(14, 38, 31, .2); cursor: pointer;
    }
    .launcher:hover { background: #125640; }
    .launcher:focus-visible, button:focus-visible, input:focus-visible {
      outline: 2px solid #e1a03d; outline-offset: 2px;
    }
    .panel {
      position: fixed; right: 20px; bottom: 76px; z-index: 2147483647;
      width: min(360px, calc(100vw - 24px));
      display: none; overflow: hidden; border: 1px solid #c8cfcc; border-radius: 8px;
      background: #f7f9f8; color: #15211d; box-shadow: 0 18px 50px rgba(18, 37, 31, .24);
      font-size: 14px; line-height: 1.5;
    }
    .panel.open { display: block; }
    .header {
      min-height: 58px; display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 16px;
      border-bottom: 1px solid #dce2df; background: #fff;
    }
    .title-wrap { min-width: 0; flex: 1; }
    .title { margin: 0; font-size: 15px; line-height: 1.3; font-weight: 700; letter-spacing: 0; }
    .status { margin-top: 2px; color: #66736e; font-size: 11px; }
    .close {
      width: 34px; height: 34px; border: 0; border-radius: 4px; background: transparent;
      color: #42504b; font-size: 22px; line-height: 1; cursor: pointer;
    }
    .close:hover { background: #edf1ef; }
    .settings { padding: 4px 0; background: #f7f9f8; }
    .setting {
      display: flex; align-items: flex-start; gap: 10px; padding: 10px 16px;
      cursor: pointer; user-select: none;
    }
    .setting:hover { background: #eef3f0; }
    .setting input { width: 15px; height: 15px; margin: 3px 0 0; accent-color: #176b52; cursor: pointer; }
    .setting-text { min-width: 0; flex: 1; }
    .setting-title { display: block; font-size: 13px; font-weight: 600; }
    .setting-hint { display: block; margin-top: 2px; color: #697570; font-size: 11px; }
    .footer {
      padding: 8px 16px 12px; border-top: 1px solid #dce2df;
      background: #fff; color: #697570; font-size: 11px;
    }
    @media (max-width: 520px) {
      .launcher { right: 12px; bottom: 12px; }
      .panel { right: 12px; bottom: 64px; }
    }
  `;

  const launcher = createElement("button", "launcher", "设置");
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");

  const panel = createElement("section", "panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "页面助手设置");
  panel.innerHTML = `
    <header class="header">
      <div class="title-wrap">
        <h2 class="title">页面助手设置</h2>
        <div class="status">本地服务 127.0.0.1:8090</div>
      </div>
      <button class="close" type="button" aria-label="关闭">&times;</button>
    </header>
    <div class="settings">
      <label class="setting">
        <input type="checkbox" name="cursorEnabled">
        <span class="setting-text">
          <span class="setting-title">虚拟光标</span>
          <span class="setting-hint">显示虚拟光标，并跟随真实鼠标指针（右下 10/12 像素缓动拖尾）；取消勾选则隐藏且不再跟随，/click、/type 仍正常执行</span>
        </span>
      </label>
      <label class="setting">
        <input type="checkbox" name="allowJsExecution">
        <span class="setting-text">
          <span class="setting-title">允许执行 JS</span>
          <span class="setting-hint">允许本地服务通过 /execute 在当前页主世界执行 JavaScript</span>
        </span>
      </label>
    </div>
    <div class="footer">设置对所有页面生效，保存在扩展本地存储中。</div>
  `;

  shadow.append(style, launcher, panel);
  document.documentElement.appendChild(host);

  const closeButton = panel.querySelector(".close");
  const cursorToggle = panel.querySelector('input[name="cursorEnabled"]');
  const jsExecutionToggle = panel.querySelector('input[name="allowJsExecution"]');

  function createElement(tag, className, text = "") {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function setOpen(open) {
    panel.classList.toggle("open", open);
    launcher.setAttribute("aria-expanded", String(open));
    launcher.textContent = open ? "隐藏设置" : "设置";
  }

  function normalizeText(value, maxLength = MAX_TEXT_LENGTH) {
    return (value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function getMeta(name) {
    return normalizeText(document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content, 1000);
  }

  function collectInteractiveElements() {
    const selector = "a[href], button, input:not([type='password']), select, textarea";
    return Array.from(document.querySelectorAll(selector)).slice(0, MAX_ELEMENTS).map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: normalizeText(element.getAttribute("type"), 40),
      text: normalizeText(element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder"), 200),
      href: element.tagName === "A" ? element.href.slice(0, 1000) : ""
    })).filter((item) => item.text || item.href);
  }

  function collectPageContext() {
    const selection = window.getSelection()?.toString() || "";
    const doctype = document.doctype ? `${new XMLSerializer().serializeToString(document.doctype)}\n` : "";
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .slice(0, 60)
      .map((heading) => ({ level: heading.tagName.toLowerCase(), text: normalizeText(heading.innerText, 500) }))
      .filter((heading) => heading.text);

    return {
      url: location.href,
      title: document.title,
      language: document.documentElement.lang || navigator.language,
      description: getMeta("description") || getMeta("og:description"),
      selectedText: normalizeText(selection, 10000),
      headings,
      interactiveElements: collectInteractiveElements(),
      visibleText: normalizeText(document.body?.innerText),
      html: `${doctype}${document.documentElement.outerHTML}`
    };
  }

  launcher.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  closeButton.addEventListener("click", () => setOpen(false));

  // --- 虚拟光标 ---------------------------------------------------------
  const CURSOR_MOVE_DURATION_MS = 420;

  const cursorHost = document.createElement("div");
  cursorHost.id = "page-context-chat-cursor";
  cursorHost.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;";
  const cursorShadow = cursorHost.attachShadow({ mode: "closed" });
  cursorShadow.innerHTML = `
    <style>
      .cursor {
        position: fixed; left: 0; top: 0; width: 0; height: 0;
        transform: translate(-100px, -100px);
        will-change: transform;
        filter: drop-shadow(0 2px 3px rgba(0, 0, 0, .35));
      }
      .arrow { display: block; }
      .pulse {
        position: absolute; left: 0; top: 0; width: 14px; height: 14px;
        margin: -7px 0 0 -7px; border-radius: 50%;
        background: rgba(23, 107, 82, .35); border: 2px solid #176b52;
        opacity: 0; transform: scale(.4); pointer-events: none;
      }
      .pulse.on { animation: page-context-cursor-pulse .55s ease-out; }
      @keyframes page-context-cursor-pulse {
        0% { opacity: .8; transform: scale(.4); }
        100% { opacity: 0; transform: scale(2.6); }
      }
    </style>
    <div class="cursor">
      <div class="pulse"></div>
      <svg class="arrow" width="22" height="30" viewBox="0 0 22 30" aria-hidden="true">
        <path d="M3 2 L3 24 L9 18 L12.5 26 L16 24.5 L12.5 16.5 L20 16.5 Z"
              fill="#ffffff" stroke="#111111" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
    </div>
  `;
  document.documentElement.appendChild(cursorHost);

  const cursorEl = cursorShadow.querySelector(".cursor");
  const pulseEl = cursorShadow.querySelector(".pulse");
  let cursorX = Math.round(window.innerWidth / 2);
  let cursorY = Math.round(window.innerHeight / 2);
  let cursorAnimation = null;
  // 「显示虚拟光标」开关：关闭时只是不绘制（宿主 display:none），位置仍照常维护，
  // 所以 /click、/type 的动作和 data-x / data-y 核对都不受影响。
  let cursorVisible = true;

  function applyCursorVisibility() {
    cursorHost.style.display = cursorVisible ? "" : "none";
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function placeCursor(x, y) {
    cursorX = x;
    cursorY = y;
    cursorEl.style.transform = `translate(${x}px, ${y}px)`;
    // 把当前位置同步到宿主元素的 data-x / data-y，便于 /execute 或自动化脚本核对
    // 虚拟光标到底走到哪儿了（对比 style.transform 需要访问 closed shadow DOM）。
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if (cursorHost.dataset.x !== String(roundedX)) {
      cursorHost.dataset.x = String(roundedX);
    }
    if (cursorHost.dataset.y !== String(roundedY)) {
      cursorHost.dataset.y = String(roundedY);
    }
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function animateCursorTo(x, y, duration = CURSOR_MOVE_DURATION_MS) {
    if (cursorAnimation) {
      cancelAnimationFrame(cursorAnimation);
      cursorAnimation = null;
    }
    if (duration <= 0 || (x === cursorX && y === cursorY)) {
      placeCursor(x, y);
      return Promise.resolve();
    }
    const startX = cursorX;
    const startY = cursorY;
    const startTime = performance.now();
    return new Promise((resolve) => {
      function step(now) {
        const progress = Math.min(1, (now - startTime) / duration);
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        placeCursor(startX + (x - startX) * eased, startY + (y - startY) * eased);
        if (progress < 1) {
          cursorAnimation = requestAnimationFrame(step);
        } else {
          cursorAnimation = null;
          resolve();
        }
      }
      cursorAnimation = requestAnimationFrame(step);
    });
  }

  // --- 跟随真实光标 -------------------------------------------------------
  // 开启后虚拟光标以固定偏移、每帧向真实指针缓动的形式跟随（“平滑拖尾”）。
  // 自动化动作（/click、/type）播放移动动画期间跟随自动让位，动画结束后由下一次
  // 鼠标移动把光标重新领回指针旁边。
  const FOLLOW_OFFSET_X = 10;
  const FOLLOW_OFFSET_Y = 12;
  const FOLLOW_EASING = 0.3;
  // 设置项在 chrome.storage.local 里的键名（对所有页面共享）。
  // 「虚拟光标」是一个勾选项同时管显示和跟随，所以只有一个键。
  const CURSOR_ENABLED_STORAGE_KEY = "cursorEnabled";
  const JS_EXECUTION_STORAGE_KEY = "allowJsExecution";
  // 自动化动作（/click、/type）期间及结束后一小段时间内忽略跟随，
  // 否则滚动引发的合成 mousemove、CDP 派发的 mouseMoved 会把光标从目标拽回指针。
  const FOLLOW_RELEASE_DELAY_MS = 400;
  const FOLLOW_HOLD_MAX_MS = 120000; // 兜底：动作回包丢失时最多按住 2 分钟

  let followEnabled = false;
  let followFrame = null;
  let followTarget = null;
  let pointerX = null;
  let pointerY = null;
  let pointerScreenX = null;
  let pointerScreenY = null;
  let followHeldUntil = 0;

  function isFollowHeld() {
    return performance.now() < followHeldUntil;
  }

  function beginFollowHold() {
    followHeldUntil = performance.now() + FOLLOW_HOLD_MAX_MS;
  }

  function endFollowHold() {
    followHeldUntil = performance.now() + FOLLOW_RELEASE_DELAY_MS;
  }

  function scheduleFollowFrame() {
    if (followFrame === null) {
      followFrame = requestAnimationFrame(followStep);
    }
  }

  function followStep() {
    followFrame = null;
    if (!followEnabled || cursorAnimation || isFollowHeld() || !followTarget) {
      return;
    }
    if (!isExtensionAlive()) {
      // 孤儿脚本：停掉跟随，避免在已经撤下的节点上继续绘制。
      followEnabled = false;
      return;
    }
    const dx = followTarget.x - cursorX;
    const dy = followTarget.y - cursorY;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      placeCursor(followTarget.x, followTarget.y);
      return;
    }
    placeCursor(
      clamp(cursorX + dx * FOLLOW_EASING, 0, Math.max(window.innerWidth - 1, 0)),
      clamp(cursorY + dy * FOLLOW_EASING, 0, Math.max(window.innerHeight - 1, 0))
    );
    scheduleFollowFrame();
  }

  function updateFollowTarget() {
    if (!followEnabled || isFollowHeld() || pointerX === null || pointerY === null) {
      return;
    }
    followTarget = {
      x: pointerX + FOLLOW_OFFSET_X,
      y: pointerY + FOLLOW_OFFSET_Y
    };
    scheduleFollowFrame();
  }

  function setFollowEnabled(enabled) {
    followEnabled = Boolean(enabled);
    if (followEnabled) {
      updateFollowTarget();
      return;
    }
    followTarget = null;
    followHeldUntil = 0;
    if (followFrame !== null) {
      cancelAnimationFrame(followFrame);
      followFrame = null;
    }
  }

  // 只有在“屏幕坐标”变化时才认为用户在移动鼠标。
  // Chrome 会在视口/布局变化时为静止的指针重算 clientX/clientY 并补发 mousemove：
  // 实测调试器横幅出现/收起时 clientY 会从 284 补间到 340（差 56，正好是横幅高度），
  // 而 screenX/screenY 全程不变。这种事件不能把光标从刚操作完的目标上拽走。
  document.addEventListener("mousemove", (event) => {
    if (isFollowHeld()) {
      // 动作期间连坐标都不记：否则 /click 经 CDP 派发的 mouseMoved 会把“指针位置”
      // 改成目标点，等按住解除后，一次静止指针的布局重算就会被误判成用户移动。
      return;
    }
    const movedByPointer = event.screenX !== pointerScreenX || event.screenY !== pointerScreenY;
    pointerScreenX = event.screenX;
    pointerScreenY = event.screenY;
    pointerX = event.clientX;
    pointerY = event.clientY;
    if (!movedByPointer) {
      return;
    }
    updateFollowTarget();
  }, { capture: true, passive: true });

  // --- 设置面板 -----------------------------------------------------------
  // 两个勾选项对所有页面共享，存在 chrome.storage.local：
  //   cursorEnabled    虚拟光标：显示 + 跟随鼠标（content 脚本自己消费）
  //   allowJsExecution 允许执行 JS（由后台脚本在 /execute 前读取并拦截）
  const storage = chrome.storage?.local ?? null;

  function saveSetting(key, value) {
    storage?.set({ [key]: value }).catch(() => {});
  }

  // 显示和跟随来自同一个勾选项，避免「勾了跟随却没显示」这类半开状态。
  function setCursorEnabled(enabled) {
    cursorVisible = enabled;
    applyCursorVisibility();
    setFollowEnabled(enabled);
  }

  cursorToggle.addEventListener("change", () => {
    setCursorEnabled(cursorToggle.checked);
    saveSetting(CURSOR_ENABLED_STORAGE_KEY, cursorToggle.checked);
  });

  jsExecutionToggle.addEventListener("change", () => {
    saveSetting(JS_EXECUTION_STORAGE_KEY, jsExecutionToggle.checked);
  });

  // 默认值：虚拟光标默认开启（显示 + 跟随），允许执行 JS 默认开启。
  // 迁移：1.7.0 之前「显示」和「跟随」是两个键，只有 cursorEnabled 缺失时才回退到旧的
  // cursorVisible（旧的「跟随」默认关闭，拿它当初始值会把光标默认变成不可见）。
  const LEGACY_CURSOR_VISIBLE_KEY = "cursorVisible";

  function resolveCursorEnabled(stored) {
    if (stored?.[CURSOR_ENABLED_STORAGE_KEY] !== undefined) {
      return stored[CURSOR_ENABLED_STORAGE_KEY] !== false;
    }
    if (stored?.[LEGACY_CURSOR_VISIBLE_KEY] !== undefined) {
      return stored[LEGACY_CURSOR_VISIBLE_KEY] !== false;
    }
    return true;
  }

  function applyStoredSettings(stored) {
    cursorToggle.checked = resolveCursorEnabled(stored);
    setCursorEnabled(cursorToggle.checked);
    jsExecutionToggle.checked = stored?.[JS_EXECUTION_STORAGE_KEY] !== false;
  }

  const SETTING_KEYS = [CURSOR_ENABLED_STORAGE_KEY, JS_EXECUTION_STORAGE_KEY, LEGACY_CURSOR_VISIBLE_KEY];

  if (storage) {
    storage.get(SETTING_KEYS)
      .then(applyStoredSettings)
      .catch(() => applyStoredSettings(null));
    // 设置是全局的，但每个页面各自持有一份运行时状态：在别的标签页改了勾选，
    // 已打开的页面必须跟着刷新，否则「设置对所有页面生效」只在刷新后才成立。
    if (storage.onChanged?.addListener) {
      storage.onChanged.addListener((changes) => {
        if (![CURSOR_ENABLED_STORAGE_KEY, JS_EXECUTION_STORAGE_KEY].some((key) => key in changes)) {
          return;
        }
        storage.get(SETTING_KEYS)
          .then(applyStoredSettings)
          .catch(() => {});
      });
    }
  } else {
    applyStoredSettings(null);
  }

  const CLICKABLE_SELECTOR = [
    "a[href]", "button", "summary", "label",
    "input[type='submit']", "input[type='button']", "input[type='reset']",
    "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']", "[role='option']"
  ].join(", ");

  function elementLabel(element) {
    const raw = element.innerText
      || element.textContent
      || element.value
      || element.getAttribute("aria-label")
      || element.getAttribute("title")
      || "";
    return normalizeText(raw, 200).toLowerCase();
  }

  function isVisibleElement(element) {
    if (element.closest("[hidden], [aria-hidden='true']")) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) {
      return false;
    }
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  }

  function resolveTargetElement(selector) {
    const query = selector.trim();
    const mode = query.startsWith("text*=") ? "contains" : query.startsWith("text=") ? "equals" : null;
    if (mode) {
      const wanted = query.slice(mode === "contains" ? 6 : 5).trim().toLowerCase();
      if (!wanted) {
        throw new Error("text= 之后需要提供要匹配的文字");
      }
      const candidates = Array.from(document.querySelectorAll(CLICKABLE_SELECTOR)).filter(isVisibleElement);
      const match = candidates.find((element) => {
        const label = elementLabel(element);
        return mode === "contains" ? label.includes(wanted) : label === wanted;
      });
      if (!match) {
        throw new Error(`未找到文字为「${query.slice(mode === "contains" ? 6 : 5).trim()}」的可点击元素`);
      }
      return match;
    }

    let element;
    try {
      element = document.querySelector(query);
    } catch (error) {
      throw new Error(`无效的 CSS 选择器：${error.message}`);
    }
    if (!element) {
      throw new Error(`未找到匹配的元素：${query}`);
    }
    return element;
  }

  async function scrollAndPointTo(element) {
    // 自动化动作开始：跟随让位，直到后台回传 CLICK_FEEDBACK / TYPE_FEEDBACK 才解除。
    beginFollowHold();
    const previousScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = "auto";
    element.scrollIntoView({ block: "center", inline: "center" });
    document.documentElement.style.scrollBehavior = previousScrollBehavior;
    await nextFrame();
    await nextFrame();
    await delay(50);

    const rect = element.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight
      || rect.right < 0 || rect.left > window.innerWidth) {
      throw new Error("目标元素不在可视区域内");
    }

    const x = clamp(rect.left + rect.width / 2, 0, Math.max(window.innerWidth - 1, 0));
    const y = clamp(rect.top + rect.height / 2, 0, Math.max(window.innerHeight - 1, 0));

    await animateCursorTo(x, y);
    return { x, y };
  }

  async function moveVirtualCursorToSelector(selector) {
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error("选择器不能为空");
    }
    const element = resolveTargetElement(selector);
    const { x, y } = await scrollAndPointTo(element);
    return {
      x,
      y,
      tag: element.tagName.toLowerCase(),
      text: normalizeText(element.innerText || element.getAttribute("aria-label") || "", 120)
    };
  }

  const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

  function isEditableElement(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return !element.disabled && !element.readOnly;
    }
    if (element.isContentEditable) {
      return true;
    }
    return EDITABLE_ROLES.has(element.getAttribute("role") || "");
  }

  function clearEditableElement(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // 用原型上的原生 setter 赋值，绕过 React/Vue 对 value 属性的劫持，
      // 再补一个 input 事件，让受控组件同步到"已清空"。
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) {
        setter.call(element, "");
      } else {
        element.value = "";
      }
    } else if (element.isContentEditable) {
      element.textContent = "";
    } else {
      return false;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  async function focusElementForTyping(selector, clear) {
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error("选择器不能为空");
    }
    const element = resolveTargetElement(selector);
    const { x, y } = await scrollAndPointTo(element);

    if (typeof element.focus === "function") {
      element.focus({ preventScroll: true });
    }
    const editable = isEditableElement(element);
    if (!editable) {
      throw new Error("目标元素不是可输入的元素（input/textarea/contenteditable）");
    }

    return {
      x,
      y,
      tag: element.tagName.toLowerCase(),
      text: normalizeText(
        element.value || element.innerText || element.getAttribute("aria-label") || "",
        120
      ),
      editable,
      cleared: Boolean(clear) && clearEditableElement(element)
    };
  }

  function pulseCursor(ok) {
    pulseEl.style.background = ok ? "rgba(23, 107, 82, .35)" : "rgba(139, 41, 37, .30)";
    pulseEl.style.borderColor = ok ? "#176b52" : "#8b2925";
    pulseEl.classList.remove("on");
    void pulseEl.offsetWidth;
    pulseEl.classList.add("on");
  }

  placeCursor(cursorX, cursorY);
  window.addEventListener("resize", () => {
    // 视口尺寸变化（包括 Chrome 调试器横幅出现/收起）只做边界收敛。
    // 这里绝不能重设跟随目标：横幅收起发生在动作结束数秒之后，会把光标
    // 从刚操作完的目标上凭空拽回指针旁边。
    placeCursor(
      clamp(cursorX, 0, Math.max(window.innerWidth - 1, 0)),
      clamp(cursorY, 0, Math.max(window.innerHeight - 1, 0))
    );
    if (followTarget) {
      followTarget = {
        x: clamp(followTarget.x, 0, Math.max(window.innerWidth - 1, 0)),
        y: clamp(followTarget.y, 0, Math.max(window.innerHeight - 1, 0))
      };
    }
  });

  // --- DOM 自愈：SPA（如 GitHub Turbo）替换 DOM 后重新挂载注入节点 --------
  function isExtensionAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function ensureOverlaysAttached() {
    const parent = document.documentElement || document.body;
    if (!parent) {
      return;
    }
    if (!cursorHost.isConnected) {
      parent.appendChild(cursorHost);
    }
    if (!host.isConnected) {
      parent.appendChild(host);
    }
  }

  let reattachQueued = false;
  function queueReattach() {
    if (reattachQueued) {
      return;
    }
    reattachQueued = true;
    setTimeout(() => {
      reattachQueued = false;
      ensureOverlaysAttached();
    }, 0);
  }

  const overlayObserver = new MutationObserver(() => {
    if (!isExtensionAlive()) {
      // 本脚本已成孤儿（扩展被重载）：停止自愈并把自己的节点清掉，
      // 让位给后台重新注入的新脚本，避免把失效的 UI 又挂回去。
      overlayObserver.disconnect();
      cursorHost.remove();
      host.remove();
      return;
    }
    if (cursorHost.isConnected && host.isConnected) {
      return;
    }
    queueReattach();
  });
  overlayObserver.observe(document, { childList: true, subtree: true });
  document.addEventListener("turbo:load", ensureOverlaysAttached, true);
  document.addEventListener("turbo:render", ensureOverlaysAttached, true);
  document.addEventListener("pjax:end", ensureOverlaysAttached, true);
  window.addEventListener("pageshow", ensureOverlaysAttached);

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type === "PING_PAGE_CONTEXT_CHAT") {
      sendResponse({ ok: true });
      return false;
    }
    if (request?.type === "TOGGLE_PAGE_CONTEXT_SETTINGS") {
      setOpen(!panel.classList.contains("open"));
      return false;
    }
    if (request?.type === "CAPTURE_PAGE_CONTEXT") {
      try {
        sendResponse({ ok: true, context: collectPageContext() });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
      return false;
    }
    if (request?.type === "MOVE_VIRTUAL_CURSOR") {
      moveVirtualCursorToSelector(request.selector)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (request?.type === "FOCUS_FOR_TYPING") {
      focusElementForTyping(request.selector, Boolean(request.clear))
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (request?.type === "CLICK_FEEDBACK" || request?.type === "TYPE_FEEDBACK") {
      pulseCursor(Boolean(request.ok));
      endFollowHold();
      return false;
    }
    return false;
  });
})();
