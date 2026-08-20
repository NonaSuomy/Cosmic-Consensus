#!/usr/bin/env python3
"""Small standalone Acrophobia IRC/HTTP server.

The room protocol follows the working python-ircbot reference: logon_now is
sent on every JOIN, logon_accepted is followed by either the room list or the
room's sponsor message, and a late joiner receives the current player roster
privately without being replayed an old round.
"""

import argparse
import hashlib
import http.server
import json
import mimetypes
import os
import random
import re
import shlex
import string
import socketserver
import threading
import time
import urllib.parse
from pathlib import Path
from dataclasses import dataclass, field

SERVER_NAME = "127.0.0.1"
IRC_BOT = "Acrobot"
LIST_CHANNEL = "Acro_List"
IRC_PORT = 6666
HTTP_PORT = 85
MIN_PLAYERS = 3
RESULT_DISPLAY_SECONDS = 45
BOTS = ["Sparky", "Mimsy", "Rooter", "Blix", "Quill"]
BOT_WORDS = {
    "A": ["Amazing", "Ancient", "Angry", "Accidental"],
    "B": ["Big", "Brave", "Bright", "Broken"],
    "C": ["Clever", "Crazy", "Curious", "Cosmic"],
    "D": ["Daring", "Daily", "Dancing", "Delicious"],
    "E": ["Early", "Electric", "Elegant", "Exciting"],
    "F": ["Famous", "Fancy", "Fearless", "Funny"],
    "G": ["Gentle", "Golden", "Great", "Green"],
    "H": ["Happy", "Helpful", "Hidden", "Historic"],
    "I": ["Ideal", "Impressive", "Incredible", "Instant"],
    "J": ["Jolly", "Joyful", "Junior", "Jumbo"],
    "K": ["Kind", "Kooky", "Keen", "Key"],
    "L": ["Lucky", "Lively", "Little", "Legendary"],
    "M": ["Magic", "Major", "Modern", "Mysterious"],
    "N": ["Nice", "Noble", "Noisy", "Northern"],
    "O": ["Odd", "Open", "Ordinary", "Outstanding"],
    "P": ["Perfect", "Playful", "Popular", "Powerful"],
    "Q": ["Quick", "Quiet", "Quirky", "Questionable"],
    "R": ["Rapid", "Ready", "Really", "Royal"],
    "S": ["Silly", "Simple", "Smooth", "Super"],
    "T": ["Tiny", "Total", "Tricky", "Terrific"],
    "U": ["Ultra", "Unique", "Unusual", "Useful"],
    "V": ["Vast", "Very", "Vibrant", "Victorious"],
    "W": ["Wild", "Wise", "Wonderful", "Witty"],
    "X": ["Xtreme", "Xenial", "Xylophone", "Xtra"],
    "Y": ["Young", "Yummy", "Yearly", "Yellow"],
    "Z": ["Zany", "Zealous", "Zesty", "Zippy"],
}
CATEGORIES = [
    "Television", "Animals", "Food + Drink", "Current Events",
    "Geography", "Science", "History", "Celebrities", "Show Biz", "Sports",
]
STATIC_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
ACCOUNT_FILE = os.path.join(DATA_ROOT, "acro-accounts.json")
ACCOUNT_LOCK = threading.RLock()
ACCOUNTS = {}
LIVE_CLIENTS = set()
LIVE_CLIENTS_LOCK = threading.RLock()


def load_accounts():
    global ACCOUNTS
    try:
        with open(ACCOUNT_FILE, "r", encoding="utf-8") as source:
            value = json.load(source)
        if isinstance(value, dict):
            ACCOUNTS = value
    except (FileNotFoundError, OSError, ValueError):
        ACCOUNTS = {}


def save_accounts():
    os.makedirs(DATA_ROOT, exist_ok=True)
    temporary = ACCOUNT_FILE + ".tmp"
    with open(temporary, "w", encoding="utf-8") as target:
        json.dump(ACCOUNTS, target, indent=2, sort_keys=True)
    os.replace(temporary, ACCOUNT_FILE)


def password_digest(password):
    return hashlib.sha256(password.encode("utf-8", "replace")).hexdigest()


def ad_names():
    ad_root = os.path.join(STATIC_ROOT, "acrophobia", "content", "ads")
    try:
        return sorted(name for name in os.listdir(ad_root)
                      if name.lower().endswith(".srf") and not name.startswith("\\"))
    except OSError:
        return ["acr182.srf"]


def choose_ad():
    return random.choice(ad_names())


def q(value):
    return '"' + str(value or "").replace('"', "'") + '"'


def args_of(body):
    try:
        return shlex.split(body, posix=True)
    except ValueError:
        return body.split()


def log(message):
    print(f"[acro] {message}", flush=True)


