import asyncio
import unittest

from aiohttp.test_utils import TestClient, TestServer

from server.server import create_app


class CaptureApiTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.client = TestClient(TestServer(create_app()))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        await self.client.close()

    async def test_capture_round_trip(self) -> None:
        socket = await self.client.ws_connect("/ws", origin="chrome-extension://test-extension")
        self.assertEqual((await socket.receive_json())["type"], "ready")
        expected_context = {
            "url": "https://example.com/",
            "title": "Example",
            "html": "<!DOCTYPE html><html><body>complete page</body></html>",
        }

        async def emulate_extension() -> None:
            command = await socket.receive_json()
            self.assertEqual(command["type"], "capture_page")
            self.assertEqual(command["target"], "active")
            await socket.send_json({
                "type": "capture_result",
                "requestId": command["requestId"],
                "ok": True,
                "context": expected_context,
            })

        extension_task = asyncio.create_task(emulate_extension())
        response = await self.client.post("/capture")
        payload = await response.json()
        await extension_task
        await socket.close()

        self.assertEqual(response.status, 200)
        self.assertEqual(payload["context"], expected_context)
        self.assertTrue(payload["requestId"])

    async def test_rejects_regular_web_origin(self) -> None:
        response = await self.client.post(
            "/capture",
            headers={"Origin": "https://malicious.example"},
        )
        payload = await response.json()

        self.assertEqual(response.status, 403)
        self.assertEqual(payload["error"]["code"], "origin_forbidden")

    async def test_capture_requires_connected_extension(self) -> None:
        response = await self.client.post("/capture")
        payload = await response.json()

        self.assertEqual(response.status, 503)
        self.assertEqual(payload["error"]["code"], "extension_unavailable")

    async def test_execute_is_disabled_by_default(self) -> None:
        response = await self.client.post("/execute", json={"code": "document.title"})
        payload = await response.json()

        self.assertEqual(response.status, 403)
        self.assertEqual(payload["error"]["code"], "js_execution_disabled")

    async def test_execute_round_trip(self) -> None:
        client = TestClient(TestServer(create_app(allow_js_execution=True)))
        await client.start_server()
        try:
            socket = await client.ws_connect("/ws", origin="chrome-extension://test-extension")
            self.assertEqual((await socket.receive_json())["type"], "ready")

            async def emulate_extension() -> None:
                command = await socket.receive_json()
                self.assertEqual(command["type"], "execute_script")
                self.assertEqual(command["target"], "active")
                self.assertEqual(command["code"], "document.title")
                await socket.send_json({
                    "type": "execute_result",
                    "requestId": command["requestId"],
                    "ok": True,
                    "result": {
                        "type": "string",
                        "subtype": None,
                        "value": "Example",
                        "unserializableValue": None,
                        "description": None,
                    },
                })

            extension_task = asyncio.create_task(emulate_extension())
            response = await client.post("/execute", json={"code": "document.title"})
            payload = await response.json()
            await extension_task
            await socket.close()

            self.assertEqual(response.status, 200)
            self.assertEqual(payload["result"]["value"], "Example")
            self.assertTrue(payload["requestId"])
        finally:
            await client.close()

    async def test_click_is_disabled_by_default(self) -> None:
        response = await self.client.post("/click", json={"selector": "#submit"})
        payload = await response.json()

        self.assertEqual(response.status, 403)
        self.assertEqual(payload["error"]["code"], "interaction_disabled")

    async def test_click_requires_selector(self) -> None:
        client = TestClient(TestServer(create_app(allow_interaction=True)))
        await client.start_server()
        try:
            response = await client.post("/click", json={"selector": "   "})
            payload = await response.json()

            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"]["code"], "invalid_selector")
        finally:
            await client.close()

    async def test_click_round_trip(self) -> None:
        client = TestClient(TestServer(create_app(allow_interaction=True)))
        await client.start_server()
        try:
            socket = await client.ws_connect("/ws", origin="chrome-extension://test-extension")
            self.assertEqual((await socket.receive_json())["type"], "ready")

            async def emulate_extension() -> None:
                command = await socket.receive_json()
                self.assertEqual(command["type"], "click_element")
                self.assertEqual(command["target"], "active")
                self.assertEqual(command["selector"], "#submit")
                await socket.send_json({
                    "type": "click_result",
                    "requestId": command["requestId"],
                    "ok": True,
                    "result": {
                        "selector": "#submit",
                        "x": 120,
                        "y": 240,
                        "tag": "button",
                        "text": "提交",
                    },
                })

            extension_task = asyncio.create_task(emulate_extension())
            response = await client.post("/click", json={"selector": "#submit"})
            payload = await response.json()
            await extension_task
            await socket.close()

            self.assertEqual(response.status, 200)
            self.assertEqual(payload["result"]["x"], 120)
            self.assertEqual(payload["result"]["tag"], "button")
            self.assertTrue(payload["requestId"])
        finally:
            await client.close()

    async def test_click_reports_extension_failure(self) -> None:
        client = TestClient(TestServer(create_app(allow_interaction=True)))
        await client.start_server()
        try:
            socket = await client.ws_connect("/ws", origin="chrome-extension://test-extension")
            self.assertEqual((await socket.receive_json())["type"], "ready")

            async def emulate_extension() -> None:
                command = await socket.receive_json()
                await socket.send_json({
                    "type": "click_result",
                    "requestId": command["requestId"],
                    "ok": False,
                    "error": {"code": "click_failed", "message": "未找到匹配的元素"},
                })

            extension_task = asyncio.create_task(emulate_extension())
            response = await client.post("/click", json={"selector": "#missing"})
            payload = await response.json()
            await extension_task
            await socket.close()

            self.assertEqual(response.status, 422)
            self.assertEqual(payload["error"]["code"], "click_failed")
        finally:
            await client.close()


    async def test_type_is_disabled_by_default(self) -> None:
        response = await self.client.post("/type", json={"text": "hello", "selector": "#q"})
        payload = await response.json()

        self.assertEqual(response.status, 403)
        self.assertEqual(payload["error"]["code"], "interaction_disabled")

    async def test_type_requires_text_unless_clearing(self) -> None:
        client = TestClient(TestServer(create_app(allow_interaction=True)))
        await client.start_server()
        try:
            response = await client.post("/type", json={"text": "", "selector": "#q"})
            payload = await response.json()
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"]["code"], "invalid_text")

            response = await client.post("/type", json={"text": "hello", "selector": "   "})
            payload = await response.json()
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"]["code"], "invalid_selector")

            # 只清空、不输入文本是合法请求：校验通过后会因为没有扩展连接而返回 503。
            response = await client.post("/type", json={"text": "", "clear": True})
            payload = await response.json()
            self.assertEqual(response.status, 503)
            self.assertEqual(payload["error"]["code"], "extension_unavailable")
        finally:
            await client.close()

    async def test_type_rejects_out_of_range_delay(self) -> None:
        client = TestClient(TestServer(create_app(allow_interaction=True)))
        await client.start_server()
        try:
            response = await client.post("/type", json={"text": "hi", "delayMs": -1})
            payload = await response.json()
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"]["code"], "invalid_delay")

            response = await client.post("/type", json={"text": "hi", "delayMs": "fast"})
            payload = await response.json()
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"]["code"], "invalid_delay")

            response = await client.post("/type", json={"text": "x" * 100, "delayMs": 1000})
            payload = await response.json()
            self.assertEqual(response.status, 400)
            self.assertEqual(payload["error"]["code"], "typing_too_slow")
        finally:
            await client.close()

    async def test_type_round_trip(self) -> None:
        client = TestClient(TestServer(create_app(allow_interaction=True)))
        await client.start_server()
        try:
            socket = await client.ws_connect("/ws", origin="chrome-extension://test-extension")
            self.assertEqual((await socket.receive_json())["type"], "ready")

            async def emulate_extension() -> None:
                command = await socket.receive_json()
                self.assertEqual(command["type"], "type_text")
                self.assertEqual(command["target"], "active")
                self.assertEqual(command["selector"], "#sb_form_q")
                self.assertEqual(command["text"], "gitee")
                self.assertEqual(command["delayMs"], 50)
                self.assertTrue(command["clear"])
                self.assertTrue(command["submit"])
                await socket.send_json({
                    "type": "type_result",
                    "requestId": command["requestId"],
                    "ok": True,
                    "result": {
                        "selector": "#sb_form_q",
                        "text": "gitee",
                        "length": 5,
                        "delayMs": 50,
                        "cleared": True,
                        "submitted": True,
                        "tag": "input",
                        "editable": True,
                    },
                })

            extension_task = asyncio.create_task(emulate_extension())
            response = await client.post("/type", json={
                "selector": "#sb_form_q",
                "text": "gitee",
                "clear": True,
                "submit": True,
                "delayMs": 50,
            })
            payload = await response.json()
            await extension_task
            await socket.close()

            self.assertEqual(response.status, 200)
            self.assertEqual(payload["result"]["length"], 5)
            self.assertTrue(payload["result"]["submitted"])
            self.assertTrue(payload["requestId"])
        finally:
            await client.close()

    async def test_type_defaults_delay_and_can_target_current_focus(self) -> None:
        client = TestClient(TestServer(create_app(allow_interaction=True)))
        await client.start_server()
        try:
            socket = await client.ws_connect("/ws", origin="chrome-extension://test-extension")
            self.assertEqual((await socket.receive_json())["type"], "ready")

            async def emulate_extension() -> None:
                command = await socket.receive_json()
                self.assertEqual(command["type"], "type_text")
                self.assertEqual(command["delayMs"], 30)
                self.assertNotIn("selector", command)
                await socket.send_json({
                    "type": "type_result",
                    "requestId": command["requestId"],
                    "ok": True,
                    "result": {"text": "hi", "length": 2, "editable": None},
                })

            extension_task = asyncio.create_task(emulate_extension())
            response = await client.post("/type", json={"text": "hi"})
            payload = await response.json()
            await extension_task
            await socket.close()

            self.assertEqual(response.status, 200)
            self.assertEqual(payload["result"]["length"], 2)
        finally:
            await client.close()

    async def test_type_reports_extension_failure(self) -> None:
        client = TestClient(TestServer(create_app(allow_interaction=True)))
        await client.start_server()
        try:
            socket = await client.ws_connect("/ws", origin="chrome-extension://test-extension")
            self.assertEqual((await socket.receive_json())["type"], "ready")

            async def emulate_extension() -> None:
                command = await socket.receive_json()
                await socket.send_json({
                    "type": "type_result",
                    "requestId": command["requestId"],
                    "ok": False,
                    "error": {"code": "type_failed", "message": "目标元素不是可输入的元素"},
                })

            extension_task = asyncio.create_task(emulate_extension())
            response = await client.post("/type", json={"text": "hi", "selector": "#title"})
            payload = await response.json()
            await extension_task
            await socket.close()

            self.assertEqual(response.status, 422)
            self.assertEqual(payload["error"]["code"], "type_failed")
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
