/**
 * Offline storage utility using IndexedDB for storing and playing downloaded songs offline.
 */

const DB_NAME = 'TamilSmartSwitchDB';
const DB_VERSION = 1;
const STORE_NAME = 'downloaded_songs';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSongOffline(song) {
  try {
    const audioUrl = `/api/audio/${song.id}`;
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error(`Audio fetch failed (${res.status})`);
    const blob = await res.blob();

    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    const record = {
      id: String(song.id),
      title: song.title,
      artist: song.artist,
      movie: song.movie,
      genre: song.genre,
      year: song.year,
      youtube_id: song.youtube_id,
      thumbnail: song.thumbnail,
      audioBlob: blob,
      sizeBytes: blob.size,
      downloadedAt: new Date().toISOString(),
    };

    await new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    return record;
  } catch (err) {
    console.error('Failed to save song offline:', err);
    throw err;
  }
}

export async function getOfflineSong(songId) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve) => {
      const req = store.get(String(songId));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function getAllOfflineSongs() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

export async function removeOfflineSong(songId) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    return new Promise((resolve) => {
      const req = store.delete(String(songId));
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch {
    return false;
  }
}