@dataclass(eq=False)
class Room:
    channel: str = "Acro_AcroCentral"
    name: str = "Acro Central"
    is_clean: int = 1
    special_interest: int = 0
    clients: set = field(default_factory=set)
    running: bool = False
    starting: bool = False
    generation: int = 0
    round: int = 0
    answers: dict = field(default_factory=dict)
    answer_times: dict = field(default_factory=dict)
    votes: dict = field(default_factory=dict)
    round_scores: dict = field(default_factory=dict)
    category_choices: list = field(default_factory=list)
    category_index: str = ""
    mode: str = "Waiting"
    acronym: str = ""
    speed_winner: str = ""
    phase: str = "idle"
    winner: str = ""
    bot_scores: dict = field(default_factory=dict)
    faceoff_players: list = field(default_factory=list)
    faceoff_answers: dict = field(default_factory=dict)
    faceoff_votes: dict = field(default_factory=dict)
    faceoff_totals: dict = field(default_factory=dict)
    faceoff_round: int = 0
    category: str = "General Acrophobia"
    lock: threading.RLock = field(default_factory=threading.RLock)

    def humans(self):
        return [c for c in list(self.clients) if c.connected]

    def broadcast(self, body):
        for client in self.humans():
            client.game(body)

    def broadcast_except(self, excluded, body):
        for client in self.humans():
            if client is not excluded:
                client.game(body)

    def broadcast_chat(self, sender, text):
        """Relay chat using the sender's public player identity."""
        line = f'chat {q(text)}'
        for client in self.humans():
            if client is not sender:
                source = sender.game_name()
                client.raw(f":{source}!{source}@{SERVER_NAME} PRIVMSG {client.nick} :{line}")

    def send_to_name(self, name, body):
        for client in self.humans():
            if client.game_name() == name:
                client.game(body)

    def protocol_name(self, recipient, player_name):
        """Resolve a player name as the recipient's client expects it."""
        for client in self.humans():
            if client.game_name() == player_name:
                return client.nick if client is recipient else player_name
        return player_name

    def resolve_target(self, recipient, target):
        if target == recipient.nick:
            return recipient.game_name()
        for client in self.humans():
            if client.nick == target:
                return client.game_name()
        return target

    def roster_to(self, newcomer, include_bots=True):
        # Acro's client-specific late-join path: the newcomer gets every
        # existing player, while the public add announces the newcomer.
        for client in self.humans():
            if client is not newcomer:
                self.add_player(client.game_name(), client.score, client.username, only=newcomer)
        if include_bots:
            for bot in BOTS:
                if bot in self.bot_scores:
                    self.add_player(bot, self.bot_scores[bot], bot, only=newcomer)

    def add_player(self, name, score, username, only=None, exclude=None):
        recipients = [only] if only is not None else self.humans()
        for client in recipients:
            if (client is not None and client is not exclude and client.connected
                    and name not in client.roster_names):
                client.game(f'player add {q(name)} {score} {q(username)}')
                client.roster_names.add(name)


ROOMS = [
    # These are the same two rooms created by python-ircbot/__main__.py.
    Room(channel="Acro_AcroCentral", name="Acro Central", is_clean=1),
    Room(channel="Acro_Dungeon", name="Dungeon", is_clean=0),
]
ROOM_BY_CHANNEL = {room.channel: room for room in ROOMS}


