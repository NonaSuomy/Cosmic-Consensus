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
// ── where the wire format comes from ─────────────────────────────────────────
//
// Everything in the PROTOCOL table below was read out of GetThePicture.exe,
// not guessed. The engine serialises each message through an xTokenizer, and
// every message class has a matching pair of stream operators:
//
//     operator>>(xTokenizer&, T&)   parses an inbound line
//     operator<<(xTokenizer&, T&)   formats an outbound one
//
// The reader always opens with a token check and then calls one primitive
// reader per field, in wire order, so the field list of any message is just
// the call sequence of its reader. The primitives are (VAs in the .exe):
//
//     0x4ad1e7  token   -- verify the literal type token, else throw
//     0x4acfae  short   sscanf "%hd"
//     0x4acff5  int     sscanf "%i"
//     0x4ad03c  ulong   sscanf "%u"
//     0x4ad083  ushort  sscanf "%u"
//     0x4ad0ca  char    sscanf "%c"
//     0x4ad111  bool    sscanf "%i", then accepts ONLY 1 (true) or -1 (false)
//     0x4ad183  string  one whitespace-delimited token
//
// Every one of them throws a C++ exception (_CxxThrowException at 0x4e87f0)
// when the field is missing or unparsable, and nothing on the message-dispatch
// path catches it. That is the whole story behind "any RI kills the client":
// a malformed room record does not get ignored, it terminates the process.
//
// ── the bug this file used to have ───────────────────────────────────────────
//
// The old RI carried Cosmic's room record. Cosmic's is:
//
//     BIR <int> <int> <int> R <name> <host> <port> <chan> <bot> <int> <bool> <int>
//                                                              (0x445226 in
//                                                               CosmicConsensus.exe)
//
// GTP's is NOT that. PictureRoom's reader (0x44a25d) is int, int, bool, bool
// and only THEN chains into the shared Room reader (0x4b0bf7):
//
//     PR <int> <int> <bool> <bool> R <name> <host> <port> <chan> <mode> <int> <bool> <int>
//
// So every previous attempt ran off the end of the line at the fourth field and
// threw. "PR 0 0 1 R Get_The_Picture ..." fed the literal "R" to the bool
// reader, which accepts only 1 and -1; "RI 0 PR" ran out of tokens on the very
// first int. Both are the same crash, which is why swapping the type token or
// reordering the trailing fields never changed anything -- the fault was three
// fields earlier than anyone was looking.
//
// ── what the room record fields mean ─────────────────────────────────────────
//
// Recovered from ChooseRoomScreen::AddRoom (0x405349), ::UpdateRoom (0x405534)
// and ::IsRoomJoinable (0x405afd):
//
//   PR.round      0x54  list column 3 ("Round")
//   PR.highScore  0x58  list column 4 ("HighScore")
//   PR.tab        0x5c  which of the screen's two list controls the row goes
//                       in -- and only one of them is on screen, so this being
//                       wrong empties the list silently. See GTP_ROOM_TAB
//   PR.noAutoPick 0x5d  passed to AddRow, and excludes the room from "Choose
//                       For Me" (0x405be3)
//   R.name        0x04  list column 1 ("Room")
//   R.host        0x14  IRC host the client dials for the room
//   R.port        0x24  IRC port
//   R.channel     0x28  IRC channel the client JOINs for the room
//   R.mode        0x38  list column 5 ("Mode"). Rendered by 0x44a0f7, which
//                       maps "dead"/"unknown" to the literal "Dead"
//   R.players     0x48  list column 2 ("#Players")
//   R.hidden      0x4c  TRUE hides the row unless the screen is in show-all
//                       mode -- so this must be -1
//   R.capacity    0x50  IsRoomJoinable is exactly `players < capacity` AND
//                       mode not in {full, listing rooms, dead, unknown}
//
// The last one matters: Cosmic writes 0 in the capacity slot, and 0 players <
// 0 capacity is false, so a Cosmic-shaped record would have listed a room the
// client refused to enter. GTP_ROOM_CAPACITY exists for that reason.
//
// ── quoting ──────────────────────────────────────────────────────────────────
//
// The tokenizer (0x4ad902) splits on plain spaces. A token containing spaces
// is wrapped in \x02 (STX), not quotes, and a doubled \x02 is a literal one.
// The buffer is 0x201 bytes with room for 256 tokens, so lines must stay under
// ~512 characters. Anything with a space in it goes through gtpQuote().

// ── the game, from the published rules ───────────────────────────────────────
//
// Berkeley Systems' own "How to Play" page, mapped onto the tokens above. This
// is the shape a segment engine has to produce; none of it is implemented yet.
//
//   7 rounds. Rounds 1-6 are identical; round 7 is the Final Round.
//
//   Composition   45 s, caption up to 160 characters      SC  -> client sends C
//                 Final Round is one of four variants, chosen at random:
//                   Copyfits    caption must use supplied words  <- SC's three
//                   Billboreds  advertising slogan                  strings?
//                   Tabheads    tabloid headline
//                   Slimericks  two rhyming lines, 80 chars each, 60 s not 45
//   Voting        >= 10 s, scaled by how many captions arrived
//                 cannot vote for your own; no vote = no points that round
//                                                        SV  -> client sends V
//                 captions are anonymous until voting ends   CLB/CLI/CLE
//   Scoring       rounds 1-3: 1 point per vote             SS, RLB/RLI/RLE
//                 rounds 4-6: 2 points per vote
//                 round 7:    3 points per vote
//                 ties broken by who submitted first
//   Round winner  goes to Fat Chance                       SRW
//   Fat Chance    6 s to pick one spinning swatch;         SFCS -> client FCS
//                 some swatches SUBTRACT points            SFCR
//   Game winner   most points after round 7                SGW
//
// The 160-character cap matters here: the tokenizer buffer is 512 bytes total
// (0x4ad902), so a 160-char caption plus its wrapper is comfortable, but two
// 80-char Slimerick lines plus quoting is worth watching.
//
// Chat commands, from the same page, and the token each produces. Confirmed
// live: /p and /n arrive as HC, and typed text as PUC.
//
//   /vote N, /v N     vote for a caption          V
//   /f                pick a Fat Chance swatch    FCS
//   /msg <user>       private message             PRC
//   /me <action>      action message              MC
//   /complain <user>  complain; a majority bans   CP
//                     the target for up to 4 h
//   /ignore <user>    client-side only, no traffic expected
//   /hide             toggle findability, i.e. affects FP/PF/PNF
//   /stat, /help, /?, /save, /log   client-side or unmapped
//
// The rules also name the room bot "Picsbot" ("A chat message from Picsbot
// will let you know..."). That is not in the binary -- it comes from
// dispatch.ini's IRC Bot Nickname, so it is ours to choose. Ours is ListNick,
// which is what the shipped dispatch.ini says; renaming means changing both
// together for the LOBBY channel, because the lobby proxy is constructed with
// that nick rather than learning it from LN.

// ── verified message catalogue ───────────────────────────────────────────────
//
// Each entry is the field list of the message's reader, in wire order.
// "<X>" is a primitive; a bare name is a nested record whose own type token is
// written inline (Room, Player, Segment, Ad, Pic and friends serialise their
// token as part of the parent's line). Class names come from the binary's RTTI.
const GTP_PROTOCOL = {
  // ── lobby / session ────────────────────────────────────────────────────────
  LN:     { cls: 'LogonNowRoomMsg',            fields: '<ushort>' },
  L:      { cls: 'LogonRoomMsg',               fields: '<str> <ushort> Version <int> <int> <int> <int> <ushort> <ushort> <int>' },
  LA:     { cls: 'LogonAcceptedRoomMsg',       fields: '<str> Version <int> <int> <int> <int> <ulong>' },
  LO:     { cls: 'LogoffRoomMsg',              fields: '<bool>' },
  LOA:    { cls: 'LogoffAcceptedRoomMsg',      fields: '' },
  LER:    { cls: 'LostRoomBotErrorMsg',        fields: '<str>' },
  GP:     { cls: 'GoPublicRoomMsg',            fields: '' },
  ST:     { cls: 'SegmentRoomMsg (time sync)', fields: 'Segment' },
  RS:     { cls: 'RequestSyncRoomMsg',         fields: '<ulong> <ulong>' },
  // LSR/LSA are the room player-list resynchronization exchange.  A client may
  // send LSR after joining or when its roster control is stale; answer it with
  // LSA before sending PLI rows.
  LSR:    { cls: 'ListSyncRequestRoomMsg',     fields: '' },
  LSA:    { cls: 'ListSyncAckRoomMsg',         fields: '' },

  // ── room list ──────────────────────────────────────────────────────────────
  RR:     { cls: 'RoomListRequest',            fields: '' },
  RB:     { cls: 'RoomListBeginRoomMsg',       fields: '<int>' },
  RI:     { cls: 'RoomListItemRoomMsg',        fields: '<int> Room' },
  RE:     { cls: 'RoomListEndRoomMsg',         fields: '' },
  RU:     { cls: 'RoomUpdateRoomMsg',          fields: 'Room' },

  // ── roster ─────────────────────────────────────────────────────────────────
  PLB:    { cls: 'PlayerListBeginRoomMsg',     fields: '<int>' },
  PLI:    { cls: 'PlayerListItemRoomMsg',      fields: '<int> Player' },
  PLE:    { cls: 'PlayerListEndRoomMsg',       fields: '' },
  PJ:     { cls: 'PlayerJoinRoomMsg',          fields: 'Player' },
  PLEAVE: { cls: 'PlayerLeaveRoomMsg',         fields: 'Player' },
  FP:     { cls: 'FindPlayerRoomMsg',          fields: 'Player' },
  PF:     { cls: 'PlayerFoundRoomMsg',         fields: 'Player Room' },
  PNF:    { cls: 'PlayerNotFoundRoomMsg',      fields: 'Player' },

  // ── chat ───────────────────────────────────────────────────────────────────
  PUC:    { cls: 'PublicChatRoomMsg',          fields: '<str> <str>' },
  PRC:    { cls: 'PrivateChatRoomMsg',         fields: '<str> <str> <str>' },
  MC:     { cls: 'MeChatRoomMsg',              fields: '<str> <str>' },
  HC:     { cls: 'HostChatRoomMsg',            fields: '<str>' },
  H:      { cls: 'HelloRoomMsg',               fields: '<str>' },

  // ── ads ────────────────────────────────────────────────────────────────────
  SPA:    { cls: 'SponsorAdRoomMsg',           fields: 'Ad' },
  SA:     { cls: 'StartAdsRoomMsg',            fields: '<bool> AdList Segment' },
  SPicA:  { cls: 'StartPictureAdsRoomMsg',     fields: '<int> StartAdsRoomMsg' },
  ADLB:   { cls: 'AdDownloadListBeginRoomMsg', fields: '<int>' },
  ADLI:   { cls: 'AdDownloadListItemRoomMsg',  fields: '<int> Ad' },
  ADLE:   { cls: 'AdDownloadListEndRoomMsg',   fields: '' },
  AI:     { cls: 'AdImpressionRoomMsg',        fields: '<bool> Ad' },

  // ── game segments (server -> client) ───────────────────────────────────────
  SP:     { cls: 'StartPreflightRoomMsg',      fields: 'Pic Segment' },
  SC:     { cls: 'StartCompRoomMsg',           fields: '<int> Pic <int> <str> <str> <str> Segment' },
  SV:     { cls: 'StartVoteRoomMsg',           fields: '<int> Pic <bool> Segment' },
  SS:     { cls: 'StartScoreRoomMsg',          fields: '<bool> <bool> <bool> <int> <str> Segment' },
  SRW:    { cls: 'StartRoundWinnerRoomMsg',    fields: '<str> <str> <str> Pic <bool> <bool> <bool> Segment' },
  SGW:    { cls: 'StartGameWinnerRoomMsg',     fields: '<bool> <int> <list> <str> <list> Segment' },
  SFCS:   { cls: 'StartFatChanceSelectionRoomMsg', fields: '<int> <str> <int> BL <bool> <int> Segment' },
  SFCR:   { cls: 'StartFatChanceResultsRoomMsg',   fields: '<str> BL <int> <int> Segment' },
  DP:     { cls: 'DownloadPictureRoomMsg',     fields: 'Pic' },
  PV:     { cls: 'PictureViewedRoomMsg',       fields: '<ushort>' },

  // ── round traffic ──────────────────────────────────────────────────────────
  C:      { cls: 'CompRoomMsg',                fields: '<int> <str> <str>' },
  CR:     { cls: 'CompReceivedRoomMsg',        fields: '<int>' },
  CL:     { cls: 'CompLateRoomMsg',            fields: '<int>' },
  CI:     { cls: 'CompInvalidRoomMsg',         fields: '<int> <str>' },
  CLB:    { cls: 'CompListBeginRoomMsg',       fields: '<int> <int> <bool>' },
  CLI:    { cls: 'CompListItemRoomMsg',        fields: '<int> <str> <str> <str>' },
  CLE:    { cls: 'CompListEndRoomMsg',         fields: '' },
  V:      { cls: 'VoteRoomMsg',                fields: '<int> <str>' },
  VR:     { cls: 'VoteReceivedRoomMsg',        fields: '<int>' },
  VL:     { cls: 'VoteLateRoomMsg',            fields: '<int>' },
  VI:     { cls: 'VoteInvalidRoomMsg',         fields: '<int> <str>' },
  RLB:    { cls: 'ResultsListBeginRoomMsg',    fields: '<int> <int> <int> <bool>' },
  RLI:    { cls: 'ResultsListItemRoomMsg',     fields: '<int> <str> <int> <int> <int> <bool>' },
  RLE:    { cls: 'ResultsListEndRoomMsg',      fields: '' },
  FCS:    { cls: 'FatChanceSelectionRoomMsg',  fields: '<int> <int>' },
  FCSR:   { cls: 'FatChanceSelectionReceivedRoomMsg', fields: '<int>' },
  FCSL:   { cls: 'FatChanceSelectionLateRoomMsg',     fields: '<int>' },
  FCSI:   { cls: 'FatChanceSelectionInvalidRoomMsg',  fields: '<int> <str>' },
  CP:     { cls: 'ComplaintRoomMsg',           fields: '<str> <int> <str>' },
};

// Nested records, written inline inside the messages above.
const GTP_RECORDS = {
  Room:    'PR <round:int> <highScore:int> <tab:bool> <noAutoPick:bool> '
         + 'R <name:str> <host:str> <port:int> <channel:str> <mode:str> '
         + '<players:int> <hidden:bool> <capacity:int>',
  Player:  'PP <score:int> P <name:str>',
  // TestPictureRoomProxy builds a Segment as (serverTime, 33000, 6000, 25000,
  // 2000) at 0x465381, so the four ints look like segment durations in ms.
  Segment: 'S <serverTimeMs:ulong> <int> <int> <int> <int>',
  Ad:      'Ad <file:str> <name:str> <adCode:int>',
  Pic:     'Pic <file:str> <folder:str> <picId:ushort> <int> <title:str> <ushort>',
  AdList:  'AL <count:int> <Ad> x count',
};

// ── network / identity constants ─────────────────────────────────────────────
//
// From the captured dispatch/client/dispatch.ini (Game List Server section).
// The shipped copy said 127.0.0.1 for every server, which inside the guest IS
// the guest -- so the client dialled itself. The served copy is 10.0.2.2, the
// same tap address cosmic's dispatch.ini uses.
const GTP_SERVER_NAME = '10.0.2.2';
const GTP_LIST_CHANNEL = 'Picture_List';
const GTP_BOT_NICK = 'ListNick';
const GTP_SHOW_ID = 'GTP';
const GTP_DISPLAY_NAME = 'Get the Picture Netshow';
const GTP_NETWORK_TOKEN = 'GTP';

// One listener serves both profiles -- which one answers is chosen by the
// console's GAME command / the page's Server dropdown -- so GTP has to be on
// the same port Cosmic binds (GAME_PORT), not the 6667 its original
// dispatch.ini specified. The served dispatch.ini was changed to match; if you
// ever give GTP its own listener, change both back together.
const GTP_PORT = 6666;

// ── rooms ────────────────────────────────────────────────────────────────────
//
// `mode` is the string in list column 5 -- "Mode" on the room-select screen --
// and nothing else. An earlier version of this file also used it as the room
// bot's nick, on the theory that RoomProxy::SendMsg (0x4b772e) PRIVMSGs a nick
// at proxy+0xb0 and the room record had no other string that could fill it.
// That was wrong. The LN branch at 0x4b72da is explicit:
//
//     if (IsEmpty(this+0xb0))          // don't overwrite one we already have
//         this+0xb0 = <sender of LN>   // 0x40a3f6, from [ebp+0xc]
//
// so the client learns the bot's nick from whoever sends it LN, and +0xb0 is
// exactly what SendMsg targets. The room record never names a bot.
//
// Which frees this column to say what it is for -- and a screenshot of the real
// service settles what that is. Its room list reads
//
//     Room       #Players  Round  HighScore  Mode
//     Picture 0     8        7        0      Playing
//     Picture 2     0        0        0      Waiting
//
// so the column is room STATE, not the Clean/Adult split (that is the tab, and
// the room NAME is just "Picture <n>", matching the channel). IsRoomJoinable's
// reject list (0x405afd) fits exactly: {full, listing rooms, dead, unknown} are
// the other states, and hitting one greys the room out.
//
// gtpRoomMode() below derives it. If a room ever goes silent after a change
// here, the field really is the bot nick after all: set it to GTP_BOT_NICK.
// `adult` picks which of the room selector's two tabs the room appears under.
// See GTP_ROOM_TAB below for how that maps onto the wire, and note the tabs are
// only VISIBLE when the login reply said adult=Y -- see the note on that field
// in cosmic-server.js's loginSuccessResponse.
//
// Names carry spaces via STX quoting, which is proven in both directions now:
// the SP caption "Get The Picture" rendered correctly under the picture, and a
// typed chat line round-tripped through PUC.
const GTP_ROOM_CONFIGS = [
  { name: 'Picture 0', channel: 'Picture_000', adult: false, capacity: 10 },
  { name: 'Picture 1', channel: 'Picture_001', adult: false, capacity: 10 },
  { name: 'Picture 2', channel: 'Picture_002', adult: true,  capacity: 10 },
  // No bots here, and the name has to say so -- from the selector the two
  // kinds of room are otherwise identical, and a pair of people who want to
  // play each other should not have to guess which one drowns them in eight
  // scripted opponents.
  { name: 'Humans Only', channel: 'Picture_003', adult: true, capacity: 10,
    botsAllowed: false },
];

