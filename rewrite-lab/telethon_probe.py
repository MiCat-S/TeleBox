"""Offline candidate probe using generated test keys, never real sessions."""
import base64
import ipaddress
import json
from pathlib import Path
import struct
import subprocess
import unittest

import telethon
from telethon.crypto import AuthKey
from telethon.sessions import StringSession
from telethon.tl import alltlobjects, functions, types


class TelethonProbe(unittest.TestCase):
    def test_teleproto_fixture_import(self):
        generator = Path(__file__).with_name("synthetic-session.cjs")
        data = json.loads(subprocess.check_output(["node", str(generator)], text=True))
        self.assertTrue(data["synthetic"])
        for fixture in data["fixtures"]:
            with self.subTest(address=fixture["address"]):
                # Decode the inspected Teleproto format, not Telethon's format.
                raw = base64.b64decode(fixture["teleproto"][1:], validate=True)
                dc, size = struct.unpack(">BH", raw[:3])
                address = raw[3:3 + size].decode("ascii")
                port = struct.unpack(">H", raw[3 + size:5 + size])[0]
                key = raw[5 + size:]
                self.assertEqual(len(key), 256)
                self.assertEqual(key, bytes([0xa5]) * 256)
                self.assertEqual((dc, address, port), (fixture["dc"], fixture["address"], fixture["port"]))
                # Let the candidate library serialize its own native format.
                session = StringSession()
                session.set_dc(dc, str(ipaddress.ip_address(address)), port)
                session.auth_key = AuthKey(key)
                restored = StringSession(session.save())
                self.assertEqual(restored.auth_key.key, key)
                self.assertEqual(restored.server_address, address)
                self.assertEqual(restored.dc_id, dc)
                self.assertEqual(restored.port, port)

    def test_required_rpc_serialization(self):
        peer = types.InputPeerSelf()
        requests = [
            functions.messages.GetHistoryRequest(peer, 0, 0, 0, 10, 0, 0, 0),
            functions.messages.EditMessageRequest(peer, 1, message="synthetic"),
            functions.messages.DeleteMessagesRequest([1]),
            functions.channels.GetSendAsRequest(peer),
            functions.messages.GetBotCallbackAnswerRequest(peer, 1, data=b"\0\xff"),
            functions.upload.SaveFilePartRequest(1, 0, b"synthetic"),
            functions.updates.GetStateRequest(),
        ]
        for request in requests:
            with self.subTest(request=type(request).__name__):
                self.assertGreaterEqual(len(bytes(request)), 4)

    def test_callback_payload(self):
        callback = types.KeyboardButtonCallback("callback", b"\0\xff\x01")
        self.assertEqual(callback.data, b"\0\xff\x01")
        self.assertGreater(len(bytes(callback)), 4)


if __name__ == "__main__":
    print(json.dumps({"library": "Telethon", "version": telethon.__version__,
                      "layer": alltlobjects.LAYER, "network": False}), flush=True)
    unittest.main(verbosity=2)