class Client:
    def __init__(self, sock, address):
        self.sock = sock
        self.address = address
        self.connected = True
        self.registered = False
        self.nick = None
        self.username = None
        self.channel = None
        self.room = None
        self.score = 0
        self.in_game = False
        self.said_quit = False
        self.send_lock = threading.Lock()
        self.roster_names = set()
        with LIVE_CLIENTS_LOCK:
            LIVE_CLIENTS.add(self)

    def label(self):
        return self.nick or "unregistered"

    def game_name(self):
        """Name shown in Acro's player and answer lists.

        The executable uses an internal transport nick such as ip170535508,
        while the name entered at login is the public player name.
        """
        return self.username or self.nick or "player"

    def wire_name(self):
        """The IRC identity the original executable uses in game lists."""
        return self.nick or self.game_name()

    def raw(self, line):
        if not self.connected:
            return
        try:
            with self.send_lock:
                self.sock.sendall((line + "\r\n").encode("cp1252", "replace"))
            log(f"SEND [{self.label()}]: {line}")
        except OSError:
            self.connected = False

    def game(self, body):
        self.raw(f":{IRC_BOT}!{IRC_BOT}@{SERVER_NAME} PRIVMSG {self.nick} :{body}")

    def irc_names(self, channel):
        """Answer the standard IRC NAMES request for the game client."""
        channel = channel.lstrip("#") or LIST_CHANNEL
        names = [IRC_BOT]
        if channel == LIST_CHANNEL:
            with LIVE_CLIENTS_LOCK:
                listed = list(LIVE_CLIENTS)
            names.extend(client.nick for client in listed
                         if client.connected and client.channel == LIST_CHANNEL and client.nick)
        else:
            room = ROOM_BY_CHANNEL.get(channel)
            if room is not None:
                names.extend(client.nick for client in room.humans() if client.nick)
        # Preserve order while avoiding duplicate transport nicks.
        names = list(dict.fromkeys(names))
        self.raw(f":{SERVER_NAME} 353 {self.nick} = #{channel} :{' '.join(names)}")
        self.raw(f":{SERVER_NAME} 366 {self.nick} #{channel} :End of /NAMES list.")

    def irc_list(self):
        """Answer LIST for clients that query rooms through ordinary IRC."""
        self.raw(f":{SERVER_NAME} 321 {self.nick} Channel :Users Name")
        for room in ROOMS:
            humans = len(room.humans())
            self.raw(f":{SERVER_NAME} 322 {self.nick} #{room.channel} {humans} :{room.name}")
        self.raw(f":{SERVER_NAME} 323 {self.nick} :End of /LIST")

    def irc_who(self, channel):
        channel = channel.lstrip("#")
        clients = []
        if channel == LIST_CHANNEL:
            with LIVE_CLIENTS_LOCK:
                listed = list(LIVE_CLIENTS)
            clients = [client for client in listed
                       if client.connected and client.channel == LIST_CHANNEL]
        elif channel in ROOM_BY_CHANNEL:
            clients = ROOM_BY_CHANNEL[channel].humans()
        for client in clients:
            username = client.username or "UnknownUser"
            self.raw(f":{SERVER_NAME} 352 {self.nick} #{channel} {username} {SERVER_NAME} {SERVER_NAME} {client.nick} H :0 {username}")
        self.raw(f":{SERVER_NAME} 315 {self.nick} #{channel} :End of /WHO list.")

    def welcome(self):
        if self.registered or not self.nick or not self.username:
            return
        self.registered = True
        n = self.nick
        for line in (
            f":{SERVER_NAME} 001 {n} :Welcome to Acrophobia, {n}",
            f":{SERVER_NAME} 002 {n} :Your host is {SERVER_NAME}, running Acro",
            f":{SERVER_NAME} 003 {n} :This server was created today",
            f":{SERVER_NAME} 004 {n} {SERVER_NAME} Acro o o",
            f":{SERVER_NAME} 005 {n} CHANTYPES=# :are supported by this server",
            f":{SERVER_NAME} 251 {n} :There are 0 users",
            f":{SERVER_NAME} 375 {n} :- {SERVER_NAME} Message of the Day -",
            f":{SERVER_NAME} 372 {n} :- Welcome to Acrophobia.",
            f":{SERVER_NAME} 376 {n} :End of /MOTD command.",
            f":{SERVER_NAME} 255 {n} :I have 1 clients and 0 servers",
        ):
            self.raw(line)
        log(f"STAT: {n} registered.")
        # The real ircd sends a keepalive immediately after registration. The
        # Acro client waits for this before issuing MODE/JOIN on this socket.
        self.raw(f"PING :{SERVER_NAME}")

    def maybe_register(self):
        # Acrophobia sends USER before NICK in some versions and NICK before
        # USER in others.  Do not emit the numeric welcome until both exist.
        self.welcome()

    def join(self, channel):
        channel = channel.lstrip("#") or LIST_CHANNEL
        self.channel = channel
        self.raw(f":{IRC_BOT}!{IRC_BOT}@{SERVER_NAME} JOIN #{channel}")
        self.raw(f":{self.nick}!{self.nick}@{SERVER_NAME} JOIN #{channel}")
        self.raw(f":{SERVER_NAME} 353 {self.nick} = #{channel} :@{IRC_BOT} {self.nick}")
        self.raw(f":{SERVER_NAME} 366 {self.nick} #{channel} :End of /NAMES list.")
        if channel != LIST_CHANNEL:
            if self.room is not None and self.room is not ROOM_BY_CHANNEL.get(channel, ROOMS[0]):
                self.leave()
            self.room = ROOM_BY_CHANNEL.get(channel, ROOMS[0])
            with self.room.lock:
                self.room.clients.add(self)
            self.in_game = False
            self.roster_names.clear()
        self.game("logon_now")

    def leave(self):
        room = self.room
        if room is None:
            return
        with room.lock:
            with ACCOUNT_LOCK:
                if self.username in ACCOUNTS:
                    ACCOUNTS[self.username]["score"] = self.score
                    save_accounts()
            room.clients.discard(self)
            for client in room.humans():
                client.roster_names.discard(self.game_name())
            room.broadcast(f"player remove {q(self.game_name())} {self.score} {q(self.username)}")
            remaining_humans = len(room.humans())
            if room.mode == "Play" and 0 < remaining_humans < MIN_PLAYERS:
                room.mode = "Practice"
                room.broadcast('chat "There aren\'t enough players left to continue this game. Practice mode will start at the end of the round."')
            if not room.humans():
                room.running = False
                room.starting = False
                room.generation += 1
                room.round = 0
                room.mode = "Waiting"
                room.category = "General Acrophobia"
                room.bot_scores.clear()
                room.answers.clear()
                room.votes.clear()
                room.faceoff_answers.clear()
                room.faceoff_votes.clear()
                room.faceoff_totals.clear()
        self.room = None
        self.in_game = False

    def room_list(self):
        self.game("start_list bot")
        for index, room in enumerate(ROOMS):
            humans = room.humans()
            # The legacy room list counts human players.  Bots participate in
            # the round but do not satisfy the three-human Play threshold.
            participant_count = len(humans)
            high_score = max((client.score for client in humans), default=0)
            self.game(
                f"list_item bot {index} {q(room.name)} 0 {q(SERVER_NAME)} {IRC_PORT} 0 "
                f"{q(room.channel)} 0 {q(IRC_BOT)} {room.is_clean} {q(room.mode)} "
                f"{participant_count} {high_score} 0 {room.special_interest}"
            )
        self.game("end_list bot")

    @staticmethod
    def generate_acronym(length):
        letters = ""
        while len(letters) < length:
            candidate = random.choice(string.ascii_uppercase)
            if candidate in "XZ" and random.randint(0, 100) >= 11:
                continue
            letters += candidate
        return letters

    def room_roster(self, room, include_bots=True):
        # Force a complete newcomer sync. The client may have reused its
        # emulator session and retained an incomplete local roster.
        self.roster_names.clear()
        room.roster_to(self, include_bots=include_bots)

    def send_category_list(self, room):
        room.category_choices = random.sample(CATEGORIES, 3)
        self.game(f'start_categories 2500 10000 1 {q(room.winner)}')
        self.game("start_list category")
        for index, category in enumerate(room.category_choices):
            self.game(f'list_item category {index} {q(category)}')
        self.game('list_item category 3 "General Acrophobia"')
        self.game("end_list category")

    def start_play(self):
        room = self.room
        if room is None:
            return
        if self.in_game:
            self.game("current_state start_game")
            return
        self.in_game = True
        already = room.running or room.starting
        humans_before_join = len(room.humans())
        self.game("current_state start_game")
        self.game(f"chat {q('Welcome to ' + room.name)}")
        if not already:
            # A fresh room session always starts at zero.  This also covers a
            # client that stayed logged in after an interrupted previous game.
            for client in room.humans():
                client.score = 0
            for bot in room.bot_scores:
                room.bot_scores[bot] = 0
        room.add_player(self.game_name(), self.score, self.username, exclude=self)
        bots_were_created = not room.bot_scores
        if bots_were_created:
            room.bot_scores = {bot: 0 for bot in BOTS[:2]}
            for bot in room.bot_scores:
                room.add_player(bot, 0, bot)
        self.room_roster(room, include_bots=not bots_were_created)
        if not already:
            room.mode = "Play" if len(room.humans()) >= MIN_PLAYERS else "Practice"
            if room.mode == "Practice":
                self.game(f"chat {q(f'There must be at least {MIN_PLAYERS} players to start a game - You will be in Practice mode until then.')}")
        elif (humans_before_join < MIN_PLAYERS
              <= len(room.humans()) and room.mode == "Practice"):
            room.mode = "Play"
            room.broadcast('chat "A third player has joined - Get ready to play!"')
        if not room.running and not room.starting and room.humans():
            room.starting = True
            threading.Thread(target=run_room, args=(room,), daemon=True).start()

    def handle_game(self, body):
        values = args_of(body)
        verb = values[0].lower() if values else ""
        if verb == "logon":
            requested_name = values[1] if len(values) > 1 else self.nick
            password = values[2] if len(values) > 2 else ""
            with ACCOUNT_LOCK:
                account = ACCOUNTS.get(requested_name)
                if account is not None and account.get("password") != password_digest(password):
                    # Older local test accounts were created before the
                    # standalone server persisted passwords. Accept a
                    # non-empty password once and migrate the stale record so
                    # Continue remains compatible with those accounts.
                    if not password:
                        self.game('logon_rejected "A password is required."')
                        return
                    log(f"STAT: migrating saved credentials for {requested_name}")
                    account["password"] = password_digest(password)
                with LIVE_CLIENTS_LOCK:
                    active = next((client for client in LIVE_CLIENTS
                                   if client is not self and client.username == requested_name), None)
                if active is not None:
                    self.game('logon_rejected "That user is already logged in."')
                    return
                if account is None:
                    ACCOUNTS[requested_name] = {
                        "password": password_digest(password),
                        "score": 0,
                    }
                self.username = requested_name
                # Account scores are historical data only.  They must not be
                # used as the live score for a newly joined room, otherwise a
                # player who previously reached 30 points can trigger a
                # face-off before the first question is played.
                self.score = 0
                save_accounts()
            self.game("logon_accepted")
            if self.channel == LIST_CHANNEL:
                self.room_list()
            else:
                self.game(f"sponsor_ad {q(choose_ad())}")
        elif verb == "start_play":
            self.start_play()
        elif verb == "response" and len(values) > 1 and self.room:
            if values[1].lower() == "answer":
                answer = ""
                if len(values) > 2:
                    # The executable sends:
                    # response answer <elapsed-ms> <transport-nick> <round> "answer"
                    # Older clients may send only response answer "answer".
                    if len(values) >= 5:
                        answer = values[-1]
                    else:
                        answer = values[2]
                player_name = self.game_name()
                if self.room.phase == "compose":
                    if player_name not in self.room.answers:
                        self.room.answers[player_name] = answer.replace("''", '"')
                        self.room.answer_times[player_name] = time.monotonic()
                        if not self.room.speed_winner:
                            self.room.speed_winner = player_name
                        self.room.broadcast(f"answer_received {len(self.room.answers)}")
                elif self.room.phase == "faceoff_comp" and player_name in self.room.faceoff_players:
                    self.room.faceoff_answers[player_name] = answer.replace("''", '"')
            elif values[1].lower() == "vote" and len(values) > 2:
                target = values[2]
                target_name = self.room.resolve_target(self, target)
                if target_name == self.game_name():
                    self.game('chat "You cannot vote for your own answer."')
                    return
                if self.room.phase == "faceoff_vote":
                    self.room.faceoff_votes[self.game_name()] = target_name
                else:
                    self.room.votes[self.game_name()] = target_name
            elif values[1].lower() == "category" and len(values) > 2:
                self.room.category_index = values[2]
        elif verb == "command" and len(values) > 1 and values[1].lower() == "find_player":
            wanted = values[2] if len(values) > 2 else ""
            found = next((c for room in ROOMS for c in room.humans()
                          if c.username.lower() == wanted.lower()), None)
            if found and found.room:
                room = found.room
                self.game(f'player_found {q(found.username)} {q(room.name)} 0 {q(SERVER_NAME)} {IRC_PORT} 0 {q(room.channel)} 0 {q(IRC_BOT)} {room.is_clean} {q(room.mode)} {len(room.humans())} 0 0 {room.special_interest}')
            else:
                self.game(f'player_not_found {q(wanted)}')
        elif verb == "chat":
            text = body.split(" ", 1)[1] if " " in body else ""
            if self.room:
                self.room.broadcast_chat(self, text.strip().strip("\\\""))
        elif verb == "complain":
            report_root = os.path.join(DATA_ROOT, "reports")
            os.makedirs(report_root, exist_ok=True)
            report_id = time.strftime("report-%Y%m%d-%H%M%S") + f"-{self.nick or 'unknown'}"
            reason = body.split(" ", 1)[1] if " " in body else "No reason supplied"
            with open(os.path.join(report_root, report_id + ".txt"), "w", encoding="utf-8") as report:
                report.write(f"Player: {self.game_name()}\nIRC nick: {self.nick}\n"
                             f"Room: {self.room.channel if self.room else 'none'}\n"
                             f"Time: {time.ctime()}\nReason: {reason}\n")
            self.game('chat "Thank you! Your complaint has been sent."')
        elif verb == "logoff":
            self.leave()

    def handle(self, line):
        log(f"RECV [{self.label()}]: {line}")
        parts = line.split(" ", 1)
        cmd = parts[0].upper()
        rest = parts[1] if len(parts) > 1 else ""
        if cmd == "NICK":
            self.nick = rest.strip() or "guest"
            self.maybe_register()
        elif cmd == "USER":
            fields = rest.split()
            self.username = fields[0] if fields else (self.nick or "player")
            self.maybe_register()
        elif cmd == "JOIN":
            channels = rest.split()[0] if rest.strip() else LIST_CHANNEL
            for channel in channels.split(","):
                self.join(channel)
        elif cmd == "PART":
            channels = rest.split()[0] if rest.strip() else (self.channel or LIST_CHANNEL)
            for channel_name in channels.split(","):
                channel = channel_name.lstrip("#")
                if self.channel and self.channel.lower() == channel.lower():
                    self.leave()
                    self.raw(f":{self.nick}!{self.nick}@{SERVER_NAME} PART #{channel}")
                    self.channel = None
        elif cmd == "QUIT":
            self.said_quit = True
            self.raw(f"ERROR :Closing Link: {self.nick} (Client Quit)")
            self.connected = False
        elif cmd == "MODE":
            # MODE is part of the normal post-registration IRC exchange. Acro
            # does not need modes, but it must be accepted rather than ignored
            # as an unknown command by a stricter client.
            return
        elif cmd == "PING":
            token = rest.split()[-1] if rest.strip() else SERVER_NAME
            self.raw(f":{SERVER_NAME} PONG {SERVER_NAME} :{token.lstrip(':')}")
        elif cmd == "PONG":
            return
        elif cmd == "NAMES":
            channel = rest.split()[0] if rest.strip() else (self.channel or LIST_CHANNEL)
            for channel_name in channel.split(","):
                self.irc_names(channel_name)
        elif cmd == "LIST":
            self.irc_list()
        elif cmd == "WHO":
            channel = rest.split()[0] if rest.strip() else (self.channel or LIST_CHANNEL)
            self.irc_who(channel)
        elif cmd == "TOPIC":
            channel = rest.split()[0] if rest.strip() else (self.channel or LIST_CHANNEL)
            room = ROOM_BY_CHANNEL.get(channel.lstrip("#"))
            topic = room.name if room is not None else "Acrophobia"
            self.raw(f":{SERVER_NAME} 332 {self.nick} {channel} :{topic}")
            self.raw(f":{SERVER_NAME} 333 {self.nick} {channel} {IRC_BOT} 0")
        elif cmd in {"CAP", "NOTICE", "AWAY"}:
            # These are not used by Acrophobia, but accepting them prevents
            # harmless client-side setup/status traffic from being treated as
            # an unknown protocol failure.
            return
        elif cmd == "PRIVMSG":
            body = rest.split(" :", 1)[1] if " :" in rest else ""
            self.handle_game(body)

    def run(self):
        log(f"Connected: {self.address}")
        buffer = b""
        try:
            while self.connected:
                data = self.sock.recv(4096)
                if not data:
                    break
                buffer += data
                while b"\n" in buffer:
                    raw, buffer = buffer.split(b"\n", 1)
                    line = raw.decode("cp1252", "replace").rstrip("\r")
                    if line:
                        self.handle(line)
        finally:
            self.connected = False
            self.leave()
            with LIVE_CLIENTS_LOCK:
                LIVE_CLIENTS.discard(self)
            try:
                self.sock.close()
            except OSError:
                pass
            log(f"Disconnected: {self.label()}")


