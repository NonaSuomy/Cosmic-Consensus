#!/usr/bin/env python3
"""Standalone HTTP content server for You Don't Know Jack: Net Show.

YDKJ Net Show is different from Cosmic Consensus, GTP, and Acrophobia:
the JavaScript profile shows that it is an HTTP-only client.  It downloads
the game/update files from ``/jol/...`` and does not use the IRC/game port.

This server mirrors that profile for a real client or emulator:

    python3 ydkjns-server.py --host 127.0.0.1 --port 80

Static requests are served from ``static`` relative to this file, so a
request for ``/jol/patches/v123/boot.srf`` serves
``static/jol/patches/v123/boot.srf``.  POST requests are also allowed for
legacy updater CGI files when those files exist under ``static/cgi``.

There is deliberately no IRC or game-port listener. YDKJ has no IRC half;
opening port 6666 would only make the server look like it supported a
protocol that the client does not use.
"""

import argparse
import http.server
import logging
import mimetypes
import os
import posixpath
import urllib.parse


ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_ROOT = os.path.join(ROOT, "static")
DEFAULT_HOST = "127.0.0.1"
DEFAULT_HTTP_PORT = 80


MIME_TYPES = {
    ".ini": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".srf": "application/octet-stream",
    ".bin": "application/octet-stream",
}


def content_type(path):
    ext = os.path.splitext(path)[1].lower()
    return MIME_TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"


class YDKJHTTPHandler(http.server.BaseHTTPRequestHandler):
    server_version = "YDKJNS/1.0"

    def log_message(self, format_string, *args):
        logging.info("HTTP %s - %s", self.address_string(), format_string % args)

    def _safe_file(self):
        raw_path = urllib.parse.urlsplit(self.path).path.replace("\\", "/")
        relative = posixpath.normpath("/" + raw_path.lstrip("/"))
        if relative == "/" or relative.startswith("/../"):
            return None
        candidate = os.path.realpath(os.path.join(STATIC_ROOT, relative.lstrip("/")))
        if os.path.commonpath((STATIC_ROOT, candidate)) != os.path.realpath(STATIC_ROOT):
            return None
        return candidate

    def _serve_file(self):
        path = self._safe_file()
        if not path or not os.path.isfile(path):
            self.send_error(404, "Not found")
            return
        try:
            with open(path, "rb") as stream:
                data = stream.read()
        except OSError as exc:
            logging.error("Read failed for %s: %s", path, exc)
            self.send_error(500, "Could not read file")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type(path))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(data)
        logging.info("Static: %s -> %s (%d bytes)", self.path, path, len(data))

    def _serve_sponsors(self):
        # Jack Netshow asks for this legacy endpoint after validation.  It is
        # not a file under static/cgi, so answer it explicitly like the JS
        # server does.  An empty sponsor list is valid and lets the client
        # continue to the local/content files.
        body = b"[Sponsors]\nAd Count = 0\n"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        logging.info("YDKJ sponsors CGI answered with an empty sponsor list")

    def _route(self):
        path = urllib.parse.urlsplit(self.path).path.replace("\\", "/")
        if path.lower() == "/cgi-bin/bezsponsors.cgi":
            self._serve_sponsors()
        else:
            self._serve_file()

    def do_GET(self):
        self._route()

    def do_POST(self):
        # The YDKJ updater uses CGI-looking paths.  The JS server serves an
        # authored file when present instead of inventing a protocol reply.
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length:
            self.rfile.read(length)
        self._route()


class ThreadingHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    parser = argparse.ArgumentParser(description="Standalone YDKJ Net Show HTTP content server")
    parser.add_argument("--host", default=DEFAULT_HOST, help="bind address (default: %(default)s)")
    parser.add_argument("--port", "--http-port", dest="http_port", type=int,
                        default=DEFAULT_HTTP_PORT, help="HTTP port (default: %(default)s)")
    args = parser.parse_args()

    if not os.path.isdir(STATIC_ROOT):
        parser.error(f"static directory does not exist: {STATIC_ROOT}")

    httpd = ThreadingHTTPServer((args.host, args.http_port), YDKJHTTPHandler)
    logging.info("YDKJ HTTP server listening on %s:%d", args.host, args.http_port)
    logging.info("Serving static files from %s", STATIC_ROOT)
    logging.info("YDKJ Net Show is HTTP-only; no IRC/game protocol is implemented")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        logging.info("Stopping YDKJ server")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    main()
