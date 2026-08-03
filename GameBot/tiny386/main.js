'use strict';

// ── hot reload for cosmic-server.js ───────────────────────────────────────
//
// Re-fetches cosmic-server.js (cache-busted) and injects it as a fresh
// inline <script>, so its top-level IIFE runs again and reassigns
// window.cosmicHttpHandler / window.startCosmicGameServer /
// window.handleGameConnection to the new definitions.
//
// This does NOT call startCosmicGameServer() again -- the original TCP
// listener from page load is still running and stays running; it just
// looks up window.handleGameConnection fresh per-connection (see the
// accept loop in cosmic-server.js), so new connections pick up the
// reloaded logic automatically. Likewise the HTTP server wraps its
// handler in `(request) => window.cosmicHttpHandler(request)` rather than
// a captured reference, so it also picks up the new handler immediately.
//
// VM state (disk images, network stack, active connections) all lives
// outside this script and is untouched by a reload.
// ── shared virtual network ───────────────────────────────────────────────
//
// The tcpip.js stack, its tap, and the DHCP/DNS/HTTP/game servers are created
// ONCE for the whole page and shared by every emulator instance. They used to
// be built inside get_tiny386(), which meant a second instance got its own
// stack, its own DHCP server and its own game server -- N isolated universes
// that could never see each other. Hoisting them out is what lets several
// client windows play the same game.
//
// The VMs sit on one Ethernet segment joined by a hub: a frame from any VM is
// written to the tap AND copied to every other VM, and every frame from the
// tap is copied to all of them. That is deliberately a hub rather than a
// switch -- no MAC learning, just fan-out. Each VM's NIC already discards
// frames that are not addressed to it, so the only cost is redundant copies,
// and it keeps broadcast (which is how DHCP and ARP work) correct for free.
let netStackPromise = null;   // resolves once the stack + services exist
const vmPorts = [];           // one entry per live VM: { id, inject(buf) }
let tapWriteController = null; // enqueue here to put a frame on the wire

// ── per-VM MAC translation ───────────────────────────────────────────────
//
// tiny386's ne2000 has a hardcoded MAC and offers no way to configure one, so
// every instance comes up with the SAME hardware address. On one segment that
// is fatal: the DHCP server keys leases off the client MAC, so the second VM
// was handed the first one's lease (both showed 10.0.2.15), and any unicast
// frame would be accepted by both machines.
//
// So the hub hands each VM a unique virtual MAC and rewrites addresses as
// frames cross it. The VM's real (baked-in) MAC is LEARNED from the first
// frame it sends, which avoids having to locate the constant inside the wasm.
//
// Rewriting the Ethernet header alone is not enough -- two payloads carry MACs
// of their own and are what DHCP and ARP actually make decisions on:
//   ARP  : sender/target hardware addresses inside the packet
//   DHCP : chaddr in the BOOTP header, which is the field the server leases on
const MAC_BCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function macRead(b, off) { return Array.from(b.subarray(off, off + 6)); }
function macWrite(b, off, mac) { for (let i = 0; i < 6; i++) b[off + i] = mac[i]; }
function macSame(b, off, mac) {
    for (let i = 0; i < 6; i++) if (b[off + i] !== mac[i]) return false;
    return true;
}
// Locally-administered unicast address (0x02 bit set), unique per VM id.
function virtualMacFor(id) { return [0x02, 0x54, 0x00, 0x00, (id >> 8) & 0xff, id & 0xff]; }

// Offset of the BOOTP chaddr field, or -1 if this is not a DHCP frame.
function dhcpChaddrOffset(b) {
    if (b.length < 34) return -1;
    if (b[12] !== 0x08 || b[13] !== 0x00) return -1;         // not IPv4
    const ihl = (b[14] & 0x0f) * 4;
    if (b[14 + 9] !== 17) return -1;                          // not UDP
    const udp = 14 + ihl;
    if (b.length < udp + 8) return -1;
    const sport = (b[udp] << 8) | b[udp + 1];
    const dport = (b[udp + 2] << 8) | b[udp + 3];
    if (!(sport === 67 || sport === 68 || dport === 67 || dport === 68)) return -1;
    const chaddr = udp + 8 + 28;
    return (b.length >= chaddr + 6) ? chaddr : -1;
}

// Recompute the UDP checksum over an IPv4 datagram.
//
// Required after touching chaddr: that field is inside the UDP PAYLOAD, so
// rewriting it leaves the checksum stale and the DHCP server discards the
// packet as corrupt -- the machine then never gets a lease at all. (The IP
// header checksum is unaffected; nothing in the IP header changes. ARP needs
// no fixup either, it has no checksum.)
function fixUdpChecksum(b) {
    const ip = 14;
    const ihl = (b[ip] & 0x0f) * 4;
    const udp = ip + ihl;
    if (b.length < udp + 8) return;
    const udpLen = (b[udp + 4] << 8) | b[udp + 5];
    if (udpLen < 8 || udp + udpLen > b.length) return;

    b[udp + 6] = 0; b[udp + 7] = 0;               // zero it before summing
    let sum = 0;
    for (let i = 0; i < 8; i += 2)                 // pseudo-header: src+dst IP
        sum += (b[ip + 12 + i] << 8) | b[ip + 12 + i + 1];
    sum += 17;                                     // protocol = UDP
    sum += udpLen;                                 // UDP length
    for (let i = 0; i < udpLen; i += 2) {
        const hi = b[udp + i];
        const lo = (i + 1 < udpLen) ? b[udp + i + 1] : 0;
        sum += (hi << 8) | lo;
    }
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
    let ck = (~sum) & 0xffff;
    if (ck === 0) ck = 0xffff;   // 0 is reserved to mean "no checksum sent"
    b[udp + 6] = ck >> 8;
    b[udp + 7] = ck & 0xff;
}

// VM -> wire: replace the VM's real MAC with its virtual one.
function macOutbound(b, port) {
    if (!port.realMac) port.realMac = macRead(b, 6);           // learn it
    const real = port.realMac, virt = port.virtMac;
    if (macSame(b, 6, real)) macWrite(b, 6, virt);
    if (b[12] === 0x08 && b[13] === 0x06 && b.length >= 42) {  // ARP
        if (macSame(b, 22, real)) macWrite(b, 22, virt);
        if (macSame(b, 32, real)) macWrite(b, 32, virt);
    }
    const ch = dhcpChaddrOffset(b);
    if (ch >= 0 && macSame(b, ch, real)) {
        macWrite(b, ch, virt);
        fixUdpChecksum(b);   // chaddr is inside the UDP payload
    }
}

// wire -> VM: put the VM's real MAC back so its NIC accepts the frame.
function macInbound(b, port) {
    const real = port.realMac, virt = port.virtMac;
    if (!real) return;
    if (macSame(b, 0, virt)) macWrite(b, 0, real);
    if (b[12] === 0x08 && b[13] === 0x06 && b.length >= 42) {  // ARP
        if (macSame(b, 22, virt)) macWrite(b, 22, real);
        if (macSame(b, 32, virt)) macWrite(b, 32, real);
    }
    const ch = dhcpChaddrOffset(b);
    if (ch >= 0 && macSame(b, ch, virt)) {
        macWrite(b, ch, real);
        fixUdpChecksum(b);   // chaddr is inside the UDP payload
    }
}

