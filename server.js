require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const path = require('path');

// ── Cloudinary config ────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ── Express / Socket.io setup ────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory state ──────────────────────────────────────────────────────────
/** @type {{ id: string, name: string, url: string }[]} */
let playlist = [];

/** Server-authoritative playback state */
let playState = {
  currentIndex: -1,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  shuffle: false,
  loop: 'none', // 'none' | 'all' | 'one'
};

const childSockets = new Set();
const parentSockets = new Set();

// ── Multer (memory storage, 50 MB limit) ─────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('音声ファイルのみアップロード可能です'), false);
  },
});

// ── Cloudinary helpers ───────────────────────────────────────────────────────
function nameFromPublicId(publicId) {
  const parts = publicId.split('/');
  return parts[parts.length - 1];
}

/**
 * Upload a buffer to Cloudinary and return the result.
 * @param {Buffer} buffer
 * @param {string} displayName
 * @param {number} order
 */
function uploadToCloudinary(buffer, displayName, order) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'video',
        folder: 'bgm',
        context: `caption=${displayName}|order=${order}`,
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      }
    );
    stream.end(buffer);
  });
}

/** Load playlist from Cloudinary on server start */
async function loadPlaylistFromCloudinary() {
  try {
    let resources = [];
    let nextCursor = null;

    // Paginate through all resources
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

    playlist = resources
      .map((r) => ({
        id: r.public_id,
        name: r.context?.custom?.caption || nameFromPublicId(r.public_id),
        url: r.secure_url,
        order: parseInt(r.context?.custom?.order ?? '0', 10),
      }))
      .sort((a, b) => a.order - b.order);

    console.log(`✓ Loaded ${playlist.length} track(s) from Cloudinary`);
  } catch (err) {
    console.error('Failed to load playlist from Cloudinary:', err.message);
  }
}

/** Persist reorder to Cloudinary in the background (best-effort) */
async function persistOrderToCloudinary() {
  for (let i = 0; i < playlist.length; i++) {
    try {
      await cloudinary.uploader.explicit(playlist[i].id, {
        resource_type: 'video',
        type: 'upload',
        context: `caption=${playlist[i].name}|order=${i}`,
      });
    } catch (_) {
      // ignore individual failures
    }
  }
}

// ── REST API ──────────────────────────────────────────────────────────────────

// Keep-alive for Render free tier
app.get('/ping', (_req, res) => res.json({ status: 'ok' }));

// Get playlist
app.get('/playlist', (_req, res) => res.json(playlist));

// Upload track
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

  // Fix garbled filename (latin1 → utf8)
  const rawName = req.file.originalname;
  let displayName;
  try {
    displayName = Buffer.from(rawName, 'latin1').toString('utf8');
  } catch {
    displayName = rawName;
  }
  displayName = displayName.replace(/\.[^/.]+$/, ''); // strip extension

  try {
    const result = await uploadToCloudinary(req.file.buffer, displayName, playlist.length);
    const track = { id: result.public_id, name: displayName, url: result.secure_url };
    playlist.push(track);
    io.emit('playlist_updated', playlist);
    res.json(track);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'アップロードに失敗しました' });
  }
});

// Delete track
app.delete('/track', async (req, res) => {
  const publicId = req.query.id;
  if (!publicId) return res.status(400).json({ error: 'id が必要です' });

  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
  } catch (err) {
    console.error('Cloudinary destroy error:', err.message);
    // continue – remove from playlist anyway
  }

  const idx = playlist.findIndex((t) => t.id === publicId);
  if (idx !== -1) {
    playlist.splice(idx, 1);
    // Adjust currentIndex
    if (playState.currentIndex > idx) {
      playState.currentIndex--;
    } else if (playState.currentIndex === idx) {
      playState.currentIndex = playlist.length > 0 ? Math.min(idx, playlist.length - 1) : -1;
      playState.isPlaying = false;
    }
  }

  io.emit('playlist_updated', playlist);
  io.emit('state_updated', playState);
  res.json({ success: true });
});

