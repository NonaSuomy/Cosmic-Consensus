'use strict';

// Wrapped in an IIFE for the same reason cosmic-server.js is: Reload Server
// injects this file again, and removing the old <script> element does NOT
// undeclare its top-level bindings. A bare `const` therefore threw
// "Identifier 'X' has already been declared" on the second load and the reload
// silently did nothing. Everything below is function-scoped; only the
// window.* exports at the bottom outlive the call, and those are plain
// assignments that happily overwrite.
(function () {

// ── Get The Picture (GTP) game server ────────────────────────────────────────
//
// A second BigIdea-lineage server living alongside cosmic-server.js. Switch
// between them from the console with:
//
//     GAME            show which server new connections go to
//     GAME GTP        route new connections here
//     GAME COSMIC     route them back to Cosmic Consensus
//
// Only NEW connections are affected -- an in-progress game keeps the server it
// started on, because the accept loop resolves the handler per connection.
//
// ── what is and is not confirmed ─────────────────────────────────────────────
//
// The LOBBY half is shared with Cosmic and is confirmed: the token table below
// was recovered from GetThePicture.exe, where 33 of its 34 entries are
// code-confirmed registrations (each token is passed to the registrar helper
// at 0x4028ec by a static-init block, the same mechanism Cosmic uses). So the
// LN/L/LA -> RR -> RB/RI/RE -> RS handshake is implemented for real here.
//
// The GAME half is NOT confirmed. GTP's own factory table is recovered too
// (GTP_TOKENS below, 27 of 28 code-confirmed), so the token NAMES are solid,
// but no field layout for any of them has ever been seen on a wire. Guessing
// at them would produce packets that look plausible and teach us nothing.
//
// So this runs the Python's "record" engine: complete the handshake, keep the
// socket alive past RS, and log every subsequent line verbatim. The point is
// to capture what a real client sends, which is the one thing static analysis
// of the exe cannot supply -- see GTP_room_building_findings.md, which reaches
// the same conclusion from the other direction.

// Lobby/engine tokens, shared with Cosmic Consensus.
// .data @ VA 0x54c34c in GetThePicture.exe.
const GTP_LOBBY_TOKENS = [
  'LN', 'L', 'LA', 'LO', 'LOA', 'SA', 'SPA', 'ADLB', 'ADLI', 'ADLE', 'AI',
  'PJ', 'PLEAVE', 'PLB', 'PLI', 'PLE', 'PUC', 'PRC', 'MC', 'HC', 'LER',
  'FP', 'PF', 'PNF', 'RB', 'RI', 'RE', 'LSR', 'LSA', 'RU', 'RR', 'GP',
  'ST', 'RS',
];

// GTP's own PictureRoomMsgFactory table -- the analogue of Cosmic's
// QT/QATB/QR1/PRS set, and completely different from it.
// .data @ VA 0x5439c4. Names are code-confirmed; FIELD LAYOUTS ARE NOT KNOWN.
//
// Paired with the RTTI class list in the same binary, the shape of the game is
// legible even without a capture: a Comp (caption) round, a Vote round, a
// "Fat Chance" round, scoring, round/game winner screens.
const GTP_TOKENS = {
  SC:   'StartCompRoomMsg',
  SV:   'StartVoteRoomMsg',
  SS:   'StartScoreRoomMsg',
  SRW:  'StartRoundWinnerRoomMsg',
  SFCS: 'StartFatChanceSelectionRoomMsg',
  SFCR: 'StartFatChanceResultsRoomMsg',
  SGW:  'StartGameWinnerRoomMsg',
  SP:   'StartPreflightRoomMsg',
  CR:   'CompReceivedRoomMsg',
  CL:   'CompLateRoomMsg',
  CI:   'CompInvalidRoomMsg',
  CLB:  'CompListBeginRoomMsg',
  CLI:  'CompListItemRoomMsg',
  CLE:  'CompListEndRoomMsg',
  VR:   'VoteReceivedRoomMsg',
  VL:   'VoteLateRoomMsg',
  VI:   'VoteInvalidRoomMsg',
  RLB:  'ResultListBeginRoomMsg',
  RLI:  'ResultListItemRoomMsg',
  RLE:  'ResultListEndRoomMsg',
  FCS:  'FatChanceSelectionRoomMsg',
  FCSR: 'FatChanceSelectionReceivedRoomMsg',
  FCSL: 'FatChanceSelectionLateRoomMsg',
  FCSI: 'FatChanceSelectionInvalidRoomMsg',
  DP:   'DownloadPictureRoomMsg',
  CP:   'ComplaintRoomMsg',
  PV:   '(unmapped)',
};

// From the captured dispatch.ini (Game List Server section). Confirmed.
// Not yet tried: LSR / LSA (ListSyncRequestRoomMsg / ListSyncAckRoomMsg) are
// in GTP's lobby token table and have NO Cosmic equivalent -- they are the one
// structural difference between the two lobbies that has not been used. If the
// client expects the room list to be framed by a list-sync exchange, an RI
// arriving outside that framing would be invalid no matter how it is spelled,
// which is exactly the symptom. Worth a look before any more shape guessing.
const GTP_LIST_CHANNEL = 'Picture_List';
const GTP_BOT_NICK = 'ListNick';
const GTP_SHOW_ID = 'GTP';
const GTP_DISPLAY_NAME = 'Get the Picture Netshow';
const GTP_NETWORK_TOKEN = 'GTP';

// Per-room identity. GENUINELY UNCONFIRMED -- the dispatch.ini configures only
// the lobby connection, and the per-room channel/nick are assigned at runtime
// by the game-list server, so they exist in no static file. 'Picture_000' is
// this codebase's convention carried over from Big_000, not evidence.
const GTP_ROOM_CHANNEL = 'Picture_000';
const GTP_ROOM_BOT = 'ListNick';

// The room record token that opens an RI/RU body -- Cosmic's 'BIR' slot.
//
// 'BIR' is confirmed ABSENT from GetThePicture.exe (zero byte matches), so the
// value inherited from the Cosmic profile is definitely wrong. 'PR' is the
// candidate: it is a real registered type, passed to the same registrar helper
// at 0x4028ec from 0x44a08a, and in the string table it sits immediately
// before "dead"/"unknown"/"Dead" -- the exact neighbours Cosmic's BIP/BIR pair
// has. Not proven to be the room record specifically; it is the only credible
// candidate in the binary.
// 'PR' was tried first and every RI carrying it killed the client -- even a
// bare "RI 0 PR" with no fields at all, which is what ruled the field list out
// and pointed here instead.
//
// 'R' is the better candidate. It is a registered type in its own right
// (registrar helper 0x4028ec, called from 0x4b0a08) and it registers from the
// SAME 0x4b.. module as RB/RI/RE (0x4b3d6d / 0x4b3ea0 / 0x4b413c), where PR
// comes from 0x44a08a -- a different module entirely. And it fits the naming:
// "BI" in Cosmic's BIR/BIP is Big Idea branding, and Cosmic's own lines carry
// a bare R and P in the very slot this token would occupy --
//
//     RI  0 BIR 0 0 1 R Cosmic_Consensus ...
//     PLI 0 BIP 0 0 0 P NonaSuomy
//
// so R (room) and P (player) are plausibly what the un-branded protocol uses.
const GTP_ROOM_TYPE_TOKEN = 'R';
// The player-record analogue, for when PLI is needed. Same reasoning.
const GTP_PLAYER_TYPE_TOKEN = 'P';

// What to answer RR with. Mirrors the switches cosmic-gtp_standalone_v63.py
// already has in _handle_rr, so the two servers can be compared directly:
//
//   'no-ri'   RB 1 then RE, with the RI line omitted   (Python: TEST_MISMATCHED_ROOM_COUNT)
//   'empty'   RB 0 then RE, a consistent empty list    (Python: TEST_EMPTY_ROOM_LIST)
//   'full'    RB 1, the RI line, then RE               (Python: default)
//   'manual'  send nothing; drive it by hand           (Python: MANUAL_ROOM_LIST)
//
// Default is 'no-ri' because that is the one reported to reach the title
// screen -- offering the room crashes the client instead. Note it is
// deliberately INCONSISTENT: the count says one room but no item follows. That
// it survives this and not a well-formed RI is the strongest hint yet that the
// RI field layout, not the room count, is what the client cannot parse.
const GTP_ROOM_LIST_MODE = 'no-ri';

// Must match what the VM can actually reach. The shipped picture/dispatch.ini
// said 127.0.0.1 for every server, which inside the guest is the GUEST -- so
// the client dialled itself and never reached us. The served copy is now
// 10.0.2.2 throughout, the same address cosmic's dispatch.ini uses.
const GTP_SERVER_NAME = '10.0.2.2';

// Local copy on purpose. cosmic-server.js is IIFE-wrapped, so its
// encodeCp1252 is not global, and this file is loaded BEFORE it anyway --
// reaching across would be fragile in both directions.
//
// The client is a pre-Unicode Win32 ANSI app: it reads raw single-byte
// windows-1252 off the wire. TextEncoder always emits UTF-8, which turns every
// code point above U+007F into a 2-3 byte sequence and renders as mojibake.
const GTP_CP1252_HIGH_CHARS =
  '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021' +
  '\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F' +
  '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014' +
  '\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';

const GTP_CP1252_ENCODE_MAP = (() => {
  const map = new Map();
  for (let i = 0; i < GTP_CP1252_HIGH_CHARS.length; i++) {
    const ch = GTP_CP1252_HIGH_CHARS[i];
    if (ch && !map.has(ch)) map.set(ch, 0x80 + i);
  }
  return map;
})();

function encodeCp1252(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) {
      bytes[i] = code;
    } else if (GTP_CP1252_ENCODE_MAP.has(str[i])) {
      bytes[i] = GTP_CP1252_ENCODE_MAP.get(str[i]);
    } else {
      bytes[i] = 0x3f; // '?' -- no CP1252 representation
    }
  }
  return bytes;
}

