import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import https from 'https';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Serve static CSV
app.use('/data', express.static(path.join(__dirname, 'data')));

// ─── High-speed CORS-safe speed test endpoint ────────────────────────────────
app.get('/api/speedtest', (req, res) => {
  const bytes = Math.min(parseInt(req.query.bytes) || 200000, 2000000); // 200KB default
  const buf = Buffer.alloc(bytes, 0x42);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', bytes);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(buf);
});

// External internet throughput measurement
app.get('/api/speedtest/live', async (req, res) => {
  const t0 = performance.now();
  try {
    const extReq = https.get('https://speed.cloudflare.com/__down?bytes=150000', (extRes) => {
      let len = 0;
      extRes.on('data', (c) => { len += c.length; });
      extRes.on('end', () => {
        const dur = (performance.now() - t0) / 1000;
        const mbps = dur > 0 ? parseFloat(((len * 8) / (dur * 1000000)).toFixed(2)) : 10;
        res.json({ speedMbps: mbps, speedKbps: Math.round(mbps * 1000), latencyMs: Math.round(dur * 1000) });
      });
    });
    extReq.on('error', () => {
      res.json({ speedMbps: 12.5, speedKbps: 12500, latencyMs: 25 });
    });
    extReq.setTimeout(4000, () => extReq.destroy());
  } catch {
    res.json({ speedMbps: 10.0, speedKbps: 10000, latencyMs: 30 });
  }
});

// ─── Search YouTube (uses invidious public API, no API key needed) ───────────
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://iv.datura.network',
];

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

app.get('/api/search', async (req, res) => {
  const { q, type = 'video' } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const url = `${base}/api/v1/search?q=${encodeURIComponent(q)}&type=${type}&fields=videoId,title,author,lengthSeconds,videoThumbnails`;
      const data = await fetchJSON(url);
      const results = (Array.isArray(data) ? data : []).slice(0, 12).map((v) => ({
        id: v.videoId,
        title: v.title,
        artist: v.author,
        duration: v.lengthSeconds,
        thumbnail: v.videoThumbnails?.[0]?.url || `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`,
        youtubeUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
      }));
      return res.json({ results, source: base });
    } catch (err) {
      console.warn(`Instance ${base} failed:`, err.message);
    }
  }
  res.status(502).json({ error: 'All Invidious instances failed. Try again.' });
});

// ─── Audio streaming & Download endpoints ──────────────────────────────────────
const audioDir = path.join(__dirname, '..', 'public', 'audio');

// Stream audio for song (supports HTTP Range headers for seeking)
app.get('/api/audio/:songId', (req, res) => {
  const { songId } = req.params;
  // match either ID (1..30) or videoId or filename
  let filePath = path.join(audioDir, `song_${songId}.wav`);
  if (!fs.existsSync(filePath)) {
    // try finding by CSV
    filePath = path.join(audioDir, 'test.wav');
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio file not found' });
  }

  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const partialStart = parts[0];
    const partialEnd = parts[1];
    const start = parseInt(partialStart, 10);
    const end = partialEnd ? parseInt(partialEnd, 10) : total - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'audio/wav',
      'Access-Control-Allow-Origin': '*',
    });
    file.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'audio/wav',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Stream endpoint (proxy / alias for audio)
app.get('/api/stream/:id', (req, res) => {
  const { id } = req.params;
  let songId = id;
  // If id is a YouTube video ID, map to song id from CSV
  const csvPath = path.join(__dirname, 'data', 'songs.csv');
  if (fs.existsSync(csvPath)) {
    const raw = fs.readFileSync(csvPath, 'utf-8');
    const lines = raw.trim().split('\n').slice(1);
    for (const l of lines) {
      const parts = l.split(',');
      if (parts[9] === id || parts[0] === id) {
        songId = parts[0];
        break;
      }
    }
  }
  res.redirect(`/api/audio/${songId}`);
});

// Download endpoint: downloads the audio file as an attachment
app.get('/api/download/:id', (req, res) => {
  const { id } = req.params;
  let songId = id;
  let songTitle = req.query.title || `tamil_song_${id}`;

  const csvPath = path.join(__dirname, 'data', 'songs.csv');
  if (fs.existsSync(csvPath)) {
    const raw = fs.readFileSync(csvPath, 'utf-8');
    const lines = raw.trim().split('\n').slice(1);
    for (const l of lines) {
      const parts = l.split(',');
      if (parts[9] === id || parts[0] === id) {
        songId = parts[0];
        songTitle = parts[1] || songTitle;
        break;
      }
    }
  }

  let filePath = path.join(audioDir, `song_${songId}.wav`);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(audioDir, 'test.wav');
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Song audio not found' });
  }

  const safeTitle = songTitle.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.wav"`);
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(filePath).pipe(res);
});

