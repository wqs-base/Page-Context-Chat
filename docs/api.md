# HTTP API

本地服务固定监听 `127.0.0.1:8090`，所有接口返回 JSON。页面侧的四个能力（采集、执行、点击、输入）都依赖 Chrome 扩展的 WebSocket 连接，扩展离线时只有 `/health`、`/chat` 可用。

- 返回 [README](../README.md)
- 相关：[设计说明](design.md) · [MCP 接入](mcp.md) · [常见问题](troubleshooting.md)

## 接口总览

| 方法     | 路径         | 用途                                                                | 默认可用         |
| -------- | ------------ | ------------------------------------------------------------------- | ---------------- |
| `GET`  | `/health`  | 服务健康检查                                                        | 是               |
| `POST` | `/chat`    | 接收聊天消息和页面上下文（扩展 1.7.0 起不再调用，仅供外部程序使用） | 是               |
| `POST` | `/capture` | 主动采集当前活动页                                                  | 是               |
| `POST` | `/execute` | 在当前活动页执行 JavaScript                                         | 否，需要启动参数 |
| `POST` | `/click`   | 用虚拟光标移动并点击当前活动页元素                                  | 否，需要启动参数 |
| `POST` | `/type`    | 向当前活动页的目标元素模拟键盘输入                                  | 否，需要启动参数 |
| `GET`  | `/ws`      | 扩展与服务端内部 WebSocket 通道                                     | 是               |

服务端只绑定回环地址，不接受其他机器连接。页面侧的能力（采集、执行、点击、输入）都要经过扩展的 WebSocket 连接，因此扩展没连上时只有 `/health` 和 `/chat` 仍可用。

### 通用错误格式

业务错误统一返回：

```json
{
  "error": {
    "code": "error_code",
    "message": "错误说明"
  }
}
```

### `GET /health`

请求：

```http
GET http://127.0.0.1:8090/health
```

响应：

```json
{
  "status": "ok"
}
```

### `POST /chat`

扩展 1.7.0 起不再调用这个接口（页面聊天输入框已移除），但服务端仍然保留，便于用 `curl`、本地脚本或后续接入的模型服务直接调用：

```http
POST http://127.0.0.1:8090/chat
Content-Type: application/json
```

请求示例：

```json
{
  "message": "总结当前页面",
  "history": [
    {
      "role": "user",
      "content": "上一条问题"
    },
    {
      "role": "assistant",
      "content": "上一条回答"
    }
  ],
  "context": {
    "url": "https://example.com/",
    "title": "Example",
    "language": "zh-CN",
    "description": "Example description",
    "selectedText": "",
    "headings": [
      {
        "level": "h1",
        "text": "Example"
      }
    ],
    "interactiveElements": [],
    "visibleText": "Example page text",
    "html": "<!DOCTYPE html><html>...</html>"
  },
  "client": {
    "name": "page-context-chat",
    "version": "1.7.0"
  }
}
```

当前服务端校验 `message` 为非空字符串、`context` 为对象；`history` 和 `client` 会随请求发送，但占位实现尚未使用。扩展已不再构造这个请求体，上面的示例是给外部调用方参照的形态。

成功响应：

```json
{
  "reply": "回答内容"
}
```

可能的错误：

- `400 invalid_json`
- `400 invalid_body`
- `400 invalid_message`
- `400 invalid_context`

### `POST /capture`

