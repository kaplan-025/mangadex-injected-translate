#!/usr/bin/env python3
"""MGC canlı log sunucusu.

Eklenti log satırlarını http://127.0.0.1:8765/log adresine POST'lar,
bu betik /tmp/mgc-live.log dosyasına ekler (2 MB'ta döndürmeli).
Sadece localhost dinlenir; dışarı hiçbir şey çıkmaz.

Kullanım:  python3 tools/logserver.py   (okurken açık tut, kapatınca akış durur)
Okuma:    tail -f /tmp/mgc-live.log
"""
from http.server import BaseHTTPRequestHandler, HTTPServer
import os
import time

LOG_PATH = "/tmp/mgc-live.log"
MAX_BYTES = 2 * 1024 * 1024


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _ok(self, body=b"ok"):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._ok(b"mgc-logserver alive")

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        body = self.rfile.read(min(n, 512 * 1024)).decode("utf-8", "replace") if n > 0 else ""
        if self.path == "/log" and body.strip():
            ts = time.strftime("%H:%M:%S")
            lines = [f"{ts} {ln[:500]}" for ln in body.split("\n") if ln.strip()][:300]
            try:
                if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > MAX_BYTES:
                    os.remove(LOG_PATH)
                with open(LOG_PATH, "a", encoding="utf-8") as f:
                    f.write("\n".join(lines) + "\n")
            except OSError:
                pass
        self._ok()


if __name__ == "__main__":
    print("mgc-logserver: http://127.0.0.1:8765 -> /tmp/mgc-live.log", flush=True)
    HTTPServer(("127.0.0.1", 8765), H).serve_forever()
