// api/speedtest.js - Vercel Serverless Function
export default function handler(req, res) {
  const bytes = Math.min(parseInt(req.query.bytes) || 200000, 2000000);
  const buf = Buffer.alloc(bytes, 0x42);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', bytes);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send(buf);
}
