#!/usr/bin/env python3
"""Server for the poster editor (no dependencies).

  python3 tools/poster-editor/serve.py          http://localhost:8010/tools/poster-editor/

Serves the repository (the editor imports the app's poster renderer and
detector) and accepts one kind of write: PUT /poster/poster.json, from this
page only. The previous version is kept as poster/poster.json.bak.
Listens on 127.0.0.1 only.
"""

import argparse
import http.server
import json
import shutil
import sys
from functools import partial
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / "poster" / "poster.json"
WRITE_PATH = "/poster/poster.json"
MAX_BYTES = 5_000_000


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }
    port = 8010

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        allowed = {f"http://localhost:{self.port}", f"http://127.0.0.1:{self.port}"}
        return origin is None or origin in allowed

    def do_PUT(self):
        if urlparse(self.path).path != WRITE_PATH or not self._same_origin():
            self.send_error(403, "only poster/poster.json, from the editor")
            return
        n = int(self.headers.get("Content-Length") or 0)
        if not 0 < n <= MAX_BYTES:
            self.send_error(413)
            return
        body = self.rfile.read(n)
        try:
            data = json.loads(body)
            if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
                raise ValueError("no elements")
        except ValueError as e:
            self.send_error(400, f"not a poster: {e}")
            return
        if TARGET.exists():
            shutil.copyfile(TARGET, TARGET.with_suffix(".json.bak"))
        TARGET.write_bytes(body)
        self.send_response(204)
        self.end_headers()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8010)
    args = ap.parse_args()
    Handler.port = args.port
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(ROOT)))
    print(f"Poster editor → http://localhost:{args.port}/tools/poster-editor/")
    print(f"  (the app with the saved poster: http://localhost:{args.port}/?mode=demo)")
    print("Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
