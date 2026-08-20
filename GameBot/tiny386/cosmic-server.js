'use strict';

// Wrapped in an IIFE (rather than bare top-level declarations) so this file
// can be safely re-fetched and re-run for hot reload -- see
// window.reloadCosmicServer() in main.js. Without this wrapper, a second
// <script src="cosmic-server.js"> load would throw a SyntaxError trying to
// redeclare the same top-level const/let/class names in the shared global
// scope. Everything that needs to survive a reload (i.e. be callable by
// main.js / the still-running TCP accept loop) is published to window.* at
// the bottom of this IIFE instead.
(function () {

// ─────────────────────────────────────────────────────────────────────────
// Cosmic Consensus -- browser-native server, ported from cosmic_standalone_v54.py
//
// Runs entirely client-side against tcpip.js's virtual network stack, so it
// can sit in the same browser tab as a tiny386-emulated Windows 95 VM (see
// main.js) with no real sockets, no build step, and no server process --
// just static files, which is what makes this deployable straight to
// GitHub Pages.
//
// STATUS: installment 1 of the port.
//   DONE : HTTP setup server (static files, ad files, login/query/change
//          CGI endpoints, sponsors/trouble pages) -- full port of
//          SetupHTTPHandler.
//   DONE : IRC-style game socket connection lifecycle -- registration
//          (NICK/USER), PING/PONG keepalive, MODE, WHO, NAMES, JOIN, PART,
//          QUIT. This is enough for a real client to connect, log in over
//          HTTP, open the game socket, register, and join the lobby.
//   TODO : the actual pyramid-game round logic (PRIVMSG dispatch -> board
//          generation, question bank, scoring, storm system, etc). That's
//          the bulk of the Python Client class (~1500 lines) and is left
//          as a clearly marked stub below (see handlePrivmsg) for the next
//          installment.
// ─────────────────────────────────────────────────────────────────────────

// ── console -> #logarea mirror ──────────────────────────────────────────
// Redirects console.log/info/warn/error/debug so their output also lands in
// the same on-page textarea that tiny386's own logger writes to (see
// index.html's inst.set_logger), instead of only going to devtools. This
// file also runs under a plain Node smoke-test harness, so everything here
// is guarded behind a check for `document`/the #logarea element -- under
// Node this block is a no-op and console behaves normally.
(function () {
    if (typeof document === 'undefined') return;
    const logarea = document.getElementById('logarea');
    if (!logarea) return;

    const MAX_LEN = 40960;
    const methods = ['log', 'info', 'warn', 'error', 'debug'];

    // Stash the REAL console methods the first time, on the window, and always
    // wrap THOSE. Capturing console[m] fresh each load meant a hot reload
    // wrapped the previous wrapper: the old one still appended, the new one
    // appended again, and every line showed up twice -- three times after two
    // reloads, compounding for as long as the page stayed open.
    if (!window.__cosmicConsoleOriginal) {
        window.__cosmicConsoleOriginal = {};
        methods.forEach(function (m) {
            window.__cosmicConsoleOriginal[m] =
                console[m] ? console[m].bind(console) : function () {};
        });
    }
    const original = window.__cosmicConsoleOriginal;

    function stringifyArg(a) {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
        try {
            return JSON.stringify(a);
        } catch (e) {
            return String(a);
        }
    }

    function append(line) {
        const s = line + '\n';
        const combined = logarea.value + s;
        logarea.value = combined.length > MAX_LEN
            ? combined.substring(combined.length - MAX_LEN)
            : combined;
        // Honour index.html's Autoscroll toggle. This used to scroll
        // unconditionally, so turning autoscroll off only stopped tiny386's own
        // logger -- every console line from the game server still yanked the
        // view back to the bottom. Default to scrolling if the flag is absent
        // (e.g. an older index.html).
        if (window.log_autoscroll === undefined || window.log_autoscroll) {
            logarea.scrollTop = logarea.scrollHeight;
        }
    }

    methods.forEach(function (method) {
        console[method] = function (...args) {
            original[method](...args);
            try {
                append(args.map(stringifyArg).join(' '));
            } catch (e) {
                // never let logging break the caller
            }
        };
    });
})();

// ── network / identity constants ────────────────────────────────────────
// SERVER_NAME must be the tap interface's own IP (the address the guest VM
// reaches the host stack at), NOT the DHCP-leased guest address. With the
// DHCP config already in main.js (tap ip 10.0.2.2/24, lease range
// 10.0.2.15-10.0.2.31), that's 10.0.2.2.
const SERVER_NAME = '10.0.2.2';
const BOT_NICK = 'CosmicBot';
const LIST_CHANNEL = 'Big_List';
const GAME_PORT = 6666;

// ═══════════════════════════════════════════════════════════════════════
// HTTP setup server (port of SetupHTTPHandler)
// ═══════════════════════════════════════════════════════════════════════

const HTTP_STATIC_ROOT = 'static'; // fetched relative to the page, same as GH Pages hosts it
const HTTP_ADS_ROOT = 'static/bigidea/content/Ads';

// Player ID counter for the HTTP login CGI endpoints - incremented per new login
let nextHttpPlayerId = 1000;

// Simple user store: player_name -> player_id
// HTTP_ACCEPT_ANY_LOGIN = true means any username/password is accepted
const HTTP_ACCEPT_ANY_LOGIN = true;
const httpUsers = new Map();
// CosmicConsensus.exe authenticates over HTTP, then opens IRC and sends its
// saved registry profile in the L line. Keep the short-lived HTTP names so
// the IRC connection can use what the player actually typed in the login box.
const pendingHttpLogins = [];
// GTP shares the same HTTP login endpoint but has its own IRC handler. Expose
// the short-lived queue so that handler can apply the username typed in the
// login form instead of trusting a stale registry name from the disk image.
window.__pendingHttpLogins = pendingHttpLogins;

const HTTP_MIME = {
  '.ini': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.srf': 'application/octet-stream',
};

function httpMimeFor(path) {
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot).toLowerCase();
  return HTTP_MIME[ext] || 'application/octet-stream';
}

// Resolves a URL path to a safe relative path under a root, or null if it
// tries to escape the root (equivalent to the os.path.normpath + ".."
// check in try_static/try_ad_file).
function safeRelativePath(urlPath) {
  const parts = urlPath.split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

async function tryStatic(urlPath) {
  const safe = safeRelativePath(urlPath);
  if (safe === null) return null;
  const fileUrl = HTTP_STATIC_ROOT + '/' + safe;
  let resp;
  try {
    resp = await fetch(fileUrl, { cache: 'no-store' });
  } catch (e) {
    return null;
  }
  if (!resp.ok) return null;
  const data = await resp.arrayBuffer();
  console.log(`[http] Static: ${urlPath} -> ${fileUrl} (${data.byteLength} bytes)`);
  return sizedResponse(data, 200, { 'Content-Type': httpMimeFor(fileUrl) });
}

async function tryAdFile(urlPath) {
  const filename = urlPath.split('/').filter(Boolean).pop();
  if (!filename) return null;
  const fileUrl = HTTP_ADS_ROOT + '/' + filename;
  let resp;
  try {
    resp = await fetch(fileUrl, { cache: 'no-store' });
  } catch (e) {
    return null;
  }
  if (!resp.ok) return null;
  const data = await resp.arrayBuffer();
  console.log(`[http] Ad file: ${urlPath} -> ${fileUrl} (${data.byteLength} bytes)`);
  return sizedResponse(data, 200, { 'Content-Type': httpMimeFor(fileUrl) });
}

/**
 * Build a Response that carries an explicit Content-Length.
 *
 * This is not optional. @tcpip/http's response-header builder is:
 *
 *     if (hasBody && !headers.has('content-length') && !headers.has('transfer-encoding'))
 *         headers.push(['transfer-encoding', 'chunked']);
 *
 * -- it has no length parameter at all, unlike its request-side counterpart,
 * and a Response object never populates content-length in .headers by itself.
 * So anything we return without setting it explicitly goes out as HTTP/1.1
 * Transfer-Encoding: chunked.
 *
 * Win95-era clients do not decode chunked bodies: they take the hex chunk-size
 * lines and their CRLFs as part of the payload. Text survives that (the markup
 * still renders, the stray digits are cosmetic), which is why this went
 * unnoticed -- but a GIF handed those extra bytes is simply corrupt, and IE
 * silently drops the image and re-requests it. That is the doubled
 * "[http] proxy -> .../frogfind.gif" line in the log.
 *
 * Strings are encoded here rather than handed to Response as-is, so the length
 * is a byte count and not a UTF-16 code-unit count.
 */
function sizedResponse(body, status, headers) {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const length = bytes instanceof ArrayBuffer ? bytes.byteLength : bytes.length;
  return new Response(bytes, {
    status,
    headers: { ...headers, 'Content-Length': String(length) },
  });
}

function textResponse(body, status = 200, contentType = 'text/plain') {
  return sizedResponse(body, status, { 'Content-Type': contentType });
}

function htmlResponse(body, status = 200) {
  return textResponse(body, status, 'text/html');
}

/**
 * "M/D/YY H:MM AM/PM", the format the client stores at login and prints back
 * in the end-of-game stats box.
 *
 * Month, day and hour are NOT zero-padded; year and minute are. That is what
 * the Python emits (`f"{now.month}/{now.day}/{now.strftime('%y')} "
 * f"{hour_12}:{now.minute:02d} {ampm}"`) and the client is a 1998 binary
 * parsing a fixed format string, so it is copied exactly rather than handed
 * to toLocaleString(), whose output shifts with the browser's locale.
 */
function effectiveDateString(now = new Date()) {
  const hours = now.getHours();
  const hour12 = hours % 12 || 12;
  const ampm = hours < 12 ? 'AM' : 'PM';
  const yy = String(now.getFullYear() % 100).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${now.getMonth() + 1}/${now.getDate()}/${yy} ${hour12}:${mm} ${ampm}`;
}

function loginSuccessResponse(playerName, playerId, sessionId) {
  // Body uses LF-only (\n) line endings -- confirmed from the client's
  // binary format string. HTTP headers are still normal.
  //
  // score, ngames and effective_date were missing here. The client reads them
  // once at login and keeps them for the session, which is why their absence
  // only showed up much later, as blanks in the end-of-game stats box.
  const body =
    `result=0\n` +
    `player_name=${playerName}\n` +
    `player_id=${playerId}\n` +
    `playersession_id=${sessionId}\n` +
    `session_id=${sessionId}\n` +
    // 'Y', not '1'. Get The Picture's validate callback (0x411955 in
    // GetThePicture.exe) scans the reply for a line starting "adult" and then
    // tests exactly one byte:
    //
    //     strncmp(line, "adult", 5) == 0
    //     flag = line[strlen("adult") + 1] == 'Y'     // i.e. the char after '='
    //
    // so "adult=1" reads as FALSE. That flag is what unlocks the room
    // selector's Adult / Keep It Clean tabs (it reaches the screen through
    // 0x405fa9, which gates the two tab controls at +0x8c and +0x90), so with
    // '1' the player silently only ever sees the clean rooms.
    //
    // Safe for the other shows: CosmicConsensus.exe contains no "adult" string
    // at all and ignores the field, and Cosmic's login is answered from
    // static/cgi/bigval0.cgi rather than here anyway.
    `adult=Y\n` +
    `score=1\n` +
    `ngames=2\n` +
    `effective_date=${effectiveDateString()}\n`;
  console.log(`[http] Login OK: ${playerName} id=${playerId} session=${sessionId}`);
  return textResponse(body);
}

function loginFailureResponse(reason = 'Login failed') {
  console.warn(`[http] Login FAILED: ${reason}`);
  return textResponse(`result=1\nerror=${reason}\n`);
}

function handleLogin(params) {
  const playerName = (
    params.get('Name') ||
    params.get('player_name') ||
    params.get('handle') ||
    params.get('username') ||
    ''
  ).trim();

  if (!playerName) {
    console.warn('[http] Login attempt with no player name.');
    return loginFailureResponse('Missing player name');
  }

  if (HTTP_ACCEPT_ANY_LOGIN) {
    pendingHttpLogins.push({ name: playerName, at: Date.now() });
    while (pendingHttpLogins.length && Date.now() - pendingHttpLogins[0].at > 60000)
      pendingHttpLogins.shift();
    if (!httpUsers.has(playerName)) {
      httpUsers.set(playerName, nextHttpPlayerId);
      console.log(`[http] New player: ${playerName} -> id=${nextHttpPlayerId}`);
      nextHttpPlayerId += 1;
    } else {
      console.log(`[http] Returning player: ${playerName} -> id=${httpUsers.get(playerName)}`);
    }
    const playerId = httpUsers.get(playerName);
    const sessionId = playerId * 9 + 12345;
    return loginSuccessResponse(playerName, playerId, sessionId);
  }

  console.warn(`[http] Login rejected (HTTP_ACCEPT_ANY_LOGIN=false): ${playerName}`);
  return loginFailureResponse('Invalid credentials');
}

function handleQuery(params) {
  const playerName = (params.get('Name') || params.get('player_name') || '').trim();
  if (httpUsers.has(playerName)) {
    const playerId = httpUsers.get(playerName);
    const sessionId = playerId * 9 + 12345;
    console.log(`[bezquery] found ${playerName} id=${playerId}`);
    return loginSuccessResponse(playerName, playerId, sessionId);
  }
  console.warn(`[bezquery] unknown player: ${playerName}`);
  return loginFailureResponse('Player not found');
}

function handleChange(params) {
  const playerName = (params.get('Name') || params.get('player_name') || '').trim();
  console.log(`[bezchange] change request for ${playerName}`);
  return textResponse(`result=0\nplayer_name=${playerName}\n`);
}

function handleSponsorsCgi() {
  console.log('[bezsponsors] ad request');
  return textResponse('[Sponsors]\nAd Count = 0\n');
}

function handleSponsors() {
  console.log('[http] SUCCESS: game loaded sponsors page');
  return htmlResponse(
    '<html><body>\n<h1>Welcome to Cosmic Consensus!</h1>\n</body></html>\n'
  );
}

function handleTrouble() {
  console.warn('[http] FAILURE: game loaded trouble page - connection failed somewhere');
  return htmlResponse(
    '<html><body>\n<h1>Connection Trouble</h1>\n' +
      '<p>The game could not connect. Check that the server is running.</p>\n</body></html>\n'
  );
}

async function handleGet(url) {
  // Some legacy game-exe builds send request paths with backslashes
  // instead of forward slashes -- normalize before routing (same fix
  // applied to the Python servers).
  const path = window.sharedHttpServer
    ? window.sharedHttpServer.normalizePath(url.pathname)
    : url.pathname.replace(/\\/g, '/').replace(/^\/+/, '/');
  console.log(`[http] GET ${path}`);

  // The real client requests sponsor ads with a lowercase ".../content/ads/..."
  // path, but the actual folder on disk is capitalized "Ads" (case-sensitive
  // static host). tryAdFile() already always serves from the correctly-cased
  // HTTP_ADS_ROOT regardless of what case the request used, so route ad
  // requests there directly -- otherwise tryStatic() would first attempt the
  // client's literal lowercase path, which is guaranteed to 404 and only
  // spams the console before falling through anyway.
  if (/\/content\/ads\//i.test(path)) {
    const adResp = await tryAdFile(path);
    if (adResp) return adResp;
  }

  const staticResp = await tryStatic(path);
  if (staticResp) return staticResp;

  const adResp = await tryAdFile(path);
  if (adResp) return adResp;

  if (path === '/cosmic/sponsors.html') return handleSponsors();
  if (path === '/cosmic/trouble.html') return handleTrouble();

  console.warn(`[http] Unknown GET path: ${path}`);
  return textResponse('Not found', 404);
}

// The jol*.cgi endpoints are authored files under static/cgi, not something we
// generate. Their real format was only visible once one was read:
//
//   ContentServer=10.0.2.2&ContentServer=10.0.2.2&ContentServerCount=2&Error=100
//
// -- ampersand-separated pairs with a REPEATED ContentServer key, which is why
// the client has no "ContentServer%d" format string. An earlier version of this
// handler synthesised an [Bezerk] INI block instead, which was wrong in every
// particular AND shadowed the real file, so edits to it did nothing.
//
// So: for a POST under /cgi/, serve the file if one exists. Authoring the reply
// stays a matter of editing the file, the way the other jol endpoints already
// work.
async function tryStaticCgi(path) {
  if (!path.startsWith('/cgi/')) return null;
  const resp = await tryStatic(path);
  if (resp) console.log(`[http] POST ${path} answered from static/cgi.`);
  return resp;
}

// Acrophobia's validate reply. Shape and field names are from a real client
// transcript, not inferred -- see the note in handlePost.
function handleAcroLogin(params) {
  const playerName = (params.get('Name') || params.get('Username') || params.get('User') || '').trim();
  if (!playerName) {
    console.warn('[http] Acro login attempt with no player name.');
    return sizedResponse('RetCode=5&Message=User+Name+not+found.', 200, { 'Content-Type': 'text/plain' });
  }
  if (!httpUsers.has(playerName)) {
    httpUsers.set(playerName, nextHttpPlayerId);
    console.log(`[http] New player: ${playerName} -> id=${nextHttpPlayerId}`);
    nextHttpPlayerId += 1;
  }
  const playerId = httpUsers.get(playerName);
  const sessionId = playerId * 9 + 12345;   // same derivation handleLogin uses
  const body = `UserName=${playerName}&UserID=${playerId}&SessionID=${sessionId}&RetCode=0&Message=Success`;
  console.log(`[http] Acro login OK: ${playerName} id=${playerId} session=${sessionId}`);
  return sizedResponse(body, 200, { 'Content-Type': 'text/plain' });
}

async function handlePost(request, url) {
  const path = window.sharedHttpServer
    ? window.sharedHttpServer.normalizePath(url.pathname)
    : url.pathname.replace(/\\/g, '/').replace(/^\/+/, '/');
  const bodyText = await request.text();
  const params = new URLSearchParams(bodyText);
  console.log(`[http] POST ${path} params=${bodyText}`);

  // The client learns its login URL from whichever dispatch.ini it fetched,
  // and different servers publish different ones:
  //   ours                     Validate CGI Name = cgi/acrval0.cgi
  //   cosmicbot.gameshows.lol  Validate CGI Name = big/validate.cgi
  // A client that picked up the remote's dispatch.ini posts to /big/validate.cgi
  // and got "Unknown POST path" here, so the login simply never completed.
  // All of these are the same request with the same fields.
  if (path === '/cgi/bigval0.cgi'
      || path === '/cgi/acrval0.cgi' || path === '/cgi/acrval1.cgi'
      || path === '/cgi/bezreg0.cgi'
      || path === '/cgi/gtpval0.cgi' || path === '/big/validate.cgi') {
    // Cosmic and Acrophobia BOTH post to /cgi/acrval0.cgi, but they want
    // different replies, so the show has to decide -- not the path.
    //   Cosmic       player_name=..&password=..&origin_code=..
    //   Acrophobia   Name=..&Password=..&Show=ACR&Origin=..
    // A real client transcript shows Acrophobia's ValidateCallback accepting
    //   UserID=746&SessionID=6712950&RetCode=0&Message=Success
    // -- ampersand-separated, RetCode not result. Handed Cosmic's newline
    // "result=0\nplayer_name=..." body it reports failure and jumps straight
    // to the dispatch Error Page, which is exactly what /acro/trouble.html
    // being fetched right after a "Login OK" meant.
    const show = (params.get('Show') || params.get('ShowID') || '').toUpperCase();
    if (show === 'ACR') return handleAcroLogin(params);
    return handleLogin(params);
  }
  // YDKJ Net Show's updater asks for the content-server list before it will
  // fetch anything. Evidence, all from the JACK client on win95_d_drive_all.img
  // (C:\Online\Jol\Updater\Common\UpdaterMain.cpp):
  //
  //   "cgi/jolcservers0.cgi"  the POST target
  //   "csv.txt"               the file the reply is saved to
  //   "Bezerk"                adjacent key group, almost certainly the section
  //   "ContentServer" / "ContentServerCount" / "Error"   the keys read back
  //   "eErrorDispatchReplyNotUnderstood"                 what a bad shape gets
  //
  // Note there is NO "ContentServer%d" format string anywhere in the image, so
  // the keys are literal -- one server per reply, not an indexed list. Until a
  // successful run confirms it, the body is dumped verbatim below so the real
  // shape can be read off the log rather than guessed at again.
  // Anything under /cgi/ backed by a real file wins over generated replies --
  // covers jolcservers0/jolend0/jolepisode0/jolinfo0/jolregister0/jolvalidate0
  // without needing a branch each. Checked after the login CGIs above, which
  // are genuinely dynamic.
  const staticCgi = await tryStaticCgi(path);
  if (staticCgi) return staticCgi;

  if (path === '/cgi/bezquery0.cgi') return handleQuery(params);
  if (path === '/cgi/bezchange0.cgi') return handleChange(params);
  if (path === '/cgi-bin/bezsponsors.cgi') return handleSponsorsCgi();

  console.warn(`[http] Unknown POST path: ${path}`);
  return textResponse('Not found', 404);
}

// ── DNS resolver ─────────────────────────────────────────────────────────
// Served on 10.0.2.2:53 by main.js. DHCP has always handed that address out
// as the resolver, but nothing answered on it until now.
//
// Everything resolves to the tap address by default, so any hostname typed
// into a browser inside the VM lands on our own HTTP server rather than
// timing out. That is the whole point: tcpip.js terminates connections in
// JavaScript and the browser cannot open raw sockets to the real internet,
// so there is nothing else for a name to usefully point at. Names needing a
// different answer go in DNS_STATIC.
const DNS_TAP_ADDRESS = '10.0.2.2';
const DNS_TTL_SECONDS = 300;
const DNS_STATIC = {
  // 'example.local': '10.0.2.2',
};

function cosmicDnsHandler(query) {
  const name = String(query && query.name || '').toLowerCase().replace(/\.$/, '');
  const type = query && query.type;

  // Only A is answerable. Returning undefined yields NXDOMAIN, which is what
  // we want for AAAA -- a Win95-era stack then falls back to IPv4 instead of
  // waiting on an IPv6 answer that could never route anywhere.
  if (type !== 'A') {
    console.log(`[dns] ${type} ${name} -> NXDOMAIN (only A is served)`);
    return undefined;
  }

  const ip = DNS_STATIC[name] || DNS_TAP_ADDRESS;
  console.log(`[dns] A ${name} -> ${ip}`);
  return { type: 'A', ttl: DNS_TTL_SECONDS, ip };
}

// Hosts served by fetching the real site, rather than from our own routes.
// @tcpip/http builds request.url from the Host header, so this is the name the
// browser inside the VM actually typed.
//
// FrogFind is a gateway in its own right: it fetches the target page, strips
// it to markup a 1995 browser can render, and rewrites every link to stay on
// frogfind.com. So allowlisting this one host is enough to reach the wider web
// -- no other name needs to be proxied for browsing to work.
const PROXY_HOSTS = new Set(['frogfind.com', 'www.frogfind.com', 'cosmicbot.gameshows.lol']);

// ── remote game server ─────────────────────────────────────────────────────
//
// Set this and the VM stops playing against the server in this file and plays
// against a real one instead. Everything the client does is forwarded:
//
//   IRC  :6666 -> a WebSocket to webserver.py's /ws relay, which makes the
//                 actual TCP connection. A browser cannot open a raw socket,
//                 and /proxy cannot carry IRC (one fetch, one response, while
//                 IRC is a long-lived stream the server pushes into), so the
//                 relay is the only route.
//   HTTP :80   -> /proxy, when proxyHttp is on, so the dispatch/login
//                 round-trip lands on the remote server too.
//
// DNS already answers every name with the tap address, so the VM reaches us
// either way and this decides what happens next. Room BIR lines coming back
// from the remote server name its own address, which also resolves to the tap
// -- so the client's follow-up connection lands here and gets relayed as well.
//
// null = play locally, which is the default.
// null = play against the server in this file. This is the default.
//
// Uncomment the block below to play against the real server instead. The relay
// works -- it carries a full lobby + game handshake and the client reaches the
// ad -- but it cannot get past a client-side deadline of roughly 60 s for
// reaching RR. The emulated 386 needs ~17 s longer than native Wine to render
// the tutorial and ad, so it misses a window Wine clears with 8 s to spare,
// and the game then tears down BOTH sockets within 0.1 s of each other.
//
// That is an emulator speed problem, not a protocol or relay one: the client
// is not waiting on anything we could send. Measured 2026-07-31 --
//     Wine:  AI +27.0s -> RR +51.3s   (plays)
//     ours:  AI +44.6s -> abort 59.4s (never reaches RR)
//
// ircHost is separate from host on purpose: that deployment serves HTTP from
// cosmicbot.gameshows.lol but runs the game server on the ORIGINAL 1998
// address, which is still up and still answers registration:
//     :137.66.45.53 001 <nick> :Welcome to Cosmic Consensus, <nick>
// cosmicbot.gameshows.lol:6666 accepts a connection and then resets it.
const REMOTE_GAME_SERVER = null;
// const REMOTE_GAME_SERVER = {
//   host: 'cosmicbot.gameshows.lol',   // HTTP
//   httpPort: 80,
//   proxyHttp: true,
//   ircHost: '137.66.45.53',           // the game server itself
//   ircPort: 6666,
// };

/**
 * Pipe one VM game connection to the remote server over the /ws relay.
 *
 * Both directions are raw bytes; nothing here parses IRC. The point is to be
 * transparent, so the client sees exactly what the real server sends -- which
 * is what makes this usable as an A/B test against our own implementation.
 */
let relaySeq = 0;

/**
 * Split on newlines, keeping each "\n" attached to the line before it.
 *
 * This was `.split(/(?<=\n)/)`. Lookbehind is ES2018 and Safari only gained
 * it in 16.4 -- and because it is a regex LITERAL the failure is at parse
 * time, so the whole of cosmic-server.js was rejected on an older iOS rather
 * than just this one function misbehaving. The game server simply did not
 * exist there, which is a very large consequence for a line in the relay path
 * that is not even reachable while REMOTE_GAME_SERVER is null.
 */
function splitKeepingNewlines(text) {
  const parts = text.split('\n');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const piece = last ? parts[i] : parts[i] + '\n';
    if (piece !== '') out.push(piece);
  }
  return out;
}

async function relayGameConnection(conn) {
  const cfg = REMOTE_GAME_SERVER;
  // Two relays run at once -- the lobby socket and the game socket -- and
  // untagged logs made it impossible to tell which one did what, or which
  // closed first. The nick is picked up from the client's own NICK line.
  const rid = ++relaySeq;
  // Seconds since this relay opened, on every line. The tcpdump was decisive
  // precisely because it had timestamps -- ours did not, so we could not tell
  // a client that waited 24 s from one that gave up instantly.
  const t0 = Date.now();
  const at = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  let tag = `#${rid}`;
  const wsOrigin = PROXY_ORIGIN.replace(/^http/, 'ws');
  const ircHost = cfg.ircHost || cfg.host;
  const url = `${wsOrigin}/ws?host=${encodeURIComponent(ircHost)}&port=${cfg.ircPort}`;
  console.log(`[relay ${tag}] ${at()} connecting -> ${ircHost}:${cfg.ircPort}`);

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const writer = conn.writable.getWriter();

  try {
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`relay refused (is webserver.py running, and is ${ircHost} in RELAY_ALLOWED_HOSTS?)`));
    });
  } catch (e) {
    console.error(`[relay] ${e.message}`);
    writer.releaseLock();
    await conn.close().catch(() => {});
    return;
  }

  // One rewriter per direction: each keeps its own partial-line buffer.
  const inbound = makeRelayRewriter(ircHost, DNS_TAP_ADDRESS);
  const outbound = makeRelayRewriter(ircHost, DNS_TAP_ADDRESS);

  // Idle keepalive -- see RELAY_KEEPALIVE_MS.
  let idleTimer = null;
  const armIdleKeepalive = () => {
    if (idleTimer !== null) return;
    console.log(`[relay ${tag}] ${at()} arming idle keepalive every ${RELAY_KEEPALIVE_MS / 1000}s`);
    let sent = 0;
    idleTimer = setInterval(() => {
      if (closed) return;
      sent += 1;
      // Errors were swallowed here, which made a failing keepalive
      // indistinguishable from a working one -- the exact thing we are trying
      // to measure. Log both the beat and any failure.
      Promise.resolve(writer.write(encodeCp1252(RELAY_KEEPALIVE_PAYLOAD)))
        .then(() => {
          if (LOG_RELAY_TRAFFIC) console.log(`[relay ${tag}] ${at()} keepalive #${sent} written`);
        })
        .catch((e) => {
          console.log(`[relay ${tag}] ${at()} keepalive #${sent} FAILED: ${e}`);
        });
    }, RELAY_KEEPALIVE_MS);
  };
  const disarmIdleKeepalive = () => {
    if (idleTimer !== null) { clearInterval(idleTimer); idleTimer = null; }
  };

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    disarmIdleKeepalive();
    try { ws.close(); } catch (e) { /* already closing */ }
    Promise.resolve(conn.close()).catch(() => {});
  };

  // Armed for the whole connection, and only now that `closed` and shutdown()
  // exist for it to consult. An empty line is inert, so unlike a PING there is
  // no window it has to avoid -- and the ad/tutorial stretch is the longest
  // idle period of all.
  armIdleKeepalive();

  // remote -> VM
  ws.onmessage = (ev) => {
    const out = inbound.push(new Uint8Array(ev.data), false);
    if (!out) return;                       // partial line, wait for the rest
    if (LOG_RELAY_TRAFFIC) console.log(`RECV [relay ${tag}] ${at()}: ${relayText(out)}`);
    Promise.resolve(writer.write(out)).catch(shutdown);
  };
  ws.onclose = () => {
    // Anything the server sent without a trailing newline is still buffered.
    const tail = inbound.flush(false);
    if (tail) {
      if (LOG_RELAY_TRAFFIC) console.log(`RECV [relay ${tag}] ${at()} (tail): ${relayText(tail)}`);
      Promise.resolve(writer.write(tail)).catch(() => {});
    }
    console.log(`[relay ${tag}] ${at()} REMOTE closed the connection`);
    shutdown();
  };
  ws.onerror = shutdown;

  // VM -> remote
  try {
    for await (const chunk of conn) {
      if (closed) break;
      const raw = outbound.push(chunk, true);
      if (!raw) continue;                   // partial line, wait for the rest

      // Drop the client's replies to OUR keepalive: the real server never sent
      // that PING and would be answering a question it did not ask. Matched on
      // the token, so the server's own PING/PONG passes through untouched.
      const kaPong = new RegExp(`^PONG\\s+:?${RELAY_KEEPALIVE_TOKEN}$`, 'i');
      const text = splitKeepingNewlines(RELAY_DECODER.decode(raw))
        .filter((l) => !kaPong.test(l.trim()))
        .join('');

      // Learn the nick so both sockets are distinguishable in the log.
      const nick = text.match(/\bNICK\s+(\S+)/);
      if (nick) tag = `#${rid} ${nick[1]}`;
      if (!text) continue;                  // nothing left but our own PONGs
      const outBytes = encodeCp1252(text);
      if (LOG_RELAY_TRAFFIC) console.log(`SEND [relay ${tag}] ${at()}: ${relayText(outBytes)}`);
      ws.send(outBytes);
    }
  } catch (e) {
    if (!closed) console.log(`[relay ${tag}] ${at()} VM side errored: ${e}`);
  } finally {
    // Log it too: a final line held in the buffer when the socket closed is
    // exactly the kind of thing we would be hunting for, and sending it
    // silently made this a blind spot.
    const tail = outbound.flush(true);
    if (tail) {
      console.log(`SEND [relay ${tag}] ${at()} (tail at close): ${relayText(tail)}`);
      try { ws.send(tail); } catch (e) { /* already closing */ }
    }
    writer.releaseLock();
    console.log(`[relay ${tag}] ${at()} CLIENT closed its end`);
    shutdown();
  }
}

// Mirror relayed traffic into the log. On by default: the entire reason for
// pointing at a real server is to see what it sends.
const LOG_RELAY_TRAFFIC = true;

