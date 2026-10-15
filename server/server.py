#!/usr/bin/env python3
"""Local HTTP and WebSocket service for the Page Context Chat extension."""

from __future__ import annotations

import asyncio
import argparse
import json
import uuid
from typing import Any

from aiohttp import WSMsgType, web


HOST = "127.0.0.1"
PORT = 8090
MAX_BODY_BYTES = 50 * 1024 * 1024
CAPTURE_TIMEOUT_SECONDS = 15
EXECUTE_TIMEOUT_SECONDS = 15
CLICK_TIMEOUT_SECONDS = 15
TYPE_TIMEOUT_SECONDS = 15
MAX_TYPE_TIMEOUT_SECONDS = 90
MAX_SCRIPT_BYTES = 256 * 1024
MAX_TYPE_CHARS = 1000
DEFAULT_TYPE_DELAY_MS = 30
MAX_TYPE_DELAY_MS = 1000
MAX_TYPE_DURATION_MS = 60 * 1000


def json_error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": message}}, status=status)


class CaptureBroker:
    def __init__(self) -> None:
        self.connections: list[web.WebSocketResponse] = []
        self.pending: dict[str, tuple[asyncio.Future[dict[str, Any]], web.WebSocketResponse]] = {}

    def register(self, socket: web.WebSocketResponse) -> None:
        self.connections.append(socket)

    def unregister(self, socket: web.WebSocketResponse) -> None:
        if socket in self.connections:
            self.connections.remove(socket)
        for future, target in self.pending.values():
            if target is socket and not future.done():
                future.set_result({
                    "ok": False,
                    "error": {"code": "extension_disconnected", "message": "扩展连接已断开"},
                })

    async def request_capture(self) -> tuple[str, dict[str, Any]]:
        return await self._request("capture_page", {}, CAPTURE_TIMEOUT_SECONDS)

    async def request_execution(self, code: str) -> tuple[str, dict[str, Any]]:
        return await self._request("execute_script", {"code": code}, EXECUTE_TIMEOUT_SECONDS)

    async def request_click(self, selector: str) -> tuple[str, dict[str, Any]]:
        return await self._request("click_element", {"selector": selector}, CLICK_TIMEOUT_SECONDS)

    async def request_typing(self, command: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        # 逐字输入的耗时随文本长度和每字延迟线性增长，超时要跟着放大。
        duration_ms = len(command["text"]) * int(command["delayMs"])
        timeout = min(TYPE_TIMEOUT_SECONDS + duration_ms / 1000, MAX_TYPE_TIMEOUT_SECONDS)
        return await self._request("type_text", command, timeout)

    async def _request(
        self,
        command_type: str,
        command: dict[str, Any],
        timeout: float,
    ) -> tuple[str, dict[str, Any]]:
        socket = next((item for item in reversed(self.connections) if not item.closed), None)
        if socket is None:
            raise ConnectionError("没有已连接的 Chrome 扩展")

        request_id = uuid.uuid4().hex
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self.pending[request_id] = (future, socket)
        try:
            try:
                await socket.send_json({
                    "type": command_type,
                    "requestId": request_id,
                    "target": "active",
                    **command,
                })
            except (ConnectionError, RuntimeError) as error:
                self.unregister(socket)
                raise ConnectionError("Chrome 扩展连接已断开") from error
            result = await asyncio.wait_for(future, timeout=timeout)
            return request_id, result
        finally:
            self.pending.pop(request_id, None)

    def resolve(self, message: dict[str, Any]) -> None:
        request_id = message.get("requestId")
        item = self.pending.get(request_id) if isinstance(request_id, str) else None
        if item is not None and not item[0].done():
            item[0].set_result(message)


BROKER_KEY = web.AppKey("capture_broker", CaptureBroker)
JS_EXECUTION_KEY = web.AppKey("allow_js_execution", bool)
INTERACTION_KEY = web.AppKey("allow_interaction", bool)


@web.middleware
async def origin_guard(request: web.Request, handler: Any) -> web.StreamResponse:
    origin = request.headers.get("Origin")
    if origin and not origin.startswith("chrome-extension://"):
        return json_error(403, "origin_forbidden", "只允许本地程序或 Chrome 扩展访问")
    if request.method == "OPTIONS":
        return web.Response(status=204, headers={
            "Access-Control-Allow-Origin": origin or "null",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Vary": "Origin",
        })

    response = await handler(request)
    if origin and not isinstance(response, web.WebSocketResponse):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    return response


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


async def chat(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return json_error(400, "invalid_json", "请求体必须是有效的 UTF-8 JSON")
    if not isinstance(payload, dict):
        return json_error(400, "invalid_body", "请求体必须是 JSON 对象")

    message = payload.get("message")
    context = payload.get("context")
    if not isinstance(message, str) or not message.strip():
        return json_error(400, "invalid_message", "message 必须是非空字符串")
    if not isinstance(context, dict):
        return json_error(400, "invalid_context", "context 必须是对象")

    reply = build_placeholder_reply(message.strip(), context)
    return web.json_response({"reply": reply})


async def capture(request: web.Request) -> web.Response:
    broker = request.app[BROKER_KEY]
    try:
        request_id, result = await broker.request_capture()
    except ConnectionError as error:
        return json_error(503, "extension_unavailable", str(error))
    except TimeoutError:
        return json_error(504, "capture_timeout", "等待扩展采集页面超时")

    if not result.get("ok"):
        error = result.get("error") if isinstance(result.get("error"), dict) else {}
        return json_error(
            422,
            str(error.get("code") or "capture_failed"),
            str(error.get("message") or "扩展无法采集当前页面"),
        )
    context = result.get("context")
    if not isinstance(context, dict):
        return json_error(502, "invalid_extension_response", "扩展响应缺少 context 对象")
    return web.json_response({"requestId": request_id, "context": context})


async def execute_script(request: web.Request) -> web.Response:
    if not request.app[JS_EXECUTION_KEY]:
        return json_error(403, "js_execution_disabled", "服务启动时未启用 JavaScript 执行")
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return json_error(400, "invalid_json", "请求体必须是有效的 UTF-8 JSON")
    if not isinstance(payload, dict):
        return json_error(400, "invalid_body", "请求体必须是 JSON 对象")

    code = payload.get("code")
    if not isinstance(code, str) or not code.strip():
        return json_error(400, "invalid_code", "code 必须是非空字符串")
    if len(code.encode("utf-8")) > MAX_SCRIPT_BYTES:
        return json_error(413, "code_too_large", f"code 不能超过 {MAX_SCRIPT_BYTES} 字节")

    broker = request.app[BROKER_KEY]
    try:
        request_id, result = await broker.request_execution(code)
    except ConnectionError as error:
        return json_error(503, "extension_unavailable", str(error))
    except TimeoutError:
        return json_error(504, "execution_timeout", "等待扩展执行 JavaScript 超时")

    if not result.get("ok"):
        error = result.get("error") if isinstance(result.get("error"), dict) else {}
        return json_error(
            422,
            str(error.get("code") or "execution_failed"),
            str(error.get("message") or "扩展无法执行 JavaScript"),
        )
    execution_result = result.get("result")
    if not isinstance(execution_result, dict):
        return json_error(502, "invalid_extension_response", "扩展响应缺少 result 对象")
    return web.json_response({"requestId": request_id, "result": execution_result})


async def click_element(request: web.Request) -> web.Response:
    if not request.app[INTERACTION_KEY]:
        return json_error(403, "interaction_disabled", "服务启动时未启用页面交互控制")
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return json_error(400, "invalid_json", "请求体必须是有效的 UTF-8 JSON")
    if not isinstance(payload, dict):
        return json_error(400, "invalid_body", "请求体必须是 JSON 对象")

    selector = payload.get("selector")
    if not isinstance(selector, str) or not selector.strip():
        return json_error(400, "invalid_selector", "selector 必须是非空字符串")

    broker = request.app[BROKER_KEY]
    try:
        request_id, result = await broker.request_click(selector.strip())
    except ConnectionError as error:
        return json_error(503, "extension_unavailable", str(error))
    except TimeoutError:
        return json_error(504, "click_timeout", "等待扩展完成点击超时")

    if not result.get("ok"):
        error = result.get("error") if isinstance(result.get("error"), dict) else {}
        return json_error(
            422,
            str(error.get("code") or "click_failed"),
            str(error.get("message") or "扩展无法点击目标元素"),
        )
    click_result = result.get("result")
    if not isinstance(click_result, dict):
        return json_error(502, "invalid_extension_response", "扩展响应缺少 result 对象")
    return web.json_response({"requestId": request_id, "result": click_result})


async def type_text(request: web.Request) -> web.Response:
    if not request.app[INTERACTION_KEY]:
        return json_error(403, "interaction_disabled", "服务启动时未启用页面交互控制")
    try:
        payload = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return json_error(400, "invalid_json", "请求体必须是有效的 UTF-8 JSON")
    if not isinstance(payload, dict):
        return json_error(400, "invalid_body", "请求体必须是 JSON 对象")

    clear = payload.get("clear", False)
    submit = payload.get("submit", False)
    if not isinstance(clear, bool) or not isinstance(submit, bool):
        return json_error(400, "invalid_flags", "clear 与 submit 必须是布尔值")

    text = payload.get("text")
    if not isinstance(text, str):
        return json_error(400, "invalid_text", "text 必须是字符串")
    if not text and not clear:
        return json_error(400, "invalid_text", "text 不能为空字符串（除非同时把 clear 设为 true）")
    if len(text) > MAX_TYPE_CHARS:
        return json_error(413, "text_too_long", f"text 不能超过 {MAX_TYPE_CHARS} 个字符")

    selector = payload.get("selector")
    if selector is not None and (not isinstance(selector, str) or not selector.strip()):
        return json_error(400, "invalid_selector", "selector 必须是非空字符串，或省略以输入到当前焦点元素")

    delay_ms = payload.get("delayMs", DEFAULT_TYPE_DELAY_MS)
    if isinstance(delay_ms, bool) or not isinstance(delay_ms, (int, float)):
        return json_error(400, "invalid_delay", "delayMs 必须是数字")
    delay_ms = int(delay_ms)
    if not 0 <= delay_ms <= MAX_TYPE_DELAY_MS:
        return json_error(400, "invalid_delay", f"delayMs 必须在 0 到 {MAX_TYPE_DELAY_MS} 之间")
    if len(text) * delay_ms > MAX_TYPE_DURATION_MS:
        return json_error(
            400,
            "typing_too_slow",
            f"text 与 delayMs 组合的预计输入时间不能超过 {MAX_TYPE_DURATION_MS // 1000} 秒",
        )

    command: dict[str, Any] = {
        "text": text,
        "delayMs": delay_ms,
        "clear": clear,
        "submit": submit,
    }
    if isinstance(selector, str):
        command["selector"] = selector.strip()

    broker = request.app[BROKER_KEY]
    try:
        request_id, result = await broker.request_typing(command)
    except ConnectionError as error:
        return json_error(503, "extension_unavailable", str(error))
    except TimeoutError:
        return json_error(504, "type_timeout", "等待扩展完成输入超时")

    if not result.get("ok"):
        error = result.get("error") if isinstance(result.get("error"), dict) else {}
        return json_error(
            422,
            str(error.get("code") or "type_failed"),
            str(error.get("message") or "扩展无法在目标元素中输入文本"),
        )
    typing_result = result.get("result")
    if not isinstance(typing_result, dict):
        return json_error(502, "invalid_extension_response", "扩展响应缺少 result 对象")
    return web.json_response({"requestId": request_id, "result": typing_result})


async def extension_socket(request: web.Request) -> web.WebSocketResponse:
    socket = web.WebSocketResponse(heartbeat=25, max_msg_size=MAX_BODY_BYTES)
    await socket.prepare(request)
    broker = request.app[BROKER_KEY]
    broker.register(socket)
    await socket.send_json({"type": "ready"})

    try:
        async for message in socket:
            if message.type != WSMsgType.TEXT:
                continue
            try:
                payload = json.loads(message.data)
            except json.JSONDecodeError:
                await socket.send_json({"type": "error", "message": "消息必须是有效 JSON"})
                continue
            if not isinstance(payload, dict):
                continue
            if payload.get("type") in {"capture_result", "execute_result", "click_result", "type_result"}:
                broker.resolve(payload)
            elif payload.get("type") == "ping":
                await socket.send_json({"type": "pong"})
    finally:
        broker.unregister(socket)
    return socket


async def close_connections(app: web.Application) -> None:
    broker = app[BROKER_KEY]
    await asyncio.gather(
        *(socket.close(code=1001, message=b"server shutdown") for socket in broker.connections),
        return_exceptions=True,
    )


def build_placeholder_reply(message: str, context: dict[str, Any]) -> str:
    """Replace this function with an LLM, search, or business-service call."""
    title = str(context.get("title") or "未命名页面")
    selected_text = str(context.get("selectedText") or "").strip()
    visible_text = str(context.get("visibleText") or "")
    html = str(context.get("html") or "")
    context_source = f"选中文本 {len(selected_text)} 字符" if selected_text else f"页面正文 {len(visible_text)} 字符"
    print(context_source)
    print(context)
    return (
        f"本地服务已收到你的问题：{message}\n\n"
        f"当前页面：{title}\n"
        f"已接收：{context_source}，完整 HTML {len(html)} 字符\n\n"
        "这是占位响应。请在 server.py 的 build_placeholder_reply() 中接入实际模型或业务逻辑。"
    )


def create_app(*, allow_js_execution: bool = False, allow_interaction: bool = False) -> web.Application:
    app = web.Application(middlewares=[origin_guard], client_max_size=MAX_BODY_BYTES)
    app[BROKER_KEY] = CaptureBroker()
    app[JS_EXECUTION_KEY] = allow_js_execution
    app[INTERACTION_KEY] = allow_interaction
    app.add_routes([
        web.get("/health", health),
        web.post("/chat", chat),
        web.post("/capture", capture),
        web.post("/execute", execute_script),
        web.post("/click", click_element),
        web.post("/type", type_text),
        web.get("/ws", extension_socket),
        web.options("/{path:.*}", health),
    ])
    app.on_shutdown.append(close_connections)
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Page Context Chat local service")
    parser.add_argument(
        "--allow-js-execution",
        action="store_true",
        help="enable the high-risk POST /execute endpoint",
    )
    parser.add_argument(
        "--allow-interaction",
        action="store_true",
        help="enable the high-risk POST /click and POST /type endpoints",
    )
    args = parser.parse_args()
    print(f"Page Context Chat server listening on http://{HOST}:{PORT}")
    if args.allow_js_execution:
        print("WARNING: arbitrary JavaScript execution is enabled for the active browser tab")
    if args.allow_interaction:
        print("WARNING: virtual-cursor clicking and simulated typing are enabled for the active browser tab")
    web.run_app(
        create_app(
            allow_js_execution=args.allow_js_execution,
            allow_interaction=args.allow_interaction,
        ),
        host=HOST,
        port=PORT,
        print=None,
    )


if __name__ == "__main__":
    main()
