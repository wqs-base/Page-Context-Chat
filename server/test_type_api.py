#!/usr/bin/env python3
"""Call the simulated-typing API and validate its response contract."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_ENDPOINT = "http://127.0.0.1:8090/type"
DEFAULT_SELECTOR = "input"
DEFAULT_TEXT = "page context chat"


def configure_output_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="测试 Chrome 扩展模拟输入接口")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="输入接口地址")
    parser.add_argument(
        "--selector",
        default=DEFAULT_SELECTOR,
        help="目标输入元素的 CSS 选择器；传入空字符串表示输入到当前焦点元素",
    )
    parser.add_argument("--text", default=DEFAULT_TEXT, help="要输入的文本")
    parser.add_argument("--delay-ms", type=int, default=30, help="每个字符之间的延迟毫秒数")
    parser.add_argument("--clear", action="store_true", help="输入前先清空目标元素")
    parser.add_argument("--submit", action="store_true", help="输入完成后按一次回车")
    parser.add_argument("--timeout", type=float, default=30, help="HTTP 请求超时秒数")
    return parser.parse_args()


def request_typing(
    endpoint: str,
    selector: str,
    text: str,
    delay_ms: int,
    clear: bool,
    submit: bool,
    timeout: float,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "text": text,
        "delayMs": delay_ms,
        "clear": clear,
        "submit": submit,
    }
    if selector.strip():
        body["selector"] = selector
    request = Request(
        endpoint,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    with urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
        if response.status != 200:
            raise RuntimeError(f"服务返回 HTTP {response.status}: {payload}")
    if not isinstance(payload, dict):
        raise ValueError("响应根节点不是 JSON 对象")
    return payload


def validate_response(payload: dict[str, Any], text: str) -> tuple[str, dict[str, Any]]:
    request_id = payload.get("requestId")
    result = payload.get("result")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("响应缺少非空 requestId")
    if not isinstance(result, dict):
        raise ValueError("响应缺少 result 对象")
    if result.get("length") != len(text):
        raise ValueError(f"result.length 应为 {len(text)}，实际为 {result.get('length')!r}")
    return request_id, result


def main() -> int:
    configure_output_encoding()
    args = parse_args()
    try:
        payload = request_typing(
            args.endpoint,
            args.selector,
            args.text,
            args.delay_ms,
            args.clear,
            args.submit,
            args.timeout,
        )
        request_id, result = validate_response(payload, args.text)
    except HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        print(f"FAIL: HTTP {error.code}: {details}", file=sys.stderr)
        return 2
    except URLError as error:
        print(f"FAIL: 无法连接输入服务: {error.reason}", file=sys.stderr)
        return 3
    except TimeoutError:
        print("FAIL: 等待输入结果超时", file=sys.stderr)
        return 4
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, RuntimeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 5

    print(json.dumps({
        "status": "PASS",
        "requestId": request_id,
        "result": result,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
