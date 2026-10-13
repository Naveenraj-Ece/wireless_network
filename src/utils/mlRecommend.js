/**
 * ML Recommendation Engine — Tamil Songs Edition
 * Uses cosine similarity on feature vectors that include
 * network bandwidth thresholds from the CSV dataset.
 */

// Map bandwidth (Mbps) to quality label using CSV thresholds
export function getQualityForSong(song, speedMbps) {
  const speedKbps = speedMbps * 1000;
  const fhd = parseFloat(song.fhd_bandwidth_kbps) || 5000;
  const hd  = parseFloat(song.hd_bandwidth_kbps)  || 2500;
  const sd  = parseFloat(song.sd_bandwidth_kbps)  || 800;
  const aud = parseFloat(song.audio_bandwidth_kbps)|| 192;
  const min = parseFloat(song.min_bandwidth_kbps)  || 128;

  if (speedKbps >= fhd) return { label: '1080p', quality: 'high',   color: '#10b981', canPlay: true };
  if (speedKbps >= hd)  return { label: '720p',  quality: 'medium', color: '#3b82f6', canPlay: true };
  if (speedKbps >= sd)  return { label: '480p',  quality: 'low',    color: '#f59e0b', canPlay: true };
  if (speedKbps >= aud) return { label: 'Audio', quality: 'audio',  color: '#ef4444', canPlay: true };
  if (speedKbps >= min) return { label: 'Low',   quality: 'audio',  color: '#dc2626', canPlay: true };
  return { label: 'No Signal', quality: 'audio', color: '#6b7280', canPlay: false };
}

// Estimate data usage per minute for this song at current speed
export function estimateDataUsage(song, speedMbps) {
  const speedKbps = speedMbps * 1000;
  const fhd = parseFloat(song.fhd_bandwidth_kbps) || 5000;
  const hd  = parseFloat(song.hd_bandwidth_kbps)  || 2500;
  const sd  = parseFloat(song.sd_bandwidth_kbps)  || 800;
  const aud = parseFloat(song.audio_bandwidth_kbps)|| 192;

  let kbpsUsed;
  if (speedKbps >= fhd) kbpsUsed = fhd;
  else if (speedKbps >= hd) kbpsUsed = hd;
  else if (speedKbps >= sd) kbpsUsed = sd;
  else kbpsUsed = aud;

  const mbPerMin = (kbpsUsed * 60) / (8 * 1000); // kbps → MB/min
  return mbPerMin.toFixed(1);
}

// Build feature vector for a song
export function buildFeatureVector(song, speedMbps) {
  const moodMap    = { Energetic: 1.0, Happy: 0.8, Chill: 0.5, Romantic: 0.6, Sad: 0.3, Dark: 0.2, Patriotic: 0.85 };
  const genreMap   = {
    'Folk-Dance': 0.9, 'Hip-Hop': 0.8, 'Kuthu': 0.88, 'Melody': 0.6, 'Dance': 0.85,
    'Folk': 0.82, 'Pop': 0.7, 'Patriotic': 0.75, 'BGM': 0.5,
  };

  const speedKbps       = speedMbps * 1000;
  const minBw           = parseFloat(song.min_bandwidth_kbps) || 128;
  const hdBw            = parseFloat(song.hd_bandwidth_kbps)  || 2500;
  const networkCompat   = Math.min(speedKbps / hdBw, 1.0); // 0→1

  return [
    parseFloat(song.rating)  / 5.0,                               // rating
    Math.min(parseFloat(song.plays) / 4500000, 1.0),              // popularity
    (moodMap[song.mood]    ?? 0.5),                                // mood
    (genreMap[song.genre]  ?? 0.5),                                // genre
    Math.min(parseFloat(song.bpm) / 200, 1.0),                    // tempo
    networkCompat,                                                 // bandwidth compatibility
    speedKbps >= minBw ? 1.0 : 0.0,                               // can play at all?
    parseFloat(song.year) >= 2018 ? 1.0 : parseFloat(song.year) >= 2010 ? 0.6 : 0.3, // recency
  ];
}

export function cosineSimilarity(a, b) {
  const dot   = a.reduce((sum, ai, i) => sum + ai * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, ai) => sum + ai * ai, 0));
  const normB = Math.sqrt(b.reduce((sum, bi) => sum + bi * bi, 0));
  return normA && normB ? dot / (normA * normB) : 0;
}

export function recommend(songs, preferences, speedMbps, topK = 8) {
  const prefVector = buildFeatureVector(preferences, speedMbps);
  const speedKbps  = speedMbps * 1000;

  const scored = songs.map((song) => {
    const minBw = parseFloat(song.min_bandwidth_kbps) || 128;
    if (speedKbps < minBw) return { ...song, _score: -1 }; // can't play at all

    const vec   = buildFeatureVector(song, speedMbps);
    const score = cosineSimilarity(prefVector, vec);
    return { ...song, _score: score };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored.filter(s => s._score >= 0).slice(0, topK);
}

export function getDefaultPreferences(mood, genre, speedMbps) {
  return {
    rating:                '4.8',
    plays:                 '1500000',
    mood:                  mood  || 'Energetic',
    genre:                 genre || 'Folk-Dance',
    bpm:                   speedMbps > 5 ? '135' : '80',
    min_bandwidth_kbps:    '128',
    hd_bandwidth_kbps:     '2500',
    fhd_bandwidth_kbps:    '5000',
    audio_bandwidth_kbps:  '192',
    year:                  '2022',
  };
}

// Bandwidth tiers for display in the UI
export const BANDWIDTH_TIERS = [
  { label: '1080p FHD', minKbps: 5000,  color: '#10b981', icon: '🔥' },
  { label: '720p HD',   minKbps: 2500,  color: '#3b82f6', icon: '✅' },
  { label: '480p SD',   minKbps: 800,   color: '#f59e0b', icon: '⚡' },
  { label: 'Audio',     minKbps: 192,   color: '#ef4444', icon: '🎵' },
  { label: 'Low',       minKbps: 128,   color: '#dc2626', icon: '📻' },
];
