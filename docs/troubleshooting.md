# 常见问题与已知限制

按 HTTP 状态码与现象索引。接口细节见 [HTTP API](api.md)，实现细节见 [设计说明](design.md)。

- 返回 [README](../README.md)

## `/capture` 返回 `503 extension_unavailable`

- 确认扩展已加载。
- 在扩展更新后点击“重新加载”。
- 确认服务启动后等待扩展完成 WebSocket 重连。
- 检查扩展 Service Worker 控制台中的连接错误。

## `/capture` 返回 `422 page_unavailable`

- 将活动页切换到普通 HTTP/HTTPS 页面。
- 刷新目标页面，让最新版内容脚本重新注入。
- `chrome://`、Chrome Web Store 和受保护页面无法采集。

## 重载扩展后页面报 `Receiving end does not exist`

重新加载扩展会让**已打开页面里的旧内容脚本失去 `chrome.runtime` 通道**（“孤儿脚本”）：控件还在，但消息通道已断，于是 `/capture` 报 `Receiving end does not exist`。

扩展 1.4.0 起会自动处理：后台启动时会逐个探测已打开页面（发一条 `PING_PAGE_CONTEXT_CHAT`），发现没有接收端就通过 `chrome.scripting.executeScript` 重新注入 `content.js`；孤儿脚本自身也会检测到通道失效并撤下自己的节点，把位置让给新脚本。因此**不再需要手动刷新页面**。

> 已在扩展 1.4.0 实测验证：重载扩展后**不做任何页面刷新**，对同一个已打开的页面执行 `POST /capture` 立即返回 200（修复前该页面会一直报 `Receiving end does not exist`）。

如果仍不生效，检查：扩展是否已重新加载并授予了 `scripting` 权限；该页面是否为受保护页面（这类页面本来就不能注入）。

## `/execute` 返回 `403 js_execution_disabled`

服务端启动时没开这个能力，用以下命令重启服务：

```powershell
python .\server\server.py --allow-js-execution
```

## `/execute` 返回 `422 js_execution_disabled`

服务端已开放，但**扩展设置里的「允许执行 JS」被取消了**。打开页面右下角「设置」重新勾选即可（设置对所有页面生效）。

排查顺序：先看 HTTP 状态码——`403` 是服务端启动参数问题，`422` 是扩展侧开关问题。

## 在别的标签页改了设置，本页没生效

1.7.0 起扩展监听 `chrome.storage.onChanged`，任一页面改动会同步到所有已打开页面。若仍是旧行为，通常是因为扩展还停留在改动前的版本：在 `chrome://extensions/` 重新加载扩展（再刷新一次页面作为兜底）。

历史上设置只在“页面加载时”和“本页点勾选框时”读取，所以旧版本里跨标签页改动不会即时生效。

## `/click` 返回 `403 interaction_disabled`

使用以下命令重启服务：

```powershell
python .\server\server.py --allow-interaction
```

## `/type` 返回 `403 interaction_disabled`

和 `/click` 共用同一个启动参数：

```powershell
python .\server\server.py --allow-interaction
```

## `/type` 返回 `422 type_failed`

- 传了 `selector` 时，确认它能命中元素、元素位于可视区域内，且是可输入的元素（`input` / `textarea` / `contenteditable` / `role=textbox` 等）。
- 想输入到页面上已经聚焦的元素时，省略 `selector` 即可跳过元素定位与可输入性检查。
- 确认当前活动页是 HTTP/HTTPS 页面，且扩展已获得 `debugger` 权限。
- 如果 Chrome DevTools 已附加到同一标签页，输入可能失败，关闭后重试。

## `/type` 输入的文本没生效

- 检查响应里的 `result.editable`：为 `false` 说明命中的元素不可输入，按键事件不会产生文本。
- 输入完成后页面可能需要一点时间响应，尤其是 `submit` 触发的搜索或表单提交，建议稍等再 `/capture` 核对。
- 组合键（`Ctrl+A`、`Shift+方向键`）和多行粘贴目前不支持，`text` 中的换行会按一次回车键处理。

## 光标跟随开启后，动作结束时会自己滑回指针旁边

这是 Chrome 调试器横幅带来的**假 `mousemove`**，不是跟随逻辑失灵。

`/click`、`/type`、`/execute` 都会 attach 调试器，Chrome 会在页面顶部插入一条调试横幅，视口高度瞬时变化（实测 `innerHeight` 773 → 717，差 56 像素），约 5 秒后横幅收起又变回来。这两次变化都会让 Chrome 为**静止的**指针重算 `clientX/clientY` 并补发 `mousemove`，`clientY` 的差值正好等于横幅高度。