// ── relay idle keepalive ───────────────────────────────────────────────────
//
// The real server keeps its TCP connection warm with bare keepalive probes
// every ~5 s. A tcpdump of a WORKING client shows the decisive stretch:
//
//   19:52:00.114899  Out  AI -1 Ad ike212.srf ike212.srf 0
//   19:52:02.927479  In   Flags [.], ack 249, length 0     <- keepalive
//   19:52:07.961040  In   Flags [.], ack 249, length 0
//   ... every ~5 s ...
//   19:52:24.435700  Out  RR                               <- 24 s later
//
// The client sits idle for 24 SECONDS after AI before asking to start. Those
// probes carry no payload, so a WebSocket relay has nothing to forward and the
// VM's socket goes completely silent for ~45 s across the ad and that wait --
// at which point the client gives up and loads trouble.html. Against our own
// server this never showed, because we send ADLB/ADLI/ADLE and then QT during
// the same window, so the connection is never idle.
//
// So the relay generates its own traffic. Two constraints shape it:
//
//   * NOT during the ad window. A PING landing between SPA and AI is fatal --
//     the same trap the Python's kaloop guards with ad_ack_pending, and it
//     cost us several rounds earlier. Only arm once AI has gone by.
//   * The reply must NOT reach the real server, which never sent the PING. A
//     distinctive token makes the client's echo unambiguous to identify and
//     swallow, while the real server's own PING/PONG passes through untouched.
const RELAY_KEEPALIVE_MS = 5000;
// A bare CRLF, not a PING.
//
// The window that needs warming is the ad/tutorial stretch -- skipping the
// tutorial quickly gets past it, dawdling does not -- and that is precisely
// where an IRC PING is fatal: one landing between SPA and AI is what killed
// the client earlier, and the Python guards the same window with
// ad_ack_pending. The real server sends no application data there either;
// only TCP-level probes, which is what we cannot reproduce.
//
// RFC 1459: "Empty messages are silently ignored." So an empty line puts bytes
// on the wire -- keeping the VM's TCP connection from going idle -- without
// being a command the client has to answer or even notice. Nothing comes back,
// so there is no reply to filter out either.
const RELAY_KEEPALIVE_PAYLOAD = '\r\n';
// Kept for the PONG filter below: if the empty line ever proves unsafe with
// this client, switching back to `PING :${RELAY_KEEPALIVE_TOKEN}` restores the
// previous behaviour and the filter is already in place for it.
const RELAY_KEEPALIVE_TOKEN = 'relay-keepalive';
// Same encoding the game socket uses everywhere else; see loadTextFile().
const RELAY_DECODER = new TextDecoder('windows-1252');

/**
 * Swap the remote's address for ours as traffic crosses the relay.
 *
 * The room list carries the game server's address in each BIR entry:
 *     RI 0 BIR 0 0 1 R Big Idea Demo 137.66.45.53 6666 Big_000 CosmicBot 0 -1 0
 * and that is what the client dials when a room is picked. It is a bare IP, so
 * no DNS lookup happens, our resolver never sees it, and the VM cannot route
 * there -- the connection dies right after RE, exactly as dispatch.ini did one
 * layer up. Rewriting it to the tap sends the client back to our own listener,
 * which relays onward.
 *
 * Rewritten in BOTH directions so the substitution is invisible: the server's
 * "PING :137.66.45.53" reaches the client as ours, and the client's
 * "PONG :10.0.2.2" is restored before it goes back out.
 *
 * Buffered by line rather than applied per chunk, because TCP may split a
 * message anywhere -- including through the middle of the address.
 */
function makeRelayRewriter(remoteAddr, localAddr) {
  // encodeCp1252, NOT TextEncoder: the stream is decoded as windows-1252, so
  // re-encoding as UTF-8 turns every byte >= 0x80 into two or three. Pure
  // ASCII survives that, which is why the handshake looked fine, but any
  // question or answer text with a curly quote or accent would be silently
  // corrupted and the byte count would no longer match.
  let pending = '';
  const from = new RegExp(remoteAddr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const to = new RegExp(localAddr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return {
    /** bytes in -> bytes out, holding back any incomplete trailing line */
    push(bytes, reverse) {
      pending += RELAY_DECODER.decode(bytes);
      const cut = pending.lastIndexOf('\n');
      if (cut === -1) return null;             // nothing complete yet
      const whole = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      const swapped = reverse ? whole.replace(to, remoteAddr) : whole.replace(from, localAddr);
      return encodeCp1252(swapped);
    },
    /** anything still buffered, e.g. a server that never sends a final newline */
    flush(reverse) {
      if (!pending) return null;
      const rest = pending;
      pending = '';
      const swapped = reverse ? rest.replace(to, remoteAddr) : rest.replace(from, localAddr);
      return encodeCp1252(swapped);
    },
  };
}
const relayText = (bytes) => RELAY_DECODER.decode(bytes).replace(/\r\n/g, ' | ').trim();

// Where webserver.py serves the release directory.
//
// Taken from the page's own origin rather than hardcoded, because the whole
// point is for /proxy to be SAME-ORIGIN: hardcoding localhost:8000 would turn
// it cross-origin the moment the page is opened as 127.0.0.1 or via a LAN
// address, and the fetch would be blocked by CORS -- the exact problem the
// proxy exists to avoid.
const PROXY_ORIGIN = (typeof window !== 'undefined' && window.location && window.location.origin)
  ? window.location.origin
  : 'http://localhost:8000';

/**
 * The dispatch.ini we hand the client in remote mode.
 *
 * Serving our own rather than proxying theirs, because theirs names the game
 * server as a BARE IP ("IRC Server Name = 137.66.45.53"). A bare IP means the
 * client never does a DNS lookup, so our catch-all resolver never sees it, the
 * VM tries to route straight there, and the client dies at "connecting to
 * lobby" without the relay ever being asked for anything.
 *
 * Built from REMOTE_GAME_SERVER so there is one source of truth: change the
 * host there and this follows. The shape is the remote's own file.
 *
 *   IRC  -> the tap address, i.e. our listener, which relayGameConnection
 *           forwards to REMOTE_GAME_SERVER.ircHost
 *   HTTP -> left as the remote's hostname, so content and the login POST are
 *           proxied out to the real server as before
 */
function remoteDispatchIni() {
  const cfg = REMOTE_GAME_SERVER;
  const httpHost = cfg.host;
  const httpPort = cfg.httpPort || 80;
  return [
    '[Dispatch File]',
    'File Version       = 1.0',
    'Show ID            = BIG',
    "Show Name          = What's the Big Idea / Cosmic Consensus",
    '',
    'Update Script Server Path   = /bigidea/content/UpdateScript.ini',
    'BOB Update Script Server Path   = /bigidea/content/UpdateScript.ini',
    'Content Server Section      = Content Server',
    'Game List Server Section    = Game List Server',
    '',
    'Register CGI Name           = cgi/bezreg0.cgi',
    'Validate CGI Name           = big/validate.cgi',
    'Change CGI Name             = cgi/bezchange0.cgi',
    '',
    'Registration Server Section = Registration Server',
    'Web Server Section          = Web Server',
    '',
    '[Content Server 1]',
    `HTTP Server Name     = ${httpHost}`,
    `HTTP Server Port     = ${httpPort}`,
    '',
    '[Game List Server 1]',
    // The whole point: our own listener, not the remote's bare IP.
    `IRC Server Name      = ${DNS_TAP_ADDRESS}`,
    `IRC Server Port      = ${cfg.ircPort || 6666}`,
    'IRC Server Password  =',
    'IRC Channel Name     = Big_List',
    'IRC Channel Password =',
    'IRC Bot Nickname     = CosmicBot',
    '',
    '[Registration Server 1]',
    `HTTP Server Name     = ${httpHost}`,
    `HTTP Server Port     = ${httpPort}`,
    '',
    '[Web Server]',
    `HTTP Server Name     = ${httpHost}`,
    `HTTP Server Port     = ${httpPort}`,
    'Sponsors CGI         = cgi/sponsors.cgi',
    'Success Page         = /bigidea/sponsors.html',
    'Error Page           = /bigidea/trouble.html',
    '',
  ].join('\n');
}

async function proxyExternal(url, request = null) {
  const target = url.toString();
  const via = `${PROXY_ORIGIN}/proxy?url=${encodeURIComponent(target)}`;
  // Method and body are forwarded, not just the URL: the game logs in with
  // POST /cgi/acrval0.cgi, so a GET-only proxy could fetch a remote server's
  // static files but never complete a handshake with it.
  const method = request ? request.method : 'GET';
  const init = { method };
  if (request && method !== 'GET' && method !== 'HEAD') {
    init.body = await request.arrayBuffer();
    const ctype = request.headers.get('Content-Type');
    if (ctype) init.headers = { 'Content-Type': ctype };
  }
  console.log(`[http] proxy ${method} -> ${target}`);
  try {
    const resp = await fetch(via, init);
    const body = await resp.arrayBuffer();
    return sizedResponse(body, resp.status, {
      // Guess from the extension when upstream sends none. Defaulting to
      // text/html mislabels the game's binary .srf ads, which our own server
      // serves as application/octet-stream -- see guess_content_type() in
      // webserver.py, which does the same thing one hop earlier.
      'Content-Type': resp.headers.get('Content-Type') || httpMimeFor(url.pathname),
    });
  } catch (e) {
    console.error(`[http] proxy failed for ${target}:`, e);
    return textResponse(
      `Could not reach ${url.hostname}.\n\n` +
      `The proxy runs in webserver.py -- check it is running on port 8000 ` +
      `and that ${url.hostname} is in its PROXY_ALLOWED_HOSTS.`,
      502
    );
  }
}

async function cosmicHttpHandler(request) {
  let url = new URL(request.url);
  // Keep all game profiles tolerant of the double-slash paths emitted by
  // some Win95 HTTP clients.  The URL object preserves those slashes.
  const normalizedPath = window.sharedHttpServer
    ? window.sharedHttpServer.normalizePath(url.pathname)
    : url.pathname.replace(/^\/+/, '/');
  if (normalizedPath !== url.pathname) {
    url.pathname = normalizedPath;
  }
  try {
    // BEFORE the host check: the client asks for dispatch.ini with the
    // REMOTE's hostname, so a Host-based proxy rule would forward it and we
    // would never get to substitute ours. This is the one file that must not
    // come from the remote -- see remoteDispatchIni() for why.
    if (REMOTE_GAME_SERVER && /(^|\/)dispatch[^/]*\.ini$/i.test(url.pathname)) {
      console.log(`[http] serving our own ${url.pathname} (IRC -> ${DNS_TAP_ADDRESS}:${REMOTE_GAME_SERVER.ircPort || 6666}, relayed to ${REMOTE_GAME_SERVER.ircHost || REMOTE_GAME_SERVER.host})`);
      return textResponse(remoteDispatchIni());
    }
    // Ads come from our own copies even in remote mode. Proxying them adds a
    // round trip to the far side for ~90 KB per ad, where local mode answers
    // from disk immediately -- and local mode is the path we KNOW this client
    // completes. Same files either way: all 18 were verified byte-identical
    // to what the remote serves.
    if (REMOTE_GAME_SERVER && request.method === 'GET' && /\/ads?\//i.test(url.pathname)) {
      const local = await tryAdFile(url.pathname);
      if (local) return local;
      console.log(`[http] ad ${url.pathname} not held locally -- falling through to the proxy`);
    }
    // Host-based routing next: a request for frogfind.com is not one of
    // our own paths, and matching on path alone would 404 it.
    if (PROXY_HOSTS.has(url.hostname.toLowerCase())) {
      return await proxyExternal(url, request);
    }
    // Remote mode with proxyHttp: the game's own routes go upstream too, so
    // dispatch2.ini and the /cgi login land on the real server rather than
    // being answered from static/ here.
    if (REMOTE_GAME_SERVER && REMOTE_GAME_SERVER.proxyHttp) {
      const port = REMOTE_GAME_SERVER.httpPort || 80;
      const upstream = new URL(
        url.pathname + url.search,
        `http://${REMOTE_GAME_SERVER.host}${port === 80 ? '' : ':' + port}`
      );
      return await proxyExternal(upstream, request);
    }
    if (request.method === 'GET') return await handleGet(url);
    if (request.method === 'POST') return await handlePost(request, url);
    return textResponse('Method not allowed', 405);
  } catch (e) {
    console.error(`[http] Unhandled error processing ${request.method} ${request.url}:`, e);
    return textResponse('Internal Server Error', 500);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// IRC-style game socket (port of the Client class)
//
// STATUS: installment 2 -- the full pyramid-game round loop is now ported:
// board generation/movement/step themes, question bank loading, the
// question -> answer -> reveal -> results -> advance cycle, segment
// start/end, and the blowout bonus round at the top of the pyramid.
//
// The storm system (runStormSequence / BI insurance) is ported but gated
// off by STORM_SYSTEM_ENABLED, matching the Python: its wire format was
// never confirmed against a real capture and the Python's own comment says
// it "currently crashes the client". The console's STORM command runs it on
// demand, which is how those field shapes can be probed without turning it
// on for live games.
// ═══════════════════════════════════════════════════════════════════════

// ── game constants (ported from the Python module-level config) ─────────

const PLAYER_NAMES = [
  'Player', 'SecondSight', 'GruffTech', 'Franklin', 'Aaron',
  'Chay', 'Frank#2', 'Dana', 'Mehar', 'Shaurya',
];
// Bot fill for a room's empty slots: PLAYER_NAMES minus the slot-0 placeholder,
// which is always replaced by the first human's name.
//
// Bots are taken from the front of this list (see makeRoomNames), so whatever
// is first here lands in the first bot slot, right after the human. With a
// 10-slot room and one human only the first 9 are ever used.
const BOT_NAMES = ['NonaSuomy', ...PLAYER_NAMES.slice(1)];
const MAX_GAME_PLAYERS = 100; // matches Python -- roster cap, not the bot count
const MIN_BOTS_PER_ROOM = 9;

// Per-room configuration. Any Big_XXX channel the client JOINs becomes a live
// room; rooms not listed here inherit ROOM_DEFAULT_CONFIG.
const ROOM_CONFIGS = {
  Big_000: { minBots: MIN_BOTS_PER_ROOM, display: 'Cosmic Consensus', minPlayersToStart: 1 },
  Big_001: { minBots: 0, display: 'No Bots', minPlayersToStart: 5 },
};
const ROOM_DEFAULT_CONFIG = { minBots: MIN_BOTS_PER_ROOM, display: 'Cosmic Consensus', minPlayersToStart: 1 };

/**
 * Build a BIR info string.
 *   BIR <lock> <step> <b> R <display> <ip> <port> <channel> <bot> <players> <status> 0
 * display uses underscores (the client parses by whitespace) and <channel> is
 * what the client sends back as the JOIN target.
 */
function makeBirLine(roomName, displayName = '', opts = {}) {
  const { lock = 0, step = 0, b = 1, players = 0, status = -1 } = opts;
  const dn = (displayName || roomName).replace(/ /g, '_');
  return `BIR ${lock} ${step} ${b} R ${dn} ${SERVER_NAME} ${GAME_PORT} ${roomName} ${BOT_NICK} ${players} ${status} 0`;
}

const MAX_ANSWER_SLOTS = 4;
const USE_ONLY_FOUR_ANSWER_QUESTIONS = false;

// Live game connections, so the lobby's room selector can report real
// occupancy instead of the hardcoded 0 this used to send.
//
// NOTE: unlike cosmic_v64_web.py there is no shared GameRoom here -- every
// client runs its own private board with its own bot fill. So `humans` is
// genuinely "people connected and in-game" and `total` adds the bot roster of a
// game that has started; there is no single shared roster to count.
const liveGameClients = new Set();

function roomOccupancy(roomName = 'Big_000') {
  const room = rooms.get(roomName);
  if (!room) return { humans: 0, total: 0 };
  return { humans: room.humanCount(), total: room.currentPlayerNames().length };
}

// BIR line for the default room, used for the initial handshake before the
// client has picked anything -- must point at the tap interface address and
// game port, not the guest's own DHCP-leased address.
//
// Field meanings come from CosmicBotlol013MysteryDoubleorNothing...: when a
// second human joined mid-game the RU went from "BIR 1 5 0 ... CosmicBot 10"
// to "BIR 2 10 0 ... CosmicBot 11", so field 1 is the HUMAN count and the
// field after the bot nick is TOTAL occupancy.
function roomInfoLine(roomName = 'Big_000') {
  const room = rooms.get(roomName);
  if (room) return room.roomInfoLine;
  const cfg = ROOM_CONFIGS[roomName] || ROOM_DEFAULT_CONFIG;
  return makeBirLine(roomName, cfg.display, { b: cfg.minPlayersToStart });
}

/**
 * Push fresh room-occupancy counts to everyone still sitting in the lobby.
 *
 * The selector is only populated once, from the RB/RI/RE burst in handleRR, so
 * without this a waiting client never sees a count change. RU carries the same
 * BIR payload as the RI entry, which is how the reference does it.
 *
 * roomName limits the update to one room; omit it to refresh every known room,
 * which is what a room going away needs -- its GameRoom is already gone by
 * then, so there is nothing left to ask for a count.
 */
/**
 * Refresh the lobby roster panel on every client still in the selector.
 *
 * Called whenever the lobby membership changes, so waiting clients see people
 * arrive and leave without having to re-request RR.
 */
function broadcastLobbyPlayerList() {
  const waiting = [...liveGameClients].filter((c) => c.connected && c.username && c.ingame === 0);
  for (const client of waiting) {
    Promise.resolve((async () => {
      await client.botPriv(client.clientIrcName, `PLB ${waiting.length}`);
      for (let i = 0; i < waiting.length; i++) {
        await client.botPriv(client.clientIrcName, `PLI ${i} BIP 0 0 0 P ${waiting[i].username}`);
      }
      await client.botPriv(client.clientIrcName, 'PLE');
    })()).catch(() => {});
  }
}

function broadcastRoomListUpdate(roomName = null) {
  const watchers = [...liveGameClients].filter((c) => c.connected && c.ingame === 0 && c.username);
  if (!watchers.length) return;
  const names = roomName
    ? [roomName]
    : [...new Set([...Object.keys(ROOM_CONFIGS), ...rooms.keys()])];
  for (const rname of names) {
    const line = `RU ${roomInfoLine(rname)}`;
    for (const c of watchers) {
      Promise.resolve(c.botPriv(c.clientIrcName, line)).catch(() => {});
    }
  }
}

// ── single-word (open-ended) questions ─────────────────────────────────────
//
// A one-blank fill-in question -- "BELLY _________" -- where the client draws
// a text box instead of answer buttons and the player types a word.
//
// The wire form comes from the genuine server's own vocabulary. Across both
// reference captures it only ever sends four QT layouts:
//
//     QT 1 0   2 answers        QT 3 2   4 answers
//     QT 2 1   3 answers        QT 6 4   open-ended, 3 blanks (the Blowout)
//
// so QT_I1 is the STEPS ON OFFER and QT_I2 is the answer layout. The Blowout's
// three blanks pay 3+2+1 = 6, which is why it sends 6. One blank pays 1, and
// the single-blank layout is 3 -- hence "QT 1 3 <dur> <text>".
//
// QT_I1 must stay 1/2/3 for the MULTIPLE-CHOICE layouts, which load a
// 1step/2steps/3steps.srf graphic from it; the open-ended layouts (3 and 4)
// don't, which is how the Blowout gets away with 6.
const SINGLE_WORD_QUESTIONS_ENABLED = true;
// Share of ordinary rounds that use a single-word question, when any are
// loaded. Kept a minority: they are a change of pace, not the main game.
const SINGLE_WORD_QUESTION_CHANCE = 0.25;
// Force the FIRST question of every segment to be a single-word one. On for
// testing -- it makes the format reachable immediately instead of waiting on
// SINGLE_WORD_QUESTION_CHANCE to land. Set false for normal play.
// Send QT/QATB/QATI/QATE immediately before ST+QS rather than ~10 s earlier,
// right after ADLE. Only affects round 1 of a segment; see sendQuestion().
const QT_AFTER_PYRAMID_BUILD = true;
const FORCE_FIRST_QUESTION_SINGLE_WORD = true;
// true  -> send single-word rounds as open-ended text entry (QT step 1, mode 4)
// false -> send them as an ordinary 3-answer multiple choice, using the house
//          answers from qanda.txt. Diagnostic: the open-ended round is not
//          drawing, and this is the one switch that tells us whether the cause
//          is the open-ended layout or the question itself.
const SINGLE_WORD_OPEN_ENDED = true;
// Open-ended (text-entry) layout. 3 and 4 are BOTH open-ended and the Question
// ctor accepts either here, but they are two different SCREENS:
//
//     3 = ordinary fill-in-the-blank   (what we want)
//     4 = the Blowout                  (the end-of-game round)
//
// Sending 4 drew every single-word question with the Blowout's framing. The
// step ranges in assertValidQt() are the tell: mode 3 stops at 3 steps, mode 4
// goes to 6, because only the Blowout awards 3+2+1 across three blanks.
const SINGLE_WORD_QT_BUTTON_MODE = 3;
// Steps on offer, QT field 0. Also how far ahead the client previews the
// board: the warning banner walks tiles position+1 .. position+step looking
// for STUN / STICKY / MYSTERY / DOUBLE OR NOTHING / BLACK HOLE. Must stay
// within 1-3 while the mode above is 3 -- see assertValidQt().
const SINGLE_WORD_QT_STEP = 2;
// Steps actually awarded, the trailing field of ARI. Keep in step with
// SINGLE_WORD_QT_STEP: the QT value is what the player is shown they are
// playing for, this is what they get.
const SINGLE_WORD_ANSWER_STEPS = 2;

let SINGLE_WORD_QUESTIONS = [];

const PROTOTYPE_BONUS_QUESTION = {
  category: 3,
  time: 40,
  reveal_ms: 40000,
  text:
    'If I could speedrun my life, I would skip the _________, glitch through ' +
    'the _________, and immediately collect the _________.',
  answers: ['Titanic', 'joystick', 'musical'],
  weights: [22, 11, 22],
  answer_steps: [3, 2, 1],
  correct: 0,
  prototype_raw_percents: true,
  prototype_qt_step: 3,
  prototype_qt_button_mode: 4,
  prototype_result_index: 3,
  prototype_result_roster_count: 9,
  is_blowout: true,
};

// Per-board caps on each special tile type, plus the ceiling on how many IQ
// tiles may carry a negative value. Without these the board generator happily
// produced several Black Holes, runs of adjacent specials and an unbounded
// number of negative steps -- see generateBoard().
const MAX_BLACK_HOLE = 1;
const MAX_STUN = 2;
const MAX_MYSTERY_TILES = 1; // applied to each hidden flavour independently
const MAX_TURBO_TILES = 3;
const MAX_DON = 1; // Double-or-Nothing
const MAX_STICKY = 1;
const MAX_NEGATIVE_SLOTS = 4;

const PYRAMID_TOP_STEP = 20;
const PYRAMID_BONUS_STEPS = 3;
const PYRAMID_MAX_STEP = PYRAMID_TOP_STEP + PYRAMID_BONUS_STEPS;
const PYRAMID_WIRE_MAX_STEP = PYRAMID_TOP_STEP;
const RESULTS_TO_NEXT_DELAY_SECONDS = 10;
// Short delay before the end-of-segment blowout, so RU+BS reaches the client
// while it is still in its QRS animation / result state -- that window is under
// 7 s, and the full RESULTS_TO_NEXT_DELAY_SECONDS misses it entirely.
const BLOWOUT_TRIGGER_DELAY_SECONDS = 2;
const BLOWOUT_EXPLOSION_SECONDS = 4; // eslint-disable-line no-unused-vars -- superseded by BLOWOUT_POST_BS_ADBREAK_SECONDS
const ADSEGUE_BUMPER_SECONDS = 2.5; // eslint-disable-line no-unused-vars -- the BS->EGS->SA bumper was disproven
// Gap between the BS explosion and the blowout ad break.
const BLOWOUT_POST_BS_ADBREAK_SECONDS = 40;
// BS duration covers the whole blowout window (ads + question + result + EGS).
const BLOWOUT_BS_WINDOW_MS = 600000;
const BLOWOUT_AD_ACK_TIMEOUT_SECONDS = 52; // matches Python; 35 gave up too early
const COMMAND_LAB_MODE = false;
const AUTO_INCLUDE_PRS = true;
const QUESTION_PACKET_MODE = 'QT'; // QT, QT_PLUS_AQ, or AQ_ONLY
const CLEAR_UNUSED_ANSWER_SLOTS = false;
const CLEAR_UNUSED_RESULT_SLOTS = false;
const AVOID_FINAL_SLOT_CONSENSUS_WINNER = true;

// FALSE, matching cosmic_v64_web.py. When true this adds a second IQ award on
// top of the tile IQ every single round -- PROTOTYPE_BIP_DELTAS is up to 55 per
// player per question -- so scores inflate far beyond anything the Python
// server produces. That is the "wonky large numbers" at the end of a round.
const PROTOTYPE_MOVEMENT_EXPERIMENT = false;
// Superseded by sendClimbSequence, which derives the extra movement frames
// from the reference capture instead of guessing at them. All three are
// unreferenced now; kept so older notes mentioning them still resolve.
const PROTOTYPE_SECOND_MOVEMENT_LIST = false; // eslint-disable-line no-unused-vars
const PROTOTYPE_SECOND_PRS_TRIGGER = false; // eslint-disable-line no-unused-vars
const PROTOTYPE_PRS_PACKET = 'PRS 0 S 0 0 0 0 0'; // eslint-disable-line no-unused-vars
const PROTOTYPE_BIP_DELTAS = [0, 10, 25, 30, 55];

const V008_ACTIVATION_MERGE = true;
const V008_QS_DURATION_MS = 20000;

// ── animation timing, ported from cosmic_v64_web.py ──────────────────────────
// All of these were measured off the CosmicBotlol013 reference captures; see
// the Python source for the per-value derivations.
const NGS_BUILD_DURATION_MS = 12000;

// NGS_BUILD_DURATION_MS is how long the build takes in the CLIENT's time. We
// wait it out on OUR wall clock, which is only the same thing when the VM is
// keeping up. When it is not -- and the emulated 386 often is not, especially
// on a second segment where the old pyramid has to unload first -- the client
// is still animating when our timer expires, the question lands mid-build, and
// it is discarded exactly as it was before QT_AFTER_PYRAMID_BUILD.
//
// So: a flat margin, plus a probe. After the nominal build we PING and wait for
// the PONG. A client that is still busy answers late, which stretches the wait
// by however much it is actually behind -- no guessing at a fixed number, and
// nothing added when the VM is keeping up. Bounded, so a client that has died
// mid-build cannot wedge the round forever.
const PYRAMID_BUILD_SETTLE_MS = 4000;
const PYRAMID_BUILD_PONG_TIMEOUT_MS = 15000;
const PYRAMID_BUILD_PROBE_ENABLED = true;
const QRS_CLIMB_DURATION_MS = 3000;
// Spacing between consecutive PRS climb frames. Each PRS starts its own
// QRS_CLIMB_DURATION_MS animation, so frames must be spaced by at least that
// long or the client overwrites one with the next. Reference PRS gaps run
// +3305 for a full climb and +1303 for the shorter settle beat.
const CLIMB_FRAME_GAP_MS = 3305;

// Climb/reveal contract for Black Hole + Mystery + DoN. Not inferred here --
// supplied by another researcher and live-verified 2026-07-22 over a 15-run
// campaign ("works and is clean"):
//
//   climb roster -> QRS PRMD -> PRS 0    jumps play; hole landers swallowed
//     wait clamp(1.5 + 0.5*total, 3, 10) client animates movers SEQUENTIALLY
//   silent pass (data-only)              path IQ + plain-IQ/Stun landings
//   BH roster (landers -> 0) + PRS 0     swallowed sprites return to Start on
//                                        their OWN plain PRS 0, before reveals
//   reveal chain, ONE tile per pass:
//     PRS <step>                         flip
//     +1.0s: roster + PRS 0              the COMMIT pair
//     beat -> BH scan -> re-queue        chains play out recursively
//   final roster                         data sync
//
// Most themed steps need no reveal at all -- they animate when a player is
// moved onto them by a plain PRS 0. Only the hidden flavours (Mystery, DoN)
// have to be flipped explicitly, which is what "PRS 1 4 S # # # # #" does.
//
// The wait is the substantive part: because the client animates movers one
// after another, it scales with the TOTAL steps moved by everyone, not with
// the longest single climb. Ten players moving 2 each is 20 steps of
// animation, i.e. 10 s clamped -- our flat CLIMB_FRAME_GAP_MS was 3.3 s, so
// later frames landed while sprites were still walking.
const CLIMB_SEQUENCE_V2 = true;
const CLIMB_WAIT_BASE_MS = 1500;
const CLIMB_WAIT_PER_STEP_MS = 500;
const CLIMB_WAIT_MIN_MS = 3000;
const CLIMB_WAIT_MAX_MS = 10000;
// "+1.0s: roster + PRS 0" -- the flip must be on screen before the commit.
const REVEAL_COMMIT_DELAY_MS = 1000;
// The unquantified "beat" between one tile's commit and the next tile's flip.
const REVEAL_BEAT_MS = 1000;
const CLIMB_SETTLE_GAP_MS = 1303;
// Upper bound on hidden-tile reveal frames in one round; each costs another
// CLIMB_FRAME_GAP_MS.
const MAX_REVEAL_FRAMES_PER_ROUND = 3;
// MAR fields [1] and [2] for a round the player never answered. Both are
// answer indices, so any non-zero value names a real button -- the Python's
// captured "1 1" highlights B for someone who picked nothing.
const MAR_NO_ANSWER_FIELDS = '0 0';
// Periodic "ST S 0 <elapsed>" heartbeat. The reference server has none -- 15
// How many consecutive un-PONGed PINGs before a client is treated as dead.
// 3 misses at the 30 s keepalive interval is ~90 s of silence -- long enough
// that a busy client is never reaped by mistake, short enough that a crashed
// one stops holding its game slot. Nothing pings during the ad window, so that
// pause never counts toward this.
const KEEPALIVE_MISSES_BEFORE_DEAD = 3;

// ST in a whole game, every one event-driven. IRC PING/PONG keeps the socket
// alive regardless. Flip true only to test whether client state depends on it.
const KALOOP_HEARTBEAT_ENABLED = false;
// End-of-game pacing. Reference EGS trailer: "EGS S 0 582074 546074 30000 0",
// so reveal_at - elapsed - visible = 6000 dwell. Two heartbeats precede it
// (+9769 then +7258 off the blowout PRS).
const ENDGAME_EGS_VISIBLE_MS = 30000;
const ENDGAME_EGS_DWELL_MS = 6000;
const ENDGAME_PRE_EGS_SECONDS = 10;
const ENDGAME_EGS_LEAD_SECONDS = 7;
const ENDGAME_EGS_WAIT_SECONDS = 45;
// Whether to loop into a brand new pyramid segment after EGS. The reference
// keeps going rather than stopping at the end-game screen.
const LOOP_NEW_SEGMENT_AFTER_EGS = true;

const ROUNDS_PER_SEGMENT_MIN = 3; // eslint-disable-line no-unused-vars -- kept for parity with the Python source
const ROUNDS_PER_SEGMENT_MAX = 4; // eslint-disable-line no-unused-vars

// Storm system left OFF -- see module docstring above.
const STORM_SYSTEM_ENABLED = false;
const STORM_ROUND_IN_SEGMENT = 2;   // fires once roundInSegment reaches this
const STORM_INSURANCE_COST = 15;    // IQ points spent to buy insurance
const STORM_INSURANCE_WINDOW_SECONDS = 25; // player's/bots' time to decide
const STORM_BOT_BUY_CHANCE = 0.5;   // chance a bot with enough IQ buys in
const STORM_TYPES = ['ION', 'METEOR', 'TORNADO']; // wire code = index

const JGS_ENABLED = false;
const PREFLIGHT_QS_ENABLED = false;

// Fallback question, used only if the real question-bank text files
// aren't reachable via fetch() at static/bigidea/qanda/74_textholder1.txt /
// static/bigidea/qanda/75_textholder2.txt.
const FALLBACK_QUESTIONS = [
  {
    category: 3,
    time: 30,
    reveal_ms: 20000,
    text: 'Which answer should move the pyramid?',
    answers: ['The first answer', 'The second answer', 'The third answer', 'The fourth answer'],
    weights: [60, 25, 10, 5],
    correct: 0,
  },
];

// Ad manifest -- pick_random_ad() in Python does a real os.listdir() of
// ADS_DIR; a static host has no directory listing over fetch(), so instead
// we fetch a manifest.json (generated by generate-ad-manifest.js
// from the real folder contents) that lists what's actually in
// static/bigidea/content/Ads/. FALLBACK_AD_MANIFEST below is only used if
// that fetch fails (e.g. manifest.json hasn't been generated yet) -- keep
// it roughly in sync, but it no longer needs to be perfectly accurate since
// the manifest.json fetch is the source of truth once it exists.
// NOTE: 'sponsor.srf' is intentionally NOT in this list. In the Python
// reference it's only the fallback name passed to normalize_ad_filename()
// when pick_random_ad() finds no real files -- it isn't a real ad and
// normally doesn't exist in Ads/, so including it here caused ~1-in-6
// random picks to 404.
const FALLBACK_AD_MANIFEST = ['air212.srf', 'usr135.srf', 'hug173.srf', 'voc213.srf', 'gvl113.srf'];

let AD_MANIFEST = FALLBACK_AD_MANIFEST;
let adManifestLoaded = null; // Promise once started; see ensureAdManifestLoaded()

async function loadAdManifest() {
  let resp;
  try {
    resp = await fetch('static/bigidea/content/Ads/manifest.json', { cache: 'no-store' });
  } catch (e) {
    return null;
  }
  if (!resp.ok) return null;
  let list;
  try {
    list = await resp.json();
  } catch (e) {
    console.error('[game] Ads/manifest.json is not valid JSON -- using the fallback ad list.', e);
    return null;
  }
  if (!Array.isArray(list)) return null;
  const srfOnly = list.filter((f) => typeof f === 'string' && f.toLowerCase().endsWith('.srf'));
  return srfOnly.length ? srfOnly : null;
}

// Memoise the PROMISE, not a boolean. The old "set flag, then await" shape
// meant a second caller arriving while the fetch was still in flight returned
// immediately and carried on with an empty list -- which matters now that the
// load is kicked off at module scope as well as from startCosmicGameServer().
async function ensureAdManifestLoaded() {
  if (adManifestLoaded) return adManifestLoaded;
  adManifestLoaded = (async () => {
  try {
    const loaded = await loadAdManifest();
    if (loaded) {
      AD_MANIFEST = loaded;
      console.log(`[game] Loaded ${loaded.length} ad files from Ads/manifest.json.`);
    } else {
      console.warn('[game] Ads/manifest.json not found or empty -- using the hardcoded fallback ad list. Run generate-ad-manifest.js to create it.');
    }
  } catch (e) {
    console.error('[game] Failed to load Ads/manifest.json -- using the fallback ad list.', e);
  }
  })();
  return adManifestLoaded;
}

let QUESTIONS = FALLBACK_QUESTIONS;
let questionBankLoaded = null; // Promise once started; see ensureQuestionBankLoaded()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── question bank loading (port of load_question_bank) ──────────────────

// windows-1252's 0x80-0x9F block, in order, for building the reverse
// (Unicode -> byte) map used by encodeCp1252(). Undefined slots (0x81,
// 0x8D, 0x8F, 0x90, 0x9D) are '' and simply won't get a reverse mapping.
const CP1252_HIGH_CHARS =
  '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021' +
  '\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F' +
  '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014' +
  '\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';

const CP1252_ENCODE_MAP = (() => {
  const map = new Map();
  for (let i = 0; i < CP1252_HIGH_CHARS.length; i++) {
    const ch = CP1252_HIGH_CHARS[i];
    if (ch && !map.has(ch)) map.set(ch, 0x80 + i);
  }
  return map;
})();

// The legacy game client (GetThePicture.exe / Cosmic Consensus, a
// pre-Unicode Win32 ANSI app) reads raw single-byte windows-1252 off the
// wire -- it has no idea what UTF-8 is. new TextEncoder().encode() always
// produces UTF-8, so any code point above U+007F (curly quotes, em dashes,
// etc. that came from decoding the CP1252 question-bank files) would come
// out as a 2-3 byte UTF-8 sequence and render as mojibake/boxes in the
// client, breaking its fixed ANSI parsing of question/answer text. This
// re-encodes back to single-byte CP1252, matching what the client expects.
// Anything with no CP1252 representation falls back to '?' rather than
// silently corrupting the wire format.
function encodeCp1252(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      bytes[i] = code;
    } else if (CP1252_ENCODE_MAP.has(str[i])) {
      bytes[i] = CP1252_ENCODE_MAP.get(str[i]);
    } else {
      bytes[i] = 0x3f; // '?' -- no CP1252 representation
    }
  }
  return bytes;
}

async function fetchLatin1Text(url) {
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) return null;
  const buf = await resp.arrayBuffer();
  // Legacy Windows game-data files are typically Windows-1252, not true
  // ISO-8859-1 -- CP1252 defines printable characters (curly quotes, em
  // dashes, ellipsis, etc.) in the 0x80-0x9F byte range where real Latin-1
  // has no assignment. Browsers already alias the "iso-8859-1" label to
  // windows-1252 per the WHATWG Encoding spec, but naming it explicitly
  // here avoids relying on that implicit legacy aliasing. A small handful
  // of byte values (0x81, 0x8D, 0x8F, 0x90, 0x9D) are still undefined even
  // in CP1252 and decode to U+FFFD -- cleanGameText() strips those.
  return new TextDecoder('windows-1252').decode(buf);
}

/**
 * Single-word questions live in qanda.txt alongside everything else, marked
 * with a "1WORD:" prefix:
 *
 *     1WORD:BELLY _________#$44:"button",33:"flop",23:"ache"
 *
 * The answers after #$ are the "house" words -- what the bots type, and what
 * fills the reveal when the player leaves the box empty. Slot 0 is replaced by
 * whatever the player actually typed. Only ONE slot goes out on the wire while
 * the question is open (a bare "-" text box); these matter at reveal time.
 *
 * Kept in their own list rather than merged into QUESTIONS:
 * USE_ONLY_FOUR_ANSWER_QUESTIONS would otherwise filter every one of them out,
 * and pickRandomQuestion mixes them in at its own rate.
 */
const SINGLE_WORD_PREFIX = '1WORD:';

function parseSingleWordLine(line) {
  const body = line.slice(SINGLE_WORD_PREFIX.length);
  const idx = body.indexOf('#$');
  const text = cleanGameText(idx >= 0 ? body.slice(0, idx) : body, 220);
  if (!text) return null;

  const answers = [];
  const weights = [];
  if (idx >= 0) {
    const re = /(-?\d+)\s*:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(body.slice(idx + 2))) !== null) {
      const answer = cleanGameText(m[2], 120);
      if (answer) {
        weights.push(Math.max(0, parseInt(m[1], 10)));
        answers.push(answer);
      }
    }
  }
  if (!answers.length) {
    answers.push('(no answer)');
    weights.push(1);
  }

  // ONE answer slot, not the whole house list. There is a single blank, so
  // there is a single result row -- the Blowout does exactly this, one ARI per
  // blank at a flat 100%:
  //     QR1 3 3 0 1 / ARB 3 / ARI 0 ... 100 3 / ARI 1 ... 100 2 / ...
  // so one blank is "QR1 1 1 0 n / ARB 1 / ARI 0 ... 100 1". Feeding the three
  // house words through as three answers is what drew three percentage bars.
  //
  // The extra words in the file are alternates and are ignored; the first is
  // the fallback shown when the player types nothing.
  return {
    category: 3,
    time: 25,
    reveal_ms: 25000,
    text,
    answers: [answers[0]],
    // The full house list, kept for SINGLE_WORD_OPEN_ENDED = false.
    all_answers: answers.slice(0, MAX_ANSWER_SLOTS),
    // raw, not normalised: a lone answer is by definition 100% of the vote
    weights: [100],
    prototype_raw_percents: true,
    answer_steps: [SINGLE_WORD_ANSWER_STEPS],
    // QR1 field 1. The Blowout sends its blank count here; one blank -> 1.
    prototype_result_index: 1,
    correct: 0,
    is_single_word: true,
  };
}

