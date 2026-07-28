#!/usr/bin/env python3
"""Minimal local HTTP service for the Page Context Chat extension."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


HOST = "127.0.0.1"
PORT = 8090
MAX_BODY_BYTES = 50 * 1024 * 1024


class ChatHandler(BaseHTTPRequestHandler):
    server_version = "PageContextChat/1.0"

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._send_common_headers()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"error": "Not found"})
            return
        self._send_json(200, {"status": "ok"})

    def do_POST(self) -> None:
        if self.path != "/chat":
            self._send_json(404, {"error": "Not found"})
            return

        try:
            payload = self._read_json()
            message = payload.get("message")
            context = payload.get("context")
            if not isinstance(message, str) or not message.strip():
                raise ValueError("message must be a non-empty string")
            if not isinstance(context, dict):
                raise ValueError("context must be an object")

            reply = build_placeholder_reply(message.strip(), context)
            self._send_json(200, {"reply": reply})
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
        except Exception:
            self._send_json(500, {"error": "Internal server error"})

    def _read_json(self) -> dict[str, Any]:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length") from error
        if content_length <= 0:
            raise ValueError("Request body is required")
        if content_length > MAX_BODY_BYTES:
            raise ValueError("Request body is too large")

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("Request body must be valid UTF-8 JSON") from error
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object")
        return payload

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_common_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")


def build_placeholder_reply(message: str, context: dict[str, Any]) -> str:
    """Replace this function with an LLM, search, or business-service call."""
    title = str(context.get("title") or "未命名页面")
    selected_text = str(context.get("selectedText") or "").strip()
    visible_text = str(context.get("visibleText") or "")
    html = str(context.get("html") or "")
    context_source = f"选中文本 {len(selected_text)} 字符" if selected_text else f"页面正文 {len(visible_text)} 字符"
    print(context_source)
    print(html)
    return (
        f"本地服务已收到你的问题：{message}\n\n"
        f"当前页面：{title}\n"
        f"已接收：{context_source}，完整 HTML {len(html)} 字符\n\n"
        "这是占位响应。请在 server.py 的 build_placeholder_reply() 中接入实际模型或业务逻辑。"
    )


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), ChatHandler)
    print(f"Page Context Chat server listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
