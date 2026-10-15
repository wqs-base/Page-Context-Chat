(() => {
  // 扩展被重新加载/更新后，已打开页面里的旧内容脚本会失去 chrome.runtime 通道（孤儿脚本）。
  // 后台会检测到并重新注入本脚本；此时旧 UI 节点还在，必须先清掉再重建，
  // 否则新脚本会被下面的判断挡住直接退出，消息监听根本不会注册。
  document.getElementById("page-context-chat-root")?.remove();
  document.getElementById("page-context-chat-cursor")?.remove();

  const MAX_TEXT_LENGTH = 30000;
  const MAX_ELEMENTS = 80;
  const history = [];
  let isSending = false;

  const host = document.createElement("div");
  host.id = "page-context-chat-root";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .launcher, .panel, button, textarea { font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .launcher {
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
      height: 44px; padding: 0 16px; border: 1px solid #1c5f4a; border-radius: 6px;
      background: #176b52; color: #fff; font-size: 14px; font-weight: 650; letter-spacing: 0;
      box-shadow: 0 8px 24px rgba(14, 38, 31, .2); cursor: pointer;
    }
    .launcher:hover { background: #125640; }
    .launcher:focus-visible, button:focus-visible, textarea:focus-visible {
      outline: 2px solid #e1a03d; outline-offset: 2px;
    }
    .panel {
      position: fixed; right: 20px; bottom: 76px; z-index: 2147483647;
      width: min(380px, calc(100vw - 24px)); height: min(560px, calc(100vh - 96px));
      display: none; grid-template-rows: auto minmax(0, 1fr) auto;
      overflow: hidden; border: 1px solid #c8cfcc; border-radius: 8px;
      background: #f7f9f8; color: #15211d; box-shadow: 0 18px 50px rgba(18, 37, 31, .24);
      font-size: 14px; line-height: 1.5;
    }
    .panel.open { display: grid; }
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
    .messages { overflow-y: auto; padding: 16px; scrollbar-width: thin; }
    .empty { margin: 30px auto; max-width: 260px; color: #65716d; text-align: center; font-size: 13px; }
    .message { display: flex; margin: 0 0 12px; }
    .message.user { justify-content: flex-end; }
    .bubble {
      max-width: 88%; padding: 9px 11px; border-radius: 7px; white-space: pre-wrap;
      overflow-wrap: anywhere; box-shadow: 0 1px 1px rgba(20, 40, 33, .06);
    }
    .user .bubble { background: #176b52; color: #fff; border-bottom-right-radius: 2px; }
    .assistant .bubble { border: 1px solid #d8dfdc; background: #fff; color: #1d2925; border-bottom-left-radius: 2px; }
    .assistant.error .bubble { border-color: #e3a3a0; background: #fff4f3; color: #8b2925; }
    .composer { padding: 10px; border-top: 1px solid #dce2df; background: #fff; }
    textarea {
      display: block; width: 100%; min-height: 70px; max-height: 150px; resize: vertical;
      border: 1px solid #aeb9b5; border-radius: 5px; padding: 9px 10px; background: #fff;
      color: #15211d; font-size: 14px; line-height: 1.45; letter-spacing: 0;
    }
    textarea::placeholder { color: #7b8782; }
    .actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; }
    .context-note { color: #697570; font-size: 11px; }
    .follow {
      display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
      color: #697570; font-size: 11px; cursor: pointer; user-select: none;
    }
    .follow input { width: 13px; height: 13px; margin: 0; accent-color: #176b52; cursor: pointer; }
    .send {
      min-width: 68px; height: 34px; padding: 0 14px; border: 1px solid #1c5f4a; border-radius: 5px;
      background: #176b52; color: #fff; font-size: 13px; font-weight: 650; letter-spacing: 0; cursor: pointer;
    }
    .send:hover { background: #125640; }
    .send:disabled { border-color: #a8b2ae; background: #a8b2ae; cursor: wait; }
    @media (max-width: 520px) {
      .launcher { right: 12px; bottom: 12px; }
      .panel { right: 12px; bottom: 64px; height: min(620px, calc(100vh - 76px)); }
    }
  `;

  const launcher = createElement("button", "launcher", "页面助手");
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");

  const panel = createElement("section", "panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "页面上下文聊天");
  panel.innerHTML = `
    <header class="header">
      <div class="title-wrap">
        <h2 class="title">页面助手</h2>
        <div class="status">本地服务 127.0.0.1:8090</div>
      </div>
      <button class="close" type="button" aria-label="关闭">&times;</button>
    </header>
    <main class="messages" aria-live="polite">
      <p class="empty">输入问题后，将把当前页面的完整 HTML 和页面上下文发送到本地服务。</p>
    </main>
    <form class="composer">
      <textarea name="message" aria-label="消息" placeholder="询问当前页面内容..." required></textarea>
      <div class="actions">
        <span class="context-note">发送完整页面 HTML</span>
        <label class="follow" title="开启后虚拟光标会跟随真实鼠标指针">
          <input type="checkbox"> 跟随鼠标
        </label>
        <button class="send" type="submit">发送</button>
      </div>
    </form>
  `;

  shadow.append(style, launcher, panel);
  document.documentElement.appendChild(host);

  const closeButton = panel.querySelector(".close");
  const messages = panel.querySelector(".messages");
  const form = panel.querySelector(".composer");
  const textarea = panel.querySelector("textarea");
  const sendButton = panel.querySelector(".send");

  function createElement(tag, className, text = "") {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
  }

  function setOpen(open) {
    panel.classList.toggle("open", open);
    launcher.setAttribute("aria-expanded", String(open));
    launcher.textContent = open ? "隐藏助手" : "页面助手";
    if (open) {
      textarea.focus();
    }
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

  function appendMessage(role, text, isError = false) {
    messages.querySelector(".empty")?.remove();
    const row = createElement("div", `message ${role}${isError ? " error" : ""}`);
    row.appendChild(createElement("div", "bubble", text));
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
  }

  async function sendMessage(message) {
    isSending = true;
    sendButton.disabled = true;
    sendButton.textContent = "发送中";
    appendMessage("user", message);

    const payload = {
      message,
      history: history.slice(-10),
      context: collectPageContext(),
      client: { name: "page-context-chat", version: "1.6.1" }
    };

    try {
      const response = await chrome.runtime.sendMessage({ type: "PAGE_CONTEXT_CHAT", payload });
      if (!response?.ok) {
        throw new Error(response?.error || "本地服务请求失败");
      }
      history.push({ role: "user", content: message }, { role: "assistant", content: response.reply });
      appendMessage("assistant", response.reply);
    } catch (error) {
      appendMessage("assistant", error.message, true);
    } finally {
      isSending = false;
      sendButton.disabled = false;
      sendButton.textContent = "发送";
      textarea.focus();
    }
  }

  launcher.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  closeButton.addEventListener("click", () => setOpen(false));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const message = textarea.value.trim();
    if (!message || isSending) {
      return;
    }
    textarea.value = "";
    sendMessage(message);
  });
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
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

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function placeCursor(x, y) {
    cursorX = x;
    cursorY = y;
    cursorEl.style.transform = `translate(${x}px, ${y}px)`;
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
  const FOLLOW_STORAGE_KEY = "cursorFollow";
  // 自动化动作（/click、/type）期间及结束后一小段时间内忽略跟随，
  // 否则滚动引发的合成 mousemove、CDP 派发的 mouseMoved 会把光标从目标拽回指针。
  const FOLLOW_RELEASE_DELAY_MS = 400;
  const FOLLOW_HOLD_MAX_MS = 120000; // 兜底：动作回包丢失时最多按住 2 分钟

  const followToggle = panel.querySelector(".follow input");
  const followStorage = chrome.storage?.local ?? null;
  let followEnabled = false;
  let followFrame = null;
  let followTarget = null;
  let pointerX = null;
  let pointerY = null;
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

  // 无论开关是否打开都记录指针位置，这样打开跟随的瞬间光标就会滑向指针。
  document.addEventListener("mousemove", (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    updateFollowTarget();
  }, { capture: true, passive: true });

  followToggle.addEventListener("change", () => {
    setFollowEnabled(followToggle.checked);
    if (followStorage) {
      followStorage.set({ [FOLLOW_STORAGE_KEY]: followToggle.checked }).catch(() => {});
    }
  });

  if (followStorage) {
    followStorage.get(FOLLOW_STORAGE_KEY)
      .then((stored) => {
        followToggle.checked = Boolean(stored?.[FOLLOW_STORAGE_KEY]);
        setFollowEnabled(followToggle.checked);
      })
      .catch(() => {});
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
    placeCursor(
      clamp(cursorX, 0, Math.max(window.innerWidth - 1, 0)),
      clamp(cursorY, 0, Math.max(window.innerHeight - 1, 0))
    );
    updateFollowTarget();
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
    if (request?.type === "TOGGLE_PAGE_CONTEXT_CHAT") {
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