// Reorder playlist
app.put('/playlist/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order が必要です' });

  const currentTrack = playlist[playState.currentIndex] ?? null;
  const newPlaylist = order.map((id) => playlist.find((t) => t.id === id)).filter(Boolean);

  if (newPlaylist.length !== playlist.length) {
    return res.status(400).json({ error: '順番の要素数が一致しません' });
  }

  playlist = newPlaylist;

  if (currentTrack) {
    playState.currentIndex = playlist.findIndex((t) => t.id === currentTrack.id);
  }

  // Persist order to Cloudinary asynchronously
  persistOrderToCloudinary().catch(() => {});

  io.emit('playlist_updated', playlist);
  io.emit('state_updated', playState);
  res.json({ success: true });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // ── Register role ────────────────────────────────────────────────────────
  socket.on('register', (role) => {
    if (role === 'child') {
      childSockets.add(socket.id);
      socket.join('child');
      // Sync current state to newly joined child
      socket.emit('sync', { playlist, playState });
      // Notify all parents
      io.to('parent').emit('child_status', { count: childSockets.size });
    } else if (role === 'parent') {
      parentSockets.add(socket.id);
      socket.join('parent');
      socket.emit('playlist_updated', playlist);
      socket.emit('state_updated', playState);
      socket.emit('child_status', { count: childSockets.size });
    }
  });

  socket.on('disconnect', () => {
    if (childSockets.has(socket.id)) {
      childSockets.delete(socket.id);
      io.to('parent').emit('child_status', { count: childSockets.size });
    }
    parentSockets.delete(socket.id);
    console.log(`Socket disconnected: ${socket.id}`);
  });

  // ── Playback controls (parent → server → child) ──────────────────────────
  socket.on('play', (data = {}) => {
    if (data.index !== undefined) playState.currentIndex = data.index;
    if (data.currentTime !== undefined) playState.currentTime = data.currentTime;
    playState.isPlaying = true;
    io.to('child').emit('play', {
      index: playState.currentIndex,
      currentTime: playState.currentTime,
    });
    io.to('parent').emit('state_updated', playState);
  });

  socket.on('pause', (data = {}) => {
    playState.isPlaying = false;
    if (data.currentTime !== undefined) playState.currentTime = data.currentTime;
    io.to('child').emit('pause');
    io.to('parent').emit('state_updated', playState);
  });

  socket.on('next', () => {
    if (playlist.length === 0) return;
    playState.currentIndex = playState.shuffle
      ? Math.floor(Math.random() * playlist.length)
      : (playState.currentIndex + 1) % playlist.length;
    playState.isPlaying = true;
    playState.currentTime = 0;
    io.to('child').emit('play', { index: playState.currentIndex, currentTime: 0 });
    io.to('parent').emit('state_updated', playState);
  });

  socket.on('prev', () => {
    if (playlist.length === 0) return;
    playState.currentIndex = playState.shuffle
      ? Math.floor(Math.random() * playlist.length)
      : (playState.currentIndex - 1 + playlist.length) % playlist.length;
    playState.isPlaying = true;
    playState.currentTime = 0;
    io.to('child').emit('play', { index: playState.currentIndex, currentTime: 0 });
    io.to('parent').emit('state_updated', playState);
  });

  socket.on('seek', (data = {}) => {
    playState.currentTime = data.time ?? 0;
    io.to('child').emit('seek', { time: playState.currentTime });
    io.to('parent').emit('state_updated', playState);
  });

  socket.on('volume', (data = {}) => {
    playState.volume = data.volume ?? 1;
    io.to('child').emit('volume', { volume: playState.volume });
    io.to('parent').emit('state_updated', playState);
  });

  socket.on('shuffle', (data = {}) => {
    playState.shuffle = !!data.shuffle;
    io.to('parent').emit('state_updated', playState);
  });

  socket.on('loop', (data = {}) => {
    playState.loop = data.loop ?? 'none';
    io.to('parent').emit('state_updated', playState);
    io.to('child').emit('loop_mode', { loop: playState.loop });
  });

  // ── Child → Server callbacks ──────────────────────────────────────────────
  // Child reports time & duration (throttled by client to ~1/sec)
  socket.on('time_update', (data = {}) => {
    playState.currentTime = data.currentTime ?? playState.currentTime;
    if (data.duration) playState.duration = data.duration;
    // Broadcast lightweight time update to parents only
    io.to('parent').emit('time_update', {
      currentTime: playState.currentTime,
      duration: playState.duration,
    });
  });

  // Child reports track ended
  socket.on('track_ended', () => {
    if (playlist.length === 0) return;

    if (playState.loop === 'one') {
      playState.currentTime = 0;
      io.to('child').emit('play', { index: playState.currentIndex, currentTime: 0 });
      io.to('parent').emit('state_updated', playState);
      return;
    }

    const nextIndex = playState.shuffle
      ? Math.floor(Math.random() * playlist.length)
      : playState.currentIndex + 1;

    if (nextIndex >= playlist.length) {
      if (playState.loop === 'all') {
        playState.currentIndex = 0;
      } else {
        // End of playlist, no loop
        playState.isPlaying = false;
        io.to('parent').emit('state_updated', playState);
        return;
      }
    } else {
      playState.currentIndex = nextIndex;
    }

    playState.isPlaying = true;
    playState.currentTime = 0;
    io.to('child').emit('play', { index: playState.currentIndex, currentTime: 0 });
    io.to('parent').emit('state_updated', playState);
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`BGM server running on http://localhost:${PORT}`);
  await loadPlaylistFromCloudinary();
});