async function loadQuestionBank() {
  const loaded = [];
  for (const filename of ['static/bigidea/qanda/qanda.txt']) {
    let text;
    try {
      text = await fetchLatin1Text(filename);
    } catch (e) {
      text = null;
    }
    if (!text) continue;
    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith(SINGLE_WORD_PREFIX)) {
        // Same file, different shape -- collected here so there is only one
        // question file to maintain.
        const swq = parseSingleWordLine(trimmed);
        if (swq) SINGLE_WORD_QUESTIONS.push(swq);
        continue;
      }
      if (!rawLine.includes('#$')) continue;
      const idx = rawLine.indexOf('#$');
      const questionText = rawLine.slice(0, idx);
      const answerBlob = rawLine.slice(idx + 2);
      const answers = [];
      const weights = [];
      const re = /(-?\d+)\s*:\s*"([^"]+)"/g;
      let m;
      while ((m = re.exec(answerBlob)) !== null) {
        const weight = Math.max(0, parseInt(m[1], 10));
        const answer = cleanGameText(m[2], 120);
        if (answer) {
          weights.push(weight);
          answers.push(answer);
        }
      }
      const cleanQuestionText = cleanGameText(questionText, 220);
      if (cleanQuestionText && answers.length >= 2) {
        const cappedAnswers = answers.slice(0, MAX_ANSWER_SLOTS);
        const cappedWeights = weights.slice(0, MAX_ANSWER_SLOTS);
        let correct = 0;
        for (let i = 1; i < cappedWeights.length; i++) {
          if (cappedWeights[i] > cappedWeights[correct]) correct = i;
        }
        // numAns drives both the QT/QATB timing bucket below AND, via
        // answers.length downstream in answerMovementSteps()/questionForWire(),
        // how many pyramid step values get generated for this question (one
        // rank 0..numAns-1 per answer slot) -- so we keep it as an explicit
        // field rather than just relying on callers to re-derive
        // answers.length correctly every time.
        const numAns = cappedAnswers.length;
        const qTime = numAns === 2 ? 15 : numAns === 3 ? 20 : 25;
        loaded.push({
          category: 3,
          time: qTime,
          reveal_ms: qTime * 1000,
          text: cleanQuestionText,
          answers: cappedAnswers,
          weights: cappedWeights,
          correct,
          num_answers: numAns,
        });
      }
    }
  }
  return loaded;
}

// Promise-memoised for the same reason as ensureAdManifestLoaded above.
async function ensureQuestionBankLoaded() {
  if (questionBankLoaded) return questionBankLoaded;
  questionBankLoaded = (async () => {
  try {
    SINGLE_WORD_QUESTIONS = [];
    let loaded = await loadQuestionBank();
    if (USE_ONLY_FOUR_ANSWER_QUESTIONS) {
      const fourAnswer = loaded.filter((q) => (q.answers || []).length === MAX_ANSWER_SLOTS);
      if (fourAnswer.length) loaded = fourAnswer;
    }
    if (loaded.length) {
      QUESTIONS = loaded;
      console.log(`[game] Loaded ${loaded.length} questions from the question bank.`);
    } else {
      console.warn('[game] No question-bank text files found -- using the fallback question.');
    }
    if (!SINGLE_WORD_QUESTIONS_ENABLED) SINGLE_WORD_QUESTIONS = [];
    if (SINGLE_WORD_QUESTIONS.length) {
      console.log(`[game] Loaded ${SINGLE_WORD_QUESTIONS.length} single-word questions.`);
    }
  } catch (e) {
    console.error('[game] Failed to load question bank -- using the fallback question.', e);
  }
  })();
  return questionBankLoaded;
}

// ── pure helpers (port of the module-level functions) ────────────────────

function cleanGameText(value, maxLen) {
  let v = (value || '').replace(/\x02/g, '');
  // Strip the Unicode replacement character (U+FFFD) -- shows up as a
  // visible "tofu" box in-game -- produced when a byte has no assignment
  // even under windows-1252 (0x81, 0x8D, 0x8F, 0x90, 0x9D), plus any other
  // stray C0/C1 control characters that shouldn't be in display text.
  v = v.replace(/\uFFFD/g, '');
  v = v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  v = v.replace(/@/g, '').replace(/&/g, '');
  v = v.replace(/\s+/g, ' ').trim();
  return v.slice(0, maxLen).replace(/\s+$/, '');
}

function pickRandomAd() {
  if (!AD_MANIFEST.length) return null;
  const choice = AD_MANIFEST[Math.floor(Math.random() * AD_MANIFEST.length)];
  console.log(`[game] Ad picked: ${choice}`);
  return choice;
}

function normalizeAdFilename(adFile, fallback = 'sponsor.srf') {
  let ad = (adFile || '').trim() || fallback;
  if (!ad.toLowerCase().endsWith('.srf')) ad += '.srf';
  return ad;
}

function secondaryAdFilename(primary) {
  let secondary = normalizeAdFilename(pickRandomAd(), 'gvl113.srf');
  if (secondary.toLowerCase() === primary.toLowerCase()) {
    secondary = primary.toLowerCase() === 'gvl113.srf' ? 'voc213.srf' : 'gvl113.srf';
  }
  return secondary;
}

/**
 * Clamp player positions to the wire-safe step range: 0..20 normally, 0..23
 * once the blowout has unlocked the three bonus steps.
 *
 * maxStep was hardcoded to PYRAMID_WIRE_MAX_STEP (20), so after the bonus
 * unlocked, anyone standing on 21-23 was still reported as 20 and the bonus
 * steps could never be reached on screen.
 */
function displayPlayerSteps(steps, maxStep = PYRAMID_WIRE_MAX_STEP) {
  return steps.map((s) => Math.max(0, Math.min(maxStep, Math.trunc(s))));
}

function displayPlayerBips(bips, count) {
  const values = (bips || []).slice();
  while (values.length < count) values.push(0);
  // No Math.max(0, ...) -- IQ is allowed to go negative and the client renders
  // it. The reference sends lines like "PLI 9 BIP -46 12 0 P Shaurya"; clamping
  // here floored every losing player at 0 and silently erased the penalty.
  return values.slice(0, count).map((v) => Math.trunc(v));
}

function answerMovementSteps(values) {
  const ranked = values.map((_, i) => i).sort((a, b) => {
    if (values[a] !== values[b]) return values[a] - values[b];
    return b - a; // matches Python's (value, -i) sort key tie-break
  });
  const steps = new Array(values.length).fill(0);
  ranked.forEach((answerIdx, rank) => {
    steps[answerIdx] = rank;
  });
  return steps;
}

function normalizedPercents(weights) {
  const safe = weights.map((w) => Math.max(0, Math.trunc(w)));
  let total = safe.reduce((a, b) => a + b, 0);
  let safeWeights = safe;
  if (total <= 0) {
    safeWeights = weights.map(() => 1);
    total = safeWeights.length;
  }
  const percents = safeWeights.map((w) => Math.round((w / total) * 100));
  if (percents.length) {
    const sum = percents.reduce((a, b) => a + b, 0);
    percents[percents.length - 1] += 100 - sum;
  }
  return [percents, safeWeights];
}

function prototypeBipDelta(answerStep) {
  const idx = Math.max(0, Math.min(PROTOTYPE_BIP_DELTAS.length - 1, Math.trunc(answerStep)));
  return PROTOTYPE_BIP_DELTAS[idx];
}

function moveListItem(values, sourceIdx, destIdx) {
  const rotated = values.slice();
  const [item] = rotated.splice(sourceIdx, 1);
  rotated.splice(destIdx, 0, item);
  return rotated;
}

function remapMovedIndex(index, sourceIdx, destIdx) {
  if (index === sourceIdx) return destIdx;
  if (destIdx <= index && index < sourceIdx) return index + 1;
  if (sourceIdx < index && index <= destIdx) return index - 1;
  return index;
}

function questionForWire(q) {
  const wire = Object.assign({}, q);
  let answers = (q.answers || []).slice(0, MAX_ANSWER_SLOTS);
  let weights = (q.weights || answers.map(() => 1)).slice(0, answers.length);
  while (weights.length < answers.length) weights.push(1);
  let correct = Math.min(q.correct || 0, Math.max(0, answers.length - 1));
  let answerSteps = (q.answer_steps || []).slice(0, answers.length);

  if (
    AVOID_FINAL_SLOT_CONSENSUS_WINNER &&
    answers.length > 1 &&
    !('prototype_result_index' in q)
  ) {
    // Strict > so a tie keeps the EARLIER answer, matching Python's
    // (weight, -i) sort key. With >= the last tied answer won instead, which
    // made this guard fire on ties where the Python never would.
    let topIdx = 0;
    for (let i = 1; i < weights.length; i++) {
      if (Math.max(0, weights[i]) > Math.max(0, weights[topIdx])) topIdx = i;
    }
    const lastIdx = answers.length - 1;
    if (topIdx === lastIdx) {
      answers = moveListItem(answers, lastIdx, 0);
      weights = moveListItem(weights, lastIdx, 0);
      if (answerSteps.length) answerSteps = moveListItem(answerSteps, lastIdx, 0);
      correct = remapMovedIndex(correct, lastIdx, 0);
      wire.final_slot_consensus_guard = true;
    }
  }
  wire.answers = answers;
  wire.weights = weights;
  if (answerSteps.length) wire.answer_steps = answerSteps;
  wire.correct = correct;
  return wire;
}

function answerPairStrings(answers) {
  const slots = answers.slice(0, MAX_ANSWER_SLOTS);
  while (slots.length < MAX_ANSWER_SLOTS) slots.push('');
  return [`A=${slots[0]}|B=${slots[1]}`, `C=${slots[2]}|D=${slots[3]}`];
}

function qtButtonField(answerCount) {
  return Math.max(0, Math.min(MAX_ANSWER_SLOTS - 2, answerCount - 2));
}

/**
 * The QT header fields and answer list for one question.
 *
 * Single source of truth on purpose. This used to be worked out independently
 * in sendQuestion and again in the guest catch-up, and the two drifted: the
 * catch-up derived the layout from q.answers.length, which for a single-word
 * question is 1, giving qtButtonField(1) === 0 -- the TWO-answer multiple
 * choice layout -- for a question the host had sent as mode 3 text entry. The
 * guest also never received the answer slot that mode 0 goes on to read, so
 * the round simply did not draw for anyone who joined mid-game.
 */
function qtFieldsFor(q) {
  const openEnded = !!q.is_single_word && SINGLE_WORD_OPEN_ENDED;
  const wireAnswers = (q.is_single_word && !SINGLE_WORD_OPEN_ENDED
                       && q.all_answers && q.all_answers.length >= 2)
    ? q.all_answers : q.answers;
  return {
    openEnded,
    wireAnswers,
    qtStep: openEnded ? SINGLE_WORD_QT_STEP : qtButtonField(wireAnswers.length) + 1,
    qtButtonMode: openEnded ? SINGLE_WORD_QT_BUTTON_MODE : qtButtonField(wireAnswers.length),
  };
}

/**
 * QT is "QT <step> <mode> <duration_secs> <text>". Read out of the client
 * binary (CosmicConsensus.exe), not guessed:
 *
 *   BigIdeaModel::HandleMessage @ 0x43e7bc dispatches QATE to 0x43bcad, which
 *   switches on the QT mode field (QuestionText+8):
 *       0 -> 2 answers   1 -> 3 answers   2 -> 4 answers
 *       3 or 4 -> OPEN ENDED, and the QATB/QATI answer list is never read
 *       anything else -> throws, question discarded
 *
 *   The open-ended Question ctor @ 0x446cae then validates:
 *       if (step <= 0)                       throw     ; 0x446d21
 *       if (mode == 3 && step <  4)          accept    ; 0x446d2e
 *       if (mode != 4)                       throw     ; 0x446d33
 *       if (step >= 7)                       throw     ; 0x446d38
 *   i.e. mode 3 allows steps 1-3, mode 4 allows steps 1-6. That is why the
 *   Blowout is "QT 6 4 60": 6 steps (3+2+1 across its blanks) needs mode 4.
 *
 * The throw is silent on the wire -- the client just never draws the round --
 * so an out-of-range combination is invisible unless we check it here.
 *
 * Question+4 (step) is also how far ahead the client previews the board: the
 * warning banner at 0x43be13 walks tiles position+1 .. position+step looking
 * for STUN / STICKY / MYSTERY / DOUBLE OR NOTHING / BLACK HOLE.
 */
function assertValidQt(step, mode, label) {
  let ok;
  if (mode >= 0 && mode <= 2) ok = true;            // fixed-answer layouts
  else if (mode === 3) ok = step > 0 && step < 4;
  else if (mode === 4) ok = step > 0 && step < 7;
  else ok = false;
  if (!ok) {
    console.warn(`[game] WARNING: QT ${step} ${mode} for ${label} is out of range -- `
      + 'the client will discard this question and draw nothing. '
      + 'mode 0-2 = 2/3/4 answers, mode 3 = open-ended step 1-3, mode 4 = open-ended step 1-6.');
  }
  return ok;
}

// Picks a random question from the bank instead of cycling through it in a
// fixed order. Avoids immediately repeating the same question again when
// more than one is available (harmless once the real bank is loaded, but
// keeps things from feeling stuck if the bank is small).
function pickRandomQuestion(excludeQuestion) {
  // Mix in a single-word round now and then, when any are loaded.
  if (
    SINGLE_WORD_QUESTIONS_ENABLED &&
    SINGLE_WORD_QUESTIONS.length &&
    !(excludeQuestion && excludeQuestion.is_single_word) &&
    Math.random() < SINGLE_WORD_QUESTION_CHANCE
  ) {
    return SINGLE_WORD_QUESTIONS[Math.floor(Math.random() * SINGLE_WORD_QUESTIONS.length)];
  }
  if (!QUESTIONS.length) return FALLBACK_QUESTIONS[0];
  if (QUESTIONS.length === 1) return QUESTIONS[0];
  let q;
  do {
    q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)];
  } while (q === excludeQuestion);
  return q;
}

function parseAnswerLine(line, currentQuestion, numPlayerSlots) {
  let body;
  if (line.startsWith('AQ ')) {
    body = line.slice(3).trim();
  } else if (line.startsWith('A ')) {
    body = line.slice(2).trim();
  } else {
    return [-1, -1];
  }
  let parts = body.split(/\s+/).filter(Boolean);
  if (parts.length && parts[0].toUpperCase() === 'A') parts = parts.slice(1);
  const numbers = [];
  for (const part of parts) {
    const cleaned = part.replace(/^[\x02,;:]+|[\x02,;:]+$/g, '');
    if (/^-?\d+$/.test(cleaned)) {
      numbers.push(parseInt(cleaned, 10));
    } else if (numbers.length) {
      break;
    }
  }
  if (!numbers.length) {
    if (currentQuestion) {
      const loweredBody = cleanGameText(body, 500).toLowerCase();
      const answers = currentQuestion.answers || [];
      for (let i = 0; i < answers.length; i++) {
        if (loweredBody.includes(cleanGameText(answers[i], 120).toLowerCase())) return [0, i];
      }
    }
    return [-1, -1];
  }
  let slot, answerIdx;
  if (numbers.length === 1) {
    [slot, answerIdx] = [0, numbers[0]];
  } else {
    [slot, answerIdx] = [numbers[0], numbers[1]];
    if (currentQuestion && !(answerIdx >= 0 && answerIdx < currentQuestion.answers.length)) {
      if (numbers[0] >= 0 && numbers[0] < currentQuestion.answers.length) {
        [slot, answerIdx] = [0, numbers[0]];
      }
    }
  }
  if (!(slot >= 0 && slot < numPlayerSlots)) return [-1, -1];
  if (currentQuestion && !(answerIdx >= 0 && answerIdx < currentQuestion.answers.length)) return [-1, -1];
  return [slot, answerIdx];
}

// ── tiny async mutex, replacing Python's threading.Lock for the send_lock
//    critical sections (multi-line PRIVMSG bursts that must not be
//    interleaved with e.g. the keepalive PING) ────────────────────────────

class AsyncLock {
  constructor() {
    this._chain = Promise.resolve();
    this._locked = false;
  }
  async withLock(fn) {
    // Reentrant: if this call chain already holds the lock (e.g.
    // start_segment holding it while calling send_player_list, which
    // acquires it again), just run inline instead of deadlocking on
    // ourselves -- mirrors Python's threading.RLock used here.
    if (this._locked) {
      return fn();
    }
    let release;
    const p = new Promise((resolve) => {
      release = resolve;
    });
    const prev = this._chain;
    this._chain = prev.then(() => p);
    await prev;
    this._locked = true;
    try {
      return await fn();
    } finally {
      this._locked = false;
      release();
    }
  }
}

// ── active-client tracking (mirrors the original bot's single-target
//    console model; not currently exposed to a UI in this browser port,
//    kept for parity / a future debug panel) ─────────────────────────────
let _activeClient = null;
function setActiveClient(client) {
  _activeClient = client;
}

// ── shared game rooms ────────────────────────────────────────────────────────
// Ported from cosmic_v64_web.py. Before this, every connection ran its own
// private board with its own bots and could never see another player. A
// GameRoom owns the state that has to be common to everyone in it -- the
// board, the roster arrays, the elapsed clock, the current round -- and each
// GameClient reaches it through the accessors defined after the class. Clients
// keep their own copy of the same fields for the roomless/solo path, so every
// accessor is "room if joined, private otherwise".
//
// The client at slot 0 is the HOST and is the only one that drives the game
// loop; guests join the room, receive the HOST's broadcasts through botPriv,
// and submit answers into the shared humanAnswers map.
class GameRoom {
  constructor(roomName = 'Big_000', minBots = MIN_BOTS_PER_ROOM, displayName = '', minPlayersToStart = 1) {
    this.roomName = roomName;
    this.displayName = displayName || roomName;
    this.minBots = minBots;
    this.minPlayersToStart = Math.max(1, minPlayersToStart);
    this.clients = [];

    // shared game state
    this.roomStartTime = null;
    this.lastReportedElapsed = 0;
    this.boardTiles = [];
    this.playerSteps = [];
    this.playerBipValues = [];
    this.playerStuck = [];
    this.playerStunned = [];
    this.pyramidBonusUnlocked = false;
    this.pyramidSegmentFinished = false;
    this.botsJoined = false;
    this.questionIndex = 0;
    this.roundInSegment = 0;
    this.currentQuestion = null;
    this.questionRevealTime = null;
    this.roundResolved = true;
    this.questionGeneration = 0;
    this.humanBlowoutAnswers = [];
    this.roundBlackholeSlots = [];
    this.roundMysteryEvents = [];
    // Total steps walked by everyone this round -- drives the climb wait.
    this.roundStepsMoved = 0;
    this.lastClimbTrailer = '';
    this.pyramidBuildUntil = 0;
    this.stormFiredThisSegment = false;
    // Storm state is shared: one insurance window, one set of insured slots.
    this.stormWindowOpen = false;
    this.stormInsured = new Set();
    // What a human typed this round on a single-word question, shared so the
    // HOST can echo it back in the reveal even when a guest typed it.
    this.singleWordAnswer = '';

    // game_slot -> answer index, for this round only
    this.humanAnswers = new Map();
  }

  /** Register a human client; returns their slot index. */
  addClient(client) {
    const slot = this.clients.length;
    this.clients.push(client);
    this.growRoster();
    return slot;
  }

  removeClient(client) {
    const i = this.clients.indexOf(client);
    if (i >= 0) this.clients.splice(i, 1);
  }

  humanCount() {
    return this.clients.length;
  }

  /**
   * Humans actually still on the socket.
   *
   * humanCount() is the raw roster length and must stay that way -- addClient()
   * hands out game slots from it, so filtering there would make two players
   * share a slot. But a client whose socket died without a clean QUIT sits in
   * this.clients until something notices, and counting those left the room
   * selector advertising players who were already gone.
   */
  liveHumanCount() {
    return this.clients.reduce((n, c) => n + (c.connected ? 1 : 0), 0);
  }

  playersReady() {
    return this.clients.length >= this.minPlayersToStart;
  }

  /** Grow the per-player arrays when a human joins mid-game. */
  growRoster() {
    const target = this.currentPlayerNames().length;
    while (this.playerSteps.length < target) {
      this.playerSteps.push(0);
      this.playerBipValues.push(0);
      this.playerStuck.push(false);
      this.playerStunned.push(false);
    }
  }

  /**
   * Human slots first (slot 0 = first human), then the bot fill.
   * A no-bots room (minBots === 0) returns only the human names, so its
   * roster shrinks and grows with the actual players.
   */
  currentPlayerNames() {
    const names = this.clients.map((c) => cleanGameText(c.username, 30) || 'Player');
    if (this.minBots > 0) {
      let botIdx = 0;
      const target = Math.max(names.length + this.minBots, PLAYER_NAMES.length);
      while (names.length < Math.min(target, MAX_GAME_PLAYERS)) {
        names.push(BOT_NAMES[botIdx % BOT_NAMES.length]);
        botIdx += 1;
      }
    }
    return names;
  }

  resetRoundAnswers() {
    this.humanAnswers.clear();
    // Cleared with the votes, or last round's word would be echoed back in
    // the next single-word reveal when nobody typed anything.
    this.singleWordAnswer = '';
  }

  get roomInfoLine() {
    // lock = human count, players = total occupancy including bots; see the
    // module-level roomInfoLine() comment for where those field meanings come
    // from in the reference capture.
    return makeBirLine(this.roomName, this.displayName, {
      lock: this.liveHumanCount(),
      b: this.minPlayersToStart,
      players: this.currentPlayerNames().length,
    });
  }
}

const rooms = new Map(); // roomName -> GameRoom

function getOrCreateGameRoom(roomName) {
  let room = rooms.get(roomName);
  if (!room) {
    const cfg = ROOM_CONFIGS[roomName] || ROOM_DEFAULT_CONFIG;
    room = new GameRoom(roomName, cfg.minBots, cfg.display, cfg.minPlayersToStart);
    rooms.set(roomName, room);
    console.log(
      `[game] STAT: Created new game room '${roomName}' ` +
      `(minBots=${cfg.minBots}, minPlayersToStart=${cfg.minPlayersToStart}).`
    );
  }
  return room;
}

function releaseGameRoomIfEmpty(roomName) {
  const room = rooms.get(roomName);
  if (room && room.humanCount() === 0) {
    console.log(`[game] STAT: All humans left room '${roomName}' -- removing from active rooms.`);
    rooms.delete(roomName);
  }
}

function activeRoomsSnapshot() {
  return [...rooms.values()];
}

/**
 * Tell everyone still in `room` that `username` has left, so the client can
 * drop them from its player panel instead of leaving a ghost entry behind.
 */
/**
 * Tell everyone still in a game room that `username` is gone, so the client
 * drops them from its in-room player panel. Mirrors the PJ packet used for
 * bot joins.
 *
 * `room` may be null to sweep every active room, which is what the Python's
 * _broadcast_pleave always does -- it takes no room argument at all. That
 * matters when the leaver's own room reference has already been cleared, and
 * it is what the console's PLEAVE command needs.
 *
 * Excludes by USERNAME, not by object identity, again matching the Python.
 * A player who crashed and reconnected has two client objects with the same
 * name; identity would send that player a PLEAVE announcing their own
 * departure on the new connection.
 */
function broadcastPleave(room, username) {
  const prefix = `:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG`;
  const rooms = room ? [room] : activeRoomsSnapshot();
  let sent = 0;
  for (const r of rooms) {
    for (const c of r.clients) {
      if (!c.connected || c.username === username) continue;
      Promise.resolve(
        c.sendRaw(`${prefix} ${c.clientIrcName} :PLEAVE BIP 0 0 0 P ${username}`)
      ).catch(() => {});
      sent += 1;
    }
  }
  // Returned so the console's PLEAVE can report a count, as the Python does.
  return sent;
}

