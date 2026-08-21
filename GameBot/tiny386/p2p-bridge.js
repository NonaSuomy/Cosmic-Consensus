'use strict';

// Zero-service multiplayer bridge.
//
// This deliberately uses manual WebRTC signaling: GitHub Pages can host this
// file, but it cannot accept signaling connections.  The data channel carries
// complete Ethernet frames, so the existing tcpip.js stack and game servers
// do not need a second protocol or a public TCP port.
(function () {
  const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
  let role = 'local';
  let guestPc = null;
  let guestChannel = null;
  const pendingHostPcs = [];
  let pendingHostPc = null;
  const hostPeers = new Set();
  let ydkjStream = null;
  let onYdkjCommand = null;
  let onYdkjAssignment = null;
  let onYdkjBuzzerResult = null;
  let guestBuzzAccepted = false;
  let onFrame = null;
  let onStatus = (s) => console.log('[p2p] ' + s);
  const pendingIncoming = [];
  const pendingGuestOutgoing = [];
  let txFrames = 0;
  let rxFrames = 0;

  // The transport is shared by every game profile, but the control channel
  // messages below are meaningful only for YDKJ Net Show.
  function ydkjSelected() {
    const selector = document.getElementById('gameselect');
    return !selector || selector.value === 'ydkj';
  }

  function status(s) {
    const text = String(s);
    if (/^YDKJ\b/i.test(text) && !ydkjSelected()) return;
    onStatus(text);
  }

  function wireChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      status('WebRTC data channel connected');
      const queue = channel._frameQueue || [];
      channel._frameQueue = [];
      for (const frame of queue) channel.send(frame);
    };
    channel.onclose = () => status('WebRTC data channel closed');
    channel.onerror = () => status('WebRTC data channel error');
    channel.onmessage = (event) => {
      const data = event.data instanceof ArrayBuffer
        ? new Uint8Array(event.data)
        : event.data instanceof Blob ? null : new Uint8Array(event.data);
      if (data) { receiveFrame(data); return; }
      event.data.arrayBuffer().then((b) => receiveFrame(new Uint8Array(b)));
    };
  }

  function wireControlChannel(channel, pc, isHost) {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      if (isHost) {
        assignYdkjPlayers();
      } else {
        status('YDKJ control channel connected');
      }
    };
    channel.onclose = () => status('YDKJ control channel closed');
    channel.onerror = () => status('YDKJ control channel error');
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (isHost && message.type === 'buzzer') {
        const assigned = pc._ydkjPlayerKey || '';
        const accepted = String(message.key || '').toUpperCase() === assigned &&
          ![...hostPeers].some((peer) => peer._ydkjBuzzed);
        if (accepted) {
          pc._ydkjBuzzed = true;
          try { channel.send(JSON.stringify({ type: 'buzzAccepted' })); } catch (_) { /* closed */ }
          if (onYdkjCommand) onYdkjCommand({ type: 'buzzer', key: assigned }, pc);
        } else {
          try { channel.send(JSON.stringify({ type: 'buzzRejected' })); } catch (_) { /* closed */ }
        }
      } else if (isHost && message.type === 'answer') {
        const answer = String(message.answer || '');
        if (!/^[1-4]$/.test(answer) || !pc._ydkjBuzzed) return;
        if (onYdkjCommand) onYdkjCommand({ type: 'answer', answer }, pc);
        for (const peer of hostPeers) {
          peer._ydkjBuzzed = false;
          const peerChannel = peer._ydkjControlChannel;
          if (peerChannel && peerChannel.readyState === 'open') {
            try { peerChannel.send(JSON.stringify({ type: 'roundReset' })); } catch (_) { /* closed */ }
          }
        }
      } else if (isHost && message.type === 'screw') {
        if (!pc._ydkjBuzzed) return;
        if (onYdkjCommand) onYdkjCommand({ type: 'screw' }, pc);
      } else if (!isHost && message.type === 'assign' && onYdkjAssignment) {
        onYdkjAssignment(message.key);
      } else if (!isHost && message.type === 'buzzAccepted') {
        guestBuzzAccepted = true;
        if (onYdkjBuzzerResult) onYdkjBuzzerResult(true);
      } else if (!isHost && message.type === 'buzzRejected') {
        if (onYdkjBuzzerResult) onYdkjBuzzerResult(false);
      } else if (!isHost && message.type === 'roundReset') {
        guestBuzzAccepted = false;
        if (onYdkjBuzzerResult) onYdkjBuzzerResult(false, true);
      }
    };
  }

  function assignYdkjPlayers() {
    const peers = [...hostPeers].filter((peer) => peer.connectionState !== 'closed');
    for (let index = 0; index < peers.length; index++) {
      const peer = peers[index];
      // With only one guest, the game's second-player buzzer is P. Once a
      // third total player joins, the positions become B (player 2) and P
      // (player 3), matching the three-player layout.
      const key = peers.length === 1 ? 'P' : (index === 0 ? 'B' : 'P');
      const changed = peer._ydkjPlayerKey !== key;
      peer._ydkjPlayerKey = key;
      if (changed) peer._ydkjAssignmentSent = false;
      const channel = peer._ydkjControlChannel;
      if (!peer._ydkjAssignmentSent && channel && channel.readyState === 'open') {
        try { channel.send(JSON.stringify({ type: 'assign', key })); } catch (_) { /* closed */ }
        peer._ydkjAssignmentSent = true;
        status(`YDKJ guest reassigned to buzzer ${key}`);
      }
    }
  }

  function addYdkjTrack(pc) {
    if (!ydkjStream) return;
    const tracks = ydkjStream.getTracks ? ydkjStream.getTracks() : [];
    for (const track of tracks) pc.addTrack(track, ydkjStream);
  }

  function receiveFrame(frame) {
    rxFrames++;
    if (rxFrames <= 3 || rxFrames % 50 === 0) status(`RX Ethernet frame #${rxFrames}`);
    if (onFrame) onFrame(frame);
    else if (pendingIncoming.length < 256) pendingIncoming.push(frame);
  }

  function waitForIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', done);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', done);
      setTimeout(() => { pc.removeEventListener('icegatheringstatechange', done); resolve(); }, 12000);
    });
  }

  // The copied value is intentionally opaque and compact.  It is an encoding,
  // not a cryptographic boundary: the peer still needs the ICE candidates.
  // Keep accepting the old pretty-printed SDP so existing invitations remain
  // usable after this format change.
  const SIGNAL_PREFIX = 'CC1.';
  function bytesToBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  function base64UrlToBytes(value) {
    const padded = String(value).replace(/-/g, '+').replace(/_/g, '/')
      + '==='.slice((String(value).length + 3) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  async function signalCode(value) {
    const source = new TextEncoder().encode(JSON.stringify(value));
    if (typeof CompressionStream === 'function') {
      try {
        const stream = new Blob([source]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return SIGNAL_PREFIX + bytesToBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
      } catch (_) { /* use the uncompressed compact fallback */ }
    }
    return SIGNAL_PREFIX + bytesToBase64Url(source);
  }
  async function signalValue(value) {
    const text = String(value).trim();
    if (!text.startsWith(SIGNAL_PREFIX)) return JSON.parse(text);
    const packed = base64UrlToBytes(text.slice(SIGNAL_PREFIX.length));
    let source = packed;
    if (typeof DecompressionStream === 'function') {
      try {
        const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        source = new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (_) { /* compact uncompressed fallback */ }
    }
    return JSON.parse(new TextDecoder().decode(source));
  }

  function shareLink(kind, code) {
    const url = new URL(window.location.href);
    url.hash = new URLSearchParams({ p2p: kind, code: String(code).trim() }).toString();
    return url.toString();
  }

  function sharedCode() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const kind = params.get('p2p');
    const code = params.get('code');
    return kind && code ? { kind, code } : null;
  }

  async function copyShareLink(kind, code, message) {
    if (!String(code || '').trim()) { status('Create a signaling code first'); return; }
    const link = shareLink(kind, code);
    try {
      await navigator.clipboard.writeText(link);
      status(message);
    } catch (e) {
      const local = document.getElementById('p2p-local');
      local.value = link;
      local.focus(); local.select();
      status('Link ready; press Ctrl+C');
    }
  }

  async function newHostOffer() {
    role = 'host';
    if (ydkjStream && [...hostPeers].filter((pc) => pc.connectionState !== 'closed').length >= 2) {
      throw new Error('YDKJ host mode supports two guest players (B and P)');
    }
    const pc = new RTCPeerConnection({ iceServers: STUN });
    const channel = pc.createDataChannel('ethernet', { ordered: true });
    const control = pc.createDataChannel('ydkj-control', { ordered: true });
    pc._ethernetChannel = channel;
    pc._ydkjControlChannel = control;
    wireChannel(channel);
    addYdkjTrack(pc);
    hostPeers.add(pc);
    wireControlChannel(control, pc, true);
    assignYdkjPlayers();
    pendingHostPc = pc;
    pendingHostPcs.push(pc);
    pc.onconnectionstatechange = () => status('Host peer: ' + pc.connectionState);
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') status('Host peer ICE failed; create a fresh offer');
    };
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc);
    status('Host offer ready; send it to the guest');
    return signalCode(pc.localDescription);
  }

  async function acceptHostAnswer(value) {
    const pc = pendingHostPcs.shift() || pendingHostPc;
    if (!pc) throw new Error('Create a host offer first');
    pendingHostPc = pc;
    await pc.setRemoteDescription(await signalValue(value));
    status('Host answer accepted; waiting for data channel');
  }

  async function acceptGuestOffer(value) {
    role = 'guest';
    guestBuzzAccepted = false;
    if (guestPc) guestPc.close();
    guestPc = new RTCPeerConnection({ iceServers: STUN });
    guestPc.onconnectionstatechange = () => status('Guest peer: ' + guestPc.connectionState);
    guestPc.ondatachannel = (event) => {
      if (event.channel.label === 'ydkj-control') {
        wireControlChannel(event.channel, guestPc, false);
        guestPc._ydkjControlChannel = event.channel;
        return;
      }
      if (event.channel.label !== 'ethernet') return;
      guestChannel = event.channel;
      guestChannel._frameQueue = pendingGuestOutgoing.splice(0, pendingGuestOutgoing.length);
      wireChannel(guestChannel);
    };
    guestPc.ontrack = (event) => {
      const stream = event.streams && event.streams[0];
      if (stream && window.ydkjP2P && window.ydkjP2P.receiveStream) {
        window.ydkjP2P.receiveStream(stream);
      }
    };
    await guestPc.setRemoteDescription(await signalValue(value));
    await guestPc.setLocalDescription(await guestPc.createAnswer());
    await waitForIce(guestPc);
    status('Guest answer ready; send it back to the host');
    return signalCode(guestPc.localDescription);
  }

  function sendFrame(frame) {
    const copy = frame.slice().buffer;
    if (role === 'guest') {
      if (guestChannel && guestChannel.readyState === 'open') guestChannel.send(copy);
      else if (guestChannel) {
        guestChannel._frameQueue = guestChannel._frameQueue || [];
        if (guestChannel._frameQueue.length < 256) guestChannel._frameQueue.push(copy);
      } else if (pendingGuestOutgoing.length < 256) {
        pendingGuestOutgoing.push(copy);
      }
      txFrames++;
      if (txFrames <= 3 || txFrames % 50 === 0) status(`TX Ethernet frame #${txFrames}`);
      return;
    }
    if (role === 'host') {
      for (const pc of hostPeers) {
        const channel = pc._ethernetChannel;
        if (!channel) continue;
        if (channel.readyState === 'open') channel.send(copy);
        else {
          channel._frameQueue = channel._frameQueue || [];
          if (channel._frameQueue.length < 256) channel._frameQueue.push(copy);
        }
      }
      txFrames++;
      if (txFrames <= 3 || txFrames % 50 === 0) status(`TX Ethernet frame #${txFrames}`);
    }
  }

  function setRole(next) {
    if (next !== 'host' && next !== 'guest' && next !== 'local') throw new Error('bad P2P role');
    role = next;
    status(next === 'local' ? 'Local-only network' : 'P2P ' + next + ' mode selected');
  }

  function setYdkjStream(stream) {
    ydkjStream = stream || null;
    status(ydkjStream ? 'YDKJ screen stream ready for new host offers' : 'YDKJ screen stream disabled');
  }

  function sendYdkjBuzzer(key) {
    const value = String(key || '').toUpperCase();
    if (!/^[QBP]$/.test(value)) throw new Error('YDKJ buzzer must be Q, B, or P');
    if (role !== 'guest' || !guestPc || !guestPc._ydkjControlChannel ||
        guestPc._ydkjControlChannel.readyState !== 'open') {
      status('YDKJ control channel is not connected');
      return false;
    }
    guestPc._ydkjControlChannel.send(JSON.stringify({ type: 'buzzer', key: value }));
    return true;
  }

  function sendYdkjAnswer(answer) {
    const value = String(answer || '');
    if (!/^[1-4]$/.test(value) || !guestBuzzAccepted) return false;
    if (role !== 'guest' || !guestPc || !guestPc._ydkjControlChannel ||
        guestPc._ydkjControlChannel.readyState !== 'open') return false;
    guestPc._ydkjControlChannel.send(JSON.stringify({ type: 'answer', answer: value }));
    guestBuzzAccepted = false;
    return true;
  }

  function sendYdkjScrew() {
    if (!guestBuzzAccepted || role !== 'guest' || !guestPc || !guestPc._ydkjControlChannel ||
        guestPc._ydkjControlChannel.readyState !== 'open') return false;
    guestPc._ydkjControlChannel.send(JSON.stringify({ type: 'screw' }));
    return true;
  }

  window.p2pBridge = {
    get role() { return role; },
    setStatusCallback(fn) { onStatus = fn || (() => {}); },
    setFrameCallback(fn) {
      onFrame = fn;
      if (onFrame) {
        while (pendingIncoming.length) onFrame(pendingIncoming.shift());
      }
    },
    setRole,
    setYdkjStream,
    sendYdkjBuzzer,
    sendYdkjAnswer,
    sendYdkjScrew,
    setYdkjCommandCallback(fn) { onYdkjCommand = fn || null; },
    setYdkjAssignmentCallback(fn) { onYdkjAssignment = fn || null; },
    setYdkjBuzzerResultCallback(fn) { onYdkjBuzzerResult = fn || null; },
    newHostOffer,
    acceptHostAnswer,
    acceptGuestOffer,
    sendFrame,
    connected() {
      if (role === 'guest') return !!guestChannel && guestChannel.readyState === 'open';
      return [...hostPeers].some((pc) => pc._ethernetChannel && pc._ethernetChannel.readyState === 'open');
    },
  };

  function bindUi() {
    const roleSelect = document.getElementById('p2p-role');
    const remote = document.getElementById('p2p-remote');
    const local = document.getElementById('p2p-local');
    const statusBox = document.getElementById('p2p-status');
    if (!roleSelect || !remote || !local || !statusBox) return;
    onStatus = (s) => { statusBox.textContent = s; console.log('[p2p] ' + s); };
    roleSelect.addEventListener('change', () => {
      try { setRole(roleSelect.value); } catch (e) { status(e.message); }
    });
    document.getElementById('p2p-offer').addEventListener('click', async () => {
      try { setRole('host'); roleSelect.value = 'host'; local.value = await newHostOffer(); }
      catch (e) { status('Offer failed: ' + e.message); }
    });
    document.getElementById('p2p-answer').addEventListener('click', async () => {
      try { setRole('guest'); roleSelect.value = 'guest'; local.value = await acceptGuestOffer(remote.value); }
      catch (e) { status('Answer failed: ' + e.message); }
    });
    document.getElementById('p2p-apply').addEventListener('click', async () => {
      try { setRole('host'); roleSelect.value = 'host'; await acceptHostAnswer(remote.value); }
      catch (e) { status('Apply failed: ' + e.message); }
    });
    document.getElementById('p2p-copy').addEventListener('click', async () => {
      const value = local.value.trim();
      if (!value) { status('Nothing to copy yet'); return; }
      try {
        await navigator.clipboard.writeText(value);
        status('Signaling code copied');
      } catch (e) {
        local.focus(); local.select();
        status('Clipboard permission denied; press Ctrl+C');
      }
    });
    document.getElementById('p2p-paste').addEventListener('click', async () => {
      try {
        remote.value = await navigator.clipboard.readText();
        status('Signaling code pasted');
      } catch (e) {
        remote.focus();
        status('Clipboard permission denied; press Ctrl+V');
      }
    });
    document.getElementById('p2p-share-host').addEventListener('click', async () => {
      await copyShareLink('guest', local.value, 'Guest invite link copied');
    });
    document.getElementById('p2p-share-answer').addEventListener('click', async () => {
      await copyShareLink('host', local.value, 'Host answer link copied');
    });

    const incoming = sharedCode();
    if (incoming) {
      remote.value = incoming.code;
      if (incoming.kind === 'guest') {
        setRole('guest'); roleSelect.value = 'guest';
        status('Host invite loaded; create a guest answer');
      } else if (incoming.kind === 'host') {
        setRole('host'); roleSelect.value = 'host';
        status('Guest answer loaded; apply the host answer');
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUi);
  else bindUi();

})();
