const $ = (id) => document.getElementById(id);

const els = {
  factBackend: $('factBackend'), factKvm: $('factKvm'), factSessions: $('factSessions'),
  hostState: $('hostState'), hostStateLabel: $('hostStateLabel'),
  selImage: $('selImage'), selProfile: $('selProfile'), selBackend: $('selBackend'),
  backendHint: $('backendHint'), btnStart: $('btnStart'), startNotice: $('startNotice'),
  sessionList: $('sessionList'), sessionEmpty: $('sessionEmpty'), sessionCount: $('sessionCount'),
  stageIdle: $('stageIdle'), stageFault: $('stageFault'), faultTitle: $('faultTitle'), faultBody: $('faultBody'),
  viewport: $('viewport'), screen: $('screen'), signal: $('signal'),
  mResolution: $('mResolution'), mFps: $('mFps'), mBitrate: $('mBitrate'), mRtt: $('mRtt'), mDropped: $('mDropped'),
  btnRotate: $('btnRotate'), btnNotifications: $('btnNotifications'), btnStop: $('btnStop'),
  adminToken: $('adminToken'),
  btnTheme: $('btnTheme'), themeIcon: $('themeIcon'),
};

// ---------------------------------------------------------------- theme
//
// index.html's inline head script already applied any *stored* preference
// before first paint (avoids a flash). Until the toggle is actually
// clicked, nothing here writes an explicit choice -- that way a visitor
// who never touches it keeps following the OS theme live, rather than
// today's system preference getting silently pinned forever on first load.
const darkMedia = matchMedia('(prefers-color-scheme: dark)');
function currentTheme() {
  return document.documentElement.dataset.theme ?? (darkMedia.matches ? 'dark' : 'light');
}
function updateThemeIcon() {
  els.themeIcon.textContent = currentTheme() === 'dark' ? '☀' : '☾';
}
updateThemeIcon();
darkMedia.addEventListener('change', () => {
  if (!document.documentElement.dataset.theme) updateThemeIcon(); // no explicit override -> still following the OS
});
els.btnTheme.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('droidstream:theme', next);
  updateThemeIcon();
});

// ---------------------------------------------------------------- admin mode
//
// Normally a session's token is only ever seen by the browser tab that
// created it (see attachTo()) -- that's the app's whole access-control
// model. If the control plane was started with ADMIN_TOKEN set, presenting
// it back via this header makes /api/sessions* include every session's
// real token too, so this browser can see and attach to sessions it
// didn't start itself. Off unless both sides opt in.
function adminHeaders() {
  const t = localStorage.getItem('droidstream:adminToken');
  return t ? { 'x-admin-token': t } : {};
}
els.adminToken.value = localStorage.getItem('droidstream:adminToken') ?? '';
els.adminToken.addEventListener('change', () => {
  const v = els.adminToken.value.trim();
  if (v) localStorage.setItem('droidstream:adminToken', v);
  else localStorage.removeItem('droidstream:adminToken');
  refreshSessions();
});

const FRAME_VIDEO = 0x01;
const FLAG_CONFIG = 0x01;
const FLAG_KEYFRAME = 0x02;

let capabilities = null;
let active = null; // { id, token, socket, decoder, ... }

// --------------------------------------------------------------- host status

function setHostState(state, label) {
  els.hostState.dataset.state = state;
  els.hostStateLabel.textContent = label;
}

async function loadCapabilities() {
  capabilities = await (await fetch('/api/capabilities')).json();

  els.selImage.innerHTML = capabilities.images
    .map((k) => `<option value="${k}">${k.replace('android-', 'Android ')}</option>`).join('');
  els.selImage.value = 'android-13';

  els.selProfile.innerHTML = Object.entries(capabilities.profiles)
    .map(([k, v]) => `<option value="${k}">${k} — ${v.width}×${v.height} @ ${v.dpi}dpi</option>`).join('');
  els.selProfile.value = 'phone-hd';

  els.selBackend.innerHTML = capabilities.backends
    .map((b) => `<option value="${b.id}"${b.available ? '' : ' disabled'}>${b.label}${b.available ? '' : ' — unavailable here'}</option>`)
    .join('');
  els.selBackend.value = capabilities.defaultBackend;
  updateBackendHint();
}

