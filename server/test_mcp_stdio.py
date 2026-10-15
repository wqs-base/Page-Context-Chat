"""MCP stdio 前端的测试。

重点盯两件真实踩过的事：

1. Windows 中文环境下 `sys.stdin.encoding` 是 GBK，如果不按字节读，UTF-8 的协议帧会被
   解成乱码（`通道测试` → `鎫求仅婴寭畿`），并且一路传到页面里。
2. stdout 是 MCP 的协议通道，任何非协议输出都会打乱 JSON-RPC 流。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest

from server.mcp_stdio import (
    SERVICE_MODE_FLAGS,
    build_service_command,
    handle_message,
)

MCP_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.py")


class ServiceCommandTest(unittest.TestCase):
    def test_service_mode_flags(self) -> None:
        self.assertEqual(SERVICE_MODE_FLAGS["plain"], [])
        self.assertEqual(SERVICE_MODE_FLAGS["interaction"], ["--allow-interaction"])
        self.assertEqual(SERVICE_MODE_FLAGS["js"], ["--allow-js-execution"])
        self.assertEqual(
            sorted(SERVICE_MODE_FLAGS["full"]),
            sorted(["--allow-js-execution", "--allow-interaction"]),
        )

    def test_command_keeps_mcp_flag_out_of_the_service(self) -> None:
        # 被拉起的服务不能带 --mcp，否则会递归地又变成 MCP 前端。
        for mode in SERVICE_MODE_FLAGS:
            command = build_service_command(mode)
            self.assertNotIn("--mcp", command)
            self.assertTrue(command)


class MessageHandlingTest(unittest.TestCase):
    def _collect(self, message: dict) -> dict:
        sent: list[dict] = []
        import server.mcp_stdio as module

        original = module.send
        module.send = sent.append  # type: ignore[assignment]
        try:
            handle_message(message, "full")
        finally:
            module.send = original  # type: ignore[assignment]
        self.assertEqual(len(sent), 1)
        return sent[0]

    def test_initialize_echoes_client_protocol_version(self) -> None:
        response = self._collect({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-11-25"},
        })
        self.assertEqual(response["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual(response["result"]["serverInfo"]["name"], "page-context-chat")

    def test_notifications_get_no_reply(self) -> None:
        import server.mcp_stdio as module

        sent: list[dict] = []
        original = module.send
        module.send = sent.append  # type: ignore[assignment]
        try:
            handle_message({"jsonrpc": "2.0", "method": "notifications/initialized"}, "full")
        finally:
            module.send = original  # type: ignore[assignment]
        self.assertEqual(sent, [])

    def test_unknown_method_returns_jsonrpc_error(self) -> None:
        response = self._collect({"jsonrpc": "2.0", "id": 7, "method": "resources/list"})
        self.assertEqual(response["error"]["code"], -32601)

    def test_tool_validation_error_becomes_is_error_result(self) -> None:
        response = self._collect({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "tools/call",
            "params": {"name": "click_element", "arguments": {"selector": "   "}},
        })
        self.assertTrue(response["result"]["isError"])
        self.assertEqual(response["result"]["content"][0]["text"], "selector 不能为空")


class StdioProtocolTest(unittest.TestCase):
    """真起一个子进程，验证换行分隔 JSON-RPC + UTF-8 解码。"""

    def _run(self, lines: list[dict]) -> list[dict]:
        payload = "\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n"
        env = os.environ.copy()
        # 模拟中文 Windows 的默认 IO 编码：旧实现会被解成乱码，按字节读的实现在这里必须仍然正确。
        env["PYTHONIOENCODING"] = "gbk"
        completed = subprocess.run(
            [sys.executable, MCP_SCRIPT, "--mcp"],
            input=payload.encode("utf-8"),
            capture_output=True,
            cwd=os.path.dirname(MCP_SCRIPT),
            env=env,
            timeout=120,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        return [
            json.loads(line)
            for line in completed.stdout.decode("utf-8").splitlines()
            if line.strip()
        ]

    def test_handshake_and_tool_list(self) -> None:
        responses = self._run([
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-11-25"}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ])
        self.assertEqual(len(responses), 2)  # 通知不回复
        self.assertEqual(responses[0]["id"], 1)
        names = [tool["name"] for tool in responses[1]["result"]["tools"]]
        self.assertEqual(
            names,
            ["status", "capture_page", "click_element", "type_text", "execute_script"],
        )

    def test_utf8_arguments_survive_stdio(self) -> None:
        responses = self._run([
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "通道测试", "arguments": {}}},
        ])
        self.assertTrue(responses[0]["result"]["isError"])
        # 乱码（GBK 误解码）会让这里变成「未知工具：鎫求仅婴寭畿」。
        self.assertEqual(responses[0]["result"]["content"][0]["text"], "未知工具：通道测试")


if __name__ == "__main__":
    unittest.main()
