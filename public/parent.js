// ── State ────────────────────────────────────────────────────────────────────
let library = [];
let playlists = [];
let activePlaylistId = null;
let activeTracks = [];
let playState = {
  currentIndex: -1, isPlaying: false, currentTime: 0,
  duration: 0, volume: 1, shuffle: false, loop: 'none',
};
let fontSettings = {
  type: 'google', googleFontName: 'Noto Sans JP',
  customFontUrl: null, fontSize: 64, color: '#ffffff',
};

// Local font draft (not yet applied to child)
let fontDraft = { ...fontSettings };

// Local timer for smooth time display
let localTimerStart = null;
let localTimeBase = 0;
let localTimerRaf = null;

// Google Fonts list (popular + Japanese)
const GOOGLE_FONTS = [
  'Noto Sans JP','Noto Serif JP','M PLUS 1p','M PLUS Rounded 1c',
  'Kosugi','Kosugi Maru','Sawarabi Gothic','Sawarabi Mincho',
  'Zen Kaku Gothic New','Zen Antique','BIZ UDGothic','BIZ UDMincho',
  'DotGothic16','Hachi Maru Pop','Kaisei Decol','RocknRoll One',
  'Roboto','Open Sans','Lato','Montserrat','Oswald','Raleway',
  'Playfair Display','Merriweather','Ubuntu','Nunito','Poppins',
  'Dancing Script','Pacifico','Lobster','Bebas Neue','Anton',
  'Cinzel','Cormorant Garamond','Josefin Sans','Righteous',
];

// ── Socket.io ────────────────────────────────────────────────────────────────
const socket = io();
socket.emit('register', 'parent');
setInterval(() => fetch('/ping').catch(() => {}), 5 * 60 * 1000);

socket.on('sync_parent', (data) => {
  library = data.library || [];
  playlists = data.playlists || [];
  activePlaylistId = data.activePlaylistId || null;
  activeTracks = data.activeTracks || [];
  playState = data.playState || playState;
  fontSettings = data.fontSettings || fontSettings;
  fontDraft = { ...fontSettings };

  renderAll();
  syncLocalTimer();
  applyFontDraftToPreview();
});

socket.on('library_updated', (lib) => {
  library = lib;
  renderLibrary();
});

socket.on('playlists_updated', (data) => {
  playlists = data.playlists || [];
  activePlaylistId = data.activePlaylistId || null;
  renderPlaylistSelector();
  renderActivePlaylistTracks();
  updateNowPlayingPlaylistName();
});

socket.on('active_tracks_updated', (tracks) => {
  activeTracks = tracks;
  renderActivePlaylistTracks();
});

socket.on('state_updated', (state) => {
  playState = state;
  syncLocalTimer();
  updateControls();
  updateNowPlaying();
  renderPlaylistActiveRow();
});

socket.on('time_update', ({ currentTime, duration }) => {
  playState.currentTime = currentTime;
  if (duration) playState.duration = duration;
  syncLocalTimer();
  updateTimeDisplay();
});

socket.on('font_updated', (settings) => {
  fontSettings = settings;
  fontDraft = { ...settings };
  applyFontDraftToPreview();
  syncFontSettingsUI();
});

socket.on('child_status', ({ count }) => {
  const badge = document.getElementById('childStatus');
  badge.querySelector('.child-badge__text').textContent =
    count > 0 ? `接続中 (${count})` : '未接続';
  badge.classList.toggle('child-badge--connected', count > 0);
  badge.classList.toggle('child-badge--disconnected', count === 0);
});

// ── Tab navigation ────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('is-active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('is-active'));
    btn.classList.add('is-active');
    document.getElementById(`tab-${tab}`).classList.add('is-active');
  });
});

// ── Render all ───────────────────────────────────────────────────────────────
function renderAll() {
  renderLibrary();
  renderPlaylistSelector();
  renderActivePlaylistTracks();
  updateControls();
  updateNowPlaying();
  updateTimeDisplay();
  updateNowPlayingPlaylistName();
}