function updateBackendHint() {
  const chosen = capabilities?.backends.find((b) => b.id === els.selBackend.value);
  els.backendHint.textContent = chosen?.note ?? '';
}

async function pollHealth() {
  try {
    const h = await (await fetch('/api/health')).json();
    els.factBackend.textContent = h.backend;
    els.factKvm.textContent = h.kvm ? 'available' : 'not needed';
    els.factSessions.textContent = `${h.sessions} / ${h.maxSessions}`;
    setHostState('ok', 'ready');
  } catch {
    setHostState('fault', 'unreachable');
  }
}

// -------------------------------------------------------------- session list

async function refreshSessions() {
  let sessions = [];
  try {
    ({ sessions } = await (await fetch('/api/sessions', { headers: adminHeaders() })).json());
  } catch {
    return;
  }

  // Admin mode: the server only includes `token` when x-admin-token matched.
  // Adopt it the same way startSession() does, so attachTo() (which only
  // ever looks in sessionStorage) works unmodified for sessions this
  // browser tab didn't create itself.
  for (const s of sessions) {
    if (s.token) sessionStorage.setItem(`token:${s.id}`, s.token);
  }

  els.sessionCount.textContent = String(sessions.length);
  els.sessionEmpty.hidden = sessions.length > 0;

  els.sessionList.replaceChildren(...sessions.map((s) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-current', String(active?.id === s.id));
    btn.innerHTML =
      `<span class="sid">${s.id}</span>` +
      `<span class="st" data-state="${s.state}">${s.state}</span>`;
    btn.title = s.error ?? `${s.backend} · ${s.image} · ${s.ageSeconds}s old`;
    btn.onclick = () => {
      if (s.state === 'ready') attachTo(s.id);
      else if (s.error) showFault('Session failed', s.error);
    };
    li.append(btn);
    return li;
  }));

  // A session we are watching that has gone away should not leave a dead canvas.
  if (active && !sessions.some((s) => s.id === active.id)) {
    showFault('Session ended', 'The device was stopped or reaped for being idle.');
    teardown();
  }
}

// --------------------------------------------------------------- start a device

async function startSession() {
  els.btnStart.disabled = true;
  showNotice('Starting. A container reaches the launcher in about 40 seconds.', 'info');
  setHostState('busy', 'booting');

  let created;
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: els.selImage.value,
        profile: els.selProfile.value,
        backend: els.selBackend.value,
      }),
    });
    created = await res.json();
    if (!res.ok) throw new Error(created.error ?? `request failed with ${res.status}`);
  } catch (err) {
    showNotice(err.message, 'error');
    els.btnStart.disabled = false;
    setHostState('fault', 'start failed');
    return;
  }

  sessionStorage.setItem(`token:${created.id}`, created.token);
  await refreshSessions();

  // Poll until the device finishes booting, then attach.
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`/api/sessions/${created.id}`);
    if (res.status === 404) {
      showNotice('The session disappeared while booting. Check the control-plane logs.', 'error');
      break;
    }
    const s = await res.json();
    if (s.state === 'ready') {
      hideNotice();
      await attachTo(created.id);
      break;
    }
    if (s.state === 'failed') {
      showNotice(s.error ?? 'The device failed to boot.', 'error');
      break;
    }
  }

  els.btnStart.disabled = false;
  setHostState('ok', 'ready');
  refreshSessions();
}

function showNotice(text, kind) {
  els.startNotice.textContent = text;
  els.startNotice.dataset.kind = kind;
  els.startNotice.hidden = false;
}
function hideNotice() { els.startNotice.hidden = true; }

// ------------------------------------------------------------------ streaming

