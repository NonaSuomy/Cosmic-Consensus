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
const ACRO_ROOMS = [
  { name: ACRO_ROOM_NAME, channel: ACRO_ROOM_CHANNEL, clean: 1 },
  { name: 'Dungeon', channel: 'Acro_Dungeon', clean: 0 },
];
// Real bot sends an EMPTY mode string, not a word.
const ACRO_ROOM_MODE = '';
// The bot tells a lone player this outright; without it the wait looks broken.
const ACRO_MIN_PLAYERS = 3;

// Round pacing, in ms. The 2500 lead-in is Acrobot's constant: every start_*
// takes a delay first and a duration second.
const ACRO_LEAD_MS = 2500;
const ACRO_COMP_MS = 60000;
const ACRO_VOTE_MS = 20000;
const ACRO_CATEGORY_MS = 10000;
const ACRO_SCORE_MS = 45000;
const ACRO_FACEOFF_COMP_MS = 20000;
const ACRO_FACEOFF_VOTE_MS = 14000;

// Acrobot triggers the faceoff when any player reaches 30.
const ACRO_FACEOFF_SCORE = 30;
const ACRO_FACEOFF_ROUNDS = 3;
const ACRO_RESULT_DISPLAY_MS = 45000;

const ACRO_BOT_WORDS = {
  A: ['Amazing', 'Ancient', 'Angry', 'Accidental'], B: ['Big', 'Brave', 'Bright', 'Broken'],
  C: ['Clever', 'Crazy', 'Curious', 'Cosmic'], D: ['Daring', 'Daily', 'Dancing', 'Delicious'],
  E: ['Early', 'Electric', 'Elegant', 'Exciting'], F: ['Famous', 'Fancy', 'Fearless', 'Funny'],
  G: ['Gentle', 'Golden', 'Great', 'Green'], H: ['Happy', 'Helpful', 'Hidden', 'Historic'],
  I: ['Ideal', 'Impressive', 'Incredible', 'Instant'], J: ['Jolly', 'Joyful', 'Junior', 'Jumbo'],
  K: ['Kind', 'Kooky', 'Keen', 'Key'], L: ['Lucky', 'Lively', 'Little', 'Legendary'],
  M: ['Magic', 'Major', 'Modern', 'Mysterious'], N: ['Nice', 'Noble', 'Noisy', 'Northern'],
  O: ['Odd', 'Open', 'Ordinary', 'Outstanding'], P: ['Perfect', 'Playful', 'Popular', 'Powerful'],
  Q: ['Quick', 'Quiet', 'Quirky', 'Questionable'], R: ['Rapid', 'Ready', 'Really', 'Royal'],
  S: ['Silly', 'Simple', 'Smooth', 'Super'], T: ['Tiny', 'Total', 'Tricky', 'Terrific'],
  U: ['Ultra', 'Unique', 'Unusual', 'Useful'], V: ['Vast', 'Very', 'Vibrant', 'Victorious'],
  W: ['Wild', 'Wise', 'Wonderful', 'Witty'], X: ['Xtreme', 'Xenial', 'Xylophone', 'Xtra'],
  Y: ['Young', 'Yummy', 'Yearly', 'Yellow'], Z: ['Zany', 'Zealous', 'Zesty', 'Zippy'],
};

const acroAccounts = new Map();
try {
  const saved = window.localStorage && window.localStorage.getItem('acro-accounts');
  if (saved) {
    for (const [name, account] of Object.entries(JSON.parse(saved))) acroAccounts.set(name, account);
  }
} catch (e) { /* private browsing or unavailable storage: use session accounts */ }

function acroSaveAccounts() {
  try {
    if (window.localStorage) window.localStorage.setItem('acro-accounts', JSON.stringify(Object.fromEntries(acroAccounts)));
  } catch (e) { /* storage is optional for the in-browser server */ }
}