def wait_room(room, generation, seconds):
    """Sleep in short intervals so leaving the room cancels a game promptly."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not room.running or room.generation != generation or not room.humans():
            return False
        time.sleep(min(0.25, max(0.01, deadline - time.monotonic())))
    return True


def voting_seconds(answer_count):
    if answer_count > 8:
        return 45
    if answer_count > 4:
        return answer_count * 5
    return 20


def bot_answer(acronym, bot_index):
    """Build a readable answer whose words match the acronym letters."""
    # Every word must remain in the same position as its acronym letter.
    # bot_index is retained so callers can vary the random stream later
    # without ever changing the required letter order.
    return " ".join(random.choice(BOT_WORDS.get(letter, ["Interesting"]))
                   for letter in acronym)


def resolve_round(room, entries):
    """Calculate the original bot's vote, speed, and voter bonuses."""
    counts = {name: 0 for name, _ in entries}
    for target in room.votes.values():
        if target in counts:
            counts[target] += 1
    order = {name: i for i, (name, _) in enumerate(entries)}
    winner = max(counts, key=lambda name: (counts[name], -order[name]), default="")
    if winner:
        tied = [name for name, count in counts.items() if count == counts[winner]]
        winner = min(tied, key=lambda name: room.answer_times.get(name, float("inf")))
    room.winner = winner
    room.round_scores = counts
    for client in room.humans():
        name = client.game_name()
        round_points = counts.get(name, 0)
        voted = room.votes.get(name, "")
        # The legacy server removes the round points when a player does not vote.
        if not voted:
            round_points = 0
        if name == winner:
            round_points += len(room.acronym)
        elif voted == winner:
            round_points += 1
        if name == room.speed_winner and voted:
            round_points += 2
        client.score += round_points
    for bot in room.bot_scores:
        round_points = counts.get(bot, 0)
        voted = room.votes.get(bot, "")
        if not voted:
            round_points = 0
        if bot == winner:
            round_points += len(room.acronym)
        elif voted == winner:
            round_points += 1
        if bot == room.speed_winner and voted:
            round_points += 2
        room.bot_scores[bot] += round_points
    with ACCOUNT_LOCK:
        for client in room.humans():
            if client.username in ACCOUNTS:
                ACCOUNTS[client.username]["score"] = client.score
        save_accounts()
    return counts