class GameClient {
  constructor(conn) {
    this.conn = conn;
    this.writer = conn.writable.getWriter();
    this.buf = new Uint8Array(0);
    this.sendLock = new AsyncLock();

    // ── plain IRC layer ──
    this.nick = null;
    this.user = null;
    this.registered = false;
    this.joinedList = false;
    this.connected = true;

    // ── bigidea game-client identity (filled in by JOIN / L) ──
    this.clientIrcName = '';
    this.previousNick = '';
    this.username = '';
    this.versionStr = '';
    this.clientSessionId = '0';

    // ── room membership ──
    // room === null means the solo/lobby path, where the _gs* fields below are
    // the live state. Once joined, every accessor delegates to the room so all
    // members share one board and one roster.
    this.room = null;
    this.gameSlot = -1;
    this.pendingRoomName = 'Big_000'; // set by JOIN, consumed by handleRS
    this.guestCatchUpPending = false;

    // ── game/session state (solo fallbacks; see the accessors below) ──
    this.ingame = 0;
    this.kaloopSuppressUntil = 0;   // per-client: each kaloop stays independent
    this.marQuestionGen = -1;       // per-client: generation MAR was last sent for
    this.adAckPending = false;      // per-client for the same reason
    this.sessionGeneration = 0;     // per-client
    this._gsBotsJoined = false;
    this._gsRoomStartTime = null;   // ms, performance.now()-style via Date.now()
    this._gsLastReportedElapsed = 0;
    this._gsPyramidBuildUntil = 0;
    this._gsLastClimbTrailer = '';
    this._gsRoundBlackholeSlots = [];
    this._gsRoundMysteryEvents = [];
    this._gsPlayerSteps = new Array(PLAYER_NAMES.length).fill(0);
    this._gsPlayerBipValues = new Array(PLAYER_NAMES.length).fill(0);
    this._gsPyramidBonusUnlocked = false;
    this._gsPyramidSegmentFinished = false;
    this._gsQuestionIndex = 0;
    this._gsCurrentQuestion = null;
    this._gsQuestionRevealTime = null; // ms epoch
    this._gsRoundInSegment = 0;
    this._gsRoundResolved = true;
    this._gsQuestionGeneration = 0;

    // ── storm system state (see module header) ──
    // Solo-game fallbacks; in a room these delegate to the shared GameRoom so
    // one storm hits everyone at once rather than each client running its own.
    this._gsStormFiredThisSegment = false;
    this._gsStormWindowOpen = false;
    this._gsStormInsured = new Set();
    this._gsSingleWordAnswer = '';

    // ── dynamic pyramid step themes and tracking ──
    this._gsBoardTiles = [];
    this._gsPlayerStuck = new Array(PLAYER_NAMES.length).fill(false);
    this._gsPlayerStunned = new Array(PLAYER_NAMES.length).fill(false);
    this._gsHumanBlowoutAnswers = [];
    this.generateBoard();

    this.keepaliveTimer = null;
    // Consecutive PINGs sent with no PONG back; reset by the PONG handler.
    this.pingsAwaitingPong = 0;
    this.kaloopTimer = null;
  }

  label() {
    return this.nick || '(unregistered)';
  }

  // ── shared-state accessors ───────────────────────────────────────────────
  // Every game-loop method below keeps using `this.X`; these redirect to
  // `this.room.X` once the client has joined a room, so a HOST and its guests
  // operate on one board, one roster and one clock. Outside a room they fall
  // back to the client's own _gs* copy, which is what the solo path uses.
  //
  // Deliberately NOT delegated: adAckPending, kaloopSuppressUntil and
  // sessionGeneration stay per-client so each connection's ad ack, heartbeat
  // gating and reconnect generation remain independent.

  get botsJoined() { return this.room ? this.room.botsJoined : this._gsBotsJoined; }
  set botsJoined(v) { if (this.room) this.room.botsJoined = v; else this._gsBotsJoined = v; }

  get roomStartTime() { return this.room ? this.room.roomStartTime : this._gsRoomStartTime; }
  set roomStartTime(v) { if (this.room) this.room.roomStartTime = v; else this._gsRoomStartTime = v; }

  get lastReportedElapsed() { return this.room ? this.room.lastReportedElapsed : this._gsLastReportedElapsed; }
  set lastReportedElapsed(v) { if (this.room) this.room.lastReportedElapsed = v; else this._gsLastReportedElapsed = v; }

  get pyramidBuildUntil() { return this.room ? this.room.pyramidBuildUntil : this._gsPyramidBuildUntil; }
  set pyramidBuildUntil(v) { if (this.room) this.room.pyramidBuildUntil = v; else this._gsPyramidBuildUntil = v; }

  get lastClimbTrailer() { return this.room ? this.room.lastClimbTrailer : this._gsLastClimbTrailer; }
  set lastClimbTrailer(v) { if (this.room) this.room.lastClimbTrailer = v; else this._gsLastClimbTrailer = v; }

  get roundBlackholeSlots() { return this.room ? this.room.roundBlackholeSlots : this._gsRoundBlackholeSlots; }
  set roundBlackholeSlots(v) { if (this.room) this.room.roundBlackholeSlots = v; else this._gsRoundBlackholeSlots = v; }
  get roundStepsMoved() { return this.room ? this.room.roundStepsMoved : (this._gsRoundStepsMoved || 0); }
  set roundStepsMoved(v) { if (this.room) this.room.roundStepsMoved = v; else this._gsRoundStepsMoved = v; }

  get roundMysteryEvents() { return this.room ? this.room.roundMysteryEvents : this._gsRoundMysteryEvents; }
  set roundMysteryEvents(v) { if (this.room) this.room.roundMysteryEvents = v; else this._gsRoundMysteryEvents = v; }

  get playerSteps() { return this.room ? this.room.playerSteps : this._gsPlayerSteps; }
  set playerSteps(v) { if (this.room) this.room.playerSteps = v; else this._gsPlayerSteps = v; }

  get playerBipValues() { return this.room ? this.room.playerBipValues : this._gsPlayerBipValues; }
  set playerBipValues(v) { if (this.room) this.room.playerBipValues = v; else this._gsPlayerBipValues = v; }

  get playerStuck() { return this.room ? this.room.playerStuck : this._gsPlayerStuck; }
  set playerStuck(v) { if (this.room) this.room.playerStuck = v; else this._gsPlayerStuck = v; }

  get playerStunned() { return this.room ? this.room.playerStunned : this._gsPlayerStunned; }
  set playerStunned(v) { if (this.room) this.room.playerStunned = v; else this._gsPlayerStunned = v; }

  get pyramidBonusUnlocked() { return this.room ? this.room.pyramidBonusUnlocked : this._gsPyramidBonusUnlocked; }
  set pyramidBonusUnlocked(v) { if (this.room) this.room.pyramidBonusUnlocked = v; else this._gsPyramidBonusUnlocked = v; }

  get pyramidSegmentFinished() { return this.room ? this.room.pyramidSegmentFinished : this._gsPyramidSegmentFinished; }
  set pyramidSegmentFinished(v) { if (this.room) this.room.pyramidSegmentFinished = v; else this._gsPyramidSegmentFinished = v; }

  get boardTiles() { return this.room ? this.room.boardTiles : this._gsBoardTiles; }
  set boardTiles(v) { if (this.room) this.room.boardTiles = v; else this._gsBoardTiles = v; }

  get questionIndex() { return this.room ? this.room.questionIndex : this._gsQuestionIndex; }
  set questionIndex(v) { if (this.room) this.room.questionIndex = v; else this._gsQuestionIndex = v; }

  get roundInSegment() { return this.room ? this.room.roundInSegment : this._gsRoundInSegment; }
  set roundInSegment(v) { if (this.room) this.room.roundInSegment = v; else this._gsRoundInSegment = v; }

  get currentQuestion() { return this.room ? this.room.currentQuestion : this._gsCurrentQuestion; }
  set currentQuestion(v) { if (this.room) this.room.currentQuestion = v; else this._gsCurrentQuestion = v; }

  get questionRevealTime() { return this.room ? this.room.questionRevealTime : this._gsQuestionRevealTime; }
  set questionRevealTime(v) { if (this.room) this.room.questionRevealTime = v; else this._gsQuestionRevealTime = v; }

  get roundResolved() { return this.room ? this.room.roundResolved : this._gsRoundResolved; }
  set roundResolved(v) { if (this.room) this.room.roundResolved = v; else this._gsRoundResolved = v; }

  get questionGeneration() { return this.room ? this.room.questionGeneration : this._gsQuestionGeneration; }
  set questionGeneration(v) { if (this.room) this.room.questionGeneration = v; else this._gsQuestionGeneration = v; }

  get humanBlowoutAnswers() { return this.room ? this.room.humanBlowoutAnswers : this._gsHumanBlowoutAnswers; }
  set humanBlowoutAnswers(v) { if (this.room) this.room.humanBlowoutAnswers = v; else this._gsHumanBlowoutAnswers = v; }

  get stormFiredThisSegment() { return this.room ? this.room.stormFiredThisSegment : this._gsStormFiredThisSegment; }
  set stormFiredThisSegment(v) { if (this.room) this.room.stormFiredThisSegment = v; else this._gsStormFiredThisSegment = v; }
  get stormWindowOpen() { return this.room ? this.room.stormWindowOpen : this._gsStormWindowOpen; }
  set stormWindowOpen(v) { if (this.room) this.room.stormWindowOpen = v; else this._gsStormWindowOpen = v; }
  get stormInsured() { return this.room ? this.room.stormInsured : this._gsStormInsured; }
  set stormInsured(v) { if (this.room) this.room.stormInsured = v; else this._gsStormInsured = v; }
  get singleWordAnswer() { return this.room ? this.room.singleWordAnswer : this._gsSingleWordAnswer; }
  set singleWordAnswer(v) { if (this.room) this.room.singleWordAnswer = v; else this._gsSingleWordAnswer = v; }

  // ── dynamic board generation, player movement, and step theme triggers ──

  generateBoard() {
    const tiles = new Array(24).fill(null);
    tiles[0] = [5, 0];
    tiles[18] = [2, 35];
    tiles[19] = [2, 40];
    tiles[20] = [2, 45];
    tiles[21] = [9, 50];
    tiles[22] = [10, 75];
    tiles[23] = [11, 100];

    const minusValues = [-5, -7, -10, -15, -20, -23, -25];
    const positiveValues = [10, 15, 20, 25, 30, 35, 40];
    const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const weightsMap = {
      IQ: 60, DOUBLE_OR_NOTHING: 8, MYSTERY_IQ: 8, BLACK_HOLE: 5,
      TURBO: 8, MYSTERY_TURBO: 5, STICKY: 8, STUN: 8,
    };

    // Hard cap on how many times each special type may appear on one board.
    const maxCounts = {
      BLACK_HOLE: MAX_BLACK_HOLE,
      TURBO: MAX_TURBO_TILES,
      STICKY: MAX_STICKY,
      STUN: MAX_STUN,
      DOUBLE_OR_NOTHING: MAX_DON,
      MYSTERY_IQ: MAX_MYSTERY_TILES,
      MYSTERY_TURBO: MAX_MYSTERY_TILES,
    };
    const typeCounts = {};
    let negativeIqCount = 0; // toward MAX_NEGATIVE_SLOTS
    let prevType = 'IQ';     // step 1 is always IQ; drives the no-adjacent rule

    for (let i = 1; i < 18; i++) {
      if (i === 1 || i === 17) {
        tiles[i] = [2, choice(positiveValues)];
        prevType = 'IQ';
        continue;
      }
      let candidates = [];
      if (i <= 9) candidates.push('BLACK_HOLE');
      if (i <= 15) { candidates.push('TURBO'); candidates.push('MYSTERY_TURBO'); }
      if (i <= 16) { candidates.push('STICKY'); candidates.push('STUN'); }
      candidates.push('DOUBLE_OR_NOTHING', 'IQ', 'MYSTERY_IQ');
      if (i === 16) {
        candidates = candidates.filter(
          (c) => c !== 'MYSTERY_IQ' && c !== 'MYSTERY_TURBO' && c !== 'DOUBLE_OR_NOTHING'
        );
      }

      // Drop any special that would sit next to the same type or has already
      // hit its per-board cap. IQ is always allowed, so the list is never
      // empty. None of this existed here: boards could come out with several
      // Black Holes, back-to-back specials and unlimited negative steps.
      candidates = candidates.filter(
        (c) => c === 'IQ' || (c !== prevType && (typeCounts[c] || 0) < (maxCounts[c] || 99))
      );
      if (!candidates.length) candidates = ['IQ'];

      const totalWeight = candidates.reduce((s, c) => s + weightsMap[c], 0);
      const r = Math.random() * totalWeight;
      let current = 0;
      let chosenType = 'IQ';
      for (const c of candidates) {
        current += weightsMap[c];
        if (r <= current) { chosenType = c; break; }
      }

      if (chosenType === 'BLACK_HOLE') tiles[i] = [0, 1];
      // Reference always carries value 2 on Double or Nothing, never 0. A zero
      // leaves the client nothing to show when the tile flips.
      else if (chosenType === 'DOUBLE_OR_NOTHING') tiles[i] = [1, 2];
      else if (chosenType === 'IQ' || chosenType === 'MYSTERY_IQ') {
        // Once MAX_NEGATIVE_SLOTS negatives are placed, draw from the positive
        // pool only.
        const pool = negativeIqCount >= MAX_NEGATIVE_SLOTS
          ? positiveValues
          : minusValues.concat(positiveValues);
        const val = choice(pool);
        if (val < 0) negativeIqCount += 1;
        tiles[i] = [chosenType === 'IQ' ? 2 : 3, val];
      } else if (chosenType === 'MYSTERY_TURBO') tiles[i] = [4, choice([2, 3, 4])];
      else if (chosenType === 'STICKY') tiles[i] = [6, 2];
      else if (chosenType === 'STUN') tiles[i] = [7, 0];
      else if (chosenType === 'TURBO') tiles[i] = [8, choice([2, 3, 4])];

      if (chosenType !== 'IQ') typeCounts[chosenType] = (typeCounts[chosenType] || 0) + 1;
      prevType = chosenType;
    }

    this.boardTiles = tiles;
    console.log(`[game] STAT: Randomly generated board steps: ${JSON.stringify(tiles)}`);
  }

  applyMovement(slot, delta, source = 'game') {
    const stepLimit = this.pyramidBonusUnlocked ? PYRAMID_MAX_STEP : PYRAMID_TOP_STEP;

    if (source === 'game') {
      if (this.playerStunned[slot]) {
        console.log(`[game] STAT: Slot ${slot} is STUNNED -- cannot move this turn.`);
        this.playerStunned[slot] = false;
        return;
      }
      if (this.playerStuck[slot]) {
        if (delta >= 2) {
          console.log(`[game] STAT: Slot ${slot} got out of STICKY with delta ${delta}.`);
          this.playerStuck[slot] = false;
        } else {
          console.log(`[game] STAT: Slot ${slot} remains STUCK (delta ${delta} < 2).`);
          return;
        }
      }
    }

    const oldStep = this.playerSteps[slot];
    const newStep = Math.min(stepLimit, Math.max(0, oldStep + delta));
    this.playerSteps[slot] = newStep;
    // Every tile the client has to walk a sprite across, summed over everyone.
    this.roundStepsMoved += Math.abs(newStep - oldStep);

    if (newStep !== oldStep && source === 'game') {
      this.triggerStepTheme(slot, newStep, stepLimit);
    }
  }

  /**
   * Record a hidden tile's effect WITHOUT applying it.
   *
   * Types 1, 3 and 4 are the tiles the player cannot read off the board, and
   * the reference lets the player stand on one for a beat before it does
   * anything: the roster before "PRS 1 <step>" shows them on the tile, the
   * roster after shows the result. Its game-3 "STP 4 4" at index 6 has
   * bot-Eastman at step 6 in the first and step 10 in the second.
   *
   * Applying the effect at landing time collapses that -- the player appears
   * to teleport from where they started straight to the post-jump step, never
   * visibly touching the tile. resolveHiddenTiles() applies these once the
   * reveal frame has gone out.
   */
  deferHiddenTile(slot, step, tileType, tileValue) {
    const names = this.currentPlayerNames();
    const playerName = slot < names.length ? names[slot] : `Slot ${slot}`;
    console.log(`[game] THEME: ${playerName} landed on a hidden tile at step ${step} -- holding for the reveal.`);
    this.roundMysteryEvents.push([slot, step, tileType, tileValue]);
  }

  /**
   * Apply every deferred effect parked on `step`, after its reveal.
   *
   * Entries are consumed as they resolve, so calling this twice for the same
   * step is a no-op the second time -- the reveal loop and the end-of-sequence
   * sweep can both reach a given step without double-applying.
   */
  resolveHiddenTiles(step, stepLimit) {
    const pending = this.roundMysteryEvents.filter((ev) => ev[1] === step);
    if (!pending.length) return;
    this.roundMysteryEvents = this.roundMysteryEvents.filter((ev) => ev[1] !== step);

    const names = this.currentPlayerNames();
    for (const [slot, , tileType, tileValue] of pending) {
      const playerName = slot < names.length ? names[slot] : `Slot ${slot}`;

      if (tileType === 1) {
        if (Math.random() < 0.5) {
          this.playerBipValues[slot] *= 2;
          console.log(`[game] THEME: ${playerName} hit DOUBLE OR NOTHING at step ${step} -- doubled IQ to ${this.playerBipValues[slot]}!`);
        } else {
          this.playerBipValues[slot] = 0;
          console.log(`[game] THEME: ${playerName} hit DOUBLE OR NOTHING at step ${step} -- lost all IQ points!`);
        }
      } else if (tileType === 3) {
        const iqValue = tileValue || 0;
        this.playerBipValues[slot] += iqValue;
        const action = iqValue >= 0 ? 'gained' : 'lost';
        console.log(`[game] THEME: ${playerName} hit MYSTERY at step ${step} -- it's IQ! ${action} ${Math.abs(iqValue)} IQ (new IQ: ${this.playerBipValues[slot]}).`);
      } else if (tileType === 4) {
        const turboValue = tileValue || 0;
        const destStep = Math.min(stepLimit, step + turboValue);
        console.log(`[game] THEME: ${playerName} hit MYSTERY at step ${step} -- it's a TURBO! Jumping up ${turboValue} steps to ${destStep}!`);
        this.playerSteps[slot] = destStep;
        // Unlike plain Turbo (type 8), the reference applies the destination
        // tile's effect after this jump -- its "STP 4 3" moved five players
        // onto a "STP 2 25" and every one of them gained the 25 IQ. One level
        // deep only: a jump landing on another hidden tile stops here.
        if (destStep !== step && destStep < this.boardTiles.length) {
          const [destType, destValue] = this.boardTiles[destStep];
          if (destType === 2) {
            this.playerBipValues[slot] += destValue;
            const act = destValue >= 0 ? 'gained' : 'lost';
            console.log(`[game] THEME: ${playerName} landed on IQ at step ${destStep} after the turbo -- ${act} ${Math.abs(destValue)} IQ (new IQ: ${this.playerBipValues[slot]}).`);
          }
        }
      }
    }
  }

  triggerStepTheme(slot, step, stepLimit) {
    if (step >= this.boardTiles.length) return;
    const [tileType, tileValue] = this.boardTiles[step];
    const names = this.currentPlayerNames();
    const playerName = slot < names.length ? names[slot] : `Slot ${slot}`;

    if (tileType === 0) {
      console.log(`[game] THEME: ${playerName} hit BLACK HOLE at step ${step} -- sending back to start!`);
      this.playerSteps[slot] = 0;
      this.roundBlackholeSlots.push(slot);
      // No reveal frame: Black Hole is visible on the board so it resolves in
      // place. Checked across all three reference games -- BH sits at index
      // 2 / 8 / 9 and none of them ever draws a "PRS 1 <step>".
    } else if (tileType === 1 || tileType === 3 || tileType === 4) {
      // Double or Nothing / Mystery IQ / Mystery Turbo -- held for the reveal.
      this.deferHiddenTile(slot, step, tileType, tileValue);
    } else if (tileType === 2) {
      const oldIq = this.playerBipValues[slot];
      this.playerBipValues[slot] = oldIq + tileValue;
      const action = tileValue >= 0 ? 'gained' : 'lost';
      console.log(`[game] THEME: ${playerName} hit IQ at step ${step} -- ${action} ${Math.abs(tileValue)} IQ (new IQ: ${this.playerBipValues[slot]}).`);
    } else if (tileType === 8) {
      // Plain Turbo is visible, so it resolves immediately and gets no reveal.
      const destStep = Math.min(stepLimit, step + tileValue);
      console.log(`[game] THEME: ${playerName} hit TURBO at step ${step} -- jumping up ${tileValue} steps to ${destStep}!`);
      this.playerSteps[slot] = destStep;
    } else if (tileType === 6) {
      console.log(`[game] THEME: ${playerName} hit STICKY step at step ${step} -- now stuck!`);
      this.playerStuck[slot] = true;
      // No reveal frame -- Sticky is visible too (index 13 / 12 in reference
      // games 2 and 3, neither draws a PRS 1).
    } else if (tileType === 7) {
      console.log(`[game] THEME: ${playerName} hit STUN step at step ${step} -- stunned for next question!`);
      this.playerStunned[slot] = true;
    }
  }

  currentPlayerNames() {
    if (this.room) return this.room.currentPlayerNames();
    const names = PLAYER_NAMES.slice();
    const realName = cleanGameText(this.username, 30);
    if (realName) names[0] = realName;
    return names;
  }

  // ── low-level send ──────────────────────────────────────────────────────

  async sendRaw(line) {
    if (!line.endsWith('\r\n')) line += '\r\n';
    console.log(`SEND [${this.label()}]: ${line.replace(/\r\n$/, '')}`);
    try {
      await this.writer.write(encodeCp1252(line));
      return true;
    } catch (e) {
      console.log(`[game] STAT: Send failed (${e}) -- treating client as disconnected.`);
      this.markClientInactive('Socket send failed; stopping active session.');
      return false;
    }
  }

  /**
   * PRIVMSG from the bot to `target`.
   *
   * When the HOST (gameSlot === 0) is in a shared room and the target is its
   * own IRC name, the message is broadcast to every connected room member so
   * guests see the same game. This is the single hook that makes one client's
   * game loop drive everyone's screen.
   *
   * Guests only ever send to themselves -- a guest broadcasting would reach
   * for the HOST's sendLock from its own read loop and the two could wedge.
   *
   * Clients still showing an ad (adAckPending) or waiting on their catch-up
   * (guestCatchUpPending) are skipped: a mid-ad packet knocks the client's
   * state machine off track, and a guest that has not caught up yet would
   * receive packets for a round it has no context for.
   *
   * NOTE: addressed to each member's own nick, never to the channel. Sending
   * game packets as "PRIVMSG #Big_000" was tried and the client ignores them
   * outright -- it only processes PRIVMSGs addressed to its own nick.
   */
  botPriv(target, body) {
    if (this.room && target === this.clientIrcName && this.ingame === 1 && this.gameSlot === 0) {
      const members = this.room.clients;
      if (members.length) {
        const prefix = `:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG`;
        const sends = [];
        for (const c of members) {
          if (c.connected && !c.adAckPending && !c.guestCatchUpPending) {
            sends.push(c.sendRaw(`${prefix} ${c.clientIrcName} :${body}`));
          }
        }
        return Promise.all(sends).then(() => true);
      }
    }
    return this.sendRaw(`:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG ${target} :${body}`);
  }

  // ── session bookkeeping ──────────────────────────────────────────────────

  activeSession(sessionGeneration = null) {
    if (this.ingame !== 1 || !this.connected) return false;
    if (sessionGeneration !== null && sessionGeneration !== this.sessionGeneration) return false;
    return true;
  }

  markClientInactive(reason) {
    if (this.ingame === 0 && this.room === null && this._gsRoomStartTime === null) return;
    if (reason) console.log(`[game] STAT: ${reason}`);
    this.sessionGeneration += 1;
    this.ingame = 0;
    this.adAckPending = false;

    if (this.room !== null) {
      // Only the HOST tears the shared game down. This used to null
      // roomStartTime / questionRevealTime unconditionally -- now that those
      // delegate to the room, a GUEST disconnecting would have stopped the
      // clock and killed the round for everyone still playing.
      if (this.gameSlot === 0) {
        this.room.roomStartTime = null;
        this.room.questionRevealTime = null;
        this.room.roundResolved = true;
        this.room.questionGeneration += 1;
      }
      if (this.username) broadcastPleave(this.room, this.username);
      const leavingRoomName = this.room.roomName;
      this.room.removeClient(this);
      this.room = null;
      this.gameSlot = -1;
      this.guestCatchUpPending = false;
      releaseGameRoomIfEmpty(leavingRoomName);
      // After the release, so a room that just emptied reports 0 from the
      // config fallback rather than a stale live count.
      broadcastRoomListUpdate(leavingRoomName);
    } else {
      // Solo path, or a lobby disconnect before any room was joined.
      this._gsRoomStartTime = null;
      this._gsQuestionRevealTime = null;
      this._gsRoundResolved = true;
      this._gsQuestionGeneration += 1;
    }
  }

