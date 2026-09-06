"""Exercise the built JSON ABI without credentials or setTdlibParameters."""
import base64
import ctypes
import json
from pathlib import Path
import time
import unittest


class TDLibProbe(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        library = Path(__file__).parent / ".tools/tdlib-build/libtdjson.dylib"
        cls.td = ctypes.CDLL(str(library))
        cls.td.td_execute.argtypes = [ctypes.c_char_p]
        cls.td.td_execute.restype = ctypes.c_char_p
        cls.td.td_create_client_id.argtypes = []
        cls.td.td_create_client_id.restype = ctypes.c_int
        cls.td.td_send.argtypes = [ctypes.c_int, ctypes.c_char_p]
        cls.td.td_send.restype = None
        cls.td.td_receive.argtypes = [ctypes.c_double]
        cls.td.td_receive.restype = ctypes.c_char_p
        cls.td.td_execute(b'{"@type":"setLogVerbosityLevel","new_verbosity_level":0}')

    def execute(self, request):
        result = self.td.td_execute(json.dumps(request).encode())
        self.assertIsNotNone(result)
        return json.loads(result)

    def test_html_entities(self):
        result = self.execute({"@type": "parseTextEntities", "text": "<b>test</b>",
                               "parse_mode": {"@type": "textParseModeHTML"}})
        self.assertEqual(result["@type"], "formattedText")
        self.assertEqual(result["text"], "test")
        self.assertEqual(result["entities"][0]["type"]["@type"], "textEntityTypeBold")
        self.assertEqual(result["entities"][0]["length"], 4)

    def test_invalid_html_rejected(self):
        result = self.execute({"@type": "parseTextEntities", "text": "<b>test",
                               "parse_mode": {"@type": "textParseModeHTML"}})
        self.assertEqual(result["@type"], "error")

    def test_async_correlation_bytes_and_close(self):
        client = self.td.td_create_client_id()

        def send(request):
            self.td.td_send(client, json.dumps(request).encode())

        def receive_until(predicate):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                raw = self.td.td_receive(0.1)
                if raw:
                    event = json.loads(raw)
                    self.assertEqual(event.get("@client_id"), client)
                    if predicate(event):
                        return event
            self.fail("TDLib response deadline exceeded")

        try:
            send({"@type": "getOption", "name": "version", "@extra": "version"})
            version = receive_until(lambda e: e.get("@extra") == "version")
            self.assertEqual(version["@type"], "optionValueString")
            self.assertEqual(version["value"], "1.8.67")
            payload = base64.b64encode(bytes([0, 255, 1])).decode()
            send({"@type": "testCallBytes", "x": payload, "@extra": "bytes"})
            result = receive_until(lambda e: e.get("@extra") == "bytes")
            self.assertEqual(result["@type"], "testBytes")
            self.assertEqual(base64.b64decode(result["value"]), bytes([0, 255, 1]))
        finally:
            send({"@type": "close", "@extra": "close"})
            receive_until(lambda e: e.get("@type") == "updateAuthorizationState"
                          and e["authorization_state"]["@type"] == "authorizationStateClosed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
