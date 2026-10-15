---
name: page-context-chat
description: 运行和试用 Page Context Chat 浏览器页面助手（本仓库的 Chrome 扩展 + 本地服务）。负责固定的三步准备链路：先提醒用户安装或重新加载 Chrome 扩展，再根据用户描述选择合适的启动参数在后台拉起本地服务可执行文件，最后检测“服务是否就绪、扩展是否连上”。只要用户想把这个页面助手跑起来、想装/更新它的插件、说扩展连不上或虚拟光标/页面助手按钮不出现、提到 8090 端口或 release 里的 exe、要用虚拟光标点击页面、要模拟打字输入到页面输入框、要采集当前页面、要执行 /capture /click /type /execute，或说“打开页面助手试试”“本地服务起不来”，就使用本技能，即使用户没有明说“用技能”。仅当用户只是改代码、看代码或讨论设计而不需要把它跑起来验证时，不要使用。
---

# Page Context Chat 运行助手

这个技能把「让页面助手真正跑起来」这件事固定成一条三步链路：**装扩展 → 起服务 → 验连接**。三步都要走完，跳过任何一步后面都会以难懂的错误收场（典型是扩展根本没连上，却去怀疑服务或代码）。

仓库根目录即本技能向上三级（`<repo>/skills/page-context-chat/`）。相关背景和接口细节以仓库 `README.md` 为准。

## 第 0 步：从用户描述判断启动模式

本地服务 exe 支持两个高风险开关，默认都关。**只开用户确实需要的那个**——不要替用户主动打开，但也不要因为“保守”而让用户下一步操作直接失败。因此要主动从用户的话里推断意图：

| 用户描述里出现的意图 | 模式 | 追加参数 |
|---|---|---|
| 只想聊天、看页面、采集内容；没提别的 | `plain` | 无 |
| 点击、虚拟光标、操作页面元素/按钮/链接、自动点某个东西、在搜索框/表单里输入文字并回车 | `interaction` | `--allow-interaction` |
| 执行 JS、eval、跑一段脚本、弹 alert、读页面变量 | `js` | `--allow-js-execution` |
| 既要点击又要执行 JS | `full` | 两个参数都加 |
| 完全判断不出来 | `plain` | 先普通模式，并告诉用户哪个开关能解锁什么，让他决定 |

拿不准但用户描述里又明显涉及点击/执行时，倾向于开对应的开关（否则 `/click`、`/execute` 会直接返回 403，只会浪费一轮）。开高风险开关前用一句话说明你开了什么、为什么。

## 第 1 步：提醒用户安装 / 重新加载扩展

这是最先要对用户说清楚的一步。服务起得再好，扩展没装或没重新加载，`/capture`、`/click` 都会返回 `503 extension_unavailable`。

用下面的内容提醒用户（按实际情况裁剪）：

1. **安装扩展**：解压 `release/page-context-chat-extension.zip`，或用源码目录 `extension/`。打开 `chrome://extensions/` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择解压出的目录（或 `extension` 目录）。
2. **改过代码/MANIFEST 就必须重新加载**：在 `chrome://extensions/` 点该扩展的「重新加载」。
3. **重新加载扩展后无需刷新页面**。扩展 1.4.0 起会在后台启动时自动探测并重新注入内容脚本，孤儿脚本也会自行撤下节点（已在 1.4.0 实测确认：重载扩展后不刷新任何页面，`/capture` 立即恢复正常）。若个别页面仍报 `Receiving end does not exist` / `503`，多为受保护页面或权限未授予 `scripting`；让用户刷新一次作为兜底即可。
4. **让一个普通 http/https 页面成为当前活动标签**（且位于当前聚焦的 Chrome 窗口）。`chrome://`、Chrome 应用商店、扩展页等受保护页面无法采集或点击，会返回 `422 page_unavailable`。
5. 可选的目视检查：页面右下角出现「页面助手」按钮、页面上出现虚拟光标（常驻显示）。

如果用户希望你直接继续，也可以先把服务起好（无害），再让用户去装扩展——因为检测环节自然会暴露扩展没连上。

## 第 2 步：在后台启动本地服务

用技能自带脚本启动，它会在后台拉起 exe 并轮询 `/health`，输出一行 JSON：

