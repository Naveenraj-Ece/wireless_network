import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Scaled Ragas / Scales
const SCALES = {
  mohanam: [1, 9/8, 5/4, 3/2, 5/3, 2, 5/3, 3/2], // Major pentatonic (Bhoopali/Mohanam)
  kalyani: [1, 9/8, 5/4, 45/32, 3/2, 5/3, 15/8, 2], // Lydian (Kalyani)
  mayamalavagowla: [1, 16/15, 5/4, 4/3, 3/2, 8/5, 15/8, 2], // Hijaz / Bhairav
  kuthu: [1, 9/8, 4/3, 3/2, 9/5, 2, 9/5, 3/2],
  melody: [1, 9/8, 6/5, 4/3, 3/2, 8/5, 9/5, 2], // Natabhairavi / Minor
};

function createWavBuffer({ durationSec = 16, sampleRate = 22050, bpm = 120, baseFreq = 220, scale = 'mohanam', genre = 'Melody' }) {
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const ratios = SCALES[scale] || SCALES.mohanam;
  const beatSec = 60 / bpm;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const beat = t / beatSec;
    const noteIdx = Math.floor(beat * 2) % ratios.length;
    const freq = baseFreq * ratios[noteIdx];

    // Main melody note
    const env = Math.exp(-((beat * 2) % 1) * 2.8);
    let melody = (
      Math.sin(2 * Math.PI * freq * t) * 0.55 +
      Math.sin(4 * Math.PI * freq * t) * 0.22 +
      Math.sin(6 * Math.PI * freq * t) * 0.12
    ) * env * 0.42;

    // Rich chord pad / drone
    const drone = (
      Math.sin(2 * Math.PI * baseFreq * t) * 0.12 +
      Math.sin(2 * Math.PI * (baseFreq * 1.5) * t) * 0.08
    );

    // Bassline
    const bassFreq = (baseFreq * 0.5) * (noteIdx % 2 === 0 ? 1 : 0.75);
    const bass = Math.sin(2 * Math.PI * bassFreq * t) * 0.22;

    // Percussion / rhythm
    let drum = 0;
    const beatFraction = beat % 1;
    if (beatFraction < 0.12) {
      // Kick drum
      drum += Math.sin(2 * Math.PI * 68 * Math.exp(-beatFraction * 24) * t) * Math.exp(-beatFraction * 26) * 0.38;
    }
    if ((beat % 0.5) < 0.07) {
      // Hi-hat / tap
      drum += (Math.random() * 2 - 1) * Math.exp(-(beat % 0.5) * 38) * 0.12;
    }
    if (genre.toLowerCase().includes('kuthu') && (beat % 0.25) < 0.05) {
      // Kuthu dholak roll
      drum += (Math.random() * 2 - 1) * 0.1 * Math.exp(-(beat % 0.25) * 40);
    }

    const mixed = Math.max(-0.95, Math.min(0.95, melody + drone + bass + drum));
    const sampleVal = Math.floor(mixed * 32767);
    buffer.writeInt16LE(sampleVal, 44 + i * 2);
  }
  return buffer;
}

const csvPath = path.join(__dirname, '..', 'server', 'data', 'songs.csv');
const raw = fs.readFileSync(csvPath, 'utf8');
const lines = raw.trim().split('\n').slice(1);

const publicAudioDir = path.join(__dirname, '..', 'public', 'audio');
if (!fs.existsSync(publicAudioDir)) fs.mkdirSync(publicAudioDir, { recursive: true });

console.log(`Generating audio files for ${lines.length} songs...`);

lines.forEach((line) => {
  const [id, title, artist, movie, genre, mood, bpm] = line.split(',');
  const bpmNum = parseInt(bpm) || 120;
  
  let scale = 'mohanam';
  if (genre?.toLowerCase().includes('kuthu')) scale = 'kuthu';
  else if (genre?.toLowerCase().includes('arabic')) scale = 'mayamalavagowla';
  else if (genre?.toLowerCase().includes('melody') || mood?.toLowerCase() === 'sad') scale = 'melody';
  else if (mood?.toLowerCase() === 'energetic') scale = 'kalyani';

  const baseFreq = 220 + (parseInt(id) % 5) * 20;

  const buf = createWavBuffer({
    durationSec: 15,
    sampleRate: 22050,
    bpm: bpmNum,
    baseFreq,
    scale,
    genre: genre || 'Melody'
  });

  const outPath = path.join(publicAudioDir, `song_${id}.wav`);
  fs.writeFileSync(outPath, buf);
});

console.log('✅ Generated 30 audio files in public/audio/');