// Room slots -- the value that goes in the Room record's capacity field, which
// is the ONLY thing that limits a room: IsRoomJoinable (0x405afd) is literally
// `players < capacity`, and the client has no cap of its own. PlayerListBegin's
// count is not even passed to the handler (0x44189d -> view vf 0x110 takes no
// argument); the roster is built from the PLI items that follow.
//
// 10 because that is what the real service ran: the Fat Chance screenshot's
// roster has ten rows -- Scandal, Hedgehawg, Madgirl, Baby J, Calgoon,
// RoadKill, Boofy, Julie K, Snokka and the local player. The room list showing
// "8" against some rooms was occupancy at that moment, not a limit.
//
// Cosmic's client tolerates 0 here; GTP's does not -- see the IsRoomJoinable
// note in the header.
const GTP_ROOM_CAPACITY = 10;

// What a JOIN has to look like before it is treated as entering a GTP room.
//
// Not paranoia -- this has already happened. One listener serves every profile,
// so a Cosmic Consensus client that connects while the Server dropdown is on
// GTP lands here and JOINs #Big_List, which is Cosmic's LOBBY. Without this
// check that read as "player selected game room Big_List": an ad-hoc room was
// invented for it, GTP segments were sent to a Cosmic client, and the phantom
// room was then advertised to real GTP clients in the room list (RB 2).
//
// A channel that is neither the lobby nor a plausible room name now gets a
// diagnostic instead of a room.
const GTP_ROOM_CHANNEL_PATTERN = /^Picture_\d+$/i;

// Which of the ChooseRoomScreen's two list controls a room lands in (0x5c) --
// which is to say, whether it is a Keep It Clean room or an Adult one.
//
// TRUE is Keep It Clean, and that is the DEFAULT for a room with no `adult`
// key, because getting it wrong is invisible rather than fatal: the room list
// came up empty with no error at all before this was pinned down.
// AddRoom (0x405349) files the room by this bit:
//
//     tab == 0  ->  the control at screen+0x68
//     tab != 0  ->  the control at screen+0x64
//
// but the control it SHOWS is chosen by a different rule. OnShow (0x4057ec)
// sets screen->0x7c = screen->0x8c, and both the "Let Me Choose" activation
// (0x406055) and the selection updater (0x4059e3) then do
//
//     list = (screen->0x7c == screen->0x8c) ? screen+0x64 : screen+0x68
//
// so the visible one in the default state is 0x64. A room with tab=false is
// added, correctly, to the list nobody is looking at. "Choose a Room for Me"
// (0x405be3) agrees: it only considers rooms whose tab matches
// (0x7c == 0x8c), which is true.
//
// Which tab is which follows from the same code. The two tab controls (+0x8c
// and +0x90) are shown only when screen->0xd1 is set (0x4057ec, 0x4060ed), and
// 0xd1 is the adult-allowed flag from the login reply (set via 0x405fa9). So a
// player without adult permission sees no tabs and can reach ONLY the default
// list -- the tab=true one. That list therefore has to be the clean rooms:
//
//     tab = true  (1)   Keep It Clean   -- the default, always reachable
//     tab = false (-1)  Adult           -- second tab, needs adult=Y
//
// The mapping is an inference from that gate, not something the binary states
// outright; the alternative (a player denied adult content can see only the
// adult rooms) is not a reading anyone shipped.
const GTP_ROOM_TAB = true;

// Whether "Choose For Me" may pick this room (0x5d). 0x405be3 skips any room
// with it set, and AddRow takes it as a flag, so false is the plain public case.
const GTP_ROOM_NO_AUTOPICK = false;

// ── ads ──────────────────────────────────────────────────────────────────────
//
// Entering a room puts the client on "Please Stand By... Downloading sponsor
// advertisement." and it stays there until a SponsorAdRoomMsg arrives. Sending
// nothing is not neutral -- it is a hang.
//
// Where the ad comes from: the served picture/content/UpdateScript.ini sets
//
//     Variable = AdServerFolder
//     Value    = picture/content/ads
//
// (read at 0x487bca, stashed at FileUpdate+0xb0), so the client GETs
// /picture/content/ads/<file> from the content server. cosmic-server.js's
// handleGet routes anything matching /content/ads/ to tryAdFile(), which
// resolves by BASENAME against static/bigidea/content/Ads -- so Cosmic's ad
// library is already reachable at GTP's path with no new plumbing. They are
// "srf1" files carrying an "off4" chunk, and GTP registers that same resource
// type, so they are the same format.
//
// Field convention comes from the binary's own reference server: the ctor at
// 0x4658d1 stores arg1 at Ad+0x00 and arg2 at Ad+0x10, and TestPictureRoomProxy
// (0x463935) calls it as
//
//     Ad("bra298.srf", "bra298", 11981)
//
// -- filename WITH the extension first, bare name second. That is the safe
// spelling: it resolves to the same file whether the downloader uses field 1
// verbatim or appends ".srf" to field 2. (Cosmic sends the full filename in
// both fields, which is fine there but would break the second reading.)
//
// The trailing int is an ad code -- the test data uses 11981 and 12678, Cosmic
// sends 0. 0 is what is proven end to end on this engine, so 0 it is.
const GTP_SEND_ADS = true;
const GTP_NO_AD_FILE = 'nad000.srf';
function gtpNoAdvertisements() {
  return !!(typeof window !== 'undefined' && window.gameSettings
    && window.gameSettings.noAdvertisements);
}
// This field is the ad display duration in milliseconds, not an ad code.
// Python and Cosmic both use six seconds here; zero leaves bumper ad slots
// blank on the Win95 client.
const GTP_AD_DURATION_MS = 6000;

// Fetched once from the same manifest cosmic-server.js reads. The fallback is
// the directory as it stands, so a failed fetch degrades to a working list
// rather than to no ad at all -- which would be the hang described above.
const GTP_AD_MANIFEST_URL = 'static/bigidea/content/Ads/manifest.json';
const GTP_AD_FALLBACK = [
  'acr182.srf', 'air212.srf', 'arm211.srf', 'bud143.srf', 'col215.srf',
  'gvl113.srf', 'hug173.srf', 'ike212.srf', 'lau111.srf', 'lnc112.srf',
  'nab184.srf', 'res221.srf', 'sky215.srf', 'tpv213.srf', 'usr135.srf',
  'vis171.srf', 'voc213.srf', 'war215.srf',
];

// How many ads to name in the ADLB/ADLI/ADLE pre-download list. Every one of
// them is fetched over HTTP before the client moves on, so keep it small.
const GTP_AD_LIST_SIZE = 4;

// Commercial-break behavior mirrored from the Python server.  The client
// ships the bumper animations; SPicA selects the break and embeds an SA ad
// sequence.  Ads must already have been downloaded at room entry.
const GTP_BUMPER_BEFORE_FINAL = true;
const GTP_BUMPER_FINAL_INT = 1;
const GTP_BUMPER_MID_INTS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const GTP_BUMPER_ANIMATION_MS = 8000;
const GTP_BUMPER_AD_COUNT = 1;
const GTP_BUMPER_DOWNLOAD_MS = 2500;

// ── game constants, from the published rules ─────────────────────────────────
//
// These are the SHIPPING values. TestPictureRoomProxy's numbers (41000, 60000,
// 107500 and so on) are a test harness exercising the UI, not the real game, so
// they are evidence for the message SHAPE and nothing more.
const GTP_ROUND_COUNT = 7;
const GTP_COMP_MS = 45000;          // composition round
const GTP_SLIMERICK_MS = 60000;     // except Slimericks, which gets 60 s
const GTP_VOTE_MIN_MS = 10000;      // "at least 10 seconds", scaled by entries
// 25 s, not 6. The 6000 this used to be came from TestPictureRoomProxy's
// (serverTime, 33000, 6000, 25000, 2000) -- but those four ints are a Segment,
// and a Segment's ints are absolute timestamps plus a transition length, not a
// list of phase durations. Lifting 6000 out of it as "the fat chance window"
// was a guess, and six seconds to read and click one of twelve swatches is not
// a window a person can use.
const GTP_FATCHANCE_MS = 25000;
const GTP_CAPTION_MAX = 160;        // characters
const GTP_SLIMERICK_LINE_MAX = 80;  // per line, two lines
// Rounds 1-3 score 1 point per vote, 4-6 score 2, the Final Round scores 3.
const GTP_POINTS_PER_VOTE = [1, 1, 1, 2, 2, 2, 3];

// ── bots ─────────────────────────────────────────────────────────────────────
//
// A room with one name in the roster looks broken; the screenshots of the real
// service show eight or nine. Same idea as cosmic-server.js's bot fill, but the
// wire is different: a bot is announced with PlayerJoinRoomMsg
//
//     PJ PP <score> P <name>
//
// and thereafter appears in every PLB/PLI/PLE roster like anyone else.
//
// Names are deliberately period-plausible and taken from the screenshots of the
// real thing where legible, so the roster reads like a 1999 game room.
const GTP_BOT_NAMES = [
  'Scandal', 'Hedgehawg', 'Madgirl', 'RoadKill', 'Baby J',
  'Boofy', 'Calgoon', 'Julie K', 'Snokka', 'kitypunk',
];
const GTP_MIN_BOTS = 8;

// Seats bots are never allowed to occupy. Without this the fill takes every
// free seat, the room advertises itself as Full, and the SECOND human is
// locked out of the room their friend is in -- which is the one thing a
// multiplayer game must not do. Bots are scenery; humans get priority.
//
// With capacity 10 this leaves 8 bots and room for two humans. Occupancy is
// reported honestly as humans + bots, so the room only reads Full when it
// genuinely is -- and gtpEvictBotsFor() is the backstop that sends bots home
// if the numbers are ever reconfigured such that a human would not otherwise
// fit.
const GTP_RESERVED_HUMAN_SEATS = 2;
// Pace of the PJ burst. Cosmic uses 500 ms so the roster fills visibly rather
// than appearing all at once; the same reads well here.
const GTP_BOT_JOIN_STAGGER_MS = 500;

// Captions the bots submit. Not sent anywhere yet -- the caption list
// (CLB/CLI/CLE) and voting are not built -- but collected at round start so the
// voting round has real content the moment it exists, and so the log shows what
// a full round would carry.
const GTP_BOT_CAPTIONS = [
  'All I said was I was having a little trouble sleeping...',
  'Body piercing 101.',
  'The visible (older) man.',
  'Is this what all the other astronauts had to go through?',
  'I told them not to overcook the noodles.',
  'Next time I am reading the instructions first.',
  'Cable TV installation has really gone downhill.',
  'They said the spa package included a wrap.',
  'So THAT is where the remote went.',
  'Do these tubes make me look fat?',
];

// Drive the composition round automatically once the picture is on screen.
// Off parks the client on the preflight screen for hand-driving with gtpSend().
const GTP_AUTO_COMP = true;

// StartComp's two ints, settled by reading CompositionScreen's own switch.
//
// At 0x408cae the screen fetches the SECOND int (accessor 0x40a965) and
// switches on it:
//
//     0 -> 0x408ddb   plain round, no twist
//     1 -> 0x408da4   twist
//     2 -> 0x408d6d   twist  -- observed to be Slimericks
//     3 -> 0x408d0d   twist that also reads the THREE STRINGS (0x40a969/
//                     0x40a96d/0x40a971) -- Copyfits, whose rules say three
//                     words are supplied
//     4 -> 0x408cd3   twist
//     anything else falls through to 0x408e12 and sets no title at all
//
// The FIRST int (accessor 0x40a961) is read inside every branch and passed to
// the title call, which makes it the round number -- the "Round One" caption.
//
// This is what made every round look like a final round: the reference harness
// passes 2 for the second int, I copied it, and 2 is Slimericks. Rounds 1-6
// need 0.
const GTP_VARIANT_PLAIN = 0;
// All four confirmed on screen. 1, 2 and 4 were identified by playing them;
// 3 fell out by elimination and agrees with the binary, where 3 is the only
// branch that reads SC's three string fields.
const GTP_VARIANT_TABHEADS = 1;     // tabloid headline
const GTP_VARIANT_SLIMERICKS = 2;   // two rhyming lines, 60 s not 45
const GTP_VARIANT_COPYFITS = 3;     // caption must use three supplied words
const GTP_VARIANT_BILLBOREDS = 4;   // advertising slogan

// The four Final Round twists, by the values above.
const GTP_FINAL_VARIANT_IDS = [
  GTP_VARIANT_TABHEADS, GTP_VARIANT_SLIMERICKS, GTP_VARIANT_COPYFITS, GTP_VARIANT_BILLBOREDS,
];

// Copyfits supplies three words the caption should try to use ("TREE... LABOR...
// SUAVE" in the published example). Only variant 3 reads them; the other
// variants get empty strings, exactly as the reference harness sends.
// Pinned by gtpVariant(n) so one variant can be tested on every round instead
// of only on round 7. null means normal play: 0 for rounds 1-6, random for 7.
let GTP_FORCED_VARIANT = (typeof window !== 'undefined'
  && window.gtpSettings && window.gtpSettings.enabled
  && window.gtpSettings.forcedVariant !== '')
  ? Number(window.gtpSettings.forcedVariant) : null;
if (typeof window !== 'undefined' && window.gtpSettings
    && window.gtpSettings.enabled) {
  const savedScale = Number(window.gtpSettings.timeScale);
  if (Number.isFinite(savedScale) && savedScale > 0) window.gtpTimeScale = savedScale;
}

const GTP_COPYFITS_WORDS = [
  ['TREE', 'LABOR', 'SUAVE'], ['WIND', 'FACE', 'ROOFING'],
  ['CHEESE', 'ORBIT', 'GRANDMA'], ['PICKLE', 'THUNDER', 'BUDGET'],
  ['VELVET', 'PLUMBER', 'ECLIPSE'], ['NOODLE', 'JUSTICE', 'TRACTOR'],
];

// Segment fields b/c/d for a composition round, kept at the reference server's
// values because there is no reading of them yet. Only `a` -- the one the timer
// control derives its countdown from (0x4bb477 computes d + a - now and hands
// it to the control, with b and c passed straight through) -- is set from the
// published 45 seconds.
const GTP_COMP_SEGMENT_BCD = [41000, 60000, 1000];

// Answer the client's in-room RR with a preflight segment. Turn this off to
// park the client on the waiting screen and drive segments entirely by hand
// with gtpSend() -- which is what you want while bisecting a field.
const GTP_AUTO_PREFLIGHT = true;

let gtpAdCache = null;

async function gtpAds() {
  if (gtpAdCache) return gtpAdCache;
  try {
    const resp = await fetch(GTP_AD_MANIFEST_URL, { cache: 'no-store' });
    if (resp.ok) {
      const list = await resp.json();
      if (Array.isArray(list) && list.length) {
        gtpAdCache = list.filter((f) => typeof f === 'string' && f.endsWith('.srf'));
        gtpLog(`STAT: loaded ${gtpAdCache.length} ad file(s) from ${GTP_AD_MANIFEST_URL}.`);
        return gtpAdCache;
      }
    }
  } catch (e) { /* fall through to the built-in list */ }
  gtpAdCache = GTP_AD_FALLBACK.slice();
  gtpLog(`STAT: ad manifest unavailable -- using the ${gtpAdCache.length}-file fallback list.`);
  return gtpAdCache;
}

/** An Ad record: filename with extension, bare name, ad code. */
function gtpAdRecord(file, durationMs = GTP_AD_DURATION_MS) {
  return `Ad ${file} ${file.replace(/\.srf$/i, '')} ${durationMs | 0}`;
}

// ── pictures ─────────────────────────────────────────────────────────────────
//
// The Pic record, from the same reference server. Its ctor at 0x465b14 lays
// out arg1..arg6 at +0x00 (str), +0x10 (str), +0x20 (int), +0x24 (int),
// +0x28 (str), +0x38 -- which is exactly the reader's
// <str> <str> <ushort> <int> <str> <ushort>. TestPictureRoomProxy (0x463a1b)
// calls it as
//
//     Pic("lightning.jpg", "picture/content/pictures", 7260, 1, "New Picture", 1)
//
// so field 1 is the image file, field 2 the server folder it is fetched from,
// and field 5 the caption shown with it. The three numbers are a picture id and
// two unknowns; 7260/1/1 is the only combination ever observed.
//
// There is no filename CONVENTION to match: the record names the file outright,
// so anything in the folder works. The only hardcoded picture name in the
// binary is the local placeholder Resources\Pictures\StillDownload.jpg.
//
// The FORMAT is fussy, though. The exe carries its own JPEG decoder (NCI
// "JPoster", error strings at 0x550e08..0x55114c) and it is not a general one:
//
//     SOF2 - Progressive JPEG not supported        baseline only
//     SOS - Multiscan image not allowed            one scan
//     SOF0 - Sample precision is not 8 bits
//     SOF0 - # Of components is not 1 or 3         grey or YCbCr; no CMYK
//     SOF0 - Color Image needs 1x1 color sampling  4:4:4 -- NO chroma subsampling
//     SOF0 - Image subsampling not 1..4
//     DQT - Quant precision is not 8-bit
//
// Two of those bite by default: most encoders write progressive, and almost
// every encoder writes 4:2:0. ImageMagick that satisfies all of them:
//
//     magick in.png -colorspace sRGB -type TrueColor \
//            -interlace none -sampling-factor 1x1 -quality 85 out.jpg
//
// PNG is not an option at all -- this client predates it.
const GTP_PICTURE_FOLDER = 'picture/content/pictures';

// The picture bank. `credit` is Pic field 5, and it is NOT a title -- it is the
// attribution line printed under the image. The real service used it exactly
// that way; a Billboreds screenshot shows
//
//     IndexStock Imagery (c) Mike Mcgovern
//
// under the photo. So the format is "<agency or source> (c) <photographer>".
//
// `id` is what the client echoes back in PV once it has decoded the image, so
// keep them distinct per picture -- Pic's equality operator (0x434ce9) compares
// nothing but this field, which means two pictures sharing an id are the same
// picture as far as the client is concerned.
//
// Add entries here as more pictures land in static/picture/content/pictures/.
// Every one must pass gtp-picture.py --check first: baseline, 8-bit, 4:4:4,
// single scan, or the client shows StillDownload.jpg forever.
// The bank starts as a single known-good picture and is replaced by whatever
// gtp-pictures.py last validated, fetched below. Keeping a hard-coded entry as
// the seed means a missing or broken manifest degrades to a playable game
// rather than a room with no picture at all.
let GTP_PICTURES = [
  {
    file: 'guywithtubes.jpg',
    id: 7260,
    // Genuinely unknown: this frame came off a 1999 screenshot, so the agency
    // and photographer are lost. Fill it in properly when a picture with known
    // provenance replaces it rather than inventing an attribution.
    credit: 'Photographer unknown',
  },
];
let gtpPicturesReady;