  async sendElapsedSt(sessionGeneration = null) {
    if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) return 0;
    if (this.roomStartTime === null) return 0;
    let elapsed = Date.now() - this.roomStartTime;
    if (elapsed <= this.lastReportedElapsed) elapsed = this.lastReportedElapsed + 1;
    this.lastReportedElapsed = elapsed;
    await this.botPriv(this.clientIrcName, `ST S 0 ${elapsed} 0 0 0`);
    return elapsed;
  }

  async sendSponsorAd(adFile = null, includeSt = true) {
    const ad = normalizeAdFilename(adFile || pickRandomAd(), 'sponsor.srf');
    return this.sendLock.withLock(async () => {
      if (includeSt) {
        if (this.roomStartTime === null) await this.botPriv(this.clientIrcName, 'ST S 0 0 0 0 0');
        else await this.sendElapsedSt();
      }
      await this.botPriv(this.clientIrcName, `SPA Ad ${ad} ${ad} 0`);
      return ad;
    });
  }

  /**
   * The suspected AdSegue path: BS -> [3 s] -> EGS -> [1 s] -> SA ad list.
   *
   * Console-only, and deliberately not wired into the game loop. This exact
   * "BS -> EGS -> SA" ordering was tried as an ad-break bumper and disproven
   * against the reference capture (see ADSEGUE_BUMPER_SECONDS and the note in
   * startBlowoutQuestion) -- EGS belongs at the true end of the game and
   * nowhere else. It is kept because it is useful for poking the client by
   * hand from the console, which is what the Python uses it for too.
   *
   * The BS trailer is the Python's verbatim hardcoded one, not a computed
   * elapsed: this is a probe, and matching the Python byte-for-byte is the
   * point.
   */
  async sendAdSegue(adFile = null) {
    await this.sendLock.withLock(() => this.botPriv(this.clientIrcName, 'BS S 0 350000 350000 35000 0'));
    await sleep(3000);
    await this.sendLock.withLock(() => this.botPriv(this.clientIrcName, 'EGS S 0 0 0 0 0'));
    await sleep(1000);
    return this.sendBlowoutAds(adFile);
  }

  async sendBlowoutAds(primaryAdFile = null, sessionGeneration = null) {
    if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) return [];

    const elapsed = this.roomStartTime === null ? 0 : Date.now() - this.roomStartTime;
    // SA's trailer is the same "S 0 <reveal_at> <elapsed> <duration> 0" shape
    // as every other timed packet, with reveal_at == elapsed + duration. This
    // used a leftover sum_val formula -- it put (elapsed + reveal_at) in the
    // reveal slot and reveal_at itself in the DURATION slot, producing e.g.
    // "S 0 1469132 584566 884566 0": a 15-minute ad break announced as
    // 884 seconds long, starting in the past.
    const durationMs = 300000;
    const revealAt = elapsed + durationMs;

    const defaultAds = ['air212.srf', 'usr135.srf', 'hug173.srf', 'voc213.srf'];
    let ads;
    if (this.currentSegmentAds && this.currentSegmentAds.length >= 4) {
      // The capture's SA replays exactly this segment's own ADLI ads. This
      // branch was missing entirely, so it always fell through to the
      // primary+defaults path below.
      ads = this.currentSegmentAds.slice(0, 4).map((a) => normalizeAdFilename(a));
    } else if (primaryAdFile) {
      const normPrimary = normalizeAdFilename(primaryAdFile);
      ads = [normPrimary];
      for (const defaultAd of defaultAds) {
        const normDefault = normalizeAdFilename(defaultAd);
        if (!ads.includes(normDefault)) ads.push(normDefault);
      }
    } else {
      ads = defaultAds.map((a) => normalizeAdFilename(a));
    }
    // Hard cap: the header says "AL 4", and primary + 4 unique defaults makes
    // FIVE. Announcing 4 and then sending 5 is what killed the client right
    // after the blowout explosion.
    ads = ads.slice(0, 4);

    const adListStr = ads.map((ad) => `Ad ${ad} ${ad} 6000`).join(' ');
    const msg = `SA 1 AL 4 ${adListStr} S 0 ${revealAt} ${elapsed} ${durationMs} 0`;

    await this.sendLock.withLock(() => this.botPriv(this.clientIrcName, msg));
    console.log(`[game] STAT: Sent blowout ads sequence: ${msg}`);
    return ads;
  }

  startKeepalive() {
    this.keepaliveTimer = setInterval(() => {
      if (!this.connected) { this.stopKeepalive(); return; }
      // Never ping while the client is sitting on the sponsor ad waiting to
      // send AI. The Python's keepalive has this exact guard, with the note
      // that the client "doesn't tolerate ANY extra traffic landing in it,
      // not just elapsed-time STs" -- the same window that kaloop's ST was
      // found to poison. A PING is extra traffic like any other.
      //
      // This port pinged unconditionally, so whether a client survived
      // entering a room came down to whether its 30 s tick happened to fall
      // between ADLE and AI. The HOST is the likelier loser: it has to create
      // the room and generate the board first, which pushes its ad burst
      // later into the interval.
      if (this.adAckPending) return;
      this.sendRaw(`PING :${SERVER_NAME}`);
      this.pingsAwaitingPong += 1;
      if (this.pingsAwaitingPong >= KEEPALIVE_MISSES_BEFORE_DEAD) {
        // A client that crashed outright leaves its socket open, so nothing
        // else will ever notice it is gone: the read loop never ends and no
        // QUIT arrives. Without this the entry stays in the room forever,
        // holding a game slot and inflating the roster, and the PLEAVE that
        // markClientInactive would send never fires.
        console.log(
          `[game] STAT: ${this.label()} missed ${this.pingsAwaitingPong} PONGs -- treating as dead.`
        );
        this.stopKeepalive();
        this.markClientInactive('No PONG response; assuming the client died.');
        this.connected = false;
        Promise.resolve(this.conn.close()).catch(() => {});
      }
    }, 30000);
  }

  stopKeepalive() {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  startKaloop(sessionGeneration) {
    this.stopKaloop();
    this.kaloopTimer = setInterval(async () => {
      if (!this.activeSession(sessionGeneration)) {
        this.stopKaloop();
        return;
      }
      if (!KALOOP_HEARTBEAT_ENABLED) {
        // The reference has no periodic heartbeat at all: 15 ST in a whole
        // game against our 60, every one event-driven (8 immediately after
        // QATE, the rest following RS / SAS / BS / LO). Every timing bug found
        // in the Python source -- the 99 s question timer, the end-game
        // screen, the post-catch-up guest window -- was a stray ST landing
        // where the reference sends nothing.
        return;
      }
      if (this.roomStartTime === null || this.adAckPending) return;
      if (Date.now() < this.kaloopSuppressUntil) return;
      await this.sendLock.withLock(async () => {
        if (!this.activeSession(sessionGeneration) || this.roomStartTime === null || this.adAckPending) return;
        if (Date.now() < this.kaloopSuppressUntil) return;
        await this.sendElapsedSt(sessionGeneration);
      });
    }, 20000);
  }

  stopKaloop() {
    if (this.kaloopTimer !== null) {
      clearInterval(this.kaloopTimer);
      this.kaloopTimer = null;
    }
  }

  // ── player list / board wire helpers ─────────────────────────────────────

  /**
   * PLB/PLI/PLE roster.
   * @param stateFlags per-slot list; the capture shows this field flip to 1 for
   *   exactly one frame when a player lands on Black Hole (step already reset
   *   to 0), then back to 0 on the very next frame.
   * @param noDelay skip the 400 ms per-PLI pace. Required inside a climb
   *   sequence, where the frames carry the timing and the roster must be
   *   instantaneous.
   */
  async sendPlayerList(steps, bipValues = null, sessionGeneration = null, stateFlags = null, noDelay = false) {
    const names = this.currentPlayerNames();
    if (bipValues === null) bipValues = this.playerBipValues;
    const safeBips = displayPlayerBips(bipValues, names.length);
    const paddedSteps = steps.concat(new Array(Math.max(0, names.length - steps.length)).fill(0));
    // Widen the wire clamp to 23 once the blowout has unlocked the bonus steps,
    // the same way the Python does -- otherwise a player who climbs past 20
    // still reports as 20 and the top of the pyramid is unreachable on screen.
    const wireMax = this.pyramidBonusUnlocked ? PYRAMID_MAX_STEP : PYRAMID_WIRE_MAX_STEP;
    const safeSteps = displayPlayerSteps(paddedSteps, wireMax);

    return this.sendLock.withLock(async () => {
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) {
        console.log('[game] STAT: Client no longer connected -- skipping player-list send.');
        return false;
      }
      await this.botPriv(this.clientIrcName, `PLB ${names.length}`);
      for (let slot = 0; slot < names.length; slot++) {
        if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) {
          console.log('[game] STAT: Client disconnected during player-list send -- stopping PLI stream.');
          return false;
        }
        const iq = safeBips[slot];
        const state = stateFlags && slot < stateFlags.length ? stateFlags[slot] : 0;
        await this.botPriv(this.clientIrcName, `PLI ${slot} BIP ${iq} ${safeSteps[slot]} ${state} P ${names[slot]}`);
        if (!noDelay) await sleep(400);
        if (!noDelay && sessionGeneration !== null && !this.activeSession(sessionGeneration)) {
          console.log('[game] STAT: Client disconnected during player-list delay -- stopping PLI stream.');
          return false;
        }
      }
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) {
        console.log('[game] STAT: Client disconnected before PLE -- stopping player-list send.');
        return false;
      }
      await this.botPriv(this.clientIrcName, 'PLE');
      return true;
    });
  }

  getPrmdBody() {
    const pairs = this.boardTiles.map((t) => `STP ${t[0]} ${t[1] === null ? 0 : t[1]}`).join(' ');
    return `PRMD ${pairs}`;
  }

  /**
   * Same clamped room-elapsed computation sendElapsedSt uses, but without
   * emitting an ST -- for the real "S 0 <target> <elapsed> <duration> 0"
   * trailer that NGS/QRS/PRS need instead of the all-zero stub they used to
   * carry. The client drives its animations off these values; all-zero means
   * every animation is instantaneous.
   */
  currentElapsedMs() {
    if (this.roomStartTime === null) return 0;
    let elapsed = Date.now() - this.roomStartTime;
    if (elapsed <= this.lastReportedElapsed) elapsed = this.lastReportedElapsed + 1;
    this.lastReportedElapsed = elapsed;
    return elapsed;
  }

  ngsPacket() {
    const elapsed = this.currentElapsedMs();
    const target = elapsed + NGS_BUILD_DURATION_MS;
    // Remember when the build finishes so the next question can hold its
    // ST+QS until the pyramid is actually standing.
    this.pyramidBuildUntil = Date.now() + NGS_BUILD_DURATION_MS + PYRAMID_BUILD_SETTLE_MS;
    return `NGS ${this.getPrmdBody()} S 0 ${target} ${elapsed} ${NGS_BUILD_DURATION_MS} 0`;
  }

  movementQrsPacket() {
    const elapsed = this.currentElapsedMs();
    const target = elapsed + QRS_CLIMB_DURATION_MS;
    // Stash the trailer so the PRS that follows can reuse it verbatim -- the
    // reference pairs them byte for byte:
    //   QRS PRMD ... S 0 532047 529047 3000 0
    //   PRS 0        S 0 532047 529047 3000 0
    // currentElapsedMs is monotonic (it bumps by 1 ms when called twice in the
    // same millisecond), so letting PRS compute its own put the two packets
    // 1 ms apart on every round.
    this.lastClimbTrailer = `S 0 ${target} ${elapsed} ${QRS_CLIMB_DURATION_MS} 0`;
    return `QRS ${this.getPrmdBody()} ${this.lastClimbTrailer}`;
  }

  /**
   * Silence heartbeat STs on this client for `ms`.
   *
   * EGS and QS carry the same "S 0 <reveal_at> <elapsed> <duration> 0" trailer
   * shape, and the client re-derives its screen timer from the elapsed value
   * in every ST it receives -- so a heartbeat landing mid-window moves the
   * deadline out from under it.
   */
  suppressKaloop(ms) {
    this.kaloopSuppressUntil = Math.max(this.kaloopSuppressUntil, Date.now() + ms);
  }

  /** Block until the most recent NGS build animation has finished. */
  async waitForPyramidBuild(sessionGeneration = null) {
    let remaining = this.pyramidBuildUntil - Date.now();
    if (remaining <= 0) return true;
    console.log(`[game] STAT: Holding QS for ${(remaining / 1000).toFixed(1)}s while the pyramid finishes building.`);
    // The reference sends nothing between QATE and the ST that follows the
    // build; a heartbeat here would move the elapsed we derive qs_start from.
    this.suppressKaloop(remaining + PYRAMID_BUILD_PONG_TIMEOUT_MS + 2000);
    while (remaining > 0) {
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) return false;
      await sleep(Math.min(remaining, 500));
      remaining = this.pyramidBuildUntil - Date.now();
    }
    return this.waitForClientResponsive(sessionGeneration);
  }

  /**
   * Round-trip a PING and wait for the PONG, so a client that is still busy
   * animating holds the question back by however far behind it actually is.
   *
   * Deliberately not reusing pingsAwaitingPong: that drives dead-client
   * detection, and resetting it here would hide missed keepalives.
   */
  async waitForClientResponsive(sessionGeneration = null) {
    if (!PYRAMID_BUILD_PROBE_ENABLED) return true;
    const seen = this.pongSeq || 0;
    const started = Date.now();
    this.sendRaw(`PING :${SERVER_NAME}`);
    while ((this.pongSeq || 0) === seen) {
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) return false;
      if (Date.now() - started >= PYRAMID_BUILD_PONG_TIMEOUT_MS) {
        console.log(`[game] STAT: No PONG within ${PYRAMID_BUILD_PONG_TIMEOUT_MS}ms of the pyramid build -- sending the question anyway.`);
        return true;
      }
      await sleep(100);
    }
    const waited = Date.now() - started;
    if (waited > 250) {
      console.log(`[game] STAT: Client took ${waited}ms to answer after the pyramid build -- question held that much longer.`);
    }
    return true;
  }

  /**
   * Play the post-QRS movement as separate, spaced animation frames.
   *
   * Reference shape (CosmicBotlol013, every result round):
   *
   *   QRS ... | PRS 0 | roster | PRS 0 (+3305) | roster | PRS 0 (+1303)
   *
   * with a hidden-tile reveal taking a middle slot as "PRS 1 <step>". The
   * roster between frames carries the visible state change -- a Black Hole
   * player appears at step 0 with state flag 1 in the frame right after the
   * climb, then the flag clears on the following one. Those rosters go out
   * with noDelay: the reference fits two full rosters plus two climb waits
   * into 4609 ms, so its roster blocks cost no measurable time and the frames
   * carry the pacing. This used to be backwards -- 400 ms per PLI with every
   * PRS in the same millisecond.
   */
  async sendClimbSequence(sessionGeneration = null, firstPrsMatchesQrs = true) {
    const names = this.currentPlayerNames();
    const stepLimit = this.pyramidBonusUnlocked ? PYRAMID_MAX_STEP : PYRAMID_TOP_STEP;

    const roster = (flags) => this.sendPlayerList(
      displayPlayerSteps(this.playerSteps),
      displayPlayerBips(this.playerBipValues, names.length),
      sessionGeneration,
      flags,
      true
    );
    const gap = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) return false;
        await sleep(Math.min(deadline - Date.now(), 500));
      }
      return true;
    };

    // Frame 1: the climb itself, pairing with the QRS trailer.
    let ok = true;
    await this.sendLock.withLock(async () => {
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) { ok = false; return; }
      if (!(await this.sendPrsPacket(firstPrsMatchesQrs))) ok = false;
    });
    if (!ok) return false;

    // The movers now walk, one after another, and nothing else may land until
    // they have all arrived.
    const climbWaitMs = CLIMB_SEQUENCE_V2
      ? Math.min(CLIMB_WAIT_MAX_MS, Math.max(CLIMB_WAIT_MIN_MS,
          CLIMB_WAIT_BASE_MS + CLIMB_WAIT_PER_STEP_MS * this.roundStepsMoved))
      : CLIMB_FRAME_GAP_MS;
    if (CLIMB_SEQUENCE_V2) {
      console.log(`[game] STAT: Climb of ${this.roundStepsMoved} total steps -- holding ${(climbWaitMs / 1000).toFixed(1)}s for the walk.`);
      if (!(await gap(climbWaitMs))) return false;
    }

    // Black Hole return-to-start. Steps are already reset to 0, so this is the
    // frame where the fall becomes visible. The swallowed sprites travel back
    // on their OWN plain PRS 0, which has to land before any reveal flip.
    const blackholeFlags = names.map((_, slot) => (this.roundBlackholeSlots.includes(slot) ? 1 : 0));
    if (!(await roster(blackholeFlags))) return false;
    if (CLIMB_SEQUENCE_V2) {
      if (this.roundBlackholeSlots.length) {
        await this.sendLock.withLock(async () => {
          if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) { ok = false; return; }
          if (!(await this.sendPrsPacket(false))) ok = false;
        });
        if (!ok) return false;
        if (!(await gap(REVEAL_BEAT_MS))) return false;
      }
    } else if (!(await gap(CLIMB_FRAME_GAP_MS))) {
      return false;
    }

    // Middle frames: one per distinct hidden TILE, not per player. A tile four
    // players hit appears four times in roundMysteryEvents, and each extra
    // frame would cost another CLIMB_FRAME_GAP_MS for no visual gain -- the
    // frame identifies a board index, not a player.
    let revealedSteps = [];
    for (const ev of this.roundMysteryEvents) {
      if (!revealedSteps.includes(ev[1])) revealedSteps.push(ev[1]);
    }
    if (revealedSteps.length > MAX_REVEAL_FRAMES_PER_ROUND) {
      console.log(`[game] STAT: ${revealedSteps.length} hidden tiles hit this round -- revealing the first ${MAX_REVEAL_FRAMES_PER_ROUND}.`);
      revealedSteps = revealedSteps.slice(0, MAX_REVEAL_FRAMES_PER_ROUND);
    }
    for (const step of revealedSteps) {
      // The flip. Only the hidden flavours need this -- everything else
      // animates off a plain PRS 0 when a player is moved onto it.
      await this.sendLock.withLock(async () => {
        if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) { ok = false; return; }
        const elapsed = this.currentElapsedMs();
        const target = elapsed + QRS_CLIMB_DURATION_MS;
        if (!(await this.botPriv(this.clientIrcName, `PRS 1 ${step} S 0 ${target} ${elapsed} ${QRS_CLIMB_DURATION_MS} 0`))) ok = false;
      });
      if (!ok) return false;
      // Let the flip land before committing its effect.
      if (CLIMB_SEQUENCE_V2 && !(await gap(REVEAL_COMMIT_DELAY_MS))) return false;
      // The tile has now been revealed, so its effect lands: the roster below
      // is the first frame showing the player anywhere other than standing on
      // it. Until this point they were held in place by deferHiddenTile.
      this.resolveHiddenTiles(step, stepLimit);
      if (!(await roster(null))) return false;
      if (CLIMB_SEQUENCE_V2) {
        // The commit half of the pair: the roster above says where everyone
        // ended up, this is what walks them there.
        await this.sendLock.withLock(async () => {
          if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) { ok = false; return; }
          if (!(await this.sendPrsPacket(false))) ok = false;
        });
        if (!ok) return false;
        if (!(await gap(REVEAL_BEAT_MS))) return false;
      } else if (!(await gap(CLIMB_FRAME_GAP_MS))) {
        return false;
      }
    }

    // Anything the cap skipped still has to resolve -- a deferred effect that
    // never ran would leave the player parked on the tile forever. These land
    // without their own reveal frame.
    for (const ev of [...this.roundMysteryEvents]) {
      if (!revealedSteps.includes(ev[1])) this.resolveHiddenTiles(ev[1], stepLimit);
    }

    // A deferred Turbo can be what puts the leader on the top step, and that
    // is only known now -- sendResults ran its own check before the climb,
    // when the jump had not happened yet.
    const leader = this.playerSteps.length ? Math.max(...this.playerSteps) : 0;
    if (!this.pyramidBonusUnlocked && leader >= PYRAMID_TOP_STEP) {
      this.pyramidBonusUnlocked = true;
      this.pyramidSegmentFinished = true;
      console.log('[game] STAT: Pyramid top reached on a hidden-tile reveal -- blowout will unlock the 3 bonus steps.');
    } else if (this.pyramidBonusUnlocked && leader >= PYRAMID_MAX_STEP) {
      this.pyramidSegmentFinished = true;
    }

    // Penultimate frame, then the roster with every flash cleared.
    await this.sendLock.withLock(async () => {
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) { ok = false; return; }
      if (!(await this.sendPrsPacket(false))) ok = false;
    });
    if (!ok) return false;
    if (!(await roster(null))) return false;
    if (!(await gap(CLIMB_SETTLE_GAP_MS))) return false;

    // Final settle frame -- the reference ends on a PRS with no roster after
    // it; the next thing the client sees is the QT for round n+1.
    await this.sendLock.withLock(async () => {
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) { ok = false; return; }
      if (!(await this.sendPrsPacket(false))) ok = false;
    });
    return ok;
  }

  /**
   * QT field 0: the step generator the client draws during the pyramid build.
   *
   * It is the max steps earnable this round -- answerCount - 1, i.e. one more
   * than the button mode: 2 answers -> 1, 3 -> 2, 4 -> 3.
   *
   * This used to return roundInSegment + 1, which is only right by accident:
   * the original game happened to send 2, then 3, then 4 answers per segment,
   * so the round number and the answer count moved together. With a shuffled
   * question bank they diverge, and the client drew the wrong number of steps
   * -- a 3-answer question announced 1 step, a 2-answer question announced 2.
   */
  qtStepField(answerCount) {
    return qtButtonField(answerCount) + 1;
  }

  /**
   * SWS (warning + insurance window) -> BI (clients buy in) -> SI (insured
   * roster) -> apply effects -> SRS (results) -> updated PLB/PLI/PLE -> PRS.
   *
   * STORM_SYSTEM_ENABLED is false, exactly as in the Python: the client
   * crashes on the SWS/SRS field layout, which has never been checked against
   * a real capture. Reachable from the console's STORM command regardless, so
   * the field shapes can be probed without turning it on for real games.
   */
  async runStormSequence(sessionGeneration = null) {
    if (sessionGeneration === null) sessionGeneration = this.sessionGeneration;
    if (!this.activeSession(sessionGeneration)) {
      console.log('[game] STAT: Client no longer connected -- skipping storm.');
      return;
    }
    const names = this.currentPlayerNames();
    this.stormInsured = new Set();
    this.stormWindowOpen = true;

    // Chosen up front so the warning, the animation and the effects all agree.
    const typeIdx = Math.floor(Math.random() * STORM_TYPES.length);
    const stormType = STORM_TYPES[typeIdx];
    const durationMs = STORM_INSURANCE_WINDOW_SECONDS * 1000;

    console.log(`[game] STAT: Storm warning (SWS) for ${stormType} -- insurance window open.`);
    let stop = false;
    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) { stop = true; return; }
      // SWS STM <type> <cost_iq> <duration_ms> <duration_ms> S 0 0 0 0 0
      await this.botPriv(
        this.clientIrcName,
        `SWS STM ${typeIdx} ${STORM_INSURANCE_COST} ${durationMs} ${durationMs} S 0 0 0 0 0`
      );
    });
    if (stop) return;

    // Bots decide independently and staggered across the window; the human in
    // slot 0 decides by sending its own BI, which handleBI picks up off the
    // read loop. Not awaited -- it has to overlap the window, not precede it.
    (async () => {
      for (let slot = 1; slot < names.length; slot++) {
        await sleep(500 + Math.random() * 2500);
        if (!this.activeSession(sessionGeneration)) return;
        if (!this.stormWindowOpen) return;
        if (this.playerBipValues[slot] >= STORM_INSURANCE_COST
            && Math.random() < STORM_BOT_BUY_CHANCE) {
          this.playerBipValues[slot] -= STORM_INSURANCE_COST;
          this.stormInsured.add(slot);
          console.log(`[game] STAT: ${names[slot]} bought storm insurance.`);
          await this.sendLock.withLock(async () => {
            if (this.activeSession(sessionGeneration)) {
              await this.botPriv(this.clientIrcName, 'BI 1');
            }
          });
        }
      }
    })().catch((e) => console.log(`[game] STAT: storm bot decisions failed: ${e}`));

    await sleep(STORM_INSURANCE_WINDOW_SECONDS * 1000);
    if (!this.activeSession(sessionGeneration)) return;
    this.stormWindowOpen = false;
    const insured = new Set(this.stormInsured);

    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) { stop = true; return; }
      // SI STM <type> <count> <count> <slot>xcount S 0 0 0 0 0
      const slots = [...insured].sort((a, b) => a - b);
      const si = slots.length
        ? `SI STM ${typeIdx} ${slots.length} ${slots.length} ${slots.join(' ')} S 0 0 0 0 0`
        : `SI STM ${typeIdx} 0 0 S 0 0 0 0 0`;
      await this.botPriv(this.clientIrcName, si);
    });
    if (stop) return;

    console.log(`[game] STAT: Storm resolving as ${stormType}; insured slots: [${[...insured].sort((a, b) => a - b).join(', ')}]`);
    const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
    for (let slot = 0; slot < names.length; slot++) {
      if (insured.has(slot)) continue;
      if (stormType === 'ION') {
        this.playerBipValues[slot] -= randInt(10, 40);
      } else if (stormType === 'METEOR') {
        this.applyMovement(slot, -randInt(1, 2), 'storm');
        this.playerBipValues[slot] -= randInt(5, 20);
      } else if (stormType === 'TORNADO') {
        this.applyMovement(slot, randInt(-3, 3), 'storm');
      }
    }

    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) { stop = true; return; }
      // SRS STM <type> <0> S 0 0 0 0 0
      await this.botPriv(this.clientIrcName, `SRS STM ${typeIdx} 0 S 0 0 0 0 0`);
    });
    if (stop) return;

    await this.sendPlayerList(
      this.playerSteps,
      displayPlayerBips(this.playerBipValues, names.length),
      sessionGeneration
    );
    // Empty PRS animates the avatars to wherever the storm left them.
    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) return;
      await this.sendPrsPacket(false);
    });
  }

  /** BIR unlock shape: lock=1 step=0 b=0, current players filled in. */
  roomUnlockLine(playerCount) {
    const rname = this.room ? this.room.roomName : 'Big_000';
    const dname = this.room ? this.room.displayName : 'Big_000';
    return makeBirLine(rname, dname, { lock: 1, step: 0, b: 0, players: playerCount, status: -1 });
  }

  /** BIR blowout shape: lock=1 step=PYRAMID_TOP_STEP b=0, status=1. */
  roomBlowoutLine(playerCount) {
    const rname = this.room ? this.room.roomName : 'Big_000';
    const dname = this.room ? this.room.displayName : 'Big_000';
    return makeBirLine(rname, dname, {
      lock: 1, step: PYRAMID_TOP_STEP, b: 0, players: playerCount, status: 1,
    });
  }

  /**
   * ADLB/ADLI/ADLE with 4 freshly-picked ads, stashed on currentSegmentAds so
   * the blowout SA packet (which reuses this segment's own ads, per the
   * capture) can find them later.
   *
   * The reference sends this after EVERY NGS, not just the first -- this
   * server only ever sent an ad list once, during the lobby handshake.
   *
   * Unlike the lobby-entry list this one is NOT preceded by SPA and the client
   * never AI-acks it; see the Python source for the captures that established
   * that timing, not SPA, is what matters here.
   */
  async sendFreshAdList() {
    const picks = [];
    for (let i = 0; i < 8 && picks.length < 4; i++) {
      const cand = normalizeAdFilename(pickRandomAd());
      if (!picks.includes(cand)) picks.push(cand);
    }
    while (picks.length < 4) picks.push(normalizeAdFilename(null, `ad${picks.length}.srf`));
    this.currentSegmentAds = picks;
    await this.botPriv(this.clientIrcName, `ADLB ${picks.length}`);
    for (let idx = 0; idx < picks.length; idx++) {
      await this.botPriv(this.clientIrcName, `ADLI ${idx} Ad ${picks[idx]} ${picks[idx]} 0`);
    }
    await this.botPriv(this.clientIrcName, 'ADLE');
  }

  /**
   * PRS 0 with the climb trailer. By default reuses the trailer from the QRS
   * this PRS belongs to (see movementQrsPacket); pass false for a standalone
   * frame that isn't paired with a preceding QRS. The trailer is consumed on
   * use, so later frames in a sequence carry their own current timing.
   */
  async sendPrsPacket(matchQrs = true) {
    let trailer = matchQrs ? this.lastClimbTrailer : '';
    this.lastClimbTrailer = '';
    if (!trailer) {
      const elapsed = this.currentElapsedMs();
      const target = elapsed + QRS_CLIMB_DURATION_MS;
      trailer = `S 0 ${target} ${elapsed} ${QRS_CLIMB_DURATION_MS} 0`;
    }
    return this.botPriv(this.clientIrcName, `PRS 0 ${trailer}`);
  }

  /** QT + QATB/QATI/QATE for `q`. Used by both the live round and the guest
   *  catch-up so the two can never describe the same question differently. */
  async sendQtCluster(q, durationSeconds) {
    const { openEnded, wireAnswers, qtStep, qtButtonMode } = qtFieldsFor(q);
    assertValidQt(qtStep, qtButtonMode, q.is_single_word ? 'single-word question' : 'question');
    await this.botPriv(this.clientIrcName, `QT ${qtStep} ${qtButtonMode} ${durationSeconds} \x02${q.text}\x02`);
    if (openEnded) {
      // One slot holding a "-" placeholder rather than any answer text. The
      // dash is what makes the client draw a TEXT-ENTRY BOX; sending real
      // strings here renders answer buttons instead, leaving nothing to type
      // into.
      //
      // Sent only for symmetry with the capture. The client provably does NOT
      // read this list in open-ended mode -- 0x43bcad jumps straight to the
      // ctor without touching the answer table -- so neither the count nor the
      // text nor the \x02 wrapping has any effect here.
      await this.botPriv(this.clientIrcName, 'QATB 1');
      await this.botPriv(this.clientIrcName, 'QATI 0 \x02-\x02');
    } else {
      await this.botPriv(this.clientIrcName, `QATB ${wireAnswers.length}`);
      for (let i = 0; i < wireAnswers.length; i++) {
        await this.botPriv(this.clientIrcName, `QATI ${i} \x02${wireAnswers[i]}\x02`);
      }
      if (CLEAR_UNUSED_ANSWER_SLOTS) {
        for (let i = wireAnswers.length; i < MAX_ANSWER_SLOTS; i++) {
          await this.botPriv(this.clientIrcName, `QATI ${i} \x02 \x02`);
        }
      }
    }
    await this.botPriv(this.clientIrcName, 'QATE');
  }

  async sendAqQuestionPacket(q) {
    const [answersAb, answersCd] = answerPairStrings(q.answers);
    const roundId = this.questionGeneration;
    const duration = Math.trunc(q.time || 30);
    await this.botPriv(
      this.clientIrcName,
      `AQ A 1 ${roundId} \x02${q.text}\x02 \x02${answersAb}\x02 \x02${answersCd}\x02 ${duration}`
    );
  }

  // ── the question/answer/reveal round loop ─────────────────────────────────

  async sendQuestion(q) {
    const sessionGeneration = this.sessionGeneration;
    if (!this.activeSession(sessionGeneration)) {
      console.log('[game] STAT: Client no longer connected -- not sending next question.');
      return;
    }

    if (this.questionIndex === 19 && !q.text.includes('Which of these actual videos would you rather watch')) {
      const videoQ = QUESTIONS.find((c) => c.text.includes('Which of these actual videos would you rather watch'));
      if (videoQ) q = videoQ;
    }

    const isVideoQ = q.text.includes('Which of these actual videos would you rather watch');
    if (isVideoQ) {
      q = Object.assign({}, q, { answer_steps: [6, 4, 2], time: 20, reveal_ms: 20000 });
    }

    q = questionForWire(q);
    this.currentQuestion = q;
    this.roundResolved = false;
    this.questionGeneration += 1;
    const gen = this.questionGeneration;

    const durationMs = V008_ACTIVATION_MERGE
      ? Math.max(1000, Math.trunc(q.reveal_ms || V008_QS_DURATION_MS))
      : Math.max(1000, Math.trunc(q.time || 30) * 1000);
    const durationSeconds = Math.max(1, Math.round(durationMs / 1000));
    const packetMode = QUESTION_PACKET_MODE.toUpperCase();

    const sendQuestionText = async () => {
      if (packetMode === 'QT' || packetMode === 'QT_PLUS_AQ') {
        await this.sendQtCluster(q, durationSeconds);
      }
      if (packetMode === 'QT_PLUS_AQ' || packetMode === 'AQ_ONLY') {
        await this.sendAqQuestionPacket(q);
      }
    };

    // Round 1 of a segment is the only round where anything separates the QT
    // cluster from ST+QS: waitForPyramidBuild() returns immediately once the
    // NGS build has elapsed, so rounds 2+ send the whole lot back to back.
    //
    // That gap is exactly what broke round 1. QATE is what constructs the
    // Question (client 0x43bcad -> 0x446cae, stored at model+0x8bc); arriving
    // ~10 s early, mid pyramid-build, it was gone by the time QS referenced it,
    // so the round never drew and always timed out with no AQ. Every round that
    // renders has QT and QS adjacent -- so send them adjacent here too.
    //
    // Set QT_AFTER_PYRAMID_BUILD = false to restore the old split.
    if (!QT_AFTER_PYRAMID_BUILD) {
      await this.sendLock.withLock(sendQuestionText);
    }

    if (!(await this.waitForPyramidBuild(sessionGeneration))) {
      console.log('[game] STAT: Client disconnected during pyramid build -- not sending QS.');
      return;
    }

    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) return;
      if (QT_AFTER_PYRAMID_BUILD) await sendQuestionText();
      // Reference: ST is always sent immediately before QS; its elapsed value
      // becomes the QS baseline.
      const elapsed = await this.sendElapsedSt(sessionGeneration);
      // QS field order, from "QS 0 0 S 0 92393 72393 20000 0":
      //   [4] reveal_at -- elapsed at which the timer expires
      //   [5] qs_start  -- elapsed at which the countdown begins, always
      //                    ST + 12000 in the reference regardless of the NGS
      //                    build length, so it is a constant offset and not
      //                    the build duration
      // These two were swapped here (elapsed in [4], revealAt in [5]) and the
      // build offset was missing entirely.
      const qsStart = elapsed + NGS_BUILD_DURATION_MS;
      const revealAt = qsStart + durationMs;
      if (PREFLIGHT_QS_ENABLED) {
        await this.botPriv(this.clientIrcName, 'PreflightQS S 0 0 0 0 0');
      }
      await this.botPriv(this.clientIrcName, `QS 0 0 S 0 ${revealAt} ${qsStart} ${durationMs} 0`);
      this.questionRevealTime = this.roomStartTime + revealAt;
    });

    this.questionWatchdog(gen, this.questionRevealTime, sessionGeneration).catch((e) =>
      console.error('[game] question watchdog error:', e)
    );
  }

  async questionWatchdog(gen, revealTime, sessionGeneration) {
    const waitMs = revealTime - Date.now() + 3000;
    if (waitMs > 0) await sleep(waitMs);
    if (!this.activeSession(sessionGeneration)) return;
    if (this.roundResolved || gen !== this.questionGeneration) return;
    if (COMMAND_LAB_MODE) {
      console.log('[game] LAB: Question timer reached; not auto-sending results.');
      return;
    }
    this.roundResolved = true;
    console.log('[game] STAT: No AQ received before the reveal deadline -- auto-advancing.');

    if (this.currentQuestion && this.currentQuestion.is_blowout) {
      this.resolveBlowoutAfterDelay(sessionGeneration).catch((e) => console.error('[game] blowout resolve error:', e));
    } else {
      await this.sendResultBurst(-1, -1, { includePrs: AUTO_INCLUDE_PRS, sessionGeneration });
      await this.advanceRound(sessionGeneration);
    }
  }

  async advanceRound(sessionGeneration = null) {
    if (sessionGeneration === null) sessionGeneration = this.sessionGeneration;
    if (!this.activeSession(sessionGeneration)) {
      console.log('[game] STAT: Client no longer connected -- not advancing round.');
      return;
    }
    this.roundInSegment += 1;
    if (this.pyramidSegmentFinished) {
      // Short delay, NOT RESULTS_TO_NEXT_DELAY_SECONDS: the RU+BS burst has to
      // land inside the client's sub-7 s result window or the pyramid never
      // plays its explosion. This used the full 10 s and missed it every time.
      await sleep(BLOWOUT_TRIGGER_DELAY_SECONDS * 1000);
      if (!this.activeSession(sessionGeneration)) {
        console.log('[game] STAT: Client no longer connected -- skipping Blowout/EGS.');
        return;
      }
      const preserveSteps = this.pyramidBonusUnlocked && Math.max(...this.playerSteps, 0) < PYRAMID_MAX_STEP;
      this.pyramidSegmentFinished = false;
      await this.endSegmentAndRestart(preserveSteps, sessionGeneration);
    } else {
      await sleep(RESULTS_TO_NEXT_DELAY_SECONDS * 1000);
      if (!this.activeSession(sessionGeneration)) {
        console.log('[game] STAT: Client no longer connected -- not sending next question.');
        return;
      }
      if (
        STORM_SYSTEM_ENABLED &&
        !this.stormFiredThisSegment &&
        this.roundInSegment >= STORM_ROUND_IN_SEGMENT
      ) {
        // Gated off by STORM_SYSTEM_ENABLED -- see the constant. This used to
        // set the flag and do nothing else, so even turning the constant on
        // produced no storm.
        this.stormFiredThisSegment = true;
        await this.runStormSequence(sessionGeneration);
        if (!this.activeSession(sessionGeneration)) {
          console.log('[game] STAT: Client no longer connected -- not sending next question.');
          return;
        }
      }
      this.questionIndex += 1;
      await this.sendQuestion(pickRandomQuestion(this.currentQuestion));
    }
  }

  /**
   * MAR -- "my answer result". Confirms to a client which answer it picked.
   *
   * Fields:
   *   [0] clientSessionId -- matches the session ID from the RS handshake, so
   *                          the client can verify the MAR is for its session
   *   [1] answerIdx       -- 0-based index of the answer chosen, echoed back so
   *                          the client can highlight that button
   *   [2] answerIdx       -- the same value repeated (duplicated in captures)
   *
   * Sent on EVERY AQ (first answer or a changed one) via sendMar() below, and
   * again here as the timeout / no-AQ auto-advance fallback -- but skipped if
   * this round already produced one, or the client would get a duplicate at
   * reveal that overwrites its highlight.
   *
   * The no-answer fallback is "0 0". cosmic_v64_web.py sends "1 1" here, taken
   * from a capture, but 1 1 names answer index 1 and highlights the B button
   * for a player who never picked anything.
   */
  async sendMyAnswerResult() {
    if (this.marQuestionGen === this.questionGeneration) return;
    this.marQuestionGen = this.questionGeneration;
    await this.botPriv(this.clientIrcName, `MAR ${this.clientSessionId} ${MAR_NO_ANSWER_FIELDS}`);
  }

  /**
   * Acknowledge a specific answer pick, direct to this client only.
   *
   * This is what highlights the chosen button in the client UI, and it was
   * missing entirely -- the only MAR ever sent was the hardcoded "1 1" at
   * reveal time, so the client was told "answer 1" no matter what was picked
   * and never lit up the real selection while the timer ran.
   *
   * sendRaw, not botPriv: a HOST would otherwise broadcast its own pick to
   * every player in the room and highlight the wrong button on their screens.
   */
  async sendMar(answerIdx) {
    if (answerIdx < 0) return;
    this.marQuestionGen = this.questionGeneration;
    await this.sendRaw(
      `:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG ${this.clientIrcName} ` +
      `:MAR ${this.clientSessionId} ${answerIdx} ${answerIdx}`
    );
  }

  async sendResultBurst(answerSlot, answerIdx, opts = {}) {
    const { includeQrs = true, includeQrr = true, includePrs = true, sessionGeneration = null } = opts;
    await this.sendLock.withLock(async () => {
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) {
        console.log('[game] STAT: Client no longer connected -- not sending result burst.');
        return;
      }
      await this.sendMyAnswerResult();
      await this.sendResults(answerSlot, answerIdx, { includeQrs, includeQrr, includePrs, sessionGeneration });
    });
  }

  async resolveAnswerAfterDelay(answerSlot, answerIdx, sessionGeneration) {
    if (this.questionRevealTime !== null) {
      const waitMs = this.questionRevealTime - Date.now();
      if (waitMs > 0) {
        console.log(`[game] STAT: Answer received early -- waiting ${(waitMs / 1000).toFixed(1)}s for the question timer before showing the tally.`);
        await sleep(waitMs);
      }
    }
    if (!this.activeSession(sessionGeneration)) {
      console.log('[game] STAT: Client left before answer reveal -- suppressing results.');
      return;
    }
    await this.sendResultBurst(answerSlot, answerIdx, { includePrs: AUTO_INCLUDE_PRS, sessionGeneration });
    await this.advanceRound(sessionGeneration);
  }

  async sendResults(answerSlot, answerIdx, opts = {}) {
    const { includeQrs = true, includeQrr = true, includePrs = true, sessionGeneration = null } = opts;
    if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) {
      console.log('[game] STAT: Client no longer connected -- not sending results.');
      return;
    }
    const q = this.currentQuestion;
    const names = this.currentPlayerNames();
    const numAnswers = q.answers.length;
    const weights = q.weights || q.answers.map(() => 1);
    let percents, safeWeights;
    if (q.prototype_raw_percents) {
      safeWeights = weights.map((w) => Math.max(0, Math.trunc(w)));
      percents = safeWeights.slice();
    } else {
      [percents, safeWeights] = normalizedPercents(weights);
    }
    // let, not const: a no-bots room recomputes both of these from live votes.
    let answerSteps = (q.answer_steps && q.answer_steps.length) ? q.answer_steps : answerMovementSteps(safeWeights);

    // Strict >: ties resolve to the earliest answer, matching Python's
    // (weight, -i) key. >= picked the last tied answer as the consensus
    // winner, so a tied question reported a different winner than the Python
    // server would for the same question bank entry.
    let topIdx = 0;
    for (let i = 1; i < numAnswers; i++) {
      if (safeWeights[i] > safeWeights[topIdx]) topIdx = i;
    }
    // QR1/QRR field 1 is the answer-slot BUTTON MODE (answerCount - 2, same as
    // QT field 2) -- the client reads it to know how many percentage bars to
    // render: 0 -> 2 bars, 1 -> 3 bars, 2 -> 4 bars.
    //
    // This defaulted to topIdx, the index of the winning answer, which only
    // happens to be right when the winner sits at the slot matching the bar
    // count. A 4-answer question whose top answer was index 0 sent "0", so the
    // client drew 2 bars and only A and B showed percentages at all.
    const consensusWireIdx = 'prototype_result_index' in q
      ? q.prototype_result_index
      : qtButtonField(numAnswers);
    const resultRosterCount = 'prototype_result_roster_count' in q ? q.prototype_result_roster_count : names.length;

    const rankedAnswers = q.answers.map((_, i) => i).sort((a, b) => {
      if (safeWeights[a] !== safeWeights[b]) return safeWeights[b] - safeWeights[a];
      return a - b;
    });
    const choices = names.map((_, slot) => rankedAnswers[slot % numAnswers]);
    if (answerIdx >= 0 && answerIdx < numAnswers) choices[0] = answerIdx;
    for (let i = 0; i < numAnswers; i++) {
      if (!choices.includes(i) && i + 1 < choices.length) choices[i + 1] = i;
    }

    // Overlay every human's real answer, then snapshot the map before it is
    // cleared -- the tallies below and the "did this player answer at all"
    // check both read from the snapshot.
    const actualHumanAnswers = new Map();
    if (this.room) {
      for (const [hSlot, hIdx] of this.room.humanAnswers) {
        actualHumanAnswers.set(hSlot, hIdx);
        if (hSlot >= 0 && hSlot < choices.length && hIdx >= 0 && hIdx < numAnswers) {
          choices[hSlot] = hIdx;
        }
      }
      this.room.resetRoundAnswers();
    }

    // A no-bots room scores itself: the percentages come from the live vote
    // tally rather than the question bank's static weights, and the movement
    // steps follow that same tally. With no bots the bank's weights describe a
    // crowd that isn't playing.
    const noBotsRoom = this.room !== null && this.room.minBots === 0;
    if (noBotsRoom && actualHumanAnswers.size) {
      const voteCounts = new Array(numAnswers).fill(0);
      for (const hIdx of actualHumanAnswers.values()) {
        if (hIdx >= 0 && hIdx < numAnswers) voteCounts[hIdx] += 1;
      }
      const totalVotes = voteCounts.reduce((a, b) => a + b, 0);
      if (totalVotes > 0) {
        percents = voteCounts.map((c) => Math.round((c / totalVotes) * 100));
        percents[percents.length - 1] += 100 - percents.reduce((a, b) => a + b, 0);
      } else {
        percents = new Array(numAnswers).fill(0);
      }
      answerSteps = answerMovementSteps(voteCounts);
      topIdx = 0;
      for (let i = 1; i < numAnswers; i++) if (voteCounts[i] > voteCounts[topIdx]) topIdx = i;
    }

    const topPickers = choices.map((pick, s) => (pick === topIdx ? names[s] : null)).filter(Boolean);
    console.log(`[game] STAT: Most popular answer: "${q.answers[topIdx]}" (${percents[topIdx]}%) -- picked by: ${topPickers.join(', ')}`);

    if (PROTOTYPE_MOVEMENT_EXPERIMENT) {
      choices.forEach((pick, slot) => {
        this.playerBipValues[slot] += prototypeBipDelta(answerSteps[pick]);
      });
    }

    // Snapshot the board BEFORE this round's movement. The reference's
    // post-MAR roster still shows the previous positions and IQ -- its round 2
    // has bot-Silva at "BIP 10 2 0" there and only drops to "BIP 20 0 1" in
    // the roster after the first PRS. Sending post-movement values in that
    // first roster means the client already shows the destination before the
    // climb starts, so a Black Hole fall has nothing left to animate.
    const preSteps = [...this.playerSteps];
    const preBips = [...this.playerBipValues];

    this.roundBlackholeSlots = [];
    this.roundMysteryEvents = [];
    this.roundStepsMoved = 0;
    choices.forEach((pick, slot) => {
      // `choices` is pre-filled with ranked defaults for every slot, which is
      // fine when bots occupy them. In a no-bots room those defaults would
      // auto-answer on behalf of a human who timed out and march them up the
      // pyramid; a player who does not answer simply stays put.
      if (noBotsRoom && !actualHumanAnswers.has(slot)) {
        console.log(`[game] STAT: ${names[slot]} did not answer -- no movement.`);
        return;
      }
      console.log(`[game] STAT: ${names[slot]} chose answer index ${pick} earning ${answerSteps[pick]} steps.`);
      this.applyMovement(slot, answerSteps[pick], 'game');
    });

    const leaderStep = this.playerSteps.length ? Math.max(...this.playerSteps) : 0;
    if (!this.pyramidBonusUnlocked && leaderStep >= PYRAMID_TOP_STEP) {
      this.pyramidBonusUnlocked = true;
      this.pyramidSegmentFinished = true;
      console.log('[game] STAT: Pyramid top reached -- blowout will unlock the 3 bonus steps.');
    } else if (this.pyramidBonusUnlocked && leaderStep >= PYRAMID_MAX_STEP) {
      this.pyramidSegmentFinished = true;
      console.log('[game] STAT: Bonus steps complete -- next segment will reset the pyramid.');
    }

    // The pre-movement roster. Flags are all clear here; the Black Hole flash
    // belongs to the frame after the first PRS, inside sendClimbSequence.
    const sent = await this.sendPlayerList(
      displayPlayerSteps(preSteps),
      displayPlayerBips(preBips, names.length),
      sessionGeneration
    );
    if (!sent) {
      console.log('[game] STAT: Client disconnected during player-list send -- suppressing result tail.');
      return;
    }

    let stopped = false;
    await this.sendLock.withLock(async () => {
      if (sessionGeneration !== null && !this.activeSession(sessionGeneration)) {
        console.log('[game] STAT: Client no longer connected -- suppressing result packet.');
        stopped = true;
        return;
      }
      await this.botPriv(this.clientIrcName, `QR1 ${numAnswers} ${consensusWireIdx} 0 ${resultRosterCount}`);
      await this.botPriv(this.clientIrcName, `ARB ${numAnswers}`);
      for (let i = 0; i < numAnswers; i++) {
        // On a single-word round slot 0 is the player's own typed word, so the
        // reveal shows what they actually entered next to the house answers,
        // the same way the Blowout substitutes its filled blanks.
        const answerText = (q.is_single_word && i === 0 && this.singleWordAnswer)
          ? this.singleWordAnswer
          : q.answers[i];
        await this.botPriv(this.clientIrcName, `ARI ${i} AR ${i} \x02${answerText}\x02 ${percents[i]} ${answerSteps[i]}`);
      }
      if (CLEAR_UNUSED_RESULT_SLOTS) {
        for (let i = numAnswers; i < MAX_ANSWER_SLOTS; i++) {
          await this.botPriv(this.clientIrcName, `ARI ${i} AR ${i} \x02 \x02 0 0`);
        }
      }
      await this.botPriv(this.clientIrcName, 'ARE');

      // Reference order is ARE -> QRR -> QRS -> PRS. QRS was being sent before
      // QRR here, which is backwards.
      const arBlob = q.answers.map((a, i) => `AR ${i} \x02${a}\x02 ${percents[i]} ${answerSteps[i]}`).join(' ');
      if (includeQrr) {
        await this.botPriv(this.clientIrcName, `QRR QR 0 ${consensusWireIdx} 0 ${numAnswers} ${numAnswers} ${arBlob}`);
      }

      if (includeQrs) await this.botPriv(this.clientIrcName, this.movementQrsPacket());
    });
    if (stopped) return;

    // The climb plays out as spaced PRS frames with a roster between each --
    // see sendClimbSequence. Outside the lock: it sleeps between frames.
    if (includePrs) {
      if (!(await this.sendClimbSequence(sessionGeneration))) {
        console.log('[game] STAT: Client disconnected during climb sequence -- suppressing result tail.');
      }
    }
  }

  // ── blowout bonus round (top of the pyramid) ─────────────────────────────

  async startBlowoutQuestion(sessionGeneration = null) {
    if (sessionGeneration === null) sessionGeneration = this.sessionGeneration;
    if (!this.activeSession(sessionGeneration)) return false;

    console.log('[game] STAT: Starting interactive Blowout Question.');
    this.humanBlowoutAnswers = [];

    const q = questionForWire(PROTOTYPE_BONUS_QUESTION);
    this.currentQuestion = q;
    this.roundResolved = false;
    this.questionGeneration += 1;
    const gen = this.questionGeneration;

    // capture: "QT 6 4 60 ..." and "QS ... 60000 0" -- the Blowout runs 60 s,
    // not the 40 s this used to give.
    const durationMs = 60000;
    const durationSeconds = 60;

    let elapsed;
    if (this.roomStartTime === null) {
      elapsed = this.lastReportedElapsed + 1;
    } else {
      elapsed = Date.now() - this.roomStartTime;
      if (elapsed <= this.lastReportedElapsed) elapsed = this.lastReportedElapsed + 1;
    }
    this.lastReportedElapsed = elapsed;
    const revealAt = elapsed + durationMs;

    // capture: "QT 6 4 60 The three worst things about the 90s were..." -- the
    // Blowout announces 6 steps (3+2+1 across its three blanks), not 3.
    const qtStep = 6;
    const qtButtonMode = 4;

    let ok = true;
    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) { ok = false; return; }
      await this.botPriv(this.clientIrcName, `QT ${qtStep} ${qtButtonMode} ${durationSeconds} \x02${q.text}\x02`);
      await this.botPriv(this.clientIrcName, `QATB ${q.answers.length}`);
      // Bare "-" placeholders, NOT the answer-bank text. The capture shows
      // "QATI 0 -", "QATI 1 -", "QATI 2 -": this is a free-text fill-in-the-
      // blank round, and the dashes are what make the client render three
      // TEXT-ENTRY BOXES. Sending the answer strings here made it draw
      // multiple-choice buttons instead, so there was nothing to type into and
      // the Blowout could never be completed -- it always timed out.
      for (let i = 0; i < q.answers.length; i++) {
        await this.botPriv(this.clientIrcName, `QATI ${i} \x02-\x02`);
      }
      await this.botPriv(this.clientIrcName, 'QATE');
      // reveal_at first, then qs_start -- the same field order fixed in
      // sendQuestion. These were swapped here too.
      await this.botPriv(this.clientIrcName, `QS 0 0 S 0 ${revealAt} ${elapsed} ${durationMs} 0`);
    });
    if (!ok) return false;

    this.questionRevealTime = this.roomStartTime + revealAt;
    this.questionWatchdog(gen, this.questionRevealTime, sessionGeneration).catch((e) =>
      console.error('[game] question watchdog error:', e)
    );
    return true;
  }

  async resolveBlowoutAfterDelay(sessionGeneration = null) {
    if (sessionGeneration === null) sessionGeneration = this.sessionGeneration;
    if (!this.activeSession(sessionGeneration)) return;

    const names = this.currentPlayerNames();

    while (this.humanBlowoutAnswers.length < 3) this.humanBlowoutAnswers.push('-');

    // Free-text round: any blank the player actually filled in earns its fixed
    // step value (the capture shows 100% credit on all three), rather than
    // being checked against a "correct" index. The old index comparisons
    // (=== 0 / === 1 / === 2) could never match a typed word, so a player who
    // answered every blank still scored 0.
    const filled = this.humanBlowoutAnswers
      .slice(0, 3)
      .map((a) => a !== null && a !== undefined && a !== '' && a !== '-');

    let humanSteps = 0;
    if (filled[0]) humanSteps += 3;
    if (filled[1]) humanSteps += 2;
    if (filled[2]) humanSteps += 1;

    console.log(`[game] STAT: Human answered blowout: ${JSON.stringify(this.humanBlowoutAnswers)} -> got ${humanSteps} steps.`);
    this.roundBlackholeSlots = [];
    this.roundMysteryEvents = [];
    this.roundStepsMoved = 0;
    this.applyMovement(0, humanSteps, 'game');

    for (let slot = 1; slot < names.length; slot++) {
      let botSteps = 0;
      if (Math.random() < 0.6) botSteps += 3;
      if (Math.random() < 0.6) botSteps += 2;
      if (Math.random() < 0.6) botSteps += 1;
      console.log(`[game] STAT: Bot ${names[slot]} got ${botSteps} steps in blowout.`);
      this.applyMovement(slot, botSteps, 'game');
    }

    // The blowout resolves in a single PRS frame, so there is no climb
    // sequence to hang reveals off -- anything applyMovement deferred has to
    // be settled here or the player would be left parked on the tile.
    {
      const stepLimit = this.pyramidBonusUnlocked ? PYRAMID_MAX_STEP : PYRAMID_TOP_STEP;
      for (const ev of [...this.roundMysteryEvents]) this.resolveHiddenTiles(ev[1], stepLimit);
    }

    // Reference shows every blank credited at 100% with its fixed step value,
    // displayed back using the player's own typed text where we have it.
    const percents = [100, 100, 100];
    const answerSteps = [3, 2, 1];
    const numAnswers = PROTOTYPE_BONUS_QUESTION.answers.length;
    // Derived from numAnswers, not a hardcoded [0,1,2], so this list can never
    // be a different length from the "ARB <numAnswers>" header that announces
    // it -- the same header/body mismatch that made the SA packet kill the
    // client.
    const displayAnswers = Array.from({ length: numAnswers }, (_, i) =>
      (filled[i] ? this.humanBlowoutAnswers[i] : PROTOTYPE_BONUS_QUESTION.answers[i])
    );

    // capture: MAR precedes the roster for this free-text round, with a fixed
    // 1004/0/0 shape distinct from a normal multiple-choice MAR. This was
    // missing -- the blowout sent no MAR at all.
    await this.botPriv(this.clientIrcName, 'MAR 1004 0 0');
    await this.sendPlayerList(
      displayPlayerSteps(this.playerSteps),
      displayPlayerBips(this.playerBipValues, names.length),
      sessionGeneration
    );

    // QR1 field 1 is the blowout's own consensus index (3), and field 3 is the
    // HUMAN count -- the reference sends "QR1 3 3 0 1" with one player and
    // "QR1 3 3 0 2" with two. This sent names.length, i.e. 10 with the bots
    // included.
    const blowoutRosterCount = this.room ? this.room.humanCount() : 1;
    const blowoutWireIdx = 'prototype_result_index' in PROTOTYPE_BONUS_QUESTION
      ? PROTOTYPE_BONUS_QUESTION.prototype_result_index
      : numAnswers;

    let stopped = false;
    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) { stopped = true; return; }
      await this.botPriv(this.clientIrcName, `QR1 ${numAnswers} ${blowoutWireIdx} 0 ${blowoutRosterCount}`);
      await this.botPriv(this.clientIrcName, `ARB ${numAnswers}`);
      for (let i = 0; i < displayAnswers.length; i++) {
        await this.botPriv(this.clientIrcName, `ARI ${i} AR ${i} \x02${displayAnswers[i]}\x02 ${percents[i]} ${answerSteps[i]}`);
      }
      await this.botPriv(this.clientIrcName, 'ARE');
      // QRR carried no answer payload and QRS no board; both were stubs. The
      // reference emits QRR twice, byte for byte identical, then the real QRS
      // with the board and climb trailer, then a single PRS.
      const arBlob = displayAnswers
        .map((a, i) => `AR ${i} \x02${a}\x02 ${percents[i]} ${answerSteps[i]}`)
        .join(' ');
      // QRR field 1 is the same consensus index as QR1 field 1.
      const qrr = `QRR QR 0 ${blowoutWireIdx} 0 ${numAnswers} ${numAnswers} ${arBlob}`;
      await this.botPriv(this.clientIrcName, qrr);
      await this.botPriv(this.clientIrcName, qrr);
      await this.botPriv(this.clientIrcName, this.movementQrsPacket());
      // Single PRS here, unlike a normal round: the reference's blowout
      // resolution is one climb frame only ("QRS@529047 | PRS 0@529047").
      await this.sendPrsPacket();
    });
    if (stopped) return;

    await sleep(3000);
    if (!this.activeSession(sessionGeneration)) return;
    await sleep(ENDGAME_PRE_EGS_SECONDS * 1000);
    if (!this.activeSession(sessionGeneration)) return;

    // First of the two heartbeats the reference puts between the blowout PRS
    // and EGS: "PRS@529047 | ST@538816 (+9769) | ST@546074 (+7258) | EGS".
    // This used to arrive incidentally from kaloop; with the periodic
    // heartbeat off it has to be explicit.
    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) return;
      await this.sendElapsedSt(sessionGeneration);
    });
    await sleep(ENDGAME_EGS_LEAD_SECONDS * 1000);
    if (!this.activeSession(sessionGeneration)) return;

    let winnerSlot = 0;
    for (let s = 1; s < names.length; s++) {
      if (this.playerBipValues[s] > this.playerBipValues[winnerSlot]) winnerSlot = s;
    }
    console.log(`[game] GAME OVER! Winner is ${names[winnerSlot]} with ${this.playerBipValues[winnerSlot]} IQ points!`);

    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) return;
      // EGS was hardcoded to a fixed 350000/35000. It carries the same
      // "S 0 <reveal_at> <elapsed> <visible> 0" trailer shape as QS, and the
      // reference's real values give reveal_at = elapsed + visible + dwell:
      //   "EGS S 0 582074 546074 30000 0" -> 582074 - 546074 - 30000 = 6000.
      const elapsed = await this.sendElapsedSt(sessionGeneration);
      const revealAt = elapsed + ENDGAME_EGS_VISIBLE_MS + ENDGAME_EGS_DWELL_MS;
      await this.botPriv(this.clientIrcName, `EGS S 0 ${revealAt} ${elapsed} ${ENDGAME_EGS_VISIBLE_MS} 0`);
      // SP + SAS follow, but NOT immediately -- see the hold below.
      // The end-game screen owns the clock from here until the next segment's
      // SP/SAS; the reference sends no ST at all in that stretch.
      this.suppressKaloop(ENDGAME_EGS_VISIBLE_MS + ENDGAME_EGS_DWELL_MS + 20000);
      // DO NOT rebase roomStartTime here. The reference's post-EGS NGS sits at
      // elapsed ~52000 rather than continuing the old clock, and rebasing does
      // reproduce that -- but it also makes every following ST smaller than
      // what the client was last told, and the client silently drops backward
      // STs. Tried in the Python: the new game's questions came out with
      // qs_start already in the client's past, no timer drew, and it could not
      // answer at all. See cosmic_v64_web.py for the full note.
    });

    if (!LOOP_NEW_SEGMENT_AFTER_EGS) {
      console.log('[game] STAT: Game over -- LOOP_NEW_SEGMENT_AFTER_EGS is off, leaving client idle post-game.');
      return;
    }

    // SP + SAS are what animate the pyramid unloading, and they have to reach
    // the client BEFORE the next NGS builds a new one -- but SP also tears the
    // end-game screen down to begin a segment, so sending it straight after
    // EGS cut the final stats off after a beat.
    //
    // EGS states its own lifetime in its trailer: "EGS S 0 781184 745184
    // 30000 0" is 30 s visible plus the 6 s dwell (reveal_at - elapsed -
    // duration). Hold for exactly that, then unload.
    //
    // The reference capture cannot settle this on its own: EGS/SP/SAS do sit
    // on adjacent LINES there, but that server sends almost no heartbeats
    // (15 ST in a whole game, all event-driven), so nothing marks how much
    // time passed between them. Adjacency in the log is not adjacency in
    // time, and the stats screen visibly getting cut short says it is not.
    const egsHoldMs = ENDGAME_EGS_VISIBLE_MS + ENDGAME_EGS_DWELL_MS;
    await sleep(egsHoldMs);
    if (!this.activeSession(sessionGeneration)) return;
    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) return;
      await this.botPriv(this.clientIrcName, 'SP S 0 0 0 0 0');
      await this.botPriv(this.clientIrcName, 'SAS S 0 0 0 0 0');
    });

    // Loop back into a brand new pyramid segment. The reference keeps going
    // (SP/SAS/NGS/RU/ADLB...) rather than stopping at the end-game screen --
    // this server used to just stop here, so the pyramid never came down and
    // no second game ever started. The remainder of the original wait, so the
    // total EGS -> NGS gap is unchanged.
    await sleep(Math.max(0, ENDGAME_EGS_WAIT_SECONDS * 1000 - egsHoldMs));
    if (!this.activeSession(sessionGeneration)) return;
    await sleep(2000); // flow-pre
    if (!this.activeSession(sessionGeneration)) return;
    await this.startSegment(true, true);
  }

  // ── segment start/end ──────────────────────────────────────────────────

  async startSegment(resetSteps = true, skipSpSas = false) {
    const sessionGeneration = this.sessionGeneration;
    if (this.roomStartTime === null) {
      this.roomStartTime = Date.now();
      this.lastReportedElapsed = 0;
    }
    this.pyramidSegmentFinished = false;
    this.stormFiredThisSegment = false;
    this.generateBoard();
    if (resetSteps) {
      const names = this.currentPlayerNames();
      this.playerSteps = new Array(names.length).fill(0);
      this.playerBipValues = new Array(names.length).fill(0);
      this.playerStuck = new Array(names.length).fill(false);
      this.playerStunned = new Array(names.length).fill(false);
      this.pyramidBonusUnlocked = false;
    }

    const names = this.currentPlayerNames();
    const firstEntry = !this.botsJoined;
    let stop = false;

    if (firstEntry) {
      // Reference opening: PLB <humans> -> [2s] -> SP/SAS -> one PJ per bot ->
      // NGS. The bots arrive one at a time as PJ packets rather than appearing
      // whole in the first roster, which this server never did.
      const humans = this.room ? this.room.humanCount() : 1;
      const humanNames = names.slice(0, humans);
      // Humans ONLY here -- the bots follow as individual PJ packets below.
      // This cannot go through sendPlayerList: that always emits the full
      // roster (PLB currentPlayerNames().length), so slicing the steps array
      // trimmed nothing on the wire. The opening list arrived holding all 11
      // slots and the 9 PJs then appended the bots a second time, which is
      // why a two-player game displayed 20 players.
      await this.sendLock.withLock(async () => {
        if (!this.activeSession(sessionGeneration)) {
          stop = true;
          return;
        }
        await this.botPriv(this.clientIrcName, `PLB ${humans}`);
        for (let i = 0; i < humanNames.length; i++) {
          await this.botPriv(this.clientIrcName, `PLI ${i} BIP 0 0 0 P ${humanNames[i]}`);
        }
        await this.botPriv(this.clientIrcName, 'PLE');
      });
      if (stop) return;
      await sleep(2000);
      if (!this.activeSession(sessionGeneration)) return;
      await this.sendLock.withLock(async () => {
        await this.botPriv(this.clientIrcName, 'SP S 0 0 0 0 0');
        await this.botPriv(this.clientIrcName, 'SAS S 0 0 0 0 0');
      });
      for (const botName of names.slice(humans)) {
        await sleep(500);
        if (!this.activeSession(sessionGeneration)) return;
        await this.sendLock.withLock(() => this.botPriv(this.clientIrcName, `PJ BIP 0 0 0 P ${botName}`));
      }
      this.botsJoined = true;
      broadcastRoomListUpdate();
      await this.sendLock.withLock(() => this.botPriv(this.clientIrcName, this.ngsPacket()));
    } else {
      // Restarting into a new segment does not resend the roster (it has not
      // changed) -- just flow-pre -> SP -> SAS -> ST -> NGS, 2s apart.
      await sleep(2000);
      if (!this.activeSession(sessionGeneration)) return;
      await sleep(2000);
      if (!this.activeSession(sessionGeneration)) return;
      // skipSpSas: the post-EGS caller already sent both, once the end-game
      // screen had had its full run. The sleeps stay either way so NGS still
      // lands at the same point on the clock.
      if (!skipSpSas) {
        await this.sendLock.withLock(() => this.botPriv(this.clientIrcName, 'SP S 0 0 0 0 0'));
      }
      await sleep(2000);
      if (!this.activeSession(sessionGeneration)) return;
      if (!skipSpSas) {
        await this.sendLock.withLock(() => this.botPriv(this.clientIrcName, 'SAS S 0 0 0 0 0'));
      }
      await sleep(2000);
      if (!this.activeSession(sessionGeneration)) return;
      await this.sendLock.withLock(async () => {
        await this.sendElapsedSt(sessionGeneration);
        await this.botPriv(this.clientIrcName, this.ngsPacket());
      });
    }
    if (!this.activeSession(sessionGeneration)) return;

    await this.sendLock.withLock(async () => {
      if (!this.activeSession(sessionGeneration)) { stop = true; return; }
      // RU-unlock plus a fresh ADLB/ADLI/ADLE right after every NGS, on every
      // segment -- not just the lobby handshake, which is all this server used
      // to send.
      await this.botPriv(this.clientIrcName, `RU ${this.roomUnlockLine(names.length)}`);
      await this.sendFreshAdList();
      if (JGS_ENABLED) await this.botPriv(this.clientIrcName, 'JGS S 0 0 0 0 0');
      this.adAckPending = true;
    });
    if (stop) return;

    // The client tears the connection down roughly 8-10s after ADLE if nothing
    // else arrives, so get QT out well inside that window with the heartbeat
    // gated off for the gap.
    await sleep(2000);
    this.adAckPending = false;
    if (!this.activeSession(sessionGeneration)) return;

    this.questionIndex = 0;
    this.roundInSegment = 0;
    const first = (FORCE_FIRST_QUESTION_SINGLE_WORD && SINGLE_WORD_QUESTIONS.length)
      ? SINGLE_WORD_QUESTIONS[Math.floor(Math.random() * SINGLE_WORD_QUESTIONS.length)]
      : pickRandomQuestion(this.currentQuestion);
    await this.sendQuestion(first);
  }

  async endSegmentAndRestart(preserveSteps = false, sessionGeneration = null) {
    if (sessionGeneration === null) sessionGeneration = this.sessionGeneration;
    if (!this.activeSession(sessionGeneration)) {
      console.log('[game] STAT: Client no longer connected -- not ending/restarting segment.');
      return;
    }
    console.log('[game] STAT: Segment complete -- explosion (BS), ad break (SA), then Blowout round.');

    const names = this.currentPlayerNames();
    await this.sendLock.withLock(async () => {
      // RU BIR 1 20 0 ... status=1 (field 1 = PYRAMID_TOP_STEP) immediately
      // precedes ST+BS and is what triggers the client's pyramid-top explosion
      // animation. Without it the bonus steps appear but the climb never plays
      // -- the players just stand at the top, which is exactly what this was
      // doing: it sent BS alone, with no RU and no ST.
      await this.botPriv(this.clientIrcName, `RU ${this.roomBlowoutLine(names.length)}`);
      // ST (real elapsed) immediately precedes BS, and BS reuses that same
      // elapsed rather than the hardcoded 350000/35000 this used to send. The
      // BS duration covers the ENTIRE blowout window -- ads, question, result
      // and EGS -- not just the pre-SA wait.
      const elapsed = await this.sendElapsedSt(sessionGeneration);
      const revealAt = elapsed + BLOWOUT_BS_WINDOW_MS;
      await this.botPriv(this.clientIrcName, `BS S 0 ${revealAt} ${elapsed} ${BLOWOUT_BS_WINDOW_MS} 0`);
    });

    // No EGS bumper here. The "BS -> EGS -> SA" ordering was never observed in
    // a real capture; EGS belongs only at the true end of the game, after the
    // Blowout round resolves.
    await sleep(BLOWOUT_POST_BS_ADBREAK_SECONDS * 1000);
    if (!this.activeSession(sessionGeneration)) {
      console.log('[game] STAT: Client disconnected during explosion -- suppressing ad/restart.');
      return;
    }

    await this.sendLock.withLock(() => this.sendElapsedSt(sessionGeneration));
    // Reuse this segment's own ad list -- the capture's SA replays exactly the
    // ADLI ads from this segment's NGS, not a fresh set.
    const primaryAd = (this.currentSegmentAds && this.currentSegmentAds.length)
      ? this.currentSegmentAds[0]
      : null;
    const ads = await this.sendBlowoutAds(primaryAd, sessionGeneration);
    // Set AFTER the SA broadcast, or botPriv's HOST loop filters the host out
    // of its own ad sequence.
    this.adAckPending = true;
    let waited = 0;
    while (this.adAckPending && waited < BLOWOUT_AD_ACK_TIMEOUT_SECONDS) {
      if (!this.activeSession(sessionGeneration)) {
        console.log('[game] STAT: Client disconnected while waiting on ad ack -- suppressing restart.');
        return;
      }
      await sleep(500);
      waited += 0.5;
    }
    if (this.adAckPending) {
      console.log(`[game] STAT: No AI ack for blowout ads ${JSON.stringify(ads)} after ${BLOWOUT_AD_ACK_TIMEOUT_SECONDS}s -- proceeding anyway.`);
      this.adAckPending = false;
    }

    if (!this.activeSession(sessionGeneration)) {
      console.log('[game] STAT: Client disconnected after ad -- suppressing Blowout round/restart.');
      return;
    }
    if (!(await this.startBlowoutQuestion(sessionGeneration))) return;
    console.log('[game] STAT: Blowout question active -- waiting for player answers or timeout.');
  }

  // ── lobby-level IRC commands ─────────────────────────────────────────

  async handleNick(args) {
    if (!args.length) return;
    this.nick = args[0];
    if (this.user && !this.registered) await this.completeRegistration();
  }

  async handleUser(args) {
    if (!args.length) return;
    this.user = args[0];
    if (this.nick && !this.registered) await this.completeRegistration();
  }

  async completeRegistration() {
    this.registered = true;
    const n = this.nick;
    const s = SERVER_NAME;
    await this.sendRaw(`:${s} 001 ${n} :Welcome to Cosmic Consensus, ${n}`);
    await this.sendRaw(`:${s} 002 ${n} :Your host is ${s}, running Cosmic`);
    await this.sendRaw(`:${s} 003 ${n} :This server was created today`);
    await this.sendRaw(`:${s} 004 ${n} ${s} Cosmic o o`);
    await this.sendRaw(`:${s} 005 ${n} CHANTYPES=# :are supported by this server`);
    await this.sendRaw(`:${s} 251 ${n} :There are 0 users`);
    await this.sendRaw(`:${s} 375 ${n} :- ${s} Message of the Day -`);
    await this.sendRaw(`:${s} 372 ${n} :- Welcome to Cosmic Consensus.`);
    await this.sendRaw(`:${s} 376 ${n} :End of /MOTD command.`);
    await this.sendRaw(`:${s} 255 ${n} :I have 1 clients and 0 servers`);
    console.log(`[game] STAT: ${n} registered.`);
    await this.sendRaw(`PING :${s}`);
  }

  async handlePing(args) {
    const token = args.length ? args[0] : SERVER_NAME;
    await this.sendRaw(`:${SERVER_NAME} PONG ${SERVER_NAME} :${token}`);
  }

  async handleMode(args) {
    if (!args.length) return;
    const target = args[0];
    if (target.startsWith('#')) {
      await this.sendRaw(`:${SERVER_NAME} 324 ${this.nick} ${target} +`);
      await this.sendRaw(`:${SERVER_NAME} 329 ${this.nick} ${target} 0`);
    }
  }

  async handleWho(args) {
    const target = args.length ? args[0] : `#${LIST_CHANNEL}`;
    await this.sendRaw(
      `:${SERVER_NAME} 352 ${this.nick} ${target} ${BOT_NICK} ${SERVER_NAME} ` +
        `${SERVER_NAME} ${BOT_NICK} H@ :0 ${BOT_NICK}`
    );
    await this.sendRaw(`:${SERVER_NAME} 315 ${this.nick} ${target} :End of /WHO list.`);
  }

  async handleNames(args) {
    const target = args.length ? args[0] : `#${LIST_CHANNEL}`;
    const chan = target.replace(/^#/, '');
    const parts = [`@${BOT_NICK}`];
    if (this.nick && this.joinedList) {
      // Everyone else in the lobby, then self -- a bare NAMES used to report
      // only this client, hiding anyone already waiting.
      for (const other of liveGameClients) {
        if (other !== this && other.connected && other.joinedList && other.nick) {
          parts.push(other.nick);
        }
      }
      parts.push(this.nick);
    }
    await this.sendRaw(`:${SERVER_NAME} 353 ${this.nick} = #${chan} :${parts.join(' ')}`);
    await this.sendRaw(`:${SERVER_NAME} 366 ${this.nick} #${chan} :End of /NAMES list.`);
  }

  async handleJoin(args) {
    if (!args.length || !this.nick) return;
    const chan = args[0].replace(/^#/, '');
    this.previousNick = this.clientIrcName;
    this.clientIrcName = this.nick;
    // The room the player picked in the selector. RS carries no room name, so
    // this JOIN is the only place it is stated; handleRS consumes it.
    if (/^Big_\d+$/i.test(chan)) this.pendingRoomName = chan;

    // Game-room channel: the member list is just the bot and this player --
    // the room's real roster arrives later as PLB/PLI/PLE, not as IRC NAMES.
    // Returning here also keeps the game connection out of the lobby
    // registry, which is what stops it appearing as a second waiting player.
    if (chan !== LIST_CHANNEL && /^Big_/i.test(chan)) {
      await this.sendRaw(`:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} JOIN #${chan}`);
      await this.sendRaw(`:${this.nick}!${this.nick}@${SERVER_NAME} JOIN #${chan}`);
      await this.sendRaw(`:${SERVER_NAME} 353 ${this.nick} = #${chan} :@${BOT_NICK} ${this.nick}`);
      await this.sendRaw(`:${SERVER_NAME} 366 ${this.nick} #${chan} :End of /NAMES list.`);
      console.log(`[game] STAT: "${this.nick}" selected game room #${chan}.`);
      await this.botPriv(this.nick, 'LN 0');
      return;
    }

    // Lobby channel. Snapshot who is already here BEFORE registering self, so
    // the NAMES reply lists them without listing this client twice.
    const existing = [...liveGameClients].filter(
      (c) => c !== this && c.connected && c.joinedList && c.nick
    );

    await this.sendRaw(`:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} JOIN #${chan}`);
    await this.sendRaw(`:${this.nick}!${this.nick}@${SERVER_NAME} JOIN #${chan}`);
    // Real usernames where known, hex nicks otherwise. Previously this was
    // hardcoded to "@CosmicBot <self>", so someone entering the lobby never
    // saw anyone already waiting in it.
    const parts = [`@${BOT_NICK}`, ...existing.map((c) => c.username || c.nick), this.nick];
    await this.sendRaw(`:${SERVER_NAME} 353 ${this.nick} = #${chan} :${parts.join(' ')}`);
    await this.sendRaw(`:${SERVER_NAME} 366 ${this.nick} #${chan} :End of /NAMES list.`);
    // Replay the NICK change for everyone already identified, so this client
    // renders real names rather than the hex nicks it just received.
    for (const other of existing) {
      if (other.username) {
        await this.sendRaw(`:${other.nick}!${other.nick}@${SERVER_NAME} NICK :${other.username}`);
      }
    }

    if (!this.joinedList) {
      this.joinedList = true;
      // Tell the clients already waiting that someone new arrived.
      const joinAnnounce = `:${this.nick}!${this.nick}@${SERVER_NAME} JOIN #${chan}`;
      for (const other of existing) {
        Promise.resolve(other.sendRaw(joinAnnounce)).catch(() => {});
      }
      console.log('[game] STAT: New client logging on.');
      setActiveClient(this);
      await this.botPriv(this.clientIrcName, 'LN 0');
    }
  }

  async handlePart(args) {
    if (!args.length || !this.nick) return;
    const chan = args[0].replace(/^#/, '');
    await this.sendRaw(`:${this.nick}!${this.nick}@${SERVER_NAME} PART #${chan}`);

    // Leaving the game channel means leaving the room, even if the socket
    // stays open. Switching halls sends PART with no QUIT, and because the
    // room was only released on disconnect the departing client kept holding
    // slot 0 forever -- so every later client joined as a guest, no one was
    // ever HOST, and the game never started. Observed as "the bots never
    // loaded" no matter how many times you switched halls.
    if (this.room && this.room.roomName === chan) {
      this.markClientInactive(`"${this.clientIrcName}" left the game (PART #${chan}).`);
    }
  }

  async handleQuit(args) {
    if (this.ingame === 1) {
      console.log(`[game] STAT: "${this.clientIrcName}" disconnected, stopping commands to it.`);
    }
    this.markClientInactive(`"${this.clientIrcName}" is no longer reachable.`);
    if (!this.connected) return;
    this.connected = false;
    const reason = args.length ? args[0] : 'Client Quit';
    await this.sendRaw(`ERROR :Closing Link: ${this.nick} (${reason})`);
    this.stopKeepalive();
    this.stopKaloop();
    try {
      await this.conn.close();
    } catch (e) {
      /* already closed */
    }
  }

  // ── game-token dispatch (was raw msg parsing in the original bot) ───────

  async handleL(body) {
    const fields = body.split('L ').slice(1).join('L ').split(' ');
    const wireUsername = fields.length ? fields[0] : this.nick || '';
    const now = Date.now();
    while (pendingHttpLogins.length && now - pendingHttpLogins[0].at > 60000)
      pendingHttpLogins.shift();
    const webLogin = pendingHttpLogins.shift();
    const requestedUsername = webLogin ? webLogin.name : wireUsername;
    this.wireUsername = wireUsername;
    if (webLogin && webLogin.name !== wireUsername) {
      console.log(`[game] HTTP profile "${webLogin.name}" overrides stale registry L name "${wireUsername}".`);
    }
    let username = requestedUsername;
    let versionStr;
    if (fields.length >= 7) {
      versionStr = 'Version ' + fields.slice(3, 7).join(' ');
    } else {
      versionStr = 'Version 1 1 0 65';
    }
    const sessionId = fields.length > 7 ? fields[7] : '0';
    this.username = username;
    this.versionStr = versionStr;
    this.clientSessionId = sessionId;
    console.log(`[game] STAT: Client identity resolved as "${username}"; roster slot 0 will be "${this.currentPlayerNames()[0]}".`);
    // A client only becomes visible to the lobby once it identifies -- until
    // now it has no username, so broadcastLobbyPlayerList() filters it out.
    // Announce the hex-nick -> real-name change to everyone (including self,
    // so the member list stops showing the hex nick), then push a fresh
    // roster. Without this the people already waiting never learned that
    // anyone arrived: their player count sat at whatever it was when they
    // themselves sent RR.
    if (this.joinedList && this.nick) {
      const nickChange = `:${this.nick}!${this.nick}@${SERVER_NAME} NICK :${username}`;
      await this.sendRaw(nickChange);
      for (const other of liveGameClients) {
        if (other !== this && other.connected) {
          Promise.resolve(other.sendRaw(nickChange)).catch(() => {});
        }
      }
      broadcastLobbyPlayerList();
    }
    await this.botPriv(this.clientIrcName, `LA ${username} ${versionStr} ${sessionId}`);
    await this.botPriv(this.clientIrcName, 'SC S 0 0 0 0 0');
  }

  async handleRR() {
    if (this.ingame === 0) {
      console.log(`[game] STAT: "${this.username}" (${this.clientIrcName}) wants the room list`);
      // Every configured room, plus any ad-hoc room that is live but not in
      // ROOM_CONFIGS. A configured room with nobody in it has no GameRoom yet,
      // so its line comes from the config defaults.
      const shown = new Map();
      for (const name of Object.keys(ROOM_CONFIGS)) shown.set(name, null);
      for (const room of activeRoomsSnapshot()) if (!shown.get(room.roomName)) shown.set(room.roomName, room);
      await this.botPriv(this.clientIrcName, `RB ${shown.size}`);
      let idx = 0;
      for (const [rname, room] of shown) {
        const cfg = ROOM_CONFIGS[rname] || ROOM_DEFAULT_CONFIG;
        const info = room
          ? room.roomInfoLine
          : makeBirLine(rname, cfg.display, { b: cfg.minPlayersToStart });
        await this.botPriv(this.clientIrcName, `RI ${idx} ${info}`);
        idx += 1;
      }
      await this.botPriv(this.clientIrcName, 'RE');
      // Lobby roster, so the client's waiting-room panel shows who else is
      // sitting in the selector rather than an empty list.
      const lobby = [...liveGameClients].filter((c) => c.connected && c.username && c.ingame === 0);
      await this.botPriv(this.clientIrcName, `PLB ${lobby.length}`);
      for (let i = 0; i < lobby.length; i++) {
        await this.botPriv(this.clientIrcName, `PLI ${i} BIP 0 0 0 P ${lobby[i].username}`);
      }
      await this.botPriv(this.clientIrcName, 'PLE');
    } else if (this.ingame === 1) {
      if (this.gameSlot === 0) {
        console.log(`[game] STAT: "${this.username}" (host) wants to start the game`);
        const need = this.room ? this.room.minPlayersToStart : 1;
        if (need > 1 && this.room && !this.room.playersReady()) {
          // Park the room at the pyramid base until enough humans arrive. The
          // PLB/SP/SAS below ends the travelling-to-hall animation so the
          // waiting players see the base rather than an endless starfield.
          await this.sendWaitingForPlayers();
          while (this.room && !this.room.playersReady()) {
            if (!this.activeSession(this.sessionGeneration)) return;
            await sleep(1000);
          }
          if (!this.activeSession(this.sessionGeneration)) return;
        }
        await this.startSegment();
      } else {
        // Guest: the HOST drives the loop. Either catch this client up to the
        // round already in progress, or -- if the game has not started yet --
        // show it the waiting-room state so it isn't left in the starfield.
        console.log(`[game] STAT: "${this.username}" (guest slot ${this.gameSlot}) is ready.`);
        if (this.room && this.room.botsJoined) {
          await this.sendGuestCatchUp();
        } else {
          await this.sendWaitingForPlayers();
        }
      }
    }
  }

  /**
   * PLB/PLI/PLE + SP/SAS for a client parked before the game starts.
   *
   * Without this the client sits on the travelling-to-hall starfield forever:
   * SP/SAS are what end that animation and drop it at the pyramid base.
   */
  async sendWaitingForPlayers() {
    const names = this.currentPlayerNames();
    const humans = this.room ? this.room.humanCount() : 1;
    const waiting = names.slice(0, humans);
    await this.sendLock.withLock(async () => {
      await this.botPriv(this.clientIrcName, `PLB ${waiting.length}`);
      for (let i = 0; i < waiting.length; i++) {
        await this.botPriv(this.clientIrcName, `PLI ${i} BIP 0 0 0 P ${waiting[i]}`);
      }
      await this.botPriv(this.clientIrcName, 'PLE');
    });
    await sleep(2000);
    if (!this.activeSession(this.sessionGeneration)) return;
    await this.sendLock.withLock(async () => {
      await this.botPriv(this.clientIrcName, 'SP S 0 0 0 0 0');
      await this.botPriv(this.clientIrcName, 'SAS S 0 0 0 0 0');
    });
  }

  /**
   * Rebuild a late-joining guest's screen from the room's live state.
   *
   * JGS is the mid-game variant of NGS: same board, static trailer, no build
   * animation -- the pyramid is already standing for everyone else. The roster
   * goes out with noDelay so this does not eat the remaining question window,
   * and if a question is currently open the guest gets a QS scoped to whatever
   * time is actually left on it.
   */
  async sendGuestCatchUp() {
    const names = this.currentPlayerNames();
    await this.sendLock.withLock(async () => {
      await this.botPriv(this.clientIrcName, 'SP S 0 0 0 0 0');
      await this.botPriv(this.clientIrcName, 'SAS S 0 0 0 0 0');
      await this.botPriv(this.clientIrcName, `JGS ${this.getPrmdBody()} S 0 0 0 0 0`);
    });
    // Raw values -- sendPlayerList clamps them itself, and it is the only
    // caller that knows whether the bonus steps are unlocked. Pre-clamping
    // here with the default wire max pinned a guest who joined after a
    // blowout to step 20.
    await this.sendPlayerList(this.playerSteps, null, this.sessionGeneration, null, true);
    // Catching up is done; from here the HOST's broadcasts reach this client.
    this.guestCatchUpPending = false;

    const q = this.currentQuestion;
    const revealAt = this.questionRevealTime;
    if (q && revealAt && Date.now() < revealAt && this.roomStartTime !== null) {
      const elapsed = this.currentElapsedMs();
      const remaining = Math.max(1000, revealAt - Date.now());
      await this.sendLock.withLock(async () => {
        await this.sendQtCluster(q, Math.round(remaining / 1000));
        await this.botPriv(this.clientIrcName, `ST S 0 ${elapsed} 0 0 0`);
        // qs_start slightly ahead of the ST we just sent so the client's timer
        // starts cleanly instead of resolving as already-expired.
        const qsStart = elapsed + 200;
        await this.botPriv(this.clientIrcName, `QS 0 0 S 0 ${qsStart + remaining} ${qsStart} ${remaining} 0`);
      });
      // The client re-derives qs_start from every ST it receives; if elapsed
      // advances past it the timer resets to 99 s. Keep heartbeats off this
      // client until the question expires.
      this.suppressKaloop(remaining + 2000);
    }
  }

  async handleRS() {
    if (this.room === null) {
      console.log(`[game] STAT: "${this.username}" (${this.previousNick}) is leaving the room list`);
      this.ingame = 1;
      this.sessionGeneration += 1;
      this.adAckPending = true;

      // Join (or create) the shared room named by the JOIN that preceded this
      // RS. RS itself carries only two integers, no room name.
      const room = getOrCreateGameRoom(this.pendingRoomName || 'Big_000');
      this.room = room;
      this.gameSlot = room.addClient(this);

      if (this.gameSlot === 0) {
        // HOST: owns the shared clock, board and roster arrays.
        const names = this.currentPlayerNames();
        room.roomStartTime = Date.now();
        room.lastReportedElapsed = 0;
        room.playerSteps = new Array(names.length).fill(0);
        room.playerBipValues = new Array(names.length).fill(0);
        room.playerStuck = new Array(names.length).fill(false);
        room.playerStunned = new Array(names.length).fill(false);
        this.generateBoard();
        console.log(
          `[game] STAT: "${this.username}" is HOST (slot 0) of room '${room.roomName}' ` +
          `with ${names.length} slots (${room.humanCount()} human).`
        );
      } else if (room.botsJoined) {
        // A guest arriving after the HOST has already started needs its screen
        // rebuilt from the room's live state; hold its broadcasts until then.
        this.guestCatchUpPending = true;
        console.log(
          `[game] STAT: "${this.username}" joined room '${room.roomName}' as guest ` +
          `(slot ${this.gameSlot}); host already running -- catch-up pending.`
        );
      } else {
        console.log(`[game] STAT: "${this.username}" joined room '${room.roomName}' as guest (slot ${this.gameSlot}).`);
      }
      // This client just left the lobby for a room, so the watchers still in
      // the selector need both lists refreshed.
      broadcastRoomListUpdate();
      broadcastLobbyPlayerList();

      const ad = normalizeAdFilename(pickRandomAd(), 'sponsor.srf');
      const secondaryAd = secondaryAdFilename(ad);

      // EVERY packet in this lobby-entry burst must go out with sendRaw, not
      // botPriv. adAckPending was just set true above, and botPriv's HOST
      // broadcast loop skips any client with adAckPending set -- including the
      // host itself. Routing these through botPriv meant the HOST silently
      // received no sponsor ad and no ad list at all, so it never sent AI,
      // adAckPending never cleared, and from then on EVERY broadcast to that
      // client was suppressed: no bots, no SP/SAS, nothing. A guest hit the
      // direct path and worked fine, which is why only the host was broken.
      const raw = `:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG ${this.clientIrcName} :`;
      await this.sendRaw(`${raw}ST S 0 0 0 0 0`);
      await this.sendRaw(`${raw}RU ${this.room.roomInfoLine}`);
      await this.sendRaw(`${raw}SPA Ad ${ad} ${ad} 0`);

      const blowoutAds = ['air212.srf', 'usr135.srf', 'hug173.srf', 'voc213.srf'];
      const uniqueAds = [];
      for (const a of [ad, secondaryAd, ...blowoutAds]) {
        const aNorm = normalizeAdFilename(a);
        if (!uniqueAds.includes(aNorm)) uniqueAds.push(aNorm);
      }
      await this.sendRaw(`${raw}ADLB ${uniqueAds.length}`);
      for (let idx = 0; idx < uniqueAds.length; idx++) {
        await this.sendRaw(`${raw}ADLI ${idx} Ad ${uniqueAds[idx]} ${uniqueAds[idx]} 0`);
      }
      await this.sendRaw(`${raw}ADLE`);

      this.startKaloop(this.sessionGeneration);
    } else {
      await this.sendElapsedSt();
    }
  }

  async handleAnswer(body) {
    const isBlowout = this.currentQuestion && this.currentQuestion.is_blowout;
    const isSingleWord = this.currentQuestion && this.currentQuestion.is_single_word;

    if (isSingleWord) {
      // Free text, same shape as the Blowout's AQ but with one blank:
      //   "AQ A 0 0 button 25"
      // Strip the AQ/A markers and the numeric fields (slot, index and the
      // echoed duration); whatever is left is what the player typed.
      let parts = body.split(/\s+/).filter(Boolean);
      if (parts.length && ['AQ', 'A'].includes(parts[0].toUpperCase())) parts = parts.slice(1);
      if (parts.length && parts[0].toUpperCase() === 'A') parts = parts.slice(1);
      const words = [];
      for (const part of parts) {
        const cleaned = part.replace(/^[\x02,;:]+|[\x02,;:]+$/g, '');
        if (cleaned && !/^-?\d+$/.test(cleaned)) words.push(cleaned);
      }
      const typed = cleanGameText(words.join(' '), 120);
      if (typed) {
        this.singleWordAnswer = typed;
        console.log(`[game] STAT: "${this.username}" typed ${JSON.stringify(typed)}.`);
      }
      // Fall through: the round is then scored as a normal answer to slot 0,
      // so MAR, the room's vote bookkeeping, the host handoff, movement and
      // the QR1/ARB/ARI reveal all run unchanged. Only the ASKING side is
      // different -- a text box instead of buttons.
    }

    if (isBlowout) {
      // The Blowout is a free-text fill-in-the-blank round, not a
      // multiple-choice one. Reference capture:
      //   "AQ A 2 0 Test test test 60"
      // -- two leading numeric fields, the three typed blanks, then a trailing
      // numeric (echoed duration). This used to scan for NUMBERS and treat
      // them as answer indices, which on that line yielded [2, 0], pushed a
      // single 0, and then waited forever for a third answer that could never
      // arrive: the blowout hung and the game never reached EGS.
      let parts = body.split(/\s+/).filter(Boolean);
      if (parts.length && ['AQ', 'A'].includes(parts[0].toUpperCase())) parts = parts.slice(1);
      if (parts.length && parts[0].toUpperCase() === 'A') parts = parts.slice(1);
      const texts = [];
      for (const part of parts) {
        const cleaned = part.replace(/^[\x02,;:]+|[\x02,;:]+$/g, '');
        if (cleaned && !/^-?\d+$/.test(cleaned)) texts.push(cleaned);
      }

      if (this.roundResolved) return;
      if (texts.length) this.humanBlowoutAnswers = texts.slice(0, 3);
      this.roundResolved = true;

      console.log(`[game] STAT: Human completed blowout question with answers: ${JSON.stringify(this.humanBlowoutAnswers)}`);
      this.resolveBlowoutAfterDelay(this.sessionGeneration).catch((e) =>
        console.error('[game] blowout resolve error:', e)
      );
      return;
    }

    // A single-word question has exactly one slot, so the typed text is always
    // "answer 0"; there is no index to parse off the wire.
    const answerIdx = isSingleWord
      ? 0
      : parseAnswerLine(body, this.currentQuestion, this.currentPlayerNames().length)[1];
    // A player always answers for their OWN slot. The slot parsed off the wire
    // is the client's local view and is always 0, so in a shared room every
    // guest's answer would otherwise be recorded against the host.
    const mySlot = this.room ? this.gameSlot : 0;

    // Acknowledge the pick immediately, on every AQ including a changed one,
    // so the client can highlight the button it selected. This also marks the
    // round as MAR'd, suppressing the 1 1 fallback at reveal.
    await this.sendMar(answerIdx);

    if (this.room && answerIdx >= 0) {
      this.room.humanAnswers.set(mySlot, answerIdx);
      console.log(`[game] STAT: "${this.username}" (slot ${mySlot}) answered ${answerIdx} -- ${this.room.humanAnswers.size}/${this.room.humanCount()} humans in.`);
      // Only the HOST resolves the round, and only once everybody has voted or
      // the watchdog fires. A guest answering must never drive the reveal.
      if (this.room.humanAnswers.size < this.room.humanCount()) return;
      const host = this.room.clients[0];
      if (host && host !== this) {
        // Everyone is in but this client is not the host -- hand off.
        if (this.roundResolved) return;
        this.roundResolved = true;
        host.resolveAnswerAfterDelay(0, this.room.humanAnswers.get(0) ?? answerIdx, host.sessionGeneration)
          .catch((e) => console.error('[game] answer resolve error:', e));
        return;
      }
    }

    if (this.roundResolved) return;
    this.roundResolved = true;
    if (answerIdx < 0) {
      console.log(`[game] STAT: Couldn't trust answer tuple: ${JSON.stringify(body)}; revealing anyway.`);
    } else {
      console.log(`[game] STAT: "${this.username}" (${this.clientIrcName}) answered ${answerIdx} (slot ${mySlot})`);
    }
    const sessionGeneration = this.sessionGeneration;
    this.resolveAnswerAfterDelay(mySlot, answerIdx, sessionGeneration).catch((e) =>
      console.error('[game] answer resolve error:', e)
    );
  }

  async handleBI(body) {
    // Storm system is disabled (see module header) so storm_window_open
    // never opens -- this stays a safe no-op, kept for parity.
    if (!this.stormWindowOpen) {
      console.log(`[game] STAT: BI from ${JSON.stringify(body)} arrived outside the insurance window -- ignoring.`);
      return;
    }
    if (this.stormInsured.has(0)) return;
    if (this.playerBipValues[0] < STORM_INSURANCE_COST) return;
    this.playerBipValues[0] -= STORM_INSURANCE_COST;
    this.stormInsured.add(0);
    await this.sendLock.withLock(() => this.botPriv(this.clientIrcName, 'BI 1'));
  }

  /**
   * Relay the chat packets emitted by the game client.  The client sends the
   * visible sender name as part of the packet, but that name can be stale when
   * two browser clients started with the same saved profile.  Always use the
   * identity assigned to this connection so the recipient can address the
   * correct player.
   */
  async handleChat(body) {
    // The Windows client commonly terminates these packets with a space.
    // Trim it first so it cannot be mistaken for an extra sender field.
    const parts = body.trim().split(/\s+/);
    const tag = parts.shift();
    if (!this.username) return;

    if (tag === 'PRC') {
      // PRC <text> <FROM> <TO>; text may contain spaces.
      const to = parts.pop() || '';
      if (parts.length) parts.pop(); // discard the client's stale FROM
      const text = parts.join(' ');
      const target = [...liveGameClients].find((client) =>
        client.connected && client.username &&
        client.username.toLowerCase() === to.toLowerCase()
      );
      if (!target) {
        await this.botPriv(this.clientIrcName, `PUC ${to} is not here. ${BOT_NICK}`);
        return;
      }
      await target.sendRaw(
        `:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG ${target.clientIrcName} :PRC ${text} ${target.username} ${this.username}`
      );
      if (target !== this) {
        await this.sendRaw(
          `:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG ${this.clientIrcName} :PRC ${text} ${this.username} ${target.username}`
        );
      }
      console.log(`[game] STAT: private chat "${this.username}" -> "${target.username}".`);
      return;
    }

    // PUC/MC/HC <text> [FROM]. Drop the stale optional sender and append the
    // canonical one.  This works for both lobby and in-room chat.
    // The final field is the client's sender field even when it is stale.
    // Remove it unconditionally and replace it with the canonical identity.
    if (parts.length) parts.pop();
    const recipients = this.room
      ? this.room.clients
      : [...liveGameClients].filter((client) => client.ingame === 0);
    for (const client of recipients) {
      if (client.connected && client.username) {
        const outgoing = `${tag} ${parts.join(' ')} ${this.username}`;
        Promise.resolve(client.sendRaw(
          `:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG ${client.clientIrcName} :${outgoing}`
        )).catch(() => {});
      }
    }
    console.log(`[game] STAT: ${tag} chat from "${this.username}".`);
  }

  async handlePrivmsg(args) {
    if (args.length < 2) return;
    const body = args[1];

    if (body.startsWith('L ')) {
      await this.handleL(body);
    } else if (body === 'RR' || body.startsWith('RR ')) {
      await this.handleRR();
    } else if (body.startsWith('RS ')) {
      await this.handleRS();
    } else if (body.startsWith('AQ ') || body.startsWith('A ')) {
      await this.handleAnswer(body);
    } else if (body.startsWith('LO -1')) {
      // LOA acknowledges THIS client's own LO, so it must go direct. Through
      // botPriv a departing HOST would broadcast "you left" to everyone else
      // still in the room.
      await this.sendRaw(`:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG ${this.clientIrcName} :LOA -1`);
      if (body.includes(':bC') || body.includes('bC')) {
        this.markClientInactive(`"${this.clientIrcName}" left the lobby/game.`);
      }
    } else if (body.startsWith('LO 1')) {
      await this.sendRaw(`:${BOT_NICK}!${BOT_NICK}@${SERVER_NAME} PRIVMSG ${this.clientIrcName} :LOA 1`);
      console.log(`[game] STAT: "${this.clientIrcName}" left the game (LO 1).`);
      this.markClientInactive(`"${this.clientIrcName}" left the game (LO 1).`);
    } else if (body.startsWith('AI ')) {
      console.log('[game] STAT: Client acknowledged ad; waiting for RR before starting segment.');
      this.adAckPending = false;
    } else if (body === 'BI' || body.startsWith('BI ')) {
      await this.handleBI(body);
    } else if (body.startsWith('PUC ') || body.startsWith('PRC ')
               || body.startsWith('MC ') || body.startsWith('HC ')) {
      await this.handleChat(body);
    } else if (this.ingame === 1) {
      await this.sendElapsedSt();
    } else {
      console.debug(`[game] Unhandled token from ${this.nick}: ${JSON.stringify(body)}`);
    }
  }

  // ── dispatch ──────────────────────────────────────────────────────────

  async dispatch(rawLine) {
    let line = rawLine;
    if (!line.trim()) return;
    console.log(`RECV [${this.label()}]: ${line}`);

    if (line.startsWith(':')) {
      const sp = line.indexOf(' ');
      line = sp === -1 ? '' : line.slice(sp + 1);
    }

    const sp0 = line.indexOf(' ');
    const command = (sp0 === -1 ? line : line.slice(0, sp0)).toUpperCase();
    let rest = sp0 === -1 ? '' : line.slice(sp0 + 1);

    const args = [];
    while (rest) {
      if (rest.startsWith(':')) {
        args.push(rest.slice(1));
        break;
      }
      const p = rest.indexOf(' ');
      if (p === -1) {
        args.push(rest);
        rest = '';
      } else {
        args.push(rest.slice(0, p));
        rest = rest.slice(p + 1);
      }
    }

    switch (command) {
      case 'NICK': return this.handleNick(args);
      case 'USER': return this.handleUser(args);
      case 'PING': return this.handlePing(args);
      case 'MODE': return this.handleMode(args);
      case 'CAP': return this.sendRaw('CAP * LS :');
      case 'JOIN': return this.handleJoin(args);
      case 'PART': return this.handlePart(args);
      case 'PRIVMSG': return this.handlePrivmsg(args);
      case 'QUIT': return this.handleQuit(args);
      case 'WHO': return this.handleWho(args);
      case 'NAMES': return this.handleNames(args);
      case 'PONG':
        // Proof of life: the socket is up and the client is still processing.
        this.pingsAwaitingPong = 0;
        // Separate counter for waitForClientResponsive, which needs to see one
        // specific round trip rather than "no misses outstanding".
        this.pongSeq = (this.pongSeq || 0) + 1;
        return;
      default: console.debug(`[game] Unhandled: ${command}`);
    }
  }

  appendChunk(chunk) {
    const combined = new Uint8Array(this.buf.length + chunk.length);
    combined.set(this.buf, 0);
    combined.set(chunk, this.buf.length);
    this.buf = combined;
  }

  async drainLines() {
    while (true) {
      const idx = this.buf.indexOf(10); // '\n'
      if (idx === -1) break;
      let lineBytes = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (lineBytes.length && lineBytes[lineBytes.length - 1] === 13) {
        lineBytes = lineBytes.slice(0, -1); // strip trailing '\r'
      }
      const line = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes);
      await this.dispatch(line);
      if (!this.connected) break;
    }
  }
}

// Which server new connections are routed to. Switched from the console with
// "GAME GTP" / "GAME COSMIC". Only new connections move: the accept loop
// resolves window.handleGameConnection per connection, so a game already
// running stays on the server it began with.
let activeGameProfile = 'cosmic';

// Single place the profile changes, so the console command and the page's
// dropdown can never disagree about which server is selected. The UI
// registers window.onActiveGameProfileChange to follow along.
function setGameProfile(profile) {
  activeGameProfile = profile;
  if (typeof window.onActiveGameProfileChange === 'function') {
    try { window.onActiveGameProfileChange(profile); }
    catch (e) { console.error('[game] profile change listener failed:', e); }
  }
  return profile;
}

// profile -> the window global its server publishes. Cosmic is absent because
// it is this file, and is the fallback when a chosen server has not loaded.
const GAME_PROFILE_HANDLERS = {
  gtp:  'gtpHandleGameConnection',
  acro: 'acroHandleGameConnection',
  ydkj: 'ydkjHandleGameConnection',
};

async function handleGameConnection(conn) {
  const hook = GAME_PROFILE_HANDLERS[activeGameProfile];
  if (hook) {
    if (window[hook]) return window[hook](conn);
    console.warn(`[game] ${activeGameProfile.toUpperCase()} is selected but its server is not loaded -- serving Cosmic.`);
  }
  // Remote mode: hand the socket straight to the real server and run none of
  // the game logic below.
  if (REMOTE_GAME_SERVER) return relayGameConnection(conn);

  const client = new GameClient(conn);
  console.log('Connected: game client');
  liveGameClients.add(client);
  client.startKeepalive();
  try {
    for await (const chunk of conn) {
      client.appendChunk(chunk);
      await client.drainLines();
      if (!client.connected) break;
    }
  } catch (e) {
    // handleQuit() proactively calls this.conn.close() as soon as the client
    // sends QUIT (e.g. during a lobby -> room switch: PART, then QUIT). If
    // this for-await loop still has a read pending on the same socket at
    // that moment, closing it out from under that read makes the transport
    // reject with "tcp connection closed" here -- that's an expected race
    // for a client-initiated disconnect, not a real failure, so log it
    // quietly instead of as a top-level error. Anything else (a transport
    // error while we were NOT already tearing the client down) is still a
    // genuine problem and stays logged as an error.
    const expectedAfterQuit = !client.connected && /connection closed/i.test(String((e && e.message) || e));
    if (expectedAfterQuit) {
      console.log(`[game] Connection closed after QUIT (expected): ${client.label()}`);
    } else {
      console.error(`Client error (${client.label()}):`, e);
    }
  } finally {
    client.stopKeepalive();
    client.stopKaloop();
    if (client.connected) await client.handleQuit([]);
    try {
      await conn.close();
    } catch (e) {
      /* already closed */
    }
    // Drop out of the occupancy set BEFORE the update so a leaver is not
    // counted in the number the lobby is told.
    liveGameClients.delete(client);
    broadcastRoomListUpdate();
    broadcastLobbyPlayerList();
    console.log(`Disconnected: ${client.label()}`);
  }
}

async function startCosmicGameServer(stack, port = GAME_PORT) {
  await ensureQuestionBankLoaded();
  await ensureAdManifestLoaded();
  const listener = await stack.tcp.listen({ port });
  console.log(`Cosmic game server listening on port ${port}`);
  for await (const conn of listener) {
    // Look up window.handleGameConnection fresh on every connection (rather
    // than closing over the local handleGameConnection) so that if
    // cosmic-server.js gets hot-reloaded later, this same long-running
    // accept loop -- which we do NOT want to restart, since that would mean
    // re-calling stack.tcp.listen() on a port that's already bound -- picks
    // up the newest per-connection game logic for any new connection that
    // comes in after the reload.
    window.handleGameConnection(conn).catch((e) => console.error('Unhandled client error:', e));
  }
}

// Exposed globally so main.js (a plain, non-module script) can call these
// after it sets up the tap interface / DHCP / stack, and so a reload of
// this file (see window.reloadCosmicServer() in main.js) updates what
// these names point to without needing to restart the VM, the network
// stack, or the already-running TCP listener.
// ── console ────────────────────────────────────────────────────────────────
//
// Port of cosmic_v64_web.py's Cisco IOS-style console. The Python one reads
// stdin on a daemon thread with readline; here the terminal lives in the page
// (see the input box under the log in index.html) and calls consoleExec() /
// consoleComplete() / consoleHelpFor().
//
//   Tab      complete the current word (command, sub-command, or flag)
//   ?        show what is available at this position, without pressing Enter
//   Up/Down  command history
// Unambiguous abbreviations expand: "STA" -> "STATUS", "PUS SEG" -> "PUSH
// SEGMENT", "SEND PL" is ambiguous (PLB/PLI/PLE) and says so.
//
// STORM fires runStormSequence() by hand. The storm is off in normal play
// (STORM_SYSTEM_ENABLED) because the client crashes on the SWS/SRS field
// layout, but the console can still drive it -- probing those field shapes is
// the only way that gets fixed.

// Every packet SEND can emit, with its wire format. Drives SEND itself plus
// tab-completion and "SEND ?".
const CONSOLE_SEND_PACKETS = {
  ST:   { args: '<elapsed_ms>', help: 'ST S 0 <elapsed> 0 0 0  --  sync client clock' },
  LN:   { args: '[n]', help: 'LN <n>  --  lobby number sent at connection (default 0)' },
  SC:   { args: '', help: 'SC S 0 0 0 0 0  --  session confirm after LA' },
  RU:   { args: '', help: 'RU BIR ...  --  room unlock state (uses current live values)' },
  PLB:  { args: '<count>', help: 'PLB <n>  --  player list begin (n entries follow)' },
  PLI:  { args: '<slot> <steps> <name>', help: 'PLI <slot> BIP 0 <steps> 0 P <name>  --  player list item' },
  PLE:  { args: '', help: 'PLE  --  player list end' },
  PJ:   { args: '<name>', help: 'PJ BIP 0 0 0 P <name>  --  player joined notification' },
  QT:   { args: '<step> <mode> <dur_s> <text>', help: 'QT <step> <mode> <dur_s> <text>  --  question text' },
  QATB: { args: '<count>', help: 'QATB <n>  --  answer list begin' },
  QATI: { args: '<idx> <answer_text>', help: 'QATI <idx> <text>  --  answer list item' },
  QATE: { args: '', help: 'QATE  --  answer list end' },
  QS:   { args: '<reveal_at> <qs_start> <duration_ms>', help: 'QS 0 0 S 0 <reveal_at> <qs_start> <dur_ms> 0  --  question timer' },
  NGS:  { args: '', help: 'NGS PRMD ... --  new game state (current board)' },
  JGS:  { args: '', help: 'JGS PRMD ... S 0 0 0 0 0  --  join game state (no animation)' },
  SP:   { args: '', help: 'SP S 0 0 0 0 0  --  segment/pyramid start' },
  SAS:  { args: '', help: 'SAS S 0 0 0 0 0  --  start-a-segment marker' },
  EGS:  { args: '', help: 'EGS S 0 0 0 0 0  --  end-game screen' },
  MAR:  { args: '<session_id> <slot> <answer_idx>', help: 'MAR <session_id> <slot> <ans>  --  my answer result' },
  ARB:  { args: '<count>', help: 'ARB <n>  --  answer reveal begin' },
  ARI:  { args: '<idx> <text> <pct> <steps>', help: 'ARI <idx> AR <idx> <text> <pct> <steps>  --  answer reveal item' },
  ARE:  { args: '', help: 'ARE  --  answer reveal end' },
  QRS:  { args: '', help: 'QRS PRMD ...  --  scoring animation (current board)' },
  PRS:  { args: '[slot]', help: 'PRS <slot> S 0 <target> <elapsed> 3000 0  --  piece move animation' },
  ADLB: { args: '<count>', help: 'ADLB <n>  --  ad list begin' },
  ADLI: { args: '<idx> <file.srf>', help: 'ADLI <idx> Ad <file> <file> 0  --  ad list item' },
  ADLE: { args: '', help: 'ADLE  --  ad list end' },
  BS:   { args: '[duration_ms]', help: 'BS S 0 <target> <elapsed> <dur> 0  --  break-start (default 35000 ms)' },
};

const CONSOLE_CMDS = {
  GAME:     { args: '[COSMIC|GTP|ACRO|YDKJ]', help: 'Show or switch which server takes NEW connections',
              sub: { COSMIC: { args: '', help: 'Cosmic Consensus (full round engine)' },
                     GTP:    { args: '', help: 'Get The Picture (lobby + record engine)' },
                     ACRO:   { args: '', help: 'Acrophobia (ported from Acrobot)' },
                     YDKJ:   { args: '', help: "You Don't Know Jack: Net Show (HTTP only, no IRC)" } } },
  RAW:      { args: '<irc-line>', help: 'Send raw IRC line to last-connected client' },
  MSG:      { args: '<body>', help: 'Send PRIVMSG body to last-connected client' },
  STATUS:   { args: '', help: 'Show game host status and connected players' },
  PLAYERS:  { args: '', help: 'List all player slots and pyramid steps' },
  PUSH:     { args: 'SEGMENT', help: 'Push a game action',
              sub: { SEGMENT: { args: '', help: 'Force a fresh game segment to start' } } },
  AD:       { args: '[file.srf]', help: 'Send sponsor-ad packet to host' },
  SPA:      { args: '[file.srf]', help: 'Alias for AD' },
  EGS:      { args: '', help: 'Send standalone EGS S 0 0 0 0 0 packet' },
  SEGUE:    { args: '[file.srf]', help: 'Send ad-segue sequence (BS -> EGS -> SA)' },
  ADSEGUE:  { args: '[file.srf]', help: 'Alias for SEGUE' },
  BREAK:    { args: '[file.srf]', help: 'Alias for SEGUE' },
  RESULTS:  { args: '[NOQRS] [NOQRR] [NOPRS]', help: 'Force-reveal current question results',
              flags: ['NOQRS', 'NOQRR', 'NOPRS'] },
  STORM:    { args: '', help: 'Force a storm sequence' },
  NEXTQ:    { args: '', help: 'Force next question immediately' },
  SKIP:     { args: '', help: 'Skip current round (results + advance)' },
  PLEAVE:   { args: '<username>', help: 'Broadcast PLEAVE packet for a player' },
  PL:       { args: '<username>', help: 'Alias for PLEAVE' },
  SEND:     { args: '<packet> [args]', help: 'Broadcast any game protocol packet',
              sub: CONSOLE_SEND_PACKETS },
  BLOWOUT:  { args: '', help: 'Trigger blowout ad sequence on host' },
  QUESTION: { args: '', help: 'Print current question text and answers' },
  ROOMS:    { args: '', help: 'List all active rooms and occupants' },
  KICK:     { args: '<username>', help: 'Disconnect and remove a player' },
  SYNC:     { args: '', help: 'Force player-list refresh on all clients' },
  LAB:      { args: '', help: 'Show LAB debug-command list' },
  HELP:     { args: '', help: 'Show all available commands' },
};

const CONSOLE_PROMPT = 'cosmic> ';

/** The game HOST, which is what every game-state command has to drive.
 *  Falls back to the last client to log on, matching the Python. */
function consoleHostClient() {
  for (const room of activeRoomsSnapshot()) {
    for (const c of room.clients) {
      if (c.gameSlot === 0 && c.connected && c.ingame === 1) return c;
    }
  }
  return consoleActiveClient();
}

function consoleActiveClient() {
  if (_activeClient && _activeClient.connected) return _activeClient;
  let last = null;
  for (const c of liveGameClients) if (c.connected) last = c;
  return last;
}

function consoleClientByUsername(name) {
  const want = String(name).toLowerCase();
  for (const c of liveGameClients) {
    if (c.connected && c.username && c.username.toLowerCase() === want) return c;
  }
  return null;
}

/** Expand an unambiguous prefix against a set of keys.
 *  -> { value } | { ambiguous: [...] } | { unknown: true } */
function consoleExpand(word, table) {
  const up = String(word).toUpperCase();
  if (Object.prototype.hasOwnProperty.call(table, up)) return { value: up };
  const matches = Object.keys(table).filter((k) => k.startsWith(up)).sort();
  if (matches.length === 1) return { value: matches[0] };
  if (matches.length > 1) return { ambiguous: matches };
  return { unknown: true };
}

function consolePad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** Contextual "?" help for a partial command line. Returns a string. */
function consoleHelpFor(words) {
  const out = [];
  if (!words.length) {
    for (const cmd of Object.keys(CONSOLE_CMDS).sort()) {
      const info = CONSOLE_CMDS[cmd];
      const suffix = info.args ? '  ' + info.args : '';
      out.push(`  ${consolePad(cmd, 12)}${consolePad(suffix, 24)} ${info.help}`);
    }
    return out.join('\n');
  }

  const exp = consoleExpand(words[0], CONSOLE_CMDS);
  if (exp.ambiguous) return '  % Ambiguous command: ' + exp.ambiguous.join(', ');
  if (exp.unknown) return `  % Unknown command '${String(words[0]).toUpperCase()}'`;
  const info = CONSOLE_CMDS[exp.value];
  const subs = info.sub || null;
  const flags = info.flags || null;

  if (words.length === 1) {
    if (subs) {
      for (const s of Object.keys(subs).sort()) out.push(`  ${consolePad(s, 12)}  ${subs[s].help}`);
    } else if (flags) {
      for (const f of flags) out.push(`  ${consolePad(f, 12)}  Suppress ${f.slice(2)} from the result burst`);
    } else {
      out.push('  <cr>' + (info.args ? '  ' + info.args : '  (no arguments)'));
    }
  } else if (subs) {
    const se = consoleExpand(words[1], subs);
    if (se.ambiguous) return '  % Ambiguous sub-command: ' + se.ambiguous.join(', ');
    if (se.unknown) return `  % Unknown sub-command '${String(words[1]).toUpperCase()}'`;
    out.push(`  <cr>  ${subs[se.value].help}`);
  } else if (flags) {
    const already = new Set(words.slice(1).map((w) => w.toUpperCase()));
    const remaining = flags.filter((f) => !already.has(f));
    if (!remaining.length) out.push('  <cr>  (all flags already specified)');
    else for (const f of remaining) out.push(`  ${consolePad(f, 12)}  Suppress ${f.slice(2)} from the result burst`);
  }
  return out.length ? out.join('\n') : '  <cr>';
}

/**
 * Tab completion for the whole buffer.
 * -> { buffer, matches } -- buffer is the (possibly extended) line, matches is
 * non-empty only when the choice was ambiguous and should be displayed.
 */
function consoleComplete(buffer) {
  const words = buffer.replace(/^\s+/, '').split(/\s+/).filter((w) => w.length);
  const trailingSpace = /\s$/.test(buffer);
  const onFirst = words.length === 0 || (words.length === 1 && !trailingSpace);

  let table = null;
  let prefix = '';
  if (onFirst) {
    table = CONSOLE_CMDS;
    prefix = (words[0] || '').toUpperCase();
  } else {
    const exp = consoleExpand(words[0], CONSOLE_CMDS);
    if (exp.ambiguous || exp.unknown) return { buffer, matches: [] };
    const info = CONSOLE_CMDS[exp.value];
    const onSecond = words.length === 1 || (words.length === 2 && !trailingSpace);
    if (info.sub && onSecond) {
      table = info.sub;
      prefix = (words[1] || '').toUpperCase();
    } else if (info.flags) {
      // Words already committed are excluded; the word being typed is not.
      const committed = trailingSpace ? words.slice(1) : words.slice(1, -1);
      const already = new Set(committed.map((w) => w.toUpperCase()));
      table = {};
      for (const f of info.flags) if (!already.has(f)) table[f] = true;
      prefix = trailingSpace ? '' : (words[words.length - 1] || '').toUpperCase();
    } else {
      return { buffer, matches: [] };
    }
  }

  const matches = Object.keys(table).filter((k) => k.startsWith(prefix)).sort();
  if (!matches.length) return { buffer, matches: [] };

  // Extend to the longest common prefix of all matches, the way readline does.
  let common = matches[0];
  for (const m of matches) {
    let i = 0;
    while (i < common.length && i < m.length && common[i] === m[i]) i++;
    common = common.slice(0, i);
  }
  const head = trailingSpace ? words : words.slice(0, -1);
  const rebuilt = (head.length ? head.join(' ') + ' ' : '') + common;
  return {
    buffer: matches.length === 1 ? rebuilt + ' ' : rebuilt,
    matches: matches.length === 1 ? [] : matches,
  };
}

/** Build the body for a SEND packet. Throws Error on a bad argument. */
function consoleBuildPacket(pkt, pktArg, host) {
  const elapsed = host.currentElapsedMs();
  const a = pktArg.trim();
  const parts = a.length ? a.split(/\s+/) : [];
  const names = host.currentPlayerNames();
  const num = (v, dflt) => {
    if (v === undefined || v === '') return dflt;
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) throw new Error(`'${v}' is not a number`);
    return n;
  };

  switch (pkt) {
    case 'ST':   return `ST S 0 ${num(parts[0], elapsed)} 0 0 0`;
    case 'LN':   return `LN ${num(parts[0], 0)}`;
    case 'SC':   return 'SC S 0 0 0 0 0';
    case 'RU':   return `RU ${host.roomUnlockLine(names.length)}`;
    case 'PLB':  return `PLB ${num(parts[0], names.length)}`;
    case 'PLI': {
      if (parts.length < 3) throw new Error('Usage: SEND PLI <slot> <steps> <name>');
      return `PLI ${num(parts[0])} BIP 0 ${num(parts[1])} 0 P ${parts.slice(2).join(' ')}`;
    }
    case 'PLE':  return 'PLE';
    case 'PJ': {
      if (!a) throw new Error('Usage: SEND PJ <name>');
      return `PJ BIP 0 0 0 P ${a}`;
    }
    case 'QT': {
      if (parts.length < 4) throw new Error('Usage: SEND QT <step> <mode> <dur_s> <text>');
      return `QT ${num(parts[0])} ${num(parts[1])} ${num(parts[2])} \x02${parts.slice(3).join(' ')}\x02`;
    }
    case 'QATB': return `QATB ${num(parts[0], 4)}`;
    case 'QATI': {
      if (parts.length < 2) throw new Error('Usage: SEND QATI <idx> <answer_text>');
      return `QATI ${num(parts[0])} \x02${parts.slice(1).join(' ')}\x02`;
    }
    case 'QATE': return 'QATE';
    case 'QS': {
      if (parts.length < 3) throw new Error('Usage: SEND QS <reveal_at> <qs_start> <duration_ms>');
      return `QS 0 0 S 0 ${num(parts[0])} ${num(parts[1])} ${num(parts[2])} 0`;
    }
    case 'NGS':  return host.ngsPacket();
    case 'JGS':  return `JGS ${host.getPrmdBody()} S 0 0 0 0 0`;
    case 'SP':   return 'SP S 0 0 0 0 0';
    case 'SAS':  return 'SAS S 0 0 0 0 0';
    case 'EGS':  return 'EGS S 0 0 0 0 0';
    case 'MAR': {
      if (parts.length < 3) throw new Error('Usage: SEND MAR <session_id> <slot> <answer_idx>');
      return `MAR ${num(parts[0])} ${num(parts[1])} ${num(parts[2])}`;
    }
    case 'ARB':  return `ARB ${num(parts[0], 4)}`;
    case 'ARI': {
      if (parts.length < 4) throw new Error('Usage: SEND ARI <idx> <text> <pct> <steps>');
      const idx = num(parts[0]);
      const steps = num(parts[parts.length - 1]);
      const pct = num(parts[parts.length - 2]);
      const text = parts.slice(1, -2).join(' ');
      return `ARI ${idx} AR ${idx} \x02${text}\x02 ${pct} ${steps}`;
    }
    case 'ARE':  return 'ARE';
    case 'QRS':  return `QRS ${host.getPrmdBody()} S 0 ${elapsed + 3000} ${elapsed} 3000 0`;
    case 'PRS': {
      const slot = a ? num(parts[0]) : 0;
      return `PRS ${slot} S 0 ${elapsed + 3000} ${elapsed} 3000 0`;
    }
    case 'ADLB': return `ADLB ${num(parts[0], 4)}`;
    case 'ADLI': {
      if (parts.length < 2) throw new Error('Usage: SEND ADLI <idx> <file.srf>');
      return `ADLI ${num(parts[0])} Ad ${parts[1]} ${parts[1]} 0`;
    }
    case 'ADLE': return 'ADLE';
    case 'BS': {
      const dur = num(parts[0], 35000);
      return `BS S 0 ${elapsed + dur} ${elapsed} ${dur} 0`;
    }
    default: throw new Error(`no handler for packet '${pkt}'`);
  }
}

