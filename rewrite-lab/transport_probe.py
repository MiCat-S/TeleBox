"""Telethon transport checks using only loopback sockets and synthetic proxy auth."""
import asyncio
from collections import defaultdict
import logging
import unittest
from unittest.mock import patch

from telethon.network.connection.tcpfull import ConnectionTcpFull


def connection(port, proxy=None):
    return ConnectionTcpFull("127.0.0.9", port, 2,
                             loggers=defaultdict(lambda: logging.getLogger("rewrite-probe")),
                             proxy=proxy)


class TransportProbe(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_pending_connect(self):
        started = asyncio.Event()
        exited = asyncio.Event()

        async def pending(*args, **kwargs):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                exited.set()

        transport = connection(1)
        with patch("asyncio.open_connection", pending):
            task = asyncio.create_task(transport.connect(timeout=3))
            try:
                await asyncio.wait_for(started.wait(), 3)
            finally:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            self.assertTrue(exited.is_set())
        await transport.disconnect()
        self.assertFalse(transport._connected)
        self.assertIsNone(transport._send_task)
        self.assertIsNone(transport._recv_task)

    async def test_authenticated_socks5_connect_and_close(self):
        for generation in range(5):
            observed = asyncio.get_running_loop().create_future()

            async def proxy_server(reader, writer):
                result = None
                try:
                    header = await reader.readexactly(2)
                    self.assertEqual(header[0], 5)
                    methods = await reader.readexactly(header[1])
                    self.assertIn(2, methods)
                    writer.write(bytes([5, 2]))
                    await writer.drain()
                    auth = await reader.readexactly(2)
                    self.assertEqual(auth[0], 1)
                    username = await reader.readexactly(auth[1])
                    password_size = (await reader.readexactly(1))[0]
                    password = await reader.readexactly(password_size)
                    self.assertEqual((username, password), (b"synthetic", b"synthetic-pass"))
                    writer.write(bytes([1, 0]))
                    await writer.drain()
                    request = await reader.readexactly(4)
                    self.assertEqual(request, bytes([5, 1, 0, 1]))
                    address = await reader.readexactly(4)
                    port = int.from_bytes(await reader.readexactly(2), "big")
                    self.assertEqual((address, port), (bytes([127, 0, 0, 9]), 443))
                    writer.write(bytes([5, 0, 0, 1, 127, 0, 0, 1, 0, 1]))
                    await writer.drain()
                    # No target connection is made; EOF proves client cleanup.
                    await reader.read()
                    result = True
                except Exception as error:
                    result = error
                finally:
                    writer.close()
                    await writer.wait_closed()
                    if not observed.done():
                        observed.set_result(result)

            server = await asyncio.start_server(proxy_server, "127.0.0.1", 0)
            proxy_port = server.sockets[0].getsockname()[1]
            transport = connection(443, {
                "proxy_type": "socks5", "addr": "127.0.0.1", "port": proxy_port,
                "username": "synthetic", "password": "synthetic-pass", "rdns": True,
            })
            try:
                await asyncio.wait_for(transport.connect(timeout=3), 4)
                self.assertTrue(transport._connected)
                await asyncio.wait_for(transport.disconnect(), 3)
                self.assertTrue(transport._send_task.done())
                self.assertTrue(transport._recv_task.done())
                self.assertTrue(transport._writer.is_closing())
                result = await asyncio.wait_for(observed, 3)
                if isinstance(result, Exception):
                    raise result
                self.assertTrue(result)
            finally:
                await transport.disconnect()
                server.close()
                await server.wait_closed()


if __name__ == "__main__":
    unittest.main(verbosity=2)