// Adding a droodle to static/picture/content/pictures/ and re-running
// ./gtp-pictures.py is all it takes to put it in rotation -- the credit line
// travels with it, parsed from the Droodle_###_Name convention.
gtpPicturesReady = Promise.resolve(fetch('static/picture/content/pictures/manifest.json'))
  .then((r) => (r.ok ? r.json() : null))
  .then((list) => {
    if (Array.isArray(list) && list.length) {
      GTP_PICTURES = list;
      gtpLog(`STAT: picture bank: ${list.length} image(s) from the manifest.`);
    }
  })
  .catch(() => gtpLog('STAT: no picture manifest; run ./gtp-pictures.py'));

/**
 * A fresh shuffled deck per game, dealt one picture per round.
 *
 * Drawing at random each round would repeat inside a single game, which is the
 * one place a repeat is obvious -- the same photo twice in seven rounds. The
 * deck is only reshuffled when it runs dry, so a bank smaller than the round
 * count still degrades gracefully.
 */
function gtpDealPictures(room) {
  const deck = GTP_PICTURES.slice();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  room.deck = deck;
}

function gtpNextPicture(room) {
  if (!room || !GTP_PICTURES.length) return GTP_PICTURES[0];
  if (!room.deck || !room.deck.length) gtpDealPictures(room);
  // Do not hand back the picture already on screen when a reshuffle lands on
  // it -- that reads as the round never having advanced.
  if (room.deck.length > 1 && room.deck[room.deck.length - 1] === room.picture) {
    room.deck.unshift(room.deck.pop());
  }
  return room.deck.pop();
}

function gtpPicRecord(pic = GTP_PICTURES[0]) {
  return `Pic ${pic.file} ${GTP_PICTURE_FOLDER} ${pic.id | 0} 1 ${gtpQuote(pic.credit)} 1`;
}

// Kept for the log lines and the preflight, which want the first picture by
// name rather than a rotation.
const GTP_PICTURE_FILE = GTP_PICTURES[0].file;

// ── cp1252 ───────────────────────────────────────────────────────────────────
//
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

// ── field helpers ────────────────────────────────────────────────────────────

// The bool reader (0x4ad111) accepts the token "1" and the token "-1" and
// throws on everything else -- not 0, not "true", not an empty field. Every
// boolean slot on the wire has to go through this.
function gtpBool(v) { return v ? '1' : '-1'; }

// Multi-word strings are wrapped in STX, not quotes (tokenizer at 0x4ad902).
// A literal STX inside the text is doubled. Single-word strings are left bare,
// which is what the client itself emits.
function gtpQuote(s) {
  const text = String(s === undefined || s === null ? '' : s);
  if (!text.length) return '\x02\x02';
  if (!/[ \x02]/.test(text)) return text;
  return '\x02' + text.replace(/\x02/g, '\x02\x02') + '\x02';
}

/**
 * A PictureRoom record, as RI/RU/PF carry it.
 *
 *   PR <round> <highScore> <tab> <noAutoPick>
 *   R  <name> <host> <port> <channel> <mode> <players> <hidden> <capacity>
 *
 * Reader: PictureRoom 0x44a25d chaining into Room 0x4b0bf7.
 */
/**
 * The Mode column: the room's state, in the real service's vocabulary.
 *
 * "full" is in IsRoomJoinable's reject list (0x405afd) as well as being caught
 * by the players < capacity test, so a full room is unjoinable twice over --
 * which is presumably why the original bothered to write it.
 */
function gtpRoomMode(room) {
  if (room.mode) return room.mode;                       // explicit override
  const players = room.players || 0;
  if (players >= (room.capacity || GTP_ROOM_CAPACITY)) return 'Full';
  return room.round > 0 ? 'Playing' : 'Waiting';
}

function gtpRoomRecord(room) {
  const players = room.players || 0;
  const capacity = room.capacity || GTP_ROOM_CAPACITY;
  // `adult` is the readable spelling; `tab` is the raw bit, kept as an escape
  // hatch if the mapping ever turns out to be the other way round.
  const tab = (room.tab !== undefined) ? room.tab
            : (room.adult !== undefined) ? !room.adult
            : GTP_ROOM_TAB;
  return [
    'PR',
    room.round | 0,
    room.highScore | 0,
    gtpBool(tab),
    gtpBool(room.noAutoPick === undefined ? GTP_ROOM_NO_AUTOPICK : room.noAutoPick),
    'R',
    gtpQuote(room.name),
    GTP_SERVER_NAME,
    GTP_PORT,
    room.channel,
    gtpQuote(gtpRoomMode(room)),
    players,
    gtpBool(false),   // hidden: TRUE would drop the row from the list entirely
    capacity,
  ].join(' ');
}

/**
 * Split a line into fields the way the client's tokenizer does: on spaces,
 * with \x02 quoting a run that contains them (0x4ad902).
 *
 * Needed because a chat body's fields can hold spaces, so a naive split lands
 * the wrong text in the wrong slot -- which for a private message would mean
 * routing it to the wrong person.
 */
function gtpFields(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ') { i++; continue; }
    if (line[i] === '\x02') {
      i++;
      let s = '';
      while (i < line.length) {
        if (line[i] === '\x02') {
          if (line[i + 1] === '\x02') { s += '\x02'; i += 2; continue; }
          i++; break;
        }
        s += line[i++];
      }
      out.push(s);
    } else {
      let s = '';
      while (i < line.length && line[i] !== ' ') s += line[i++];
      out.push(s);
    }
  }
  return out;
}

/** A PicturePlayer record, as PLI/PJ/PLEAVE/FP/PF/PNF carry it. */
function gtpPlayerRecord(name, score = 0) {
  return `PP ${score | 0} P ${gtpQuote(name)}`;
}

/**
 * A Segment record. The first field is the server clock in milliseconds:
 * LogonAccepted and every ST feed it to RoomProxy::SetServerTime (0x4b76cd),
 * which stores it as a signed offset from the local GetTickCount.
 */
function gtpSegment(serverTimeMs, a = 0, b = 0, c = 0, d = 0) {
  return `S ${serverTimeMs >>> 0} ${a | 0} ${b | 0} ${c | 0} ${d | 0}`;
}

/**
 * A Segment for a screen that shows a countdown.
 *
 * Field `a` is an ABSOLUTE server timestamp -- when the segment ENDS -- not a
 * duration. The timer control setup at 0x4bb477 is unambiguous:
 *
 *     call [eax+0x78]     ; now = the server clock
 *     mov  edx, d
 *     mov  ebx, a
 *     add  edx, ebx       ; d + a
 *     sub  edx, eax       ; d + a - now   -> handed to the control as arg 1
 *
 * so `a` only means anything measured on the same clock as `now` -- the one we
 * set through LA and every ST. Sending a duration made the round expire the
 * instant it started: with a=45000 against a clock already at ~322000, the
 * remaining time computed as roughly -276000 and the badge read 00.
 *
 * The reference server's numbers agree once read this way: its comp segment is
 * (107500, 41000, 60000, 1000), and 41000 < 60000 < 107500 is an ordered set of
 * timestamps. As durations they never added up -- 41000+60000+1000 is 102000,
 * not 107500 -- which was the arithmetic that would not close.
 *
 * b and c are left as the caller passes them. They look like sub-phase
 * boundaries on the same clock, but nothing has pinned that down, so this does
 * not silently rebase them.
 */
/**
 * How long a screen is given to transition in, the Segment's `d`.
 *
 * 0x4bb477 hands the incoming screen Start(d + a, b, c, d), so `d` is the
 * length of its entrance, not a timestamp. It matters more than it looks:
 * CaptionsControl only enables its rows for clicking when the transition
 * completes (0x41d9c2, reached from CaptionsControlTransitionDoneMsg at
 * 0x41dd56, which turns each row on through vf 0xe4/0xe8). A screen given no
 * transition has nothing to finish, so the rows stay dead and the captions
 * cannot be clicked at all -- which is exactly what the voting screen did.
 *
 * The reference server's composition segment is (107500, 41000, 60000, 1000),
 * so 1000 is the observed value; its preflight segment is (10000, 0, 10000, 0),
 * so a screen with no entrance genuinely passes 0. Everything else was sending
 * 0 because that was the parameter default I picked, not because anything
 * observed said so.
 */
const GTP_TRANSITION_MS = 1000;

function gtpSegmentEndingIn(durationMs, d = GTP_TRANSITION_MS) {
  const now = gtpNow();
  const end = now + durationMs;
  // b and c are on the SAME clock as a, and leaving them at the reference
  // server's raw values put them minutes in the past -- every sub-phase of the
  // round read as already expired, so the composition screen skipped straight
  // past the typing window with the countdown still showing time.
  //
  // The preflight reference is what gives the pattern: (a=10000, b=0,
  // c=10000, d=0) with the segment starting at 0, i.e. b is the segment START
  // and c its END. So they are rebased with a rather than left behind.
  return gtpSegment(now, end, now, end, d);
}

// ── rooms ────────────────────────────────────────────────────────────────────

const gtpRooms = new Map();

function gtpRoom(channel) {
  return gtpRooms.get(channel) || null;
}

function gtpEnsureRoom(channel) {
  let room = gtpRooms.get(channel);
  if (!room && !GTP_ROOM_CHANNEL_PATTERN.test(channel)) {
    // Belt and braces with the JOIN check above: nothing that is not a GTP
    // room channel gets a room, because a room here becomes an RI line to
    // every client in the lobby.
    gtpLog(`STAT: refusing to create a room for #${channel} -- not a GTP room channel.`);
    return null;
  }
  if (!room) {
    room = {
      name: channel,
      channel,
      mode: GTP_BOT_NICK,
      capacity: GTP_ROOM_CAPACITY,
      round: 0,
      highScore: 0,
      players: 0,
      clients: new Set(),
      gameGeneration: 0,
      screenCluster: [],
      lastScreenCluster: null,
      bumperDeck: [],
      adDeck: [],
      lastAd: null,
      bumperReceipt: null,
      pendingBumpers: [],
      fcRevealed: new Set(),
      fcBoard: [],
    };
    gtpRooms.set(channel, room);
    gtpLog(`STAT: created ad-hoc room '${channel}'.`);
  }
  return room;
}

for (const cfg of GTP_ROOM_CONFIGS) {
  gtpRooms.set(cfg.channel, Object.assign(
    { players: 0, round: 0, highScore: 0, clients: new Set(), gameGeneration: 0,
      screenCluster: [], lastScreenCluster: null, bumperDeck: [], adDeck: [],
      lastAd: null, bumperReceipt: null, pendingBumpers: [],
      fcRevealed: new Set(), fcBoard: [] }, cfg));
}

/**
 * Make a login name unique across connected clients.
 *
 * Every VM boots the same disk image with the same saved credentials, so two
 * windows both log in as "NonaSuomy". That is not cosmetic: the roster shows
 * one name twice, and room.votes, room.entries and room.scores are all keyed
 * by username -- so two players share a vote, and the second one's caption
 * REPLACES the first's. Chat looks broken too, because each player receives the
 * other's line attributed to their own name and the client treats it as an echo
 * of something it already displayed.
 *
 * NEVER renames. Renaming looks harmless and is not.
 *
 * The client keeps its OWN copy of its name and compares against it --
 * PictureView holds it at +0xbc, and virtual_196 compares it with the winner
 * name out of SFCS to decide whether this player may touch the Fat Chance
 * board. The same comparison drives every "is this me?" behaviour: your name in
 * red, refusing to let you vote for your own caption, and the board accepting a
 * click at all.
 *
 * Rename the client to "NonaSuomy2" while it still believes it is "NonaSuomy"
 * and all of that silently stops working -- the board renders, the countdown
 * runs, every click is refused, and the announcer insists you did not win the
 * round you just won. Nothing in any log shows it.
 *
 * The common trigger is not two people picking one name: it is the SAME person
 * reconnecting while their previous room socket has not been reaped. A client
 * may legitimately keep its lobby socket open while opening a second room
 * socket, so a lobby-only duplicate is preserved; only an older connection
 * already occupying a room is evicted. Bots just get renamed; they have no
 * opinion.
 */
function gtpUniqueName(wanted, self) {
  for (const c of gtpClients) {
    if (c !== self && c.connected && c.username && c.room
        && c.username.toLowerCase() === wanted.toLowerCase()) {
      gtpLog(`STAT: "${wanted}" is held by an older connection -- dropping it so `
        + `the new client can keep its own name. Renaming would break that client.`);
      c.connected = false;
      try { c.conn.close(); } catch (e) { /* already gone */ }
    }
  }
  for (const room of gtpRooms.values()) {
    for (const b of room.bots || []) {
      if (b.name.toLowerCase() === wanted.toLowerCase()) {
        b.name = `${b.name}_bot`;
        gtpLog(`STAT: renamed a bot out of the way for "${wanted}".`);
      }
    }
  }
  return wanted;
}

function gtpHttpLoginName(wireName) {
  const queue = (typeof window !== 'undefined' && window.__pendingHttpLogins) || null;
  if (!queue) return wireName;
  const now = Date.now();
  while (queue.length && now - queue[0].at > 60000) queue.shift();
  const login = queue.shift();
  if (login && login.name && login.name !== wireName) {
    gtpLog(`STAT: HTTP profile "${login.name}" overrides stale registry L name "${wireName}".`);
  }
  return login && login.name ? login.name : wireName;
}

/** Everyone currently connected, so the lobby can report real occupancy. */
const gtpClients = new Set();

function gtpLobbyClients() {
  return [...gtpClients].filter((c) => c.connected && c.username && !c.room);
}

function gtpRoomClients(room) {
  return [...room.clients].filter((c) => c.connected && c.username);
}

/**
 * The room's full roster: humans first, then bots, sorted by score descending.
 *
 * Descending because that is how the real service ordered it -- the round-winner
 * screenshot shows the list resorted with the winner at the top -- and because
 * the final-score screen reads straight off it.
 */
function gtpRoster(room) {
  const humans = gtpRoomClients(room).map((c) => ({ name: c.username, score: c.score || 0 }));
  const bots = (room.bots || []).map((b) => ({ name: b.name, score: b.score || 0 }));
  return humans.concat(bots).sort((a, b) => b.score - a.score);
}

/**
 * How many bots this room should be running right now.
 *
 * Capacity minus whichever is larger: the humans actually present, or the
 * seats held open for humans still to arrive. So a room never fills to the brim
 * with bots, and a second or third player can always get in.
 */
function gtpTargetBotCount(room) {
  if (room.botsAllowed === false) return 0;
  const capacity = room.capacity || GTP_ROOM_CAPACITY;
  const humans = gtpRoomClients(room).length;
  const free = capacity - Math.max(humans, GTP_RESERVED_HUMAN_SEATS);
  return Math.max(0, Math.min(GTP_MIN_BOTS, free));
}

/** Fill a room's empty seats, leaving room for the humans already in it. */
function gtpFillBots(room) {
  const want = gtpTargetBotCount(room);
  room.bots = room.bots || [];
  if (room.bots.length >= want) return room.bots;
  const have = new Set(room.bots.map((b) => b.name));
  for (const name of GTP_BOT_NAMES) {
    if (room.bots.length >= want) break;
    if (!have.has(name)) room.bots.push({ name, score: 0 });
  }
  return room.bots;
}

/**
 * Make room for an arriving human by sending bots home.
 *
 * Announced with PLEAVE so every client's roster updates, and the lowest
 * scorers go first -- losing the leader mid-game would be strange.
 */
async function gtpEvictBotsFor(room) {
  const want = gtpTargetBotCount(room);
  if (!room.bots || room.bots.length <= want) return;
  const going = room.bots
    .slice()
    .sort((a, b) => (a.score || 0) - (b.score || 0))
    .slice(0, room.bots.length - want);
  room.bots = room.bots.filter((b) => !going.includes(b));
  for (const bot of going) {
    for (const c of gtpRoomClients(room)) {
      await c.botPriv(`PLEAVE ${gtpPlayerRecord(bot.name, bot.score || 0)}`);
    }
  }
  // PLEAVE's handler (0x43f45c) carries the same name guard as PJ's, so it will
  // not remove an arbitrary player either. The roster push is what actually
  // updates the list.
  gtpPushRoster(room);
  // Any staged caption from an evicted bot has to go too, or it would appear
  // in the voting list from someone no longer in the room.
  if (room.entries) {
    room.entries = room.entries.filter((e) => !going.some((b) => b.name === e.name));
  }
  gtpLog(`STAT: ${going.length} bot(s) left '${room.channel}' to make room `
         + `(${gtpRoomClients(room).length} human(s), ${room.bots.length} bot(s), `
         + `${(room.capacity || GTP_ROOM_CAPACITY)} seats).`);
}

// "banned from that gameroom for up to 4 hours" -- the rules' own number.
const GTP_BAN_MS = 4 * 60 * 60 * 1000;

/**
 * Remove a player from a room and keep them out of it for a while.
 *
 * Per-room, not global: the rules are explicit that a majority in ONE room bans
 * from THAT room, and that finding another room is the expected remedy. A
 * site-wide ban is a different power and is not what this is.
 */
async function gtpBanFromRoom(room, client, ms) {
  room.bans = room.bans || new Map();
  room.bans.set((client.username || '').toLowerCase(), Date.now() + ms);
  const hours = Math.round(ms / 3600000);
  gtpLog(`STAT: "${client.username}" banned from '${room.channel}' for ${hours}h by majority complaint.`);
  for (const c of gtpRoomClients(room)) {
    Promise.resolve(c.notice(`${client.username} has been removed from this room.`)).catch(() => {});
  }
  await client.notice(`You have been removed from this room for ${hours} hours.`);
  client.leaveRoom();
  // LER is LostRoomBotError in the catalogue, but it is the only "you are out
  // of this room" message the lobby half has, and the client is already back on
  // the room list by the time it lands.
  await client.botPriv(`LER ${gtpQuote('Removed from the room by player complaints.')}`);
}

function gtpIsBanned(room, name) {
  if (!room.bans) return false;
  const until = room.bans.get((name || '').toLowerCase());
  if (!until) return false;
  if (Date.now() >= until) { room.bans.delete((name || '').toLowerCase()); return false; }
  return true;
}

