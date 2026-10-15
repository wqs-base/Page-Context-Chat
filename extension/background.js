const CHAT_ENDPOINT = "http://127.0.0.1:8090/chat";
const SOCKET_ENDPOINT = "ws://127.0.0.1:8090/ws";
const REQUEST_TIMEOUT_MS = 30000;
const KEEPALIVE_INTERVAL_MS = 20000;
const MAX_RECONNECT_DELAY_MS = 10000;

let socket = null;
let reconnectTimer = null;
let keepaliveTimer = null;
let reconnectDelay = 1000;

function sendSocketMessage(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
}

function connectSocket() {
  if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) {
    return;
  }

  socket = new WebSocket(SOCKET_ENDPOINT);
  socket.addEventListener("open", () => {
    reconnectDelay = 1000;
    sendSocketMessage({ type: "hello", client: "page-context-chat", version: "1.6.4" });
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => sendSocketMessage({ type: "ping" }), KEEPALIVE_INTERVAL_MS);
  });
  socket.addEventListener("message", async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === "capture_page" && typeof message.requestId === "string") {
      await captureActivePage(message.requestId);
    } else if (message?.type === "execute_script" && typeof message.requestId === "string") {
      await executeInActivePage(message.requestId, message.code);
    } else if (message?.type === "click_element" && typeof message.requestId === "string") {
      await clickInActivePage(message.requestId, message.selector);
    } else if (message?.type === "type_text" && typeof message.requestId === "string") {
      await typeInActivePage(message.requestId, message);
    }
  });
  socket.addEventListener("close", () => {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
    socket = null;
    scheduleReconnect();
  });
  socket.addEventListener("error", () => socket?.close());
}

async function captureActivePage(requestId) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      throw new Error("当前没有活动标签页");
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_PAGE_CONTEXT" });
    if (!response?.ok || !response.context) {
      throw new Error(response?.error || "活动页面未返回上下文");
    }
    sendSocketMessage({ type: "capture_result", requestId, ok: true, context: response.context });
  } catch (error) {
    sendSocketMessage({
      type: "capture_result",
      requestId,
      ok: false,
      error: {
        code: "page_unavailable",
        message: `无法采集当前活动页：${error.message}`
      }
    });
  }
}

async function executeInActivePage(requestId, code) {
  let debuggee = null;
  try {
    if (typeof code !== "string" || !code.trim()) {
      throw new Error("服务端未提供有效的 JavaScript 代码");
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) {
      throw new Error("当前活动页不是可执行的 HTTP/HTTPS 页面");
    }

    debuggee = { tabId: tab.id };
    await chrome.debugger.attach(debuggee, "1.3");
    const response = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      timeout: 10000
    });
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "JavaScript 执行失败");
    }

    const remote = response.result || {};
    sendSocketMessage({
      type: "execute_result",
      requestId,
      ok: true,
      result: {
        type: remote.type || "undefined",
        subtype: remote.subtype || null,
        value: Object.hasOwn(remote, "value") ? remote.value : null,
        unserializableValue: remote.unserializableValue || null,
        description: remote.description || null
      }
    });
  } catch (error) {
    sendSocketMessage({
      type: "execute_result",
      requestId,
      ok: false,
      error: {
        code: "execution_failed",
        message: `无法在当前活动页执行 JavaScript：${error.message}`
      }
    });
  } finally {
    if (debuggee) {
      await chrome.debugger.detach(debuggee).catch(() => {});
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickInActivePage(requestId, selector) {
  let debuggee = null;
  let tabId = null;
  try {
    if (typeof selector !== "string" || !selector.trim()) {
      throw new Error("服务端未提供有效的选择器");
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) {
      throw new Error("当前活动页不是可交互的 HTTP/HTTPS 页面");
    }
    tabId = tab.id;

    const target = await chrome.tabs.sendMessage(tabId, {
      type: "MOVE_VIRTUAL_CURSOR",
      selector: selector.trim()
    });
    if (!target?.ok) {
      throw new Error(target?.error || "无法定位目标元素");
    }

    debuggee = { tabId };
    await chrome.debugger.attach(debuggee, "1.3");
    const point = { x: target.x, y: target.y };
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      ...point, type: "mouseMoved", button: "none", buttons: 0, clickCount: 0
    });
    await delay(60);
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      ...point, type: "mousePressed", button: "left", buttons: 1, clickCount: 1
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      ...point, type: "mouseReleased", button: "left", buttons: 0, clickCount: 1
    });

    chrome.tabs.sendMessage(tabId, { type: "CLICK_FEEDBACK", ok: true }).catch(() => {});
    sendSocketMessage({
      type: "click_result",
      requestId,
      ok: true,
      result: {
        selector: selector.trim(),
        x: target.x,
        y: target.y,
        tag: target.tag || "",
        text: target.text || ""
      }
    });
  } catch (error) {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: "CLICK_FEEDBACK", ok: false }).catch(() => {});
    }
    sendSocketMessage({
      type: "click_result",
      requestId,
      ok: false,
      error: {
        code: "click_failed",
        message: `无法在活动页面点击目标元素：${error.message}`
      }
    });
  } finally {
    if (debuggee) {
      await chrome.debugger.detach(debuggee).catch(() => {});
    }
  }
}