// ── Library ──────────────────────────────────────────────────────────────────
function renderLibrary() {
  const ul = document.getElementById('libraryList');
  document.getElementById('libraryCount').textContent = `${library.length}曲`;

  ul.innerHTML = '';

  if (library.length === 0) {
    ul.innerHTML = '<li class="playlist-empty">曲がありません</li>';
    return;
  }

  library.forEach((track) => {
    const li = document.createElement('li');
    li.className = 'library-item';
    li.innerHTML = `
      <span class="track-name">${escHtml(track.name)}</span>
      <div class="library-item__actions">
        <button class="btn-add" data-id="${escHtml(track.id)}" aria-label="プレイリストに追加">
          <svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </button>
        <button class="delete-btn" data-id="${escHtml(track.id)}" aria-label="削除">
          <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    `;

    li.querySelector('.btn-add').addEventListener('click', () => openAddToPlaylistModal(track));
    li.querySelector('.delete-btn').addEventListener('click', () => deleteLibraryTrack(track));

    ul.appendChild(li);
  });
}

async function deleteLibraryTrack(track) {
  if (!confirm(`"${track.name}" をライブラリから削除しますか？\nCloudinaryからも削除されます。`)) return;
  try {
    const res = await fetch(`/library?id=${encodeURIComponent(track.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    alert(`削除に失敗しました: ${err.message}`);
  }
}

// ── Add to playlist modal ─────────────────────────────────────────────────────
let modalTrackId = null;

function openAddToPlaylistModal(track) {
  modalTrackId = track.id;
  document.getElementById('modalTrackName').textContent = track.name;

  const list = document.getElementById('modalPlaylistList');
  list.innerHTML = '';

  if (playlists.length === 0) {
    list.innerHTML = '<li class="playlist-empty">プレイリストがありません。<br>「リスト」タブで作成してください。</li>';
  } else {
    playlists.forEach((pl) => {
      const already = pl.trackIds.includes(track.id);
      const li = document.createElement('li');
      li.className = `modal__playlist-item${already ? ' is-added' : ''}`;
      li.innerHTML = `
        <span>${escHtml(pl.name)}</span>
        <span class="modal__added-label">${already ? '追加済み' : ''}</span>
      `;
      if (!already) {
        li.addEventListener('click', () => addTrackToPlaylist(pl.id, track.id));
      }
      list.appendChild(li);
    });
  }

  document.getElementById('addToPlaylistModal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('addToPlaylistModal').style.display = 'none';
  modalTrackId = null;
}

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('addToPlaylistModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeModal();
});

async function addTrackToPlaylist(playlistId, trackId) {
  try {
    const res = await fetch(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId }),
    });
    if (!res.ok) {
      const data = await res.json();
      if (res.status === 409) {
        alert('この曲はすでに追加されています。');
        return;
      }
      throw new Error(data.error || res.statusText);
    }
    closeModal();
  } catch (err) {
    alert(`追加に失敗しました: ${err.message}`);
  }
}

// ── Playlist selector ─────────────────────────────────────────────────────────
function renderPlaylistSelector() {
  const ul = document.getElementById('playlistSelector');
  ul.innerHTML = '';

  if (playlists.length === 0) {
    ul.innerHTML = '<li class="ps-empty">プレイリストがありません</li>';
    return;
  }

  playlists.forEach((pl) => {
    const li = document.createElement('li');
    li.className = `ps-item${pl.id === activePlaylistId ? ' is-active' : ''}`;
    li.innerHTML = `
      <button class="ps-item__name" data-id="${escHtml(pl.id)}">${escHtml(pl.name)}</button>
      <span class="ps-item__count">${pl.trackIds.length}曲</span>
      <button class="delete-btn ps-item__delete" data-id="${escHtml(pl.id)}" aria-label="削除">
        <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    `;

    li.querySelector('.ps-item__name').addEventListener('click', () => setActivePlaylist(pl.id));
    li.querySelector('.ps-item__delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deletePlaylist(pl);
    });

    ul.appendChild(li);
  });
}

async function setActivePlaylist(id) {
  try {
    const res = await fetch('/playlists/active', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    alert(`切り替えに失敗しました: ${err.message}`);
  }
}

async function deletePlaylist(pl) {
  if (!confirm(`"${pl.name}" を削除しますか？`)) return;
  try {
    const res = await fetch(`/playlists/${pl.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
  } catch (err) {
    alert(`削除に失敗しました: ${err.message}`);
  }
}

document.getElementById('btnCreatePlaylist').addEventListener('click', async () => {
  const input = document.getElementById('newPlaylistName');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  try {
    const res = await fetch('/playlists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(await res.text());
    input.value = '';
  } catch (err) {
    alert(`作成に失敗しました: ${err.message}`);
  }
});

document.getElementById('newPlaylistName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btnCreatePlaylist').click();
});

// ── Active playlist tracks ────────────────────────────────────────────────────
function renderActivePlaylistTracks() {
  const section = document.getElementById('activePlaylistSection');
  const pl = playlists.find((p) => p.id === activePlaylistId);

  if (!pl) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  document.getElementById('activePlaylistTitle').textContent = pl.name;
  document.getElementById('plTrackCount').textContent = `${activeTracks.length}曲`;

  const ul = document.getElementById('plTrackList');
  ul.innerHTML = '';

  if (activeTracks.length === 0) {
    ul.innerHTML = '<li class="playlist-empty">曲がありません。ライブラリから追加してください。</li>';
    return;
  }

  activeTracks.forEach((track, i) => {
    const li = document.createElement('li');
    li.className = `playlist-item${i === playState.currentIndex ? ' is-active' : ''}`;
    li.dataset.id = track.id;
    li.dataset.index = i;
    li.draggable = true;

    li.innerHTML = `
      <span class="drag-handle" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M20 9H4v2h16V9zm0 4H4v2h16v-2z"/></svg>
      </span>
      <span class="track-name">${escHtml(track.name)}</span>
      <button class="delete-btn" aria-label="リストから削除">
        <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    `;

    li.querySelector('.track-name').addEventListener('click', () => {
      socket.emit('play', { index: i, currentTime: 0 });
    });

    li.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await fetch(
          `/playlists/${activePlaylistId}/tracks?trackId=${encodeURIComponent(track.id)}`,
          { method: 'DELETE' }
        );
        if (!res.ok) throw new Error(await res.text());
      } catch (err) {
        alert(`削除に失敗しました: ${err.message}`);
      }
    });

    ul.appendChild(li);
  });

  initDragDrop(ul, activePlaylistId);
  initTouchDragDrop(ul, activePlaylistId);
}