// ── NetBIOS isolation ────────────────────────────────────────────────────
//
// Every client boots the same image, so every machine calls itself BEZERK.
// Windows detects that over NetBIOS name service (UDP 137): a booting machine
// broadcasts a name registration, and anyone already holding the name answers
// with a negative response, producing
//
//   Error 38: The computer name you specified is already in use on the network
//
// Renaming the machines would mean editing the registry inside the image, and
// those values sit in checksummed RGDB blocks -- patching them without fixing
// the checksum corrupts the config and the machine will not boot (tried it).
//
// So instead the hub simply does not carry NBNS between VMs. Each machine
// registers its name, nothing contradicts it, and every machine happily
// believes it owns BEZERK. Nothing here needs NetBIOS: the game reaches the
// server over TCP/IP (6666 and 8080) and dispatch2.ini uses raw IPs. The only
// loss is that the machines cannot browse each other in Network Neighbourhood.
//
// 138 (datagram service) is included because it is the other half of the same
// browsing chatter and equally pointless to fan out across N machines.
const ISOLATE_NETBIOS = true;
const NETBIOS_PORTS = new Set([137, 138]);

function isNetbiosFrame(b) {
    if (b.length < 17) return false;
    const typeLen = (b[12] << 8) | b[13];

    // NetBEUI: an 802.3 frame (the type field is a LENGTH, <= 1500) whose LLC
    // header says NetBIOS, DSAP = SSAP = 0xF0. This runs straight over
    // Ethernet with no IP involved at all, which is why filtering only UDP 137
    // did not stop Error 38 -- Win95 was detecting the duplicate name over
    // NetBEUI, not over NetBIOS-over-TCP/IP.
    if (typeLen <= 1500) {
        return b[14] === 0xf0 && b[15] === 0xf0;
    }

    // NetBIOS over TCP/IP: UDP 137 (name service) / 138 (datagram).
    if (typeLen !== 0x0800) return false;                     // not IPv4
    if (b.length < 38) return false;
    const ihl = (b[14] & 0x0f) * 4;
    if (b[14 + 9] !== 17) return false;                       // not UDP
    const udp = 14 + ihl;
    if (b.length < udp + 4) return false;
    const sport = (b[udp] << 8) | b[udp + 1];
    const dport = (b[udp + 2] << 8) | b[udp + 3];
    return NETBIOS_PORTS.has(sport) || NETBIOS_PORTS.has(dport);
}

// Should this port receive the frame? Broadcast/multicast goes to everyone;
// unicast only to the VM that owns the destination address. Without this the
// hub would hand every VM every frame, and since they share a real MAC they
// would all accept traffic meant for one of them.
function portWants(b, port) {
    if (b[0] & 0x01) return true;                              // bcast/mcast
    return macSame(b, 0, port.virtMac);
}

// Frames are queued and delivered on a later task, never inline.
//
// hubBroadcast is called from inside wasm_loop -- the VM calls out to JS to
// send a frame. Delivering synchronously meant calling wasm_inject_packet on
// another instance while the first was still executing, and if that injection
// made the second VM emit (an ARP reply, say) it broadcast straight back and
// re-entered the FIRST instance's WASM with its wasm_loop still on the stack.
// Deferring to a macrotask guarantees the emitting VM has fully unwound first.
const pendingFrames = [];
let drainScheduled = false;

function hubBroadcast(buf, fromId) {
    pendingFrames.push({ buf, fromId });
    if (!drainScheduled) {
        drainScheduled = true;
        setTimeout(drainHub, 0);
    }
}

function deliver(port, buf) {
    // One misbehaving VM must not take the others down with it. This matters
    // most on the tap.readable pipe: a throw out of its write handler errors
    // the stream permanently, which would silently cut packet delivery to
    // EVERY VM -- looking exactly like the first client locking up when a
    // second one appeared.
    if (!portWants(buf, port)) return;
    try {
        // Each VM needs its own copy: macInbound rewrites the buffer in place,
        // and the same frame may go to several ports.
        const copy = buf.slice();
        macInbound(copy, port);
        port.inject(copy);
    } catch (e) {
        console.error(`[net] inject into VM ${port.id} failed:`, e);
    }
}

function drainHub() {
    drainScheduled = false;
    const batch = pendingFrames.splice(0, pendingFrames.length);
    for (const { buf, fromId } of batch) {
        if (tapWriteController) {
            try { tapWriteController.enqueue(buf); } catch (e) { /* stream closed */ }
        }
        // VM-to-VM only: NBNS still reaches the tap (our stack ignores it), so
        // this suppresses the name-conflict answer without otherwise changing
        // what the machines can see.
        const vmToVm = !(ISOLATE_NETBIOS && isNetbiosFrame(buf));
        if (vmToVm) {
            for (const p of vmPorts) {
                if (p.id !== fromId) deliver(p, buf);
            }
        }
    }
}

function hubAttach(port) {
    port.virtMac = virtualMacFor(port.id);
    port.realMac = null;   // learned from this VM's first outbound frame
    vmPorts.push(port);
    console.log(`[net] VM ${port.id} attached to the shared segment (${vmPorts.length} online)`);
    return () => {
        const i = vmPorts.indexOf(port);
        if (i >= 0) vmPorts.splice(i, 1);
        console.log(`[net] VM ${port.id} detached (${vmPorts.length} online)`);
    };
}

function ensureNetwork() {
    if (netStackPromise) return netStackPromise;
    netStackPromise = (async () => {
        const tcpip = await import('tcpip');
        const stack = await tcpip.createStack();
        const tap = await stack.interfaces.createTap({ ip: '10.0.2.2/24' });

        // One writable side shared by every VM.
        const toTap = new ReadableStream({
            start: (c) => { tapWriteController = c; }
        });
        toTap.pipeTo(tap.writable);

        // Everything the stack emits goes to every VM; their NICs filter.
        // deliver() swallows per-VM errors so this pipe can never error out --
        // if it did, every VM would lose networking at once.
        tap.readable.pipeTo(new WritableStream({
            write: (buf) => { for (const p of vmPorts) deliver(p, buf); }
        })).catch(e => console.error('[net] tap read pipe ended:', e));

        const dhcpMod = await import('@tcpip/dhcp');
        const dhcp = await dhcpMod.createDhcp(stack.udp);
        dhcp.serve({
            // Widened from .15-.31 (17 addresses): with many client windows on
            // one segment the old range ran out and later VMs got no lease.
            leaseRange: { start: '10.0.2.15', end: '10.0.2.200' },
            serverIdentifier: '10.0.2.2',
            netmask: '255.255.255.0',
            router: '10.0.2.2',
            dnsServers: ['10.0.2.2'],
        });

        // DNS on 10.0.2.2:53. DHCP has always advertised this address as the
        // resolver but nothing listened on it, so every hostname lookup from
        // inside a VM timed out. The handler is looked up on window per query,
        // like cosmicHttpHandler, so a hot reload swaps in the new resolver.
        try {
            const dnsMod = await import('@tcpip/dns');
            const dns = await dnsMod.createDns(stack.udp);
            dns.serve({ port: 53, request: (q) => window.cosmicDnsHandler(q) });
            console.log('[dns] resolver listening on 10.0.2.2:53');
        } catch (e) {
            console.error('[dns] setup failed:', e);
        }

        const httpMod = await import('@tcpip/http');
        const http = await httpMod.createHttp(stack.tcp);
        // 8080: the game's own setup server (dispatch2.ini points here).
        // 80: browsers inside the VM. Same handler -- it routes on the Host
        // header, so frogfind.com is proxied out while the game's own paths
        // still resolve exactly as before.
        http.serve({ port: 8080, handler: (r) => window.cosmicHttpHandler(r) });
        http.serve({ port: 80, handler: (r) => window.cosmicHttpHandler(r) });

        window.startCosmicGameServer(stack, 6666);
        console.log('[net] shared stack ready: DHCP, DNS:53, HTTP:80/:8080, game:6666');
        return stack;
    })();
    return netStackPromise;
}
window.ensureNetwork = ensureNetwork;
// Monotonic id per emulator instance, used as its port id on the hub.
window.__vmSeq = window.__vmSeq || 0;
// Disk images downloaded once per page and copied per VM; see loads().
window.__imageCache = window.__imageCache || {};
// filename -> in-flight fetch promise, so clients booting at the same time
// share one download rather than racing to fetch the same image.
window.__imagePending = window.__imagePending || {};
// filename -> byte offsets of the computer-name value inside that image,
// discovered once and reused by every VM. See findNameSites().
window.__nameSites = window.__nameSites || {};