该接口无需请求体。调用后，服务端通过 WebSocket 请求扩展采集当前活动页面：

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8090/capture"
```

成功响应包含完整上下文：

```json
{
  "requestId": "f68f57fc6ec24f849ee50d768c314cab",
  "context": {
    "url": "https://example.com/",
    "title": "Example",
    "language": "en",
    "description": "Example description",
    "selectedText": "",
    "headings": [],
    "interactiveElements": [],
    "visibleText": "Example page text",
    "html": "<!DOCTYPE html><html>...</html>"
  }
}
```

可能的错误：

- `403 origin_forbidden`：请求来自普通网页 Origin。
- `422 page_unavailable`：没有活动标签页，或目标页面不允许内容脚本运行。
- `502 invalid_extension_response`：扩展回包缺少 `context`。
- `503 extension_unavailable`：没有已连接的扩展。
- `504 capture_timeout`：15 秒内未收到采集结果。

### 页面上下文结构

`/capture` 返回的 `context` 由内容脚本在服务端触发时读取当前动态 DOM 生成：

| 字段 | 类型 | 内容与限制 |
|---|---|---|
| `url` | string | 当前页面完整 URL |
| `title` | string | `document.title` |
| `language` | string | 页面 `lang`，缺失时使用浏览器语言 |
| `description` | string | `description` 或 `og:description`，最多 1,000 字符 |
| `selectedText` | string | 当前选中文本，最多 10,000 字符 |
| `headings` | array | 前 60 个 `h1`、`h2`、`h3`，包含 `level` 和 `text` |
| `interactiveElements` | array | 前 80 个链接、按钮、非密码输入框、下拉框和文本域 |
| `visibleText` | string | `document.body.innerText` 规范化结果，最多 30,000 字符 |
| `html` | string | 当前 `document.documentElement.outerHTML`，存在 DOCTYPE 时包含 DOCTYPE，不截断 |

`interactiveElements` 中的每项结构为：

```json
{
  "tag": "a",
  "type": "",
  "text": "Example link",
  "href": "https://example.com/"
}
```

密码输入框不会进入 `interactiveElements`，但完整 HTML 仍可能包含隐藏内容、表单默认值、令牌或其他敏感数据。

### `POST /execute`

必须使用 `--allow-js-execution` 启动服务，并保持扩展设置里的「允许执行 JS」为勾选状态。请求作用于当前活动 HTTP/HTTPS 标签页：

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

PowerShell 示例：

```powershell
$body = @{ code = "document.title" } | ConvertTo-Json
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8090/execute" `
  -ContentType "application/json" `
  -Body $body
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

返回字段对应 CDP `Runtime.RemoteObject` 的精简表示。普通字符串、数字、布尔值、数组和可序列化对象通常放在 `value`；函数、DOM 节点、循环引用对象、`NaN`、`Infinity` 或大整数可能通过 `type`、`subtype`、`description` 或 `unserializableValue` 表达。

可能的错误：

- `400 invalid_json`
- `400 invalid_body`
- `400 invalid_code`
- `403 js_execution_disabled`：服务端启动时未启用 `/execute`。
- `403 origin_forbidden`
- `413 code_too_large`
- `422 js_execution_disabled`：服务端已启用，但扩展设置里取消了「允许执行 JS」，代码没有执行。
- `422 execution_failed`：代码异常、页面不支持、DevTools 已占用调试器等。
- `502 invalid_extension_response`
- `503 extension_unavailable`
- `504 execution_timeout`

### `POST /click`

必须使用 `--allow-interaction` 启动服务。请求让虚拟光标移动到目标元素中心并点击。`selector` 支持两种写法：

- **CSS 选择器**：直接写标准选择器，例如 `#submit-button`、`a[href$="/issues"]`。
- **文本选择器**：`text=完全匹配` 或 `text*=包含匹配`，在可见的可点击元素（链接、按钮、`role=button` 等）中按文字定位，例如 `text=Code`、`text*=提交`。适合按界面标签点击、但标签没有稳定 id/class 的场景。

```http
POST http://127.0.0.1:8090/click
Content-Type: application/json
```

请求（CSS 选择器）：

```json
{
  "selector": "#submit-button"
}
```

请求（文本选择器）：

```json
{
  "selector": "text=Code"
}
```

PowerShell 示例：

```powershell
$body = @{ selector = "#submit-button" } | ConvertTo-Json
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8090/click" `
  -ContentType "application/json" `
  -Body $body
```

成功响应：

```json
{
  "requestId": "0f3a1c9d6b5e4f0a93d2ce7a4b1f8e60",
  "result": {
    "selector": "#submit-button",
    "x": 640,
    "y": 412,
    "tag": "button",
    "text": "提交"
  }
}
```

`result.x` 与 `result.y` 是点击发生时的视口坐标（CSS 像素），`tag` 和 `text` 是实际命中元素的信息，便于调用方核对。

可能的错误：

- `400 invalid_json`
- `400 invalid_body`
- `400 invalid_selector`
- `403 interaction_disabled`
- `403 origin_forbidden`
- `422 click_failed`：选择器无效、未找到元素、元素不在可视区域、页面不支持或调试器被占用等。
- `502 invalid_extension_response`
- `503 extension_unavailable`
- `504 click_timeout`

