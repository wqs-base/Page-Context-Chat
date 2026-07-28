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
    sendSocketMessage({ type: "hello", client: "page-context-chat", version: "1.1.0" });
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
        : `无法连接本地服务：${error.message}`;
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

connectSocket();
