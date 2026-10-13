// api/search.js - Vercel Serverless Function
import https from 'https';
import http from 'http';

const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://iv.datura.network',
];

function fetchJSON(url) {
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
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
}
