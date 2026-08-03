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
})();