// ── per-VM computer name ─────────────────────────────────────────────────
//
// Every client boots the same C: image, so every Win95 comes up calling itself
// BEZERK. Two machines with one NetBIOS name on a segment is a conflict: the
// second reports "a duplicate name exists on the network" and its networking
// does not come up.
//
// The name lives in the registry hive inside the disk image as a length-
// prefixed inline string:
//
//     0c 00 06 00 "ComputerName" "BEZERK"
//     ^^^^^ ^^^^^  key len 12     value len 6
//
// so replacing it with another SIX-character name leaves every offset in the
// hive untouched -- no need to understand the hive format beyond this.
//
// It must be anchored to the key, though. "BEZERK" appears 77 times in the
// image and most are install paths (D:\PROGRA~1\BEZERK, Bezerk.url); only the
// 8 ComputerName and 4 Comment sites are the machine name. A blind
// search-and-replace would rewrite the game's own paths and break it.
// OFF. Patching the name straight into the image does not work, and this is
// why: the ComputerName values live inside CREG registry hives, in RGDB blocks
// that carry a checksum in their header. Rewriting the value bytes leaves the
// checksum stale, Windows decides the registry is damaged, and the machine
// boots to a black screen -- Ctrl+Alt+Del then reports
//
//   Invalid VxD dynamic link call from VWIN32(01) ... to device "0009"
//   Your Windows configuration is invalid. Run the Windows Setup program again
//
// because the VxDs cannot read their configuration. Same-length replacement is
// necessary but NOT sufficient; the containing block's checksum has to be
// recomputed too.
//
// Re-enabling this needs RGDB checksum fixup, which is worth doing only if
// duplicate NetBIOS names actually cause a problem in practice. Leaving it off
// costs nothing unless Windows complains about the duplicate name.
const PATCH_COMPUTER_NAME = false;
const VM_NAME_BASE = 'BEZERK';                       // what the image ships with
const VM_NAME_ANCHORS = ['ComputerName', 'Comment']; // keys whose value is the name

function computerNameFor(id) {
    // Always exactly VM_NAME_BASE.length characters, so the hive is unchanged
    // in size. Readable for the realistic range, base36 beyond it.
    const n = (id <= 99)
        ? 'BZRK' + String(id).padStart(2, '0')
        : 'BZ' + id.toString(36).toUpperCase().padStart(4, '0');
    return n.slice(0, VM_NAME_BASE.length);
}

// Locate every place the name is stored. Done ONCE per image, because the scan
// is not cheap: 900 ms across the 90 MB C: drive, and 4.7 s across the 500 MB
// D: drive purely to discover it holds no registry at all. Caching the offsets
// turns every later boot into a handful of byte writes.
function findNameSites(bytes) {
    const enc = (s) => Array.from(s, (ch) => ch.charCodeAt(0));
    const base = enc(VM_NAME_BASE);
    const sites = [];
    for (const anchor of VM_NAME_ANCHORS) {
        const pat = enc(anchor).concat(base);
        outer:
        for (let i = 0; i + pat.length <= bytes.length; i++) {
            for (let j = 0; j < pat.length; j++) {
                if (bytes[i + j] !== pat[j]) continue outer;
            }
            sites.push(i + anchor.length);   // offset of the VALUE, not the key
            i += pat.length - 1;
        }
    }
    return sites;
}

function writeNameAt(bytes, sites, newName) {
    if (newName.length !== VM_NAME_BASE.length) return 0;
    for (const off of sites) {
        for (let k = 0; k < newName.length; k++) bytes[off + k] = newName.charCodeAt(k);
    }
    return sites.length;
}

