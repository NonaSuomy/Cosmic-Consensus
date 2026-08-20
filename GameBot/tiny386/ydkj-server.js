'use strict';

// Wrapped in an IIFE for the same reason cosmic-server.js is: Reload Server
// injects this file again, and removing the old <script> element does NOT
// undeclare its top-level bindings. A bare `const` therefore threw
// "Identifier 'X' has already been declared" on the second load and the reload
// silently did nothing. Everything below is function-scoped; only the
// window.* exports at the bottom outlive the call, and those are plain
// assignments that happily overwrite.
(function () {

// ── You Don't Know Jack: Net Show ────────────────────────────────────────────
//
// The odd one out: YDKJ Net Show has no IRC half at all. Everything it needs
// comes over HTTP out of static/jol, so there is no handshake to implement and
// no round engine to drive -- the game is entirely client-side once its files
// have been fetched.
//
// This file therefore exists for two reasons only:
//
//   1. So "YDKJ" is a selectable profile alongside Cosmic / GTP / Acrophobia,
//      and picking it does the honest thing -- REFUSES game-port connections
//      instead of silently handing them to Cosmic's engine, which would answer
//      a YDKJ client with Cosmic packets and produce a baffling failure.
//   2. So the served tree has one documented place describing what YDKJ needs.
//
// If a connection does arrive on the game port while this profile is selected,
// that is itself information worth seeing -- it means something in the client
// wants IRC after all -- so the socket is logged and closed rather than
// ignored.

const YDKJ_STATIC_ROOT = 'static/jol';
const YDKJ_DISPLAY_NAME = "You Don't Know Jack: Net Show";

let ydkjSeq = 0;

function ydkjLog(msg) { console.log(`[ydkj] ${msg}`); }

async function ydkjHandleGameConnection(conn) {
  const id = ++ydkjSeq;
  ydkjLog(`Connection #${id} arrived on the game port, but ${YDKJ_DISPLAY_NAME} is HTTP-only.`);
  ydkjLog('Closing it. If you are seeing this, the client wants IRC after all -- worth investigating.');
  try { await conn.close(); } catch (e) { /* already gone */ }
}

window.ydkjHandleGameConnection = ydkjHandleGameConnection;
window.ydkjProfile = {
  displayName: YDKJ_DISPLAY_NAME,
  staticRoot: YDKJ_STATIC_ROOT,
  httpOnly: true,
};

// Optional browser-to-browser spectator/player mode.  The actual YDKJ VM
// remains on the host; guests receive its canvas as a WebRTC video track and
// send only Q/B/P buzzer presses back over a small ordered data channel.
let ydkjHostCanvas = null;
let ydkjHostInstance = null;
let ydkjAssignedKey = '';

function ydkjP2PStatus(text) {
  const node = document.getElementById('ydkj-p2p-status');
  if (node) node.textContent = text;
  ydkjLog(text);
}

function ydkjSetGuestKey(key) {
  ydkjAssignedKey = String(key || '').toUpperCase();
  for (const button of document.querySelectorAll('[data-ydkj-buzzer]')) {
    button.disabled = button.dataset.ydkjBuzzer !== ydkjAssignedKey;
  }
  ydkjP2PStatus(ydkjAssignedKey ? `Assigned buzzer: ${ydkjAssignedKey}` : 'Waiting for a buzzer assignment');
}

function ydkjSetAnswerEnabled(enabled) {
  for (const button of document.querySelectorAll('[data-ydkj-answer]')) {
    button.disabled = !enabled;
  }
  for (const button of document.querySelectorAll('[data-ydkj-screw]')) {
    button.disabled = !enabled;
  }
  ydkjP2PStatus(enabled ? 'Buzz accepted; choose answer 1–4' : 'Waiting for your buzzer');
}

function ydkjReceiveStream(stream) {
  const video = document.getElementById('ydkj-remote-video');
  if (!video) return;
  video.srcObject = stream;
  video.hidden = false;
  video.play().catch(() => { /* muted autoplay may still need a click */ });
  ydkjP2PStatus('Receiving the host YDKJ screen');
}

function ydkjStartHostStream() {
  // Prefer the currently focused emulator.  This also covers the common case
  // where the user boots the Net Show executable from a general Win95 image
  // rather than selecting the dedicated Net Show profile first.
  if (!ydkjHostCanvas) {
    const active = window.__tiny386ActiveClient;
    const candidates = [active, ...(window.__tiny386Clients || []).slice().reverse()]
      .filter((item, index, all) => item && all.indexOf(item) === index);
    const candidate = candidates.find((item) => item && item.canvas && item.inst);
    if (candidate) {
      ydkjHostCanvas = candidate.canvas;
      ydkjHostInstance = candidate.inst;
    }
  }
  if (!ydkjHostCanvas || typeof ydkjHostCanvas.captureStream !== 'function') {
    ydkjP2PStatus('Start a YDKJ emulator first; this browser cannot capture its canvas');
    return false;
  }
  const videoStream = ydkjHostCanvas.captureStream(15);
  // The emulator's audio is rendered through its own WebAudio graph, so a
  // canvas capture alone cannot carry it.  Feed that graph into a media
  // destination and combine its track with the canvas track.
  if (ydkjHostInstance && typeof ydkjHostInstance.resume_audio === 'function') {
    ydkjHostInstance.resume_audio().catch(() => { /* browser may already be running */ });
  }
  const audioStream = ydkjHostInstance && typeof ydkjHostInstance.get_audio_stream === 'function'
    ? ydkjHostInstance.get_audio_stream() : null;
  const tracks = videoStream.getTracks();
  if (audioStream && audioStream.getAudioTracks) tracks.push(...audioStream.getAudioTracks());
  const stream = typeof MediaStream === 'function' ? new MediaStream(tracks) : videoStream;
  if (!window.p2pBridge || typeof window.p2pBridge.setYdkjStream !== 'function') {
    ydkjP2PStatus('P2P bridge is not loaded');
    return false;
  }
  window.p2pBridge.setYdkjStream(stream);
  ydkjP2PStatus(audioStream && audioStream.getAudioTracks().length
    ? 'Screen and audio ready; create a new host offer for each guest'
    : 'Screen ready; audio capture is unavailable in this browser');
  return true;
}

window.ydkjP2P = {
  setHostInstance(canvas, instance) {
    ydkjHostCanvas = canvas || null;
    ydkjHostInstance = instance || null;
  },
  startHostStream: ydkjStartHostStream,
  receiveStream: ydkjReceiveStream,
  assignedKey() { return ydkjAssignedKey; },
};

if (window.p2pBridge) {
  window.p2pBridge.setYdkjCommandCallback((message, peer) => {
    if (ydkjHostInstance && typeof ydkjHostInstance.send_text === 'function') {
      if (message.type === 'buzzer') {
        ydkjHostInstance.send_text(String(message.key).toLowerCase());
        ydkjP2PStatus(`Guest buzzer ${message.key} sent to the emulator`);
      } else if (message.type === 'answer') {
        ydkjHostInstance.send_text(String(message.answer));
        ydkjP2PStatus(`Guest answer ${message.answer} sent to the emulator`);
      } else if (message.type === 'screw') {
        ydkjHostInstance.send_text('s');
        ydkjP2PStatus('Guest screw action sent to the emulator');
      }
    }
  });
  window.p2pBridge.setYdkjAssignmentCallback(ydkjSetGuestKey);
  window.p2pBridge.setYdkjBuzzerResultCallback((accepted, reset) => {
    ydkjSetAnswerEnabled(!!accepted && !reset);
  });
}

function bindYdkjP2PUI() {
  const start = document.getElementById('ydkj-p2p-start');
  if (start) start.addEventListener('click', ydkjStartHostStream);
  for (const button of document.querySelectorAll('[data-ydkj-buzzer]')) {
    button.addEventListener('click', () => {
      if (window.p2pBridge && window.p2pBridge.sendYdkjBuzzer(button.dataset.ydkjBuzzer)) {
        ydkjP2PStatus(`Buzzer ${button.dataset.ydkjBuzzer} sent`);
      }
    });
  }
  for (const button of document.querySelectorAll('[data-ydkj-answer]')) {
    button.addEventListener('click', () => {
      if (window.p2pBridge && window.p2pBridge.sendYdkjAnswer(button.dataset.ydkjAnswer)) {
        ydkjSetAnswerEnabled(false);
      }
    });
  }
  for (const button of document.querySelectorAll('[data-ydkj-screw]')) {
    button.addEventListener('click', () => {
      if (window.p2pBridge && window.p2pBridge.sendYdkjScrew()) {
        ydkjP2PStatus('Screw action sent');
      }
    });
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindYdkjP2PUI);
else bindYdkjP2PUI();
})();