// Which RI body shape to send. The room-select screen shows
//
//     Room   #Players   Round   HighScore   Mode
//
// -- five values, two of which (HighScore, Mode) the Cosmic-shaped line has
// nowhere to carry. Acrobot's equivalent DOES carry them, and its column set
// is the same, so its field order is the best template available:
//
//     list_item bot 0 "name" 0 "server" port 0 "channel" 0 "Acrobot"
//               clean "mode" players highscore 0 param        (IRCClient.py:196)
//
// Note "mode" is a QUOTED string there, not an int -- if GTP parses the same
// way, an unquoted or absent mode would leave the tokenizer reading past the
// end of the line, which is the shape of failure we actually see.
//
//   'cosmic'  13 fields, Cosmic's exact BIR layout          (what we sent before)
//   'acro'    Acrobot's column order with PR in front       (default)
//   'cosmic+' Cosmic's layout with round/highscore/"mode" appended
//   'minimal' just the type token and nothing else
//
// 'acro' and 'cosmic+' both killed the client at exactly the same point, so
// the trailing fields are NOT the variable and more field-order guesses are
// unlikely to pay. 'minimal' asks a different question: does ANY room item
// crash it? If a body carrying only the type token also dies, the fault is not
// in the field list at all -- it is the item itself, or the type token, and
// the next thing to vary is GTP_ROOM_TYPE_TOKEN. If it survives, the fields
// are back in play and can be bisected by adding them one at a time.
// Tested 2026-08-02, all four crash the client the instant RE follows:
//     acro      RI 0 PR "Get The Picture" 0 "10.0.2.2" 6666 0 ... "normal" 0 0 0 0
//     cosmic+   RI 0 PR 0 0 1 R Get_The_Picture ... 0 0 0 "normal" 0
//     minimal   RI 0 PR
//     minimal   RI 0 R      (token swapped, everything else identical)
//
// Any RI dies; RB 1 + RE with no item reaches the title screen. So it is not
// the field order, not the field count, and not the type token -- the client
// fails on the presence of a room entry at all. Field-shape guessing is
// exhausted as an approach; see the note on LSR/LSA below.
const GTP_RI_SHAPE = 'minimal';

