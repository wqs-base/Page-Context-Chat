# MCP 接入（AI 编码代理）

把本仓库接入 OpenCode 等支持 MCP 的编码代理：同一个 exe 带 `--mcp` 即成为 stdio 前端，由它拉起并调用本地服务。

- 返回 [README](../README.md)
- 相关：[HTTP API](api.md) · [设计说明](design.md) · [常见问题](troubleshooting.md)

```mermaid
flowchart LR
    AG[AI 编码代理 / MCP 客户端] -->|stdio JSON-RPC| MCP["page-context-chat-server --mcp"]
    MCP -->|"按需拉起 + HTTP 调用"| SVC["本地服务 127.0.0.1:8090"]
    SVC <-->|WebSocket| EXT[Chrome 扩展]
```

## 前提：exe 在哪

MCP 接入只需要一个文件：`release/page-context-chat-server.exe`（Windows 64 位单文件，目标机器无需安装 Python 或 aiohttp）。下文统一用仓库内路径举例，实际配置请换成**本机上的绝对路径**。

## 方式一：直接用仓库自带的 `opencode.json`（推荐）

仓库根目录已经带好一份配置，克隆后无需改动即可使用：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "page-context-chat": {
        "type": "local",
        "command": [
          "E:\\python\\Page-Context-Chat\\release\\page-context-chat-server.exe",
          "--mcp"
        ],
        "timeout": { "startup": 60000 },
        "enabled": true
      }
    }
  }
}
```

如果克隆到了别的目录，只需把 `command[0]` 改成该目录下的实际绝对路径。

## 方式二：用命令行添加

```powershell
opencode mcp add page-context-chat -- "E:\python\Page-Context-Chat\release\page-context-chat-server.exe" --mcp
```

## 方式三：手写进配置

- **项目级**：把上面的 `mcp.servers` 片段写进仓库根目录的 `opencode.json`，只对当前项目生效。
- **全局级**：写进 `C:\Users\<你的用户名>\.config\opencode\opencode.jsonc`，对所有项目生效：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "page-context-chat": {
        "type": "local",
        "command": ["D:\\tools\\page-context-chat-server.exe", "--mcp"],
        "timeout": { "startup": 60000 }
      }
    }
  }
}
```

## 配置项说明

| 字段                                           | 必填         | 说明                                                                                                               |
| ---------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `type`                                       | 是           | 固定 `local`：本地进程 + stdio 通信。 |
| `command`                                    | 是           | 数组。`command[0]` 是 exe 的**绝对路径**，其余元素是启动参数。 |
| `command` 中的 `--mcp`                     | **是** | **必须带**。没有它，exe 会以普通 HTTP 服务启动，MCP 握手必然失败。 |
| `command` 追加 `--mcp-service-mode <mode>` | 否           | 拉起本地服务时的权限档位，取值 `plain` / `interaction` / `js` / `full`，**默认 `full`**（全权限）。 |
| `timeout.startup`                            | 否           | 启动超时（毫秒）。单文件 exe 首次解包 + 拉起服务要十几秒，建议 `60000`。 |
| `enabled`                                    | 否           | 默认 `true`。设为 `false` 可临时停用而不删配置。 |

## 验证

改完配置重启 OpenCode，MCP 面板里 `page-context-chat` 应显示已连接，并列出 5 个工具：`status` / `capture_page` / `click_element` / `type_text` / `execute_script`。

最省事的验证是直接调用 `status`——它会按需把本地服务拉起来，并返回服务是否就绪、扩展是否连上、当前活动页：

```json
{
  "service": true,
  "serviceUrl": "http://127.0.0.1:8090",
  "serviceMode": "full",
  "extensionConnected": true,
  "page": { "url": "https://example.com/", "title": "Example" }
}
```

`service: true` 说明服务已就绪；`extensionConnected: false` 表示 Chrome 扩展还没连上（见 [常见问题](troubleshooting.md) 里的 `503 extension_unavailable`）。

## 配置常见错误

| 现象                                                                               | 原因                                                                              | 处理                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `Connection closed: MCP server process exited with code 1: 系统找不到指定的路径` | `command[0]` 指向的 exe 不存在（例如从别处抄了一段占位路径 `E:\path\to\...`） | 换成 exe 的真实绝对路径 |
| 同上，但报错显示成乱码 | 上面那句 GBK 文本被控制台按错误编码渲染，信息本身不变 | 按上一条处理 |
| MCP 始终连不上，且 `127.0.0.1:8090` 已被占用 | 漏掉了 `--mcp`，exe 退化成普通 HTTP 服务常驻 | 补上 `--mcp`，并先停掉 8090 上的进程（见 [停止服务](development.md#停止服务)） |
| 工具列表里没有 `click_element` / `type_text` / `execute_script` | `--mcp-service-mode` 被收窄成 `plain`，对应接口未开放 | 改成 `interaction` / `js` / `full` |

## 工具

| 工具               | 对应接口                   | 说明                                                                                         |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------- |
| `status`         | `/health` + `/capture` | 服务是否就绪、扩展是否连上、当前活动页；**开始任何页面操作前先调它**                   |
| `capture_page`   | `/capture`               | 页面标题/URL/可见文本/可交互元素；**默认不返回整页 HTML**（需要时传 `include_html`） |
| `click_element`  | `/click`                 | 虚拟光标真实点击，支持 CSS 或 `text=` / `text*=` |
| `type_text`      | `/type`                  | 模拟键盘输入，可选 `clear` / `submit` / `delay_ms` |
| `execute_script` | `/execute`               | 主世界执行 JavaScript                                                                        |

扩展侧的设置会叠加在这些工具之上：

- 取消「允许执行 JS」后，`execute_script` 返回 `js_execution_disabled`（HTTP 422），其余工具不受影响。
- 取消「虚拟光标」只是隐藏并停止跟随，`click_element`、`type_text` 仍会照常滚动页面、移动光标位置并派发真实事件（光标不可见）。
- 采集类工具（`status`、`capture_page`）不受两个开关影响。

## 权限

`--mcp` 拉起服务时**默认全权限**（`--allow-js-execution --allow-interaction`）。要收窄就加参数：

```jsonc
"command": [
  "E:\\python\\Page-Context-Chat\\release\\page-context-chat-server.exe",
  "--mcp",
  "--mcp-service-mode", "interaction"
]
```

取值 `plain` / `interaction` / `js` / `full`。MCP 客户端侧还能按工具名再拦一道（OpenCode）：

```jsonc
"permissions": [{ "action": "page_context_chat_execute_script", "resource": "*", "effect": "deny" }]
```

## 实现上的几个注意点

- **stdout 是协议通道**：MCP 前端所有日志走 stderr，被拉起的服务的 stdout 也重定向到日志文件，绝不能继承协议流。
- **协议是 UTF-8**：Windows 中文环境下 `sys.stdin.encoding` 是 **GBK**，按文本读会把 `通道测试` 解成 `鎫求仅婴寭畿` 并一路传到页面里。实现改为按字节读、显式 UTF-8 解码；写 stdout 也写 UTF-8 字节（否则页面里的 `›` 这类字符会因 GBK 编不出来而报错）。
- **单文件模式要给子进程清理环境**：PyInstaller 会把 `_MEIPASS2` 传给子进程，继承后新实例会复用 MCP 进程的临时解包目录，导致本进程退不干净、服务还依赖了一个会被删掉的目录。拉起前会剔除 `_MEI*` / `_PYI*` 变量。
- **服务单例**：已在运行就直接复用，不重复启动；扩展的连接也不会随 MCP 会话结束而断开。

