# 变更记录

只记录对使用方式有影响的变化，最新在前。

- 返回 [README](../README.md)

## 1.7.0

- 移除页面内的聊天 UI（消息列表、输入框、发送按钮、`/chat` 请求转发），点右下角按钮改为打开**设置面板**。
- 设置面板提供两个勾选项：「虚拟光标」（显示 + 跟随真实鼠标，合并了 1.6.x 的两个开关，存储键 `cursorEnabled`）与「允许执行 JS」（`allowJsExecution`）。
- 扩展侧新增 `/execute` 二次校验：`allowJsExecution` 为关时直接返回 `js_execution_disabled`（HTTP 422）。
- 设置改为跨页面同步：监听 `chrome.storage.onChanged`，任一页面改动即时生效。
- 后台 `hello` 版本号与 manifest 版本同步为 `1.7.0`；`/chat` 接口在服务端保持原样。

## 1.6.4

- 跟随逻辑改用 `screenX` / `screenY` 判断用户是否真的移动了鼠标，消除调试器横幅导致的假 `mousemove`。