const ACRO_CATEGORIES = [
  'Television', 'Animals', 'Food + Drink', 'Current Events', 'Geography',
  'Science', 'History', 'Celebrities', 'Show Biz', 'Sports',
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

function randomAcronym(length = 3 + Math.floor(Math.random() * 3)) {
  const letters = 'ABCDEFGHIJKLMNOPRSTUW';
  const len = length;
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
    this.starting = false;
    this.generation = 0;
    this.phase = 'idle';
    this.mode = 'Waiting';
    this.categoryChoices = [];
    this.categoryIndex = '';
    this.winner = '';
    this.speedWinner = '';
    this.botScores = new Map();
    // ircname -> { acro, timeMs }
    this.answers = new Map();
    this.answerTimes = new Map();
    // voter ircname -> { target, value }
    this.votes = new Map();
    this.category = ACRO_CATEGORIES[0];
    this.acronym = randomAcronym();
    this.faceoffPlayers = [];
    this.faceoffAnswers = new Map();
    this.faceoffVotes = new Map();
    this.faceoffTotals = new Map();
  }

  humans() { return [...this.clients].filter((c) => c.connected); }

  broadcast(body) {
    return Promise.all(this.humans().map((c) => c.sendRaw(
      `:${ACRO_BOT_NICK}!${ACRO_BOT_NICK}@${ACRO_SERVER_NAME} PRIVMSG #${this.channel} :${body}`
    )));
  }

  gameName(client) { return client.username || client.nick || 'player'; }

  protocolName(recipient, playerName) {
    const player = this.humans().find((c) => this.gameName(c) === playerName);
    return player && player === recipient ? recipient.nick : playerName;
  }

  resolveTarget(recipient, target) {
    if (target === recipient.nick) return this.gameName(recipient);
    const player = this.humans().find((c) => c.nick === target);
    return player ? this.gameName(player) : target;
  }

  sendToName(name, body) {
    const client = this.humans().find((c) => this.gameName(c) === name);
    return client ? client.priv(body) : Promise.resolve(false);
  }

  addPlayer(name, score, username, only = null, exclude = null) {
    const recipients = only ? [only] : this.humans();
    return Promise.all(recipients.filter((c) => c && c !== exclude && c.connected && !c.rosterNames.has(name))
      .map(async (c) => {
        c.rosterNames.add(name);
        await c.priv(`player add ${acroQuote(name)} ${score} ${acroQuote(username)}`);
      }));
  }

  async rosterTo(newcomer, includeBots = true) {
    newcomer.rosterNames.clear();
    for (const c of this.humans()) {
      if (c !== newcomer) await this.addPlayer(this.gameName(c), c.score, c.username, newcomer);
    }
    if (includeBots) {
      for (const bot of this.botScores.keys()) {
        await this.addPlayer(bot, this.botScores.get(bot), bot, newcomer);
      }
    }
  }
}

function acroGetRoom(channel) {
  if (!acroRooms.has(channel)) acroRooms.set(channel, new AcroRoom(channel));
  return acroRooms.get(channel);
}

// ── client ───────────────────────────────────────────────────────────────────