// Re-fetch one server script and swap it in place, keeping its <script> id so
// the next reload can find it again.
async function reloadServerScript(file, id, expectGlobal) {
    const resp = await fetch(`${file}?t=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) {
        console.error(`[reload] Failed to fetch ${file}: HTTP ${resp.status}`);
        return false;
    }
    const src = await resp.text();
    const oldScript = document.getElementById(id);
    if (oldScript) oldScript.remove();
    const script = document.createElement('script');
    script.id = id;
    script.textContent = src;
    document.body.appendChild(script);
    // A syntax error in an injected script is reported as an uncaught error
    // event, NOT thrown out of appendChild -- so the try/catch above cannot see
    // it and this used to claim success on a file that had not loaded at all.
    // Checking that the export actually landed is the only honest signal.
    if (expectGlobal && typeof window[expectGlobal] !== 'function') {
        console.error(`[reload] ${file} did not publish ${expectGlobal}() -- see the SyntaxError above; the OLD version is still live.`);
        return false;
    }
    console.log(`[reload] ${file} reloaded.`);
    return true;
}

async function reloadCosmicServer() {
    try {
        // Which server is selected has to survive the reload. cosmic-server.js
        // declares `let activeGameProfile = 'cosmic'`, so re-running it silently
        // reverts the selection -- and the page's dropdown, which is only told
        // about changes that go through setGameProfile, would keep claiming GTP
        // while Cosmic was actually answering.
        const previousProfile = (typeof window.getActiveGameProfile === 'function')
            ? window.getActiveGameProfile() : 'cosmic';

        // GTP first: cosmic-server.js's router looks up window.gtpHandleGameConnection
        // per connection, so it wants the new one in place before it goes live.
        // Absent gtp-server.js is not an error -- the page may predate it.
        for (const [file, id, hook] of [
            ['gtp-server.js', 'gtp-server-script', 'gtpHandleGameConnection'],
            ['acro-server.js', 'acro-server-script', 'acroHandleGameConnection'],
            ['ydkj-server.js', 'ydkj-server-script', 'ydkjHandleGameConnection'],
        ]) {
            if (document.getElementById(id)) await reloadServerScript(file, id, hook);
        }

        if (!(await reloadServerScript('cosmic-server.js', 'cosmic-server-script', 'handleGameConnection'))) return false;

        if (previousProfile !== 'cosmic' && typeof window.setActiveGameProfile === 'function') {
            // Goes through the setter, so the dropdown is told too.
            window.setActiveGameProfile(previousProfile);
            console.log(`[reload] restored game profile: ${previousProfile}`);
        }
        console.log('[reload] new window.cosmicHttpHandler / window.handleGameConnection are now live.');
        return true;
    } catch (e) {
        console.error('[reload] server reload failed:', e);
        return false;
    }
}
window.reloadCosmicServer = reloadCosmicServer;

// ── audio ──────────────────────────────────────────────────────────────────
//
// ScriptProcessorNode has been deprecated for years: it runs its callback on
// the MAIN thread, so any hitch there (a 90 MB image decompressing, a redraw,
// GC) lands as an audible dropout. AudioWorkletNode replaces it and runs on
// the realtime audio thread.
//
// That thread cannot reach into the emulator: the wasm instance, h2, and
// wasm_getaudio_f32 all live on the main thread and none of them are
// transferable. So instead of the worklet PULLING from the emulator, the main
// thread PUSHES into a SharedArrayBuffer ring buffer and the worklet drains
// it. webserver.py already sends the COOP/COEP headers SharedArrayBuffer
// needs, for the wasm's sake.
//
// The pump is self-limiting: it only ever tops the ring up to full, and the
// ring drains at exactly the audio clock, so the emulator is consumed at the
// right rate no matter how often the pump is called.
const AUDIO_CHANNELS = 2;
// Ring depth in emulator blocks. 32 blocks is enough slack to ride out a long
// main-thread stall without being so deep that sound lags the picture.
const AUDIO_RING_BLOCKS = 32;

const AUDIO_WORKLET_SOURCE = `
class Tiny386Player extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const o = options.processorOptions;
        this.ctl = new Int32Array(o.control);   // [0] read, [1] write
        this.data = new Float32Array(o.data);   // interleaved stereo
        this.channels = o.channels;
        this.frames = this.data.length / o.channels;
        // The audio thread is not subject to background-tab timer throttling,
        // so while the page is hidden we beat for the main thread. Off by
        // default: when the tab is visible setTimeout already drives the loop
        // and these messages would be pure overhead.
        this.tick = false;
        this.port.onmessage = (e) => { this.tick = !!(e.data && e.data.hidden); };
    }
    process(inputs, outputs) {
        const out = outputs[0];
        const need = out[0].length;
        const read = Atomics.load(this.ctl, 0);
        const write = Atomics.load(this.ctl, 1);
        let avail = write - read;
        if (avail < 0) avail += this.frames;
        const n = Math.min(need, avail);
        for (let i = 0; i < n; i++) {
            const base = ((read + i) % this.frames) * this.channels;
            for (let ch = 0; ch < out.length; ch++)
                out[ch][i] = this.data[base + ch];
        }
        // Underrun: silence rather than repeating stale audio, which buzzes.
        for (let i = n; i < need; i++)
            for (let ch = 0; ch < out.length; ch++) out[ch][i] = 0;
        Atomics.store(this.ctl, 0, (read + n) % this.frames);
        if (this.tick) this.port.postMessage(0);
        return true;
    }
}
registerProcessor('tiny386-player', Tiny386Player);
`;

// One Blob URL for the whole page; addModule() still has to be called per
// AudioContext, but the module itself need only be built once.
let audioWorkletUrl = null;
function getAudioWorkletUrl() {
    if (!audioWorkletUrl) {
        audioWorkletUrl = URL.createObjectURL(
            new Blob([AUDIO_WORKLET_SOURCE], { type: 'application/javascript' }));
    }
    return audioWorkletUrl;
}


function get_tiny386(screen) {

// Identity for this emulated machine: drives its computer name (patched into
// its disk copy below) and its virtual MAC on the shared segment.
const vmId = ++window.__vmSeq;
let mem8;
let logger = null;
let running = false;
let audctx;
let audioNode = null;        // AudioWorkletNode, or the legacy fallback
let audioPumpTimer = null;   // interval that tops up the ring buffer
// How long one wasm_loop should block the main thread. Each round inside it is
// PC_STEP_COUNT (10240) guest instructions plus a device sweep, and the wasm
// defaults to 64 rounds -- about 655k instructions, which measured 55-95 ms
// here. That is over Chrome's 50 ms reporting threshold ("[Violation]
// 'setTimeout' handler took NNms") and it also capped the 20 ms redraw loop at
// whatever rate the blocks retired, ~10-13 fps.
//
// Total speed is unchanged by this -- a smaller block is just more calls. It
// only sets how often the thread comes back for frames, audio and input.
// 16 ms is one 60 Hz frame.
const EMU_BLOCK_TARGET_MS = 16;
const EMU_BLOCK_START_ROUNDS = 16;
const EMU_BLOCK_MIN_ROUNDS = 2;
const EMU_BLOCK_MAX_ROUNDS = 64;
const EMU_BLOCK_DEFAULT_ROUNDS = 64;   // what the wasm uses if we never set it

// Runs one slice of the emulator. Set once the VM is up; the audio worklet
// calls it to keep the CPU stepping while the tab is hidden and setTimeout is
// throttled. Null before boot and after shutdown.
let step_emulator = null;
let visibilityHandler = null;
let instance;
let h2;

function get_string(ptr)
{
    let len;
    for (len = 0; mem8[ptr + len]; len++);
    return new TextDecoder("utf-8").decode(mem8.slice(ptr, ptr + len));
}

function copy_string(str, malloc)
{
    const buf = new TextEncoder().encode(str);
    const ptr = malloc(buf.length + 1);
    for (let i = 0; i < buf.length; i++)
        mem8[ptr + i] = buf[i];
    mem8[ptr + buf.length] = 0;
    return ptr;
}

function __abort(strptr)
{
    throw new Error('wasm abort: ' + get_string(strptr));
}

function exit(status)
{
    throw new Error('wasm exit with ' + status);
}

// Emulated time, advanced in bounded steps instead of read straight off the
// wall clock.
//
// Browsers clamp setTimeout to once per SECOND in a hidden tab, so main_loop
// stops driving the CPU -- but Date.now() keeps running, and the i8254 bills
// the guest for the entire gap:
//
//     d = (get_uticks() - count_load_time) * PIT_FREQ / 1000000;
//
// One second of stall is 1,193,182 PIT ticks, i.e. ~100 IRQ0 owed at once at
// 100 Hz. The guest wakes up, the interrupts nest faster than the handlers
// unwind, and the kernel stack overflows -- which is exactly what the abort
// reported: SP = 0xc0efd000 with CR2 = 0xc0efcffc (CR2 == SP - 4, ring 0,
// paging on) is a page fault taken while PUSHING onto its own stack.
//
// Capping the per-call advance makes the guest see time creep rather than
// leap, so the backlog can never form. Emulated time then drifts behind real
// time while throttled -- unavoidable regardless, since the CPU is only
// getting a thousandth of its cycles in that state.
const MAX_CLOCK_STEP_MS = 50;
let clockVirtual = Date.now();
let clockLastReal = clockVirtual;

function __get_mticks()
{
    const real = Date.now();
    const delta = real - clockLastReal;
    clockLastReal = real;
    // Called many times per wasm_loop, so in the foreground each delta is a
    // fraction of a millisecond and the sum tracks real time closely. Only a
    // genuine stall ever reaches the cap.
    clockVirtual += Math.min(Math.max(delta, 0), MAX_CLOCK_STEP_MS);
    return clockVirtual;
}

function dolog(s)
{
    if (logger !== null)
        logger(s);
}

function __console_print(ptr)
{
    dolog(get_string(ptr));
}

const filestore = {}
const filestore_list = []
function __filestore_fetch(pathptr)
{
    const path = get_string(pathptr);
    filestore_list.push(path);
}

function __open_get_size(pathptr)
{
    const path = get_string(pathptr);
    if (path in filestore) {
        return filestore[path].length;
    }
    return -1;
}

const fdtable = {}
let next_fd = 3;
function __open(pathptr)
{
    const path = get_string(pathptr);
    if (path in filestore) {
        const fd = next_fd;
        next_fd++;
        fdtable[fd] = filestore[path];
        return fd;
    }
    return -1;
}

function __read(fd, bufptr, off, len)
{
    if (fd in fdtable) {
        const src = fdtable[fd];
        if (off >= src.length || off + len > src.length)
            return -1;
        for (let i = 0; i < len; i++)
            mem8[bufptr + i] = src[off + i];
        return 0;
    }
    return -1;
}

function __write(fd, bufptr, off, len)
{
    if (fd in fdtable) {
        const dst = fdtable[fd];
        if (off >= dst.length || off + len > dst.length)
            return -1;
        for (let i = 0; i < len; i++)
            dst[off + i] = mem8[bufptr + i];
        return 0;
    }
    return -1;
}

function __close(fd)
{
    delete fdtable[fd];
}

function drawfb(fbptr, width, height)
{
    const ctx = screen.getContext('2d');

    screen.width = width;
    screen.height = height;

    const data = ctx.createImageData(screen.width, screen.height);

    const len = screen.width * screen.height;
    for (let i = 0; i < len; i++) {
        data.data[4 * i + 0] = mem8[fbptr + 4 * i + 2];
        data.data[4 * i + 1] = mem8[fbptr + 4 * i + 1];
        data.data[4 * i + 2] = mem8[fbptr + 4 * i + 0];
        data.data[4 * i + 3] = 255;
    }
    ctx.putImageData(data, 0, 0);
}

// charmap, codemap taken from copy/v86
var charmap = new Uint16Array([
    0, 0, 0, 0,  0, 0, 0, 0,
    // 0x08: backspace, tab, enter
    0x0E, 0x0F, 0, 0,  0, 0x1C, 0, 0,

    // 0x10: shift, ctrl, alt, pause, caps lock
    0x2A, 0x1D, 0x38, 0,  0x3A, 0, 0, 0,

    // 0x18: escape
    0, 0, 0, 0x01,  0, 0, 0, 0,

    // 0x20: spacebar, page down/up, end, home, arrow keys, ins, del
    0x39, 0xE049, 0xE051, 0xE04F,  0xE047, 0xE04B, 0xE048, 0xE04D,
    0x50, 0, 0, 0,  0, 0x52, 0x53, 0,

    // 0x30: numbers
    0x0B, 0x02, 0x03, 0x04,  0x05, 0x06, 0x07, 0x08,
    0x09, 0x0A,

    // 0x3B: ;= (firefox only)
    0, 0x27, 0, 0x0D, 0, 0,

    // 0x40
    0,

    // 0x41: letters
    0x1E, 0x30, 0x2E, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
    0x31, 0x18, 0x19, 0x10, 0x13, 0x1F, 0x14, 0x16, 0x2F, 0x11, 0x2D, 0x15, 0x2C,

    // 0x5B: Left Win, Right Win, Menu
    0xE05B, 0xE05C, 0xE05D, 0, 0,

    // 0x60: keypad
    0x52, 0x4F, 0x50, 0x51, 0x4B, 0x4C, 0x4D, 0x47,
    0x48, 0x49, 0, 0, 0, 0, 0, 0,

    // 0x70: F1 to F12
    0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58,

    0, 0, 0, 0,

    // 0x80
    0, 0, 0, 0,  0, 0, 0, 0,
    0, 0, 0, 0,  0, 0, 0, 0,

    // 0x90: Numlock
    0x45, 0, 0, 0,  0, 0, 0, 0,
    0, 0, 0, 0,     0, 0, 0, 0,

    // 0xA0: - (firefox only)
    0, 0, 0, 0,  0, 0, 0, 0,
    0, 0, 0, 0,  0, 0x0C, 0, 0,

    // 0xB0
    0, 0, 0, 0,  0, 0, 0, 0,
    0, 0, 0x27, 0x0D,  0x33, 0x0C, 0x34, 0x35,

    // 0xC0
    // `
    0x29, 0, 0, 0,  0, 0, 0, 0,
    0, 0, 0, 0,     0, 0, 0, 0,

    // 0xD0
    // [']\
    0, 0, 0, 0,     0, 0, 0, 0,
    0, 0, 0, 0x1A,  0x2B, 0x1B, 0x28, 0,

    // 0xE0
    // Apple key on Gecko, Right alt
    0xE05B, 0xE038, 0, 0,  0, 0, 0, 0,
    0, 0, 0, 0,            0, 0, 0, 0,
]);