/** Push a fresh RU to everyone still sitting in the room selector. */
function gtpBroadcastRoomUpdate(room) {
  for (const c of gtpLobbyClients()) {
    Promise.resolve(c.botPriv(`RU ${gtpRoomRecord(room)}`)).catch(() => {});
  }
}

/**
 * Refresh the lobby roster panel on every client still in the selector.
 *
 * `except` skips one client, which is what a fresh logon wants: the arrival's
 * own selector is populated by its RR a moment later, and pushing a roster at a
 * client that has not asked for the room list yet means pushing it at a screen
 * that does not exist.
 */
function gtpBroadcastLobbyRoster(except = null) {
  const waiting = gtpLobbyClients();
  for (const c of waiting) {
    if (c === except) continue;
    Promise.resolve((async () => {
      await c.botPriv(`PLB ${waiting.length}`);
      for (let i = 0; i < waiting.length; i++) {
        await c.botPriv(`PLI ${i} ${gtpPlayerRecord(waiting[i].username)}`);
      }
      await c.botPriv('PLE');
    })()).catch(() => {});
  }
}

// ── logging ──────────────────────────────────────────────────────────────────


// ── the round engine ─────────────────────────────────────────────────────────
//
// Seven rounds, each: composition -> voting -> scoring -> round winner ->
// Fat Chance, then the game-winner screen. Driven by the room, not by a client,
// because every player in the room sees the same segments at the same time.
//
// Every message SHAPE below is recovered from the binary's readers and the
// reference server's own ctor calls. Several field MEANINGS are not:
//
//   confirmed   CLI <index> <name> <line1> <line2>     ctor 0x465f32, args in
//                                                      that order
//               CLB <count> <int> <bool>               ctor 0x465f08; the
//                                                      reference passes (5,1,1)
//                                                      with 5 captions staged
//               SRW <name> <line1> <line2> Pic <bool>x3 Segment
//                                                      ctor 0x465cc0, called
//                                                      with ("Bozo","caption",
//                                                      "captionPart2")
//               SGW <isTie> <count> then count x (<name> <score>) Segment
//                                                      reader 0x44bd7d
//               B   <points:int> <bool>                reader 0x439498
//               BL  <count> then count x B             reader 0x4395e8
//
//   guessed     SV's int and bool, SS's three bools and its int/str, RLI's
//               three ints and bool, CLB's second int and bool, SFCS/SFCR's
//               scalars. All are ints or 1/-1 bools, so a wrong value shows
//               the wrong number on screen rather than throwing -- unlike a
//               wrong FIELD COUNT, which kills the client. The counts are the
//               part that had to be right.
//
// Rules implemented from the published How To Play plus the player accounts:
//   - 45 s composition (60 s for Slimericks), captions up to 160 chars
//   - voting is >= 10 s, longer with more captions
//   - you cannot vote for your own caption
//   - if you do not vote you score nothing that round, UNLESS you were the
//     only entrant
//   - rounds 1-3 score 1 point per vote, 4-6 score 2, round 7 scores 3
//   - ties broken by who submitted first
//   - the round winner plays Fat Chance; swatches run +8 to -4
//   - round 7 is one of four variants, chosen at random

// Fat Chance swatch values. "The swatches range in 'bonus' points from +8 to
// -4" -- one player account, and the only figure anyone gives. Mostly positive,
// a few negative, which matches "most of the swatches will give you bonus
// points, but a few will take points away".
// TEN squares. Twelve was a guess and it was wrong -- there are ten positions
// around the Fat Chance box, confirmed on screen. A 12-long list against a
// 10-square control means the count, the BL list and the control disagree, so
// the index the server picks need not be the square the client reveals.
// B's first field is an INDEX into a value table the CLIENT owns -- not the
// points. Mapped with /fcmap, which fills all ten squares with ONE index and
// leaves them face-up, so the number on screen cannot be a layout artefact:
//
//     index   1   2   3   4   5   6   7   8   9
//     points +2  +3  +4  +6  +8  -1  -2  -4  (blank)
//
// Ascending bonuses, then the penalties -- the order a designer would write.
//
//   * 0 is out of range and kills the client, silently, like every reader
//     failure on this wire.
//   * 9 renders blank, so the usable range is 1..8.
//   * Only EIGHT distinct values exist, so a ten-box board repeats some.
//
// An earlier version of this table had the same eight values in the wrong order.
// It came from sending 1..9 one per box and reading the board back in VISUAL
// order (top row, sides, bottom) while assuming that matched the BL list order.
// It does not. Every payout disagreed with the screen until /fcmap removed the
// layout from the question entirely.
const GTP_FATCHANCE_TABLE = { 1: 2, 2: 3, 3: 4, 4: 6, 5: 8, 6: -1, 7: -2, 8: -4 };

/** A player's running total, for the score box on the Fat Chance board. */
function gtpScoreOf(room, name) {
  const bot = (room.bots || []).find((b) => b.name === name);
  if (bot) return bot.score || 0;
  const c = gtpRoomClients(room).find((x) => x.username === name);
  return (c && c.score) || 0;
}

/** Points the client awards for a swatch index. */
function gtpFcPoints(index) {
  return GTP_FATCHANCE_TABLE[index] || 0;
}

// The board as the real game drew it, read off a screenshot -- 4 6 8 -1 / 3 -4
// / 2 2 3 6 -- stored as the indices that produce those values.
const GTP_FATCHANCE_SWATCHES = [3, 4, 5, 6, 2, 8, 1, 1, 2, 4];

// Per-screen durations. Only the composition and Fat Chance figures are
// published; the rest are paced to be readable.
/**
 * How far before the composition segment expires the caption list is sent.
 *
 * The client runs its own countdown off SC's segment and decides for itself
 * when composition is over. Collecting for the whole window and sending
 * CLB/CLI/CLE at the instant it ends is a race the client kept winning: its
 * phase ended with an empty caption list, so the host announced NobodyComposed
 * ("nobody wrote a caption -- you're only supposed to leave your keyboard
 * during the ad") over a round that had six of them.
 *
 * Closing a little early costs the player the last couple of seconds of typing
 * and keeps the on-screen countdown honest, which is the better trade than
 * padding the segment and showing a countdown that does not match the window.
 */
const GTP_LIST_LEAD_MS = 3000;

const GTP_VOTE_BASE_MS = 10000;      // "at least 10 seconds"
const GTP_VOTE_PER_ENTRY_MS = 2000;  // "the more captions received, the more time"
const GTP_SCORE_MS = 12000;
const GTP_ROUND_WINNER_MS = 7000;
const GTP_FATCHANCE_RESULT_MS = 7000;
const GTP_GAME_WINNER_MS = 30000;

const GTP_FINAL_VARIANTS = [
  { id: 1, name: 'Slimericks' },   // confirmed by observation
  { id: 2, name: 'variant 2' },
  { id: 3, name: 'variant 3' },
  { id: 4, name: 'variant 4' },
];

/** Everyone in the room who can be sent to. */
function gtpRoomSay(room, line) {
  // Keep the latest screen cluster for late joiners.  A screen record is only
  // useful with the caption/results rows that precede it; replaying the screen
  // alone makes the client index an empty list and can terminate the process.
  const tag = line.split(' ', 1)[0];
  const listTags = new Set(['CLB', 'CLI', 'CLE', 'RLB', 'RLI', 'RLE', 'DP']);
  const screenTags = new Set(['SC', 'SV', 'SS', 'SRW', 'SFCS', 'SFCR', 'SGW', 'SP', 'SPicA']);
  room.screenCluster = room.screenCluster || [];
  if (tag === 'DP') {
    room.screenCluster = [line];
    room.lastScreenCluster = null;
  } else if (listTags.has(tag)) {
    room.screenCluster.push(line);
  }
  if (screenTags.has(tag)) {
    room.screenCluster.push(line);
    room.lastScreenCluster = room.screenCluster.slice();
    room.screenCluster = [];
  }
  for (const c of gtpRoomClients(room)) {
    Promise.resolve(c.botPriv(line)).catch(() => {});
  }
}

function gtpRescopeScreen(line, ms = 5000) {
  // All screen messages end in an embedded six-field Segment.  Rebase it for
  // the late joiner so an absolute timestamp from the original player is not
  // already expired when replayed.
  return line.replace(/ S \d+(?: -?\d+){5}$/, ` ${gtpSegmentEndingIn(ms)}`);
}

async function gtpCatchUpRoom(room, client) {
  const cluster = room.lastScreenCluster;
  if (!cluster || !cluster.length || !client.connected || client.room !== room) return;
  const screen = cluster[cluster.length - 1];
  const listData = cluster.slice(0, -1).filter((line) => !line.startsWith('DP '));
  for (const line of listData) {
    if (!client.connected || client.room !== room) return;
    await client.botPriv(line);
  }
  if (!client.connected || client.room !== room) return;
  await client.botPriv(gtpRescopeScreen(screen));
  gtpLog(`STAT: caught "${client.label()}" up to ${screen.split(' ', 1)[0]} in '${room.channel}'.`);
}

function gtpRoomNotice(room, text) {
  gtpRoomSay(room, `PUC ${gtpQuote(text)} ${gtpQuote(GTP_BOT_NICK)}`);
}

/** Point value of a vote in this round. */
function gtpRoundPoints(round) {
  return GTP_POINTS_PER_VOTE[Math.min(Math.max(round, 1), GTP_ROUND_COUNT) - 1];
}

function gtpBumperForRound(room, round) {
  if (round === GTP_ROUND_COUNT) {
    return GTP_BUMPER_BEFORE_FINAL ? GTP_BUMPER_FINAL_INT : null;
  }
  if (round <= 1) return null;
  room.bumperDeck = room.bumperDeck || [];
  if (!room.bumperDeck.length) {
    room.bumperDeck = GTP_BUMPER_MID_INTS.slice();
    for (let i = room.bumperDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.bumperDeck[i], room.bumperDeck[j]] = [room.bumperDeck[j], room.bumperDeck[i]];
    }
  }
  return room.bumperDeck.pop();
}

function gtpBumperAd(room) {
  const have = [...new Set(gtpRoomClients(room).flatMap((c) => c.adsHave || []))];
  if (!have.length) return null;
  room.adDeck = room.adDeck || [];
  if (!room.adDeck.length) {
    room.adDeck = have.slice();
    for (let i = room.adDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [room.adDeck[i], room.adDeck[j]] = [room.adDeck[j], room.adDeck[i]];
    }
    if (room.adDeck.length > 1 && room.adDeck[room.adDeck.length - 1] === room.lastAd) {
      room.adDeck.unshift(room.adDeck.pop());
    }
  }
  room.lastAd = room.adDeck[room.adDeck.length - 1];
  return room.adDeck.pop();
}

function gtpResetFatChance(room) {
  room.fcRevealed = new Set();
  room.fcBoard = GTP_FATCHANCE_SWATCHES.slice();
  for (let i = room.fcBoard.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [room.fcBoard[i], room.fcBoard[j]] = [room.fcBoard[j], room.fcBoard[i]];
  }
}

async function gtpSendBumper(room, number, generation) {
  if (gtpNoAdvertisements()) {
    gtpLog(`STAT: bumper ${number} skipped -- advertisements disabled.`);
    return 0;
  }
  const ad = gtpBumperAd(room);
  if (!ad) {
    gtpLog(`STAT: bumper ${number} skipped -- no downloaded ad is available.`);
    return 0;
  }
  const ads = [ad].slice(0, GTP_BUMPER_AD_COUNT);
  gtpRoomSay(room, `ADLB ${ads.length}`);
  for (let i = 0; i < ads.length; i++) {
    gtpRoomSay(room, `ADLI ${i} ${gtpAdRecord(ads[i])}`);
  }
  gtpRoomSay(room, 'ADLE');
  gtpRoomSay(room, `SPA ${gtpAdRecord(ad)}`);
  if (!await gtpRoomSleepAlive(room, generation, gtpScale(GTP_BUMPER_DOWNLOAD_MS))) return 0;
  const items = ads.map((file) => gtpAdRecord(file)).join(' ');
  const duration = Math.max(GTP_BUMPER_ANIMATION_MS,
    ads.length * GTP_AD_DURATION_MS + GTP_BUMPER_ANIMATION_MS);
  room.bumperReceipt = { ad, before: new Map(
    gtpRoomClients(room).map((c) => [c, c.impressions.length])) };
  gtpRoomSay(room, `SPicA ${number} SA 1 AL ${ads.length} ${items} `
    + gtpSegmentEndingIn(gtpScale(duration)));
  room.bumperRunMs = gtpScale(duration);
  gtpLog(`STAT: bumper ${number} sent with ad ${ad}; expected runtime ${duration} ms.`);
  return room.bumperRunMs;
}

function gtpCheckBumperReceipt(room) {
  if (!room.bumperReceipt) return;
  const { ad, seen } = room.bumperReceipt;
  if (seen) {
    room.bumperReceipt = null;
    return;
  }
  room.pendingBumpers = room.pendingBumpers || [];
  room.pendingBumpers.push(ad);
  room.bumperReceipt = null;
}

function gtpReportUnplayedAds(room) {
  if (!room.pendingBumpers || !room.pendingBumpers.length) return;
  gtpLog(`STAT: no AI receipt for ${room.pendingBumpers.length} bumper ad(s): `
    + room.pendingBumpers.join(', '));
  room.pendingBumpers = [];
}

/**
 * Run one room's whole game, start to finish.
 *
 * Guarded so a second caller cannot start a parallel game in the same room --
 * two loops sending segments to one client would interleave screens.
 */
async function gtpRunGame(room) {
  if (room.running) return;
  room.gameGeneration = (room.gameGeneration || 0) + 1;
  const generation = room.gameGeneration;
  room.running = true;
  room.round = 0;
  room.scores = new Map();
  gtpResetFatChance(room);
  try {
   await gtpPicturesReady;
   gtpDealPictures(room);
   // Game after game, for as long as anyone is in the room.
   //
   // Nothing in the protocol restarts play: the in-room tag table
   // (0x5439c0..0x543a54) has no "new game" message, and SGW is the last thing
   // the client is ever told. It sits on the winner screen indefinitely -- chat
   // keeps working, since that is a different path -- until the server drives
   // the next game exactly as it drove the first.
   for (;;) {
    for (let round = 1; round <= GTP_ROUND_COUNT; round++) {
      if (!gtpCurrent() || room.gameGeneration !== generation) {
        gtpLog(`STAT: room '${room.channel}' -- server reloaded, retiring this game loop.`);
        return;
      }
      if (!gtpRoomClients(room).length) {
        gtpLog(`STAT: room '${room.channel}' emptied -- abandoning the game.`);
        return;
      }
      room.round = round;
      gtpBroadcastRoomUpdate(room);
      const bumper = gtpBumperForRound(room, round);
      if (bumper !== null) {
        const runMs = await gtpSendBumper(room, bumper, generation);
        if (runMs && !await gtpRoomSleepAlive(room, generation, runMs)) return;
        if (room.gameGeneration !== generation || !gtpCurrent()) return;
        gtpCheckBumperReceipt(room);
      }
      await gtpComposition(room, round, generation);
      if (room.gameGeneration !== generation) return;
      await gtpVoting(room, round, generation);
      if (room.gameGeneration !== generation) return;
      const winner = await gtpScoring(room, round, generation);
      if (room.gameGeneration !== generation) return;
      if (winner) {
        await gtpRoundWinner(room, round, winner, generation);
        if (room.gameGeneration !== generation || !gtpCurrent()) return;
        // NO FAT CHANCE ON THE FINAL ROUND -- the announcer says "no more fat
        // chances" at the end of round 7, and we were sending a board anyway.
        // The last round is settled on captions alone and goes straight to SGW;
        // a bonus swatch afterwards could flip a result the players have
        // already watched being decided.
        if (round < GTP_ROUND_COUNT) {
          await gtpFatChance(room, round, winner, generation);
        } else {
          gtpLog(`STAT: round ${round} is the final round -- no Fat Chance, `
            + `straight to the game winner.`);
        }
      }
    }
    await gtpGameWinner(room, generation);
    gtpReportUnplayedAds(room);

    if (!gtpCurrent() || room.gameGeneration !== generation || !gtpRoomClients(room).length) {
      gtpLog(`STAT: room '${room.channel}' emptied -- no further games.`);
      return;
    }
    // Back to the picture screen, the same way the first game began.
    room.round = 0;
    room.scores = new Map();
    room.bumperDeck = [];
    room.adDeck = [];
    room.lastAd = null;
    room.pendingBumpers = [];
    gtpResetFatChance(room);
    for (const b of room.bots || []) b.score = 0;
    gtpDealPictures(room);
    gtpLog(`STAT: room '${room.channel}' -- starting the next game.`);
    gtpRoomSay(room, `SP ${gtpPicRecord(room.picture)} `
      + gtpSegmentEndingIn(gtpScale(10000), 0));
    gtpRoomSay(room, `DP ${gtpPicRecord(room.picture)}`);
    if (!await gtpRoomSleepAlive(room, generation, gtpScale(6000))) return;
   }
  } catch (e) {
    gtpLog(`STAT: room '${room.channel}' game loop failed: ${e && e.stack || e}`);
  } finally {
    room.running = false;
    room.round = 0;
    gtpBroadcastRoomUpdate(room);
  }
}

/** Round 7 is one of four twists; 1-6 are plain. */
function gtpVariantFor(round) {
  if (GTP_FORCED_VARIANT !== null) return { id: GTP_FORCED_VARIANT, name: `forced variant ${GTP_FORCED_VARIANT}` };
  if (round < GTP_ROUND_COUNT) return { id: GTP_VARIANT_PLAIN, name: 'composition' };
  const id = GTP_FINAL_VARIANT_IDS[Math.floor(Math.random() * GTP_FINAL_VARIANT_IDS.length)];
  const names = {
    [GTP_VARIANT_TABHEADS]: 'Tabheads',
    [GTP_VARIANT_SLIMERICKS]: 'Slimericks',
    [GTP_VARIANT_COPYFITS]: 'Copyfits',
    [GTP_VARIANT_BILLBOREDS]: 'Billboreds',
  };
  return { id, name: names[id] || `final round (variant ${id})` };
}