/**
 * Run one console line. `print` receives each output line.
 * Async because most of the game actions are.
 */
async function consoleExec(line, print) {
  const say = print || ((s) => console.log(s));
  const cmd = String(line).trim();
  if (!cmd) return;

  // A bare "?" or a trailing "?" is contextual help, not a command.
  if (cmd === '?') { say(consoleHelpFor([])); return; }
  if (cmd.endsWith('?')) {
    const stem = cmd.slice(0, -1);
    say(consoleHelpFor(stem.trim().split(/\s+/).filter((w) => w.length)));
    return;
  }

  const sp = cmd.indexOf(' ');
  const rawVerb = (sp < 0 ? cmd : cmd.slice(0, sp)).toUpperCase();
  let arg = sp < 0 ? '' : cmd.slice(sp + 1).trim();

  if (rawVerb === 'GAME' || (rawVerb.length >= 2 && 'GAME'.startsWith(rawVerb))) {
    const PROFILES = {
      COSMIC: { key: 'cosmic', label: 'Cosmic Consensus' },
      GTP:    { key: 'gtp',    label: 'Get The Picture', note: 'Lobby + record only: everything past RS is logged, not answered.' },
      ACRO:   { key: 'acro',   label: 'Acrophobia',      note: 'Ported from Acrobot; never run against a real client yet.' },
      YDKJ:   { key: 'ydkj',   label: "You Don't Know Jack: Net Show", note: 'HTTP only -- game-port connections are refused by design.' },
    };
    const want = arg.toUpperCase();
    if (!want) {
      say(`[console] New connections go to: ${activeGameProfile.toUpperCase()}`);
      return;
    }
    const name = Object.keys(PROFILES).find((k) => k.startsWith(want));
    if (!name) { say(`[console] Unknown game '${arg}'. Use ${Object.keys(PROFILES).join(', ')}.`); return; }
    const p = PROFILES[name];
    const hook = GAME_PROFILE_HANDLERS[p.key];
    if (hook && !window[hook]) {
      say(`[console] ${p.label} is selected but its server file is not loaded -- reload the page.`);
      return;
    }
    setGameProfile(p.key);
    say(`[console] New connections -> ${p.label}.`);
    if (p.note) say(`[console] ${p.note}`);
    say('[console] Games already in progress keep the server they started on.');
    return;
  }

  const exp = consoleExpand(rawVerb, CONSOLE_CMDS);
  if (exp.ambiguous) {
    say(`[console] Ambiguous command '${rawVerb}' -- did you mean: ${exp.ambiguous.join(', ')}?`);
    return;
  }
  if (exp.unknown) {
    say(`[console] Unknown command '${rawVerb}' -- type HELP or ? for the list`);
    return;
  }
  const verb = exp.value;

  // Expand an unambiguous sub-command too, e.g. "PUS SEG" -> "PUSH SEGMENT".
  const subInfo = CONSOLE_CMDS[verb].sub;
  if (subInfo && arg) {
    const firstSub = arg.split(/\s+/)[0];
    const se = consoleExpand(firstSub, subInfo);
    if (se.ambiguous) {
      say(`[console] Ambiguous sub-command '${firstSub.toUpperCase()}' -- did you mean: ${se.ambiguous.join(', ')}?`);
      return;
    }
    if (se.value) arg = se.value + arg.slice(firstSub.length);
  }

  const client = consoleActiveClient();
  const host = consoleHostClient();
  const noClient = () => say('[console] No client connected yet');
  const noHost = () => say('[console] No host client connected yet');

  switch (verb) {
    case 'RAW':
      if (!client) return noClient();
      if (!arg) return say('[console] Usage: RAW <line>');
      await client.sendRaw(arg);
      return say(`[console] RAW -> ${arg}`);

    case 'MSG':
      if (!client) return noClient();
      if (!arg) return say('[console] Usage: MSG <body>');
      await client.botPriv(client.clientIrcName, arg);
      return say(`[console] MSG -> ${arg}`);

    case 'STATUS': {
      if (!host) return say('  (no client connected yet)');
      say(`  host:     ${host.clientIrcName} (slot ${host.gameSlot})`);
      say(`  ingame:   ${host.ingame}`);
      say(host.roomStartTime !== null
        ? `  elapsed:  ${host.currentElapsedMs()}ms since roomStartTime`
        : '  elapsed:  (roomStartTime not set)');
      say(`  round:    ${host.roundInSegment}`);
      say(`  question: #${host.questionIndex}`);
      say(`  resolved: ${host.roundResolved}`);
      if (host.room) say(`  players:  ${host.room.liveHumanCount()} human(s) in room`);
      return;
    }

    case 'PLAYERS': {
      if (!host) return noClient();
      const names = host.currentPlayerNames();
      for (let i = 0; i < names.length; i++) {
        say(`  [${i}] ${names[i]}  step=${host.playerSteps[i]}`);
      }
      return;
    }

    case 'PUSH':
      if (arg.trim().toUpperCase() !== 'SEGMENT') return say('[console] Usage: PUSH SEGMENT');
      if (!host) return noHost();
      say(`[console] Forcing a fresh segment -> ${host.clientIrcName}`);
      // Not awaited: a segment runs for minutes and would wedge the terminal.
      host.startSegment().catch((e) => say(`[console] segment failed: ${e}`));
      return;

    case 'AD':
    case 'SPA': {
      if (!host) return noClient();
      const sent = await host.sendSponsorAd(arg.trim() || null);
      return say(`[console] Sent sponsor-ad trigger: SPA Ad ${sent} ${sent} 0`);
    }

    case 'EGS':
      if (!host) return noClient();
      await host.sendLock.withLock(() => host.botPriv(host.clientIrcName, 'EGS S 0 0 0 0 0'));
      return say('[console] Sent standalone EGS S 0 0 0 0 0');

    case 'RESULTS': {
      if (!host) return noHost();
      if (!host.currentQuestion) return say('[console] No active question to reveal');
      const flags = new Set(arg.split(/\s+/).filter((s) => s).map((s) => s.toUpperCase()));
      say(`[console] Sending results with flags=[${[...flags].sort().join(', ')}]`);
      host.roundResolved = true;
      host.sendResultBurst(-1, -1, {
        includeQrs: !flags.has('NOQRS'),
        includeQrr: !flags.has('NOQRR'),
        includePrs: !flags.has('NOPRS'),
      }).catch((e) => say(`[console] results failed: ${e}`));
      return;
    }

    case 'SEGUE':
    case 'ADSEGUE':
    case 'BREAK': {
      if (!host) return noClient();
      const ads = await host.sendAdSegue(arg.trim() || null);
      return say(`[console] Sent suspected AdSegue path: BS -> EGS -> SA 1 AL 4 Ad ${(ads || []).join(', ')}`);
    }

    case 'STORM':
      if (!host) return noHost();
      say(`[console] Forcing a storm sequence -> ${host.clientIrcName}`);
      host.stormFiredThisSegment = true;
      // Not awaited: the insurance window alone is 25 s.
      host.runStormSequence(host.sessionGeneration)
        .catch((e) => say(`[console] storm failed: ${e}`));
      return;

    case 'NEXTQ':
      if (!host) return noHost();
      say('[console] Forcing next question');
      host.advanceRound().catch((e) => say(`[console] advance failed: ${e}`));
      return;

    case 'SKIP': {
      if (!host) return noHost();
      if (host.roundResolved) return say('[console] Round already resolved -- nothing to skip');
      host.roundResolved = true;
      say(`[console] Skipping current round -> ${host.clientIrcName}`);
      (async () => {
        await host.sendResultBurst(-1, -1, { includePrs: AUTO_INCLUDE_PRS });
        await host.advanceRound();
      })().catch((e) => say(`[console] skip failed: ${e}`));
      return;
    }

    case 'PLEAVE':
    case 'PL': {
      const username = arg.trim();
      if (!username) return say(`[console] Usage: ${verb} <username>`);
      // null room: sweep every active room, as the Python's does. No host
      // needed -- this is a broadcast, not something the host has to drive.
      const n = broadcastPleave(null, username);
      return say(`[console] Sent PLEAVE for '${username}' to ${n} client(s)`);
    }

    case 'SEND': {
      if (!host) return noHost();
      if (!arg) return say("[console] Usage: SEND <packet> [args]  --  type 'SEND ?' to list packets");
      const psp = arg.indexOf(' ');
      const rawPkt = (psp < 0 ? arg : arg.slice(0, psp)).toUpperCase();
      const pktArg = psp < 0 ? '' : arg.slice(psp + 1);
      const pe = consoleExpand(rawPkt, CONSOLE_SEND_PACKETS);
      if (pe.ambiguous) return say(`[console] Ambiguous packet '${rawPkt}': ${pe.ambiguous.join(', ')}`);
      if (pe.unknown) return say(`[console] Unknown packet '${rawPkt}' -- type 'SEND ?' to list packets`);
      let body;
      try {
        body = consoleBuildPacket(pe.value, pktArg, host);
      } catch (e) {
        return say(`[console] SEND: bad argument -- ${e.message}`);
      }
      await host.sendLock.withLock(() => host.botPriv(host.clientIrcName, body));
      return say(`[console] SEND -> ${body.slice(0, 120)}`);
    }

    case 'BLOWOUT':
      if (!host) return noHost();
      say(`[console] Triggering blowout sequence -> ${host.clientIrcName}`);
      host.sendBlowoutAds().catch((e) => say(`[console] blowout failed: ${e}`));
      return;

    case 'QUESTION': {
      if (!host) return noHost();
      const q = host.currentQuestion;
      if (!q) return say('[console] No active question');
      say(`  Q: ${q.question || '(unknown)'}`);
      const answers = q.answers || [];
      for (let i = 0; i < answers.length; i++) {
        say(`  ${i === q.correct_index ? '*' : ' '} [${i}] ${answers[i]}`);
      }
      return;
    }

    case 'ROOMS': {
      const all = activeRoomsSnapshot();
      if (!all.length) return say('[console] No active rooms');
      for (const room of all) {
        say(`  Room: ${room.roomName}  (${room.clients.length} client(s))`);
        for (const c of room.clients) {
          const role = c.gameSlot === 0 ? 'host' : 'guest';
          const st = c.connected ? 'connected' : 'disconnected';
          say(`    [${c.gameSlot}] ${consolePad(c.username || c.nick || '?', 20)}  ${consolePad(role, 6)}  ${st}`);
        }
      }
      return;
    }

    case 'KICK': {
      const uname = arg.trim();
      if (!uname) return say('[console] Usage: KICK <username>');
      const target = consoleClientByUsername(uname);
      if (!target) return say(`[console] Player '${uname}' not found`);
      target.markClientInactive('kicked via console');
      return say(`[console] Kicked '${uname}'`);
    }

    case 'SYNC':
      if (!host) return noHost();
      await host.sendPlayerList(host.playerSteps);
      return say(`[console] Sent player-list refresh (steps=[${host.playerSteps.join(', ')}])`);

    case 'LAB':
      return say('[console] LAB commands: RESULTS [NOQRS] [NOQRR] [NOPRS] | NEXTQ | MSG <token...> | RAW <irc line> | STATUS');

    case 'HELP':
      say('[console] Navigation: Tab = complete   ? = show options   Up/Down = history');
      say('[console] Abbreviations work: STA = STATUS, PUS SEG = PUSH SEGMENT, etc.');
      say('[console] Commands:');
      say(consoleHelpFor([]));
      return;

    default:
      return say(`[console] '${verb}' is listed but has no handler`);
  }
}

