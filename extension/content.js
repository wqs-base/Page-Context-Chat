(() => {
  if (document.getElementById("page-context-chat-root")) {
    return;
  }

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
      client: { name: "page-context-chat", version: "1.0.0" }
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
  chrome.runtime.onMessage.addListener((request) => {
    if (request?.type === "TOGGLE_PAGE_CONTEXT_CHAT") {
      setOpen(!panel.classList.contains("open"));
    }
  });
})();
