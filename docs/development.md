# 开发与构建

仓库结构、测试脚本、PyInstaller 打包流程与服务停止方式。

- 返回 [README](../README.md)
- 相关：[设计说明](design.md) · [HTTP API](api.md) · [MCP 接入](mcp.md)

## 项目结构

```text
Page-Context-Chat/
|-- .gitignore
|-- README.md
|-- opencode.json              # OpenCode MCP 接入配置（page-context-chat）
|-- build_release.ps1          # 一键生成分发产物（服务端 exe + 扩展 zip）
|-- extension/
|   |-- manifest.json          # Manifest V3、权限和注入配置（1.7.0）
|   |-- background.js          # WebSocket 客户端、活动页采集、CDP 执行/点击/输入、JS 执行开关校验
|   `-- content.js             # Shadow DOM 设置面板、页面上下文采集、虚拟光标与跟随
|-- release/                   # 分发产物（随仓库提交）
|   |-- page-context-chat-server.exe       # 本地服务可执行文件（也是 MCP 前端）
|   `-- page-context-chat-extension.zip    # Chrome 扩展打包
`-- server/
    |-- requirements.txt       # aiohttp 依赖
    |-- server.py              # HTTP/WebSocket 本地服务
    |-- mcp_stdio.py           # MCP stdio 前端（拉起服务 + 通过 HTTP 调用）
    |-- build_exe.ps1          # 仅构建服务端可执行文件
    |-- page_context_chat_server.spec   # PyInstaller 打包配置
    |-- test_server.py         # 服务端异步协议单元测试
    |-- test_capture_api.py    # /capture 集成测试脚本
    |-- test_click_api.py      # /click 虚拟光标点击集成测试脚本
    |-- test_type_api.py       # /type 模拟输入集成测试脚本
    |-- test_mcp_stdio.py      # MCP stdio 协议与 UTF-8 回归测试
    `-- test_execute_api.py    # /execute alert 集成测试脚本
```


## 测试

### 服务端协议测试

安装依赖后执行：

```powershell
python -m unittest server.test_server -v
```

测试覆盖：

- `/capture` WebSocket 往返。
- 普通网页 Origin 拒绝。
- 扩展未连接时返回 `503`。
- `/execute` 默认关闭。
- 启用后 `/execute` WebSocket 往返和结果返回。
- `/click` 默认关闭。
- 启用后 `/click` WebSocket 往返、结果返回和扩展失败回传。
- `/type` 默认关闭。
- 启用后 `/type` WebSocket 往返、参数校验（空文本、选择器、`delayMs` 范围与总耗时）和扩展失败回传。
- MCP 前端：`initialize` 回显协议版本、`tools/list` 返回 5 个工具、未知方法返回 `-32601`、参数校验失败回传 `isError` 结果，以及把 `PYTHONIOENCODING=gbk` 注入子进程后 UTF-8 参数（中文）仍不被解成乱码。

### 页面采集集成测试

先启动服务并确保扩展已加载、目标 HTTP/HTTPS 页面处于活动状态：

```powershell
conda run --no-capture-output -n agent python .\server\test_capture_api.py
```

普通 Python 环境也可以直接运行：

```powershell
python .\server\test_capture_api.py
```

脚本校验 `requestId`、`context`、非空 `html` 和 `<html>` 根元素，并输出 URL、标题、HTML 长度、可见文本长度和 HTML 预览。

可选参数：

```text
--endpoint URL    自定义接口地址
--timeout SEC     请求超时，默认 20 秒
--preview N       HTML 预览字符数，默认 200
--output PATH     将完整 JSON 响应保存到文件
```

### JavaScript alert 集成测试

先以 `--allow-js-execution` 启动服务，并确保扩展 1.7.0 已重新加载：

```powershell
conda run --no-capture-output -n agent python .\server\test_execute_api.py
```

脚本调用 `/execute`，安排当前活动页延迟显示 `alert`，然后校验 `requestId`、`result.type == "string"` 和 `result.value == "alert scheduled"`。

可选参数：

```text
--endpoint URL    自定义接口地址
--timeout SEC     HTTP 超时，默认 20 秒
--delay MS        弹窗延迟，默认 300 毫秒
--message TEXT    自定义弹窗文本
```

### 虚拟光标点击集成测试

先以 `--allow-interaction` 启动服务，并确保扩展 1.7.0 已重新加载，且目标 HTTP/HTTPS 页面处于活动状态：

```powershell
conda run --no-capture-output -n agent python .\server\test_click_api.py --selector "#some-button"
```

脚本调用 `/click`，校验 `requestId` 以及 `result.x` / `result.y` 为数值，并输出命中元素的 `selector`、坐标、`tag` 和 `text`。

可选参数：

```text
--endpoint URL    自定义接口地址
--selector CSS    要点击元素的 CSS 选择器，默认 a[href]
--timeout SEC     HTTP 超时，默认 20 秒
```

### 模拟输入集成测试

先以 `--allow-interaction` 启动服务，并确保扩展 1.7.0 已重新加载，且目标 HTTP/HTTPS 页面中有一个可见输入框：

```powershell
conda run --no-capture-output -n agent python .\server\test_type_api.py --selector "#search-input" --text "gitee" --clear --submit
```