// From:
// https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code#Code_values_on_Linux_%28X11%29_%28When_scancode_is_available%29
// http://stanislavs.org/helppc/make_codes.html
// http://www.computer-engineering.org/ps2keyboard/scancodes1.html
//
// Mapping from event.code to scancode
var codemap = {
    "Escape": 0x0001,
    "Digit1": 0x0002,
    "Digit2": 0x0003,
    "Digit3": 0x0004,
    "Digit4": 0x0005,
    "Digit5": 0x0006,
    "Digit6": 0x0007,
    "Digit7": 0x0008,
    "Digit8": 0x0009,
    "Digit9": 0x000a,
    "Digit0": 0x000b,
    "Minus": 0x000c,
    "Equal": 0x000d,
    "Backspace": 0x000e,
    "Tab": 0x000f,
    "KeyQ": 0x0010,
    "KeyW": 0x0011,
    "KeyE": 0x0012,
    "KeyR": 0x0013,
    "KeyT": 0x0014,
    "KeyY": 0x0015,
    "KeyU": 0x0016,
    "KeyI": 0x0017,
    "KeyO": 0x0018,
    "KeyP": 0x0019,
    "BracketLeft": 0x001a,
    "BracketRight": 0x001b,
    "Enter": 0x001c,
    "ControlLeft": 0x001d,
    "KeyA": 0x001e,
    "KeyS": 0x001f,
    "KeyD": 0x0020,
    "KeyF": 0x0021,
    "KeyG": 0x0022,
    "KeyH": 0x0023,
    "KeyJ": 0x0024,
    "KeyK": 0x0025,
    "KeyL": 0x0026,
    "Semicolon": 0x0027,
    "Quote": 0x0028,
    "Backquote": 0x0029,
    "ShiftLeft": 0x002a,
    "Backslash": 0x002b,
    "KeyZ": 0x002c,
    "KeyX": 0x002d,
    "KeyC": 0x002e,
    "KeyV": 0x002f,
    "KeyB": 0x0030,
    "KeyN": 0x0031,
    "KeyM": 0x0032,
    "Comma": 0x0033,
    "Period": 0x0034,
    "Slash": 0x0035,
    "IntlRo": 0x0035,
    "ShiftRight": 0x0036,
    "NumpadMultiply": 0x0037,
    "AltLeft": 0x0038,
    "Space": 0x0039,
    "CapsLock": 0x003a,
    "F1": 0x003b,
    "F2": 0x003c,
    "F3": 0x003d,
    "F4": 0x003e,
    "F5": 0x003f,
    "F6": 0x0040,
    "F7": 0x0041,
    "F8": 0x0042,
    "F9": 0x0043,
    "F10": 0x0044,
    "NumLock": 0x0045,
    "ScrollLock": 0x0046,
    "Numpad7": 0x0047,
    "Numpad8": 0x0048,
    "Numpad9": 0x0049,
    "NumpadSubtract": 0x004a,
    "Numpad4": 0x004b,
    "Numpad5": 0x004c,
    "Numpad6": 0x004d,
    "NumpadAdd": 0x004e,
    "Numpad1": 0x004f,
    "Numpad2": 0x0050,
    "Numpad3": 0x0051,
    "Numpad0": 0x0052,
    "NumpadDecimal": 0x0053,
    "IntlBackslash": 0x0056,
    "F11": 0x0057,
    "F12": 0x0058,

    "NumpadEnter": 0xe01c,
    "ControlRight": 0xe01d,
    "NumpadDivide": 0xe035,
    //"PrintScreen": 0x0063,
    "AltRight": 0xe038,
    "Home": 0xe047,
    "ArrowUp": 0xe048,
    "PageUp": 0xe049,
    "ArrowLeft": 0xe04b,
    "ArrowRight": 0xe04d,
    "End": 0xe04f,
    "ArrowDown": 0xe050,
    "PageDown": 0xe051,
    "Insert": 0xe052,
    "Delete": 0xe053,

    "OSLeft": 0xe05b,
    "OSRight": 0xe05c,
    "ContextMenu": 0xe05d,
};

