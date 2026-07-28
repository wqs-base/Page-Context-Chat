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


if __name__ == "__main__":
    unittest.main()