async function attachTo(id) {
  const token = sessionStorage.getItem(`token:${id}`);
  if (!token) {
    showFault('No access token', 'This browser did not start that session, so it cannot attach to it.');
    return;
  }

  teardown();

  if (!('VideoDecoder' in window)) {
    showFault('This browser cannot decode the stream',
      'DroidStream needs WebCodecs. Use Chrome or Edge 94+, or Safari 16.4+.');
    return;
  }

  els.stageIdle.hidden = true;
  els.stageFault.hidden = true;
  els.viewport.hidden = false;

  const ctx = els.screen.getContext('2d', { alpha: false, desynchronized: true });

  const state = {
    id,
    token,
    ctx,
    socket: null,
    decoder: null,
    configBytes: null,
    started: false,
    pendingRtt: new Map(),
    counters: { frames: 0, bytes: 0, dropped: 0 },
    history: [],
    rtt: null,
  };
  active = state;

  state.decoder = new VideoDecoder({
    output: (frame) => {
      if (els.screen.width !== frame.displayWidth) {
        els.screen.width = frame.displayWidth;
        els.screen.height = frame.displayHeight;
        els.mResolution.textContent = `${frame.displayWidth}×${frame.displayHeight}`;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();
      state.counters.frames += 1;
    },
    error: (err) => {
      // Recover rather than die: drop the decoder and rebuild on the next
      // config packet the server sends.
      console.warn('decoder error', err);
      state.counters.dropped += 1;
      state.started = false;
      try { state.decoder.close(); } catch { /* already closed */ }
      state.decoder = null;
    },
  });

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${proto}//${location.host}/stream?token=${encodeURIComponent(token)}`);
  socket.binaryType = 'arraybuffer';
  state.socket = socket;

  socket.onmessage = (ev) => {
    if (typeof ev.data === 'string') return onJson(state, JSON.parse(ev.data));
    onBinary(state, new Uint8Array(ev.data));
  };
  socket.onclose = () => {
    if (active === state) showFault('Stream closed', 'The connection to the device dropped.');
  };
  socket.onerror = () => {
    if (active === state) showFault('Could not open the stream', 'The WebSocket refused to connect.');
  };

  bindInput(state);
  startMeters(state);
  refreshSessions();
}

function onJson(state, msg) {
  if (msg.t === 'meta') {
    els.mResolution.textContent = `${msg.width}×${msg.height}`;
  } else if (msg.t === 'pong') {
    const sentAt = state.pendingRtt.get(msg.id);
    if (sentAt !== undefined) {
      state.rtt = performance.now() - sentAt;
      state.pendingRtt.delete(msg.id);
    }
  } else if (msg.t === 'ended') {
    showFault('Device stream ended', msg.reason ?? '');
  }
}

function onBinary(state, bytes) {
  if (bytes[0] !== FRAME_VIDEO) return;

  const flags = bytes[1];
  const view = new DataView(bytes.buffer, bytes.byteOffset + 2, 8);
  const pts = Number(view.getBigUint64(0));
  const payload = bytes.subarray(10);

  state.counters.bytes += payload.length;

  if (flags & FLAG_CONFIG) {
    // SPS/PPS. Hold them; WebCodecs wants parameter sets immediately ahead of
    // the IDR they describe when the bitstream is Annex-B.
    state.configBytes = payload.slice();
    configureDecoder(state, payload);
    return;
  }

  if (!state.decoder || state.decoder.state !== 'configured') return;

  const isKey = (flags & FLAG_KEYFRAME) !== 0;
  if (!state.started) {
    if (!isKey) return; // nothing decodable yet
    state.started = true;
  }

  let data = payload;
  if (isKey && state.configBytes) {
    data = new Uint8Array(state.configBytes.length + payload.length);
    data.set(state.configBytes, 0);
    data.set(payload, state.configBytes.length);
  }

  try {
    state.decoder.decode(new EncodedVideoChunk({
      type: isKey ? 'key' : 'delta',
      timestamp: pts,
      data,
    }));
  } catch (err) {
    state.counters.dropped += 1;
    console.warn('decode failed', err);
  }
}

function configureDecoder(state, configBytes) {
  const codec = codecStringFromSps(configBytes) ?? 'avc1.42E01E';

  if (!state.decoder || state.decoder.state === 'closed') {
    state.decoder = new VideoDecoder({
      output: (frame) => {
        if (els.screen.width !== frame.displayWidth) {
          els.screen.width = frame.displayWidth;
          els.screen.height = frame.displayHeight;
        }
        state.ctx.drawImage(frame, 0, 0);
        frame.close();
        state.counters.frames += 1;
      },
      error: (err) => console.warn('decoder error', err),
    });
  }

  try {
    // No `description` means the decoder treats the bitstream as Annex-B,
    // which is exactly what scrcpy emits.
    state.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
    state.started = false;
  } catch (err) {
    showFault('Cannot configure the video decoder', `${codec}: ${err.message}`);
  }
}

/**
 * Builds the codec string from the sequence parameter set so the decoder is
 * configured for the profile the device actually chose, rather than a guess
 * that fails the moment MediaCodec picks High instead of Baseline.
 */
function codecStringFromSps(bytes) {
  for (let i = 0; i + 4 < bytes.length; i++) {
    const isStart3 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1;
    const isStart4 = bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1;
    if (!isStart3 && !isStart4) continue;

    const nal = i + (isStart4 ? 4 : 3);
    if ((bytes[nal] & 0x1f) !== 7) continue; // not the SPS
    if (nal + 3 >= bytes.length) return null;

    const hex = (n) => n.toString(16).padStart(2, '0');
    return `avc1.${hex(bytes[nal + 1])}${hex(bytes[nal + 2])}${hex(bytes[nal + 3])}`;
  }
  return null;
}

// ---------------------------------------------------------------------- input

function send(state, obj) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(obj));
}