// Quoted in the 'acro' shape, so spaces are safe there; the cosmic shapes
// need the underscore form.
const GTP_ROOM_DISPLAY_NAME = 'Get The Picture';
const GTP_ROOM_MODE = 'normal';

function gtpRoomInfoBody(players = 0, round = 0, highScore = 0) {
  const t = GTP_ROOM_TYPE_TOKEN, sv = GTP_SERVER_NAME, p = GTP_PORT;
  const ch = GTP_ROOM_CHANNEL, bot = GTP_ROOM_BOT;
  // The cosmic shapes do NOT quote their strings, so a name with spaces would
  // land as three extra tokens and shift every field after it. Underscore it
  // for those, exactly as Cosmic writes Cosmic_Consensus; only the quoted
  // 'acro' shape can carry the spaced form.
  const dn = (GTP_RI_SHAPE === 'acro')
    ? GTP_ROOM_DISPLAY_NAME
    : GTP_ROOM_DISPLAY_NAME.replace(/ /g, '_');
  if (GTP_RI_SHAPE === 'minimal') {
    return `${t}`;
  }
  if (GTP_RI_SHAPE === 'cosmic') {
    return `${t} 0 0 1 R ${dn} ${sv} ${p} ${ch} ${bot} ${players} -1 0`;
  }
  if (GTP_RI_SHAPE === 'cosmic+') {
    return `${t} 0 0 1 R ${dn} ${sv} ${p} ${ch} ${bot} ${players} ${round} ${highScore} "${GTP_ROOM_MODE}" 0`;
  }
  // 'acro': faithful to IRCClient.py:196, allowing for RI carrying its index
  // BEFORE the type token where Acrobot puts the type first:
  //
  //   acrobot   list_item bot 0 "name" 0 "server" port 0 "channel" 0 "Acrobot"
  //                            clean "mode" players highscore 0 param
  //   ours      RI 0 PR       "name" 0 "server" port 0 "channel" 0 "ListNick"
  //                            clean "mode" players highscore 0 param
  //
  // Every string field is QUOTED, which is the part an earlier version of this
  // function got wrong -- it used Acrobot's field ORDER but Cosmic's unquoted
  // convention, and was one slot out as a result. The quoting is also why the
  // display name can contain spaces here: Cosmic writes Cosmic_Consensus with
  // underscores precisely because its fields are NOT quoted.
  return `${t} "${dn}" 0 "${sv}" ${p} 0 "${ch}" 0 "${bot}" 1 "${GTP_ROOM_MODE}" ${players} ${highScore} 0 ${round}`;
}