function renderPlaylistActiveRow() {
  document.querySelectorAll('#plTrackList .playlist-item').forEach((li, i) => {
    li.classList.toggle('is-active', i === playState.currentIndex);
  });
}

function updateNowPlayingPlaylistName() {
  const pl = playlists.find((p) => p.id === activePlaylistId);
  document.getElementById('nowPlaylistName').textContent = pl ? pl.name : 'プレイリスト未選択';
}

// ── Drag & Drop (mouse) ───────────────────────────────────────────────────────
function initDragDrop(ul, playlistId) {
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
      ul.querySelectorAll('.playlist-item').forEach((i) => i.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (dragSrc && dragSrc !== item) {
        const items = [...ul.querySelectorAll('.playlist-item')];
        const si = items.indexOf(dragSrc), di = items.indexOf(item);
        ul.insertBefore(dragSrc, si < di ? item.nextSibling : item);
        sendReorder(ul, playlistId);
      }
    });
  });
}

// ── Drag & Drop (touch) ───────────────────────────────────────────────────────
function initTouchDragDrop(ul, playlistId) {
  let dragEl = null, clone = null, offsetX = 0, offsetY = 0;

  ul.querySelectorAll('.drag-handle').forEach((handle) => {
    handle.addEventListener('touchstart', (e) => {
      const item = handle.closest('.playlist-item');
      dragEl = item;
      const touch = e.touches[0];
      const rect = item.getBoundingClientRect();
      offsetX = touch.clientX - rect.left;
      offsetY = touch.clientY - rect.top;
      clone = item.cloneNode(true);
      clone.style.cssText = `position:fixed;pointer-events:none;z-index:1000;opacity:0.85;width:${rect.width}px;left:${rect.left}px;top:${rect.top}px;`;
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
    const items = [...ul.querySelectorAll('.playlist-item:not(.is-dragging)')];
    items.forEach((i) => i.classList.remove('drag-over'));
    const target = items.find((i) => { const r = i.getBoundingClientRect(); return touch.clientY >= r.top && touch.clientY <= r.bottom; });
    if (target) target.classList.add('drag-over');
    e.preventDefault();
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (!dragEl || !clone) return;
    const touch = e.changedTouches[0];
    clone.remove(); clone = null;
    dragEl.classList.remove('is-dragging');
    const items = [...ul.querySelectorAll('.playlist-item')];
    items.forEach((i) => i.classList.remove('drag-over'));
    const target = items.find((i) => { if (i === dragEl) return false; const r = i.getBoundingClientRect(); return touch.clientY >= r.top && touch.clientY <= r.bottom; });
    if (target) {
      const si = items.indexOf(dragEl), di = items.indexOf(target);
      ul.insertBefore(dragEl, si < di ? target.nextSibling : target);
      sendReorder(ul, playlistId);
    }
    dragEl = null;
  });
}

async function sendReorder(ul, playlistId) {
  const trackIds = [...ul.querySelectorAll('.playlist-item')].map((li) => li.dataset.id);
  try {
    await fetch(`/playlists/${playlistId}/reorder`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackIds }),
    });
  } catch (err) { console.error(err); }
}

