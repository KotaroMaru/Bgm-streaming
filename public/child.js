// ── State ────────────────────────────────────────────────────────────────────
let activeTracks = [];
let loopMode = 'none'; // 'none' | 'one' | 'all'
let audioUnlocked = false;
let pendingPlay = null; // { index, currentTime } queued before unlock

const audio = document.getElementById('audioPlayer');
const trackTitleEl = document.getElementById('trackTitle');

// ── Keep Render awake ─────────────────────────────────────────────────────────
setInterval(() => fetch('/ping').catch(() => {}), 5 * 60 * 1000);

// ── Socket.io (connect only after user tap) ───────────────────────────────────
const socket = io({ autoConnect: false });
let reconnectTimer = null;

socket.on('connect', () => {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  socket.emit('register', 'child');
});

socket.on('disconnect', () => {
  reconnectTimer = setTimeout(() => socket.connect(), 3000);
});

socket.on('connect_error', () => {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => socket.connect(), 3000);
});

// ── Initial unlock ────────────────────────────────────────────────────────────
document.getElementById('startBtn').addEventListener('click', () => {
  audioUnlocked = true;
  document.getElementById('startOverlay').style.display = 'none';

  // Unlock audio context with silent WAV
  audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  audio.play().catch(() => {}).finally(() => {
    audio.src = '';
    socket.connect();
  });
});

// ── Sync on (re)connect ───────────────────────────────────────────────────────
socket.on('sync', ({ activeTracks: tracks, playState, fontSettings }) => {
  activeTracks = tracks || [];
  applyLoopMode(playState.loop ?? 'none');
  audio.volume = playState.volume ?? 1;
  applyFontSettings(fontSettings);

  if (playState.isPlaying && playState.currentIndex >= 0) {
    execPlay(playState.currentIndex, playState.currentTime ?? 0);
  }
});

// ── Active tracks update ──────────────────────────────────────────────────────
socket.on('active_tracks_updated', (tracks) => {
  activeTracks = tracks || [];
});

// ── Playback commands ─────────────────────────────────────────────────────────
socket.on('play', ({ index, currentTime = 0 }) => {
  execPlay(index, currentTime);
});

socket.on('pause', () => {
  audio.pause();
  setTitle(null);
});

socket.on('seek', ({ time }) => {
  if (!isNaN(audio.duration)) audio.currentTime = time;
});

socket.on('volume', ({ volume }) => {
  audio.volume = volume;
});

socket.on('loop_mode', ({ loop }) => {
  applyLoopMode(loop);
});

socket.on('state_updated', (state) => {
  audio.volume = state.volume ?? 1;
  applyLoopMode(state.loop ?? 'none');
});

socket.on('font_updated', (settings) => {
  applyFontSettings(settings);
});

// ── Play track by index ───────────────────────────────────────────────────────
function execPlay(index, startTime) {
  if (index < 0 || index >= activeTracks.length) return;
  const track = activeTracks[index];
  audio.src = track.cloudinaryUrl;
  audio.currentTime = startTime || 0;
  audio.play().catch((err) => console.warn('Play blocked:', err));
  setTitle(track.name);
}

function setTitle(name) {
  trackTitleEl.textContent = name ?? '';
}

// ── Loop mode ─────────────────────────────────────────────────────────────────
function applyLoopMode(mode) {
  loopMode = mode;
  // 'one' loop is handled natively by audio.loop = true.
  // This prevents the 'ended' event from firing, so the server never advances.
  audio.loop = (mode === 'one');
}

// ── Audio callbacks ───────────────────────────────────────────────────────────
let lastTimeEmit = 0;
audio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastTimeEmit < 900) return;
  lastTimeEmit = now;
  socket.emit('time_update', {
    currentTime: audio.currentTime,
    duration: isNaN(audio.duration) ? 0 : audio.duration,
  });
});

// Only fires when audio.loop === false (i.e., loopMode !== 'one')
audio.addEventListener('ended', () => {
  socket.emit('track_ended');
});

audio.addEventListener('error', () => {
  console.warn('Audio error on track:', audio.src);
  socket.emit('track_ended');
});

// ── Font settings ─────────────────────────────────────────────────────────────
function applyFontSettings(settings) {
  if (!settings) return;
  trackTitleEl.style.fontSize = `${settings.fontSize ?? 64}px`;
  trackTitleEl.style.color = settings.color ?? '#ffffff';

  if (settings.type === 'google') {
    loadGoogleFont(settings.googleFontName);
    trackTitleEl.style.fontFamily = `'${settings.googleFontName}', sans-serif`;
  } else if (settings.type === 'custom' && settings.customFontUrl) {
    loadCustomFont(settings.customFontUrl);
    trackTitleEl.style.fontFamily = "'ChildCustomFont', sans-serif";
  }
}

function loadGoogleFont(name) {
  if (!name) return;
  const id = `gfont-${name.replace(/\s+/g, '-')}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}&display=swap`;
  document.head.appendChild(link);
}

function loadCustomFont(url) {
  let style = document.getElementById('child-custom-font');
  if (!style) {
    style = document.createElement('style');
    style.id = 'child-custom-font';
    document.head.appendChild(style);
  }
  style.textContent = `@font-face { font-family: 'ChildCustomFont'; src: url('${url}'); }`;
}

// ── Load font settings on page open ──────────────────────────────────────────
fetch('/settings/font')
  .then((r) => r.json())
  .then((s) => applyFontSettings(s))
  .catch(() => {});
