# Page Context Chat

一个 Manifest V3 Chrome Extension。它向普通 HTTP/HTTPS 页面注入聊天组件，在用户发送消息时读取当前页面上下文，并通过扩展 Service Worker 请求本机 `127.0.0.1:8090` 服务。

## 目录

```text
chrome-dom-chat/
|-- extension/
|   |-- manifest.json
|   |-- background.js
|   `-- content.js
`-- server/
    `-- server.py
```

## 启动

1. 启动本地占位服务：

   ```powershell
   python .\server\server.py
   ```

2. Chrome 打开 `chrome://extensions/`，启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择 `chrome-dom-chat\extension`。
4. 打开或刷新任意 HTTP/HTTPS 页面，点击右下角“页面助手”。

也可以点击 Chrome 工具栏中的扩展按钮显示或隐藏聊天窗口。Chrome 内部页面（例如 `chrome://settings`）不允许扩展注入内容脚本。

## API 契约

扩展调用：

```http
POST http://127.0.0.1:8090/chat
Content-Type: application/json
```

请求主体包含：

```json
{
  "message": "总结当前页面",
  "history": [],
  "context": {
    "url": "https://example.com/",
    "title": "Example",
    "language": "zh-CN",
    "description": "...",
    "selectedText": "...",
    "headings": [],
    "interactiveElements": [],
    "visibleText": "...",
    "html": "<!DOCTYPE html><html>...</html>"
  },
  "client": {
    "name": "page-context-chat",
    "version": "1.0.0"
  }
}
```

服务响应：

```json
{
  "reply": "回答内容"
}
```

`server.py` 当前只返回占位响应。实际接入模型时，替换 `build_placeholder_reply()` 即可，接口格式无需改动。服务默认仅监听回环地址，不接受其他机器访问。

## 上下文与隐私

- 仅在用户点击发送时采集上下文。
- 完整发送当前动态 DOM 的 `document.documentElement.outerHTML`，不做截断。
- 同时采集标题、描述、三级以内标题、链接/按钮等交互元素；可见正文最多 30,000 个字符，选中文本最多 10,000 个字符。
- 完整 HTML 可能包含隐藏内容、表单默认值、令牌或其他敏感信息；发送前应确认本地服务的处理和存储方式。
- 本地示例服务接受的请求体上限为 50 MB，超大页面会返回 HTTP 400。