let gtpSeq = 0;

function gtpLog(msg) { console.log(`[gtp] ${msg}`); }

class GtpClient {
  constructor(conn) {
    this.conn = conn;
    this.id = ++gtpSeq;
    this.connected = true;
    this.registered = false;
    this.nick = null;
    this.username = null;
    this.ingame = false;
    // conn has no write() -- take a writer off its WritableStream, the same
    // way cosmic-server.js's GameClient does. Calling conn.write() threw on
    // the very first line (the 001 welcome), and because sendRaw swallowed
    // the error the client just vanished with no diagnostic.
    this.writer = conn.writable.getWriter();
    this.buf = new Uint8Array(0);
    this.recorded = [];
  }

  label() { return this.nick || `(unregistered #${this.id})`; }

  async sendRaw(line) {
    if (!this.connected) return false;
    gtpLog(`SEND [${this.label()}]: ${line}`);
    try {
      // cp1252, not UTF-8: the client is a 1999 Win32 app, and TextEncoder
      // would turn every byte >= 0x80 into a 2-3 byte sequence.
      await this.writer.write(encodeCp1252(line + '\r\n'));
      return true;
    } catch (e) {
      // Loudly. Swallowing this is what made the first failure look like a
      // clean disconnect instead of a bug.
      gtpLog(`STAT: Send failed (${e}) -- treating client as disconnected.`);
      this.connected = false;
      return false;
    }
  }

  botPriv(body) {
    return this.sendRaw(
      `:${GTP_BOT_NICK}!${GTP_BOT_NICK}@${GTP_SERVER_NAME} PRIVMSG ${this.nick} :${body}`
    );
  }

  appendChunk(chunk) {
    const combined = new Uint8Array(this.buf.length + chunk.length);
    combined.set(this.buf, 0);
    combined.set(chunk, this.buf.length);
    this.buf = combined;
  }