// --- 模拟输入（POST /type）--------------------------------------------------
// 通过 CDP 派发真实的按键事件，而不是直接改写 input.value，这样页面的事件处理、
// 受控组件（React/Vue）和快捷键逻辑都能被正常触发。
function describeTypingKey(char) {
  if (char === "\n" || char === "\r") {
    return { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
  }
  if (char === "\t") {
    return { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
  }
  if (char === " ") {
    return { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " };
  }
  if (/^[a-z]$/i.test(char)) {
    const upper = char.toUpperCase();
    return { key: char, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), text: char };
  }
  if (/^[0-9]$/.test(char)) {
    return { key: char, code: `Digit${char}`, windowsVirtualKeyCode: char.charCodeAt(0), text: char };
  }
  return null;
}

async function pressKey(debuggee, definition) {
  const base = {
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.windowsVirtualKeyCode,
    nativeVirtualKeyCode: definition.windowsVirtualKeyCode
  };
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    text: definition.text || "",
    unmodifiedText: definition.text || ""
  });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function typeTextIntoPage(debuggee, text, delayMs) {
  for (const char of Array.from(text)) {
    const definition = describeTypingKey(char);
    if (definition) {
      await pressKey(debuggee, definition);
    } else {
      // 没有对应按键定义的字符（中文、表情、生僻符号等）直接交给 CDP 插入文本。
      await chrome.debugger.sendCommand(debuggee, "Input.insertText", { text: char });
    }
    if (delayMs > 0) {
      await delay(delayMs);
    }
  }
}

async function typeInActivePage(requestId, message) {
  let debuggee = null;
  let tabId = null;
  let target = null;
  const text = typeof message.text === "string" ? message.text : "";
  const selector = typeof message.selector === "string" ? message.selector.trim() : "";
  const delayMs = Number.isFinite(message.delayMs) ? Math.max(0, Math.trunc(message.delayMs)) : 0;
  const clear = Boolean(message.clear);
  const submit = Boolean(message.submit);

  try {
    if (!text && !clear) {
      throw new Error("服务端未提供要输入的文本");
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !/^https?:\/\//.test(tab.url || "")) {
      throw new Error("当前活动页不是可交互的 HTTP/HTTPS 页面");
    }
    tabId = tab.id;

    if (selector) {
      target = await chrome.tabs.sendMessage(tabId, { type: "FOCUS_FOR_TYPING", selector, clear });
      if (!target?.ok) {
        throw new Error(target?.error || "无法定位输入目标");
      }
    }

    debuggee = { tabId };
    await chrome.debugger.attach(debuggee, "1.3");

    if (text) {
      await typeTextIntoPage(debuggee, text, delayMs);
    }
    if (submit) {
      await delay(30);
      await pressKey(debuggee, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    }

    chrome.tabs.sendMessage(tabId, { type: "TYPE_FEEDBACK", ok: true }).catch(() => {});
    sendSocketMessage({
      type: "type_result",
      requestId,
      ok: true,
      result: {
        selector,
        text,
        length: Array.from(text).length,
        delayMs,
        cleared: Boolean(target?.cleared),
        submitted: submit,
        tag: target?.tag || "",
        editable: target ? Boolean(target.editable) : null
      }
    });
  } catch (error) {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: "TYPE_FEEDBACK", ok: false }).catch(() => {});
    }
    sendSocketMessage({
      type: "type_result",
      requestId,
      ok: false,
      error: {
        code: "type_failed",
        message: `无法在活动页面输入文本：${error.message}`
      }
    });
  } finally {
    if (debuggee) {
      await chrome.debugger.detach(debuggee).catch(() => {});
    }
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.type !== "PAGE_CONTEXT_CHAT") {
    return false;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  fetch(CHAT_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request.payload),
    signal: controller.signal
  })
    .then(async (response) => {
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error?.message || data?.error || `本地服务返回 HTTP ${response.status}`);
      }
      if (typeof data?.reply !== "string") {
        throw new Error("本地服务响应缺少 reply 字段");
      }
      sendResponse({ ok: true, reply: data.reply });
    })
    .catch((error) => {
      const message = error.name === "AbortError"
        ? "本地服务响应超时"
        : `无法连接本地服务：${error.message}（本地服务可能未启动，请先启动 page-context-chat-server.exe 后重试）`;
      sendResponse({ ok: false, error: message });
    })
    .finally(() => clearTimeout(timeoutId));

  return true;
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PAGE_CONTEXT_CHAT" }).catch(() => {});
  }
});

// --- 内容脚本自愈 ---------------------------------------------------------
// 重新加载/更新扩展会让已打开页面里的旧内容脚本失去 chrome.runtime 通道（孤儿脚本），
// 此时它不再响应消息，但 UI 节点还留在页面上。这里主动探测并重新注入，省去用户手动刷新页面。
const CONTENT_SCRIPT_FILE = "content.js";

async function healContentScripts() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  } catch {
    return;
  }

  await Promise.all(tabs.map(async (tab) => {
    if (typeof tab.id !== "number" || tab.status !== "complete") {
      // 仍在加载的页面交给声明式注入处理，避免提前注入造成重复。
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "PING_PAGE_CONTEXT_CHAT" });
      return;
    } catch {
      // 没有接收端：页面在扩展加载/重载前就已打开，或旧脚本已成孤儿。重新注入。
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT_FILE] });
    } catch {
      // chrome://、应用商店、已丢弃的标签页等不允许注入，忽略。
    }
  }));
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install" || details.reason === "update") {
    healContentScripts();
  }
});
chrome.runtime.onStartup.addListener(healContentScripts);
healContentScripts();

connectSocket();