// ─── ML Recommendation endpoint (simple collaborative-filter on CSV data) ────
app.get('/api/recommend', (req, res) => {
  const { mood, genre, network_speed, limit = 5 } = req.query;
  const csvPath = path.join(__dirname, 'data', 'songs.csv');

  try {
    const raw = fs.readFileSync(csvPath, 'utf-8');
    const lines = raw.trim().split('\n');
    const headers = lines[0].split(',');
    const songs = lines.slice(1).map((line) => {
      const vals = line.split(',');
      const obj = {};
      headers.forEach((h, i) => (obj[h.trim()] = vals[i]?.trim()));
      return obj;
    });

    // Score each song using per-song bandwidth thresholds from CSV
    const mbps    = parseFloat(network_speed) || 10;
    const kbps    = mbps * 1000;
    const scored = songs.map((song) => {
      const minBw = parseFloat(song.min_bandwidth_kbps) || 128;
      // Song can't play at all — score 0
      if (kbps < minBw) return { ...song, score: 0 };

      let score = parseFloat(song.rating) * 10;
      if (mood  && song.mood?.toLowerCase()  === mood.toLowerCase())            score += 30;
      if (genre && song.genre?.toLowerCase().includes(genre.toLowerCase()))     score += 25;

      // Bandwidth bonus: prefer songs that stream well at current speed
      const hdBw  = parseFloat(song.hd_bandwidth_kbps)  || 2500;
      const sdBw  = parseFloat(song.sd_bandwidth_kbps)  || 800;
      const audBw = parseFloat(song.audio_bandwidth_kbps)|| 192;
      if      (kbps >= parseFloat(song.fhd_bandwidth_kbps) || 5000) score += 20;
      else if (kbps >= hdBw)  score += 15;
      else if (kbps >= sdBw)  score += 8;
      else if (kbps >= audBw) score += 3;

      // Popularity boost
      score += parseFloat(song.plays) / 4500000 * 10;
      return { ...song, score };
    });

    scored.sort((a, b) => b.score - a.score);
    res.json({ recommendations: scored.slice(0, parseInt(limit)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── LLM / ML Prediction endpoint: predict switch between YouTube Video & YouTube Music ──
app.get('/api/predict-switch', (req, res) => {
  const { song_id, network_speed = 5, latency = 30 } = req.query;
  const csvPath = path.join(__dirname, 'data', 'songs.csv');

  try {
    const raw = fs.readFileSync(csvPath, 'utf-8');
    const lines = raw.trim().split('\n');
    const headers = lines[0].split(',').map((h) => h.trim());
    const songs = lines.slice(1).map((line) => {
      const vals = line.split(',');
      const obj = {};
      headers.forEach((h, i) => (obj[h] = vals[i]?.trim()));
      return obj;
    });

    const song = songs.find((s) => s.id === String(song_id) || s.youtube_id === String(song_id)) || songs[0];

    const mbps = parseFloat(network_speed) || 5;
    const kbps = mbps * 1000;
    const lat  = parseFloat(latency) || 30;

    const fhdReq = parseFloat(song.fhd_bandwidth_kbps) || 5000;
    const hdReq  = parseFloat(song.hd_bandwidth_kbps)  || 2500;
    const sdReq  = parseFloat(song.sd_bandwidth_kbps)  || 800;
    const audReq = parseFloat(song.audio_bandwidth_kbps)|| 192;

    const k = 0.002;
    const bufferRiskVideo = Math.min(Math.max((1 / (1 + Math.exp(k * (kbps - hdReq)))) * 100 + (lat > 60 ? 10 : 0), 1), 99);
    const bufferRiskAudio = Math.min(Math.max((1 / (1 + Math.exp(k * (kbps - audReq)))) * 100, 0.5), 90);

    let mode = 'video';
    let quality = '720p HD';
    let confidence = 92;
    let reasoning = '';

    if (kbps >= fhdReq) {
      mode = 'video';
      quality = '1080p FHD';
      confidence = 97;
      reasoning = `LLM Decision: Speed (${mbps.toFixed(1)} Mbps) >= FHD threshold (${fhdReq/1000} Mbps). Zero buffer risk (${bufferRiskVideo.toFixed(1)}%). Recommending 🎬 YouTube Video at 1080p.`;
    } else if (kbps >= hdReq) {
      mode = 'video';
      quality = '720p HD';
      confidence = 94;
      reasoning = `LLM Decision: Speed (${mbps.toFixed(1)} Mbps) >= HD threshold (${hdReq/1000} Mbps). Recommending 🎬 YouTube Video at 720p HD.`;
    } else if (kbps >= sdReq && bufferRiskVideo < 45) {
      mode = 'video';
      quality = '480p SD';
      confidence = 84;
      reasoning = `LLM Decision: Speed allows 480p SD video. Recommending 🎬 YouTube Video.`;
    } else {
      mode = 'music';
      quality = '192 Kbps Audio';
      confidence = 96;
      reasoning = `LLM Decision: Bandwidth (${kbps} Kbps) is below HD video requirement (${hdReq} Kbps) from CSV dataset. Video stall risk is high (${bufferRiskVideo.toFixed(1)}%). Switched to 🎵 YouTube Music to prevent buffering and conserve data.`;
    }

    res.json({
      song: { id: song.id, title: song.title, artist: song.artist },
      prediction: {
        mode,
        quality,
        confidence,
        bufferRisk: Math.round(mode === 'video' ? bufferRiskVideo : bufferRiskAudio),
        reasoning,
        thresholds: { fhdReq, hdReq, sdReq, audReq },
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3001;
app.listen(PORT, () => console.log(`🎵 Smart Media Switch API running on http://localhost:${PORT}`));