  async drainLines() {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) break;
      // Decode as cp1252-ish: the client is a 1999 Win32 app, not UTF-8.
      let line = '';
      for (let i = 0; i < nl; i++) {
        const b = this.buf[i];
        if (b !== 13) line += String.fromCharCode(b);
      }
      this.buf = this.buf.slice(nl + 1);
      if (line.length) await this.handleLine(line);
      if (!this.connected) return;
    }
  }

  async handleLine(line) {
    gtpLog(`RECV [${this.label()}]: ${line}`);
    const parts = line.split(' ');
    const cmd = (parts[0] || '').toUpperCase();
    const rest = parts.slice(1);

    switch (cmd) {
      case 'NICK':
        this.nick = rest[0] || `gtp${this.id}`;
        return this.maybeRegister();
      case 'USER':
        this.username = rest[0] || 'user';
        return this.maybeRegister();
      case 'PING':
        return this.sendRaw(`:${GTP_SERVER_NAME} PONG ${GTP_SERVER_NAME} :${rest[0] || GTP_SERVER_NAME}`);
      case 'PONG':
        return;
      case 'MODE':
        return;
      case 'CAP':
        return this.sendRaw('CAP * LS :');
      case 'JOIN':
        return this.handleJoin(rest[0] || '');
      case 'PART':
        return this.sendRaw(`:${this.nick}!${this.nick}@${GTP_SERVER_NAME} PART ${rest[0] || ''}`);
      case 'PRIVMSG':
        return this.handlePrivmsg(line);
      case 'QUIT':
        this.connected = false;
        return this.sendRaw(`ERROR :Closing Link: ${this.nick} (Client Quit)`);
      default:
        gtpLog(`RECORD unhandled IRC verb: ${line}`);
        return;
    }
  }

  async maybeRegister() {
    if (this.registered || !this.nick || !this.username) return;
    this.registered = true;
    const n = this.nick;
    const s = GTP_SERVER_NAME;
    await this.sendRaw(`:${s} 001 ${n} :Welcome to ${GTP_DISPLAY_NAME}, ${n}`);
    await this.sendRaw(`:${s} 002 ${n} :Your host is ${s}, running ${GTP_NETWORK_TOKEN}`);
    await this.sendRaw(`:${s} 003 ${n} :This server was created today`);
    await this.sendRaw(`:${s} 004 ${n} ${s} ${GTP_NETWORK_TOKEN} o o`);
    await this.sendRaw(`:${s} 005 ${n} CHANTYPES=# :are supported by this server`);
    await this.sendRaw(`:${s} 251 ${n} :There are 0 users`);
    await this.sendRaw(`:${s} 375 ${n} :- ${s} Message of the Day -`);
    await this.sendRaw(`:${s} 372 ${n} :- Welcome to ${GTP_DISPLAY_NAME}.`);
    await this.sendRaw(`:${s} 376 ${n} :End of /MOTD command.`);
    await this.sendRaw(`:${s} 255 ${n} :I have 1 clients and 0 servers`);
    gtpLog(`STAT: ${n} registered.`);
  }

  async handleJoin(channel) {
    const chan = channel.replace(/^:/, '') || `#${GTP_LIST_CHANNEL}`;
    await this.sendRaw(`:${GTP_BOT_NICK}!${GTP_BOT_NICK}@${GTP_SERVER_NAME} JOIN ${chan}`);
    await this.sendRaw(`:${this.nick}!${this.nick}@${GTP_SERVER_NAME} JOIN ${chan}`);
    await this.sendRaw(`:${GTP_SERVER_NAME} 353 ${this.nick} = ${chan} :@${GTP_BOT_NICK} ${this.nick}`);
    await this.sendRaw(`:${GTP_SERVER_NAME} 366 ${this.nick} ${chan} :End of /NAMES list.`);
    // LN opens the login handshake, exactly as Cosmic does on #Big_List.
    await this.botPriv('LN 0');
  }

  async handlePrivmsg(line) {
    // "PRIVMSG <target> :<body>"
    const idx = line.indexOf(' :');
    const body = idx >= 0 ? line.slice(idx + 2) : '';
    const parts = body.split(' ').filter((s) => s.length);
    const token = (parts[0] || '').toUpperCase();

    switch (token) {
      case 'L': {
        // L <username> <...>  -- identity. Mirror it back with LA.
        // L <user> <n> Version <a> <b> <c> <d> <playerid> <session> <flag>
        // Echo the version and player id the client just gave us rather than
        // hardcoding them: it announced 1 0 0 27 while this replied 1 0 0 26,
        // and a client told its own build is out of date is entitled to stop.
        this.username = parts[1] || this.username || 'Player';
        const vi = parts.findIndex((p) => p.toLowerCase() === 'version');
        const version = (vi >= 0 && parts.length >= vi + 5)
          ? parts.slice(vi + 1, vi + 5).join(' ')
          : '1 0 0 26';
        const playerId = (vi >= 0 && parts.length >= vi + 6) ? parts[vi + 5] : '1000';
        gtpLog(`STAT: Client identity resolved as "${this.username}" (version ${version.replace(/ /g, '.')}, id ${playerId}).`);
        await this.botPriv(`LA ${this.username} Version ${version} ${playerId}`);
        return;
      }
      case 'RR': {
        gtpLog(`STAT: "${this.username}" wants the room list`);
        const riLine = `RI 0 ${gtpRoomInfoBody()}`;
        if (GTP_ROOM_LIST_MODE === 'manual') {
          gtpLog('STAT: room list mode "manual" -- sending nothing. Send it yourself:');
          gtpLog('        RB 1');
          gtpLog(`        ${riLine}`);
          gtpLog('        RE');
          return;
        }
        if (GTP_ROOM_LIST_MODE === 'empty') {
          gtpLog('STAT: room list mode "empty" -- RB 0 / RE, a consistent empty list.');
          await this.botPriv('RB 0');
          await this.botPriv('RE');
          return;
        }
        if (GTP_ROOM_LIST_MODE === 'full') {
          gtpLog('STAT: room list mode "full" -- offering the room. This is the mode that crashes.');
          await this.botPriv('RB 1');
          await this.botPriv(riLine);
          await this.botPriv('RE');
          return;
        }
        // 'no-ri': the count claims a room, no item follows. Reported to reach
        // the title screen where 'full' crashes.
        gtpLog('STAT: room list mode "no-ri" -- RB 1 / RE, RI omitted.');
        await this.botPriv('RB 1');
        await this.botPriv('RE');
        return;
      }
      case 'LO': {
        await this.botPriv(`LOA ${parts[1] || '-1'}`);
        return;
      }
      case 'RS': {
        // The client has picked a room. Everything past here is unmapped, so
        // acknowledge minimally and record.
        this.ingame = true;
        gtpLog(`STAT: "${this.username}" selected a room (RS) -- entering RECORD mode.`);
        gtpLog('STAT: every further line is logged verbatim; nothing is answered.');
        return;
      }
      default: {
        this.recorded.push(body);
        const known = GTP_TOKENS[token] || (GTP_LOBBY_TOKENS.includes(token) ? '(lobby token)' : null);
        gtpLog(`RECORD ${this.recorded.length}: ${body}` + (known ? `   <- ${token} = ${known}` : ''));
        return;
      }
    }
  }
}