function register_kbdmouse(h, exports)
{
    function mousehandler(event) {
        const x = event.movementX;
        const y = event.movementY;
        screen.tabIndex = 1;
        exports.wasm_send_mouse(h, x, y, 0, event.buttons);
    }

    let last_x;
    let last_y;
    let btn;
    let touchend_time;
    function touchstarthandler(event) {
        last_x = event.changedTouches[0].clientX;
        last_y = event.changedTouches[0].clientY;
        if (Date.now() - touchend_time < 200) {
            btn = 1;
        } else {
            btn = 0;
        }
    }

    function touchmovehandler(event) {
        event.preventDefault();
        const touch = event.changedTouches[0];

        const x = event.changedTouches[0].clientX;
        const y = event.changedTouches[0].clientY;

        exports.wasm_send_mouse(h, x - last_x, y - last_y, 0, btn);
        last_x = x;
        last_y = y;
    }

    function touchendhandler(event) {
        btn = 0;
        touchend_time = Date.now();
        exports.wasm_send_mouse(h, 0, 0, 0, 0);
    }

    screen.addEventListener('mousemove', mousehandler);
    screen.addEventListener('mousedown', mousehandler);
    screen.addEventListener('mouseup', mousehandler);
    screen.addEventListener('touchstart', touchstarthandler);
    screen.addEventListener('touchend', touchendhandler);
    screen.addEventListener('touchmove', touchmovehandler);

    function kbdhandler(ev, keypress) {
        ev.preventDefault();
        const code = ev.code;
        if (code in codemap) {
            exports.wasm_send_kbd(h, keypress, codemap[code]);
        } else {
            const code = ev.keyCode;
            if (code < 256) {
                if (code in charmap)
                    exports.wasm_send_kbd(h, keypress, charmap[code]);
            }
        }
    }

    screen.addEventListener('keydown', (event) => kbdhandler(event, 1));
    screen.addEventListener('keyup', (event) => kbdhandler(event, 0));

    screen.addEventListener('fullscreenchange', (event) => {
        if (!document.fullscreenElement) {
            screen.style.cursor = 'default';
        } else {
            screen.requestPointerLock();
            if ('keyboard' in navigator &&
                typeof navigator.keyboard.lock === 'function') {
                navigator.keyboard.lock();
            }
        }
    });
}

let on_packet_cb_func = null;
let detachFromHub = null;   // set when this VM joins the shared segment
function on_packet_cb(buf, size)
{
    if (on_packet_cb_func !== null)
        on_packet_cb_func(mem8.slice(buf, buf + size));
}

const imports = {
    env: {
        __abort,
        exit,
        __get_mticks,
        __console_print,
        __filestore_fetch,
        __open_get_size,
        __open,
        __read,
        __write,
        __close,
        sin: Math.sin,
        cos: Math.cos,
        pow: Math.pow,
        log10: Math.log10,
        log2: Math.log2,
        tan: Math.tan,
        atan2: Math.atan2,
        round: Math.round,
        // new: networking
        on_packet_cb
    }
};

const fetchopt = { cache: 'no-store' };

// Give this VM its own identity inside its private disk copy. Runs on the
// copy, never the cached master, so each machine gets a different name.
function applyMachineIdentity(name, bytes) {
    if (!PATCH_COMPUTER_NAME) return;
    if (!(name in window.__nameSites)) {
        // First time we have seen this image: find the sites once.
        window.__nameSites[name] = findNameSites(bytes);
    }
    const sites = window.__nameSites[name];
    if (!sites.length) return;               // e.g. the D: drive, no registry
    const myName = computerNameFor(vmId);
    writeNameAt(bytes, sites, myName);
    dolog('computer name -> ' + myName + ' (' + sites.length + ' registry sites)\n');
}

// ── zstd-compressed disk images ────────────────────────────────────────────
//
// A .img.zst named in the .ini is fetched compressed and expanded here, which
// is worth a lot over the wire: the 500 MB D: drive is mostly zeros and empty
// FAT, so it compresses to a fraction of that.
//
// get_unzstd() comes from unzstd.js (loaded by index.html) and builds a fresh
// WebAssembly instance -- with a 2048-page heap -- every time it is called.
// Memoised into one promise so several images, and several clients, share a
// single instance instead of each standing up their own decompressor.
let unzstdReady = null;
function getUnzstd() {
    if (unzstdReady) return unzstdReady;
    unzstdReady = new Promise((resolve, reject) => {
        if (typeof get_unzstd !== 'function') {
            reject(new Error('unzstd.js is not loaded -- add ' +
                '<script src="unzstd.js"></script> before main.js'));
            return;
        }
        try {
            get_unzstd(resolve);
        } catch (e) {
            reject(e);
        }
    }).catch(err => {
        // Don't cache the failure: a missing unzstd.wasm is fixable without a
        // page reload, and retrying is cheap next to a 500 MB download.
        unzstdReady = null;
        throw err;
    });
    return unzstdReady;
}

function unzstdBytes(name, bytes) {
    dolog('decompressing ' + name + ' (' + bytes.byteLength + ' bytes) ...\n');
    return getUnzstd().then(unzstd => {
        const out = unzstd(bytes);
        dolog('decompressed ' + name + ' -> ' + out.byteLength + ' bytes\n');
        return out;
    });
}

