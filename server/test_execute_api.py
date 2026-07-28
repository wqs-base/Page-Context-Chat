#!/usr/bin/env python3
"""Call the JavaScript execution API and show an alert in the active tab."""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_ENDPOINT = "http://127.0.0.1:8090/execute"
EXPECTED_VALUE = "alert scheduled"


def configure_output_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="测试浏览器 JavaScript 执行接口并显示 alert")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="执行接口地址")
    parser.add_argument("--timeout", type=float, default=20, help="HTTP 请求超时秒数")
    parser.add_argument("--delay", type=int, default=300, help="弹窗延迟毫秒数")
    parser.add_argument("--message", default="JavaScript execution API test passed", help="弹窗文本")
    return parser.parse_args()


def request_execution(endpoint: str, code: str, timeout: float) -> dict[str, Any]:
    body = json.dumps({"code": code}, ensure_ascii=False).encode("utf-8")
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
    if result.get("type") != "string":
        raise ValueError(f"result.type 应为 string，实际为 {result.get('type')!r}")
    if result.get("value") != EXPECTED_VALUE:
        raise ValueError(f"result.value 应为 {EXPECTED_VALUE!r}，实际为 {result.get('value')!r}")
    return request_id, result


def main() -> int:
    configure_output_encoding()
    args = parse_args()
    delay = max(args.delay, 0)
    message = json.dumps(args.message, ensure_ascii=False)
    code = f"setTimeout(() => window.alert({message}), {delay}); {json.dumps(EXPECTED_VALUE)}"

    try:
        payload = request_execution(args.endpoint, code, args.timeout)
        request_id, result = validate_response(payload)
    except HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        print(f"FAIL: HTTP {error.code}: {details}", file=sys.stderr)
        return 2
    except URLError as error:
        print(f"FAIL: 无法连接执行服务: {error.reason}", file=sys.stderr)
        return 3
    except TimeoutError:
        print("FAIL: 等待 JavaScript 执行结果超时", file=sys.stderr)
        return 4
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, RuntimeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 5

    print(json.dumps({
        "status": "PASS",
        "requestId": request_id,
        "result": result,
        "alertMessage": args.message,
        "alertDelayMs": delay,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
