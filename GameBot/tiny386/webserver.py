import base64
import hashlib
import http.server
import select
import socket
import socketserver
import struct
import threading
import urllib.error
import urllib.parse
import urllib.request

PORT = 8000

# Hosts /ws is willing to open a raw TCP connection to, and the ports it will
# use. Even more important than the /proxy allowlist: this endpoint relays
# arbitrary bytes, so without a list it would be an open TCP proxy for anyone
# who can reach port 8000.
RELAY_ALLOWED_HOSTS = {
    'cosmicbot.gameshows.lol',
    # The live game server. cosmicbot.gameshows.lol serves the HTTP side but
    # resets connections on 6666; the original 1998 address still answers IRC
    # registration, and is what the remote's dispatch.ini names.
    '137.66.45.53',
}
RELAY_ALLOWED_PORTS = {6666, 6667}
RELAY_CONNECT_TIMEOUT = 15
# RFC 6455's fixed handshake salt.
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

# Hosts the /proxy endpoint is willing to fetch.
#
# An allowlist, not a wildcard, on purpose: this server binds to every
# interface (see the TCPServer call below), so a wildcard proxy would let
# anyone who can reach this box route arbitrary traffic through it. FrogFind
# is already a general-purpose gateway -- it fetches the target page itself
# and rewrites every link to stay on frogfind.com -- so allowing that one host
# is enough to browse the wider web from inside the VM.
PROXY_ALLOWED_HOSTS = {
    'frogfind.com',
    'www.frogfind.com',
    'cosmicbot.gameshows.lol',
}

# Internet Explorer 3 -- the browser inside Win95 -- predates PNG support
# entirely (it arrived in IE4/5). Any PNG reaches it as a broken image icon, so
# the proxy re-encodes them to GIF, which IE3 has always understood.
#
# Transparency is preserved where the source has it. Truecolour PNGs are
# quantised to a 256-colour palette, which is all GIF can hold -- lossy, but a
# visible logo beats a broken-image icon.
TRANSCODE_PNG_TO_GIF = True

# Retry a 404'd static asset once at the site root.
#
# cosmicbot.gameshows.lol's Hall of Fame page references site.css and its two
# logos with relative URLs, but the client resolves them against /cgi/ (where
# sponsors.cgi lives) rather than the site root where the files actually are.
# Everything 404s: no styling, no images.
#
# This is a workaround for that server's markup, not a fix -- the real fix is
# absolute paths or a <base href="/"> on the remote page. Deliberately narrow:
# GET only, 404 only, one retry, and only for extensions that are plainly
# static assets. Anything dynamic (.cgi, .ini) is left alone, because a 404
# from an endpoint is a real answer and retrying it elsewhere would invent one.
PROXY_ROOT_FALLBACK = True
PROXY_ROOT_FALLBACK_SUFFIXES = ('.css', '.png', '.gif', '.jpg', '.jpeg', '.ico', '.js')

PROXY_TIMEOUT_SECONDS = 20
# Identify as the vintage client rather than as Python: some hosts reject
# urllib's default agent outright, and FrogFind tailors its output for old
# browsers.
PROXY_USER_AGENT = 'Mozilla/3.0 (compatible; beZerk Revived; Windows 95)'


# Extension -> type, for upstreams that send no Content-Type at all.
PROXY_MIME = {
    '.srf': 'application/octet-stream',
    '.ini': 'text/plain',
    '.txt': 'text/plain',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.html': 'text/html',
    '.htm': 'text/html',
}


def guess_content_type(url, upstream_ctype):
    """Content-Type for a proxied response.

    cosmicbot.gameshows.lol serves the game's .srf ad files with NO
    Content-Type header. Blindly defaulting those to text/html hands the client
    a binary asset labelled as markup -- and the same file served by our own
    server carries application/octet-stream, so remote mode was not a faithful
    substitute. Guess from the extension instead, and only fall back to
    text/html for paths with no useful extension (.cgi, /halloffame, ...).
    """
    if upstream_ctype:
        return upstream_ctype
    path = urllib.parse.urlparse(url).path.lower()
    dot = path.rfind('.')
    ext = path[dot:] if dot != -1 else ''
    return PROXY_MIME.get(ext, 'text/html')