function setup_audio(ctx, h) {
    const audlen = instance.exports.wasm_getaudiolen(h);

    if (typeof SharedArrayBuffer === 'undefined') {
        dolog('audio: SharedArrayBuffer unavailable (needs COOP/COEP headers) '
              + '-- falling back to the deprecated ScriptProcessorNode\n');
        setup_audio_legacy(ctx, h, audlen);
        return;
    }

    const frames = audlen * AUDIO_RING_BLOCKS;
    const control = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    const data = new SharedArrayBuffer(frames * AUDIO_CHANNELS * Float32Array.BYTES_PER_ELEMENT);
    const ctl = new Int32Array(control);
    const ring = new Float32Array(data);

    ctx.audioWorklet.addModule(getAudioWorkletUrl()).then(() => {
        const node = new AudioWorkletNode(ctx, 'tiny386-player', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [AUDIO_CHANNELS],
            processorOptions: { control, data, channels: AUDIO_CHANNELS },
        });
        node.connect(ctx.destination);
        audioNode = node;

        function pump() {
            // Re-read every time: memory.grow() detaches existing views, and
            // a stale one silently reads zeros -- i.e. silence.
            const mf32 = new Float32Array(instance.exports.memory.buffer);
            const read = Atomics.load(ctl, 0);
            let write = Atomics.load(ctl, 1);
            for (;;) {
                let used = write - read;
                if (used < 0) used += frames;
                if (frames - 1 - used < audlen) break;   // no room for a block
                // Planar in wasm (all of channel 0, then channel 1),
                // interleaved in the ring.
                const ap = instance.exports.wasm_getaudio_f32(h) / 4;
                for (let i = 0; i < audlen; i++) {
                    const dst = ((write + i) % frames) * AUDIO_CHANNELS;
                    for (let ch = 0; ch < AUDIO_CHANNELS; ch++)
                        ring[dst + ch] = mf32[ap + audlen * ch + i];
                }
                write = (write + audlen) % frames;
            }
            Atomics.store(ctl, 1, write);
        }

        audioPumpTimer = setInterval(pump, 10);

        // Hidden-tab heartbeat. process() fires every 128 frames (~344 Hz at
        // 44.1 kHz) whether or not there is anything to play, so this keeps
        // running even if the ring has starved -- which it will, since the
        // pump above is a throttled setTimeout. Stepping the CPU here also
        // means the clock clamp above rarely has to engage.
        node.port.onmessage = () => {
            if (step_emulator) step_emulator();
            pump();
        };
        visibilityHandler = () => {
            node.port.postMessage({ hidden: document.hidden });
        };
        document.addEventListener('visibilitychange', visibilityHandler);
        visibilityHandler();

        dolog('audio: AudioWorklet ready (' + audlen + '-frame blocks, '
              + AUDIO_RING_BLOCKS + '-block ring, hidden-tab heartbeat on)\n');
    }).catch(err => {
        dolog('audio: AudioWorklet setup failed (' + err.message + ') '
              + '-- falling back to ScriptProcessorNode\n');
        setup_audio_legacy(ctx, h, audlen);
    });
}

// Kept only for browsers without SharedArrayBuffer, or if the worklet module
// fails to load. Deprecated, and the source of the console warning.
function setup_audio_legacy(ctx, h, audlen) {
    const mf32 = new Float32Array(instance.exports.memory.buffer);
    const n = 8;
    const dummybuf = ctx.createBuffer(1, audlen * n, 44100);
    const dummysrc = ctx.createBufferSource();
    const audcb = ctx.createScriptProcessor(audlen * n, 1, 2);
    audcb.addEventListener('audioprocess', (ev) => {
        const out = ev.outputBuffer;
        for (let j = 0; j < n; j++) {
            const ap = instance.exports.wasm_getaudio_f32(h) / 4;
            for (let ch = 0; ch < 2; ch++) {
                const buf = out.getChannelData(ch);
                const off = audlen * ch;
                for (let i = 0; i < audlen; i++)
                    buf[audlen * j + i] = mf32[ap + off + i];
            }
        }
    });
    audcb.connect(ctx.destination);
    dummysrc.buffer = dummybuf;
    dummysrc.loop = true;
    dummysrc.connect(audcb);
    dummysrc.start();
    audioNode = audcb;
}

function loads(files, i, cont) {
    if (i == files.length)
        cont();
    else {
        const name = files[i];
        // Download each image ONCE for the whole page, then hand every VM its
        // own copy. Without the cache a second client re-fetched ~1.2 GB of
        // disk images (90 MB C: + 500 MB D: + 632 MB ISO for win95c.ini),
        // which is what made the first one stall while the second loaded.
        //
        // The copy is not optional: Win95 writes to its disks (swap, registry,
        // temp), so sharing one Uint8Array would let the VMs corrupt each
        // other's filesystem. This saves the network round-trip and the decode,
        // NOT the memory -- each running VM still costs a full set of images.
        // Log the size the EMULATOR will see. A .zst that still reads as its
        // compressed size here means the bytes never went through
        // unzstdBytes() -- almost always a stale main.js or a stale
        // __imageCache entry from a page load before .zst support existed.
        const install = (master) => {
            filestore[name] = master.slice();
            applyMachineIdentity(name, filestore[name]);
            dolog(name + ': ' + filestore[name].length + ' bytes'
                  + (name.endsWith('.zst') ? ' (decompressed)' : '') + '\n');
        };

        const cached = window.__imageCache[name];
        if (cached) {
            dolog('reuse ' + name + ' (cached)\n');
            install(cached);
            loads(files, i + 1, cont);
            return;
        }
        // A download already running for this image: wait on it instead of
        // starting a second one. __imageCache is only populated once the fetch
        // resolves, so N clients started together -- which is exactly what the
        // auto-start checkbox does -- would otherwise each pull their own copy
        // of the same ~590 MB before any of them finished.
        const pending = window.__imagePending[name];
        if (pending) {
            dolog('wait ' + name + ' (already downloading)\n');
            pending.then(master => {
                install(master);
                loads(files, i + 1, cont);
            }).catch(() => {
                // The client that started the download already logged why.
                dolog('giving up on ' + name + '\n');
            });
            return;
        }
        dolog('fetch ' + name + ' ...\n');
        const download = fetch(name, fetchopt)
            .then(response => {
                if (!response.ok)
                    throw new Error(name + ': HTTP ' + response.status);
                return response.arrayBuffer();
            })
            // Decompress BEFORE caching, so the cache holds plain image bytes:
            // N clients then share one download AND one decompression, and
            // applyMachineIdentity below is patching a real disk image rather
            // than compressed bytes. filestore stays keyed by the .zst name
            // because that is what the .ini asked for -- the emulator just
            // sees a larger file than it fetched.
            .then(bytes => name.endsWith('.zst') ? unzstdBytes(name, bytes) : bytes)
            .then(bytes => {
                const master = new Uint8Array(bytes);
                window.__imageCache[name] = master;
                delete window.__imagePending[name];
                return master;
            })
            .catch(err => {
                delete window.__imagePending[name];
                dolog('ERROR loading ' + name + ': ' + err.message + '\n');
                throw err;
            });
        window.__imagePending[name] = download;
        download.then(master => {
            install(master);
            loads(files, i + 1, cont);
        }).catch(err => {
            // Without this the chain just stops: cont() is never reached, the
            // VM never boots, and nothing says why.
            dolog('boot aborted: ' + err.message + '\n');
        });
    }
}