window.getActiveGameProfile = () => activeGameProfile;
window.setActiveGameProfile = setGameProfile;
window.cosmicConsole = {
  exec: consoleExec,
  help: consoleHelpFor,
  complete: consoleComplete,
  prompt: CONSOLE_PROMPT,
  commands: CONSOLE_CMDS,
};

window.cosmicHttpHandler = cosmicHttpHandler;
window.cosmicDnsHandler = cosmicDnsHandler;
window.startCosmicGameServer = startCosmicGameServer;
window.handleGameConnection = handleGameConnection;

// Start loading the question bank and ad manifest as soon as this file runs.
//
// These used to be awaited ONLY inside startCosmicGameServer(), which
// main.js deliberately does not call again on a hot reload (re-listening on an
// already-bound port would fail). So a reloaded module came up with QUESTIONS
// still at FALLBACK_QUESTIONS, and every game served after a reload showed the
// built-in placeholder question instead of the real bank.
//
// Kicking them off here means a reload repopulates both. Both are
// promise-memoised, so startCosmicGameServer()'s awaits on first load still
// wait for these same in-flight loads rather than racing past them.
ensureQuestionBankLoaded().catch((e) => console.error('[game] question bank load failed:', e));
ensureAdManifestLoaded().catch((e) => console.error('[game] ad manifest load failed:', e));

})();