async function gtpComposition(room, round, generation) {
  const variant = gtpVariantFor(round);
  const pic = gtpNextPicture(room);
  const ms = gtpScale((variant.id === GTP_VARIANT_SLIMERICKS) ? GTP_SLIMERICK_MS : GTP_COMP_MS);
  room.variant = variant;
  room.picture = pic;
  room.entries = [];
  room.votes = new Map();          // voter name -> entry index
  room.compStart = Date.now();

  gtpLog(`STAT: room '${room.channel}' round ${round}/${GTP_ROUND_COUNT} -- `
         + `${variant.name}, ${ms / 1000}s, ${gtpRoundPoints(round)} point(s) per vote.`);

  const [, , d] = GTP_COMP_SEGMENT_BCD;
  // DP first, and only when the image actually changed. Re-sending it every
  // round made the client re-fetch the same JPEG and re-enter the picture
  // screen on top of the round that had just started.
  if (room.shownPicture !== pic.id) {
    gtpRoomSay(room, `DP ${gtpPicRecord(pic)}`);
    room.shownPicture = pic.id;
  }
  // Copyfits is the only variant that reads the three strings.
  const words = (variant.id === GTP_VARIANT_COPYFITS)
    ? GTP_COPYFITS_WORDS[Math.floor(Math.random() * GTP_COPYFITS_WORDS.length)]
    : ['', '', ''];
  room.copyfits = (variant.id === GTP_VARIANT_COPYFITS) ? words : null;
  gtpRoomSay(room, `SC ${round} ${gtpPicRecord(pic)} ${variant.id} `
    + `${gtpQuote(words[0])} ${gtpQuote(words[1])} ${gtpQuote(words[2])} `
    + gtpSegmentEndingIn(ms, d));

  // Close early enough that CLB/CLI/CLE lands while the client still considers
  // the composition phase live -- see GTP_LIST_LEAD_MS.
  const collectMs = Math.max(1000, ms - gtpScale(GTP_LIST_LEAD_MS));
  if (!await gtpRoomSleepAlive(room, generation, collectMs)) return;

  // Captions written for THIS picture if the manifest carries them, so the bots
  // stop describing tubes while a hedgehog is on screen. Shuffled per round so
  // the same eight never arrive in the same order.
  const pool = ((pic && pic.captions && pic.captions.length)
    ? pic.captions.slice() : GTP_BOT_CAPTIONS.slice());
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  // Bots submit late, so a human's own caption is in first and the tie-break
  // by submission order stays honest.
  const twoLines = variant.id === GTP_VARIANT_SLIMERICKS;
  for (const bot of room.bots || []) {
    if (room.entries.some((e) => e.name === bot.name)) continue;
    const line1 = pool[room.entries.length % pool.length];
    let line2 = twoLines
      ? pool[(room.entries.length + (room.bots || []).length) % pool.length]
      : '';
    if (twoLines && line2 === line1) line2 = pool[(room.entries.length + 1) % pool.length];
    room.entries.push({
      name: bot.name,
      line1,
      line2,
      at: room.compStart + collectMs - 1,
      bot: true,
    });
  }
  gtpLog(`STAT: round ${round} closed with ${room.entries.length} caption(s).`);
}

async function gtpVoting(room, round, generation) {
  const entries = room.entries;
  if (!entries.length) {
    gtpRoomNotice(room, 'Nobody wrote a caption this round.');
    return;
  }
  // "The more captions received, the more time you have to vote."
  const ms = gtpScale(GTP_VOTE_BASE_MS + Math.max(0, entries.length - 1) * GTP_VOTE_PER_ENTRY_MS);

  // The caption list is anonymous -- "all players' captions are displayed on the
  // screen, but without any indication of which player entered which caption"
  // -- with ONE exception: each client is told which row is its own.
  //
  // The client keeps track of its own caption. It has a Resources\Sfx\
  // OwnCaptionSelected.srf to play when your caption wins, so it must be able
  // to pick your row out of the list, and the only field that could carry that
  // is CLI's name.
  //
  // Sending every name empty is what killed the client. Two games in one log
  // settled it: the one where the player typed a caption died right after SRW
  // (the round-winner screen, which is where "did mine win?" would be asked),
  // and the one where the player typed nothing ran on to round 2. Everything
  // else about the two rounds was identical, and SRW's own wire format checks
  // out against its reader (0x44b723) field for field.
  //
  // So the list is now built per recipient: your row carries your name, every
  // other row stays blank. Anonymity is preserved -- you only ever learn which
  // caption is yours, which you already knew.
  // AWAITED, not fired off: SV opens voting on the list, so every CLI row and
  // the CLE that closes them have to be on the wire first. Sending these
  // concurrently let SV overtake the rows.
  await Promise.all(gtpRoomClients(room).map(async (c) => {
    const mine = c.username;
      // CLB's third field is the ONLY one its handler reads (0x43f49c ->
      // FUN_00448c8d = "mov al, byte [ecx+0xc]"); count and round are ignored
      // there. The host was announcing NobodyComposed.srf on rounds that had
      // seven captions, and this bit is the only thing CLB tells the control,
      // so it reads as "nobody composed" -- true when the list is empty.
      //
      // Flip it live with gtpNobodyComposed(true) if this turns out backwards.
      await c.botPriv(
        `CLB ${entries.length} ${round} ${gtpBool(
          GTP_CLB_FLAG ?? (room.variant.id === GTP_VARIANT_SLIMERICKS || !entries.length))}`);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      // CLI's name is the VOTE IDENTITY, not a display field. The client votes
      // with "V <n> <author>", taking the name straight off the row it clicked,
      // so blanking these left it unable to say what it had picked and every
      // vote arrived as an empty string. The client hides authors on screen by
      // itself -- that is what "displayed without any indication of who entered
      // which caption" describes. Sending real names is required, not a leak.
      await c.botPriv(
        `CLI ${i} ${gtpQuote(e.name)} ${gtpQuote(e.line1)} ${gtpQuote(e.line2 || '')}`);
    }
    await c.botPriv('CLE');
  })).catch((err) => gtpLog(`STAT: caption list failed: ${err}`));
  // -1 is what makes the voting screen appear and keeps the host from
  // announcing that nobody composed. Confirmed by hand: -1 shows the clickable
  // rows, 1 fires the line and leaves the screen blank.
  gtpRoomSay(room, `SV ${entries.length} ${gtpPicRecord(room.picture)} `
    + `${gtpBool(false)} ${gtpSegmentEndingIn(ms)}`);
  // A late joiner's list control may only become writable at this phase
  // transition; refresh the full roster while the voting screen is live.
  gtpPushRoster(room);
  gtpLog(`STAT: voting open for ${ms / 1000}s on ${entries.length} caption(s).`);

  if (!await gtpRoomSleepAlive(room, generation, ms)) return;

  // Bots vote for someone other than themselves.
  for (const bot of room.bots || []) {
    if (room.votes.has(bot.name)) continue;
    const choices = entries.map((e, i) => i).filter((i) => entries[i].name !== bot.name);
    if (choices.length) {
      room.votes.set(bot.name, choices[Math.floor(Math.random() * choices.length)]);
    }
  }
  gtpLog(`STAT: ${room.votes.size} vote(s) cast.`);
}

/**
 * Tally, award, and show the results. Returns the round winner, or null.
 */
async function gtpScoring(room, round, generation) {
  const entries = room.entries;
  if (!entries.length) return null;
  const perVote = gtpRoundPoints(round);

  for (const e of entries) e.votes = 0;
  for (const [, idx] of room.votes) {
    if (entries[idx]) entries[idx].votes += 1;
  }

  // "if you do not vote at all, you cannot collect the points in that round".
  // The rules give one exception: a lone entrant need not vote, since there is
  // nobody else to vote for.
  const lone = entries.length === 1;
  for (const e of entries) {
    const voted = room.votes.has(e.name);
    e.eligible = voted || lone;
    e.points = e.eligible ? e.votes * perVote : 0;
    if (!e.eligible && e.votes) {
      gtpLog(`STAT: "${e.name}" got ${e.votes} vote(s) but did not vote -- no points.`);
    }
    gtpAddScore(room, e.name, e.points);
  }

  // "Ties are broken by speed; the player who entered his or her caption
  // quickest among the tied players will be the round winner."
  //
  // Ranked by POINTS, not raw votes: the no-vote rule zeroes a player who did
  // not vote, so ranking by votes could crown someone with 0 points, and the
  // results list then carried "2 votes, 0 points, WINNER" -- which contradicts
  // itself and the score the roster shows a moment later.
  const ranked = entries.slice()
    .sort((a, b) => (b.points - a.points) || (b.votes - a.votes) || (a.at - b.at));
  const winner = ranked[0].points > 0 ? ranked[0] : null;

  // RLB's bool is the DOUBLE-POINTS flag. Hardcoding it true made the
  // announcer say "we're in the second half, points are worth double" from
  // round one; it has to follow the actual scoring, which doubles from round 4.
  gtpRoomSay(room, `RLB ${entries.length} ${round} ${perVote} ${gtpBool(perVote > 1)}`);
  // The index has to be the CAPTION's index in the CLI list just sent, not the
  // player's rank -- that is what ties a name to the caption it belongs to.
  // Sending the rank put every name against the wrong caption, which on screen
  // read as no names at all.
  ranked.forEach((e) => {
    const at = entries.indexOf(e);
    gtpRoomSay(room, `RLI ${at} ${gtpQuote(e.name)} ${e.votes} ${e.points} `
      // Marks the winning row. Sending FALSE here was tried, on the theory
      // that it blanked the winner's caption -- it does not. With every row
      // identical the winner is still highlighted and still has no text, so
      // both come from elsewhere (SS is the only other message naming them).
      + `${gtpScoreOf(room, e.name)} ${gtpBool(winner === e)}`);
  });
  gtpRoomSay(room, 'RLE');
  // SS's FIRST bool is handed straight to the captions control:
  //
  //   FUN_00450d40 (PictureView vf 0xc0, the SS handler)
  //     scoreScreen->Set(msg)
  //     ctl = *(this+0xa4)                     the CAPTIONS control
  //     b   = FUN_0041e4e4(msg)                "mov al,[ecx+0x18]" -- bool #1
  //     ctl->vf 0x64(b)
  //
  // All three were false because that is what I picked, with nothing observed
  // to go on. The control has a NobodyVoted path of its own
  // (CaptionsControlNobodyVotedDoneMsg, and Resources\Voice\NobodyVoted.srf),
  // and the host kept announcing it over a round that had captions and votes --
  // then the client died on this very message, which is the last thing the
  // drop-out report showed it processing.
  //
  // So bool #1 reads as "somebody voted", and asserting the opposite drove the
  // control into its nobody-voted state while a full results list was on
  // screen. Bools #2 and #3 are only copied into the score screen
  // (FUN_0045934f); nothing observed says what they mean, so they stay false.
  // SS = StartScoreRoomMsg. Its FIRST bool is the caption-row display gate.
  //
  //                SS handler, FUN_00450d40 (PictureView vf 0xc0)
  //                  ctl = *(this+0xa4)              the CaptionsControl
  //                  b   = msg+0x18                  bool #1
  //                  ctl->vf 0x64(b)                 = FUN_004261ed:
  //                                                      this+0x1a8 = b
  //
  //                FUN_00423de0, the routine that puts the rows on screen:
  //                  if (this+0x1a8 == 0)
  //                      for each caption row: show it, enable it
  //
  //              and the bool READER, FUN_004ad111:
  //                  "1"  stores 1
  //                  "-1" stores 0        <-- "-1" is not -1 in memory, it is ZERO
  //
  //              So bool #1 = 1 means "do not show the caption rows" and -1 means
  //              "show them". Sending 1 is why the voting screen was blank and why
  //              nothing could be clicked -- the rows were never shown or enabled.
  //
  //              This also explains why flipping it earlier changed nothing: the
  //              OTHER place that reads +0x1a8 (0x423de8) tests != 0, so 1 and -1
  //              looked identical there. Only this display gate distinguishes them.
  const showRows = false;
  // The int is an INDEX INTO THE CAPTION LIST, not a count.
  //
  // This was the caption count, and the client died on this message every
  // single time -- the drop-out report named it on every run, through every
  // other change. With N captions the valid indices are 0..N-1, so sending N
  // is one past the end, and the ScoringScreen reads it to find the winning
  // caption. Its sibling RLI indexes the same list the same way (that was
  // already settled: RLI carries the caption's index, not its rank), so a bare
  // count is the odd one out in this family.
  const winnerIdx = winner ? entries.indexOf(winner) : 0;
  gtpRoomSay(room, `SS ${gtpBool(showRows)} ${gtpBool(false)} ${gtpBool(false)} `
    // Naming the winner here HIGHLIGHTS that row and HIDES its caption --
    // one mechanism, not two. That is deliberate suspense: the results screen
    // shows who won without spoiling what they wrote, and SRW reveals the
    // caption a moment later. Sending -1 restores the text but loses the
    // highlight, which is the worse trade.
    + `${winnerIdx} ${gtpQuote(winner ? winner.name : '')} `
    + gtpSegmentEndingIn(gtpScale(GTP_SCORE_MS)));

  gtpLog(`STAT: round ${round} results -- `
         + ranked.map((e) => `${e.name}:${e.votes}v/${e.points}p`).join(' '));

  // The roster carries the running totals, and the screenshots show it
  // resorted with the leader on top.
  gtpPushRoster(room);
  if (!await gtpRoomSleepAlive(room, generation, gtpScale(GTP_SCORE_MS))) return null;
  return winner;
}

async function gtpRoundWinner(room, round, winner, generation) {
  gtpRoomSay(room, `SRW ${gtpQuote(winner.name)} ${gtpQuote(winner.line1)} `
    + `${gtpQuote(winner.line2 || '')} ${gtpPicRecord(room.picture)} `
    + `${gtpBool(true)} ${gtpBool(true)} ${gtpBool(false)} `
    + gtpSegmentEndingIn(gtpScale(GTP_ROUND_WINNER_MS)));
  gtpLog(`STAT: round ${round} winner is "${winner.name}" with ${winner.votes} vote(s).`);
  await gtpRoomSleepAlive(room, generation, gtpScale(GTP_ROUND_WINNER_MS));
}

/**
 * Fat Chance: the round winner picks one spinning swatch, most of which add
 * points and a few of which subtract.
 */
async function gtpFatChance(room, round, winner, generation) {
  if (!room.fcBoard || room.fcBoard.length !== GTP_FATCHANCE_SWATCHES.length) {
    gtpResetFatChance(room);
  }
  const swatches = room.fcBoard;
  room.fcRevealed = room.fcRevealed || new Set();
  let hidden = new Set(swatches.map((_, i) => i));
  for (const i of room.fcRevealed) hidden.delete(i);
  if (!hidden.size) {
    room.fcRevealed = new Set();
    hidden = new Set(swatches.map((_, i) => i));
  }
  // <index> <revealed?>. The index goes verbatim -- it is not a magnitude --
  // and the bool decides whether that square starts face-up: 1 shows it, -1
  // covers it. Confirmed both ways on screen.
  const list = `BL ${swatches.length} `
    + swatches.map((v, i) => `B ${Math.abs(v)} ${gtpBool(!hidden.has(i))}`).join(' ');
  room.fatChance = { swatches, winner: winner.name, picked: null, hidden };

  // Third field is the WINNER'S SCORE, not the swatch count -- the board
  // prints it in the score box, and the count already travels inside BL.
  //
  // The bool is the winner flag, and it is INVERTED like everything else on
  // this wire: "1" stores 1, "-1" stores 0, and the capability gates on zero,
  // so -1 is the one that means "you won".
  // THE CLICK GATE -- see gtp-server.py for the Frida trace that proved it.
  // This bool becomes byte [control+0x420] via the setup call at 0x45927b, and
  // 0x427900 refuses every click while that byte is zero. "-1" stores 0, so the
  // board is only clickable when this is TRUE.
  gtpRoomSay(room, `SFCS ${round} ${gtpQuote(winner.name)} ${gtpScoreOf(room, winner.name)} ${list} `
    + `${gtpBool(true)} ${gtpScale(GTP_FATCHANCE_MS)} ${gtpSegmentEndingIn(gtpScale(GTP_FATCHANCE_MS))}`);
  gtpLog(`STAT: Fat Chance for "${winner.name}" -- ${GTP_FATCHANCE_MS / 1000}s to pick.`);

  if (!await gtpRoomSleepAlive(room, generation, gtpScale(GTP_FATCHANCE_MS))) return;

  // Whoever did not pick in time gets one chosen for them; the rules make the
  // round winner take a swatch either way.
  let idx = room.fatChance.picked;
  if (idx === null || idx === undefined || !Number.isInteger(idx)
      || idx < 0 || idx >= swatches.length) {
    const choices = [...hidden];
    idx = choices[Math.floor(Math.random() * choices.length)];
    gtpLog(`STAT: no pick in time -- taking swatch ${idx} for "${winner.name}".`);
  }
  // swatches holds INDICES, so the points come from the table -- the same
  // table the client scores from, which is what makes the chat line and the
  // announcer quote the same number instead of each inventing one.
  const value = gtpFcPoints(swatches[idx]);
  room.fatChance = null;
  room.fcRevealed.add(idx);
  gtpAddScore(room, winner.name, value);
  // Trailing pair is <position> <index>, matching BL's own spelling; the client
  // looks the points up itself.
  gtpRoomSay(room, `SFCR ${gtpQuote(winner.name)} ${list} ${idx} ${swatches[idx]} `
    + gtpSegmentEndingIn(gtpScale(GTP_FATCHANCE_RESULT_MS)));
  gtpPushRoster(room);
  gtpRoomNotice(room, `${winner.name} ${value >= 0 ? 'receives' : 'loses'} `
    + `${Math.abs(value)} point${Math.abs(value) === 1 ? '' : 's'}!`);
  gtpLog(`STAT: Fat Chance swatch ${idx} = ${value} for "${winner.name}".`);
  gtpPushRoster(room);
  await gtpRoomSleepAlive(room, generation, gtpScale(GTP_FATCHANCE_RESULT_MS));
}

async function gtpGameWinner(room, generation) {
  let roster = gtpRoster(room);
  // SGW is the only message carrying the WHOLE roster in one line, and the
  // client's tokenizer buffer is 0x201 bytes (0x4ad902). About 28 players fit;
  // past that the line is refused by botPriv and the final screen never
  // appears. Trim to the leaders rather than lose the screen entirely.
  const MAX = 24;
  if (roster.length > MAX) {
    gtpLog(`STAT: ${roster.length} players -- SGW trimmed to the top ${MAX} to fit the client buffer.`);
    roster = roster.slice(0, MAX);
  }
  const top = roster.length ? roster[0].score : 0;
  const tie = roster.filter((p) => p.score === top).length > 1;
  const pairs = roster.map((p) => `${gtpQuote(p.name)} ${p.score}`).join(' ');
  gtpRoomSay(room, `SGW ${gtpBool(tie)} ${roster.length} ${pairs} `
    + gtpSegmentEndingIn(gtpScale(GTP_GAME_WINNER_MS)));
  gtpLog(`STAT: game over in '${room.channel}' -- `
         + roster.map((p) => `${p.name}:${p.score}`).join(' ')
         + (tie ? '  (tie)' : ''));
  await gtpRoomSleepAlive(room, generation, gtpScale(GTP_GAME_WINNER_MS));
}

