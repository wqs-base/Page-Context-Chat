const CHAT_ENDPOINT = "http://127.0.0.1:8090/chat";
const REQUEST_TIMEOUT_MS = 30000;

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
        throw new Error(data?.error || `本地服务返回 HTTP ${response.status}`);
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
