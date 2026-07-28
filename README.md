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
    |-- requirements.txt
    `-- server.py
```

## 启动

1. 安装服务端依赖并启动本地服务：

   ```powershell
   python -m pip install -r .\server\requirements.txt
   python .\server\server.py
   ```

   若提示 `No module named pip`，先执行 `python -m ensurepip --upgrade`，再安装依赖。
2. Chrome 打开 `chrome://extensions/`，启用“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择 `chrome-dom-chat\extension`。
4. 打开或刷新任意 HTTP/HTTPS 页面，点击右下角“页面助手”。

也可以点击 Chrome 工具栏中的扩展按钮显示或隐藏聊天窗口。Chrome 内部页面（例如 `chrome://settings`）不允许扩展注入内容脚本。

扩展要求 Chrome 116 或更高版本。后台 Service Worker 会连接 `ws://127.0.0.1:8090/ws`，并每 20 秒发送保活消息，使服务端可以主动要求扩展采集当前活动页。

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

## 服务端触发采集

本地程序调用以下接口后，服务会通过 WebSocket 通知扩展采集当前聚焦 Chrome 窗口的活动标签页。接口最长等待 15 秒：

```http
POST http://127.0.0.1:8090/capture
```

无需请求体。成功响应：

```json
{
  "requestId": "f68f57fc6ec24f849ee50d768c314cab",
  "context": {
    "url": "https://example.com/",
    "title": "Example",
    "html": "<!DOCTYPE html><html>...</html>",
    "visibleText": "..."
  }
}
```

常见失败状态：

- `503 extension_unavailable`：扩展未加载、未重载或 WebSocket 尚未连接。
- `504 capture_timeout`：扩展未在 15 秒内回传结果。
- `422 page_unavailable`：活动页不允许内容脚本运行，例如 `chrome://` 页面。
- `403 origin_forbidden`：请求来自普通网页。接口只接受无 `Origin` 的本地程序或 Chrome 扩展来源。

PowerShell 调用示例：

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8090/capture"
```

也可以在 Conda `agent` 环境运行响应契约测试：

```powershell
conda run --no-capture-output -n agent python .\server\test_capture_api.py
```

使用 `--output capture.json` 可将包含完整 HTML 的 JSON 响应保存到文件；还可通过 `--endpoint`、`--timeout` 和 `--preview` 调整测试参数。

## 执行 JavaScript

任意 JavaScript 执行默认关闭。需要先停止旧服务，再使用高风险开关启动：

```powershell
python .\server\server.py --allow-js-execution
```

扩展需要重新加载并接受新增的 `debugger` 和 `tabs` 权限。执行时 Chrome 会显示调试器已附加提示。

接口作用于当前聚焦 Chrome 窗口的活动 HTTP/HTTPS 标签页：

```http
POST http://127.0.0.1:8090/execute
Content-Type: application/json
```

请求：

```json
{
  "code": "document.title"
}
```

成功响应：

```json
{
  "requestId": "62a3990a4c9f4a3e854afcdd14d0bb83",
  "result": {
    "type": "string",
    "subtype": null,
    "value": "Example",
    "unserializableValue": null,
    "description": null
  }
}
```

代码会在页面主 JavaScript 世界中通过 Chrome DevTools Protocol `Runtime.evaluate` 执行，支持等待 Promise。代码最大 256 KB，单次执行最长约 10 秒，接口等待扩展最长 15 秒。函数、DOM 节点和循环引用对象通常不能按值序列化，此时应检查 `type`、`subtype` 和 `description`。

该接口允许读取登录态、修改页面和发起页面权限内的请求，仅适合受控的本地开发环境。服务仍只监听 `127.0.0.1`，拒绝普通网页来源，并且未带 `--allow-js-execution` 时返回 `403 js_execution_disabled`。此能力不适合发布到 Chrome Web Store。

在 Conda `agent` 环境运行弹窗测试：

```powershell
conda run --no-capture-output -n agent python .\server\test_execute_api.py
```

脚本调用 `/execute` 后在当前活动页面延迟显示 `alert`，并校验 `requestId`、`result.type` 和 `result.value`。可通过 `--message`、`--delay`、`--endpoint` 和 `--timeout` 调整测试参数。

## 上下文与隐私

- 在用户发送聊天消息或本地程序调用 `/capture` 时采集上下文。
- 完整发送当前动态 DOM 的 `document.documentElement.outerHTML`，不做截断。
- 同时采集标题、描述、三级以内标题、链接/按钮等交互元素；可见正文最多 30,000 个字符，选中文本最多 10,000 个字符。
- 完整 HTML 可能包含隐藏内容、表单默认值、令牌或其他敏感信息；发送前应确认本地服务的处理和存储方式。
- 本地示例服务的 HTTP 请求体和 WebSocket 单条消息上限均为 50 MB，超大页面无法完成采集。
- `/capture` 不向普通网页开放 CORS，WebSocket 也会拒绝普通网页来源，防止网站读取当前活动页内容。
- `/execute` 具有任意页面代码执行能力，应仅在需要时使用启动开关临时启用。