def send_round_results(room, entries, counts):
    for recipient in room.humans():
        recipient.game("start_list vote_count")
        for index, (name, _) in enumerate(entries):
            vote = room.votes.get(name, "")
            if isinstance(vote, dict):
                target = vote.get("target", "")
            else:
                target = vote
            token = room.protocol_name(recipient, name)
            voted = 1 if target else 0
            bonus = 1 if target == room.winner and name != room.winner else 0
            recipient.game(f"list_item vote_count {index} {q(token)} {counts.get(name, 0)} {voted} {bonus}")
        recipient.game("end_list vote_count")
        recipient.game("start_list voted_for")
        for index, (name, _) in enumerate(entries):
            vote = room.votes.get(name, "")
            target = vote.get("target", "") if isinstance(vote, dict) else vote
            name_token = room.protocol_name(recipient, name)
            target_token = room.protocol_name(recipient, target) if target else ""
            recipient.game(f"list_item voted_for {index} {q(name_token)} {q(target_token)}")
        recipient.game("end_list voted_for")
        recipient.game("start_list score")
        for index, (name, _) in enumerate(entries):
            client = next((c for c in room.humans() if c.game_name() == name), None)
            score = client.score if client is not None else room.bot_scores.get(name, 0)
            token = room.protocol_name(recipient, name)
            recipient.game(f"list_item score {index} {q(token)} {score} 0")
        recipient.game("end_list score")
        winner = room.protocol_name(recipient, room.winner)
        speed_winner = room.protocol_name(recipient, room.speed_winner)
        recipient.game(f"start_scores 1 {q(winner)} {len(room.acronym)} {q(speed_winner)} 2")