```powershell
powershell -File .\skills\page-context-chat\scripts\start_server.ps1 -Mode interaction
```

- `-Mode` 取第 0 步推断出的值（`plain` / `interaction` / `js` / `full`）。
- 脚本默认按顺序找：**与本脚本同目录的 `page-context-chat-server.exe`**（技能自带，推荐）、`release/page-context-chat-server.exe`、`server/dist/page-context-chat-server.exe`；也可以用 `-ExePath` 指定。
- 输出里的 `healthy` 为 `true` 表示服务已就绪；`alreadyUp` 为 `true` 说明 8090 上已经有一个实例，脚本不会重复启动。

**找不到 exe 时**：不要卡住。告诉用户先构建（`powershell -File .\build_release.ps1`），或改用源码方式启动（`python server/server.py <参数>`）——源码与 exe 的接口、参数完全一致，只是没有打包分发。

## 第 3 步：检测连接情况

服务就绪后，用脚本判断扩展到底连上没有：

```powershell
powershell -File .\skills\page-context-chat\scripts\check_connection.ps1
```

它先用 `/health` 判断服务，再用 `/capture` 的返回码区分扩展状态，输出 JSON 与 `verdict` 字段：

| verdict | 含义 | 你要做的 |
|---|---|---|
| `connected` | 扩展已连上，且当前活动页可采集（附 `url`/`title`） | 环境 OK，可以进入用户真正想做的事 |
| `connected_no_page` | 扩展已连上，但当前活动标签不是可采集的 http/https 页面 | 让用户切到普通网页并刷新 |
| `extension_unavailable` | 没有任何扩展通过 WebSocket 连上 | 回到第 1 步：确认扩展已加载/重新加载，然后刷新页面 |
| `capture_timeout` | 扩展连上了但没在超时内回应 | 让用户刷新页面重试；必要时重载扩展 |
| `server_not_running` | 服务没起来 | 回到第 2 步 |
| `unexpected` | 其它返回码 | 读 `detail`，必要时看仓库 `README.md` 的错误码表 |

判定为 `connected` 之后再向用户汇报，并给出“现在可以做什么”的建议（例如：要采集就调 `/capture`，要点击就用 `/click`，要在输入框里打字就用 `/type`）。判定失败时不要继续往下做用户的任务，先把连接问题讲清楚并给出具体下一步。

## 停止服务

```powershell
powershell -File .\skills\page-context-chat\scripts\stop_server.ps1
```

按端口找到监听进程并停止。用户说“关掉服务”“停一下”时用它，不要留着后台进程。

## 常见问题速查

- **`503 extension_unavailable`**：扩展没连接。先确认 `chrome://extensions/` 里已加载且无报错，重载扩展后**刷新页面**；服务刚启动时扩展 WebSocket 会按 1/2/4/8/10 秒退避重连，等几秒再试。
- **`422 page_unavailable`**：当前活动页不支持。切到普通 http/https 页面并刷新。
- **`403 interaction_disabled` / `403 js_execution_disabled`**：服务启动时没开对应开关。按第 0 步重开对应模式。
- **虚拟光标/页面助手按钮一闪而过或不出现**：内容脚本可能被 SPA 替换了 DOM（1.2.1 起自愈）；也可能是页面仍跑旧脚本——1.4.0 起扩展会自动重新注入，若仍未恢复就让用户刷新一次页面。
- **8090 被占用**：脚本会返回 `alreadyUp`，或用 `stop_server.ps1` 先停掉旧实例。

## 脚本说明

| 脚本 | 作用 |
|---|---|
| `scripts/start_server.ps1` | 后台启动 exe（按 `-Mode` 加参数），轮询 `/health`，输出 JSON |
| `scripts/check_connection.ps1` | 探测服务与扩展连接，输出 JSON 与 `verdict` |
| `scripts/stop_server.ps1` | 按端口停止服务 |

脚本全部只输出机器可读的 JSON，由你负责翻译成自然语言汇报给用户。用 Windows 自带的 PowerShell 运行即可（`powershell -File ...`）；装了 PowerShell 7 也可以把 `powershell` 换成 `pwsh`。