// ── score bookkeeping ────────────────────────────────────────────────────────

function gtpAddScore(room, name, points) {
  if (!points) return;
  room.scores = room.scores || new Map();
  room.scores.set(name, (room.scores.get(name) || 0) + points);
  // Mirror onto whichever object owns the roster entry, so PLI and SGW agree.
  const bot = (room.bots || []).find((b) => b.name === name);
  if (bot) bot.score = room.scores.get(name);
  for (const c of gtpRoomClients(room)) {
    if (c.username === name) c.score = room.scores.get(name);
  }
}

function gtpScoreOf(room, name) {
  return (room.scores && room.scores.get(name)) || 0;
}

/** Re-send the roster so every client's list shows the new totals and order. */
function gtpPushRoster(room) {
  const roster = gtpRoster(room);
  for (const c of gtpRoomClients(room)) {
    Promise.resolve((async () => {
      if (!c.connected || c.room !== room) return;
      await c.botPriv(`PLB ${roster.length}`);
      if (!c.connected || c.room !== room) return;
      for (let i = 0; i < roster.length; i++) {
        await c.botPriv(`PLI ${i} ${gtpPlayerRecord(roster[i].name, roster[i].score)}`);
        if (!c.connected || c.room !== room) return;
      }
      await c.botPriv('PLE');
    })()).catch(() => {});
  }
}

let gtpSeq = 0;
const gtpStart = Date.now();

function gtpLog(msg) { console.log(`[gtp] ${msg}`); }

// ── surviving a Reload Server ────────────────────────────────────────────────
//
// Reload Server re-evaluates this file into a FRESH scope with a fresh gtpRooms
// map. The previous scope does not go away: its game loop is sitting in an
// await, and when the timer fires it carries on driving whichever clients it
// still holds. The observed result was two games running in one room at once,
// one on round 6 and one on round 1, interleaved in the log.
//
// A generation counter on window is the one thing both scopes can see. Each
// load claims the next number; a loop whose generation is no longer current
// stops at its next checkpoint.
window.__gtpGeneration = (window.__gtpGeneration || 0) + 1;
const GTP_GENERATION = window.__gtpGeneration;
if (GTP_GENERATION > 1) {
  console.log(`[gtp] server reloaded (generation ${GTP_GENERATION}); `
              + 'game loops from the previous load will stop at their next step.');
}

/** False once a newer copy of this file has been loaded. */
function gtpCurrent() {
  return window.__gtpGeneration === GTP_GENERATION;
}

/**
 * Override for CLB's bool. null = derive it (true only when no captions came
 * in); set true/false from devtools with gtpNobodyComposed() to test it.
 */
let GTP_CLB_FLAG = (typeof window !== 'undefined'
  && window.gtpSettings && window.gtpSettings.enabled
  && window.gtpSettings.forceNobodyComposed)
  ? true : null;

/** How many recent messages to keep per client for the drop-out report. */
const GTP_TAIL_KEEP = 8;

/** Message tags suppressed by gtpSkip(), for bisecting client-side crashes. */
const GTP_SKIP = new Set();

const gtpSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sleep, then report whether this loop is still the current one. Every game
 * phase waits through this, so a reload retires an in-flight round rather than
 * only stopping between rounds.
 */
async function gtpSleepAlive(ms) {
  await gtpSleep(ms);
  return gtpCurrent();
}

async function gtpRoomSleepAlive(room, generation, ms) {
  await gtpSleep(ms);
  return gtpCurrent() && room.gameGeneration === generation
    && gtpRoomClients(room).length > 0;
}

/**
 * Scale every game duration. window.gtpTimeScale = 0.05 makes a seven-round
 * game run in about thirty seconds, which is the difference between being able
 * to test the back half of the game and not.
 *
 * Applied to the segment the client is told about as well as to the server's
 * own wait, so the countdown on screen still matches reality.
 */
function gtpScale(ms) {
  const f = (typeof window !== 'undefined' && window.gtpTimeScale) || 1;
  return Math.max(250, Math.round(ms * f));
}

/** Milliseconds since this server object was created -- the wire clock. */
function gtpNow() { return (Date.now() - gtpStart) >>> 0; }

/** STX is invisible in a terminal; show it so logged lines stay readable. */
function gtpShow(line) { return line.replace(/\x02/g, '\\x02'); }

// ── client ───────────────────────────────────────────────────────────────────

class GtpClient {
  constructor(conn) {
    this.conn = conn;
    this.id = ++gtpSeq;
    this.connected = true;
    this.registered = false;
    this.nick = null;
    this.username = null;
    this.version = '1 0 0 27';
    this.room = null;          // set once the client logs on to a room channel
    this.pendingRoom = null;   // room channel JOINed, not yet logged on to
    this.loggedOn = false;
    this.sentPreflight = false;
    this.captions = [];
    this.score = 0;
    this.hidden = false;
    this.adsHave = [];
    this.impressions = [];
    // conn has no write() -- take a writer off its WritableStream, the same
    // way cosmic-server.js's GameClient does. Calling conn.write() threw on
    // the very first line (the 001 welcome), and because sendRaw swallowed
    // the error the client just vanished with no diagnostic.
    this.writer = conn.writable.getWriter();
    this.buf = new Uint8Array(0);
    this.recorded = [];
    this.lastSent = [];      // ring of recent sends, for the drop-out report
    this.saidQuit = false;   // set on QUIT, so a clean exit is not reported
  }

  label() { return this.username || this.nick || `(unregistered #${this.id})`; }