// ── Upload ────────────────────────────────────────────────────────────────────
const fileInput = document.getElementById('fileInput');
const uploadArea = document.getElementById('uploadArea');

fileInput.addEventListener('change', async (e) => {
  for (const f of [...e.target.files]) await uploadAudioFile(f);
  fileInput.value = '';
});

uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('is-drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('is-drag-over'));
uploadArea.addEventListener('drop', async (e) => {
  e.preventDefault(); uploadArea.classList.remove('is-drag-over');
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('audio/'));
  for (const f of files) await uploadAudioFile(f);
});

async function uploadAudioFile(file) {
  if (file.size > 50 * 1024 * 1024) { alert(`"${file.name}" は 50 MB を超えています。`); return; }
  setProgress('progressWrap', 'progressFill', 'progressLabel', 0, file.name);
  document.getElementById('progressWrap').style.display = 'flex';

  const fd = new FormData();
  fd.append('file', file);

  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/upload');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) setProgress('progressWrap', 'progressFill', 'progressLabel', Math.round(e.loaded / e.total * 100), file.name);
      };
      xhr.onload = () => xhr.status < 300 ? resolve() : reject(new Error(`サーバーエラー: ${xhr.status}`));
      xhr.onerror = () => reject(new Error('ネットワークエラー'));
      xhr.send(fd);
    });
    setProgress('progressWrap', 'progressFill', 'progressLabel', 100, `完了: ${file.name}`);
    setTimeout(() => { document.getElementById('progressWrap').style.display = 'none'; }, 1500);
  } catch (err) {
    setProgress('progressWrap', 'progressFill', 'progressLabel', 0, `エラー: ${err.message}`);
    setTimeout(() => { document.getElementById('progressWrap').style.display = 'none'; }, 3000);
  }
}

function setProgress(wrapId, fillId, labelId, pct, label) {
  document.getElementById(fillId).style.width = `${pct}%`;
  document.getElementById(labelId).textContent = `${pct < 100 ? pct + '%  ' : ''}${label}`;
}

// ── Playback controls ─────────────────────────────────────────────────────────
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

// Loop: none → one → all → none
const LOOP_MODES = ['none', 'one', 'all'];
const LOOP_LABELS = { none: 'OFF', one: '1曲', all: '全曲' };

document.getElementById('btnLoop').addEventListener('click', () => {
  const next = LOOP_MODES[(LOOP_MODES.indexOf(playState.loop) + 1) % LOOP_MODES.length];
  socket.emit('loop', { loop: next });
});

document.getElementById('volumeSlider').addEventListener('input', (e) => {
  const vol = parseInt(e.target.value) / 100;
  document.getElementById('volumeLabel').textContent = `${e.target.value}%`;
  socket.emit('volume', { volume: vol });
});

// Seek
const seekRange = document.getElementById('seekRange');
let isSeeking = false;
seekRange.addEventListener('pointerdown', () => { isSeeking = true; });
seekRange.addEventListener('change', () => {
  isSeeking = false;
  if (playState.duration > 0) {
    socket.emit('seek', { time: (parseFloat(seekRange.value) / 100) * playState.duration });
  }
});

function localCurrentTime() {
  if (!localTimerStart) return playState.currentTime;
  return localTimeBase + (performance.now() - localTimerStart) / 1000;
}

// ── UI update functions ───────────────────────────────────────────────────────
function updateControls() {
  const btnPlay = document.getElementById('btnPlay');
  btnPlay.querySelector('.icon-play').style.display = playState.isPlaying ? 'none' : '';
  btnPlay.querySelector('.icon-pause').style.display = playState.isPlaying ? '' : 'none';

  document.getElementById('btnShuffle').classList.toggle('is-active', playState.shuffle);

  const btnLoop = document.getElementById('btnLoop');
  const loop = playState.loop ?? 'none';
  btnLoop.dataset.loop = loop;
  btnLoop.classList.toggle('is-active', loop !== 'none');
  btnLoop.querySelector('.loop-label').textContent = LOOP_LABELS[loop] ?? 'OFF';

  const vol = Math.round((playState.volume ?? 1) * 100);
  document.getElementById('volumeSlider').value = vol;
  document.getElementById('volumeLabel').textContent = `${vol}%`;
}