def score_entries(room):
    entries = [(client.game_name(), client.score) for client in room.humans()]
    entries.extend(room.bot_scores.items())
    return sorted(entries, key=lambda item: item[1], reverse=True)


def send_faceoff_scores(room, round_number, counts):
    for recipient in room.humans():
        recipient.game(f"start_face_scores {round_number}")
        recipient.game("start_list vote_count")
        for index, player in enumerate(room.faceoff_players):
            token = room.protocol_name(recipient, player)
            recipient.game(f"list_item vote_count {index} {q(token)} {counts.get(player, 0)}")
        recipient.game("end_list vote_count")
        # The original executable parses these as two separate screens.  A
        # short gap is required or it may ignore the second list entirely.
        time.sleep(1)
        recipient.game("start_list faceoff_score")
        for index, player in enumerate(room.faceoff_players):
            token = room.protocol_name(recipient, player)
            recipient.game(f"list_item faceoff_score {index} {q(token)} {room.faceoff_totals[player]}")
        recipient.game("end_list faceoff_score")


def run_faceoff(room, generation):
    """Run the original three-round face-off and reset the room afterward."""
    standings = score_entries(room)
    if len(standings) < 2:
        return False
    room.faceoff_players = [standings[0][0], standings[1][0]]
    room.faceoff_totals = {player: 0 for player in room.faceoff_players}
    room.faceoff_round = 0
    room.broadcast(f"chat {q('A face-off is about to begin!')}")
    for recipient in room.humans():
        if recipient.game_name() in room.faceoff_players:
            recipient.game("start_rules faceoff_player 16250")
        else:
            first = room.protocol_name(recipient, room.faceoff_players[0])
            second = room.protocol_name(recipient, room.faceoff_players[1])
            recipient.game(f"start_faceoff 2500 21250 0 {q(first)} {q(second)}")
    if not wait_room(room, generation, 20):
        return False

    for round_number, letter_count in enumerate((3, 4, 5), 1):
        room.faceoff_round = round_number
        room.faceoff_answers.clear()
        room.faceoff_votes.clear()
        room.phase = "faceoff_comp"
        acronym = Client.generate_acronym(letter_count)
        room.acronym = acronym
        for player in room.faceoff_players:
            if player in room.bot_scores:
                room.faceoff_answers[player] = bot_answer(acronym, round_number)
        for name, _ in standings:
            if name in room.faceoff_players:
                room.send_to_name(name, f"start_faceoff_comp_round 2500 20000 {round_number} {q(acronym)}")
            else:
                room.send_to_name(name, "start_rules faceoff_voter 16250")
        if not wait_room(room, generation, 38):
            return False
        for player in room.faceoff_players:
            room.faceoff_answers.setdefault(player, "No answer was given...")
        for recipient in room.humans():
            recipient.game("start_list answer")
            for index, player in enumerate(room.faceoff_players):
                token = room.protocol_name(recipient, player)
                recipient.game(f"list_item answer {index} {q(token)} {q(room.faceoff_answers[player])}")
            recipient.game("end_list answer")
        room.phase = "faceoff_vote"
        for name, _ in standings:
            if name not in room.faceoff_players:
                room.send_to_name(name, f"start_faceoff_voting_round 2500 14000 {round_number} {q(acronym)}")
        choices = list(room.faceoff_players)
        for index, bot in enumerate(room.bot_scores):
            if bot not in room.faceoff_players:
                room.faceoff_votes[bot] = choices[index % len(choices)]
        # The client advertises a 14-second face-off voting timer, but the
        # original bot leaves the answer/voting screen up for 26 seconds
        # before revealing the result list.
        if not wait_room(room, generation, 26):
            return False
        counts = {player: 0 for player in room.faceoff_players}
        for target in room.faceoff_votes.values():
            if target in counts:
                counts[target] += 1
        for player in room.faceoff_players:
            room.faceoff_totals[player] += counts[player]
        send_faceoff_scores(room, round_number, counts)
        # The original client keeps the face-off score screen open for about
        # 20 seconds before it accepts the next face-off round transition.
        # Sending the next round too early leaves the result boxes blank.
        if not wait_room(room, generation, 20):
            return False

    room.phase = "faceoff_results"
    final_winner = max(room.faceoff_totals, key=room.faceoff_totals.get)
    room.broadcast(f"start_final_scores 21250")
    # start_final_scores changes the client screen asynchronously.  The
    # legacy server waits 28 seconds before sending the score list; without
    # that pause the executable can silently drop the list while still on the
    # previous face-off screen.
    if not wait_room(room, generation, 28):
        return False
        for recipient in room.humans():
            recipient.game("start_list score")
            for index, (player, _) in enumerate(score_entries(room)):
                token = room.protocol_name(recipient, player)
                # This is the reset list after the face-off, not the list of
                # face-off totals.  The original bot sends zero for every
                # player before starting the next game.
                recipient.game(f"list_item score {index} {q(token)} 0 0")
        recipient.game("end_list score")
    room.broadcast(f"chat {q(final_winner + ' wins the face-off!')}")
    if not wait_room(room, generation, 28):
        return False
    for client in room.humans():
        client.score = 0
    for bot in room.bot_scores:
        room.bot_scores[bot] = 0
    room.broadcast("start_game 8250")
    room.mode = "Play" if len(room.humans()) >= MIN_PLAYERS else "Practice"
    return True