let acroSeq = 0;
const acroClients = new Set();

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
    this.inGame = false;
    this.rosterNames = new Set();
    this.room = null;
    this.channel = null;
    this.buf = new Uint8Array(0);
    acroClients.add(this);
  }

  label() { return this.nick || `(unregistered #${this.id})`; }

  gameName() { return this.username || this.nick || 'player'; }

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
      case 'JOIN': {
        for (const channel of (rest[0] || '').replace(/^:/, '').split(',')) await this.handleJoin(channel);
        return;
      }
      case 'PART': {
        for (const channel of (rest[0] || this.channel || ACRO_LIST_CHANNEL).replace(/^:/, '').split(',')) await this.handlePart(channel);
        return;
      }
      case 'NAMES': return this.sendNames(rest[0] || this.channel || ACRO_LIST_CHANNEL);
      case 'LIST': return this.sendIrcList();
      case 'TOPIC': {
        const channel = rest[0] || this.channel || ACRO_LIST_CHANNEL;
        return this.sendRaw(`:${ACRO_SERVER_NAME} 332 ${this.nick} ${channel} :${channel}`);
      }
      case 'NOTICE': case 'AWAY': return;
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
    // Acrophobia waits for the client-count numeric and the first keepalive
    // before it sends MODE/JOIN. The standalone Python server sends both;
    // omitting them makes the client disconnect immediately after the MOTD,
    // before it can join Acro_List and receive the room list.
    await this.sendRaw(`:${s} 255 ${n} :I have 1 clients and 0 servers`);
    await this.sendRaw(`PING :${s}`);
    acroLog(`STAT: ${n} registered.`);
  }

  async handleJoin(channel) {
    const chan = channel || `#${ACRO_LIST_CHANNEL}`;
    const bare = chan.replace(/^#/, '');
    if (bare !== ACRO_LIST_CHANNEL && this.room && this.room.channel !== bare) {
      this.leaveRoom();
    }
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
      this.inGame = false;
      this.rosterNames.clear();
    }
    await this.priv('logon_now');
  }

  async sendNames(channel) {
    const bare = channel.replace(/^#/, '') || ACRO_LIST_CHANNEL;
    const names = [ACRO_BOT_NICK];
    if (bare === ACRO_LIST_CHANNEL) {
      names.push(...[...acroClients].filter((c) => c.connected && c.channel === bare).map((c) => c.nick));
    } else {
      names.push(...acroGetRoom(bare).humans().map((c) => c.nick));
    }
    await this.sendRaw(`:${ACRO_SERVER_NAME} 353 ${this.nick} = #${bare} :@${ACRO_BOT_NICK} ${[...new Set(names)].join(' ')}`);
    await this.sendRaw(`:${ACRO_SERVER_NAME} 366 ${this.nick} #${bare} :End of /NAMES list.`);
  }

  async sendIrcList() {
    await this.sendRaw(`:${ACRO_SERVER_NAME} 321 ${this.nick} Channel :Users Name`);
    for (const item of ACRO_ROOMS) {
      const room = acroGetRoom(item.channel);
      await this.sendRaw(`:${ACRO_SERVER_NAME} 322 ${this.nick} #${item.channel} ${room.humans().length} :${item.name}`);
    }
    await this.sendRaw(`:${ACRO_SERVER_NAME} 323 ${this.nick} :End of /LIST`);
  }

  async handlePart(channel) {
    await this.sendRaw(`:${this.nick}!${this.nick}@${ACRO_SERVER_NAME} PART ${channel}`);
    this.leaveRoom();
  }

  leaveRoom() {
    this.inGame = false;
    if (!this.room) return;
    const room = this.room;
    room.clients.delete(this);
    this.room = null;
    const playerName = this.gameName();
    for (const c of room.humans()) c.rosterNames.delete(playerName);
    room.broadcast(`player remove ${acroQuote(playerName)} ${this.score} ${acroQuote(this.username)}`);
    if (room.mode === 'Play' && room.humans().length > 0 && room.humans().length < ACRO_MIN_PLAYERS) {
      room.mode = 'Practice';
      room.broadcast(`chat ${acroQuote("There aren't enough players left to continue this game. Practice mode will start at the end of the round.")}`);
    }
    if (!room.humans().length) {
      room.running = false;
      room.starting = false;
      room.generation += 1;
      room.mode = 'Waiting';
      room.botScores.clear();
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
        const requestedName = args[1] || this.username || 'Player';
        const password = args[2] || '';
        const duplicate = [...acroClients].find((c) => c !== this && c.connected && c.username === requestedName);
        if (duplicate) {
          await this.priv('logon_rejected "That user is already logged in."');
          return;
        }
        const account = acroAccounts.get(requestedName);
        if (account && account.password !== password) {
          await this.priv('logon_rejected "The user name or password is incorrect."');
          return;
        }
        if (!account) {
          acroAccounts.set(requestedName, { password, score: 0 });
          acroSaveAccounts();
        }
        this.username = requestedName;
        this.score = 0;
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
        if (this.room) {
          const text = args[1] || '';
          for (const recipient of this.room.humans()) {
            if (recipient !== this) {
              await recipient.sendRaw(`:${this.gameName()}!${this.gameName()}@${ACRO_SERVER_NAME} PRIVMSG ${recipient.nick} :chat ${acroQuote(text)}`);
            }
          }
        }
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
    for (let index = 0; index < ACRO_ROOMS.length; index++) {
      const item = ACRO_ROOMS[index];
      const room = acroGetRoom(item.channel);
      const highScore = Math.max(0, ...room.humans().map((c) => c.score || 0));
      await this.priv(
        `list_item bot ${index} ${acroQuote(item.name)} 0 ${acroQuote(ACRO_SERVER_NAME)} ${ACRO_PORT} 0 ` +
        `${acroQuote(item.channel)} 0 ${acroQuote(ACRO_BOT_NICK)} ${item.clean} ${acroQuote(room.mode)} ` +
        `${room.humans().length} ${highScore} 0 0`
      );
    }
    await this.priv('end_list bot');
  }

  async findPlayer(name) {
    const wanted = String(name || '').toLowerCase();
    for (const room of acroRooms.values()) {
      for (const c of room.humans()) {
        if ((c.username || '').toLowerCase() === wanted) {
          await this.priv(
            `player_found ${acroQuote(c.username)} ${acroQuote(room.channel === ACRO_ROOM_CHANNEL ? ACRO_ROOM_NAME : room.channel.replace(/^Acro_/, ''))} 0 ` +
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
    if (this.inGame) {
      await this.priv('current_state start_game');
      return;
    }
    this.inGame = true;
    // The Win95 client appends player-add rows instead of replacing an old
    // row when a room is re-entered.  Clear the rows this connection knows
    // about before sending the current roster, otherwise bots can appear
    // twice (once at their old score and once at zero/current score).
    if (this.rosterNames.size) {
      const oldNames = [...this.rosterNames];
      for (const name of oldNames) {
        await this.priv(`player remove ${acroQuote(name)} 0 ${acroQuote(name)}`);
      }
      this.rosterNames.clear();
    }
    const alreadyRunning = room.running || room.starting;
    const humansBeforeJoin = room.humans().length;
    if (!alreadyRunning) {
      for (const c of room.humans()) c.score = 0;
      for (const bot of room.botScores.keys()) room.botScores.set(bot, 0);
    }
    // current_state carries a STATE NAME, not a number -- the transcript shows
    // "current_state start_game", which the client logs as state 10 (waiting to
    // start). Sending an integer here left it in no state at all.
    await this.priv('current_state start_game');
    await this.priv(`chat ${acroQuote(`Welcome to ${ACRO_ROOM_NAME}`)}`);
    const botsWereCreated = room.botScores.size === 0;
    if (botsWereCreated) {
      for (const bot of ACRO_BOTS.slice(0, 2)) room.botScores.set(bot, 0);
      for (const bot of room.botScores.keys()) await room.addPlayer(bot, 0, bot);
    }
    await room.addPlayer(this.gameName(), this.score, this.username, null, this);
    // Bot creation already broadcast their initial rows to this player.
    // Only late joiners need the bot rows replayed during roster sync.
    await room.rosterTo(this, !botsWereCreated);
    if (!alreadyRunning) {
      room.mode = room.humans().length >= ACRO_MIN_PLAYERS ? 'Play' : 'Practice';
    }
    if (!alreadyRunning && room.humans().length < ACRO_MIN_PLAYERS) {
      await this.priv(`chat ${acroQuote(`There must be at least ${ACRO_MIN_PLAYERS} players to start a game - You will be in Practice mode until then.`)}`);
    } else if (alreadyRunning && humansBeforeJoin < ACRO_MIN_PLAYERS && room.humans().length >= ACRO_MIN_PLAYERS && room.mode === 'Practice') {
      room.mode = 'Play';
      await room.broadcast(`chat ${acroQuote('A third player has joined - Get ready to play!')}`);
    }
    if (!room.running && !room.starting && room.humans().length > 0) {
      room.starting = true;
      acroRunRoom(room).catch((e) => console.error('[acro] room loop error:', e));
    }
  }

  async handleResponse(args) {
    const room = this.room;
    if (!room) return;
    const kind = (args[1] || '').toLowerCase();
    if (kind === 'answer') {
      // Clients may include their transport nick and round number:
      // response answer <time> <irc-nick> <round> "<acro>"
      // The nick is not the answer.  Older clients use response answer
      // <time> "<acro>", so accept both forms.
      let answerText = args[2] || '';
      if (/^\d+$/.test(args[2] || '') && args.length >= 4) {
        answerText = args[args.length - 1] || '';
      }
      const playerName = room.gameName(this);
      const answer = { acro: answerText, timeMs: parseInt(args[2], 10) || 0, client: this };
      // During the original overlapping face-off flow, the finalists are
      // already composing the next acronym while the room is technically in
      // the previous round's voting phase. Keep accepting their composition
      // answers during both phases.
      if ((room.phase === 'faceoff_comp' || room.phase === 'faceoff_vote') &&
          room.faceoffPlayers.includes(playerName)) {
        room.faceoffAnswers.set(playerName, answer);
      } else if (room.phase === 'comp' && !room.answers.has(playerName)) {
        room.answers.set(playerName, answer);
        room.answerTimes.set(playerName, answer.timeMs);
        if (!room.speedWinner) room.speedWinner = playerName;
      }
      acroLog(`STAT: ${this.username} submitted "${answerText}"`);
      await room.broadcast(`answer_received ${room.answers.size}`);
    } else if (kind === 'vote') {
      // response vote <ircname> <value>
      const voter = room.gameName(this);
      const target = room.resolveTarget(this, args[2] || '');
      if (target === voter) {
        await this.priv('chat "You cannot vote for your own answer."');
        return;
      }
      if (room.phase === 'faceoff_vote') {
        room.faceoffVotes.set(voter, { target, value: parseInt(args[3], 10) || 0 });
      } else {
        room.votes.set(voter, { target, value: parseInt(args[3], 10) || 0 });
      }
      acroLog(`STAT: ${this.username} voted for ${args[2]}`);
    } else if (kind === 'category') {
      const idx = parseInt(args[2], 10);
      room.categoryIndex = Number.isInteger(idx) ? String(idx) : '';
      if (room.phase === 'category' && idx >= 0 && idx < room.categoryChoices.length) {
        room.category = room.categoryChoices[idx];
      }
      acroLog(`STAT: category picked -> ${room.category}`);
    }
  }
}

// ── the round loop ───────────────────────────────────────────────────────────

function acroBotAnswer(acronym, botIndex) {
  return acronym.split('').map((letter) => {
    const words = ACRO_BOT_WORDS[letter] || ['Interesting'];
    return words[Math.floor(Math.random() * words.length)];
  }).join(' ');
}

function acroVotingSeconds(answerCount) {
  if (answerCount > 8) return 45;
  if (answerCount > 4) return answerCount * 5;
  return 20;
}

function acroScoreEntries(room) {
  const entries = room.humans().map((c) => [room.gameName(c), c.score]);
  for (const [name, score] of room.botScores) entries.push([name, score]);
  return entries.sort((a, b) => b[1] - a[1]);
}

function acroResolveWinner(room, entries) {
  const counts = new Map(entries.map(([name]) => [name, 0]));
  for (const vote of room.votes.values()) {
    if (counts.has(vote.target)) counts.set(vote.target, counts.get(vote.target) + 1);
  }
  let max = -1;
  for (const value of counts.values()) max = Math.max(max, value);
  const tied = entries.map(([name]) => name).filter((name) => counts.get(name) === max);
  tied.sort((a, b) => (room.answerTimes.get(a) || Infinity) - (room.answerTimes.get(b) || Infinity));
  return { winner: tied[0] || '', counts };
}

async function acroSendRoundResults(room, entries, winner, counts) {
  for (const recipient of room.humans()) {
    await recipient.priv('start_list vote_count');
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i][0];
      const token = room.protocolName(recipient, name);
      const voted = room.votes.has(name) ? 1 : 0;
      const bonus = room.votes.get(name)?.target === winner && name !== winner ? 1 : 0;
      await recipient.priv(`list_item vote_count ${i} ${acroQuote(token)} ${counts.get(name) || 0} ${voted} ${bonus}`);
    }
    await recipient.priv('end_list vote_count');
    await recipient.priv('start_list voted_for');
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i][0];
      const token = room.protocolName(recipient, name);
      const target = room.votes.get(name)?.target || '';
      await recipient.priv(`list_item voted_for ${i} ${acroQuote(token)} ${acroQuote(target)}`);
    }
    await recipient.priv('end_list voted_for');
    await recipient.priv('start_list score');
    let i = 0;
    for (const [name] of entries) {
      const token = room.protocolName(recipient, name);
      const client = room.humans().find((c) => room.gameName(c) === name);
      const score = client ? client.score : room.botScores.get(name);
      await recipient.priv(`list_item score ${i++} ${acroQuote(token)} ${score} 0`);
    }
    await recipient.priv('end_list score');
    const winnerToken = room.protocolName(recipient, winner);
    const speedToken = room.protocolName(recipient, room.speedWinner);
    await recipient.priv(`start_scores 1 ${acroQuote(winnerToken)} ${room.acronym.length} ${acroQuote(speedToken)} 2`);
  }
}

async function acroRunRoom(room) {
  room.running = true;
  const gen = ++room.generation;
  const alive = () => room.running && gen === room.generation && room.humans().length > 0;
  await room.broadcast('start_game 8250');
  await acroSleep(15000);

  while (alive()) {
    room.round += 1;
    room.phase = 'comp';
    room.answers.clear();
    room.answerTimes.clear();
    room.votes.clear();
    room.winner = '';
    room.speedWinner = '';
    const length = 3 + ((room.round - 1) % 5);
    room.acronym = randomAcronym(length);
    await room.broadcast(`start_comp_round 2500 60000 ${room.round} ${acroQuote(room.acronym)} ${acroQuote(room.category)}`);
    await acroSleep(78000);
    if (!alive()) break;

    for (let i = 0; i < 2; i++) {
      const bot = ACRO_BOTS[i];
      room.answers.set(bot, { acro: acroBotAnswer(room.acronym, i), timeMs: 30000, client: null });
      room.answerTimes.set(bot, 30000 + i * 100);
    }
    const entries = [...room.answers.entries()];
    room.phase = 'vote';
    const voteSeconds = acroVotingSeconds(entries.length);
    for (const recipient of room.humans()) {
      await recipient.priv(`start_voting_round 2500 ${voteSeconds}000 ${room.round}`);
      await recipient.priv(`start_list answer ${entries.length} 1`);
      for (let i = 0; i < entries.length; i++) {
        const token = room.protocolName(recipient, entries[i][0]);
        await recipient.priv(`list_item answer ${i} ${acroQuote(token)} ${acroQuote(entries[i][1].acro)}`);
      }
      await recipient.priv('end_list answer');
    }
    const targets = entries.map(([name]) => name);
    for (let i = 0; i < room.botScores.size; i++) {
      const bot = [...room.botScores.keys()][i];
      const choices = targets.filter((name) => name !== bot);
      room.votes.set(bot, { target: choices[i % choices.length], value: room.round });
    }
    await acroSleep((voteSeconds + 15) * 1000);
    if (!alive()) break;

    room.phase = 'results';
    const result = acroResolveWinner(room, entries);
    room.winner = result.winner;
    for (const [name] of entries) {
      const voted = room.votes.get(name)?.target || '';
      // A player who never voted earns no points for the round, including
      // the acronym-length winner bonus. This must stay inside the voted
      // branch; otherwise an unanswered vote can still score as winner.
      let points = 0;
      if (voted) {
        points = result.counts.get(name) || 0;
        if (name === result.winner) points += room.acronym.length;
        else if (voted === result.winner) points += 1;
        if (name === room.speedWinner) points += 2;
      }
      const client = room.humans().find((c) => room.gameName(c) === name);
      if (client) client.score += points;
      else room.botScores.set(name, room.botScores.get(name) + points);
    }
    await acroSendRoundResults(room, entries, result.winner, result.counts);
    await acroSleep(ACRO_RESULT_DISPLAY_MS);
    if (!alive()) break;

    if (acroScoreEntries(room).some(([, score]) => score >= ACRO_FACEOFF_SCORE)) {
      await acroRunFaceoff(room, alive);
      if (!alive()) break;
      room.round = 0;
      room.category = 'General Acrophobia';
      continue;
    }

    room.phase = 'category';
    room.categoryIndex = '';
    room.categoryChoices = [];
    while (room.categoryChoices.length < 3) {
      const category = ACRO_CATEGORIES[Math.floor(Math.random() * ACRO_CATEGORIES.length)];
      if (!room.categoryChoices.includes(category)) room.categoryChoices.push(category);
    }
    for (const recipient of room.humans()) {
      const picker = room.protocolName(recipient, room.winner);
      await recipient.priv(`start_categories 2500 10000 1 ${acroQuote(picker)}`);
      await recipient.priv('start_list category');
      for (let i = 0; i < room.categoryChoices.length; i++) await recipient.priv(`list_item category ${i} ${acroQuote(room.categoryChoices[i])}`);
      await recipient.priv('list_item category 3 "General Acrophobia"');
      await recipient.priv('end_list category');
    }
    if (room.winner && room.botScores.has(room.winner)) room.categoryIndex = String(room.round % 3);
    await acroSleep(10000);
    const selected = Number.parseInt(room.categoryIndex, 10);
    room.category = Number.isInteger(selected) && selected >= 0 && selected < 3
      ? room.categoryChoices[selected] : 'General Acrophobia';
  }
  room.running = false;
  room.starting = false;
  room.phase = 'idle';
  acroLog(`STAT: room #${room.channel} loop ended.`);
}

async function acroRunFaceoff(room, alive) {
  const ranked = acroScoreEntries(room);
  if (ranked.length < 2) return;
  room.faceoffPlayers = [ranked[0][0], ranked[1][0]];
  room.faceoffTotals = new Map(room.faceoffPlayers.map((name) => [name, 0]));
  acroLog(`STAT: FACEOFF -- ${room.faceoffPlayers[0]} vs ${room.faceoffPlayers[1]}`);
  room.phase = 'faceoff';
  await room.broadcast(`chat ${acroQuote('A face-off is about to begin!')}`);

  for (const c of room.humans()) {
    if (room.faceoffPlayers.includes(room.gameName(c))) {
      await c.priv('start_rules faceoff_player 16250');
    } else {
      const first = room.protocolName(c, room.faceoffPlayers[0]);
      const second = room.protocolName(c, room.faceoffPlayers[1]);
      await c.priv(`start_faceoff ${ACRO_LEAD_MS} 21250 0 ${acroQuote(first)} ${acroQuote(second)}`);
    }
  }
  await acroSleep(20000);

  // Match Acrobot's overlapping face-off cadence: finalists compose the next
  // acronym while the other players vote on the answers just submitted.
  let acronym = randomAcronym(3);
  room.faceoffAnswers.clear();
  room.faceoffVotes.clear();
  room.phase = 'faceoff_comp';
  for (const player of room.faceoffPlayers) {
    if (room.botScores.has(player)) {
      room.faceoffAnswers.set(player, { acro: acroBotAnswer(acronym, 1), timeMs: 30000 });
    }
  }
  for (const c of room.humans()) {
    if (room.faceoffPlayers.includes(room.gameName(c))) {
      await c.priv(`start_faceoff_comp_round ${ACRO_LEAD_MS} ${ACRO_FACEOFF_COMP_MS} 1 ${acroQuote(acronym)}`);
    } else {
      await c.priv('start_rules faceoff_voter 16250');
    }
  }
  await acroSleep(38000);

  for (let r = 1; r <= ACRO_FACEOFF_ROUNDS && alive(); r++) {
    const answers = new Map(room.faceoffAnswers);
    for (const name of room.faceoffPlayers) {
      if (!answers.has(name)) answers.set(name, { acro: 'No answer was given...', timeMs: 0 });
    }
    const voteAcronym = acronym;
    room.faceoffVotes.clear();

    if (r < ACRO_FACEOFF_ROUNDS) {
      // Start the next composition before showing this round's answers.
      acronym = randomAcronym(r + 3);
      room.faceoffAnswers.clear();
      room.phase = 'faceoff_comp';
      for (const player of room.faceoffPlayers) {
        if (room.botScores.has(player)) {
          room.faceoffAnswers.set(player, { acro: acroBotAnswer(acronym, r + 1), timeMs: 30000 });
        }
      }
      for (const c of room.humans()) {
        if (room.faceoffPlayers.includes(room.gameName(c))) {
          await c.priv(`start_faceoff_comp_round ${ACRO_LEAD_MS} ${ACRO_FACEOFF_COMP_MS} ${r + 1} ${acroQuote(acronym)}`);
        }
      }
    } else {
      for (const c of room.humans()) {
        if (room.faceoffPlayers.includes(room.gameName(c))) {
          await c.priv(`chat ${acroQuote("And that's it! The results will be revealed in just a moment.")}`);
        }
      }
    }

    // Face-off answer lists are room broadcasts; private lists are ignored by
    // some clients. Voters now receive this round's choices immediately.
    await room.broadcast('start_list answer');
    for (let i = 0; i < room.faceoffPlayers.length; i++) {
      const player = room.faceoffPlayers[i];
      await room.broadcast(`list_item answer ${i} ${acroQuote(player)} ${acroQuote(answers.get(player).acro)}`);
    }
    await room.broadcast('end_list answer');
    room.phase = 'faceoff_vote';
    for (const c of room.humans()) {
      if (!room.faceoffPlayers.includes(room.gameName(c))) {
        await c.priv(`start_faceoff_voting_round ${ACRO_LEAD_MS} ${ACRO_FACEOFF_VOTE_MS} ${r} ${acroQuote(voteAcronym)}`);
      }
    }

    // Bots vote automatically; human voters get the full vote window.
    const choices = [...room.faceoffPlayers];
    let botIndex = 0;
    for (const bot of room.botScores.keys()) {
      if (!room.faceoffPlayers.includes(bot)) {
        room.faceoffVotes.set(bot, { target: choices[botIndex % choices.length], value: r });
        botIndex += 1;
      }
    }
    await acroSleep(26000);
    if (!alive()) return;

    const counts = new Map(room.faceoffPlayers.map((name) => [name, 0]));
    for (const [, vote] of room.faceoffVotes) {
      if (counts.has(vote.target)) counts.set(vote.target, counts.get(vote.target) + 1);
    }
    for (const name of room.faceoffPlayers) {
      room.faceoffTotals.set(name, room.faceoffTotals.get(name) + counts.get(name));
    }

    await room.broadcast(`start_face_scores ${r}`);
    await room.broadcast('start_list vote_count');
    for (let i = 0; i < room.faceoffPlayers.length; i++) {
      const player = room.faceoffPlayers[i];
      await room.broadcast(`list_item vote_count ${i} ${acroQuote(player)} ${counts.get(player)}`);
    }
    await room.broadcast('end_list vote_count');
    await acroSleep(1000);
    await room.broadcast('start_list faceoff_score');
    for (let i = 0; i < room.faceoffPlayers.length; i++) {
      const player = room.faceoffPlayers[i];
      await room.broadcast(`list_item faceoff_score ${i} ${acroQuote(player)} ${room.faceoffTotals.get(player)}`);
    }
    await room.broadcast('end_list faceoff_score');
    await acroSleep(20000);
  }

  room.phase = 'faceoff_results';
  const finalWinner = [...room.faceoffTotals.entries()].sort((a, b) => b[1] - a[1])[0][0];
  await room.broadcast('start_final_scores 21250');
  await acroSleep(28000);
  await room.broadcast('start_list score');
  let i = 0;
  for (const [player] of acroScoreEntries(room)) {
    await room.broadcast(`list_item score ${i++} ${acroQuote(player)} 0 0`);
  }
  await room.broadcast('end_list score');
  await room.broadcast(`chat ${acroQuote(`${finalWinner} wins the face-off!`)}`);
  // Let the final faceoff/results screen remain visible before resetting the
  // scores and starting the next ordinary game.
  await acroSleep(28000);
  for (const c of room.humans()) c.score = 0;
  for (const bot of room.botScores.keys()) room.botScores.set(bot, 0);
  await room.broadcast('start_game 8250');
  await acroSleep(15000);
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
    acroClients.delete(client);
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
