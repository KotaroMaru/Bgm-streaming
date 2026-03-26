/* ── State ──────────────────────────────────────────────────────────────────── */
let playlist = [];
let playState = {
  currentIndex: -1,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  shuffle: false,
  loop: 'none',
};

// Local timer for smooth time display between server updates
let localTimerStart = null;
let localTimeBase = 0;
let localTimerRaf = null;

/* ── Socket.io ──────────────────────────────────────────────────────────────── */
const socket = io();
socket.emit('register', 'parent');

// Keep Render from sleeping
setInterval(() => fetch('/ping').catch(() => {}), 5 * 60 * 1000);

socket.on('child_status', ({ count }) => {
  const badge = document.getElementById('childStatus');
  const dot = badge.querySelector('.child-badge__dot');
  const text = badge.querySelector('.child-badge__text');
  text.textContent = count > 0 ? `接続中 (${count})` : '未接続';
  badge.classList.toggle('child-badge--connected', count > 0);
  badge.classList.toggle('child-badge--disconnected', count === 0);
});

socket.on('playlist_updated', (newPlaylist) => {
  playlist = newPlaylist;
  renderPlaylist();
  updateNowPlaying();
});

socket.on('state_updated', (state) => {
  playState = state;
  syncLocalTimer();
  updateControls();
  updateNowPlaying();
  renderPlaylistActive();
});

socket.on('time_update', ({ currentTime, duration }) => {
  playState.currentTime = currentTime;
  if (duration) playState.duration = duration;
  syncLocalTimer();
  updateTimeDisplay();
});

/* ── Local smooth timer ──────────────────────────────────────────────────────── */
function syncLocalTimer() {
  cancelAnimationFrame(localTimerRaf);
  localTimeBase = playState.currentTime;
  localTimerStart = playState.isPlaying ? performance.now() : null;
  if (playState.isPlaying) tickTimer();
}

function tickTimer() {
  if (!localTimerStart) return;
  const elapsed = (performance.now() - localTimerStart) / 1000;
  const t = localTimeBase + elapsed;
  updateTimeDisplay(t);
  localTimerRaf = requestAnimationFrame(tickTimer);
}