  async sendRaw(line) {
    if (!this.connected) return false;
    gtpLog(`SEND [${this.label()}]: ${gtpShow(line)}`);
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

  /**
   * A game message, which on the wire is an IRC PRIVMSG from the bot.
   *
   * The tokenizer buffer is 0x201 bytes wide (0x4ad902), so anything past ~512
   * characters is silently truncated mid-field and then throws in the reader.
   * Better to refuse it here with a diagnostic than to kill the client.
   */
  botPriv(body) {
    // Bisect aid. The client dies with no QUIT and no error output, so the only
    // way to identify the message that kills it is to stop sending candidates
    // and see whether it survives. From devtools:
    //
    //   gtpSkip('SRW')        drop every SRW
    //   gtpSkip('SRW','SS')   drop both
    //   gtpSkip()             send everything again (the default)
    //
    // If the client lives past the point it used to die, the dropped message is
    // the culprit; if it still dies, it is not.
    const tag = body.split(' ', 1)[0];
    // Keep the last few messages so a drop-out can be read back. The client
    // dies with no QUIT and no error output, and the browser log is usually
    // truncated by the time anyone looks, so the tail has to be captured here.
    this.lastSent.push(body);
    if (this.lastSent.length > GTP_TAIL_KEEP) this.lastSent.shift();
    if (GTP_SKIP.has(tag)) {
      gtpLog(`STAT: gtpSkip -- dropping ${tag} (${body.length} chars).`);
      return Promise.resolve(false);
    }
    if (body.length > 500) {
      gtpLog(`STAT: refusing ${body.length}-char message -- the client tokenizer holds 512.`);
      return Promise.resolve(false);
    }
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

  // ── IRC ────────────────────────────────────────────────────────────────────

  async handleLine(line) {
    gtpLog(`RECV [${this.label()}]: ${gtpShow(line)}`);
    const parts = line.split(' ');
    const cmd = (parts[0] || '').toUpperCase();
    const rest = parts.slice(1);

    switch (cmd) {
      case 'NICK':
        this.nick = rest[0] || `gtp${this.id}`;
        return this.maybeRegister();
      case 'USER':
        this.ircUser = rest[0] || 'user';
        return this.maybeRegister();
      case 'PING':
        return this.sendRaw(`:${GTP_SERVER_NAME} PONG ${GTP_SERVER_NAME} :${rest[0] || GTP_SERVER_NAME}`);
      case 'PONG':
      case 'MODE':
        return;
      case 'CAP':
        return this.sendRaw('CAP * LS :');
      case 'JOIN':
        return this.handleJoin(rest[0] || '');
      case 'PART':
        return this.handlePart(rest[0] || '');
      case 'PRIVMSG':
        return this.handlePrivmsg(line);
      case 'QUIT':
        this.saidQuit = true;
        this.connected = false;
        this.leaveRoom();
        return this.sendRaw(`ERROR :Closing Link: ${this.nick} (Client Quit)`);
      default:
        gtpLog(`RECORD unhandled IRC verb: ${line}`);
        return;
    }
  }

  async maybeRegister() {
    if (this.registered || !this.nick || !this.ircUser) return;
    this.registered = true;
    gtpClients.add(this);
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

  /**
   * A JOIN is how the client states which room it wants: the lobby channel from
   * dispatch.ini, or the `channel` field of the room record it picked.
   *
   * The LN that closes this opens the logon handshake. It is also where the
   * client learns the bot's nick -- RoomProxy::HandleMsg (0x4b71d1) copies the
   * sender of LN into proxy+0x2c and replies to that -- so LN has to come from
   * GTP_BOT_NICK on both channels.
   */
  async handleJoin(channel) {
    const chan = (channel.replace(/^:/, '').replace(/^#/, '')) || GTP_LIST_CHANNEL;
    const isList = chan.toLowerCase() === GTP_LIST_CHANNEL.toLowerCase();

    await this.sendRaw(`:${GTP_BOT_NICK}!${GTP_BOT_NICK}@${GTP_SERVER_NAME} JOIN #${chan}`);
    await this.sendRaw(`:${this.nick}!${this.nick}@${GTP_SERVER_NAME} JOIN #${chan}`);
    await this.sendRaw(`:${GTP_SERVER_NAME} 353 ${this.nick} = #${chan} :@${GTP_BOT_NICK} ${this.nick}`);
    await this.sendRaw(`:${GTP_SERVER_NAME} 366 ${this.nick} #${chan} :End of /NAMES list.`);

    if (isList) {
      this.pendingRoom = null;
      gtpLog(`STAT: "${this.label()}" entered the lobby channel #${chan}.`);
    } else if (gtpRoom(chan) || GTP_ROOM_CHANNEL_PATTERN.test(chan)) {
      // The room the player picked in the selector. Nothing the client sends
      // after this names the room again -- RS carries two integers and no name
      // -- so this JOIN is the only statement of intent.
      this.pendingRoom = chan;
      gtpLog(`STAT: "${this.label()}" selected game room #${chan}.`);
    } else {
      // Almost certainly another game's client routed here by the Server
      // dropdown. Say so plainly rather than inventing a room for it: the old
      // behaviour put a phantom entry in the room list that real GTP clients
      // could then see and try to join.
      this.pendingRoom = null;
      gtpLog(`STAT: #${chan} is not a Get The Picture channel -- not entering a room.`);
      gtpLog('STAT: that usually means another game\'s client connected while the '
             + 'Server dropdown was on GTP. Switch it, or start that game\'s own server.');
    }

    await this.botPriv('LN 0');
  }

  async handlePart(channel) {
    const chan = channel.replace(/^:/, '').replace(/^#/, '');
    await this.sendRaw(`:${this.nick}!${this.nick}@${GTP_SERVER_NAME} PART #${chan}`);
    if (this.room && this.room.channel === chan) this.leaveRoom();
  }

  // ── game tokens ────────────────────────────────────────────────────────────

  async handlePrivmsg(line) {
    // "PRIVMSG <target> :<body>"
    const idx = line.indexOf(' :');
    const body = idx >= 0 ? line.slice(idx + 2) : '';
    const parts = body.split(' ').filter((s) => s.length);
    const token = (parts[0] || '').toUpperCase();

    switch (token) {
      case 'L':      return this.handleL(parts);
      case 'RR':     return this.handleRR();
      case 'RS':     return this.handleRS(parts);
      case 'LO':     return this.handleLO(parts);
      case 'LER':    return this.handleLER();
      case 'LSR':
        // PLI rows sent before LSA are parsed but rejected by the roster
        // control.  Answer the client's list-sync request before rebuilding
        // its complete live roster.
        gtpLog(`STAT: "${this.label()}" requested a player-list resync (LSR).`);
        if (this.room && this.connected) {
          await this.botPriv('LSA');
          const roster = gtpRoster(this.room);
          await this.botPriv(`PLB ${roster.length}`);
          for (let i = 0; i < roster.length; i++) {
            if (!this.connected || !this.room) return;
            await this.botPriv(`PLI ${i} ${gtpPlayerRecord(roster[i].name, roster[i].score)}`);
          }
          await this.botPriv('PLE');
        }
        return;
      case 'LSA':    return;   // acknowledgement of a server list sync
      case 'AI':
        // AI <bool> Ad <file> <name> <code> -- the ad played. Cosmic treats
        // this as "the client is ready"; here it is the cue that the next
        // segment is what it is waiting for.
        //
        // The bool is whether the viewer dismissed the ad rather than letting
        // it run out: pressing space during playback sends 1, sitting through
        // it sends -1. (Confirmed by the player, not from the binary -- both
        // values were seen for the same ad file, differing only by the
        // keypress.) Nothing here depends on it; a real ad server would have
        // used it to tell a watched impression from a skipped one.
        {
          const fields = gtpFields(body);
          const adAt = fields.indexOf('Ad');
          const ad = adAt >= 0 ? (fields[adAt + 1] || '') : (fields[2] || fields[1] || '');
          this.impressions.push({ ad, at: Date.now() });
          if (ad && this.room && this.room.bumperReceipt
              && ad === this.room.bumperReceipt.ad) {
            this.room.bumperReceipt.seen = true;
            this.room.pendingBumpers = (this.room.pendingBumpers || [])
              .filter((name) => name !== ad);
          }
        }
        gtpLog(`STAT: "${this.label()}" reported an ad impression: ${gtpShow(body)}`);
        gtpLog('STAT: the client should follow with RR, which is answered with the preflight segment.');
        return;
      case 'GP':
        gtpLog(`STAT: "${this.label()}" went public.`);
        return;
      case 'PV':
        // PictureViewedRoomMsg <ushort>. The client acknowledging a picture it
        // has fetched and shown -- so this arriving is the proof that DP and
        // the JPEG both worked, and the cue that the screen is ready for a
        // round rather than still downloading.
        gtpLog(`STAT: "${this.label()}" viewed picture id ${parts[1] || '?'} -- the image decoded.`);
        // The room screen is live now, so this is when the bots may arrive.
        // The first round waits for them: the burst is paced at
        // GTP_BOT_JOIN_STAGGER_MS each, and starting composition straight away
        // put SC on the wire with two of the eight seated, so the round began
        // against a half-empty player list.
        if (this.room && this.room.pendingBots) {
          this.room.pendingBots = false;
          Promise.resolve((async () => {
            await gtpEvictBotsFor(this.room);
            await this.joinBots(this.room);
            if (GTP_AUTO_COMP && this.room && !this.room.round) await this.startComp();
          })()).catch((e) => gtpLog(`STAT: bot roster update failed: ${e}`));
          return;
        }
        if (GTP_AUTO_COMP && this.room && !this.room.round) await this.startComp();
        return;
      case 'C':
        return this.handleCaption(body, parts);
      case 'V':
        return this.handleVote(body, parts);
      case 'FCS':
        return this.handleFatChancePick(body, parts);
      case 'PUC': case 'MC':
        return this.relayChat(body);
      case 'PRC':
        return this.handlePrivateChat(body, parts);
      case 'HC':
        return this.handleHostCommand(body, parts);
      case 'CP':
        return this.handleComplaint(body, parts);
      case 'FP':
        return this.handleFindPlayer(body, parts);
      default:
        return this.record(body, token);
    }
  }

  /**
   * LogonRoomMsg -> LogonAcceptedRoomMsg.
   *
   *   in   L  <name> <n> Version <a> <b> <c> <d> <playerId> <session> <flag>
   *   out  LA <name> Version <a> <b> <c> <d> <serverTimeMs>
   *
   * Echo the version the client just gave us rather than hardcoding one: it
   * announced 1 0 0 27 while this used to reply 1 0 0 26, and a client told its
   * own build is out of date is entitled to stop.
   *
   * The trailing ulong is NOT the player id -- LogonAccepted's accessor at
   * 0x4b800d feeds it straight to RoomProxy::SetServerTime (0x4b76cd), which
   * keeps it as a signed offset from the local GetTickCount. Sending a player
   * id there set the client's clock decades adrift.
   */
  async handleL(parts) {
    const wireName = parts[1] || this.username || 'Player';
    const requestedName = gtpHttpLoginName(wireName);
    this.username = gtpUniqueName(requestedName, this);
    const vi = parts.findIndex((p) => p.toLowerCase() === 'version');
    if (vi >= 0 && parts.length >= vi + 5) this.version = parts.slice(vi + 1, vi + 5).join(' ');
    gtpLog(`STAT: Client identity resolved as "${this.username}" (version ${this.version.replace(/ /g, '.')}).`);

    await this.botPriv(`LA ${gtpQuote(this.username)} Version ${this.version} ${gtpNow()}`);
    this.loggedOn = true;

    // Logging on to a room channel, rather than the lobby, is entry to the
    // room. There is no separate "I am in" message.
    if (this.pendingRoom) await this.enterRoom(this.pendingRoom);
    else gtpBroadcastLobbyRoster(this);
  }

  /**
   * The room list.
   *
   *   RB <count>
   *   RI <index> <Room>     x count
   *   RE
   *
   * followed by the lobby roster, so the selector's player panel is populated.
   */
  async handleRR() {
    if (this.room) {
      // In-room RR is the client saying it is ready -- the same signal Cosmic
      // treats as "the host wants to start". Answer with the first segment.
      //
      // Only the FIRST one: everything after preflight (SC/SV/SS/SRW/...) is a
      // real game loop with scoring and timers, and none of that exists here.
      // Re-sending SP on every RR would restart the screen in a loop, so later
      // RRs just get the clock and the suggested next line.
      if (GTP_AUTO_PREFLIGHT && !this.sentPreflight) {
        this.sentPreflight = true;
        gtpLog(`STAT: "${this.label()}" is ready -- sending the preflight segment.`);
        await this.botPriv(this.preflightLine());
        // SP only puts the picture control on screen; it does NOT fetch the
        // image. The download is started by DownloadPictureRoomMsg and nothing
        // else: the model's dispatcher (0x4424aa) calls view vf 0x1d0 only for
        // a message that dynamic-casts to DownloadPictureRoomMsg, and that slot
        // (0x4521ac) pulls the Pic out of msg+4 and hands it to the downloader
        // at 0x42de42. Without this the client sits on Resources\Pictures\
        // StillDownload.jpg -- the "Sorry, image still downloading..." frame --
        // and never issues an HTTP request at all.
        //
        // After SP, not before: the control has to exist before the image
        // arrives to fill it.
        await this.botPriv(`DP ${gtpPicRecord()}`);
        if (this.room) this.room.shownPicture = GTP_PICTURES[0].id;
        gtpLog(`STAT: picture offered; the client should GET /${GTP_PICTURE_FOLDER}/${GTP_PICTURE_FILE}.`);
        return;
      }
      gtpLog(`STAT: "${this.label()}" sent RR in-room; preflight already sent, no segment engine past it.`);
      gtpLog(`STAT: the next segment is the comp round. Try: gtpSend('${this.compLine()}')`);
      return this.sendSt();
    }

    const rooms = [...gtpRooms.values()];
    gtpLog(`STAT: "${this.label()}" wants the room list (${rooms.length} room(s)).`);
    await this.botPriv(`RB ${rooms.length}`);
    for (let i = 0; i < rooms.length; i++) {
      await this.botPriv(`RI ${i} ${gtpRoomRecord(rooms[i])}`);
    }
    await this.botPriv('RE');

    const waiting = gtpLobbyClients();
    await this.botPriv(`PLB ${waiting.length}`);
    for (let i = 0; i < waiting.length; i++) {
      await this.botPriv(`PLI ${i} ${gtpPlayerRecord(waiting[i].username)}`);
    }
    await this.botPriv('PLE');
  }

  /**
   * RequestSyncRoomMsg: the client's periodic ping, carrying its best and last
   * measured round-trip in milliseconds (RoomProxy 0x4b7138 builds it from
   * proxy+0x108/+0x10c). The answer is an ST carrying the server clock, which
   * 0x4b71d1 turns back into a clock offset.
   */
  async handleRS(parts) {
    const best = parts[1] || '?';
    const last = parts[2] || '?';
    gtpLog(`STAT: "${this.label()}" sync request (best ${best} ms, last ${last} ms).`);
    // A room proxy sends its first RS right after LogonAccepted, so normally
    // handleL has already run enterRoom. It only re-sends L when its bot nick
    // is still unset (0x4b71d1), which is true for a freshly built proxy but
    // need not be true if the client ever reuses one -- so treat an RS arriving
    // on a JOINed-but-not-entered room channel as the entry too. Cheaper than
    // finding out the hard way that the client skipped a step.
    if (!this.room && this.pendingRoom) await this.enterRoom(this.pendingRoom);
    return this.sendSt();
  }

  sendSt(a = 0, b = 0, c = 0, d = 0) {
    return this.botPriv(`ST ${gtpSegment(gtpNow(), a, b, c, d)}`);
  }

  /**
   * A StartPreflightRoomMsg, shaped AND timed from the binary's own reference
   * server. TestPictureRoomProxy (0x46541a) builds one as
   *
   *     push Pic; push 0; push 10000; push 0; push 10000; push GetServerTime()
   *     call 0x465ebd
   *
   * and the ctor there (ret 0x18, six args) hands its first five straight to
   * the Segment base ctor at 0x44e1d7 and copies the sixth -- a Pic -- to
   * this+0x18. So the argument list is literally
   *
   *     StartPreflight(serverTime, 10000, 0, 10000, 0, Pic)
   *
   * which is where these four numbers come from. They are the reference
   * server's, not a guess at what a timing "should" be.
   */
  preflightLine() {
    // 10 s from now, rebased onto the server clock for the same reason the comp
    // round is -- see gtpSegmentEndingIn(). The preflight screen shows no
    // countdown, so this was never visibly wrong, but it was wrong.
    // d=0 here is not a guess: the reference preflight segment is
    // (10000, 0, 10000, 0). This screen has no entrance to wait on.
    return `SP ${gtpPicRecord()} ${gtpSegmentEndingIn(10000, 0)}`;
  }

  /**
   * A StartCompRoomMsg -- the caption-writing round, the first real gameplay.
   *
   * The shape is confirmed from the reader chain, and the ctor at 0x465b82
   * pins the argument order: args 1-5 go straight to the Segment base
   * (0x44e1d7), then +0x18, the Pic, +0x58 and three strings. The reference
   * server calls it (0x464424) as
   *
   *     SC(serverTime, 107500, 41000, 60000, 1000, 1, Pic, 2, "", "", "")
   *
   * Only the duration is changed here, to the published 45 seconds. The two
   * ints and the three strings are still unexplained; the strings are empty in
   * the reference too, and are the obvious candidate for carrying the Copyfits
   * word list on the Final Round.
   */
  compLine(variant = GTP_VARIANT_PLAIN, round = 1, pic = GTP_PICTURES[0]) {
    const [, , d] = GTP_COMP_SEGMENT_BCD;
    const ms = (variant === GTP_VARIANT_SLIMERICKS) ? GTP_SLIMERICK_MS : GTP_COMP_MS;
    const w = (variant === GTP_VARIANT_COPYFITS) ? GTP_COPYFITS_WORDS[0] : ['', '', ''];
    return `SC ${round} ${gtpPicRecord(pic)} ${variant} `
         + `${gtpQuote(w[0])} ${gtpQuote(w[1])} ${gtpQuote(w[2])} `
         + gtpSegmentEndingIn(ms, d);
  }

  /**
   * Start the composition round.
   *
   * Driven off PV -- the client acknowledging that it has fetched and decoded
   * the picture -- because that is the only signal that says the screen is
   * actually ready for a round rather than still downloading.
   */
  async startComp() {
    if (!this.room) return;
    if (this.room.running) {
      gtpLog(`STAT: room '${this.room.channel}' already has a game running -- joining it.`);
      return;
    }
    gtpLog(`STAT: starting a ${GTP_ROUND_COUNT}-round game in '${this.room.channel}'.`);
    // Not awaited: the loop runs for the length of a whole game, and this is
    // called from a message handler that has to return.
    Promise.resolve(gtpRunGame(this.room)).catch(
      (e) => gtpLog(`STAT: game loop error: ${e}`));
  }

  /** LogoffRoomMsg -> LogoffAcceptedRoomMsg. LOA carries no fields. */
  async handleLO(parts) {
    const leavingGame = parts[1] === '1';
    await this.botPriv('LOA');
    gtpLog(`STAT: "${this.label()}" logged off (${leavingGame ? 'left the room' : 'left the lobby'}).`);
    if (this.room) this.leaveRoom();
  }

  /** LeaveRoomRoomMsg: return to the selector without closing the IRC socket. */
  async handleLER() {
    const room = this.room;
    if (!room) return;
    gtpLog(`STAT: "${this.label()}" left room '${room.channel}' (LER).`);
    this.leaveRoom();
  }

  /**
   * CompRoomMsg -- a submitted caption.
   *
   *   in   C  <int> <str> <str>
   *   out  CR <int>          accepted   (CompReceivedRoomMsg)
   *        CL <int>          too late   (CompLateRoomMsg)
   *        CI <int> <str>    rejected   (CompInvalidRoomMsg, with a reason)
   *
   * Two strings, which matches Slimericks needing two lines; a normal round
   * presumably leaves the second empty. Answering CR is what stops the client
   * waiting on its own submission.
   */
  async handleCaption(body, parts) {
    const idx = parts[1] || '0';
    const fields = gtpFields(body).slice(2);
    const slimericks = this.room && this.room.variant
      && this.room.variant.id === GTP_VARIANT_SLIMERICKS;
    const lineLimit = slimericks ? GTP_SLIMERICK_LINE_MAX : GTP_CAPTION_MAX;
    const rawLine1 = fields[0] || '';
    const rawLine2 = fields[1] || '';
    const line1 = rawLine1.slice(0, lineLimit);
    const line2 = rawLine2.slice(0, lineLimit);
    const shown = [line1, line2].filter(Boolean).join(' / ');
    gtpLog(`STAT: caption from "${this.label()}" (slot ${idx}): ${JSON.stringify(shown)}`);
    if (rawLine1.length > lineLimit || rawLine2.length > lineLimit) {
      gtpLog(`STAT: caption from "${this.label()}" exceeded the ${lineLimit}-character `
        + `per-line limit -- truncating.`);
    }
    await this.botPriv(`CR ${idx}`);
    if (this.room) {
      this.room.entries = this.room.entries || [];
      // One entry per player: a resubmission replaces, it does not stack.
      const prev = this.room.entries.findIndex((e) => e.name === this.username);
      // `at` is what breaks a tie -- "the player who entered his or her caption
      // quickest among the tied players will be the round winner" -- so it is
      // the FIRST submission time that counts, not the latest edit.
      const at = prev >= 0 ? this.room.entries[prev].at : Date.now();
      const entry = { name: this.username, line1, line2, at, bot: false };
      if (prev >= 0) this.room.entries[prev] = entry;
      else this.room.entries.push(entry);
    }
    gtpLog(`STAT: caption accepted; it will appear in the voting list as entry `
           + `${this.room ? this.room.entries.length - 1 : '?'}.`);
  }

  // ── chat commands ──────────────────────────────────────────────────────────
  //
  // The client handles some slash commands itself and forwards the rest to the
  // room bot as HostChatRoomMsg. Observed live: "HC /help", "HC /p", "HC /n".
  // So HC is the command channel in BOTH directions -- inbound it is a command,
  // outbound it is a system notice, which is what the green lines in the
  // screenshots ("Composition received", "Vote received") are.

  /**
   * A system notice in the room's chat window.
   *
   * PUC, not HC. HC is what the client SENDS for an unhandled slash command,
   * and answering in kind put the text in the server log but nowhere on screen.
   * PUC is the message the chat window demonstrably renders -- a typed line
   * came back as "<NonaSuomy>: ..." -- so a notice is just a PUC from the bot,
   * which is also how the real service's green "Composition received" lines
   * would have reached the window.
   */
  notice(text) {
    return this.botPriv(`PUC ${gtpQuote(text)} ${gtpQuote(GTP_BOT_NICK)}`);
  }

  /** Same, to everyone in the room. */
  roomNotice(text) {
    const where = this.room ? gtpRoomClients(this.room) : gtpLobbyClients();
    for (const c of where) Promise.resolve(c.notice(text)).catch(() => {});
  }

  /**
   * An inbound HC: a slash command the client did not handle locally.
   *
   * The rules split the commands three ways, and only the third reaches here:
   *
   *   client-side, never sent   /ignore /save /log
   *   own message type          /vote -> V, /f -> FCS, /msg -> PRC, /me -> MC
   *   forwarded as HC           everything else
   */
  async handleHostCommand(body, parts) {
    const raw = body.replace(/^HC\s+/, '').replace(/\x02/g, '').trim();
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ');
    gtpLog(`STAT: "${this.label()}" sent host command ${JSON.stringify(raw)}`);

    switch ((cmd || '').toLowerCase()) {
      case '/help': case '/?':
        for (const line of [
          'Commands: /help /? /stat /hide /complain /ignore /msg /me /vote /f',
          '/vote N (or /v N) votes for caption N. /f picks a Fat Chance swatch.',
          '/msg <user> sends a private message. /me <action> sends an action.',
          '/complain <user> reports a problem player. /ignore <user> hides them.',
          '/stat shows your stats. /hide toggles Find My Friend visibility.',
        ]) await this.notice(line);
        return;

      case '/stat': {
        const room = this.room ? this.room.channel : 'the lobby';
        await this.notice(`${this.username}: score ${this.score || 0}, `
                          + `room ${room}, round ${(this.room && this.room.round) || 0}`);
        return;
      }

      case '/hide':
        this.hidden = !this.hidden;
        await this.notice(this.hidden
          ? 'You are now hidden from Find My Friend.'
          : 'You are visible to Find My Friend again.');
        return;

      case '/complain':
        if (!arg) { await this.notice('Usage: /complain <username>'); return; }
        return this.registerComplaint(arg);

      case '/ignore': case '/save': case '/log':
        // The rules describe these as local: /ignore filters the client's own
        // chat view, /save and /log write PictureLog.txt in the game directory.
        // If one arrives anyway the client has not implemented it, so say so
        // rather than swallowing it.
        await this.notice(`${cmd} is handled by your own client, not the server.`);
        return;

      default:
        // /p and /n arrive from the two small buttons above the chat box. What
        // they are meant to do is not established, so they are recorded rather
        // than guessed at.
        this.record(body, 'HC');
        await this.notice(`Unknown command ${cmd}. Try /help.`);
        return;
    }
  }

  /**
   * PrivateChatRoomMsg: "The message won't appear to anyone else but you and
   * the recipient."
   *
   * Three strings, and which is which is not established -- PUC is
   * <text> <sender>, so PRC is that plus a recipient somewhere. Rather than
   * guess the slot, find the field that names a DIFFERENT player: the sender is
   * already known, so whichever remaining field matches someone else in the
   * room is the target. Falls back to refusing to deliver rather than
   * broadcasting, because a private message leaked to the whole room is the one
   * failure that actually matters here.
   */
  async handlePrivateChat(body, parts) {
    const fields = gtpFields(body).slice(1);
    const everyone = this.room ? gtpRoomClients(this.room) : gtpLobbyClients();
    const target = everyone.find((c) => c !== this
      && fields.some((f) => f.toLowerCase() === (c.username || '').toLowerCase()));
    if (!target) {
      gtpLog(`STAT: private message from "${this.label()}" names no one here -- not delivered.`);
      await this.notice('That player is not in this room.');
      return;
    }
    await target.sendRaw(
      `:${GTP_BOT_NICK}!${GTP_BOT_NICK}@${GTP_SERVER_NAME} PRIVMSG ${target.nick} :${body}`);
    gtpLog(`STAT: private message "${this.label()}" -> "${target.label()}" (not broadcast).`);
  }

  /**
   * ComplaintRoomMsg, and /complain.
   *
   * "If the majority of players in a game room complain about a problem player,
   * that player will be banned from that gameroom for up to 4 hours."
   */
  async handleComplaint(body, parts) {
    const fields = gtpFields(body).slice(1);
    const everyone = this.room ? gtpRoomClients(this.room) : [];
    const named = fields.find((f) => everyone.some(
      (c) => (c.username || '').toLowerCase() === f.toLowerCase()));
    if (!named) {
      gtpLog(`STAT: complaint from "${this.label()}" names nobody present: ${gtpShow(body)}`);
      this.record(body, 'CP');
      return;
    }
    return this.registerComplaint(named);
  }

  async registerComplaint(targetName) {
    if (!this.room) { await this.notice('You can only complain inside a room.'); return; }
    const room = this.room;
    const target = gtpRoomClients(room).find(
      (c) => (c.username || '').toLowerCase() === targetName.toLowerCase());
    if (!target) { await this.notice(`${targetName} is not in this room.`); return; }
    if (target === this) { await this.notice('You cannot complain about yourself.'); return; }

    room.complaints = room.complaints || new Map();
    const against = room.complaints.get(target.username) || new Set();
    against.add(this.username);
    room.complaints.set(target.username, against);

    // "the majority of players in a game room" -- humans only. Bots have no
    // opinion, and counting them would make a ban unreachable in a quiet room.
    const humans = gtpRoomClients(room).length;
    const needed = Math.floor(humans / 2) + 1;
    gtpLog(`STAT: complaint against "${target.username}" from "${this.username}" `
           + `(${against.size}/${needed} of ${humans}).`);
    await this.notice(`Complaint registered against ${target.username} `
                      + `(${against.size} of ${needed} needed).`);
    if (against.size >= needed) await gtpBanFromRoom(room, target, GTP_BAN_MS);
  }

  /**
   * FindPlayerRoomMsg -- the "Find My Friend" option on the room menu.
   *
   *   in   FP  <Player>
   *   out  PF  <Player> <Room>   found, and here is the room to join
   *        PNF <Player>          not found
   *
   * /hide makes a player unfindable, which is exactly what the rules say it is
   * for, so a hidden player answers PNF as though they were not here.
   */
  async handleFindPlayer(body, parts) {
    const fields = gtpFields(body).slice(1);
    const wanted = fields[fields.length - 1] || '';
    let found = null;
    let inRoom = null;
    for (const room of gtpRooms.values()) {
      for (const c of gtpRoomClients(room)) {
        if ((c.username || '').toLowerCase() === wanted.toLowerCase() && !c.hidden) {
          found = c; inRoom = room; break;
        }
      }
      if (found) break;
    }
    if (!found) {
      gtpLog(`STAT: "${this.label()}" looked for "${wanted}" -- not found (or hidden).`);
      return this.botPriv(`PNF ${gtpPlayerRecord(wanted)}`);
    }
    gtpLog(`STAT: "${this.label()}" found "${found.username}" in '${inRoom.channel}'.`);
    return this.botPriv(
      `PF ${gtpPlayerRecord(found.username, found.score || 0)} ${gtpRoomRecord(inRoom)}`);
  }

  /**
   * VoteRoomMsg -- /vote N, /v N, or a click on a caption.
   *
   *   in   V  <int> <str>
   *   out  VR <int>          counted
   *        VL <int>          too late   (voting closed)
   *        VI <int> <str>    invalid    (out of range, or your own caption)
   *
   * "you can't vote for your own answer. If you could, then everyone would vote
   * for themselves!" -- so a self-vote is refused rather than quietly dropped.
   */
  /**
   * V <count:int> <author:str>
   *
   * The vote names the caption's AUTHOR; the leading int echoes SV's count
   * rather than identifying the choice. Reading it as the caption index picked
   * whatever sat at position 9 of a nine-caption list -- i.e. nothing.
   */
  async handleVote(body, parts) {
    const room = this.room;
    // gtpFields, not `parts`: the caller splits on plain spaces, so a quoted
    // author arrives as "\x02Baby J\x02" -- STX still attached, and split in
    // two if the name has a space. Names are the vote identity here, so they
    // have to come through the real tokenizer.
    const f = gtpFields(body);
    const echo = parseInt(f[1], 10);
    const author = f[2] || '';
    if (!room || !room.entries || !room.entries.length) {
      gtpLog(`STAT: vote from "${this.label()}" with no round in progress.`);
      return this.botPriv(`VL ${Number.isFinite(echo) ? echo : 0}`);
    }
    if (!author) {
      gtpLog(`STAT: "${this.label()}" voted for an unnamed caption -- `
             + 'CLI must carry author names for voting to work.');
      return this.botPriv(`VI ${Number.isFinite(echo) ? echo : 0} ${gtpQuote('No such caption')}`);
    }
    const idx = room.entries.findIndex((e) => e.name === author);
    if (idx < 0) {
      return this.botPriv(`VI ${Number.isFinite(echo) ? echo : 0} ${gtpQuote('No such caption')}`);
    }
    if (room.entries[idx].name === this.username) {
      gtpLog(`STAT: "${this.label()}" tried to vote for their own caption -- refused.`);
      await this.notice('You cannot vote for your own caption.');
      return this.botPriv(`VI ${echo} ${gtpQuote('You cannot vote for yourself')}`);
    }
    room.votes = room.votes || new Map();
    room.votes.set(this.username, idx);
    gtpLog(`STAT: "${this.label()}" voted for "${author}" (caption ${idx}).`);
    await this.botPriv(`VR ${echo}`);
    await this.notice('Vote received.');
  }

  /**
   * FatChanceSelectionRoomMsg -- /f, or a click on a swatch.
   *
   * Only the round winner is playing, so a pick from anyone else is refused.
   */
  async handleFatChancePick(body, parts) {
    const room = this.room;
    // FCS is <round> <index>, NOT <index> -- same shape as C <round> <caption>.
    // Reading parts[1] scored the ROUND NUMBER as the swatch, so round 1 always
    // awarded swatch 1 whatever was clicked, and SFCR echoed that position back,
    // lighting up a square the player never touched. Confirmed on the wire:
    // "FCS 1 4" arrived while the control had stored index 4.
    const idx = parseInt(parts.length > 2 ? parts[2] : parts[1], 10);
    const fc = room && room.fatChance;
    if (!fc) return this.botPriv(`FCSL ${Number.isFinite(idx) ? idx : 0}`);
    if (fc.winner !== this.username) {
      return this.botPriv(`FCSI ${Number.isFinite(idx) ? idx : 0} `
        + gtpQuote('Only the round winner plays Fat Chance'));
    }
    if (!Number.isFinite(idx) || idx < 0 || idx >= fc.swatches.length) {
      return this.botPriv(`FCSI ${Number.isFinite(idx) ? idx : 0} ${gtpQuote('No such swatch')}`);
    }
    fc.picked = idx;
    gtpLog(`STAT: "${this.label()}" picked Fat Chance swatch ${idx}.`);
    return this.botPriv(`FCSR ${idx}`);
  }

  /** Lobby chat, fanned out verbatim to everyone else in the same place. */
  relayChat(body) {
    const peers = (this.room ? gtpRoomClients(this.room) : gtpLobbyClients())
      .filter((c) => c !== this);
    for (const other of peers) Promise.resolve(other.botPriv(body)).catch(() => {});
    gtpLog(`STAT: chat from "${this.label()}" -> ${peers.length} listener(s): ${JSON.stringify(gtpShow(body))}`);
  }

  record(body, token) {
    this.recorded.push(body);
    const spec = GTP_PROTOCOL[token];
    const note = spec ? `   <- ${token} ${spec.cls}: ${spec.fields || '(no fields)'}` : '';
    gtpLog(`RECORD ${this.recorded.length}: ${gtpShow(body)}${note}`);
  }

  // ── room membership ────────────────────────────────────────────────────────

  /**
   * The client has logged on to a room channel. Everything past here is the
   * game proper, which is not implemented: the fields of SP/SC/SV and the Pic
   * record they carry are recovered as TYPES but not as MEANINGS, and guessing
   * at them would produce packets that look plausible and teach us nothing.
   *
   * So this establishes the room -- clock, room state, roster -- and then
   * records. Use gtpSend() from the console to drive segments by hand.
   */
  async enterRoom(channel) {
    const room = gtpRoom(channel) || gtpEnsureRoom(channel);
    if (!room) {
      gtpLog(`STAT: "${this.label()}" cannot enter #${channel}; staying out of any room.`);
      this.pendingRoom = null;
      return;
    }
    if (gtpIsBanned(room, this.username)) {
      const mins = Math.ceil((room.bans.get(this.username.toLowerCase()) - Date.now()) / 60000);
      gtpLog(`STAT: "${this.label()}" is banned from '${room.channel}' for another ${mins} min.`);
      this.pendingRoom = null;
      await this.botPriv(`LER ${gtpQuote(`You cannot rejoin this room for ${mins} more minutes.`)}`);
      return;
    }
    this.room = room;
    this.pendingRoom = null;
    room.clients.add(this);
    // Occupancy is humans PLUS bots -- that is what the #Players column meant on
    // the real service, and what the joinable test is measured against.
    room.players = gtpRoster(room).length;
    gtpLog(`STAT: "${this.label()}" entered room '${room.channel}' `
           + `(${gtpRoomClients(room).length} human(s) + ${(room.bots || []).length} bot(s)`
           + ` = ${room.players}/${room.capacity || GTP_ROOM_CAPACITY}).`);

    const alive = () => this.connected && this.room === room;
    if (!alive()) return;
    await this.sendSt();
    if (!alive()) return;
    await this.botPriv(`RU ${gtpRoomRecord(room)}`);
    if (!alive()) return;

    if (GTP_SEND_ADS && !gtpNoAdvertisements()) {
      // Match Python's immediate local ad selection.  Waiting for the async
      // manifest fetch here delayed the roster and left the Win95 client on
      // the entry screen long enough to disconnect.  The fetch still updates
      // the pool for later room entries.
      const all = (gtpAdCache && gtpAdCache.length)
        ? gtpAdCache.slice() : GTP_AD_FALLBACK.slice();
      if (!gtpAdCache) Promise.resolve(gtpAds()).catch(() => {});
      const sponsor = all[Math.floor(Math.random() * all.length)];
      // The sponsor ad first -- that is the one the "Downloading sponsor
      // advertisement." screen is waiting on -- then the pre-download list.
      // The sponsor leads the list so the client is never asked to fetch more
      // than it has to.
      const list = [sponsor];
      for (const f of all) {
        if (list.length >= GTP_AD_LIST_SIZE) break;
        if (!list.includes(f)) list.push(f);
      }
      await this.botPriv(`SPA ${gtpAdRecord(sponsor)}`);
      if (!alive()) return;
      await this.botPriv(`ADLB ${list.length}`);
      if (!alive()) return;
      for (let i = 0; i < list.length; i++) {
        await this.botPriv(`ADLI ${i} ${gtpAdRecord(list[i])}`);
        if (!alive()) return;
      }
      await this.botPriv('ADLE');
      if (!alive()) return;
      this.adsHave = [...new Set(this.adsHave.concat(list))];
      gtpLog(`STAT: sponsor ad "${sponsor}" offered; the client should GET /picture/content/ads/${sponsor}.`);
    } else if (GTP_SEND_ADS) {
      // Use the local zero-byte placeholder rather than a real sponsor. The
      // client still performs its normal download/ack path, but displays no
      // advertisement and never needs a missing filename fallback.
      await this.botPriv(`SPA ${gtpAdRecord(GTP_NO_AD_FILE)}`);
      await this.botPriv(`ADLB 1`);
      if (!alive()) return;
      await this.botPriv(`ADLI 0 ${gtpAdRecord(GTP_NO_AD_FILE)}`);
      await this.botPriv('ADLE');
      gtpLog(`STAT: advertisements disabled; offered ${GTP_NO_AD_FILE}.`);
    }

    if (room.running) {
      // A late joiner has not received the screen that owns the roster control.
      // Establish a short screen first, then acknowledge list sync and push
      // the live roster after the client has built that screen.
      await this.botPriv(this.preflightLine());
      if (!alive()) return;
      const pic = room.picture || GTP_PICTURES[0];
      await this.botPriv(`DP ${gtpPicRecord(pic)}`);
      if (!alive()) return;
      const variant = room.variant && room.variant.id || 0;
      await this.botPriv(`SC ${room.round || 1} ${gtpPicRecord(pic)} ${variant} `
        + `${gtpQuote('')} ${gtpQuote('')} ${gtpQuote('')} ${gtpSegmentEndingIn(5000)}`);
      if (!alive()) return;
      await this.botPriv('LSA');
      if (!alive()) return;
      setTimeout(() => {
        if (!alive()) return;
        const roster = gtpRoster(room);
        Promise.resolve((async () => {
          await gtpCatchUpRoom(room, this);
          if (!alive()) return;
          await this.botPriv('LSA');
          if (!alive()) return;
          await this.botPriv(`PLB ${roster.length}`);
          for (let i = 0; i < roster.length; i++) {
            if (!alive()) return;
            await this.botPriv(`PLI ${i} ${gtpPlayerRecord(roster[i].name, roster[i].score)}`);
          }
          await this.botPriv('PLE');
        })()).catch(() => {});
      }, 1000);
    } else {
      // Fresh-room behavior matches Python: the complete current roster is
      // sent now, and RR supplies the preflight/DP sequence afterward.
      gtpPushRoster(room);
    }

    // The bot burst waits for the picture.
    //
    // cosmic-server.js has the reference opening for this engine: the roster
    // goes out with the HUMANS only, then SP/SAS end the travelling animation,
    // and only THEN do the bots arrive as one PJ each. The bots are announced
    // after the room screen exists.
    //
    // Doing it at room entry sent every PJ and every roster push while the
    // client was still playing the sponsor ad -- there was no room screen yet
    // to put them on, so the game started with an empty player list. The cue
    // that the screen is live is PV, the client acknowledging the picture, so
    // the burst is armed here and fired from there.
    room.pendingBots = GTP_MIN_BOTS > 0 && !room.running;
    // Tell the people still in the selector that occupancy changed.
    gtpBroadcastRoomUpdate(room);
    gtpBroadcastLobbyRoster();

    gtpLog('STAT: room established -- entering RECORD mode for game traffic.');
    gtpLog('STAT: drive segments by hand with gtpSend("SP Pic ...").');
  }

  /**
   * Announce the room's bots, one PJ at a time.
   *
   * PJ carries a Player record, same as PLI, so a bot is indistinguishable from
   * a human on the wire -- which is the point.
   */
  async joinBots(room) {
    room.bots = room.bots || [];
    const want = gtpTargetBotCount(room);
    const have = new Set(room.bots.map((b) => b.name));
    const queue = GTP_BOT_NAMES.filter((n) => !have.has(n))
      .slice(0, Math.max(0, want - room.bots.length));
    if (!queue.length) return;
    gtpLog(`STAT: adding ${queue.length} bot(s) to '${room.channel}'.`);
    for (const name of queue) {
      await gtpSleep(GTP_BOT_JOIN_STAGGER_MS);
      // Everyone may have left while we were pacing this out.
      const members = gtpRoomClients(room);
      if (!members.length) {
        gtpLog(`STAT: room '${room.channel}' emptied -- stopping the bot join burst.`);
        return;
      }
      // Seat the bot HERE, one per tick, so each roster push is one longer
      // than the last and the list is seen to fill.
      const bot = { name, score: 0 };
      room.bots.push(bot);
      for (const c of members) {
        await c.botPriv(`PJ ${gtpPlayerRecord(bot.name, bot.score)}`);
      }
      // PJ alone does NOT put the name in the player list. Its handler
      // (0x43f40d) only adds the player when their name matches a string the
      // room proxy holds at +0x878 -- initialised to "Unknown" at 0x43d0af and
      // set from +0x984 -- so it is for one specific expected arrival, not for
      // general roster updates. PLI's handler (0x43f3d8) adds unconditionally,
      // which is why the list only ever filled in at the first scoring screen,
      // where a full roster happens to be pushed.
      gtpPushRoster(room);
    }
    room.players = gtpRoster(room).length;
    gtpBroadcastRoomUpdate(room);
  }

  leaveRoom() {
    const room = this.room;
    if (!room) return;
    room.clients.delete(this);
    this.room = null;
    room.players = gtpRoster(room).length;
    for (const other of gtpRoomClients(room)) {
      Promise.resolve(other.botPriv(`PLEAVE ${gtpPlayerRecord(this.username || '')}`)).catch(() => {});
    }
    // A human leaving frees a seat; let the bots take it back so the room does
    // not slowly empty out over a long session.
    if (gtpRoomClients(room).length) gtpFillBots(room);
    if (!gtpRoomClients(room).length) {
      // Invalidate every outstanding phase and delayed roster callback.  A
      // quick Continue must start a clean game instead of inheriting the old
      // room's SC/SV/Fat Chance state.
      room.gameGeneration = (room.gameGeneration || 0) + 1;
      room.running = false;
      room.round = 0;
      room.entries = [];
      room.votes = new Map();
      room.fatChance = null;
      room.lastScreenCluster = null;
      room.screenCluster = [];
      room.bumperReceipt = null;
      room.pendingBumpers = [];
    }
    room.players = gtpRoster(room).length;
    gtpLog(`STAT: "${this.label()}" left room '${room.channel}' (${room.players}/${room.capacity}).`);
    gtpBroadcastRoomUpdate(room);
    gtpBroadcastLobbyRoster();
  }
}

// ── accept loop ──────────────────────────────────────────────────────────────

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
    client.connected = false;
    client.leaveRoom();
    gtpClients.delete(client);
    try { await conn.close(); } catch (e) { /* already closed */ }
    if (client.recorded.length) {
      gtpLog(`Session recorded ${client.recorded.length} unmapped line(s):`);
      client.recorded.forEach((l, i) => gtpLog(`  ${i + 1}. ${gtpShow(l)}`));
    }
    // A QUIT is a clean exit. Anything else means the client went away without
    // saying so, which is what an uncaught throw in its reader looks like --
    // so print what it was given just beforehand.
    if (!client.saidQuit && client.lastSent.length) {
      gtpLog(`Disconnected WITHOUT quit -- last ${client.lastSent.length} message(s) sent to ${client.label()}:`);
      client.lastSent.forEach((l, i) => {
        const n = client.lastSent.length - i;
        gtpLog(`  -${n}: ${gtpShow(l)}`);
      });
      gtpLog('  ^ the last line is the prime suspect. gtpSkip(\'TAG\') drops one to test it.');
    }
    gtpLog(`Disconnected: ${client.label()}`);
  }
}

/**
 * Send a raw game message to a connected client, from the browser console:
 *
 *     gtpSend('SP Pic ...')          -- to the only/first live client
 *     gtpSend('RU ...', 'NonaSuomy') -- to a named one
 *
 * The point is to bisect the unmapped half of the protocol against a real
 * client without editing this file between attempts. gtpProtocol() prints the
 * field list of any token.
 */
function gtpSend(body, who = null) {
  const live = [...gtpClients].filter((c) => c.connected);
  const target = who
    ? live.find((c) => c.username === who || c.nick === who)
    : live[0];
  if (!target) {
    gtpLog(`STAT: no such client${who ? ` "${who}"` : ''} -- ${live.length} connected.`);
    return false;
  }
  Promise.resolve(target.botPriv(body)).catch((e) => gtpLog(`STAT: send failed: ${e}`));
  return true;
}

/** Print the recovered field list for one token, or all of them. */
function gtpProtocol(token = null) {
  if (token) {
    const spec = GTP_PROTOCOL[token.toUpperCase()];
    if (spec) {
      gtpLog(`${token.toUpperCase()}  ${spec.cls}`);
      gtpLog(`  ${token.toUpperCase()} ${spec.fields || '(no fields)'}`);
      return;
    }
    // Records are named by class (Room, Player, ...) rather than by their wire
    // token, so accept either spelling -- "PR" and "Room" are the same thing.
    const byToken = { PR: 'Room', R: 'Room', PP: 'Player', P: 'Player', S: 'Segment' };
    const key = Object.keys(GTP_RECORDS).find(
      (k) => k.toLowerCase() === token.toLowerCase()
    ) || byToken[token.toUpperCase()];
    if (key) { gtpLog(`${key}  ${GTP_RECORDS[key]}`); return; }
    gtpLog(`no such token: ${token}`);
    return;
  }
  for (const [t, spec] of Object.entries(GTP_PROTOCOL)) {
    gtpLog(`${t.padEnd(7)} ${t} ${spec.fields}`.trimEnd() + `   -- ${spec.cls}`);
  }
  gtpLog('records:');
  for (const [r, f] of Object.entries(GTP_RECORDS)) gtpLog(`  ${r.padEnd(8)} ${f}`);
}

/**
 * Set the StartComp variant field live, so the value can be identified in one
 * session instead of one per reload.
 *
 *     gtpVariant(0); gtpVariant(1); ...
 *
 * Sending 1 produced the Slimericks screen. What value means "a plain round"
 * is still unknown, and the round title is what tells us -- a wrong value shows
 * the wrong words, it does not throw.
 */
function gtpVariant(n) {
  GTP_FORCED_VARIANT = (n === null || n === undefined) ? null : (n | 0);
  gtpLog(GTP_FORCED_VARIANT === null
    ? 'STAT: variant forcing off -- rounds 1-6 plain, round 7 random.'
    : `STAT: forcing every composition round to variant ${GTP_FORCED_VARIANT}. `
      + '0 plain, 2 Slimericks, 3 Copyfits, 1 and 4 untested.');
  return GTP_FORCED_VARIANT;
}

window.gtpVariant = gtpVariant;
window.gtpHandleGameConnection = gtpHandleGameConnection;
window.gtpSend = gtpSend;
window.gtpNobodyComposed = (v) => {
  GTP_CLB_FLAG = (v === undefined || v === null) ? null : !!v;
  gtpLog(`STAT: CLB's bool is now ${GTP_CLB_FLAG === null ? 'derived from the caption count' : GTP_CLB_FLAG}.`);
  return GTP_CLB_FLAG;
};
window.gtpSkip = (...tags) => {
  GTP_SKIP.clear();
  for (const t of tags.flat()) GTP_SKIP.add(String(t));
  gtpLog(GTP_SKIP.size
    ? `STAT: suppressing ${[...GTP_SKIP].join(', ')} -- if the client now survives, that is the one.`
    : 'STAT: no messages suppressed.');
  return [...GTP_SKIP];
};
window.gtpProtocol = gtpProtocol;
window.gtpProfile = {
  showId: GTP_SHOW_ID,
  displayName: GTP_DISPLAY_NAME,
  listChannel: GTP_LIST_CHANNEL,
  botNick: GTP_BOT_NICK,
  port: GTP_PORT,
  rooms: GTP_ROOM_CONFIGS,
  protocol: GTP_PROTOCOL,
  records: GTP_RECORDS,
};
})();
