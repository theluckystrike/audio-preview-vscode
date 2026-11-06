'use strict';
// Small helpers used by the webview. No DOM and no Buffer, so Node tests can run them.

function fmtTime(s, ms) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = ms ? sec.toFixed(2).padStart(5, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const fmtDb = (v, unit) => (v == null || !Number.isFinite(v) ? '-inf' : v.toFixed(1)) + (unit ? ' ' + unit : '');

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

const CHANNEL_NAMES = { 1: ['Mono'], 2: ['Left', 'Right'], 6: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'] };
const channelName = (n, i) => (CHANNEL_NAMES[n] ? CHANNEL_NAMES[n][i] : 'Ch ' + (i + 1));

/** Splits an ADTS stream into frames (header included). Skips a leading ID3 tag. */
function adtsFrames(u8) {
  const out = [];
  let p = 0;
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) p = 10 + (((u8[6] & 0x7f) << 21) | ((u8[7] & 0x7f) << 14) | ((u8[8] & 0x7f) << 7) | (u8[9] & 0x7f));
  while (p + 7 <= u8.length) {
    if (u8[p] !== 0xff || (u8[p + 1] & 0xf6) !== 0xf0) break;
    const len = ((u8[p + 3] & 3) << 11) | (u8[p + 4] << 3) | (u8[p + 5] >> 5);
    if (len < 7 || p + len > u8.length) break;
    const hdr = u8[p + 1] & 1 ? 7 : 9; // protection_absent = 1 means no CRC
    out.push({ start: p, end: p + len, hdr });
    p += len;
  }
  return out;
}

/** Reads the first Ogg Opus stream: OpusHead fields and the audio packets (tags skipped). */
function oggOpusStream(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const packets = []; let cur = [], curLen = 0, serial = null, p = 0;
  const flush = () => { const a = new Uint8Array(curLen); let o = 0; for (const c of cur) { a.set(c, o); o += c.length; } packets.push(a); cur = []; curLen = 0; };
  while (p + 27 <= u8.length) {
    if (u8[p] !== 0x4f || u8[p + 1] !== 0x67 || u8[p + 2] !== 0x67 || u8[p + 3] !== 0x53) break;
    const segs = u8[p + 26], sn = dv.getUint32(p + 14, true);
    if (serial === null) serial = sn;
    let q = p + 27 + segs;
    for (let s = 0; s < segs; s++) {
      const l = u8[p + 27 + s];
      if (sn === serial) { cur.push(u8.subarray(q, q + l)); curLen += l; if (l < 255) flush(); }
      q += l;
    }
    p = q;
  }
  const id = packets[0];
  if (!id || String.fromCharCode(...id.subarray(0, 8)) !== 'OpusHead') return null;
  const h = { channels: id[9], preSkip: id[10] | (id[11] << 8), family: id[18] };
  if (h.family !== 0 && id.length >= 21 + h.channels) { h.streamCount = id[19]; h.coupledStreamCount = id[20]; h.mapping = Array.from(id.subarray(21, 21 + h.channels)); }
  else if (h.channels <= 2) { h.streamCount = 1; h.coupledStreamCount = h.channels - 1; h.mapping = h.channels === 2 ? [0, 1] : [0]; }
  return { head: h, packets: packets.slice(2).filter(x => x.length) };
}

/** 16-bit PCM WAV bytes from planar Float32 data, so a decoded stream can play in an audio element. */
function encodeWav16(planes, sampleRate) {
  const ch = planes.length, n = planes[0].length, data = n * ch * 2;
  const buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + data, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, data, true);
  let p = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, planes[c][i])); v.setInt16(p, s < 0 ? s * 32768 : s * 32767, true); p += 2; }
  return buf;
}

/** Spectrogram colour map (dark blue, purple, orange, pale yellow). Returns [r, g, b] for 0..255. */
const STOPS = [[0, 4, 4, 18], [60, 40, 11, 84], [120, 120, 28, 109], [170, 200, 60, 70], [215, 246, 130, 30], [255, 252, 245, 170]];
function colorMap() {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    let k = 0; while (k < STOPS.length - 2 && i > STOPS[k + 1][0]) k++;
    const [a, b] = [STOPS[k], STOPS[k + 1]], t = (i - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * Math.max(0, Math.min(1, t)));
  }
  return lut;
}

/** Text block for "Copy stats". */
function statsText(meta, st) {
  const lines = [`File: ${meta.name}`, `Format: ${meta.codec}, ${meta.sampleRate} Hz, ${meta.channels} ch${meta.bitDepth ? ', ' + meta.bitDepth + '-bit' : ''}, ${fmtTime(meta.durationSec, true)}`,
    `Integrated loudness: ${fmtDb(st.integrated, 'LUFS')}`, `Short-term max: ${fmtDb(st.shortTermMax, 'LUFS')}`, `Momentary max: ${fmtDb(st.momentaryMax, 'LUFS')}`,
    `Sample peak: ${fmtDb(st.peakDb, 'dBFS')}`, `RMS: ${fmtDb(st.rmsDb, 'dBFS')}`, `Clipped samples: ${st.clipped}`];
  st.channels.forEach((c, i) => lines.push(`${channelName(meta.channels, i)}: peak ${fmtDb(c.peakDb, 'dBFS')}, RMS ${fmtDb(c.rmsDb, 'dBFS')}, DC ${c.dc == null ? '0' : c.dc.toFixed(5)}`));
  return lines.join('\n');
}

module.exports = { fmtTime, fmtDb, fmtBytes, channelName, adtsFrames, oggOpusStream, encodeWav16, colorMap, statsText };