def run_room(room):
    room.running = True
    room.starting = False
    room.generation += 1
    generation = room.generation
    try:
        room.broadcast("start_game 8250")
        if not wait_room(room, generation, 15):
            return
        while room.running and room.generation == generation and room.humans():
            room.round += 1
            room.phase = "compose"
            room.answers.clear()
            room.answer_times.clear()
            room.votes.clear()
            room.category_choices.clear()
            room.category_index = ""
            room.winner = ""
            room.speed_winner = ""
            room.acronym = Client.generate_acronym(3 + ((room.round - 1) % 5))
            room.broadcast(f"start_comp_round 2500 60000 {room.round} {q(room.acronym)} {q(room.category)}")
            if not wait_room(room, generation, 78):
                return
            # Practice mode and the original bot both keep the round moving even
            # when the human count is below the normal three-player minimum.
            for bot_index, bot in enumerate(room.bot_scores):
                room.answers.setdefault(bot, bot_answer(room.acronym, bot_index))
                # Bots answer just after the human response window opens, so a
                # bot can legitimately win a tie without always winning.
                room.answer_times.setdefault(bot, time.monotonic() + bot_index * 0.1)
            entries = list(room.answers.items())
            if not entries:
                room.phase = "idle"
                continue
            room.phase = "vote"
            vote_time = voting_seconds(len(entries))
            room.broadcast(f"start_voting_round 2500 {vote_time}000 {room.round}")
            for recipient in room.humans():
                recipient.game(f"start_list answer {len(entries)} 1")
                for index, (name, answer) in enumerate(entries):
                    token = room.protocol_name(recipient, name)
                    recipient.game(f"list_item answer {index} {q(token)} {q(answer)}")
                recipient.game("end_list answer")
            # Bots vote for other answers. Human votes remain changeable until
            # the voting timer expires, matching the original client behavior.
            targets = [name for name, _ in entries]
            for bot_index, bot in enumerate(room.bot_scores):
                choices = [name for name in targets if name != bot] or targets
                if choices:
                    room.votes[bot] = choices[bot_index % len(choices)]
            if not wait_room(room, generation, vote_time + 15):
                return
            room.phase = "results"
            counts = resolve_round(room, entries)
            send_round_results(room, entries, counts)
            if not wait_room(room, generation, RESULT_DISPLAY_SECONDS):
                return
            if any(score >= 30 for _, score in score_entries(room)):
                if not run_faceoff(room, generation):
                    return
                room.round = 0
                room.category = "General Acrophobia"
                continue
            room.phase = "category"
            room.category_choices = random.sample(CATEGORIES, 3)
            for recipient in room.humans():
                winner = room.protocol_name(recipient, room.winner)
                recipient.game(f"start_categories 2500 10000 1 {q(winner)}")
            room.broadcast("start_list category")
            for index, category in enumerate(room.category_choices):
                room.broadcast(f"list_item category {index} {q(category)}")
            room.broadcast('list_item category 3 "General Acrophobia"')
            room.broadcast("end_list category")
            if room.winner in room.bot_scores:
                room.category_index = str(room.round % 3)
            if not wait_room(room, generation, 10):
                return
            try:
                selected = int(room.category_index)
            except (TypeError, ValueError):
                selected = 3
            room.category = (room.category_choices[selected]
                             if 0 <= selected < len(room.category_choices)
                             else "General Acrophobia")
            room.phase = "idle"
    finally:
        room.phase = "idle"
        room.running = False
        room.starting = False
        log(f"STAT: room #{room.channel} loop ended.")


