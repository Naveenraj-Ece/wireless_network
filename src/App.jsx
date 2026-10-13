import React, { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';
import {
  measureNetworkSpeed,
  getQualityFromSpeed,
  formatSpeed,
  getSpeedTier,
  formatDuration,
} from './utils/network';
import {
  recommend,
  getDefaultPreferences,
  getQualityForSong,
  estimateDataUsage,
  BANDWIDTH_TIERS,
} from './utils/mlRecommend';
import {
  saveSongOffline,
  getOfflineSong,
  getAllOfflineSongs,
  removeOfflineSong,
} from './utils/offlineStore';
import { predictMediaSwitch } from './utils/llmPredictor';

// ── Parse CSV ─────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines   = text.trim().split('\n');
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(',');
    const obj  = {};
    headers.forEach((h, i) => (obj[h] = vals[i]?.trim() || ''));
    return obj;
  });
}

// ── Toast system ──────────────────────────────────────────────────────────────
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const add = (msg, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };
  return { toasts, add };
}

// ── YouTube IFrame API hook ───────────────────────────────────────────────────
function useYouTubePlayer(onStateChange, onError) {
  const playerRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let checkTimer;
    const tryInit = () => {
      const container = document.getElementById('yt-docked-frame');
      if (!container) return;
      if (playerRef.current) return;
      try {
        playerRef.current = new window.YT.Player('yt-docked-frame', {
          height: '100%',
          width:  '100%',
          videoId: '',
          playerVars: {
            autoplay:       1,
            controls:       1,
            disablekb:      0,
            enablejsapi:    1,
            modestbranding: 1,
            playsinline:    1,
            rel:            0,
            origin:         window.location.origin,
          },
          events: {
            onReady: () => setReady(true),
            onStateChange: (e) => onStateChange?.(e),
            onError: (e) => {
              console.warn('YT player error code:', e.data);
              onError?.(e.data);
            },
          },
        });
      } catch (err) {
        console.error('YT Player init error:', err);
      }
    };

    if (window.YT?.Player) {
      tryInit();
    } else {
      window.onYouTubeIframeAPIReady = tryInit;
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const tag = document.createElement('script');
        tag.src   = 'https://www.youtube.com/iframe_api';
        tag.async = true;
        document.head.appendChild(tag);
      }
    }

    checkTimer = setInterval(() => {
      if (!playerRef.current && window.YT?.Player && document.getElementById('yt-docked-frame')) {
        tryInit();
      }
    }, 1000);

    return () => clearInterval(checkTimer);
  }, [onStateChange, onError]);

  const play = useCallback((videoId, ytQuality, startSeconds = 0) => {
    if (!playerRef.current) return;
    try {
      playerRef.current.loadVideoById({
        videoId,
        suggestedQuality: ytQuality || 'default',
        startSeconds: startSeconds || 0,
      });
      if (ytQuality) {
        setTimeout(() => {
          try { playerRef.current?.setPlaybackQuality(ytQuality); } catch {}
        }, 1500);
      }
    } catch (e) {
      console.warn('Error loading video by ID:', e);
    }
  }, []);

  const pause      = useCallback(() => { try { playerRef.current?.pauseVideo(); } catch {} }, []);
  const resume     = useCallback(() => { try { playerRef.current?.playVideo(); } catch {} }, []);
  const stop       = useCallback(() => { try { playerRef.current?.stopVideo(); } catch {} }, []);
  const seekTo     = useCallback((s) => { try { playerRef.current?.seekTo(s, true); } catch {} }, []);
  const setVol     = useCallback((v) => { try { playerRef.current?.setVolume(v); } catch {} }, []);
  const setQuality = useCallback((q) => { try { playerRef.current?.setPlaybackQuality(q); } catch {} }, []);
  const getDur     = useCallback(() => { try { return playerRef.current?.getDuration() || 0; } catch { return 0; } }, []);
  const getCurrent = useCallback(() => { try { return playerRef.current?.getCurrentTime() || 0; } catch { return 0; } }, []);

  return { play, pause, resume, stop, seekTo, setVol, setQuality, getDur, getCurrent, ready };
}