function start(inifile)
{
    fetch('tiny386.wasm', fetchopt)
        .then(response => response.arrayBuffer())
        .then(bytes => WebAssembly.compile(bytes))
        .then(module => new WebAssembly.Instance(module, imports))
        .then(instance1 => {
            instance = instance1;
            instance.exports.memory.grow(1024 * 10); // 64K * 10K
            mem8 = new Uint8Array(instance.exports.memory.buffer);
            dolog('ini file ' + inifile + '\n');
            loads([inifile], 0, () => {
                const iniptr = copy_string(inifile, instance.exports.malloc);
                const h1 = instance.exports.wasm_prepare(iniptr);
                // XXX
                const width = mem8[h1 + 19 * 4] | (mem8[h1 + 19 * 4 + 1] << 8);
                const height = mem8[h1 + 20 * 4] | (mem8[h1 + 20 * 4 + 1] << 8);
                loads(filestore_list, 0, () => {
                    h2 = instance.exports.wasm_init(h1);
                    const fbptr = instance.exports.wasm_getfb(h2);
                    if (h2 != 0) {
                        register_kbdmouse(h2, instance.exports);
                        screen.focus();

                        // web audio
                        audctx = new window.AudioContext({sampleRate: 44100});
                        setup_audio(audctx, h2);

                        // networking -- join the page-wide shared segment.
                        // The stack, DHCP, DNS, HTTP and game servers are
                        // created once by ensureNetwork() and shared by every
                        // client window, so all the VMs on this page sit on
                        // one Ethernet segment and can play each other. This
                        // used to build a whole private stack per instance.
                        // 1514, not 1500: a full Ethernet frame is the
                        // 1500-byte MTU payload PLUS the 14-byte header.
                        // Allocating 1500 let every full-size frame write 14
                        // bytes past the end of this buffer and corrupt the
                        // WASM heap -- erratic networking rather than a clean
                        // crash. The length guard drops anything oversized.
                        const wbuf = instance.exports.malloc(1514);
                        const injectIntoVm = (buf) => {
                            if (buf.length > 1514)
                                return;
                            for (let i = 0; i < buf.length; i++)
                                mem8[wbuf + i] = buf[i];
                            instance.exports.wasm_inject_packet(h2, wbuf, buf.length);
                        };
                        const hubPort = { id: vmId, inject: injectIntoVm };
                        detachFromHub = hubAttach(hubPort);
                        // Outbound frames from this VM go to the stack and to
                        // every other VM on the segment.
                        on_packet_cb_func = function (buf) {
                            // Stamp this VM's virtual MAC on the way out, so the
                            // DHCP server sees a distinct client per window.
                            macOutbound(buf, hubPort);
                            hubBroadcast(buf, vmId);
                        };
                        ensureNetwork().catch(e => console.error('[net] setup failed:', e));

                        running = true;
                        // Single guarded entry point: wasm_loop must never be
                        // re-entered, and it now has two possible drivers
                        // (setTimeout when visible, the audio worklet when not).
                        let inLoop = false;
                        // Optional: older builds of the wasm do not export it,
                        // in which case the block stays at its built-in 64 and
                        // everything below simply does not adapt.
                        const setBlockRounds = instance.exports.wasm_set_block_rounds;
                        let blockRounds = EMU_BLOCK_DEFAULT_ROUNDS;
                        let blockAvgMs = 0;
                        if (setBlockRounds) {
                            blockRounds = EMU_BLOCK_START_ROUNDS;
                            setBlockRounds(blockRounds);
                        }
                        // Guest-fault tracing, off unless asked for. See
                        // cpui386_step in i386.c: prints CS:EIP for every
                        // exception the GUEST takes, which is how a client that
                        // dies on a particular packet gets pinned to an address
                        // in its own .exe.
                        window.traceGuestFaults = (on) => {
                            const f = instance.exports.wasm_set_trace_faults;
                            if (!f) { dolog('guest-fault tracing needs a newer tiny386.wasm\n'); return false; }
                            f(h2, on ? 1 : 0);
                            dolog('guest fault tracing ' + (on ? 'ON' : 'off') + '\n');
                            return !!on;
                        };
                        step_emulator = () => {
                            if (!running || inLoop) return;
                            inLoop = true;
                            const t0 = setBlockRounds ? performance.now() : 0;
                            try { instance.exports.wasm_loop(h2); }
                            finally { inLoop = false; }
                            if (!setBlockRounds) return;
                            // Aim for EMU_BLOCK_TARGET_MS per block. Smoothed,
                            // so one hitch (GC, a disk read) cannot swing it,
                            // and with wide hysteresis so it settles instead of
                            // oscillating between two sizes.
                            const dt = performance.now() - t0;
                            blockAvgMs = blockAvgMs ? blockAvgMs * 0.9 + dt * 0.1 : dt;
                            if (blockAvgMs > EMU_BLOCK_TARGET_MS * 1.5 && blockRounds > EMU_BLOCK_MIN_ROUNDS) {
                                blockRounds = Math.max(EMU_BLOCK_MIN_ROUNDS, blockRounds >> 1);
                                setBlockRounds(blockRounds);
                                blockAvgMs = 0;
                            } else if (blockAvgMs < EMU_BLOCK_TARGET_MS * 0.5 && blockRounds < EMU_BLOCK_MAX_ROUNDS) {
                                blockRounds = Math.min(EMU_BLOCK_MAX_ROUNDS, blockRounds * 2);
                                setBlockRounds(blockRounds);
                                blockAvgMs = 0;
                            }
                        };

                        // setTimeout(fn, 0) is not 0: once the nesting depth
                        // passes 5 browsers clamp it to ~4 ms. That was 4% of a
                        // 95 ms block and invisible, but it would be 20% of a
                        // 16 ms one -- shortening the blocks would have cost
                        // real speed. A MessageChannel has no minimum delay, so
                        // blocks retire back to back and the shorter block is
                        // free. Still a task per block, so the browser can
                        // still render and run timers between them.
                        const loopChannel = new MessageChannel();
                        loopChannel.port1.onmessage = () => {
                            if (!running) return;
                            step_emulator();
                            loopChannel.port2.postMessage(0);
                        };
                        loopChannel.port2.postMessage(0);

                        function redraw_loop() {
                            drawfb(fbptr, width, height);
                            if (running)
                                setTimeout(redraw_loop, 20);
                        }
                        redraw_loop();
                    }
                });
            });
        });
}

function stop()
{
    running = false;
    step_emulator = null;
    // Stop the pump before closing the context: it reaches into the wasm
    // instance every 10 ms and must not keep running against a stopped VM.
    if (audioPumpTimer !== null) { clearInterval(audioPumpTimer); audioPumpTimer = null; }
    if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        visibilityHandler = null;
    }
    if (audioNode) { try { audioNode.disconnect(); } catch (e) { /* already gone */ } audioNode = null; }
    if (audctx) { audctx.close(); audctx = null; }
    on_packet_cb_func = null;
    if (detachFromHub) { detachFromHub(); detachFromHub = null; }
}

return {
    start,
    stop,
    set_logger: function (o) { logger = o; },
    send_kbd: function(down, key) { instance.exports.wasm_send_kbd(h2, down, key); },
    send_mouse: function(x, y, z, btn) {
        instance.exports.wasm_send_mouse(h2, x, y, z, btn);
    },
}
}