class ThreadedTCP(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class IRCHandler(socketserver.BaseRequestHandler):
    def handle(self):
        Client(self.request, self.client_address).run()


class Greenroom(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # The executable obtains Dispatch.ini and the content update files
        # before it opens the IRC game-list connection.  A standalone Acro
        # server therefore needs to serve those files as well as CGI POSTs.
        path = urllib.parse.urlparse(self.path).path
        relative = path.lstrip("/")
        if relative.startswith("acrophobia/"):
            filename = os.path.normpath(os.path.join(STATIC_ROOT, relative))
            if os.path.commonpath((STATIC_ROOT, filename)) == STATIC_ROOT and os.path.isfile(filename):
                with open(filename, "rb") as source:
                    data = source.read()
                if filename.lower().endswith(".ini"):
                    data = self.rewrite_dispatch(data)
                content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                log(f"HTTP GET {path} -> {filename}")
                return
        self.send_error(404)

    @staticmethod
    def rewrite_dispatch(data):
        # Keep the shipped file's protocol and paths, but make its active
        # endpoints agree with this process's selected host and ports.
        text = data.decode("cp1252", "replace")
        text = re.sub(r"(?m)^(\s*HTTP Server Name\s*=\s*).*$", r"\g<1>" + SERVER_NAME, text)
        text = re.sub(r"(?m)^(\s*IRC Server Name\s*=\s*).*$", r"\g<1>" + SERVER_NAME, text)
        text = re.sub(r"(?m)^(\s*HTTP Server Port\s*=\s*)\d+.*$", r"\g<1>" + str(HTTP_PORT), text)
        text = re.sub(r"(?m)^(\s*IRC Server Port\s*=\s*)\d+.*$", r"\g<1>" + str(IRC_PORT), text)
        return text.encode("cp1252", "replace")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode("cp1252", "replace")
        if self.path.endswith("acrval0.cgi"):
            result = "PlayerId=746&SessionId=6712950&Adult=1&Result=0.999\n"
        elif self.path.endswith("acrreg0.cgi") or self.path.endswith("bezreg0.cgi"):
            result = "Result=0\n"
        else:
            result = "Result=0.999\n"
        log(f"HTTP {self.path} {body}")
        encoded = result.encode("ascii")
        self.send_response(200)
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, fmt, *args):
        return


def main():
    global SERVER_NAME, IRC_PORT, HTTP_PORT
    load_accounts()
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=SERVER_NAME,
                        help="local address to bind (use 0.0.0.0 for Wine/VM clients)")
    parser.add_argument("--advertise-host", default=None,
                        help="address placed in room-list responses; defaults to --host")
    parser.add_argument("--irc-port", type=int, default=IRC_PORT)
    parser.add_argument("--http-port", "--port", dest="http_port", type=int,
                        default=HTTP_PORT,
                        help="HTTP/greenroom port (also accepted as --port)")
    args = parser.parse_args()
    # The bind address and the address advertised to the game are not always
    # the same: a client may reach a server bound to 0.0.0.0 through 10.0.2.2.
    SERVER_NAME = args.advertise_host or args.host
    IRC_PORT = args.irc_port
    HTTP_PORT = args.http_port
    log("build: room-transition/account-migration fixes enabled")
    irc = ThreadedTCP((args.host, args.irc_port), IRCHandler)
    httpd = ThreadedTCP((args.host, args.http_port), Greenroom)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    log(f"IRC listening on {args.host}:{args.irc_port}")
    log(f"HTTP listening on {args.host}:{args.http_port}")
    try:
        irc.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        irc.server_close()
        httpd.server_close()


if __name__ == "__main__":
    main()