// ── Bandwidth Meter ───────────────────────────────────────────────────────────
function BandwidthMeter({ speedKbps }) {
  return (
    <div className="bw-meter">
      {BANDWIDTH_TIERS.map((tier) => {
        const pct     = Math.min((speedKbps / tier.minKbps) * 100, 100);
        const reached = speedKbps >= tier.minKbps;
        return (
          <div key={tier.label} className={`bw-tier${reached ? ' reached' : ''}`}>
            <span className="bw-icon">{tier.icon}</span>
            <div className="bw-bar-track">
              <div className="bw-bar-fill"
                style={{ width: `${pct}%`, background: tier.color }} />
            </div>
            <span className="bw-label" style={{ color: reached ? tier.color : '#475569' }}>
              {tier.label}
            </span>
            <span className="bw-req">
              {tier.minKbps >= 1000 ? `${tier.minKbps / 1000} Mbps` : `${tier.minKbps} Kbps`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── 🧠 LLM Media Prediction Dashboard Component ───────────────────────────────
function LLMPredictionDashboard({ song, speed, prediction, userMode }) {
  if (!song) return null;

  const isVideo = prediction.mode === 'video';
  const speedKbps = speed.speedKbps || Math.round(speed.speedMbps * 1000);
  const hdReqKbps = parseFloat(song.hd_bandwidth_kbps) || 2500;

  return (
    <div className="llm-prediction-panel" id="llm-dashboard">
      <div className="llm-panel-header">
        <div className="llm-panel-title">
          <span>🧠 LLM Media Switch Predictor</span>
          <span style={{ fontSize: '0.85rem', color: '#94a3b8', fontWeight: 400 }}>
            • Evaluating "{song.title}" via <code>songs.csv</code> dataset
          </span>
        </div>
        <div className="llm-model-badge">
          <div className="llm-pulse-dot" />
          <span>LLM-MediaSwitch-v2 (CSV-Trained)</span>
        </div>
      </div>

      <div className="llm-decision-hero">
        <div className={`llm-decision-tag ${isVideo ? 'video' : 'music'}`}>
          <span>{isVideo ? '🎬' : '🎵'}</span>
          <span>{isVideo ? 'Predicted: YouTube Video' : 'Predicted: YouTube Music'}</span>
        </div>

        <div className="llm-stats-row">
          <div className="llm-stat-item">
            <span className="llm-stat-label">Model Confidence</span>
            <span className="llm-stat-val" style={{ color: '#10b981' }}>{prediction.confidence}%</span>
          </div>
          <div className="llm-stat-item">
            <span className="llm-stat-label">Buffer Risk</span>
            <span className="llm-stat-val" style={{ color: prediction.bufferRisk > 40 ? '#ef4444' : '#10b981' }}>
              {prediction.bufferRisk}% {prediction.bufferRisk > 40 ? '(High)' : '(Minimal)'}
            </span>
          </div>
          <div className="llm-stat-item">
            <span className="llm-stat-label">Recommended Quality</span>
            <span className="llm-stat-val" style={{ color: '#38bdf8' }}>{prediction.quality}</span>
          </div>
          <div className="llm-stat-item">
            <span className="llm-stat-label">Bandwidth Headroom</span>
            <span className="llm-stat-val" style={{ color: speedKbps >= hdReqKbps ? '#10b981' : '#f59e0b' }}>
              {(speedKbps / hdReqKbps).toFixed(2)}x HD Req ({hdReqKbps} Kbps)
            </span>
          </div>
          {prediction.bandwidthSavingsPct > 0 && (
            <div className="llm-stat-item">
              <span className="llm-stat-label">Data Conservation</span>
              <span className="llm-stat-val" style={{ color: '#ec4899' }}>
                +{prediction.bandwidthSavingsPct}% Bandwidth Saved
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="llm-reasoning-box">
        <div className="llm-reasoning-header">
          <span>⚡ LLM Model Inference & Reasoning:</span>
        </div>
        <div>{prediction.reasoning}</div>
      </div>
    </div>
  );
}

// ── Network Speed Panel with Live Simulator ───────────────────────────────────
function NetworkPanel({
  speed,
  onTest,
  testing,
  activeMode,
  onSetSimSpeed,
  isSimulated,
}) {
  const tier = getSpeedTier(speed.speedMbps);
  const qual = getQualityFromSpeed(speed.speedMbps);
  const kbps = speed.speedKbps || Math.round(speed.speedMbps * 1000);

  const presets = [
    { label: '🚀 5G / 10 Mbps', mbps: 10, target: '🎬 1080p Video' },
    { label: '✅ 4G / 2.5 Mbps', mbps: 2.5, target: '🎬 720p Video' },
    { label: '⚡ 3G / 800 Kbps', mbps: 0.8, target: '🎵 YT Music' },
    { label: '🐢 2G / 200 Kbps', mbps: 0.2, target: '🎵 YT Music (Low)' },
  ];

  return (
    <div className="speed-panel">
      {/* Live speed gauge */}
      <div className="speed-gauge">
        <div className="speed-number">{formatSpeed(speed.speedMbps)}</div>
        <div className="speed-unit">{kbps.toLocaleString()} Kbps</div>
        <div className="quality-badge-big" style={{ background: qual.color }}>
          {qual.label}
        </div>
        {speed.latencyMs > 0 && (
          <div className="latency-text">Ping: {speed.latencyMs} ms</div>
        )}
        <div className="latency-text" style={{ fontSize: '0.65rem', marginTop: 2, color: isSimulated ? '#f59e0b' : '#38bdf8' }}>
          {isSimulated ? '⚡ Live Speed Simulator' : `via ${speed.source || 'Cloudflare Test'}`}
        </div>
      </div>

      {/* Bandwidth progress bars */}
      <div className="bw-meter-wrap">
        <div className="bw-title">📶 Bandwidth & Smart Switch Levels</div>
        <BandwidthMeter speedKbps={kbps} />
      </div>

      {/* Info + test button */}
      <div className="switch-info">
        <div className="switch-title">
          🔄 Smart Switch Mode:{' '}
          <span style={{ color: qual.color, fontWeight: 800 }}>
            {activeMode === 'auto' ? `AI Auto (${qual.label})` : activeMode.toUpperCase()}
          </span>
        </div>
        <div className="switch-desc">
          {speed.speedMbps >= 2.0
            ? '🔥 High speed! LLM model predicts 🎬 YouTube Video (720p/1080p Full HD).'
            : '⚡ Medium/Low speed. LLM model predicts 🎵 YouTube Music (Audio Mode to prevent buffering).'}
        </div>
        <button className="test-btn" onClick={onTest} disabled={testing} id="test-speed-btn">
          {testing ? (
            <><span className="spin-icon">⏳</span> Measuring…</>
          ) : (
            <><span>📡</span> Real Wi-Fi Speed Test</>
          )}
        </button>
      </div>

      {/* ── Live Speed Simulator Slider & Presets ── */}
      <div className="speed-sim-section">
        <div className="speed-sim-title">
          <span>🎛️ Live Network Speed Switcher (Test LLM Auto-Switching Live):</span>
        </div>
        <div className="speed-preset-grid">
          {presets.map((p) => (
            <button
              key={p.label}
              className={`speed-preset-btn${Math.abs(speed.speedMbps - p.mbps) < 0.05 ? ' active' : ''}`}
              onClick={() => onSetSimSpeed(p.mbps)}
              id={`preset-${p.mbps}`}
            >
              <span>{p.label}</span>
              <span style={{ fontSize: '0.65rem', color: '#94a3b8' }}>→ {p.target}</span>
            </button>
          ))}
        </div>
        <div className="speed-slider-wrap">
          <span>0.1 Mbps (2G)</span>
          <input
            type="range"
            className="speed-sim-slider"
            min={0.1}
            max={15}
            step={0.1}
            value={speed.speedMbps}
            onChange={(e) => onSetSimSpeed(parseFloat(e.target.value))}
            id="speed-simulator-slider"
          />
          <span>15 Mbps (5G)</span>
        </div>
      </div>
    </div>
  );
}

// ── Bandwidth Info Table ──────────────────────────────────────────────────────
function BandwidthInfoPanel({ speedKbps }) {
  const rows = [
    { mode: '🎬 YouTube Video', label: '🔥 1080p FHD', min: 5000, data: '~37.5 MB/min', best: 'Fibre / 5G', color: '#10b981' },
    { mode: '🎬 YouTube Video', label: '✅ 720p HD',   min: 2500, data: '~18.8 MB/min', best: '4G / WiFi', color: '#3b82f6' },
    { mode: '🎵 YouTube Music', label: '⚡ 480p SD',   min: 800,  data: '~6 MB/min',    best: '3G / Mobile', color: '#f59e0b' },
    { mode: '🎵 YouTube Music', label: '🎵 HQ Audio',  min: 192,  data: '~1.4 MB/min',  best: '2G / Mobile', color: '#ec4899' },
  ];
  return (
    <div className="bw-info-panel">
      <div className="bw-info-title">📊 Smart Switch Dataset — Automatic Switching Matrix (songs.csv)</div>
      <div className="bw-table-wrap">
        <table className="bw-table">
          <thead>
            <tr>
              <th>Predicted Mode</th>
              <th>Quality Tier</th>
              <th>Min Bandwidth</th>
              <th>Data Usage</th>
              <th>Network Type</th>
              <th>LLM Prediction Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td style={{ fontWeight: 700, color: r.color }}>{r.mode}</td>
                <td>{r.label}</td>
                <td>{r.min >= 1000 ? `${r.min / 1000} Mbps` : `${r.min} Kbps`}</td>
                <td>{r.data}</td>
                <td>{r.best}</td>
                <td>
                  {speedKbps >= r.min
                    ? <span style={{ color: '#10b981', fontWeight: 700 }}>✔ Active Tier</span>
                    : <span style={{ color: '#64748b' }}>✗ Below Threshold</span>
                  }
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Song Card ─────────────────────────────────────────────────────────────────
function SongCard({ song, isActive, isPlaying, onPlay, onVideo, onDownload, isDownloaded, speedMbps }) {
  const videoId = song.youtube_id || song.id;
  const thumb   = song.thumbnail  || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
  const qual    = getQualityForSong(song, speedMbps);
  const dataMB  = estimateDataUsage(song, speedMbps);

  return (
    <div className={`song-card${isActive ? ' active' : ''}`} id={`card-${videoId}`}>
      <div className="card-thumb">
        <img src={thumb} alt={song.title}
          onError={(e) => { e.target.src = `https://picsum.photos/seed/${videoId}/320/180`; }} />
        <div className="quality-label" style={{ color: qual.color }}>{qual.label}</div>
        {isDownloaded && (
          <div className="downloaded-badge">💾 Downloaded</div>
        )}
        <div className="card-overlay">
          <button className="overlay-btn play-btn" onClick={() => onPlay(song)}
            id={`play-${videoId}`} title="▶ Play (Smart Switch)">
            {isActive && isPlaying ? '⏸' : '▶'}
          </button>
          <button className="overlay-btn" onClick={() => onVideo(song)}
            id={`video-${videoId}`} title="🎬 Watch YouTube Video">🎬</button>
          <button className={`overlay-btn download-btn${isDownloaded ? ' downloaded' : ''}`}
            onClick={() => onDownload(song)} id={`download-${videoId}`}
            title={isDownloaded ? '💾 Downloaded' : '⬇ Download Song'}>
            {isDownloaded ? '✔' : '⬇'}
          </button>
        </div>
      </div>
      <div className="card-info">
        <div className="card-title" title={song.title}>{song.title}</div>
        <div className="card-artist">{song.artist}</div>
        <div className="card-movie">{song.movie}{song.year ? ` (${song.year})` : ''}</div>
        <div className="card-meta">
          <span className="card-bw" style={{ color: qual.color }}>📶 {qual.label}</span>
          <span className="card-data">~{dataMB} MB/min</span>
          {song.rating && <span className="card-rating">⭐ {parseFloat(song.rating).toFixed(1)}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Video Modal (full video inside site) ─────────────────────────────────────
function VideoModal({ song, onClose }) {
  const videoId = song?.youtube_id || song?.id;
  if (!song) return null;
  return (
    <div className="modal-overlay" onClick={onClose} id="video-modal">
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="modal-title">🎬 {song.title}</div>
            <div style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: 2 }}>
              {song.artist} • {song.movie} {song.year ? `(${song.year})` : ''}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} id="close-modal-btn">✕</button>
        </div>
        <div className="video-iframe-wrap">
          <iframe
            src={`https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0&modestbranding=1&enablejsapi=1`}
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            title={song.title}
          />
        </div>
      </div>
    </div>
  );
}

// ── Main App Component ────────────────────────────────────────────────────────
export default function App() {
  const [tab,             setTab]             = useState('discover');
  const [query,           setQuery]           = useState('');
  const [searching,       setSearching]       = useState(false);
  const [searchResults,   setSearchResults]   = useState([]);
  const [catalog,         setCatalog]         = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [currentSong,     setCurrentSong]     = useState(null);
  const [isPlaying,       setIsPlaying]       = useState(false);
  const [videoModal,      setVideoModal]      = useState(null);
  const [progress,        setProgress]        = useState(0);
  const [duration,        setDuration]        = useState(0);
  const [volume,          setVolume]          = useState(85);
  const [speed,           setSpeed]           = useState({ speedMbps: 4.5, speedKbps: 4500, latencyMs: 25, source: 'Initial' });
  const [isSimulatedSpeed,setIsSimulatedSpeed]= useState(false);
  const [testingSpeed,    setTestingSpeed]    = useState(false);
  const [moodFilter,      setMoodFilter]      = useState('');
  const [genreFilter,     setGenreFilter]     = useState('');
  
  // Media modes: 'auto' (LLM Predictor) | 'video' | 'music'
  const [mediaMode,       setMediaMode]       = useState('auto');
  const [dockedMinimized, setDockedMinimized] = useState(false);
  const [dockedViewType,  setDockedViewType]  = useState('auto'); // 'auto' | 'music' | 'video'
  
  // Live switch notification banner
  const [liveSwitchNotice, setLiveSwitchNotice] = useState(null);

  // Downloaded songs map
  const [downloadedSongs, setDownloadedSongs] = useState({});
  const [downloadingId,   setDownloadingId]   = useState(null);

  const progressTimer     = useRef(null);
  const audioRef          = useRef(null);
  const prevEffectiveMode = useRef(null);
  const storedSecondRef   = useRef(0);
  const { toasts, add: addToast } = useToasts();

  // Load downloaded songs from IndexedDB
  const refreshOfflineLibrary = useCallback(async () => {
    try {
      const all = await getAllOfflineSongs();
      const map = {};
      all.forEach((item) => { map[String(item.id)] = item; });
      setDownloadedSongs(map);
    } catch (e) {
      console.warn('Could not read offline storage:', e);
    }
  }, []);

  useEffect(() => {
    refreshOfflineLibrary();
  }, [refreshOfflineLibrary]);

  // Handle YouTube player state changes
  const handleYTState = useCallback((event) => {
    if (event.data === 1) {
      setIsPlaying(true);
      startProgressTimer();
    } else if (event.data === 2) {
      setIsPlaying(false);
      stopProgressTimer();
    } else if (event.data === 0) {
      setIsPlaying(false);
      setProgress(0);
      storedSecondRef.current = 0;
      stopProgressTimer();
    }
  }, []);

  // Handle YouTube embed errors
  const handleYTError = useCallback((code) => {
    console.warn('YouTube embed error code:', code);
    if (currentSong) {
      addToast(`YouTube embed restricted (${code}). Playing high-fidelity audio track!`, 'info');
      if (audioRef.current) {
        audioRef.current.src = `/api/audio/${currentSong.id}`;
        audioRef.current.play().catch(() => {});
      }
    }
  }, [currentSong]);

  const yt = useYouTubePlayer(handleYTState, handleYTError);

  function startProgressTimer() {
    stopProgressTimer();
    progressTimer.current = setInterval(() => {
      const cur = yt.getCurrent();
      const dur = yt.getDur();
      if (dur > 0) {
        setProgress(cur);
        setDuration(dur);
        storedSecondRef.current = cur;
      }
    }, 400);
  }

  function stopProgressTimer() {
    if (progressTimer.current) {
      clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
  }

  useEffect(() => () => stopProgressTimer(), []);

  // ── Calculate LLM Model Prediction for current song & network ────────────────
  const activeSongForPredict = currentSong || catalog[0] || null;
  const currentPrediction = predictMediaSwitch(activeSongForPredict, speed);

  // Determine active mode: if 'auto', use LLM model prediction
  const effectiveMode = mediaMode === 'auto' ? currentPrediction.mode : mediaMode;

  // ── SEAMLESS LIVE SWITCHING ON SPEED OR LLM PREDICTION CHANGE ────────────────
  useEffect(() => {
    if (!currentSong || !isPlaying) return;

    const newMode = effectiveMode;
    const oldMode = prevEffectiveMode.current;

    if (oldMode && oldMode !== newMode) {
      // 1. Capture the exact second played
      const currentPos = yt.getCurrent() || storedSecondRef.current || progress;
      storedSecondRef.current = currentPos;

      // 2. Adjust quality on the active player without reloading or re-buffering!
      const ytQual = newMode === 'video' ? (speed.speedMbps >= 5 ? 'hd1080' : 'hd720') : 'small';
      yt.setQuality(ytQual);

      // 3. Switch visual view (Music Deck visualizer vs Video screen)
      if (newMode === 'music') {
        setDockedViewType('music');
        if (videoModal) setVideoModal(null); // close heavy video modal on low network
      } else {
        setDockedViewType('video');
      }

      // 4. Preserve progress scrollbar position
      setProgress(currentPos);

      const notice = `⚡ Network is ${formatSpeed(speed.speedMbps)} → Auto-switched to ${newMode === 'video' ? '🎬 YouTube Video (HD)' : '🎵 YouTube Music (Audio)'} (Stored & continuing at ${formatDuration(Math.floor(currentPos))})!`;
      setLiveSwitchNotice(notice);
      addToast(notice, 'info');
    }

    prevEffectiveMode.current = newMode;
  }, [effectiveMode, speed.speedMbps, currentSong, isPlaying, yt, videoModal]);

  // Load catalog on mount & test network speed
  useEffect(() => {
    fetch('/songs.csv')
      .then((r) => r.text())
      .then((text) => {
        const parsed = parseCSV(text);
        setCatalog(parsed);
        if (parsed.length > 0 && !currentSong) {
          setCurrentSong(parsed[0]);
        }
      })
      .catch(() =>
        fetch('/api/data/songs.csv')
          .then((r) => r.text())
          .then((text) => setCatalog(parseCSV(text)))
          .catch(() => addToast('Could not load songs dataset', 'error'))
      );

    runSpeedTest(true);

    const handleOnline = () => {
      addToast('🌐 Network reconnected! Testing live speed…', 'success');
      setIsSimulatedSpeed(false);
      runSpeedTest(false);
    };
    const handleOffline = () => {
      addToast('⚠️ Network dropped to low speed! LLM switched to 🎵 YouTube Music.', 'info');
      setSpeed({ speedMbps: 0.15, speedKbps: 150, latencyMs: 120, source: 'Offline' });
      setIsSimulatedSpeed(true);
    };

    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Update recommendations when catalog or speed changes
  useEffect(() => {
    if (!catalog.length) return;
    const prefs = getDefaultPreferences(moodFilter, genreFilter, speed.speedMbps);
    setRecommendations(recommend(catalog, prefs, speed.speedMbps, 10));
  }, [catalog, speed, moodFilter, genreFilter]);

  // Volume sync for YouTube player
  useEffect(() => {
    if (yt.ready) yt.setVol(volume);
  }, [volume, yt.ready]);

  const runSpeedTest = async (silent = false) => {
    setIsSimulatedSpeed(false);
    setTestingSpeed(true);
    if (!silent) addToast('📡 Testing live network bandwidth…', 'info');
    const result = await measureNetworkSpeed();
    setSpeed(result);
    const q = getQualityFromSpeed(result.speedMbps);
    if (!silent) addToast(`✅ Live Speed: ${formatSpeed(result.speedMbps)} → ${q.label}`, 'success');
    setTestingSpeed(false);
  };

  // Set simulated live speed
  const handleSetSimSpeed = (mbps) => {
    setIsSimulatedSpeed(true);
    const kbps = Math.round(mbps * 1000);
    const latency = mbps >= 5 ? 15 : mbps >= 2 ? 35 : mbps >= 0.5 ? 65 : 120;
    setSpeed({ speedMbps: mbps, speedKbps: kbps, latencyMs: latency, source: 'Simulator' });
  };

  // ── SMART SWITCH: Play Song Handler ──────────────────────────────────────────
  const playSong = useCallback((song) => {
    const videoId    = song.youtube_id || song.id;
    const pred       = predictMediaSwitch(song, speed);
    const targetMode = mediaMode === 'auto' ? pred.mode : mediaMode;

    setCurrentSong(song);
    setProgress(0);
    setDuration(0);
    prevEffectiveMode.current = targetMode;

    const ytQuality = targetMode === 'video' ? (speed.speedMbps >= 5 ? 'hd1080' : 'hd720') : 'medium';

    if (yt.ready) {
      yt.play(videoId, ytQuality);
      yt.setVol(volume);
      setIsPlaying(true);
      const modeLabel = targetMode === 'video' ? '🎬 YouTube Video' : '🎵 YouTube Music';
      addToast(`▶ LLM Predicted: ${modeLabel} for "${song.title}" (${pred.confidence}% Conf)`, 'success');
    }
  }, [mediaMode, speed, yt, volume]);

  const togglePlay = () => {
    if (!currentSong) return;
    if (isPlaying) { yt.pause(); setIsPlaying(false); }
    else           { yt.resume(); setIsPlaying(true); }
  };

  const seekTo = (e) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const target = pct * duration;
    setProgress(target);
    storedSecondRef.current = target;
    yt.seekTo(target);
  };

  // ── Download Song Handler ────────────────────────────────────────────────────
  const handleDownload = async (song) => {
    const songId = String(song.id);
    setDownloadingId(songId);
    addToast(`⏳ Downloading "${song.title}"…`, 'info');

    try {
      const downloadUrl = `/api/download/${song.id}?title=${encodeURIComponent(song.title)}`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${song.title.replace(/[^a-zA-Z0-9_\-\s]/g, '')}.wav`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      await saveSongOffline(song);
      await refreshOfflineLibrary();

      addToast(`💾 "${song.title}" downloaded! Available for offline playback.`, 'success');
    } catch (err) {
      console.error('Download error:', err);
      addToast('Download failed. Please check server.', 'error');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDeleteOffline = async (songId, title) => {
    await removeOfflineSong(songId);
    await refreshOfflineLibrary();
    addToast(`Removed "${title}" from offline downloads`, 'info');
  };

  const handleSearch = async (e) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setTab('search');
    try {
      const q   = query.toLowerCase().includes('tamil') ? query : `${query} Tamil song`;
      const res  = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=video`);
      const data = await res.json();
      if (data.results) {
        setSearchResults(data.results);
        addToast(`Found ${data.results.length} Tamil songs 🎵`, 'success');
      } else {
        addToast(data.error || 'Search failed', 'error');
      }
    } catch {
      addToast('Search failed: Ensure backend server is running', 'error');
    }
    setSearching(false);
  };

  const filteredCatalog = catalog.filter((s) => {
    if (moodFilter  && s.mood  !== moodFilter) return false;
    if (genreFilter && !s.genre?.toLowerCase().includes(genreFilter.toLowerCase())) return false;
    return true;
  });

  const downloadedList = Object.values(downloadedSongs);

  const qual    = getQualityFromSpeed(speed.speedMbps);
  const kbps    = speed.speedKbps || Math.round(speed.speedMbps * 1000);
  const speedOk = speed.speedMbps > 0;

  // Docked player display mode:
  const isMusicMode = (dockedViewType === 'auto' && effectiveMode === 'music') || dockedViewType === 'music';

  return (
    <>
      {/* ── Audio Fallback ── */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* ── Docked Media Deck (YouTube Video / YouTube Music) ── */}
      <div className={`docked-yt-container${dockedMinimized ? ' minimized' : ''}`}
        id="docked-player"
        style={{ display: currentSong ? 'block' : 'none' }}>
        <div className="docked-yt-header">
          <div className="docked-yt-header-title">
            <span>{effectiveMode === 'video' ? '🎬 Video' : '🎵 Music'}</span>
            <span style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {currentSong?.title}
            </span>
          </div>
          <div className="docked-yt-tools">
            <button
              className="docked-tool-btn"
              onClick={() => setDockedViewType(dockedViewType === 'music' ? 'video' : 'music')}
              title={dockedViewType === 'music' ? 'Show Video Player' : 'Show Music Deck Visualizer'}
            >
              {isMusicMode ? '🎬 Video' : '🎵 Deck'}
            </button>
            <button className="docked-tool-btn" onClick={() => setVideoModal(currentSong)} title="Expand Full Theater">⛶</button>
            <button className="docked-tool-btn" onClick={() => setDockedMinimized(!dockedMinimized)} title="Minimize/Restore">
              {dockedMinimized ? '▲' : '▼'}
            </button>
          </div>
        </div>

        {/* The YouTube iframe is ALWAYS kept alive in the DOM so audio never stops! */}
        <div className="docked-yt-frame">
          <div id="yt-docked-frame" style={{ width: '100%', height: '100%' }} />

          {/* When in Music Mode, display the Music Deck visualizer overlay over the player */}
          {isMusicMode && (
            <div className="docked-audio-card-overlay">
              <img
                src={currentSong?.thumbnail || `https://img.youtube.com/vi/${currentSong?.youtube_id}/hqdefault.jpg`}
                alt={currentSong?.title}
                className={`docked-vinyl-spin${isPlaying ? ' playing' : ''}`}
              />
              <div className="docked-audio-card-title">{currentSong?.title}</div>
              <div className="docked-audio-card-sub">{currentSong?.artist}</div>
              <div className="docked-audio-tag">🎵 YouTube Music Mode (Audio Playing)</div>
            </div>
          )}
        </div>
      </div>

      {/* ── Header ── */}
      <header className="header">
        <div className="logo">
          <div className="logo-icon">🎵</div>
          Tamil SmartSwitch
        </div>
        <div className="network-badge" id="network-badge" title="Live Network Bandwidth">
          <div className={`speed-dot ${getSpeedTier(speed.speedMbps)}`} />
          <span style={{ color: qual.color, fontWeight: 800, fontSize: '0.92rem' }}>
            📶 {formatSpeed(speed.speedMbps)}
          </span>
          <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}>
            ({qual.label})
          </span>
          <span className="quality-switch-badge">
            {mediaMode === 'auto' ? '🧠 LLM AUTO SWITCH' : mediaMode.toUpperCase()}
          </span>
        </div>
      </header>

      {/* ── Main Content ── */}
      <main className="main">

        {/* Hero Section */}
        <section className="search-section">
          <h1 className="search-title">🎵 Tamil Smart Media Switch</h1>
          <p className="search-subtitle">
            AI LLM Model predicts and switches strictly between <strong>🎬 YouTube Video</strong> and <strong>🎵 YouTube Music</strong> based on your live bandwidth and the <code>songs.csv</code> dataset.
          </p>
          <form className="search-bar-wrapper" onSubmit={handleSearch}>
            <input className="search-bar" id="search-input"
              placeholder="Search Tamil songs, movies, artists… e.g. Anirudh, Vaathi Coming, Rowdy Baby"
              value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className="search-btn" type="submit" id="search-submit-btn" disabled={searching}>
              {searching ? '⏳' : '🔍'} Search
            </button>
          </form>
        </section>

        {/* ── Live Smart Switch Alert Banner ── */}
        {liveSwitchNotice && (
          <div className="live-switch-banner" id="live-switch-banner">
            <span className="live-switch-badge">LLM PREDICTION</span>
            <span className="live-switch-text">{liveSwitchNotice}</span>
            <button
              style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '0.9rem' }}
              onClick={() => setLiveSwitchNotice(null)}
            >✕</button>
          </div>
        )}

        {/* ── Media Mode Switch Bar (Strictly YouTube Video & YouTube Music) ── */}
        <div className="media-mode-bar" id="media-mode-bar">
          <div style={{ fontSize: '0.82rem', color: '#94a3b8', fontWeight: 600, marginRight: 6 }}>
            Decision Mode:
          </div>
          {[
            { id: 'auto',  icon: '🧠', label: 'LLM Auto Switch', badge: 'AI Predicted' },
            { id: 'video', icon: '🎬', label: 'YouTube Video',   badge: 'HD / FHD'     },
            { id: 'music', icon: '🎵', label: 'YouTube Music',   badge: 'HQ Audio'     },
          ].map((m) => (
            <button
              key={m.id}
              className={`mode-pill${mediaMode === m.id ? ' active' : ''}`}
              onClick={() => {
                setMediaMode(m.id);
                addToast(`Mode set to: ${m.label}`, 'info');
              }}
              id={`mode-${m.id}`}
            >
              <span>{m.icon}</span>
              <span>{m.label}</span>
              <span className="mode-badge-auto">{m.badge}</span>
            </button>
          ))}
        </div>

        {/* ── 🧠 LLM Prediction Dashboard ── */}
        <LLMPredictionDashboard
          song={activeSongForPredict}
          speed={speed}
          prediction={currentPrediction}
          userMode={mediaMode}
        />

        {/* Network Panel with Live Speed Simulator */}
        <NetworkPanel
          speed={speed}
          onTest={() => runSpeedTest()}
          testing={testingSpeed}
          activeMode={mediaMode}
          onSetSimSpeed={handleSetSimSpeed}
          isSimulated={isSimulatedSpeed}
        />

        {/* Bandwidth Dataset Matrix */}
        <BandwidthInfoPanel speedKbps={kbps} />

        {/* Tabs */}
        <div className="tabs">
          {[
            { id: 'discover',  label: '✨ Discover' },
            { id: 'search',    label: '🔍 Search' },
            { id: 'offline',   label: `💾 Downloaded (${downloadedList.length})` },
            { id: 'library',   label: '📚 Library' },
          ].map((t) => (
            <button key={t.id} className={`tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)} id={`tab-${t.id}`}>
              {t.label}
            </button>
          ))}
        </div>

        {/* Filters */}
        {(tab === 'discover' || tab === 'library') && (
          <div className="filter-row">
            <select className="filter-select" value={moodFilter}
              onChange={(e) => setMoodFilter(e.target.value)} id="mood-filter">
              <option value="">All Moods</option>
              {['Energetic','Happy','Chill','Romantic','Sad','Patriotic'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select className="filter-select" value={genreFilter}
              onChange={(e) => setGenreFilter(e.target.value)} id="genre-filter">
              <option value="">All Genres</option>
              {['Folk-Dance','Kuthu','Melody','Hip-Hop','Dance','Folk','Patriotic','BGM'].map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
        )}

        {/* ── Discover Tab ── */}
        {tab === 'discover' && (
          <>
            <div className="rec-section">
              <div className="section-header">
                <div className="section-title">
                  <div className="section-title-icon">🤖</div>
                  Smart Recommendations — Tailored to {speedOk ? formatSpeed(speed.speedMbps) : 'your bandwidth'}
                </div>
              </div>
              <div className="grid">
                {recommendations.map((song, i) => (
                  <SongCard
                    key={song.id || song.youtube_id || i}
                    song={song}
                    isActive={currentSong?.id === song.id || currentSong?.youtube_id === song.youtube_id}
                    isPlaying={isPlaying}
                    onPlay={playSong}
                    onVideo={setVideoModal}
                    onDownload={handleDownload}
                    isDownloaded={!!downloadedSongs[String(song.id)]}
                    speedMbps={speed.speedMbps}
                  />
                ))}
              </div>
            </div>

            <div className="rec-section">
              <div className="section-header">
                <div className="section-title">
                  <div className="section-title-icon">🎵</div>
                  All 30 Tamil Songs
                </div>
              </div>
              <div className="grid">
                {filteredCatalog.map((song, i) => (
                  <SongCard
                    key={song.id || song.youtube_id || i}
                    song={song}
                    isActive={currentSong?.id === song.id || currentSong?.youtube_id === song.youtube_id}
                    isPlaying={isPlaying}
                    onPlay={playSong}
                    onVideo={setVideoModal}
                    onDownload={handleDownload}
                    isDownloaded={!!downloadedSongs[String(song.id)]}
                    speedMbps={speed.speedMbps}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {/* ── Search Tab ── */}
        {tab === 'search' && (
          <>
            {searching && <div className="spinner" />}
            {!searching && searchResults.length === 0 && (
              <div className="empty-state">
                <div className="empty-icon">🎵</div>
                <div className="empty-text">Search for any Tamil song above</div>
              </div>
            )}
            {!searching && searchResults.length > 0 && (
              <div className="grid">
                {searchResults.map((song, i) => (
                  <SongCard
                    key={song.id || i}
                    song={{ ...song, youtube_id: song.id }}
                    isActive={currentSong?.youtube_id === song.id}
                    isPlaying={isPlaying}
                    onPlay={playSong}
                    onVideo={setVideoModal}
                    onDownload={handleDownload}
                    isDownloaded={!!downloadedSongs[String(song.id)]}
                    speedMbps={speed.speedMbps}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Downloaded (Offline) Tab ── */}
        {tab === 'offline' && (
          <div className="rec-section">
            <div className="section-header">
              <div className="section-title">
                <div className="section-title-icon">💾</div>
                Downloaded Songs ({downloadedList.length}) — Offline Storage
              </div>
            </div>
            {downloadedList.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">⬇</div>
                <div className="empty-text">
                  No downloaded songs yet. Click the <strong>⬇ Download</strong> button on any song to save it for offline playback!
                </div>
              </div>
            ) : (
              <div className="grid">
                {downloadedList.map((item) => (
                  <div key={item.id} className="song-card active" id={`offline-card-${item.id}`}>
                    <div className="card-thumb">
                      <img src={item.thumbnail || `https://img.youtube.com/vi/${item.youtube_id}/hqdefault.jpg`} alt={item.title} />
                      <div className="downloaded-badge">💾 Downloaded</div>
                      <div className="card-overlay">
                        <button className="overlay-btn play-btn" onClick={() => playSong(item)} title="▶ Play Song">
                          {currentSong?.id === item.id && isPlaying ? '⏸' : '▶'}
                        </button>
                        <button className="overlay-btn" onClick={() => setVideoModal(item)} title="🎬 Watch Video">🎬</button>
                      </div>
                    </div>
                    <div className="card-info">
                      <div className="card-title">{item.title}</div>
                      <div className="card-artist">{item.artist}</div>
                      <div className="card-movie">{item.movie}</div>
                      <div className="card-meta">
                        <span style={{ color: '#10b981', fontWeight: 700, fontSize: '0.72rem' }}>
                          💾 Offline Ready
                        </span>
                        <button className="offline-delete-btn" onClick={() => handleDeleteOffline(item.id, item.title)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Library Tab ── */}
        {tab === 'library' && (
          <>
            {filteredCatalog.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">🎶</div>
                <div className="empty-text">No songs match your filters</div>
              </div>
            ) : (
              <div className="grid">
                {filteredCatalog.map((song, i) => (
                  <SongCard
                    key={song.id || song.youtube_id || i}
                    song={song}
                    isActive={currentSong?.id === song.id || currentSong?.youtube_id === song.youtube_id}
                    isPlaying={isPlaying}
                    onPlay={playSong}
                    onVideo={setVideoModal}
                    onDownload={handleDownload}
                    isDownloaded={!!downloadedSongs[String(song.id)]}
                    speedMbps={speed.speedMbps}
                  />
                ))}
              </div>
            )}
          </>
        )}

      </main>

      {/* ── Now Playing Bar ── */}
      <div className={`player-bar${currentSong ? '' : ' hidden'}`} id="player-bar">
        {currentSong && (
          <>
            <img
              className={`player-thumb vinyl${isPlaying ? ' playing' : ''}`}
              src={currentSong.thumbnail || `https://img.youtube.com/vi/${currentSong.youtube_id || currentSong.id}/default.jpg`}
              alt={currentSong.title}
              onError={(e) => { e.target.src = 'https://picsum.photos/seed/music/52/52'; }}
            />
            <div className="player-info">
              <div className="player-title">{currentSong.title}</div>
              <div className="player-artist">
                {currentSong.artist}{currentSong.movie ? ` • ${currentSong.movie}` : ''}
              </div>
            </div>

            {/* Equalizer Visualizer */}
            <div className={`audio-visualizer${isPlaying ? ' playing' : ''}`} title="Audio Visualizer">
              <div className="eq-bar" />
              <div className="eq-bar" />
              <div className="eq-bar" />
              <div className="eq-bar" />
              <div className="eq-bar" />
            </div>

            {/* Active Engine Badge */}
            <div className={`engine-badge ${effectiveMode}`}>
              {effectiveMode === 'video'
                ? '🎬 YT VIDEO (HD)'
                : '🎵 YT MUSIC (AUDIO)'}
            </div>

            {/* Controls */}
            <div className="player-controls">
              <button className="ctrl-btn" id="prev-btn" title="Previous"
                onClick={() => {
                  const idx = catalog.findIndex((s) => s.id === currentSong.id);
                  if (idx > 0) playSong(catalog[idx - 1]);
                }}>⏮</button>
              <button className="play-pause-btn" onClick={togglePlay} id="play-pause-btn">
                {isPlaying ? '⏸' : '▶'}
              </button>
              <button className="ctrl-btn" id="next-btn" title="Next"
                onClick={() => {
                  const idx = catalog.findIndex((s) => s.id === currentSong.id);
                  if (idx >= 0 && idx < catalog.length - 1) playSong(catalog[idx + 1]);
                }}>⏭</button>
            </div>

            {/* Progress Bar */}
            <div className="progress-section">
              <div className="progress-bar-wrap" onClick={seekTo} id="progress-bar">
                <div className="progress-fill"
                  style={{ width: duration > 0 ? `${(progress / duration) * 100}%` : '0%' }} />
              </div>
              <div className="time-row">
                <span>{formatDuration(Math.floor(progress))}</span>
                <span>{formatDuration(Math.floor(duration))}</span>
              </div>
            </div>

            {/* Volume */}
            <div className="volume-wrap">
              <span>🔊</span>
              <input type="range" className="volume-slider" id="volume-slider"
                min={0} max={100} step={1} value={volume}
                onChange={(e) => setVolume(parseInt(e.target.value))} />
            </div>

            {/* Action Buttons: Video Modal & Download */}
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="ctrl-btn" onClick={() => setVideoModal(currentSong)} title="🎬 Watch Full Video" style={{ fontSize: '1rem' }}>
                🎬
              </button>
              <button className="ctrl-btn" onClick={() => handleDownload(currentSong)} title="⬇ Download Song" style={{ fontSize: '1rem' }}>
                ⬇
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Video Modal ── */}
      {videoModal && <VideoModal song={videoModal} onClose={() => setVideoModal(null)} />}

      {/* ── Toast Notifications ── */}
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.type === 'success' ? '✅' : t.type === 'error' ? '❌' : 'ℹ️'} {t.msg}
          </div>
        ))}
      </div>
    </>
  );
}
