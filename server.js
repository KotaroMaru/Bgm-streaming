require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');

// ── Cloudinary ───────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Express / Socket.io ──────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ────────────────────────────────────────────────────────────────────
/** @type {{ id: string, name: string, cloudinaryUrl: string, cloudinaryPublicId: string }[]} */
let library = [];

/** @type {{ id: string, name: string, trackIds: string[] }[]} */
let playlists = [];

/** @type {string|null} */
let activePlaylistId = null;

let playState = {
  currentIndex: -1,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  shuffle: false,
  loop: 'none', // 'none' | 'one' | 'all'
};

let fontSettings = {
  type: 'google',          // 'google' | 'custom'
  googleFontName: 'Noto Sans JP',
  customFontUrl: null,
  fontSize: 64,
  color: '#ffffff',
};

const childSockets = new Set();

// ── Helpers ──────────────────────────────────────────────────────────────────
function getActivePlaylist() {
  return playlists.find((p) => p.id === activePlaylistId) || null;
}

function getActiveTracks() {
  const pl = getActivePlaylist();
  if (!pl) return [];
  return pl.trackIds.map((id) => library.find((t) => t.id === id)).filter(Boolean);
}

function nameFromPublicId(publicId) {
  return publicId.split('/').pop();
}

function uploadStreamAsync(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

// ── Cloudinary persistence for playlists ─────────────────────────────────────
const PLAYLISTS_CDN_ID = 'bgm_metadata/playlists';

async function savePlaylistsToCdn() {
  try {
    const data = JSON.stringify({ playlists, activePlaylistId });
    await uploadStreamAsync(Buffer.from(data), {
      resource_type: 'raw',
      public_id: PLAYLISTS_CDN_ID,
      overwrite: true,
    });
  } catch (err) {
    console.error('Failed to save playlists to Cloudinary:', err.message);
  }
}

async function loadPlaylistsFromCdn() {
  try {
    const resource = await cloudinary.api.resource(PLAYLISTS_CDN_ID, { resource_type: 'raw' });
    const res = await fetch(`${resource.secure_url}?_t=${Date.now()}`);
    const data = await res.json();
    playlists = data.playlists || [];
    activePlaylistId = data.activePlaylistId || null;
    console.log(`✓ Loaded ${playlists.length} playlist(s) from Cloudinary`);
  } catch (err) {
    if (err.http_code === 404 || err?.error?.http_code === 404) {
      console.log('No playlists data found, starting fresh');
    } else {
      console.error('Failed to load playlists:', err.message || err);
    }
    playlists = [];
    activePlaylistId = null;
  }
}

// ── Load library from Cloudinary on startup ───────────────────────────────────
async function loadLibraryFromCloudinary() {
  try {
    let resources = [];
    let nextCursor = null;
    do {
      const opts = {
        resource_type: 'video',
        type: 'upload',
        prefix: 'bgm/',
        max_results: 500,
        context: true,
        ...(nextCursor ? { next_cursor: nextCursor } : {}),
      };
      const result = await cloudinary.api.resources(opts);
      resources = resources.concat(result.resources || []);
      nextCursor = result.next_cursor || null;
    } while (nextCursor);

    library = resources.map((r) => ({
      id: r.public_id,
      name: r.context?.custom?.caption || nameFromPublicId(r.public_id),
      cloudinaryUrl: r.secure_url,
      cloudinaryPublicId: r.public_id,
    }));
    console.log(`✓ Loaded ${library.length} track(s) from Cloudinary`);
  } catch (err) {
    console.error('Failed to load library:', err.message);
  }
}

// ── Multer instances ──────────────────────────────────────────────────────────
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('音声ファイルのみアップロード可能です'), false);
  },
});

const fontUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) cb(null, true);
    else cb(new Error('フォントファイル (.ttf/.otf/.woff/.woff2) のみ対応しています'), false);
  },
});

// ── Socket.io broadcast helpers ───────────────────────────────────────────────
function emitLibraryUpdated(target = io) {
  target.emit('library_updated', library);
}

function emitPlaylistsUpdated(target = io) {
  target.emit('playlists_updated', { playlists, activePlaylistId });
}