function updateNowPlaying() {
  const track = activeTracks[playState.currentIndex];
  document.getElementById('nowPlayingTitle').textContent = track ? track.name : '—';
  updateTimeDisplay();
}

function updateTimeDisplay(overrideTime) {
  if (isSeeking) return;
  const t = overrideTime !== undefined ? overrideTime : playState.currentTime;
  const d = playState.duration || 0;
  document.getElementById('currentTime').textContent = formatTime(t);
  document.getElementById('durationTime').textContent = formatTime(d);
  if (d > 0) {
    const pct = Math.min((t / d) * 100, 100);
    seekRange.value = pct;
    document.getElementById('seekFill').style.width = `${pct}%`;
  }
}

// ── Local timer ───────────────────────────────────────────────────────────────
function syncLocalTimer() {
  cancelAnimationFrame(localTimerRaf);
  localTimeBase = playState.currentTime;
  localTimerStart = playState.isPlaying ? performance.now() : null;
  if (playState.isPlaying) tickTimer();
}

function tickTimer() {
  if (!localTimerStart) return;
  updateTimeDisplay(localTimeBase + (performance.now() - localTimerStart) / 1000);
  localTimerRaf = requestAnimationFrame(tickTimer);
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

// ── Font settings ─────────────────────────────────────────────────────────────
// Font type toggle
document.querySelectorAll('.toggle-pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-pill').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    fontDraft.type = btn.dataset.type;
    document.getElementById('googleFontPanel').style.display = btn.dataset.type === 'google' ? '' : 'none';
    document.getElementById('customFontPanel').style.display = btn.dataset.type === 'custom' ? '' : 'none';
    applyFontDraftToPreview();
  });
});

// Google Fonts list
function renderGoogleFontList(filter = '') {
  const ul = document.getElementById('fontList');
  ul.innerHTML = '';
  const filtered = GOOGLE_FONTS.filter((n) => n.toLowerCase().includes(filter.toLowerCase()));

  filtered.forEach((name) => {
    const li = document.createElement('li');
    li.className = `font-item${fontDraft.googleFontName === name && fontDraft.type === 'google' ? ' is-selected' : ''}`;
    li.dataset.font = name;

    // Load font for preview
    loadGoogleFont(name);
    li.innerHTML = `<span style="font-family:'${name}',sans-serif">${name}</span>`;

    li.addEventListener('click', () => {
      fontDraft.googleFontName = name;
      fontDraft.type = 'google';
      document.querySelectorAll('.font-item').forEach((i) => i.classList.remove('is-selected'));
      li.classList.add('is-selected');
      applyFontDraftToPreview();
    });

    ul.appendChild(li);
  });
}

document.getElementById('fontSearch').addEventListener('input', (e) => {
  renderGoogleFontList(e.target.value);
});

// Font size
document.getElementById('fontSizeSlider').addEventListener('input', (e) => {
  fontDraft.fontSize = parseInt(e.target.value);
  document.getElementById('fontSizeLabel').textContent = `${fontDraft.fontSize}px`;
  applyFontDraftToPreview();
});

// Font color
document.getElementById('fontColorPicker').addEventListener('input', (e) => {
  fontDraft.color = e.target.value;
  document.getElementById('fontColorLabel').textContent = e.target.value;
  applyFontDraftToPreview();
});

function syncFontSettingsUI() {
  // Type toggle
  document.querySelectorAll('.toggle-pill').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.type === fontDraft.type);
  });
  document.getElementById('googleFontPanel').style.display = fontDraft.type === 'google' ? '' : 'none';
  document.getElementById('customFontPanel').style.display = fontDraft.type === 'custom' ? '' : 'none';

  // Size / color
  document.getElementById('fontSizeSlider').value = fontDraft.fontSize;
  document.getElementById('fontSizeLabel').textContent = `${fontDraft.fontSize}px`;
  document.getElementById('fontColorPicker').value = fontDraft.color;
  document.getElementById('fontColorLabel').textContent = fontDraft.color;

  renderGoogleFontList(document.getElementById('fontSearch').value);
}

