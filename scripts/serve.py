#!/usr/bin/env python3
"""Local dev server for Ostinascope (no dependencies).

  python3 scripts/serve.py            http://localhost:8000  (camera works on localhost)
  python3 scripts/serve.py --https    https://<LAN-IP>:8443  for testing on a phone

Phones only allow the camera over HTTPS. --https creates a self-signed
certificate in .cert/ (git-ignored) with openssl; on the phone, accept the
certificate warning once ("Show Details" → "visit this website" on iOS).
For anything beyond quick tests, publish to GitHub Pages instead.
"""

import argparse
import http.server
import os
import socket
import ssl
import subprocess
import sys
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CERT_DIR = ROOT / ".cert"


def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip: str) -> tuple[Path, Path]:
    CERT_DIR.mkdir(exist_ok=True)
    cert, key = CERT_DIR / "dev.crt", CERT_DIR / "dev.key"
    stamp = CERT_DIR / "ip.txt"
    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text() == ip:
        return cert, key
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "30",
            "-subj", "/CN=ostinascope-dev",
            "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    stamp.write_text(ip)
    return cert, key


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--https", action="store_true", help="serve over HTTPS on the LAN")
    ap.add_argument("--port", type=int, default=None)
    args = ap.parse_args()

    os.chdir(ROOT)
    ip = lan_ip()
    port = args.port or (8443 if args.https else 8000)
    host = "0.0.0.0" if args.https else "127.0.0.1"
    httpd = http.server.ThreadingHTTPServer((host, port), partial(Handler, directory=str(ROOT)))

    if args.https:
        cert, key = ensure_cert(ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        print(f"Ostinascope → https://{ip}:{port}/   (phone on the same Wi-Fi)")
    else:
        print(f"Ostinascope → http://localhost:{port}/   (demo: add ?mode=demo)")
    print("Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