def png_to_gif(data: bytes):
    """Re-encode a PNG as GIF, or return None to pass the original through."""
    if not TRANSCODE_PNG_TO_GIF or not data.startswith(b'\x89PNG\r\n\x1a\n'):
        return None
    try:
        import io
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(io.BytesIO(data)) as im:
            has_alpha = im.mode in ('RGBA', 'LA') or 'transparency' in im.info
            im = im.convert('RGBA') if has_alpha else im.convert('RGB')
            out = io.BytesIO()
            if has_alpha:
                # Quantise, then reserve one palette slot as the transparent
                # colour -- GIF has no alpha channel, only an index.
                q = im.convert('RGBA').quantize(colors=255, method=Image.Quantize.FASTOCTREE)
                mask = im.split()[3].point(lambda a: 255 if a <= 128 else 0)
                q.paste(255, mask)
                q.save(out, format='GIF', transparency=255)
            else:
                im.quantize(colors=256, method=Image.Quantize.FASTOCTREE).save(out, format='GIF')
            return out.getvalue()
    except Exception as e:
        print(f'[proxy] PNG->GIF failed ({e}); passing the original through')
        return None


def ws_frame(payload: bytes, opcode: int = 0x2) -> bytes:
    """Encode one unfragmented server->client frame. Server frames are never
    masked (RFC 6455 5.1)."""
    header = bytes([0x80 | opcode])
    n = len(payload)
    if n < 126:
        header += bytes([n])
    elif n < 65536:
        header += bytes([126]) + struct.pack('>H', n)
    else:
        header += bytes([127]) + struct.pack('>Q', n)
    return header + payload


def _read_exactly(stream, n: int):
    """rfile.read can come up short; keep going until we have n bytes or EOF."""
    buf = b''
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def ws_read_frame(stream):
    """Decode one client->server frame -> (opcode, payload), or (None, b'').

    Client frames are always masked. Continuation frames (opcode 0) are folded
    into the previous opcode, which is enough for a byte-stream relay: nothing
    here cares about message boundaries, only about the bytes in order.
    """
    opcode_out = None
    payload = b''
    while True:
        head = _read_exactly(stream, 2)
        if head is None:
            return None, b''
        fin = head[0] & 0x80
        opcode = head[0] & 0x0F
        masked = head[1] & 0x80
        length = head[1] & 0x7F

        if length == 126:
            ext = _read_exactly(stream, 2)
            if ext is None:
                return None, b''
            length = struct.unpack('>H', ext)[0]
        elif length == 127:
            ext = _read_exactly(stream, 8)
            if ext is None:
                return None, b''
            length = struct.unpack('>Q', ext)[0]

        mask = None
        if masked:
            mask = _read_exactly(stream, 4)
            if mask is None:
                return None, b''

        data = _read_exactly(stream, length) if length else b''
        if data is None:
            return None, b''
        if mask:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))

        if opcode != 0x0:
            opcode_out = opcode
        payload += data
        # Control frames (0x8 close, 0x9 ping, 0xA pong) are never fragmented.
        if fin or opcode_out in (0x8, 0x9, 0xA):
            return opcode_out, payload


# Source files the browser must never serve from cache without asking.
#
# main.js and index.html are plain <script src>/document loads, so a soft
# reload happily reuses the stored copy -- which means an edited main.js can
# sit on disk while the page keeps running the previous one. That has now
# masked two separate fixes (the .zst decompression and the AudioWorklet
# switch), each time looking like the new code was broken rather than absent.
#
# "no-cache" does NOT mean "do not store": the browser still caches, it just
# has to revalidate, and SimpleHTTPRequestHandler answers with a 304 when the
# file is unchanged. Cost is one conditional request per file per load.
#
# Disk images are deliberately excluded -- they are large, they change rarely,
# and main.js caches them in memory across clients anyway.
NO_CACHE_SUFFIXES = ('.js', '.html', '.htm', '.css', '.ini', '.json', '.wasm')


class MyHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Mandatory headers for Wasm/SharedArrayBuffer support
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        path = urllib.parse.urlparse(self.path).path.lower()
        if path.endswith(NO_CACHE_SUFFIXES) or path.endswith('/'):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_GET(self):
        if self.path.startswith('/ws?'):
            self.handle_websocket()
            return
        if self.path.startswith('/proxy?'):
            self.handle_proxy()
            return
        super().do_GET()

    def do_POST(self):
        """POST is proxied too, so a real game server's login round-trip works.

        The client authenticates with POST /cgi/acrval0.cgi; a GET-only proxy
        could fetch a remote server's static files but never actually log in.
        """
        if self.path.startswith('/proxy?'):
            self.handle_proxy()
            return
        self.send_error(405, 'POST is only supported on /proxy')

    # ── websocket -> raw TCP relay ────────────────────────────────────────
    #
    # The emulated PC talks IRC on port 6666, which is a long-lived
    # bidirectional stream. The /proxy endpoint cannot carry that: it is one
    # fetch, one response, and the IRC server pushes unsolicited traffic with
    # no request to hang it off. A browser also cannot open a raw TCP socket,
    # which is the whole reason tcpip.js exists in this project.
    #
    # So the page opens a WebSocket here and this process -- ordinary Python,
    # with real sockets -- makes the actual TCP connection and pumps bytes both
    # ways. cosmic-server.js pipes the VM's port-6666 stream into it, which is
    # what lets a client inside the VM play on a real remote server.

    def handle_websocket(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        host = query.get('host', [None])[0]
        port_raw = query.get('port', ['6666'])[0]

        try:
            port = int(port_raw)
        except ValueError:
            self.send_error(400, f'bad port: {port_raw!r}')
            return
        if host not in RELAY_ALLOWED_HOSTS:
            print(f'[relay] REFUSED {host} (not in RELAY_ALLOWED_HOSTS)')
            self.send_error(403, f'host not allowed: {host}')
            return
        if port not in RELAY_ALLOWED_PORTS:
            print(f'[relay] REFUSED port {port} (not in RELAY_ALLOWED_PORTS)')
            self.send_error(403, f'port not allowed: {port}')
            return

        key = self.headers.get('Sec-WebSocket-Key')
        if not key or 'websocket' not in (self.headers.get('Upgrade') or '').lower():
            self.send_error(400, 'not a websocket upgrade')
            return

        try:
            target = socket.create_connection((host, port), RELAY_CONNECT_TIMEOUT)
            # create_connection leaves that timeout on the socket for every
            # later send and recv, not just the connect. A game connection sits
            # idle for minutes at a time -- through the tutorial, the ad, the
            # intro -- so a 15 s deadline on ordinary traffic is wrong. select()
            # below already provides the waiting.
            target.settimeout(None)
        except Exception as e:
            print(f'[relay] connect to {host}:{port} failed: {e}')
            self.send_error(502, f'cannot reach {host}:{port}')
            return

        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()
        ).decode()
        # Written raw: send_response would add Server/Date and, more to the
        # point, end_headers injects this server's COOP/COEP headers, which do
        # not belong on a 101.
        self.wfile.write(
            b'HTTP/1.1 101 Switching Protocols\r\n'
            b'Upgrade: websocket\r\n'
            b'Connection: Upgrade\r\n'
            b'Sec-WebSocket-Accept: ' + accept.encode() + b'\r\n\r\n'
        )
        self.wfile.flush()
        self.close_connection = True
        print(f'[relay] open -> {host}:{port}')

        write_lock = threading.Lock()
        done = threading.Event()

        def target_to_ws():
            """Upstream bytes -> binary websocket frames."""
            try:
                while not done.is_set():
                    # Poll rather than block forever, so this thread notices
                    # done and exits when the other direction tears down.
                    if not select.select([target], [], [], 0.5)[0]:
                        continue
                    chunk = target.recv(65536)
                    if not chunk:
                        break
                    with write_lock:
                        self.wfile.write(ws_frame(chunk))
                        self.wfile.flush()
            except Exception as e:
                # Swallowing this made every upstream failure look identical to
                # a clean close, which is the one thing we most need to tell
                # apart.
                print(f'[relay] {host}:{port} upstream read failed: {e!r}')
            finally:
                done.set()

        pump = threading.Thread(target=target_to_ws, daemon=True)
        pump.start()

        try:
            while not done.is_set():
                opcode, payload = ws_read_frame(self.rfile)
                if opcode is None or opcode == 0x8:      # closed / CLOSE
                    break
                if opcode == 0x9:                        # PING -> PONG
                    with write_lock:
                        self.wfile.write(ws_frame(payload, opcode=0xA))
                        self.wfile.flush()
                    continue
                if opcode in (0x1, 0x2):                 # TEXT / BINARY
                    target.sendall(payload)
        except Exception as e:
            print(f'[relay] {host}:{port} ended: {e}')
        finally:
            done.set()
            try:
                target.shutdown(socket.SHUT_RDWR)
            except Exception:
                pass
            target.close()
            pump.join(timeout=2)
            print(f'[relay] closed -> {host}:{port}')

    def proxy_fetch(self, url, body_in, headers):
        """One upstream request -> (body, content_type, status)."""
        req = urllib.request.Request(
            url, data=body_in, headers=headers, method=self.command
        )
        try:
            with urllib.request.urlopen(req, timeout=PROXY_TIMEOUT_SECONDS) as resp:
                ctype = guess_content_type(url, resp.headers.get('Content-Type'))
                return resp.read(), ctype, resp.status
        except urllib.error.HTTPError as e:
            # Pass the upstream status through rather than masking it as a 500,
            # so a 404 from the far end still reads as a 404 in the browser.
            body = e.read() or f'upstream returned {e.code}'.encode()
            ctype = e.headers.get('Content-Type', 'text/plain') if e.headers else 'text/plain'
            print(f'[proxy] upstream HTTP {e.code} for {url}')
            return body, ctype, e.code
        except Exception as e:
            print(f'[proxy] FAILED {url}: {e}')
            return f'proxy error: {e}'.encode(), 'text/plain', 502

    def root_fallback_target(self, parsed):
        """Same filename at the site root, or None if not eligible."""
        if not PROXY_ROOT_FALLBACK or self.command != 'GET':
            return None
        path = parsed.path
        if not path.lower().endswith(PROXY_ROOT_FALLBACK_SUFFIXES):
            return None
        name = path.rsplit('/', 1)[-1]
        # Already at the root: nowhere else to look.
        if not name or path == '/' + name:
            return None
        return f'{parsed.scheme}://{parsed.netloc}/{name}'

    def handle_proxy(self):
        """Fetch an allowlisted external URL on behalf of the page.

        The emulated PC cannot reach the internet on its own: tcpip.js is a
        userspace stack running inside the browser tab, and a browser cannot
        open raw sockets. cosmic-server.js therefore hands outbound requests
        here, and this process -- ordinary Python, with real network access --
        performs the fetch.

        This has to live in THIS server rather than being fetched straight from
        the page, because frogfind.com sends no Access-Control-Allow-Origin
        header: a cross-origin fetch from the page would simply be blocked.
        Served from /proxy on port 8000 it is same-origin, so CORS never
        applies.
        """
        query = urllib.parse.urlparse(self.path).query
        target = urllib.parse.parse_qs(query).get('url', [None])[0]

        if not target:
            self.send_error(400, 'missing url parameter')
            return

        parsed = urllib.parse.urlparse(target)
        if parsed.scheme not in ('http', 'https'):
            self.send_error(400, f'unsupported scheme: {parsed.scheme!r}')
            return
        if parsed.hostname not in PROXY_ALLOWED_HOSTS:
            print(f'[proxy] REFUSED {parsed.hostname} (not in allowlist)')
            self.send_error(403, f'host not allowed: {parsed.hostname}')
            return

        # Forward the request body on POST, so a login round-trip works and
        # not just static fetches.
        body_in = None
        if self.command == 'POST':
            try:
                length = int(self.headers.get('Content-Length') or 0)
            except ValueError:
                length = 0
            body_in = self.rfile.read(length) if length else b''

        headers = {'User-Agent': PROXY_USER_AGENT}
        if body_in is not None:
            headers['Content-Type'] = (
                self.headers.get('Content-Type') or 'application/x-www-form-urlencoded'
            )

        print(f'[proxy] {self.command} {target}'
              + (f' ({len(body_in)} byte body)' if body_in else ''))
        body, ctype, status = self.proxy_fetch(target, body_in, headers)

        if status == 404 and self.root_fallback_target(parsed) is not None:
            retry = self.root_fallback_target(parsed)
            print(f'[proxy] 404 -- retrying at the site root: {retry}')
            r_body, r_ctype, r_status = self.proxy_fetch(retry, body_in, headers)
            if r_status == 200:
                print(f'[proxy] root fallback OK ({len(r_body)} bytes, {r_ctype})')
                body, ctype, status = r_body, r_ctype, r_status
            else:
                print(f'[proxy] root fallback also failed ({r_status}); keeping the 404')

        gif = png_to_gif(body)
        if gif is not None:
            print(f'[proxy] PNG -> GIF for IE3 ({len(body)} -> {len(gif)} bytes)')
            body, ctype = gif, 'image/gif'

        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    """Threaded, because a /ws relay holds its connection open for the whole
    game. On the old single-threaded TCPServer the first relay would have
    blocked every other request -- including the page's own assets."""
    daemon_threads = True
    allow_reuse_address = True


with ThreadingServer(("", PORT), MyHandler) as httpd:
    print(f"Server started at http://localhost:{PORT}")
    print(f"Proxy allowlist: {', '.join(sorted(PROXY_ALLOWED_HOSTS))}")
    print(f"Relay allowlist: {', '.join(sorted(RELAY_ALLOWED_HOSTS))} "
          f"on ports {sorted(RELAY_ALLOWED_PORTS)}")
    httpd.serve_forever()