// One listener serves both profiles -- which one answers is chosen by the
// console's GAME command / the page's Server dropdown -- so GTP has to be on
// the same port Cosmic binds (GAME_PORT), not the 6667 its original
// dispatch.ini specified. The served picture/dispatch.ini was changed to match;
// if you ever give GTP its own listener, change both back together.
const GTP_PORT = 6666;

async function gtpHandleGameConnection(conn) {
  const client = new GtpClient(conn);
  gtpLog('Connected: GTP client');
  try {
    for await (const chunk of conn) {
      client.appendChunk(chunk);
      await client.drainLines();
      if (!client.connected) break;
    }
  } catch (e) {
    const expected = !client.connected && /connection closed/i.test(String((e && e.message) || e));
    if (expected) gtpLog(`Connection closed after QUIT (expected): ${client.label()}`);
    else console.error(`[gtp] Client error (${client.label()}):`, e);
  } finally {
    try { await conn.close(); } catch (e) { /* already closed */ }
    if (client.recorded.length) {
      gtpLog(`Session recorded ${client.recorded.length} unmapped line(s):`);
      client.recorded.forEach((l, i) => gtpLog(`  ${i + 1}. ${l}`));
    }
    gtpLog(`Disconnected: ${client.label()}`);
  }
}

window.gtpHandleGameConnection = gtpHandleGameConnection;
window.gtpProfile = {
  showId: GTP_SHOW_ID,
  displayName: GTP_DISPLAY_NAME,
  listChannel: GTP_LIST_CHANNEL,
  botNick: GTP_BOT_NICK,
  roomChannel: GTP_ROOM_CHANNEL,
  roomBot: GTP_ROOM_BOT,
  roomTypeToken: GTP_ROOM_TYPE_TOKEN,
  port: GTP_PORT,
  lobbyTokens: GTP_LOBBY_TOKENS,
  gameTokens: GTP_TOKENS,
};
})();