function applyFontDraftToPreview() {
  const preview = document.getElementById('fontPreviewText');
  const previewBox = document.getElementById('fontPreview');
  previewBox.style.background = fontDraft.color === '#ffffff' || fontDraft.color === '#fff' ? '#222' : '#000';
  preview.style.fontSize = `${Math.min(fontDraft.fontSize, 80)}px`; // cap preview size
  preview.style.color = fontDraft.color;

  if (fontDraft.type === 'google') {
    loadGoogleFont(fontDraft.googleFontName);
    preview.style.fontFamily = `'${fontDraft.googleFontName}', sans-serif`;
  } else if (fontDraft.type === 'custom' && fontDraft.customFontUrl) {
    loadCustomFontPreview(fontDraft.customFontUrl);
    preview.style.fontFamily = "'CustomPreviewFont', sans-serif";
  }
}

function loadGoogleFont(name) {
  const id = `gfont-${name.replace(/\s+/g, '-')}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}&display=swap`;
  document.head.appendChild(link);
}

function loadCustomFontPreview(url) {
  let style = document.getElementById('custom-preview-font');
  if (!style) { style = document.createElement('style'); style.id = 'custom-preview-font'; document.head.appendChild(style); }
  style.textContent = `@font-face { font-family: 'CustomPreviewFont'; src: url('${url}'); }`;
}

// Apply font to child
document.getElementById('btnApplyFont').addEventListener('click', async () => {
  try {
    const res = await fetch('/settings/font', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fontDraft),
    });
    if (!res.ok) throw new Error(await res.text());
    const btn = document.getElementById('btnApplyFont');
    btn.textContent = '✓ 適用しました';
    setTimeout(() => { btn.textContent = '子側に適用する'; }, 2000);
  } catch (err) {
    alert(`適用に失敗しました: ${err.message}`);
  }
});

// ── Custom font upload ────────────────────────────────────────────────────────
document.getElementById('fontFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await uploadFontFile(file);
  e.target.value = '';
});

document.getElementById('fontUploadArea').addEventListener('dragover', (e) => {
  e.preventDefault(); document.getElementById('fontUploadArea').classList.add('is-drag-over');
});
document.getElementById('fontUploadArea').addEventListener('dragleave', () => {
  document.getElementById('fontUploadArea').classList.remove('is-drag-over');
});
document.getElementById('fontUploadArea').addEventListener('drop', async (e) => {
  e.preventDefault(); document.getElementById('fontUploadArea').classList.remove('is-drag-over');
  const file = e.dataTransfer.files[0];
  if (file) await uploadFontFile(file);
});

async function uploadFontFile(file) {
  document.getElementById('fontProgressWrap').style.display = 'flex';
  setProgress('fontProgressWrap', 'fontProgressFill', 'fontProgressLabel', 0, file.name);
  const fd = new FormData(); fd.append('font', file);
  try {
    const res = await fetch('/upload/font', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(await res.text());
    setProgress('fontProgressWrap', 'fontProgressFill', 'fontProgressLabel', 100, `完了: ${file.name}`);
    setTimeout(() => { document.getElementById('fontProgressWrap').style.display = 'none'; }, 1500);
    await loadCustomFontList();
  } catch (err) {
    setProgress('fontProgressWrap', 'fontProgressFill', 'fontProgressLabel', 0, `エラー: ${err.message}`);
    setTimeout(() => { document.getElementById('fontProgressWrap').style.display = 'none'; }, 3000);
  }
}

async function loadCustomFontList() {
  try {
    const fonts = await fetch('/fonts').then((r) => r.json());
    const ul = document.getElementById('customFontList');
    document.getElementById('customFontEmpty').style.display = fonts.length ? 'none' : '';

    ul.querySelectorAll('.font-item').forEach((el) => el.remove());

    fonts.forEach((font) => {
      const li = document.createElement('li');
      li.className = `font-item${fontDraft.customFontUrl === font.url && fontDraft.type === 'custom' ? ' is-selected' : ''}`;
      li.innerHTML = `<span>${escHtml(font.name)}</span>`;
      li.addEventListener('click', () => {
        fontDraft.customFontUrl = font.url;
        fontDraft.type = 'custom';
        ul.querySelectorAll('.font-item').forEach((i) => i.classList.remove('is-selected'));
        li.classList.add('is-selected');
        applyFontDraftToPreview();
      });
      ul.appendChild(li);
    });
  } catch (err) { console.error('Failed to load fonts:', err); }
}

// ── Utility ───────────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
renderGoogleFontList();
loadCustomFontList();
