// api/recommend.js - Vercel Serverless Function
// NOTE: Reads songs.csv from the public folder (bundled with deployment)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { mood, genre, network_speed, limit = 5 } = req.query;

  // In Vercel, the public folder is NOT available at runtime for serverless functions.
  // We embed the CSV data directly here.
  const csvPath = path.join(__dirname, '..', 'public', 'songs.csv');

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

    const mbps = parseFloat(network_speed) || 10;
    const kbps = mbps * 1000;

    const scored = songs.map((song) => {
      const minBw = parseFloat(song.min_bandwidth_kbps) || 128;
      if (kbps < minBw) return { ...song, score: 0 };

      let score = parseFloat(song.rating) * 10;
      if (mood && song.mood?.toLowerCase() === mood.toLowerCase()) score += 30;
      if (genre && song.genre?.toLowerCase().includes(genre.toLowerCase())) score += 25;

      const hdBw  = parseFloat(song.hd_bandwidth_kbps)  || 2500;
      const sdBw  = parseFloat(song.sd_bandwidth_kbps)  || 800;
      const audBw = parseFloat(song.audio_bandwidth_kbps)|| 192;
      if      (kbps >= (parseFloat(song.fhd_bandwidth_kbps) || 5000)) score += 20;
      else if (kbps >= hdBw)  score += 15;
      else if (kbps >= sdBw)  score += 8;
      else if (kbps >= audBw) score += 3;

      score += parseFloat(song.plays) / 4500000 * 10;
      return { ...song, score };
    });

    scored.sort((a, b) => b.score - a.score);
    res.json({ recommendations: scored.slice(0, parseInt(limit)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