function updateTimeDisplay(overrideTime) {
  const t = overrideTime !== undefined ? overrideTime : playState.currentTime;
  const d = playState.duration || 0;
  document.getElementById('currentTime').textContent = formatTime(t);
  document.getElementById('durationTime').textContent = formatTime(d);

  const seekRange = document.getElementById('seekRange');
  const seekFill = document.getElementById('seekFill');
  if (d > 0) {
    const pct = Math.min((t / d) * 100, 100);
    seekRange.max = 100;
    seekRange.value = pct;
    seekFill.style.width = `${pct}%`;
  } else {
    seekRange.value = 0;
    seekFill.style.width = '0%';
  }
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ── Now Playing ─────────────────────────────────────────────────────────────── */
function updateNowPlaying() {
  const track = playlist[playState.currentIndex];
  document.getElementById('nowPlayingTitle').textContent = track ? track.name : '—';
  updateTimeDisplay();
}

/* ── Controls ────────────────────────────────────────────────────────────────── */
function updateControls() {
  // Play / pause icons
  const btnPlay = document.getElementById('btnPlay');
  btnPlay.querySelector('.icon-play').style.display = playState.isPlaying ? 'none' : '';
  btnPlay.querySelector('.icon-pause').style.display = playState.isPlaying ? '' : 'none';

  // Shuffle
  document.getElementById('btnShuffle').classList.toggle('is-active', playState.shuffle);

  // Loop
  const btnLoop = document.getElementById('btnLoop');
  const loop = playState.loop ?? 'none';
  btnLoop.dataset.loop = loop;
  btnLoop.classList.toggle('is-active', loop !== 'none');
  btnLoop.querySelector('.icon-loop-all').style.display = loop === 'one' ? 'none' : '';
  btnLoop.querySelector('.icon-loop-one').style.display = loop === 'one' ? '' : 'none';
  const loopTitles = { none: 'ループなし', all: '全曲ループ', one: '1曲ループ' };
  btnLoop.title = loopTitles[loop] ?? '';

  // Volume
  const vol = Math.round((playState.volume ?? 1) * 100);
  document.getElementById('volumeSlider').value = vol;
  document.getElementById('volumeLabel').textContent = `${vol}%`;
}

/* ── Playlist render ─────────────────────────────────────────────────────────── */
function renderPlaylist() {
  const ul = document.getElementById('playlist');
  const empty = document.getElementById('playlistEmpty');
  document.getElementById('trackCount').textContent = playlist.length;

  // Remove all track items (keep the empty placeholder)
  ul.querySelectorAll('.playlist-item').forEach((el) => el.remove());

  if (playlist.length === 0) {
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';

  playlist.forEach((track, i) => {
    const li = document.createElement('li');
    li.className = 'playlist-item';
    if (i === playState.currentIndex) li.classList.add('is-active');
    li.dataset.id = track.id;
    li.dataset.index = i;
    li.draggable = true;

    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M20 9H4v2h16V9zm0 4H4v2h16v-2z"/></svg>
      </span>
      <span class="track-name">${escapeHtml(track.name)}</span>
      <button class="delete-btn" aria-label="削除">
        <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    `;

    // Click track name → play
    li.querySelector('.track-name').addEventListener('click', () => {
      socket.emit('play', { index: i, currentTime: 0 });
    });

    // Delete
    li.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`"${track.name}" を削除しますか？`)) return;
      try {
        const res = await fetch(`/track?id=${encodeURIComponent(track.id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
      } catch (err) {
        alert(`削除に失敗しました: ${err.message}`);
      }
    });

    ul.appendChild(li);
  });

  initDragDrop(ul);
  initTouchDragDrop(ul);
}

function renderPlaylistActive() {
  document.querySelectorAll('.playlist-item').forEach((li, i) => {
    li.classList.toggle('is-active', i === playState.currentIndex);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Drag & Drop (mouse) ─────────────────────────────────────────────────────── */
function initDragDrop(ul) {
  let dragSrc = null;

  ul.querySelectorAll('.playlist-item').forEach((item) => {
    item.addEventListener('dragstart', (e) => {
      dragSrc = item;
      e.dataTransfer.effectAllowed = 'move';
      setTimeout(() => item.classList.add('is-dragging'), 0);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('is-dragging');
      ul.querySelectorAll('.playlist-item').forEach((i) => i.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      ul.querySelectorAll('.playlist-item').forEach((i) => i.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (dragSrc && dragSrc !== item) {
        const items = [...ul.querySelectorAll('.playlist-item')];
        const srcIdx = items.indexOf(dragSrc);
        const dstIdx = items.indexOf(item);
        ul.insertBefore(dragSrc, srcIdx < dstIdx ? item.nextSibling : item);
        sendReorder(ul);
      }
    });
  });
}

/* ── Drag & Drop (touch) ─────────────────────────────────────────────────────── */
function initTouchDragDrop(ul) {
  let dragEl = null;
  let clone = null;
  let offsetX = 0;
  let offsetY = 0;

  ul.querySelectorAll('.drag-handle').forEach((handle) => {
    handle.addEventListener('touchstart', (e) => {
      const item = handle.closest('.playlist-item');
      dragEl = item;
      const touch = e.touches[0];
      const rect = item.getBoundingClientRect();
      offsetX = touch.clientX - rect.left;
      offsetY = touch.clientY - rect.top;

      clone = item.cloneNode(true);
      clone.style.cssText = `
        position: fixed; pointer-events: none; z-index: 1000; opacity: 0.85;
        width: ${rect.width}px; left: ${rect.left}px; top: ${rect.top}px;
      `;
      document.body.appendChild(clone);
      item.classList.add('is-dragging');
      e.preventDefault();
    }, { passive: false });
  });

  document.addEventListener('touchmove', (e) => {
    if (!dragEl || !clone) return;
    const touch = e.touches[0];
    clone.style.left = `${touch.clientX - offsetX}px`;
    clone.style.top = `${touch.clientY - offsetY}px`;

    // Highlight target
    const items = [...ul.querySelectorAll('.playlist-item:not(.is-dragging)')];
    items.forEach((i) => i.classList.remove('drag-over'));
    const target = items.find((i) => {
      const r = i.getBoundingClientRect();
      return touch.clientY >= r.top && touch.clientY <= r.bottom;
    });
    if (target) target.classList.add('drag-over');

    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (!dragEl || !clone) return;
    const touch = e.changedTouches[0];
    clone.remove();
    clone = null;
    dragEl.classList.remove('is-dragging');

    const items = [...ul.querySelectorAll('.playlist-item')];
    items.forEach((i) => i.classList.remove('drag-over'));

    const target = items.find((i) => {
      if (i === dragEl) return false;
      const r = i.getBoundingClientRect();
      return touch.clientY >= r.top && touch.clientY <= r.bottom;
    });

    if (target) {
      const srcIdx = items.indexOf(dragEl);
      const dstIdx = items.indexOf(target);
      ul.insertBefore(dragEl, srcIdx < dstIdx ? target.nextSibling : target);
      sendReorder(ul);
    }

    dragEl = null;
  });
}

function sendReorder(ul) {
  const order = [...ul.querySelectorAll('.playlist-item')].map((li) => li.dataset.id);
  fetch('/playlist/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order }),
  }).catch(console.error);
}

/* ── Upload ──────────────────────────────────────────────────────────────────── */
const fileInput = document.getElementById('fileInput');
const uploadArea = document.getElementById('uploadArea');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');

fileInput.addEventListener('change', async (e) => {
  const files = [...e.target.files];
  for (const f of files) await uploadFile(f);
  fileInput.value = '';
});

uploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadArea.classList.add('is-drag-over');
});
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('is-drag-over'));
uploadArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  uploadArea.classList.remove('is-drag-over');
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio/'));
  for (const f of files) await uploadFile(f);
});