虚拟光标由内容脚本提供并常驻显示，点击本身通过 CDP 在页面主世界派发真实鼠标事件，因此目标页面能收到 `isTrusted` 为 `true` 的点击。

### `POST /type`

必须使用 `--allow-interaction` 启动服务。请求让扩展把文本逐字符输入到目标元素，用于模拟真人打字。

| 字段         | 类型    | 必填 | 说明                                                                                   |
| ------------ | ------- | ---- | -------------------------------------------------------------------------------------- |
| `text`     | string  | 是   | 要输入的文本，最多 1000 个字符；只想清空时可传空串并把 `clear` 设为 `true`          |
| `selector` | string  | 否   | 目标元素，支持 CSS 选择器或 `text=` / `text*=` 文本选择器；省略时输入到当前焦点元素 |
| `clear`    | boolean | 否   | 输入前先清空目标元素，默认 `false`                                                    |
| `submit`   | boolean | 否   | 输入完成后按一次回车，默认 `false`                                                    |
| `delayMs`  | number  | 否   | 每个字符之间的延迟毫秒数，取值 0–1000，默认 30                                        |

```http
POST http://127.0.0.1:8090/type
Content-Type: application/json
```

请求：

```json
{
  "selector": "#search-input",
  "text": "gitee",
  "clear": true,
  "submit": true,
  "delayMs": 30
}
```

只清空输入框：

```json
{
  "selector": "#search-input",
  "text": "",
  "clear": true
}
```

PowerShell 示例：

```powershell
$body = @{
  selector = "#search-input"
  text     = "gitee"
  clear    = $true
  submit   = $true
} | ConvertTo-Json
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8090/type" `
  -ContentType "application/json" `
  -Body $body
```

成功响应：

```json
{
  "requestId": "7c1d2b4a9f0e43d1be56a7c8d9e0f123",
  "result": {
    "selector": "#search-input",
    "text": "gitee",
    "length": 5,
    "delayMs": 30,
    "cleared": true,
    "submitted": true,
    "tag": "input",
    "editable": true
  }
}
```

`result.cleared` 表示是否真的执行过清空，`result.editable` 是目标元素可输入性的判定结果；省略 `selector` 时 `result.tag` 为空串、`result.editable` 为 `null`。

可能的错误：

- `400 invalid_json`
- `400 invalid_body`
- `400 invalid_text`：`text` 不是字符串，或在没有同时指定 `clear` 的情况下传了空串。
- `400 invalid_selector`
- `400 invalid_flags`：`clear` / `submit` 不是布尔值。
- `400 invalid_delay`：`delayMs` 不是数字或超出 0–1000。
- `400 typing_too_slow`：`text` 与 `delayMs` 组合的预计输入时间超过 60 秒。
- `403 interaction_disabled`
- `403 origin_forbidden`
- `413 text_too_long`：`text` 超过 1000 个字符。
- `422 type_failed`：选择器无效、未找到元素、元素不可输入、页面不支持或调试器被占用等。
- `502 invalid_extension_response`
- `503 extension_unavailable`
- `504 type_timeout`

输入本身通过 CDP 派发真实按键事件，和手动敲键盘一样会触发页面的 `keydown` / `keypress` / `input` 链路；`clear` 走脚本清空，只影响目标元素的值。

### `GET /ws`

该接口供扩展内部使用，不是普通业务调用接口。主要消息类型：

| 方向         | `type`           | 说明                       |
| ------------ | ------------------ | -------------------------- |
| 服务端到扩展 | `ready`          | WebSocket 建立完成         |
| 扩展到服务端 | `hello`          | 扩展名称和版本             |
| 扩展到服务端 | `ping`           | 20 秒保活                  |
| 服务端到扩展 | `pong`           | 保活响应                   |
| 服务端到扩展 | `capture_page`   | 请求采集活动页             |
| 扩展到服务端 | `capture_result` | 返回上下文或错误           |
| 服务端到扩展 | `execute_script` | 请求执行 JavaScript        |
| 扩展到服务端 | `execute_result` | 返回执行结果或错误         |
| 服务端到扩展 | `click_element`  | 请求用虚拟光标点击元素     |
| 扩展到服务端 | `click_result`   | 返回点击结果或错误         |
| 服务端到扩展 | `type_text`      | 请求向目标元素模拟键盘输入 |
| 扩展到服务端 | `type_result`    | 返回输入结果或错误         |

WebSocket 单条消息上限为 50 MB。