function normalized(ev) {
  const rect = els.screen.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) / rect.width,
    y: (ev.clientY - rect.top) / rect.height,
  };
}

const ANDROID_KEYS = {
  Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Escape: 'escape',
  ArrowUp: 'dpadUp', ArrowDown: 'dpadDown', ArrowLeft: 'dpadLeft', ArrowRight: 'dpadRight',
};

function bindInput(state) {
  const screen = els.screen;
  const pointers = new Set();

  screen.onpointerdown = (ev) => {
    screen.setPointerCapture(ev.pointerId);
    pointers.add(ev.pointerId);
    screen.focus();
    send(state, { t: 'touch', action: 'down', pointerId: ev.pointerId, pressure: ev.pressure || 1, ...normalized(ev) });
  };

  screen.onpointermove = (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    send(state, { t: 'touch', action: 'move', pointerId: ev.pointerId, pressure: ev.pressure || 1, ...normalized(ev) });
  };

  const lift = (ev, action) => {
    if (!pointers.delete(ev.pointerId)) return;
    send(state, { t: 'touch', action, pointerId: ev.pointerId, ...normalized(ev) });
  };
  screen.onpointerup = (ev) => lift(ev, 'up');
  screen.onpointercancel = (ev) => lift(ev, 'cancel');

  screen.onwheel = (ev) => {
    ev.preventDefault();
    send(state, {
      t: 'scroll',
      ...normalized(ev),
      hscroll: Math.max(-1, Math.min(1, -ev.deltaX / 120)),
      vscroll: Math.max(-1, Math.min(1, -ev.deltaY / 120)),
    });
  };

  screen.onkeydown = (ev) => {
    if (ev.metaKey || ev.ctrlKey) return; // leave browser shortcuts alone

    const named = ANDROID_KEYS[ev.key];
    if (named) {
      ev.preventDefault();
      send(state, { t: 'nav', button: named });
      return;
    }
    if (ev.key.length === 1) {
      ev.preventDefault();
      send(state, { t: 'text', value: ev.key });
    }
  };

  screen.onpaste = (ev) => {
    const text = ev.clipboardData?.getData('text');
    if (!text) return;
    ev.preventDefault();
    send(state, { t: 'clipboard', value: text, paste: true });
  };

  for (const btn of document.querySelectorAll('[data-nav]')) {
    btn.onclick = () => send(state, { t: 'nav', button: btn.dataset.nav });
  }
  els.btnRotate.onclick = () => send(state, { t: 'rotate' });

  // Toggle: a second press collapses whatever the first one pulled down.
  let panelOpen = false;
  els.btnNotifications.onclick = () => {
    send(state, { t: panelOpen ? 'collapse' : 'notifications' });
    panelOpen = !panelOpen;
  };
}