function emitActiveTracksUpdated(target = io) {
  target.emit('active_tracks_updated', getActiveTracks());
}

function emitStateUpdated(target = io) {
  target.emit('state_updated', playState);
}

// ── REST API: Keep-Alive ──────────────────────────────────────────────────────
app.get('/ping', (_req, res) => res.json({ status: 'ok' }));

// ── REST API: Library ─────────────────────────────────────────────────────────
app.get('/library', (_req, res) => res.json(library));

app.post('/upload', audioUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

  let displayName;
  try {
    displayName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  } catch {
    displayName = req.file.originalname;
  }
  displayName = displayName.replace(/\.[^/.]+$/, '');

  try {
    const result = await uploadStreamAsync(req.file.buffer, {
      resource_type: 'video',
      folder: 'bgm',
      context: `caption=${displayName}`,
    });

    const track = {
      id: result.public_id,
      name: displayName,
      cloudinaryUrl: result.secure_url,
      cloudinaryPublicId: result.public_id,
    };
    library.push(track);
    emitLibraryUpdated();
    res.json(track);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'アップロードに失敗しました' });
  }
});

app.delete('/library', async (req, res) => {
  const trackId = req.query.id;
  if (!trackId) return res.status(400).json({ error: 'id が必要です' });

  const track = library.find((t) => t.id === trackId);
  if (!track) return res.status(404).json({ error: '曲が見つかりません' });

  try {
    await cloudinary.uploader.destroy(track.cloudinaryPublicId, { resource_type: 'video' });
  } catch (err) {
    console.error('Cloudinary destroy error:', err.message);
  }

  library = library.filter((t) => t.id !== trackId);

  // Remove from all playlists
  playlists.forEach((pl) => {
    pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
  });

  // Adjust playState if active tracks changed
  const activeTracks = getActiveTracks();
  if (playState.currentIndex >= activeTracks.length) {
    playState.currentIndex = activeTracks.length - 1;
    playState.isPlaying = false;
  }

  savePlaylistsToCdn();
  emitLibraryUpdated();
  emitPlaylistsUpdated();
  emitActiveTracksUpdated();
  emitStateUpdated();
  res.json({ success: true });
});

// ── REST API: Playlists ───────────────────────────────────────────────────────
app.get('/playlists', (_req, res) => res.json({ playlists, activePlaylistId }));

// IMPORTANT: Define /playlists/active BEFORE /playlists/:id routes
app.put('/playlists/active', (req, res) => {
  const { id } = req.body;
  if (id !== null && !playlists.find((p) => p.id === id)) {
    return res.status(404).json({ error: 'プレイリストが見つかりません' });
  }
  activePlaylistId = id || null;
  playState.currentIndex = -1;
  playState.isPlaying = false;

  savePlaylistsToCdn();
  emitPlaylistsUpdated();
  emitActiveTracksUpdated();
  emitStateUpdated();
  io.to('child').emit('pause');
  res.json({ activePlaylistId });
});

app.post('/playlists', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '名前が必要です' });

  const pl = { id: crypto.randomUUID(), name: name.trim(), trackIds: [] };
  playlists.push(pl);

  // Auto-activate if first playlist
  if (!activePlaylistId) activePlaylistId = pl.id;

  savePlaylistsToCdn();
  emitPlaylistsUpdated();
  emitActiveTracksUpdated();
  res.json(pl);
});

app.delete('/playlists/:id', (req, res) => {
  const idx = playlists.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'プレイリストが見つかりません' });

  playlists.splice(idx, 1);

  if (activePlaylistId === req.params.id) {
    activePlaylistId = playlists.length > 0 ? playlists[0].id : null;
    playState.currentIndex = -1;
    playState.isPlaying = false;
    io.to('child').emit('pause');
  }

  savePlaylistsToCdn();
  emitPlaylistsUpdated();
  emitActiveTracksUpdated();
  emitStateUpdated();
  res.json({ success: true });
});