扩展 **1.6.4** 起以 `screenX` / `screenY` 判断指针是否真的移动过，这类事件会被忽略；`resize` 回调也不再重设跟随目标。可以在动作结束后用 `/execute` 观察现象与来源：

```javascript
// 光标当前位置（CSS 像素、视口坐标）
const cursor = document.getElementById("page-context-chat-cursor");
cursor.dataset.x + "," + cursor.dataset.y;

// 同时记录事件：cy 在变、sx/sy 不变的那些就是假事件
document.addEventListener("mousemove",
  (e) => console.log(e.clientX, e.clientY, e.screenX, e.screenY), true);
```

实测日志（光标停在目标 `460,74` 纹丝不动，期间到达的全是假事件）：

```text
{t:28730, cx:1391, cy:502, sx:1391, sy:674}   // 物理指针真实位置
{t:28746, cx:1391, cy:518, sx:1391, sy:674}   // clientY 在变 → 视口重算
{t:28839, ev:"resize", h:773}                 // 横幅收起
{t:28855, cx:1391, cy:553, sx:1391, sy:674}   // 又补了一发
```

## `/click` 返回 `422 click_failed`

- 确认选择器能命中元素，且元素位于可视区域内（扩展会自动滚动到元素中央）。
- 确认当前活动页是 HTTP/HTTPS 页面，且扩展已获得 `debugger` 权限。
- 如果 Chrome DevTools 已附加到同一标签页，点击可能失败，关闭后重试。
- 确认页面已刷新，加载的是包含虚拟光标的 1.7.0 内容脚本。

## `/execute` 返回 `422 execution_failed`

- 确认当前活动页是 HTTP/HTTPS 页面。
- 确认扩展已获得 `debugger` 和 `tabs` 权限。
- 关闭该标签页已打开的 Chrome DevTools，再重试。
- 检查传入代码是否抛出异常或执行超时。

## 页面没有出现“设置”按钮

- 刷新页面。
- 检查页面是否为允许注入的 HTTP/HTTPS 页面。
- 在 `chrome://extensions/` 中查看扩展错误。
- 页面使用的 CSP 不影响内容脚本 UI，但浏览器受保护页面仍禁止注入。

## 端口 `8090` 被占用

```powershell
Get-NetTCPConnection -LocalPort 8090 -State Listen
```

停止占用进程后重新启动服务。当前实现未提供端口配置参数。

## 当前限制

- `/chat` 仅返回占位回答，尚未接入 LLM 或业务服务；扩展侧的聊天输入框已在 1.7.0 移除，调用方需要自己发请求。
- 没有“只移动光标、不点击”的独立接口：光标只能由 `/click`、`/type`（随动作移动到目标）或跟随真实鼠标驱动。想让它停在某个元素上又不触发点击，目前只能借用跟随逻辑（需要「虚拟光标」保持勾选并移动真实指针）。
- 虚拟光标只能在设置面板里整体开关（1.7.0 起「虚拟光标」勾选项同时控制显示与跟随），不支持手动拖动。
- 跟随只在顶层文档生效：指针移到跨源 iframe 上时浏览器不会把 `mousemove` 传给外层文档，虚拟光标会停在上一次位置。
- `closed` Shadow DOM 让页面脚本（包括 `/execute`）读不到面板和光标内部结构，只能用 `#page-context-chat-cursor` 的 `data-x` / `data-y` 核对光标位置。
- `/click` 每次只操作一个元素，未实现双击、右键或拖拽。
- `/type` 逐字符输入，不支持组合键（`Ctrl+C`、`Shift+方向键` 等）、粘贴、撤销和输入法候选词选字；`clear` 通过脚本清空元素值，不会触发页面的删除键逻辑；`text` 中的换行按一次回车键处理。
- 页面交互（`/click`、`/type`）固定作用于当前聚焦窗口的活动标签页。
- 服务地址、端口和扩展端点目前为固定值。
- 页面采集和 JavaScript 执行固定作用于当前聚焦窗口的活动标签页。
- 多个扩展实例连接时使用最后建立的存活连接，未提供客户端选择参数。
- 未实现鉴权、持久化、审计日志和生产级访问控制。
- 完整 HTML 和大型执行结果可能带来较高内存、序列化和传输开销。
- Chrome 内部页面和其他受保护页面不支持采集或执行。