// ------------------------------------------------------------------ telemetry

/**
 * Signature element: a vertical strip beside the screen showing the last 60
 * seconds of decode throughput. Time runs downward, bar length is bitrate, and
 * a notch marks any second where frames were dropped.
 */
function drawSignal(state) {
  const canvas = els.signal;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 56;
  const cssH = canvas.clientHeight || 600;

  if (canvas.width !== cssW * dpr) {
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
  }

  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const rows = 60;
  const rowH = cssH / rows;
  const peak = Math.max(200_000, ...state.history.map((h) => h.bytes * 8));

  g.fillStyle = '#2B3136';
  g.fillRect(cssW - 1, 0, 1, cssH);

  state.history.slice(-rows).forEach((sample, i) => {
    const y = i * rowH;
    const len = (sample.bytes * 8 / peak) * (cssW - 10);
    g.fillStyle = sample.dropped ? '#96700B' : '#3D6B34';
    g.fillRect(cssW - 1 - len, y + rowH * 0.2, len, Math.max(1, rowH * 0.6));
  });

  // Ten-second gridlines, so the strip reads as a timeline and not decoration.
  g.fillStyle = '#3A4045';
  for (let s = 10; s < rows; s += 10) g.fillRect(cssW - 5, s * rowH, 5, 1);
}

function startMeters(state) {
  let lastFrames = 0;
  let lastBytes = 0;
  let lastDropped = 0;
  let pingId = 0;

  state.meterTimer = setInterval(() => {
    if (active !== state) return;

    const frames = state.counters.frames - lastFrames;
    const bytes = state.counters.bytes - lastBytes;
    const dropped = state.counters.dropped - lastDropped;
    lastFrames = state.counters.frames;
    lastBytes = state.counters.bytes;
    lastDropped = state.counters.dropped;

    state.history.push({ bytes, dropped });
    if (state.history.length > 120) state.history.shift();

    els.mFps.textContent = `${frames}`;
    els.mBitrate.textContent = bytes > 125_000
      ? `${(bytes * 8 / 1e6).toFixed(1)} Mb/s`
      : `${Math.round(bytes * 8 / 1e3)} kb/s`;
    els.mDropped.textContent = String(state.counters.dropped);
    els.mRtt.textContent = state.rtt == null ? '—' : `${Math.round(state.rtt)} ms`;

    drawSignal(state);

    const id = ++pingId;
    state.pendingRtt.set(id, performance.now());
    send(state, { t: 'ping', id });
    // Never let unanswered probes accumulate.
    if (state.pendingRtt.size > 5) state.pendingRtt.clear();
  }, 1000);
}

// ------------------------------------------------------------------- teardown

function teardown() {
  if (!active) return;
  clearInterval(active.meterTimer);
  try { active.socket?.close(); } catch { /* already closing */ }
  try { active.decoder?.close(); } catch { /* already closed */ }
  els.screen.onpointerdown = els.screen.onpointermove = els.screen.onpointerup = null;
  els.screen.onwheel = els.screen.onkeydown = null;
  active = null;
  els.viewport.hidden = true;
  els.stageIdle.hidden = false;
}

function showFault(title, body) {
  els.faultTitle.textContent = title;
  els.faultBody.textContent = body;
  els.stageFault.hidden = false;
  els.viewport.hidden = true;
  els.stageIdle.hidden = true;
}

async function stopActive() {
  if (!active) return;
  const id = active.id;
  teardown();
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  sessionStorage.removeItem(`token:${id}`);
  refreshSessions();
}

// ----------------------------------------------------------------------- boot

els.btnStart.onclick = startSession;
els.btnStop.onclick = stopActive;
els.selBackend.onchange = updateBackendHint;
window.addEventListener('beforeunload', () => active?.socket?.close());

await loadCapabilities();
await pollHealth();
await refreshSessions();
setInterval(pollHealth, 5000);
setInterval(refreshSessions, 4000);
