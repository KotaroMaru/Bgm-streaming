/* ── State ──────────────────────────────────────────────────────────────────── */
let playlist = [];
let audioUnlocked = false;
let pendingAction = null; // { type: 'play', index, currentTime } – queued before unlock
let loopMode = 'none'; // 'none' | 'all' | 'one'

const audio = document.getElementById('audioPlayer');
const trackTitleEl = document.getElementById('trackTitle');

/* ── Keep Render awake ──────────────────────────────────────────────────────── */
setInterval(() => fetch('/ping').catch(() => {}), 5 * 60 * 1000);

/* ── Socket.io (connect only after user tap) ────────────────────────────────── */
const socket = io({ autoConnect: false });
let reconnectTimer = null;

socket.on('connect', () => {
  console.log('Connected:', socket.id);
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  socket.emit('register', 'child');
});

socket.on('disconnect', () => {
  console.log('Disconnected. Reconnecting in 3 s…');
  reconnectTimer = setTimeout(() => socket.connect(), 3000);
});

socket.on('connect_error', () => {
  reconnectTimer = setTimeout(() => socket.connect(), 3000);
});

/* ── Initial unlock button ──────────────────────────────────────────────────── */
document.getElementById('startBtn').addEventListener('click', () => {
  audioUnlocked = true;
  document.getElementById('startOverlay').style.display = 'none';

  // Prime the audio context with a silent play to unlock autoplay
  audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  audio.play().catch(() => {}).finally(() => {
    audio.src = '';
    socket.connect();
  });
});

/* ── Sync on (re)connect ────────────────────────────────────────────────────── */
socket.on('sync', ({ playlist: pl, playState }) => {
  playlist = pl;
  loopMode = playState.loop ?? 'none';
  audio.volume = playState.volume ?? 1;

  if (playState.isPlaying && playState.currentIndex >= 0) {
    execPlay(playState.currentIndex, playState.currentTime ?? 0);
  }
});

/* ── Playlist updates ────────────────────────────────────────────────────────── */
socket.on('playlist_updated', (pl) => {
  playlist = pl;
});

/* ── Playback commands ───────────────────────────────────────────────────────── */
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
  loopMode = loop;
});

socket.on('state_updated', (state) => {
  audio.volume = state.volume ?? 1;
  loopMode = state.loop ?? 'none';
});

/* ── Play a track by index ──────────────────────────────────────────────────── */
function execPlay(index, startTime) {
  if (index < 0 || index >= playlist.length) return;
  const track = playlist[index];

  audio.src = track.url;
  audio.currentTime = startTime || 0;
  audio.play().catch((err) => console.warn('Play blocked:', err));
  setTitle(track.name);
}

function setTitle(name) {
  trackTitleEl.textContent = name ?? '';
}

/* ── Audio event → server ────────────────────────────────────────────────────── */
let lastTimeEmit = 0;
audio.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - lastTimeEmit < 900) return; // throttle to ~1/sec
  lastTimeEmit = now;
  socket.emit('time_update', {
    currentTime: audio.currentTime,
    duration: isNaN(audio.duration) ? 0 : audio.duration,
  });
});

audio.addEventListener('ended', () => {
  socket.emit('track_ended');
});

// On error, notify server so it can advance the playlist
audio.addEventListener('error', () => {
  console.warn('Audio error on track:', audio.src);
  socket.emit('track_ended');
});
