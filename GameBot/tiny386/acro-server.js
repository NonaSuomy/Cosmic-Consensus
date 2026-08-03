'use strict';

// Wrapped in an IIFE for the same reason cosmic-server.js is: Reload Server
// injects this file again, and removing the old <script> element does NOT
// undeclare its top-level bindings. A bare `const` therefore threw
// "Identifier 'X' has already been declared" on the second load and the reload
// silently did nothing. Everything below is function-scoped; only the
// window.* exports at the bottom outlive the call, and those are plain
// assignments that happily overwrite.
(function () {

// ── Acrophobia ───────────────────────────────────────────────────────────────
//
// Ported from SecondSight05/Acrobot (Python, AGPL-3.0), which is a working
// recreation of the 1997-2001 Berkeley Systems Acrophobia server. The protocol
// below is theirs; the structure follows cosmic-server.js so the two can share
// this page's accept loop and profile switch.
//
// Unlike Cosmic/GTP this is NOT a terse-token protocol. Acrophobia sends
// English words with quoted string arguments:
//
//     logon "user" "pass"          ->  logon_accepted
//     start_list bot / list_item bot ... / end_list bot
//     start_comp_round 2500 60000 <round> "<acronym>" "<category>"
//     response answer <time> "<acro>"
//     start_voting_round 2500 <ms> <round>
//     response vote <ircname> <value>
//
// Round flow, per Acrobot: start_game -> composition -> voting -> category
// pick -> scoring, repeating until someone reaches FACEOFF_SCORE, then a
// three-round faceoff between the top two and a final scoreboard.
//
// Status: first cut, never run against a real client. The message shapes come
// from Acrobot's source, but timing and the exact interleaving of the scoring
// lists are the parts most likely to need adjusting against a live capture.

const ACRO_SERVER_NAME = '10.0.2.2';
const ACRO_PORT = 6666;
const ACRO_BOT_NICK = 'Acrobot';
const ACRO_LIST_CHANNEL = 'Acro_List';
// From a real client transcript (2026-08-02): the channel is the room name
// with spaces stripped and an "Acro_" prefix -- "Acro Central" lives in
// #Acro_AcroCentral, not the Big_000-style numbering carried over from Cosmic.
const ACRO_ROOM_NAME = 'Acro Central';
const ACRO_ROOM_CHANNEL = 'Acro_' + ACRO_ROOM_NAME.replace(/ /g, '');
// Real bot sends an EMPTY mode string, not a word.
const ACRO_ROOM_MODE = '';
// The bot tells a lone player this outright; without it the wait looks broken.
const ACRO_MIN_PLAYERS = 3;

// Round pacing, in ms. The 2500 lead-in is Acrobot's constant: every start_*
// takes a delay first and a duration second.
const ACRO_LEAD_MS = 2500;
const ACRO_COMP_MS = 60000;
const ACRO_VOTE_MS = 30000;
const ACRO_CATEGORY_MS = 5000;
const ACRO_SCORE_MS = 8000;
const ACRO_FACEOFF_COMP_MS = 20000;
const ACRO_FACEOFF_VOTE_MS = 14000;

// Acrobot triggers the faceoff when any player reaches 30.
const ACRO_FACEOFF_SCORE = 30;
const ACRO_FACEOFF_ROUNDS = 3;

const ACRO_CATEGORIES = [
  'Things you should never say on a first date',
  'Bad names for a racehorse',
  'Rejected cereal mascots',
  'Signs your roommate is an alien',
  'Worst possible superpowers',
  'Things overheard in an elevator',
  'Unlikely bumper stickers',
  'Rejected theme park rides',
];

const ACRO_BOTS = ['Sparky', 'Mimsy', 'Rooter', 'Blix', 'Quill'];

function acroLog(msg) { console.log(`[acro] ${msg}`); }
function acroSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Acrophobia quotes its string arguments. A literal quote inside one would
// break the client's tokenizer, so strip rather than escape -- Acrobot has no
// escape convention to copy.
function acroQuote(s) {
  return `"${String(s == null ? '' : s).replace(/"/g, "'")}"`;
}

// Pull the quoted and bare arguments out of a body like:
//   response answer 1234 "MY ACRO"
function acroArgs(body) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(body)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function randomAcronym() {
  const letters = 'ABCDEFGHIJKLMNOPRSTUW';
  const len = 3 + Math.floor(Math.random() * 3);   // 3-5 letters
  let s = '';
  for (let i = 0; i < len; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

// ── cp1252 ───────────────────────────────────────────────────────────────────
// Local copy for the same reason gtp-server.js has one: cosmic-server.js is
// IIFE-wrapped and loads later, so its encoder is not reachable from here. The
// client is a pre-Unicode Win32 app and reads single-byte windows-1252.
const ACRO_CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';

const ACRO_CP1252_MAP = (() => {
  const m = new Map();
  for (let i = 0; i < ACRO_CP1252_HIGH.length; i++) {
    const ch = ACRO_CP1252_HIGH[i];
    if (ch && !m.has(ch)) m.set(ch, 0x80 + i);
  }
  return m;
})();

function acroEncode(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) bytes[i] = c;
    else if (ACRO_CP1252_MAP.has(str[i])) bytes[i] = ACRO_CP1252_MAP.get(str[i]);
    else bytes[i] = 0x3f;
  }
  return bytes;
}

// ── room ─────────────────────────────────────────────────────────────────────

const acroRooms = new Map();

class AcroRoom {
  constructor(channel) {
    this.channel = channel;
    this.clients = new Set();
    this.round = 0;
    this.running = false;
    this.generation = 0;
    this.phase = 'idle';
    // ircname -> { acro, timeMs }
    this.answers = new Map();
    // voter ircname -> { target, value }
    this.votes = new Map();
    this.category = ACRO_CATEGORIES[0];
    this.acronym = randomAcronym();
  }

  humans() { return [...this.clients].filter((c) => c.connected); }

  broadcast(body) {
    return Promise.all(this.humans().map((c) => c.sendRaw(
      `:${ACRO_BOT_NICK}!${ACRO_BOT_NICK}@${ACRO_SERVER_NAME} PRIVMSG #${this.channel} :${body}`
    )));
  }
}

function acroGetRoom(channel) {
  if (!acroRooms.has(channel)) acroRooms.set(channel, new AcroRoom(channel));
  return acroRooms.get(channel);
}

// ── client ───────────────────────────────────────────────────────────────────

let acroSeq = 0;

class AcroClient {
  constructor(conn) {
    this.conn = conn;
    this.id = ++acroSeq;
    // conn has no write(); take a writer off the stream, as cosmic-server.js
    // and gtp-server.js do.
    this.writer = conn.writable.getWriter();
    this.connected = true;
    this.registered = false;
    this.nick = null;
    this.username = null;
    this.score = 0;
    this.room = null;
    this.channel = null;
    this.buf = new Uint8Array(0);
  }

  label() { return this.nick || `(unregistered #${this.id})`; }

  async sendRaw(line) {
    if (!this.connected) return false;
    acroLog(`SEND [${this.label()}]: ${line}`);
    try {
      await this.writer.write(acroEncode(line + '\r\n'));
      return true;
    } catch (e) {
      acroLog(`STAT: Send failed (${e}) -- treating client as disconnected.`);
      this.connected = false;
      return false;
    }
  }

  // PRIVMSG from the bot straight to this client.
  priv(body) {
    return this.sendRaw(`:${ACRO_BOT_NICK}!${ACRO_BOT_NICK}@${ACRO_SERVER_NAME} PRIVMSG ${this.nick} :${body}`);
  }

  appendChunk(chunk) {
    const c = new Uint8Array(this.buf.length + chunk.length);
    c.set(this.buf, 0); c.set(chunk, this.buf.length);
    this.buf = c;
  }

  async drainLines() {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl < 0) break;
      let line = '';
      for (let i = 0; i < nl; i++) if (this.buf[i] !== 13) line += String.fromCharCode(this.buf[i]);
      this.buf = this.buf.slice(nl + 1);
      if (line.length) await this.handleLine(line);
      if (!this.connected) return;
    }
  }

  async handleLine(line) {
    acroLog(`RECV [${this.label()}]: ${line}`);
    const parts = line.split(' ');
    const cmd = (parts[0] || '').toUpperCase();
    const rest = parts.slice(1);
    switch (cmd) {
      case 'NICK': this.nick = rest[0] || `acro${this.id}`; return this.maybeRegister();
      case 'USER': this.username = this.username || rest[0] || 'player'; return this.maybeRegister();
      case 'PING': return this.sendRaw(`:${ACRO_SERVER_NAME} PONG ${ACRO_SERVER_NAME} :${rest[0] || ACRO_SERVER_NAME}`);
      case 'PONG': case 'MODE': return;
      case 'CAP': return this.sendRaw('CAP * LS :');
      case 'JOIN': return this.handleJoin((rest[0] || '').replace(/^:/, ''));
      case 'PART': return this.handlePart((rest[0] || '').replace(/^:/, ''));
      case 'PRIVMSG': return this.handlePrivmsg(line);
      case 'QUIT':
        this.connected = false;
        return this.sendRaw(`ERROR :Closing Link: ${this.nick} (Client Quit)`);
      default: acroLog(`RECORD unhandled IRC verb: ${line}`); return;
    }
  }

  async maybeRegister() {
    if (this.registered || !this.nick || !this.username) return;
    this.registered = true;
    const n = this.nick, s = ACRO_SERVER_NAME;
    await this.sendRaw(`:${s} 001 ${n} :Welcome to Acrophobia, ${n}`);
    await this.sendRaw(`:${s} 002 ${n} :Your host is ${s}, running Acro`);
    await this.sendRaw(`:${s} 003 ${n} :This server was created today`);
    await this.sendRaw(`:${s} 004 ${n} ${s} Acro o o`);
    await this.sendRaw(`:${s} 005 ${n} CHANTYPES=# :are supported by this server`);
    await this.sendRaw(`:${s} 251 ${n} :There are 0 users`);
    await this.sendRaw(`:${s} 375 ${n} :- ${s} Message of the Day -`);
    await this.sendRaw(`:${s} 372 ${n} :- Welcome to Acrophobia.`);
    await this.sendRaw(`:${s} 376 ${n} :End of /MOTD command.`);
    acroLog(`STAT: ${n} registered.`);
  }

  async handleJoin(channel) {
    const chan = channel || `#${ACRO_LIST_CHANNEL}`;
    const bare = chan.replace(/^#/, '');
    await this.sendRaw(`:${ACRO_BOT_NICK}!${ACRO_BOT_NICK}@${ACRO_SERVER_NAME} JOIN ${chan}`);
    await this.sendRaw(`:${this.nick}!${this.nick}@${ACRO_SERVER_NAME} JOIN ${chan}`);
    await this.sendRaw(`:${ACRO_SERVER_NAME} 353 ${this.nick} = ${chan} :@${ACRO_BOT_NICK} ${this.nick}`);
    await this.sendRaw(`:${ACRO_SERVER_NAME} 366 ${this.nick} ${chan} :End of /NAMES list.`);

    // logon_now goes out on EVERY join, lobby included -- Acrobot sends it
    // from its JOIN handler with no channel test (IRCClient.py:138). This file
    // originally skipped it for the lobby, which would have stalled the client
    // there forever: logon_now is its cue to send "logon", so nothing followed.
    this.channel = bare;
    if (bare !== ACRO_LIST_CHANNEL) {
      this.room = acroGetRoom(bare);
      this.room.clients.add(this);
    }
    await this.priv('logon_now');
  }

  async handlePart(channel) {
    await this.sendRaw(`:${this.nick}!${this.nick}@${ACRO_SERVER_NAME} PART ${channel}`);
    this.leaveRoom();
  }

  leaveRoom() {
    if (!this.room) return;
    const room = this.room;
    room.clients.delete(this);
    this.room = null;
    room.broadcast(`player remove ${acroQuote(this.nick)} ${this.score} ${acroQuote(this.username)}`);
    if (!room.humans().length) {
      room.running = false;
      room.generation += 1;
      acroLog(`STAT: room #${room.channel} empty -- stopping the loop.`);
    }
  }

  async handlePrivmsg(line) {
    const i = line.indexOf(' :');
    const body = i >= 0 ? line.slice(i + 2) : '';
    const args = acroArgs(body);
    const verb = (args[0] || '').toLowerCase();

    switch (verb) {
      case 'logon': {
        // logon "username" "password"
        this.username = args[1] || this.username || 'Player';
        acroLog(`STAT: logon as "${this.username}"`);
        await this.priv('logon_accepted');
        // What follows depends on WHERE they logged on, not on a fixed order
        // (IRCClient.py:167-202): in a game room it is the sponsor ad; in the
        // lobby it is the room list. Never both.
        if (this.channel && this.channel !== ACRO_LIST_CHANNEL) {
          await this.priv(`sponsor_ad ${acroQuote('acr182.srf')}`);
        } else {
          await this.sendRoomList();
        }
        return;
      }
      case 'start_play':
        return this.startPlay();
      case 'response':
        return this.handleResponse(args);
      case 'command':
        // command find_player "name"
        if ((args[1] || '').toLowerCase() === 'find_player') return this.findPlayer(args[2]);
        // command log_string "AGSM0,746,..." -- telemetry, no reply expected.
        return;
      case 'complain':
        return this.priv(`chat ${acroQuote('Thank you! Your complaint has been sent.')}`);
      case 'chat':
        acroLog(`CHAT [${this.username}]: ${args[1] || ''}`);
        return;
      case 'logoff':
        // logoff <ircname> "<reason>"
        this.leaveRoom();
        return;
      case 'log_string':
        return;   // client-side telemetry, nothing to answer
      default:
        acroLog(`RECORD unhandled game verb: ${body}`);
        return;
    }
  }

  async sendRoomList() {
    // start_list bot / list_item bot ... / end_list bot
    await this.priv('start_list bot');
    const room = acroGetRoom(ACRO_ROOM_CHANNEL);
    const players = room.humans().length;
    await this.priv(
      // Transcript, verbatim:
      //   list_item bot 0 "Acro Central" 0 "88.208.215.149" 6666 0
      //                   "Acro_AcroCentral" 0 "Acrobot" 1 "" 0 0 0 0
      // Note the leading 0 is NOT an incrementing index -- both rooms in the
      // capture use 0 -- and the trailing counters are all 0 even for a room
      // with players in it.
      `list_item bot 0 ${acroQuote(ACRO_ROOM_NAME)} 0 ${acroQuote(ACRO_SERVER_NAME)} ${ACRO_PORT} 0 ` +
      `${acroQuote(ACRO_ROOM_CHANNEL)} 0 ${acroQuote(ACRO_BOT_NICK)} 1 ${acroQuote(ACRO_ROOM_MODE)} 0 0 0 0`
    );
    await this.priv('end_list bot');
  }

  async findPlayer(name) {
    const wanted = String(name || '').toLowerCase();
    for (const room of acroRooms.values()) {
      for (const c of room.humans()) {
        if ((c.username || '').toLowerCase() === wanted) {
          await this.priv(
            `player_found ${acroQuote(c.username)} ${acroQuote(ACRO_ROOM_NAME)} 0 ` +
            `${acroQuote(ACRO_SERVER_NAME)} ${ACRO_PORT} 0 ${acroQuote(room.channel)} 0 ` +
            `${acroQuote(ACRO_BOT_NICK)} 1 ${acroQuote('normal')} ${room.humans().length} 0 0`
          );
          return;
        }
      }
    }
    await this.priv(`player_not_found ${acroQuote(name || '')}`);
  }

  async startPlay() {
    const room = this.room;
    if (!room) return;
    // current_state carries a STATE NAME, not a number -- the transcript shows
    // "current_state start_game", which the client logs as state 10 (waiting to
    // start). Sending an integer here left it in no state at all.
    await this.priv('current_state start_game');
    await this.priv(`chat ${acroQuote(`Welcome to ${ACRO_ROOM_NAME}`)}`);
    // player add goes to the CHANNEL; chat goes to the player.
    await room.broadcast(`player add ${acroQuote(this.nick)} ${this.score} ${acroQuote(this.username)}`);
    for (const c of room.humans()) {
      if (c !== this) await this.priv(`player add ${acroQuote(c.nick)} ${c.score} ${acroQuote(c.username)}`);
    }
    if (room.humans().length < ACRO_MIN_PLAYERS) {
      await this.priv(`chat ${acroQuote(`There must be at least ${ACRO_MIN_PLAYERS} players to start a game.`)}`);
    }
    if (!room.running) acroRunRoom(room).catch((e) => console.error('[acro] room loop error:', e));
  }

  async handleResponse(args) {
    const room = this.room;
    if (!room) return;
    const kind = (args[1] || '').toLowerCase();
    if (kind === 'answer') {
      // response answer <time> "<acro>"
      room.answers.set(this.nick, { acro: args[3] || '', timeMs: parseInt(args[2], 10) || 0, client: this });
      acroLog(`STAT: ${this.username} submitted "${args[3] || ''}"`);
      await room.broadcast(`answer_received ${room.answers.size}`);
    } else if (kind === 'vote') {
      // response vote <ircname> <value>
      room.votes.set(this.nick, { target: args[2] || '', value: parseInt(args[3], 10) || 0 });
      acroLog(`STAT: ${this.username} voted for ${args[2]}`);
    } else if (kind === 'category') {
      const idx = parseInt(args[2], 10) || 0;
      room.category = ACRO_CATEGORIES[idx % ACRO_CATEGORIES.length];
      acroLog(`STAT: category picked -> ${room.category}`);
    }
  }
}

// ── the round loop ───────────────────────────────────────────────────────────

async function acroRunRoom(room) {
  room.running = true;
  const gen = ++room.generation;
  const alive = () => room.running && gen === room.generation && room.humans().length > 0;

  await room.broadcast(`start_game ${ACRO_LEAD_MS}`);
  await acroSleep(ACRO_LEAD_MS);

  while (alive()) {
    room.round += 1;
    room.answers.clear();
    room.votes.clear();
    room.acronym = randomAcronym();

    // ── composition ──
    room.phase = 'comp';
    await room.broadcast(
      `start_comp_round ${ACRO_LEAD_MS} ${ACRO_COMP_MS} ${room.round} ` +
      `${acroQuote(room.acronym)} ${acroQuote(room.category)}`
    );
    await acroSleep(ACRO_LEAD_MS + ACRO_COMP_MS);
    if (!alive()) break;

    // House entries so a lone human still has something to vote on.
    let botIdx = 0;
    while (room.answers.size < 2 && botIdx < ACRO_BOTS.length) {
      const name = ACRO_BOTS[botIdx++];
      room.answers.set(name, {
        acro: room.acronym.split('').map((ch) => ch + '---').join(' '),
        timeMs: 30000, client: null,
      });
    }

    // ── voting ──
    room.phase = 'vote';
    const entries = [...room.answers.entries()];
    await room.broadcast(`start_voting_round ${ACRO_LEAD_MS} ${ACRO_VOTE_MS} ${room.round}`);
    await room.broadcast(`start_list answer ${entries.length} 1`);
    for (let i = 0; i < entries.length; i++) {
      await room.broadcast(`list_item answer ${i} ${acroQuote(entries[i][0])} ${acroQuote(entries[i][1].acro)}`);
    }
    await room.broadcast('end_list answer');
    await acroSleep(ACRO_LEAD_MS + ACRO_VOTE_MS);
    if (!alive()) break;

    // ── scoring ──
    room.phase = 'score';
    const tally = new Map();
    for (const [, v] of room.votes) tally.set(v.target, (tally.get(v.target) || 0) + 1);
    for (const c of room.humans()) {
      const got = tally.get(c.nick) || 0;
      c.score += got * 5;
      if (room.answers.has(c.nick)) c.score += 1;   // participation
    }

    let winner = room.humans()[0] || null;
    for (const c of room.humans()) if (winner && c.score > winner.score) winner = c;
    const winnerName = winner ? winner.username : ACRO_BOTS[0];

    await room.broadcast('start_list vote_count');
    let vi = 0;
    for (const c of room.humans()) {
      await room.broadcast(`list_item vote_count ${vi++} ${acroQuote(c.nick)} ${(tally.get(c.nick) || 0) * 5} ${room.votes.has(c.nick) ? 1 : 0} 0`);
    }
    await room.broadcast('end_list vote_count');

    await room.broadcast('start_list voted_for');
    for (const [voter, v] of room.votes) {
      await room.broadcast(`list_item voted_for 1 ${acroQuote(voter)} ${acroQuote(v.target)}`);
    }
    await room.broadcast('end_list voted_for');

    await room.broadcast('start_list score');
    let si = 0;
    for (const c of room.humans()) {
      const a = room.answers.get(c.nick);
      await room.broadcast(`list_item score ${si++} ${acroQuote(c.nick)} ${c.score} ${a ? a.timeMs : 0}`);
    }
    await room.broadcast('end_list score');
    await room.broadcast(`start_scores 1 ${acroQuote(winnerName)} 0 ${acroQuote(winnerName)} 2`);
    await acroSleep(ACRO_SCORE_MS);
    if (!alive()) break;

    // ── faceoff, or next category ──
    if (room.humans().some((c) => c.score >= ACRO_FACEOFF_SCORE)) {
      await acroRunFaceoff(room, alive);
      if (!alive()) break;
      room.round = 0;
      for (const c of room.humans()) c.score = 0;
      continue;
    }

    room.phase = 'category';
    await room.broadcast(`start_categories ${ACRO_LEAD_MS} ${ACRO_CATEGORY_MS} 1 ${acroQuote(winnerName)}`);
    await room.broadcast('start_list category');
    const picks = [];
    while (picks.length < 4) {
      const c = ACRO_CATEGORIES[Math.floor(Math.random() * ACRO_CATEGORIES.length)];
      if (!picks.includes(c)) picks.push(c);
    }
    for (let i = 0; i < picks.length; i++) await room.broadcast(`list_item category ${i} ${acroQuote(picks[i])}`);
    await room.broadcast('end_list category');
    await acroSleep(ACRO_LEAD_MS + ACRO_CATEGORY_MS);
    room.category = picks[0];
  }

  room.running = false;
  room.phase = 'idle';
  acroLog(`STAT: room #${room.channel} loop ended.`);
}

async function acroRunFaceoff(room, alive) {
  const ranked = [...room.humans()].sort((a, b) => b.score - a.score);
  const p1 = ranked[0], p2 = ranked[1] || ranked[0];
  if (!p1) return;
  acroLog(`STAT: FACEOFF -- ${p1.username} vs ${p2.username}`);
  room.phase = 'faceoff';

  const competitors = new Set([p1, p2]);
  for (const c of room.humans()) {
    if (competitors.has(c)) await c.priv(`start_rules faceoff_player 16250`);
    else await c.priv(`start_faceoff ${ACRO_LEAD_MS} 21250 0 ${acroQuote(p1.username)} ${acroQuote(p2.username)}`);
  }
  await acroSleep(ACRO_LEAD_MS);

  for (let r = 1; r <= ACRO_FACEOFF_ROUNDS && alive(); r++) {
    const acronym = randomAcronym();
    room.answers.clear();
    room.votes.clear();
    for (const c of room.humans()) {
      if (competitors.has(c)) {
        await c.priv(`start_faceoff_comp_round ${ACRO_LEAD_MS} ${ACRO_FACEOFF_COMP_MS} ${r} ${acroQuote(acronym)}`);
      } else {
        await c.priv(`start_faceoff_voting_round ${ACRO_LEAD_MS} ${ACRO_FACEOFF_VOTE_MS} ${r} ${acroQuote(acronym)}`);
      }
    }
    await acroSleep(ACRO_LEAD_MS + ACRO_FACEOFF_COMP_MS);
    if (!alive()) return;

    const entries = [...room.answers.entries()];
    await room.broadcast('start_list answer');
    for (let i = 0; i < entries.length; i++) {
      await room.broadcast(`list_item answer ${i} ${acroQuote(entries[i][0])} ${acroQuote(entries[i][1].acro)}`);
    }
    await room.broadcast('end_list answer');
    await acroSleep(ACRO_FACEOFF_VOTE_MS);
    if (!alive()) return;

    const tally = new Map();
    for (const [, v] of room.votes) tally.set(v.target, (tally.get(v.target) || 0) + 1);
    for (const c of competitors) c.score += (tally.get(c.nick) || 0) * 5;

    await room.broadcast(`start_face_scores ${r}`);
    await room.broadcast('start_list score');
    let i = 0;
    for (const c of competitors) await room.broadcast(`list_item score ${i++} ${acroQuote(c.nick)} ${c.score} 0`);
    await room.broadcast('end_list score');
  }

  await room.broadcast('start_final_scores 21250');
  await room.broadcast('start_list score');
  let i = 0;
  for (const c of room.humans()) await room.broadcast(`list_item score ${i++} ${acroQuote(c.nick)} 0 0`);
  await room.broadcast('end_list score');
  await acroSleep(21250);
}

// ── entry point ──────────────────────────────────────────────────────────────

async function acroHandleGameConnection(conn) {
  const client = new AcroClient(conn);
  acroLog('Connected: Acrophobia client');
  try {
    for await (const chunk of conn) {
      client.appendChunk(chunk);
      await client.drainLines();
      if (!client.connected) break;
    }
  } catch (e) {
    const expected = !client.connected && /connection closed/i.test(String((e && e.message) || e));
    if (expected) acroLog(`Connection closed after QUIT (expected): ${client.label()}`);
    else console.error(`[acro] Client error (${client.label()}):`, e);
  } finally {
    client.connected = false;
    client.leaveRoom();
    try { await conn.close(); } catch (e) { /* already closed */ }
    acroLog(`Disconnected: ${client.label()}`);
  }
}

window.acroHandleGameConnection = acroHandleGameConnection;
window.acroProfile = {
  displayName: 'Acrophobia',
  listChannel: ACRO_LIST_CHANNEL,
  botNick: ACRO_BOT_NICK,
  roomChannel: ACRO_ROOM_CHANNEL,
  port: ACRO_PORT,
};
})();
