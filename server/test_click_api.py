#!/usr/bin/env python3
"""Call the virtual-cursor click API and validate its response contract."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_ENDPOINT = "http://127.0.0.1:8090/click"
DEFAULT_SELECTOR = "a[href]"


def configure_output_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="测试 Chrome 扩展虚拟光标点击接口")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="点击接口地址")
    parser.add_argument("--selector", default=DEFAULT_SELECTOR, help="要点击元素的 CSS 选择器")
    parser.add_argument("--timeout", type=float, default=20, help="HTTP 请求超时秒数")
    return parser.parse_args()


def request_click(endpoint: str, selector: str, timeout: float) -> dict[str, Any]:
    body = json.dumps({"selector": selector}, ensure_ascii=False).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
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


def validate_response(payload: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    request_id = payload.get("requestId")
    result = payload.get("result")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("响应缺少非空 requestId")
    if not isinstance(result, dict):
        raise ValueError("响应缺少 result 对象")
    if not isinstance(result.get("x"), (int, float)) or not isinstance(result.get("y"), (int, float)):
        raise ValueError(f"result.x / result.y 应为数值，实际为 {result.get('x')!r} / {result.get('y')!r}")
    return request_id, result


def main() -> int:
    configure_output_encoding()
    args = parse_args()
    try:
        payload = request_click(args.endpoint, args.selector, args.timeout)
        request_id, result = validate_response(payload)
    except HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        print(f"FAIL: HTTP {error.code}: {details}", file=sys.stderr)
        return 2
    except URLError as error:
        print(f"FAIL: 无法连接点击服务: {error.reason}", file=sys.stderr)
        return 3
    except TimeoutError:
        print("FAIL: 等待点击结果超时", file=sys.stderr)
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
