#!/usr/bin/env python3
"""Call the local capture API and validate its response contract."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


DEFAULT_ENDPOINT = "http://127.0.0.1:8090/capture"


def configure_output_encoding() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="测试 Chrome 扩展页面采集接口")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="采集接口地址")
    parser.add_argument("--timeout", type=float, default=20, help="请求超时秒数")
    parser.add_argument("--preview", type=int, default=200, help="HTML 预览字符数")
    parser.add_argument("--output", type=Path, help="将完整 JSON 响应保存到指定文件")
    return parser.parse_args()


def request_capture(endpoint: str, timeout: float) -> dict[str, Any]:
    request = Request(endpoint, data=b"", method="POST")
    with urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8")
        if response.status != 200:
            raise RuntimeError(f"服务返回 HTTP {response.status}: {body}")
    payload = json.loads(body)
    if not isinstance(payload, dict):
        raise ValueError("响应根节点不是 JSON 对象")
    return payload


def validate_response(payload: dict[str, Any]) -> tuple[str, dict[str, Any], str]:
    request_id = payload.get("requestId")
    context = payload.get("context")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("响应缺少非空 requestId")
    if not isinstance(context, dict):
        raise ValueError("响应缺少 context 对象")

    html = context.get("html")
    if not isinstance(html, str) or not html.strip():
        raise ValueError("context.html 不是非空字符串")
    if "<html" not in html.lower():
        raise ValueError("context.html 未包含 <html> 根元素")
    return request_id, context, html


def main() -> int:
    configure_output_encoding()
    args = parse_args()
    try:
        payload = request_capture(args.endpoint, args.timeout)
        request_id, context, html = validate_response(payload)
    except HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        print(f"FAIL: HTTP {error.code}: {details}", file=sys.stderr)
        return 2
    except URLError as error:
        print(f"FAIL: 无法连接采集服务: {error.reason}", file=sys.stderr)
        return 3
    except TimeoutError:
        print("FAIL: 等待采集结果超时", file=sys.stderr)
        return 4
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError, RuntimeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        return 5

    if args.output:
        args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    preview_length = max(args.preview, 0)
    summary = {
        "status": "PASS",
        "requestId": request_id,
        "url": context.get("url", ""),
        "title": context.get("title", ""),
        "htmlLength": len(html),
        "visibleTextLength": len(str(context.get("visibleText") or "")),
        "htmlPreview": html[:preview_length],
        "output": str(args.output.resolve()) if args.output else None,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