app.post('/playlists/:id/tracks', (req, res) => {
  const pl = playlists.find((p) => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'プレイリストが見つかりません' });

  const { trackId } = req.body;
  if (!library.find((t) => t.id === trackId)) {
    return res.status(404).json({ error: '曲が見つかりません' });
  }
  if (pl.trackIds.includes(trackId)) {
    return res.status(409).json({ error: 'すでに追加されています' });
  }

  pl.trackIds.push(trackId);
  savePlaylistsToCdn();
  emitPlaylistsUpdated();
  if (pl.id === activePlaylistId) emitActiveTracksUpdated();
  res.json(pl);
});

app.delete('/playlists/:id/tracks', (req, res) => {
  const pl = playlists.find((p) => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'プレイリストが見つかりません' });

  const trackId = req.query.trackId;
  if (!trackId) return res.status(400).json({ error: 'trackId が必要です' });

  const before = pl.trackIds.length;
  pl.trackIds = pl.trackIds.filter((id) => id !== trackId);

  savePlaylistsToCdn();
  emitPlaylistsUpdated();
  if (pl.id === activePlaylistId) emitActiveTracksUpdated();
  res.json({ removed: before - pl.trackIds.length });
});

app.put('/playlists/:id/reorder', (req, res) => {
  const pl = playlists.find((p) => p.id === req.params.id);
  if (!pl) return res.status(404).json({ error: 'プレイリストが見つかりません' });

  const { trackIds } = req.body;
  if (!Array.isArray(trackIds)) return res.status(400).json({ error: 'trackIds が必要です' });

  // Only keep IDs that exist in the playlist
  pl.trackIds = trackIds.filter((id) => pl.trackIds.includes(id));

  // Re-add any that were in playlist but missing from new order (safety)
  const missing = pl.trackIds.filter((id) => !trackIds.includes(id));
  pl.trackIds = [...pl.trackIds, ...missing];

  const currentTrack = getActiveTracks()[playState.currentIndex];

  savePlaylistsToCdn();
  emitPlaylistsUpdated();
  if (pl.id === activePlaylistId) {
    emitActiveTracksUpdated();
    // Re-sync currentIndex
    if (currentTrack) {
      const newTracks = getActiveTracks();
      playState.currentIndex = newTracks.findIndex((t) => t.id === currentTrack.id);
    }
    emitStateUpdated();
  }
  res.json(pl);
});

// ── REST API: Font settings ───────────────────────────────────────────────────
app.get('/settings/font', (_req, res) => res.json(fontSettings));

app.put('/settings/font', (req, res) => {
  const allowed = ['type', 'googleFontName', 'customFontUrl', 'fontSize', 'color'];
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) fontSettings[k] = req.body[k];
  });
  io.emit('font_updated', fontSettings);
  res.json(fontSettings);
});

// Upload custom font to Cloudinary
app.post('/upload/font', fontUpload.single('font'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const baseName = path.basename(req.file.originalname, ext);
  const publicId = `bgm_fonts/${Date.now()}_${baseName}`;

  try {
    const result = await uploadStreamAsync(req.file.buffer, {
      resource_type: 'raw',
      public_id: publicId,
      overwrite: false,
    });
    res.json({ id: result.public_id, name: req.file.originalname, url: result.secure_url });
  } catch (err) {
    console.error('Font upload error:', err);
    res.status(500).json({ error: 'フォントのアップロードに失敗しました' });
  }
});