脚本调用 `/type`，校验 `requestId` 以及 `result.length` 与输入文本长度一致，并输出命中元素的 `tag`、`cleared`、`submitted` 和 `editable`。

可选参数：

```text
--endpoint URL    自定义接口地址
--selector CSS    目标输入元素的 CSS 选择器，默认 input；传空字符串表示输入到当前焦点元素
--text TEXT       要输入的文本，默认 page context chat
--delay-ms MS     每个字符之间的延迟毫秒数，默认 30
--clear           输入前先清空目标元素
--submit          输入完成后按一次回车
--timeout SEC     HTTP 超时，默认 30 秒
```

## 打包与分发

仓库中已包含打包好的分发产物，随仓库一起提交，开箱即用：

| 产物               | 位置                                        | 说明                                                             |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------- |
| 本地服务可执行文件 | `release/page-context-chat-server.exe`    | Windows 64 位单文件，目标机器无需安装 Python 或 aiohttp          |
| Chrome 扩展打包    | `release/page-context-chat-extension.zip` | zip 根目录即 `manifest.json`、`background.js`、`content.js` |

可执行文件和扩展包都放在 `release/` 下，开箱即用：exe 既可以手动启动本地服务（见下文「运行可执行文件」），也可以直接作为 MCP server 接给编码代理（见 [MCP 接入](mcp.md)）。

### 重新生成分发产物

先安装构建依赖：

```powershell
python -m pip install pyinstaller
```

在项目根目录执行一键打包脚本：

```powershell
pwsh -File .\build_release.ps1
# 或指定解释器
pwsh -File .\build_release.ps1 -Python "D:\miniforge3\envs\agent\python.exe"
```

脚本会先用 PyInstaller 构建服务端 exe（中间产物在 `server/build`、`server/dist`），复制到 `release/`，再把 `extension/` 打包成 `release/page-context-chat-extension.zip`。`build/` 与 `dist/` 已被 `.gitignore` 忽略，属于中间产物。

只想要服务端 exe 时，也可以单独执行：

```powershell
pwsh -File .\server\build_exe.ps1
# 或直接调用 spec
python -m PyInstaller --noconfirm --clean `
  --distpath server/dist --workpath server/build `
  server/page_context_chat_server.spec
```

### 运行可执行文件

`release/page-context-chat-server.exe` 的启动参数与 `python .\server\server.py` 完全一致（Argparse 逻辑未改动），提供以下启动模式：

| 模式                | 命令                                                                                | 额外开放的接口                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 普通模式（默认）    | `.\release\page-context-chat-server.exe`                                          | 无，仅 `/health`、`/chat`、`/capture`、`/ws` |
| 页面交互模式        | `.\release\page-context-chat-server.exe --allow-interaction`                      | `/click` + `/type` |
| JavaScript 执行模式 | `.\release\page-context-chat-server.exe --allow-js-execution`                     | `/execute` |
| 完整模式            | `.\release\page-context-chat-server.exe --allow-js-execution --allow-interaction` | `/click` + `/type` + `/execute` |
| MCP 模式            | `.\release\page-context-chat-server.exe --mcp`                                    | 本进程不开放 HTTP，改为向 MCP 客户端提供工具，并按 `--mcp-service-mode`（默认全权限）拉起本地服务 |

说明：

- `--allow-interaction` 启用虚拟光标点击 `/click` 和模拟输入 `/type`，`--allow-js-execution` 启用任意 JavaScript 执行 `/execute`；两者默认关闭，可独立或同时使用，未启用时分别返回 `403 interaction_disabled` 和 `403 js_execution_disabled`。
- 直接双击 exe 等同于无参数启动普通模式。程序带控制台窗口运行，启动时会打印监听地址，启用高风险参数时会额外打印警告。
- 监听地址固定为 `http://127.0.0.1:8090`，接口路由与行为同源码方式一致，分发时只需拷贝该 exe。
- 停止服务：在运行窗口按 `Ctrl+C`。需要后台运行时可用 `Start-Process`，按端口停止的方法见下文「停止服务」一节。
- 单文件模式每次启动会把内容解压到临时目录，首次启动略慢，属正常现象；若在意启动速度，可在 spec 中把 `EXE(...)` 拆成 `EXE` + `COLLECT` 生成目录形式。
- 当前 exe 为 Windows 64 位构建（Python 3.11 + aiohttp 3.14），其它平台需在对应系统上各自构建。

### 安装已打包的扩展

`release/page-context-chat-extension.zip` 解压后即为扩展目录，加载方式与源码一致：

1. 把 zip 解压到任意目录；
2. 打开 `chrome://extensions/`，启用「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择解压出的目录。

> Chrome 已不允许从商店外直接安装 `.crx`，因此分发采用 zip + 加载已解压扩展的方式。

> 提示：把大体积二进制直接提交进 Git 会让仓库历史和克隆体积持续变大。若希望更规范地分发，可改为用 GitHub Releases 上传这些产物（例如 `gh release create v1.3.0 release/page-context-chat-server.exe release/page-context-chat-extension.zip`），或在需要时改用 Git LFS。

## 停止服务

在服务运行的终端按 `Ctrl+C`。也可以在 PowerShell 中按监听端口停止：

```powershell
$connection = Get-NetTCPConnection -LocalPort 8090 -State Listen
Stop-Process -Id $connection.OwningProcess
```

