'use strict';

// ── client-window UI ─────────────────────────────────────────────────────────
//
// Split out of index.html so it can be hot-reloaded like the game servers: the
// markup and the button wiring are the parts that change while iterating, and
// re-running them must NOT cost a Win95 boot.
//
// The page keeps ownership of client state (the clients array, activeClient,
// spawn/close/stop). This file owns only what a window LOOKS like and what its
// buttons do, and receives everything else through `api`:
//
//     api.stopClient(c)         shut the VM down
//     api.fullscreenClient(c)   go fullscreen
//     api.conlog(text)          write to the log panel
//
// uiRebuildClient() is what makes the reload safe: it regenerates the markup
// and then MOVES the live <canvas> back into it. Moving a node re-parents it
// rather than recreating it, so the 2D context the emulator draws through
// stays valid and the VM never notices the surgery.

(function () {

function uiClientMarkup(id) {
    return '<div class="title-bar">' +
  '<div class="title-bar-text">Client ' + id + '</div>' +
  '<div class="title-bar-controls">' +
    '<button aria-label="Minimize" title="Dock this window back into the page"></button>' +
    '<button aria-label="Maximize" title="Fullscreen this client\'s screen. Press Esc to exit."></button>' +
    '<button aria-label="Close" title="Stop this client and remove its window"></button>' +
  '</div>' +
'</div>' +
'<div class="window-body">' +
  '<center><canvas width="720" height="480" style="background-color:#000000;"></canvas></center>' +
  '<div class="controls-row">' +
    '<select title="Which game disc this PC boots into. Pick before pressing Start.">' +
      '<option value="win95all.ini">beZerk Revived</option>' +
      '<option value="win95cc.ini">Cosmic Consensus</option>' +
      '<option value="win95a.ini">Acrophobia</option>' +
      '<option value="win95gtp.ini">Get The Picture</option>' +
      '<option value="win95ns.ini">Net Show</option>' +
    '</select>' +
    '<button data-act="start" title="Boot this PC with the selected game.">Start</button>' +
    '<button data-act="stop" title="Shut this PC down. Any game in progress is lost.">Stop</button>' +
        '<button data-act="save" title="Snapshot this PC: CPU, RAM, devices and disks. Held in memory only -- it does not survive closing the tab.">Save State</button>' +
        '<button data-act="load" title="Put the last snapshot back. The VM keeps running throughout; it simply finds itself where it was.">Load State</button>' +
        '<button data-act="savefile" title="Write the snapshot to a file you can keep. Roughly 220 MB -- guest RAM plus both disk images -- so it takes a moment. Survives closing the browser.">Save to File</button>' +
        '<button data-act="loadfile" title="Load a snapshot file saved earlier. The VM must be started first; the file replaces its state.">Load from File</button>' +
        '<input type="file" data-act="loadfileinput" accept=".t386,.bin" style="display:none;">' +
    '<button data-act="grab" title="Lock the mouse to this screen, so movement is delivered to the guest instead of moving the host cursor. Ctrl+Alt+G toggles it from the keyboard; Esc releases it. Not available on iOS.">Grab</button>' +
    '<button data-act="full" title="Expand this screen to fill the display. Press Esc to exit.">Fullscreen</button>' +
    '<button data-act="cad" title="Send Ctrl+Alt+Del to this PC.">Ctrl+Alt+Del</button>' +
    '<button data-act="altf4" title="Send Alt+F4 to this PC, closing whatever window has focus in the guest. Sent to the emulated keyboard, so the guest decides what it means -- it will not stop a truly hung app, and on the desktop it asks Windows to shut down.">Alt+F4</button>' +
    '<input type="text" data-act="typebox" placeholder="type here -> Enter sends" spellcheck="false" ' +
      'autocomplete="off" autocapitalize="off" autocorrect="off" ' +
      'style="font-family: monospace; width: 150px;" ' +
      'title="Type with your device keyboard and press Enter to send it to this PC, followed by Return. Use this when the on-screen keyboard is awkward -- on a phone, tapping here raises the native keyboard.">' +
    '<button data-act="typesend" title="Send the text in the box to this PC (same as pressing Enter), without a trailing Return.">Send</button>' +
    '<button data-act="paste" title="Read the system clipboard and paste its text into this PC.">Paste</button>' +
    '<button data-act="bksp" title="Send one Backspace to this PC. The type box cannot delete text already sent, so use this to correct the guest.">Backspace</button>' +
    '<button data-act="lmb" title="Send a left-click to this PC, wherever the guest pointer currently is. Useful on touch devices, where there is no real mouse button.">Left-Click</button>' +
    '<button data-act="dblclk" title="Send a left double-click to this PC, wherever the guest pointer currently is. The two clicks go out back to back, well inside the guest\'s double-click interval.">Double-Click</button>' +
    '<button data-act="rmb" title="Send a right-click to this PC.">Right-Click</button>' +
  '</div>' +
  // Its own block under the buttons rather than wedged
  // between two of them, so it reads as a caption for the
  // whole row and stops shoving the buttons around when the
  // window is narrow.
  '<div class="shortcut-hint" style="opacity:0.7; margin-top:4px; font-size:0.9em;">' +
    'Ctrl+Alt+ G lock/release mouse &middot; L left-click &middot; ' +
    'R right-click &middot; D double-click &middot; Esc release &middot; ' +
    'drag to move the pointer &middot; double-tap-drag to click-drag &middot; ' +
    'Tab cycles the buttons' +
  '</div>' +
  // Boot status is deliberately last, so it reads as the client window's
  // status bar instead of interrupting the screen and controls. It remains
  // hidden once the VM reaches the running phase.
  '<div data-act="statusbar" class="status-bar" style="display:none; margin-top:6px;">' +
    '<div class="status-bar-field" data-act="statustext" style="flex-grow:2;">Idle</div>' +
    '<div class="status-bar-field" data-act="statuspct" style="flex-grow:0; min-width:52px; text-align:right;"></div>' +
  '</div>' +
  '<div data-act="statusprog" class="progress-indicator segmented" style="display:none; height:18px; margin-top:2px;">' +
    '<span class="progress-indicator-bar" style="width:0%;"></span>' +
  '</div>' +
'</div>';
}

/**
 * Render one boot-status update into a client window.
 *
 * `st` comes from main.js's dostatus(): { phase, text, loaded, total }.
 *
 *   phase 'run'    the guest is up -- hide the bar, the screen speaks for itself
 *   phase 'error'  leave it up and visible; this is the case the log used to
 *                  swallow entirely
 *   total > 0      determinate bar with a percentage
 *   no total       indeterminate (the segmented 98.css bar, animated by CSS),
 *                  which is what zstd extraction honestly is
 *
 * Safe to call before the window has a status bar: a page still running the
 * pre-status ui.js simply has no elements to find, and this returns quietly
 * rather than throwing into the boot chain.
 */
function uiSetStatus(c, st) {
    if (!c || !c.win || !st) return;
    const bar = c.win.querySelector('[data-act="statusbar"]');
    const prog = c.win.querySelector('[data-act="statusprog"]');
    if (!bar || !prog) return;
    const text = bar.querySelector('[data-act="statustext"]');
    const pct = bar.querySelector('[data-act="statuspct"]');
    const fill = prog.querySelector('.progress-indicator-bar');

    if (st.phase === 'run') {
        bar.style.display = 'none';
        prog.style.display = 'none';
        return;
    }

    bar.style.display = '';
    text.textContent = st.text || '';

    const total = Number(st.total) || 0;
    const loaded = Number(st.loaded) || 0;
    if (total > 0) {
        const p = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
        prog.style.display = '';
        prog.classList.remove('segmented');
        fill.style.width = p + '%';
        pct.textContent = p + '%';
    } else if (st.phase === 'error') {
        // No bar at all on an error -- a stalled progress bar reads as "still
        // working", which is the opposite of what happened.
        prog.style.display = 'none';
        pct.textContent = '';
    } else {
        // Indeterminate: the segmented bar filled to 100% is 98.css's barber
        // pole, and says "working, duration unknown".
        prog.style.display = '';
        prog.classList.add('segmented');
        fill.style.width = '100%';
        pct.textContent = '';
    }
}

function uiWireControls(c, win, api) {
    win.querySelector('[data-act="start"]').addEventListener('click', c.start);

    win.querySelector('[data-act="stop"]').addEventListener('click', () => api.stopClient(c));
    // One snapshot per client, held in memory. Deliberately not persisted:
    // see the note on save_state in main.js -- surviving a page reload needs
    // the handles reconstructed too, which is a separate job.
    win.querySelector('[data-act="save"]').addEventListener('click', () => {
        if (!c.inst) { api.conlog('[ui] Start this PC first.'); return; }
        if (typeof c.inst.save_state !== 'function') {
            api.conlog('[ui] This page has a stale main.js (no save_state). Hard-refresh.');
            return;
        }
        const snap = c.inst.save_state();
        if (snap) { c.snapshot = snap; api.conlog('[ui] client ' + c.id + ': state saved'); }
    });
    win.querySelector('[data-act="load"]').addEventListener('click', () => {
        if (!c.inst) { api.conlog('[ui] Start this PC first.'); return; }
        if (!c.snapshot) { api.conlog('[ui] client ' + c.id + ': no snapshot saved yet'); return; }
        if (c.inst.load_state(c.snapshot)) api.conlog('[ui] client ' + c.id + ': state restored');
    });
    // To a file, so a snapshot survives closing the browser. Save State keeps
    // one in memory for quick undo; this is the durable version.
    win.querySelector('[data-act="savefile"]').addEventListener('click', () => {
        if (!c.inst) { api.conlog('[ui] Start this PC first.'); return; }
        if (typeof c.inst.export_state !== 'function') {
            api.conlog('[ui] This page has a stale main.js (no export_state). Hard-refresh.');
            return;
        }
        const snap = c.inst.save_state();
        if (!snap) return;
        const blob = c.inst.export_state(snap);
        if (!blob) { api.conlog('[ui] could not serialise the snapshot'); return; }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'tiny386-client' + c.id + '-' + stamp + '.t386';
        a.click();
        // Revoking immediately can cancel the download in some browsers; give
        // it a moment, then release the blob so 220 MB is not pinned forever.
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        api.conlog('[ui] client ' + c.id + ': writing ' + (blob.size / 1048576).toFixed(0) + ' MB to ' + a.download);
    });

    const fileInput = win.querySelector('[data-act="loadfileinput"]');
    win.querySelector('[data-act="loadfile"]').addEventListener('click', () => {
        if (!c.inst) { api.conlog('[ui] Start this PC first, then load into it.'); return; }
        fileInput.value = '';   // so picking the same file twice still fires
        fileInput.click();
    });
    fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        api.conlog('[ui] reading ' + f.name + ' (' + (f.size / 1048576).toFixed(0) + ' MB) ...');
        try {
            const snap = c.inst.import_state(await f.arrayBuffer());
            if (snap && c.inst.load_state(snap)) {
                c.snapshot = snap;
                api.conlog('[ui] client ' + c.id + ': state loaded from ' + f.name);
            }
        } catch (e) {
            api.conlog('[ui] could not read ' + f.name + ': ' + (e && e.message ? e.message : e));
        }
    });

    win.querySelector('[data-act="grab"]').addEventListener('click', () => {
        c.canvas.tabIndex = 0; c.canvas.focus();   // 0 keeps natural tab order
        // No pointer lock on iOS -- say so rather than throwing.
        if (c.canvas.requestPointerLock) c.canvas.requestPointerLock();
        else api.conlog('[ui] Grab needs pointer lock, which this browser does not support.');
    });
    win.querySelector('[data-act="full"]').addEventListener('click', () => api.fullscreenClient(c));
    win.querySelector('[data-act="cad"]').addEventListener('click', () => {
        if (!c.inst) return;
        c.inst.send_kbd(1, 0x1d); c.inst.send_kbd(1, 0x38); c.inst.send_kbd(1, 0x53);
        c.inst.send_kbd(0, 0x53); c.inst.send_kbd(0, 0x38); c.inst.send_kbd(0, 0x1d);
    });
    // Alt+F4. Scancodes are the emulator's own (main.js: AltLeft
    // 0x38, F4 0x3e), pressed and released in nesting order the
    // way the Ctrl+Alt+Del handler above does it -- releasing Alt
    // before F4 would look like Alt was let go mid-chord and the
    // guest would drop the combination.
    win.querySelector('[data-act="altf4"]').addEventListener('click', () => {
        if (!c.inst) return;
        c.inst.send_kbd(1, 0x38); c.inst.send_kbd(1, 0x3e);
        c.inst.send_kbd(0, 0x3e); c.inst.send_kbd(0, 0x38);
    });
    // Type-through box. The guest gets scancodes via inst.send_text
    // (main.js), which owns the character -> key mapping because the
    // scancode table lives in its closure.
    //
    // Enter sends the line AND a Return, which is what you want when
    // answering a prompt; the Send button omits the Return so a
    // field can be filled without submitting it.
    {
        const box = win.querySelector('[data-act="typebox"]');
        const push = (withReturn) => {
            if (!c.inst) { api.conlog('[ui] Start this PC before sending text.'); return; }
            // A new index.html against a cached old main.js: GitHub
            // Pages caches .js, so the two can arrive out of step.
            // Without this it surfaced as a bare
            // "c.inst.send_text is not a function".
            if (typeof c.inst.send_text !== 'function') {
                api.conlog('[ui] This page has a stale main.js (no send_text). '
                     + 'Hard-refresh to pick up the current one: '
                     + 'desktop Ctrl+Shift+R, iOS hold Reload -> Request Desktop Site, or clear site data.');
                return;
            }
            const text = box.value;
            if (!text && !withReturn) return;
            c.inst.send_text(withReturn ? text + '\n' : text);
            box.value = '';
        };
        box.addEventListener('keydown', (e) => {
            // Keep the box's own typing away from the canvas key
            // handler, or every character is delivered twice.
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); push(true); }
        });
        box.addEventListener('keyup', (e) => e.stopPropagation());
        win.querySelector('[data-act="typesend"]').addEventListener('click', () => push(false));

        const paste = async () => {
            if (!c.inst) { api.conlog('[ui] Start this PC before pasting text.'); return; }
            if (typeof c.inst.send_text !== 'function') {
                api.conlog('[ui] This page has a stale main.js (no send_text); refresh the page.');
                return;
            }
            try {
                const text = await navigator.clipboard.readText();
                if (text) c.inst.send_text(text);
            } catch (err) {
                api.conlog('[ui] Clipboard paste was blocked. Click the page first or use the type box.');
            }
        };
        win.querySelector('[data-act="paste"]').addEventListener('click', paste);
    }

    // Press-then-release at the pointer's current position -- the
    // deltas are 0, so this clicks wherever the guest cursor
    // already is rather than moving it. Button bits are the DOM
    // MouseEvent.buttons values the emulator is fed elsewhere
    // (main.js:946): 1 = left, 2 = right.
    win.querySelector('[data-act="lmb"]').addEventListener('click', () => {
        if (!c.inst) return;
        c.inst.send_mouse(0, 0, 0, 1);
        c.inst.send_mouse(0, 0, 0, 0);
    });
    // Backspace. Scancode 0x0e, from the emulator's own codemap
    // (main.js). Sent as a discrete press/release rather than held,
    // so it deletes exactly one character with no key repeat.
    win.querySelector('[data-act="bksp"]').addEventListener('click', () => {
        if (!c.inst) return;
        c.inst.send_kbd(1, 0x0e);
        c.inst.send_kbd(0, 0x0e);
    });

    // Two press/release pairs with nothing between them. The guest
    // decides what counts as a double-click by the gap between
    // presses, and back-to-back is comfortably inside any setting.
    win.querySelector('[data-act="dblclk"]').addEventListener('click', () => {
        if (!c.inst) return;
        c.inst.send_mouse(0, 0, 0, 1); c.inst.send_mouse(0, 0, 0, 0);
        c.inst.send_mouse(0, 0, 0, 1); c.inst.send_mouse(0, 0, 0, 0);
    });
    win.querySelector('[data-act="rmb"]').addEventListener('click', () => {
        if (!c.inst) return;
        c.inst.send_mouse(0, 0, 0, 2);
        c.inst.send_mouse(0, 0, 0, 0);
    });
}

/**
 * Rebuild one client's window from the current markup, keeping its VM.
 *
 * Order matters: take the live canvas out BEFORE replacing innerHTML, or it is
 * destroyed along with everything else and the emulator ends up drawing into a
 * detached element -- a black window with a VM still running behind it.
 */
function uiRebuildClient(c, api, wireChrome) {
    if (!c || !c.win) return false;
    const live = c.canvas;
    if (live && live.parentNode) live.parentNode.removeChild(live);

    c.win.innerHTML = uiClientMarkup(c.id);

    if (live) {
        const fresh = c.win.querySelector('canvas');
        if (fresh && fresh.parentNode) fresh.parentNode.replaceChild(live, fresh);
        c.canvas = live;
    } else {
        c.canvas = c.win.querySelector('canvas');
    }

    uiWireControls(c, c.win, api);
    if (typeof wireChrome === 'function') wireChrome(c, c.win);
    return true;
}

window.uiClientMarkup = uiClientMarkup;
window.uiWireControls = uiWireControls;
window.uiRebuildClient = uiRebuildClient;
window.uiSetStatus = uiSetStatus;

})();