// Get uploaded custom fonts
app.get('/fonts', async (_req, res) => {
  try {
    const result = await cloudinary.api.resources({
      resource_type: 'raw',
      type: 'upload',
      prefix: 'bgm_fonts/',
      max_results: 100,
    });
    const fonts = (result.resources || []).map((r) => ({
      id: r.public_id,
      name: nameFromPublicId(r.public_id).replace(/^\d+_/, ''),
      url: r.secure_url,
    }));
    res.json(fonts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on('register', (role) => {
    if (role === 'child') {
      childSockets.add(socket.id);
      socket.join('child');
      socket.emit('sync', {
        activeTracks: getActiveTracks(),
        playState,
        fontSettings,
      });
      io.to('parent').emit('child_status', { count: childSockets.size });
    } else if (role === 'parent') {
      socket.join('parent');
      socket.emit('sync_parent', {
        library,
        playlists,
        activePlaylistId,
        activeTracks: getActiveTracks(),
        playState,
        fontSettings,
      });
      socket.emit('child_status', { count: childSockets.size });
    }
  });

  socket.on('disconnect', () => {
    if (childSockets.has(socket.id)) {
      childSockets.delete(socket.id);
      io.to('parent').emit('child_status', { count: childSockets.size });
    }
    console.log(`Socket disconnected: ${socket.id}`);
  });

  // ── Playback (parent → server → child) ────────────────────────────────────
  socket.on('play', (data = {}) => {
    if (data.index !== undefined) playState.currentIndex = data.index;
    if (data.currentTime !== undefined) playState.currentTime = data.currentTime;
    playState.isPlaying = true;
    io.to('child').emit('play', {
      index: playState.currentIndex,
      currentTime: playState.currentTime,
    });
    emitStateUpdated(io.to('parent'));
  });

  socket.on('pause', (data = {}) => {
    playState.isPlaying = false;
    if (data.currentTime !== undefined) playState.currentTime = data.currentTime;
    io.to('child').emit('pause');
    emitStateUpdated(io.to('parent'));
  });

  socket.on('next', () => {
    const tracks = getActiveTracks();
    if (tracks.length === 0) return;
    playState.currentIndex = playState.shuffle
      ? Math.floor(Math.random() * tracks.length)
      : (playState.currentIndex + 1) % tracks.length;
    playState.isPlaying = true;
    playState.currentTime = 0;
    io.to('child').emit('play', { index: playState.currentIndex, currentTime: 0 });
    emitStateUpdated(io.to('parent'));
  });

  socket.on('prev', () => {
    const tracks = getActiveTracks();
    if (tracks.length === 0) return;
    playState.currentIndex = playState.shuffle
      ? Math.floor(Math.random() * tracks.length)
      : (playState.currentIndex - 1 + tracks.length) % tracks.length;
    playState.isPlaying = true;
    playState.currentTime = 0;
    io.to('child').emit('play', { index: playState.currentIndex, currentTime: 0 });
    emitStateUpdated(io.to('parent'));
  });

  socket.on('seek', (data = {}) => {
    playState.currentTime = data.time ?? 0;
    io.to('child').emit('seek', { time: playState.currentTime });
    emitStateUpdated(io.to('parent'));
  });

  socket.on('volume', (data = {}) => {
    playState.volume = data.volume ?? 1;
    io.to('child').emit('volume', { volume: playState.volume });
    emitStateUpdated(io.to('parent'));
  });

  socket.on('shuffle', (data = {}) => {
    playState.shuffle = !!data.shuffle;
    emitStateUpdated();
  });

  socket.on('loop', (data = {}) => {
    playState.loop = data.loop ?? 'none';
    io.to('child').emit('loop_mode', { loop: playState.loop });
    emitStateUpdated(io.to('parent'));
  });

  // ── Child → Server ────────────────────────────────────────────────────────
  socket.on('time_update', (data = {}) => {
    playState.currentTime = data.currentTime ?? playState.currentTime;
    if (data.duration) playState.duration = data.duration;
    io.to('parent').emit('time_update', {
      currentTime: playState.currentTime,
      duration: playState.duration,
    });
  });

  socket.on('track_ended', () => {
    // NOTE: 'one' loop is handled by audio.loop=true on child side, so this
    // event is only emitted for 'none' and 'all' modes.
    const tracks = getActiveTracks();
    if (tracks.length === 0) return;

    const nextIndex = playState.shuffle
      ? Math.floor(Math.random() * tracks.length)
      : playState.currentIndex + 1;

    if (nextIndex >= tracks.length) {
      if (playState.loop === 'all') {
        playState.currentIndex = 0;
      } else {
        playState.isPlaying = false;
        emitStateUpdated();
        return;
      }
    } else {
      playState.currentIndex = nextIndex;
    }

    playState.isPlaying = true;
    playState.currentTime = 0;
    io.to('child').emit('play', { index: playState.currentIndex, currentTime: 0 });
    emitStateUpdated(io.to('parent'));
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`BGM server running on http://localhost:${PORT}`);
  await loadLibraryFromCloudinary();
  await loadPlaylistsFromCdn();
});
