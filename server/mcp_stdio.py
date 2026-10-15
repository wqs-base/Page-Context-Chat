#!/usr/bin/env python3
"""MCP (Model Context Protocol) stdio front-end for the Page Context Chat service.

职责只有两件事：

1. 启动/复用一个本地服务进程（`server.py` 或同一个 exe），默认以全权限拉起；
2. 之后通过 HTTP 调它的 `/health`、`/capture`、`/click`、`/type`、`/execute`。

本进程**不监听任何端口**：HTTP/WebSocket 服务仍由被拉起的那个进程提供，Chrome 扩展照旧
主动连 `127.0.0.1:8090`。因此扩展和 `server.py` 的路由都不需要为 MCP 做任何改动。

stdout 只用于 MCP 的 JSON-RPC 帧，**所有日志一律走 stderr**——否则会直接打乱协议流。

在 OpenCode 中配置（opencode.jsonc）：

    {
      "mcp": {
        "servers": {
          "page-context-chat": {
            "type": "local",
            "command": [
              "E:/path/to/page-context-chat-server.exe",
              "--mcp"
            ],
            "timeout": { "startup": 60000 }
          }
        }
      }
    }
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from typing import Any

HOST = "127.0.0.1"
PORT = 8090
BASE_URL = f"http://{HOST}:{PORT}"

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "page-context-chat"
SERVER_VERSION = "1.0.0"

SERVICE_MODE_FLAGS: dict[str, list[str]] = {
    "plain": [],
    "interaction": ["--allow-interaction"],
    "js": ["--allow-js-execution"],
    "full": ["--allow-js-execution", "--allow-interaction"],
}

HEALTH_TIMEOUT_SECONDS = 2.0
STARTUP_WAIT_SECONDS = 40.0
CAPTURE_TIMEOUT_SECONDS = 20.0
CLICK_TIMEOUT_SECONDS = 20.0
TYPE_TIMEOUT_SECONDS = 120.0
EXECUTE_TIMEOUT_SECONDS = 20.0

DEFAULT_MAX_TEXT_CHARS = 20000
DEFAULT_MAX_HTML_CHARS = 200000


def _write_line(stream: Any, text: str) -> None:
    """按 UTF-8 写一行。

    Windows 下 stdout/stderr 的默认编码是控制台代码页（中文机器上是 GBK），
    页面里的 `›` 这类字符会直接编码失败；而 MCP 协议本来就要求 UTF-8，
    所以这里显式写 UTF-8 字节，不受代码页影响。
    """
    data = (text + "\n").encode("utf-8")
    buffer = getattr(stream, "buffer", None)
    if buffer is not None:
        buffer.write(data)
        buffer.flush()
        return
    stream.write(data.decode("utf-8"))
    stream.flush()


def log(message: str) -> None:
    """日志只走 stderr——stdout 是 MCP 的协议通道。"""
    _write_line(sys.stderr, message)


def iter_stdin_lines() -> Any:
    """按 UTF-8 逐行读取 stdin。

    Windows 中文环境里 `sys.stdin.encoding` 是 cp936/GBK，直接 `for line in sys.stdin`
    会把 UTF-8 的协议帧解成乱码（实测：`通道测试` 的 UTF-8 字节被解成 `鎫求仅婴寭畿`）。
    MCP 协议规定就是 UTF-8，所以这里绕过文本层、按字节读再显式解码。
    """
    buffer = getattr(sys.stdin, "buffer", None)
    if buffer is None:
        for line in sys.stdin:
            yield line
        return
    for raw in buffer:
        yield raw.decode("utf-8", "replace")


class ServiceUnavailable(RuntimeError):
    """本地服务不可达（还没起来、或起不来）。"""


# --- 本地服务生命周期 ---------------------------------------------------------

_service_lock = threading.Lock()
_service_ready = False


def service_is_up() -> bool:
    try:
        with urllib.request.urlopen(f"{BASE_URL}/health", timeout=HEALTH_TIMEOUT_SECONDS) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, TimeoutError):
        return False


def build_service_command(service_mode: str) -> list[str]:
    flags = SERVICE_MODE_FLAGS.get(service_mode, SERVICE_MODE_FLAGS["full"])
    if getattr(sys, "frozen", False):
        # 打包后：用同一个 exe，只是不带 --mcp → 进入普通服务模式。
        return [sys.executable, *flags]
    return [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py"), *flags]


def service_environment() -> dict[str, str]:
    """给被拉起的服务准备一份干净环境。

    PyInstaller 单文件模式会把 `_MEIPASS2` 这类变量传给子进程。若被子进程继承，
    新的实例会直接复用**本进程**的临时解包目录，后果是：

    - 本进程退出时报 `Failed to remove temporary directory: _MEI...`；
    - 被拉起的服务依赖本进程的 `_MEI` 目录，本进程一退出它就可能缺文件。

    所以这里剔掉 PyInstaller 的变量，让服务自己解包到自己的目录。
    """
    env = os.environ.copy()
    for key in list(env):
        if key.startswith("_MEI") or key.startswith("_PYI"):
            env.pop(key, None)
    return env


def spawn_service(service_mode: str) -> int:
    command = build_service_command(service_mode)
    log_dir = os.path.join(os.environ.get("TEMP") or os.environ.get("TMP") or ".", "page-context-chat")
    os.makedirs(log_dir, exist_ok=True)
    out_log = open(os.path.join(log_dir, "mcp-service.out.log"), "ab", buffering=0)
    err_log = open(os.path.join(log_dir, "mcp-service.err.log"), "ab", buffering=0)
    kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        # 关键：子进程的 stdout 绝不能继承本进程的 stdout，否则会把服务端日志写进 MCP 协议流。
        "stdout": out_log,
        "stderr": err_log,
        "close_fds": True,
        "env": service_environment(),
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(command, **kwargs)
    log(f"started local service: pid={process.pid} mode={service_mode} logs={log_dir}")
    return process.pid


def ensure_service(service_mode: str, wait_seconds: float = STARTUP_WAIT_SECONDS) -> dict[str, Any]:
    """服务已经在跑就复用；否则以指定权限模式拉起并等待 /health。"""
    global _service_ready
    with _service_lock:
        if _service_ready and service_is_up():
            return {"started": False, "reused": True, "pid": None}
        if service_is_up():
            _service_ready = True
            return {"started": False, "reused": True, "pid": None}

        pid = spawn_service(service_mode)
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            if service_is_up():
                _service_ready = True
                return {"started": True, "reused": False, "pid": pid}
            time.sleep(0.3)
        raise ServiceUnavailable(
            f"本地服务在 {wait_seconds:.0f} 秒内没有响应 {BASE_URL}/health"
            f"（日志见 %TEMP%/page-context-chat/mcp-service.err.log）"
        )


def warm_up_service(service_mode: str) -> None:
    """后台预热，避免第一次工具调用才等启动。失败只记日志，由工具调用时报错。"""
    try:
        ensure_service(service_mode)
    except ServiceUnavailable as error:
        log(f"service warm-up failed: {error}")


# --- HTTP 调用 ----------------------------------------------------------------


def request_json(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    timeout: float = CAPTURE_TIMEOUT_SECONDS,
) -> tuple[int, dict[str, Any]]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        # 显式 UTF-8：中文等非 ASCII 必须按 UTF-8 编码发送（PowerShell 那边踩过这个坑）。
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(f"{BASE_URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", "replace")
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(body)
        except json.JSONDecodeError:
            return error.code, {"error": {"code": "http_error", "message": body}}
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise ServiceUnavailable(f"无法连接本地服务 {BASE_URL}：{error}") from error


def error_text(code: int, payload: dict[str, Any]) -> str:
    error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
    detail = {
        "httpStatus": code,
        "code": error.get("code") or "unknown_error",
        "message": error.get("message") or "本地服务返回了错误",
    }
    return json.dumps(detail, ensure_ascii=False, indent=2)


def ok_text(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2)


# --- 工具实现 -----------------------------------------------------------------


def tool_status(service_mode: str) -> str:
    ensure_service(service_mode)
    code, payload = request_json("GET", "/health", timeout=HEALTH_TIMEOUT_SECONDS)
    result: dict[str, Any] = {
        "service": code == 200,
        "serviceUrl": BASE_URL,
        "serviceMode": service_mode,
    }
    try:
        capture_code, capture_payload = request_json("POST", "/capture", {}, CAPTURE_TIMEOUT_SECONDS)
    except ServiceUnavailable as error:
        result["extensionConnected"] = False
        result["detail"] = str(error)
        return ok_text(result)

    if capture_code == 200:
        context = capture_payload.get("context") or {}
        result["extensionConnected"] = True
        result["page"] = {
            "url": context.get("url"),
            "title": context.get("title"),
            "selectedTextLength": len(context.get("selectedText") or ""),
        }
        return ok_text(result)

    error = capture_payload.get("error") if isinstance(capture_payload.get("error"), dict) else {}
    result["extensionConnected"] = error.get("code") == "page_unavailable"
    result["detail"] = {
        "httpStatus": capture_code,
        "code": error.get("code") or "unknown_error",
        "message": error.get("message") or "扩展无法采集当前活动页",
    }
    return ok_text(result)


def tool_capture_page(arguments: dict[str, Any]) -> str:
    include_html = bool(arguments.get("include_html", False))
    max_text_chars = int(arguments.get("max_text_chars") or DEFAULT_MAX_TEXT_CHARS)
    max_html_chars = int(arguments.get("max_html_chars") or DEFAULT_MAX_HTML_CHARS)

    code, payload = request_json("POST", "/capture", {}, CAPTURE_TIMEOUT_SECONDS)
    if code != 200:
        raise ToolError(error_text(code, payload))

    context = payload.get("context") or {}
    visible_text = str(context.get("visibleText") or "")
    result: dict[str, Any] = {
        "url": context.get("url"),
        "title": context.get("title"),
        "selectedText": context.get("selectedText") or "",
        "headings": context.get("headings") or [],
        "interactiveElements": context.get("interactiveElements") or [],
        "visibleText": visible_text[:max_text_chars],
        "visibleTextLength": len(visible_text),
        "visibleTextTruncated": len(visible_text) > max_text_chars,
    }
    if include_html:
        html = str(context.get("html") or "")
        result["html"] = html[:max_html_chars]
        result["htmlLength"] = len(html)
        result["htmlTruncated"] = len(html) > max_html_chars
    else:
        result["htmlOmitted"] = (
            "整页 HTML 默认不返回（数 MB，会挤爆上下文）；需要时传 include_html=true，"
            "并用 max_html_chars 限制长度。"
        )
    return ok_text(result)


def tool_click_element(arguments: dict[str, Any]) -> str:
    selector = str(arguments.get("selector") or "").strip()
    if not selector:
        raise ToolError("selector 不能为空")
    code, payload = request_json("POST", "/click", {"selector": selector}, CLICK_TIMEOUT_SECONDS)
    if code != 200:
        raise ToolError(error_text(code, payload))
    return ok_text(payload.get("result") or {})


def tool_type_text(arguments: dict[str, Any]) -> str:
    text = arguments.get("text")
    if not isinstance(text, str):
        raise ToolError("text 必须是字符串")
    body: dict[str, Any] = {"text": text}
    selector = arguments.get("selector")
    if isinstance(selector, str) and selector.strip():
        body["selector"] = selector.strip()
    if "clear" in arguments:
        body["clear"] = bool(arguments["clear"])
    if "submit" in arguments:
        body["submit"] = bool(arguments["submit"])
    if arguments.get("delay_ms") is not None:
        body["delayMs"] = int(arguments["delay_ms"])

    # 打字耗时随文本长度和逐字延迟线性增长，客户端超时要跟着放大。
    delay_ms = int(body.get("delayMs") or 30)
    timeout = min(TYPE_TIMEOUT_SECONDS, 20 + len(text) * delay_ms / 1000)
    code, payload = request_json("POST", "/type", body, timeout)
    if code != 200:
        raise ToolError(error_text(code, payload))
    return ok_text(payload.get("result") or {})


def tool_execute_script(arguments: dict[str, Any]) -> str:
    code_text = arguments.get("code")
    if not isinstance(code_text, str) or not code_text.strip():
        raise ToolError("code 必须是非空字符串")
    code, payload = request_json("POST", "/execute", {"code": code_text}, EXECUTE_TIMEOUT_SECONDS)
    if code != 200:
        raise ToolError(error_text(code, payload))
    return ok_text(payload.get("result") or {})


class ToolError(RuntimeError):
    """工具执行失败，回给客户端的是 isError=true 的正常结果，而不是 JSON-RPC 错误。"""


TOOLS: list[dict[str, Any]] = [
    {
        "name": "status",
        "description": (
            "检查本地服务是否就绪、Chrome 扩展是否已连上，并返回当前活动页的 URL 与标题。"
            "会按需拉起本地服务。开始任何页面操作前先调它。"
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "_handler": tool_status,
    },
    {
        "name": "capture_page",
        "description": (
            "采集当前活动标签页：标题、URL、选中文本、可见文本、标题结构、可交互元素（含选择器）。"
            "默认不返回整页 HTML，避免上下文过大。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "include_html": {"type": "boolean", "description": "是否返回整页 HTML，默认 false"},
                "max_text_chars": {"type": "integer", "description": f"可见文本截断长度，默认 {DEFAULT_MAX_TEXT_CHARS}"},
                "max_html_chars": {"type": "integer", "description": f"HTML 截断长度，默认 {DEFAULT_MAX_HTML_CHARS}"},
            },
            "additionalProperties": False,
        },
        "_handler": tool_capture_page,
    },
    {
        "name": "click_element",
        "description": (
            "让虚拟光标移动到目标元素并派发真实鼠标点击（CDP）。"
            "selector 支持 CSS 选择器，或 text=完全匹配 / text*=包含匹配 的文本选择器。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"selector": {"type": "string", "description": "CSS 选择器或 text= / text*= 文本选择器"}},
            "required": ["selector"],
            "additionalProperties": False,
        },
        "_handler": tool_click_element,
    },
    {
        "name": "type_text",
        "description": (
            "向目标元素模拟键盘逐字输入（CDP 派发真实按键，受控组件也能收到事件）。"
            "省略 selector 则输入到当前焦点元素；submit=true 会在输入后按一次回车。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "要输入的文本"},
                "selector": {"type": "string", "description": "目标元素；省略则输入到当前焦点元素"},
                "clear": {"type": "boolean", "description": "输入前先清空目标元素，默认 false"},
                "submit": {"type": "boolean", "description": "输入完成后按一次回车，默认 false"},
                "delay_ms": {"type": "integer", "description": "每个字符之间的延迟毫秒数，默认 30"},
            },
            "required": ["text"],
            "additionalProperties": False,
        },
        "_handler": tool_type_text,
    },
    {
        "name": "execute_script",
        "description": "在当前活动页的主世界执行 JavaScript（CDP Runtime.evaluate，会等待 Promise 并尽量按值返回）。",
        "inputSchema": {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "要执行的 JavaScript 表达式或 IIFE"}},
            "required": ["code"],
            "additionalProperties": False,
        },
        "_handler": tool_execute_script,
    },
]

TOOL_BY_NAME = {tool["name"]: tool for tool in TOOLS}


# --- MCP 协议（stdio，换行分隔 JSON-RPC）---------------------------------------


def send(message: dict[str, Any]) -> None:
    _write_line(sys.stdout, json.dumps(message, ensure_ascii=False))


def send_result(request_id: Any, result: dict[str, Any]) -> None:
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def send_error(request_id: Any, code: int, message: str) -> None:
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def public_tools() -> list[dict[str, Any]]:
    return [
        {"name": tool["name"], "description": tool["description"], "inputSchema": tool["inputSchema"]}
        for tool in TOOLS
    ]


def handle_tool_call(params: dict[str, Any], service_mode: str) -> dict[str, Any]:
    name = params.get("name")
    arguments = params.get("arguments") or {}
    tool = TOOL_BY_NAME.get(name) if isinstance(name, str) else None
    if tool is None:
        raise ToolError(f"未知工具：{name}")
    if not isinstance(arguments, dict):
        raise ToolError("arguments 必须是对象")

    handler = tool["_handler"]
    text = handler(arguments) if tool["name"] != "status" else handler(service_mode)
    return {"content": [{"type": "text", "text": text}], "isError": False}


def handle_message(message: dict[str, Any], service_mode: str) -> None:
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") if isinstance(message.get("params"), dict) else {}

    if method == "initialize":
        requested = params.get("protocolVersion")
        send_result(request_id, {
            "protocolVersion": requested if isinstance(requested, str) and requested else PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
        return

    if method in {"notifications/initialized", "notifications/cancelled"}:
        return  # 通知不需要回复

    if method == "ping":
        send_result(request_id, {})
        return

    if method == "tools/list":
        send_result(request_id, {"tools": public_tools()})
        return

    if method == "tools/call":
        try:
            result = handle_tool_call(params, service_mode)
        except ServiceUnavailable as error:
            result = {
                "content": [{"type": "text", "text": json.dumps(
                    {"code": "service_unavailable", "message": str(error)}, ensure_ascii=False, indent=2
                )}],
                "isError": True,
            }
        except (ToolError, ValueError) as error:
            result = {"content": [{"type": "text", "text": str(error)}], "isError": True}
        # send 放在 try 外面：写 stdout 的编码/IO 错误不能被误报成「工具执行失败」。
        send_result(request_id, result)
        return

    if request_id is not None:
        send_error(request_id, -32601, f"Method not found: {method}")


def run_mcp_stdio(service_mode: str = "full") -> None:
    log(f"{SERVER_NAME} MCP server: service_mode={service_mode} service={BASE_URL}")
    if service_mode == "full":
        log("WARNING: 本地服务将以全权限启动（--allow-js-execution --allow-interaction）")

    threading.Thread(target=warm_up_service, args=(service_mode,), daemon=True).start()

    for line in iter_stdin_lines():
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            log(f"ignoring non-JSON line: {line[:200]}")
            continue
        if not isinstance(message, dict):
            continue
        try:
            handle_message(message, service_mode)
        except Exception as error:  # noqa: BLE001 - 任何异常都不能让 stdio 循环退出
            log(f"handler error: {error!r}")
            if message.get("id") is not None:
                send_error(message.get("id"), -32603, f"Internal error: {error}")