async function uploadFile(file) {
  const MAX = 50 * 1024 * 1024;
  if (file.size > MAX) {
    alert(`"${file.name}" は 50 MB を超えています。`);
    return;
  }

  progressWrap.style.display = 'flex';
  setProgress(0, file.name);

  const fd = new FormData();
  fd.append('file', file);

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100), file.name);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error(`サーバーエラー: ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('ネットワークエラー'));
      xhr.send(fd);
    });

    setProgress(100, `完了: ${file.name}`);
    setTimeout(() => { progressWrap.style.display = 'none'; }, 1500);
  } catch (err) {
    setProgress(0, `エラー: ${err.message}`);
    setTimeout(() => { progressWrap.style.display = 'none'; }, 3000);
  }
}

function setProgress(pct, label) {
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${pct}%  ${label}`;
}

/* ── Button handlers ─────────────────────────────────────────────────────────── */
document.getElementById('btnPlay').addEventListener('click', () => {
  if (playState.isPlaying) {
    socket.emit('pause', { currentTime: localCurrentTime() });
  } else {
    const idx = playState.currentIndex >= 0 ? playState.currentIndex : 0;
    socket.emit('play', { index: idx, currentTime: playState.currentTime });
  }
});

document.getElementById('btnNext').addEventListener('click', () => socket.emit('next'));
document.getElementById('btnPrev').addEventListener('click', () => socket.emit('prev'));

document.getElementById('btnShuffle').addEventListener('click', () => {
  socket.emit('shuffle', { shuffle: !playState.shuffle });
});

document.getElementById('btnLoop').addEventListener('click', () => {
  const modes = ['none', 'all', 'one'];
  const next = modes[(modes.indexOf(playState.loop) + 1) % modes.length];
  socket.emit('loop', { loop: next });
});

document.getElementById('volumeSlider').addEventListener('input', (e) => {
  const vol = parseInt(e.target.value) / 100;
  document.getElementById('volumeLabel').textContent = `${e.target.value}%`;
  socket.emit('volume', { volume: vol });
});

// Seek bar
const seekRange = document.getElementById('seekRange');
let isSeeking = false;
seekRange.addEventListener('mousedown', () => { isSeeking = true; });
seekRange.addEventListener('touchstart', () => { isSeeking = true; });
seekRange.addEventListener('change', () => {
  isSeeking = false;
  if (playState.duration > 0) {
    const t = (parseFloat(seekRange.value) / 100) * playState.duration;
    socket.emit('seek', { time: t });
  }
});
// Prevent timer from updating while user drags
function localCurrentTime() {
  if (!localTimerStart) return playState.currentTime;
  return localTimeBase + (performance.now() - localTimerStart) / 1000;
}

/* ── Init ────────────────────────────────────────────────────────────────────── */
fetch('/playlist')
  .then((r) => r.json())
  .then((data) => {
    playlist = data;
    renderPlaylist();
    updateNowPlaying();
  })
  .catch(console.error);
