'use strict';
// Header and tag readers for WAV, MP3, FLAC, Ogg (Vorbis, Opus), MP4/M4A and ADTS AAC.
// They read small byte ranges from a source, so a 2 GB file costs a few reads.

const MAX_MOOV = 64 * 1048576;

class AudioFormatError extends Error {}

const latin1 = b => Buffer.from(b).toString('latin1');
const utf8 = b => Buffer.from(b).toString('utf8');
const clean = s => String(s).replace(/\u0000+$/g, '').replace(/\u0000/g, ' / ').trim();

function detect(head, name) {
  const s4 = latin1(head.subarray(0, 4)), ext = (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (s4 === 'RIFF' || s4 === 'RF64' || s4 === 'BW64') return 'wav';
  if (s4 === 'fLaC') return 'flac';
  if (s4 === 'OggS') return 'ogg';
  if (latin1(head.subarray(4, 8)) === 'ftyp') return 'mp4';
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return 'aac'; // ADTS sync, layer 00
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  if (s4.startsWith('ID3')) {
    if (ext === 'flac') return 'flac';
    if (ext === 'aac') return 'aac';
    return 'mp3';
  }
  const byExt = { wav: 'wav', wave: 'wav', mp3: 'mp3', flac: 'flac', ogg: 'ogg', oga: 'ogg', opus: 'ogg', m4a: 'mp4', mp4: 'mp4', aac: 'aac' };
  if (byExt[ext]) return byExt[ext];
  throw new AudioFormatError('This file does not look like WAV, MP3, FLAC, Ogg, Opus, M4A or AAC audio.');
}

// ---------- ID3 ----------
function decodeId3Text(b) {
  if (!b.length) return '';
  const enc = b[0], d = b.subarray(1);
  if (enc === 0) return clean(latin1(d));
  if (enc === 3) return clean(utf8(d));
  if (enc === 1 || enc === 2) {
    let le = enc === 1, off = 0;
    if (enc === 1 && d.length >= 2) { if (d[0] === 0xfe && d[1] === 0xff) { le = false; off = 2; } else if (d[0] === 0xff && d[1] === 0xfe) { off = 2; } }
    const body = Buffer.from(d.subarray(off, off + ((d.length - off) & ~1)));
    if (!le) body.swap16();
    return clean(body.toString('utf16le').replace(/﻿|￾/g, ''));
  }
  return clean(latin1(d));
}

const ID3_NAMES = {
  TIT2: 'Title', TT2: 'Title', TPE1: 'Artist', TP1: 'Artist', TALB: 'Album', TAL: 'Album', TPE2: 'Album artist', TP2: 'Album artist',
  TYER: 'Year', TYE: 'Year', TDRC: 'Date', TCON: 'Genre', TCO: 'Genre', TRCK: 'Track', TRK: 'Track', TPOS: 'Disc', TCOM: 'Composer', TCM: 'Composer',
  TSSE: 'Encoder', TSS: 'Encoder', TENC: 'Encoded by', TBPM: 'BPM', TKEY: 'Key', TCOP: 'Copyright', TPUB: 'Publisher', TSRC: 'ISRC',
};

/** Parses an ID3v2 tag. Returns { size, tags: [[k, v]], info: [[k, v]] } or null. */
function parseId3v2(b) {
  if (b.length < 10 || latin1(b.subarray(0, 3)) !== 'ID3') return null;
  const ver = b[3], flags = b[5];
  const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  const tags = [], info = [['ID3 version', `2.${ver}`]];
  let p = 10;
  const end = Math.min(b.length, 10 + size);
  if (flags & 0x40 && ver >= 3) { // extended header
    const ext = ver === 4 ? ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f) : b.readUInt32BE(p) + 4;
    p += ext;
  }
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  while (p + hdr <= end) {
    const id = latin1(b.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let fs;
    if (ver === 2) fs = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
    else if (ver === 4) fs = ((b[p + 4] & 0x7f) << 21) | ((b[p + 5] & 0x7f) << 14) | ((b[p + 6] & 0x7f) << 7) | (b[p + 7] & 0x7f);
    else fs = b.readUInt32BE(p + 4);
    const body = b.subarray(p + hdr, Math.min(end, p + hdr + fs));
    p += hdr + fs;
    if (fs <= 0) break;
    if (ID3_NAMES[id]) tags.push([ID3_NAMES[id], decodeId3Text(body)]);
    else if (id === 'COMM' || id === 'COM') { const enc = body[0]; const rest = body.subarray(4); const t = decodeId3Text(Buffer.concat([Buffer.from([enc]), rest])); const parts = t.split(' / '); tags.push(['Comment', parts.length > 1 ? parts.slice(1).join(' / ') : t]); }
    else if (id === 'TXXX' || id === 'TXX') { const t = decodeId3Text(body).split(' / '); tags.push([VC_NAMES[(t[0] || '').toUpperCase()] || t[0] || 'TXXX', t.slice(1).join(' / ')]); }
    else if (id === 'APIC' || id === 'PIC') info.push(['Cover art', `yes (${fs} bytes)`]);
  }
  return { size: total, tags: tags.filter(t => t[1] !== ''), info };
}

const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic'];

function parseId3v1(b) {
  if (b.length !== 128 || latin1(b.subarray(0, 3)) !== 'TAG') return null;
  const f = (s, e) => clean(latin1(b.subarray(s, e)));
  const tags = [['Title', f(3, 33)], ['Artist', f(33, 63)], ['Album', f(63, 93)], ['Year', f(93, 97)], ['Comment', f(97, 127)]];
  if (b[125] === 0 && b[126]) tags.push(['Track', String(b[126])]);
  if (GENRES[b[127]]) tags.push(['Genre', GENRES[b[127]]]);
  return tags.filter(t => t[1]);
}

// ---------- WAV ----------
const INFO_NAMES = { INAM: 'Title', IART: 'Artist', IPRD: 'Album', ICRD: 'Date', IGNR: 'Genre', ICMT: 'Comment', ISFT: 'Encoder', ITRK: 'Track', IPRT: 'Track', ICOP: 'Copyright', IENG: 'Engineer', IKEY: 'Keywords', ISBJ: 'Subject' };
const WAV_CODECS = { 1: 'PCM', 3: 'IEEE float', 6: 'A-law', 7: 'mu-law', 2: 'MS ADPCM', 0x11: 'IMA ADPCM', 0x55: 'MP3', 0xfffe: 'Extensible' };

async function readWav(src) {
  const head = await src.read(0, 12);
  if (head.length < 12 || latin1(head.subarray(8, 12)) !== 'WAVE') throw new AudioFormatError('The RIFF header is incomplete or is not WAVE.');
  const rf64 = latin1(head.subarray(0, 4)) !== 'RIFF';
  const m = { format: 'wav', tags: [], info: [] };
  let p = 12, fmt = null, dataOffset = -1, dataSize = 0, ds64Data = null, guard = 0;
  while (p + 8 <= src.size && guard++ < 10000) {
    const h = await src.read(p, 8);
    if (h.length < 8) break;
    const id = latin1(h.subarray(0, 4));
    let size = h.readUInt32LE(4);
    if (id === 'ds64') { const d = await src.read(p + 8, 28); if (d.length >= 24) ds64Data = Number(d.readBigUInt64LE(8)); }
    if (id === 'fmt ') {
      const f = await src.read(p + 8, Math.min(size, 64));
      if (f.length < 16) throw new AudioFormatError('The fmt chunk is too short.');
      fmt = { tag: f.readUInt16LE(0), channels: f.readUInt16LE(2), sampleRate: f.readUInt32LE(4), byteRate: f.readUInt32LE(8), blockAlign: f.readUInt16LE(12), bits: f.readUInt16LE(14) };
      if (fmt.tag === 0xfffe && f.length >= 26) { fmt.validBits = f.readUInt16LE(18); fmt.sub = f.readUInt16LE(24); }
    } else if (id === 'data') {
      dataOffset = p + 8;
      if (rf64 && size === 0xffffffff && ds64Data != null) size = ds64Data;
      dataSize = Math.min(size, src.size - dataOffset);
    } else if (id === 'LIST') {
      const l = await src.read(p + 8, Math.min(size, 65536));
      if (latin1(l.subarray(0, 4)) === 'INFO') {
        let q = 4;
        while (q + 8 <= l.length) {
          const k = latin1(l.subarray(q, q + 4)), n = l.readUInt32LE(q + 4);
          const v = clean(utf8(l.subarray(q + 8, q + 8 + n)));
          if (v) m.tags.push([INFO_NAMES[k] || k, v]);
          q += 8 + n + (n & 1);
        }
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      const t = parseId3v2(await src.read(p + 8, Math.min(size, 1048576)));
      if (t) { m.tags.push(...t.tags); m.info.push(...t.info); }
    } else if (id === 'bext') m.info.push(['Broadcast WAV', 'yes (bext chunk)']);
    else if (id === 'smpl') m.info.push(['Sampler loop data', 'yes (smpl chunk)']);
    else if (id === 'cue ') m.info.push(['Cue points', 'yes']);
    p += 8 + size + (size & 1);
  }
  if (!fmt) throw new AudioFormatError('No fmt chunk found: the WAV header is broken.');
  if (dataOffset < 0) throw new AudioFormatError('No data chunk found: the WAV file has no audio.');
  const tag = fmt.tag === 0xfffe ? fmt.sub : fmt.tag;
  const kind = tag === 1 ? 'int' : tag === 3 ? 'float' : tag === 6 ? 'alaw' : tag === 7 ? 'mulaw' : null;
  m.sampleRate = fmt.sampleRate; m.channels = fmt.channels; m.bitDepth = fmt.validBits || fmt.bits;
  m.codec = `${WAV_CODECS[tag] || 'format 0x' + tag.toString(16)}${kind === 'int' || kind === 'float' ? ' ' + fmt.bits + '-bit' : ''}${rf64 ? ' (RF64)' : ''}`;
  const frameBytes = fmt.blockAlign || (fmt.channels * fmt.bits / 8);
  m.totalFrames = frameBytes ? Math.floor(dataSize / frameBytes) : 0;
  m.durationSec = fmt.sampleRate ? m.totalFrames / fmt.sampleRate : 0;
  m.bitrate = fmt.byteRate * 8;
  const okBits = kind === 'int' ? [8, 16, 24, 32].includes(fmt.bits) : kind === 'float' ? [32, 64].includes(fmt.bits) : fmt.bits === 8;
  m.wav = kind && okBits && fmt.channels > 0 && frameBytes === fmt.channels * fmt.bits / 8 ? { kind, bits: fmt.bits, dataOffset, dataSize, blockAlign: frameBytes } : null;
  if (!m.wav) m.unsupported = `${m.codec} WAV data cannot be decoded here. PCM 8/16/24/32-bit, float 32/64-bit, A-law and mu-law are supported.`;
  return m;
}

// ---------- MP3 ----------
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_BITRATES = {
  '3-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function mp3Header(b, i) {
  if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[i + 1] >> 3) & 3, layerBits = (b[i + 1] >> 1) & 3, br = b[i + 2] >> 4, sr = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1, mode = b[i + 3] >> 6;
  if (ver === 1 || layerBits === 0 || br === 0 || br === 15 || sr === 3) return null;
  const layer = 4 - layerBits;
  const table = MP3_BITRATES[(ver === 3 ? '3-' : '2-') + (ver === 3 ? layer : layer === 1 ? 1 : 2)];
  const bitrate = table[br] * 1000, sampleRate = MP3_RATES[ver][sr];
  const spf = layer === 1 ? 384 : layer === 3 && ver !== 3 ? 576 : 1152;
  const len = layer === 1 ? (Math.floor(12 * bitrate / sampleRate) + pad) * 4 : Math.floor(spf / 8 * bitrate / sampleRate) + pad;
  return { ver, layer, bitrate, sampleRate, channels: mode === 3 ? 1 : 2, spf, len, mode };
}

async function readMp3(src) {
  const m = { format: 'mp3', tags: [], info: [] };
  let start = 0;
  const first = await src.read(0, 10);
  if (latin1(first.subarray(0, 3)) === 'ID3') {
    const sz = ((first[6] & 0x7f) << 21) | ((first[7] & 0x7f) << 14) | ((first[8] & 0x7f) << 7) | (first[9] & 0x7f);
    const t = parseId3v2(await src.read(0, Math.min(10 + sz, 4 * 1048576)));
    if (t) { m.tags.push(...t.tags); m.info.push(...t.info); start = t.size; }
  }
  const b = await src.read(start, 256 * 1024);
  let i = 0, h = null;
  for (; i + 4 < b.length; i++) {
    h = mp3Header(b, i);
    if (h && (i + h.len + 4 > b.length || mp3Header(b, i + h.len))) break; // two frames in a row
    h = null;
  }
  if (!h) throw new AudioFormatError('No MPEG audio frame found in the first 256 KB.');
  m.sampleRate = h.sampleRate; m.channels = h.channels; m.bitDepth = null;
  m.codec = `MPEG-${h.ver === 3 ? '1' : h.ver === 2 ? '2' : '2.5'} Layer ${['', 'I', 'II', 'III'][h.layer]}`;
  m.info.push(['Channel mode', ['Stereo', 'Joint stereo', 'Dual channel', 'Mono'][h.mode]]);
  const side = h.ver === 3 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
  const x = i + 4 + side, tagId = latin1(b.subarray(x, x + 4));
  const audioBytes = src.size - start - i;
  let frames = 0;
  if (tagId === 'Xing' || tagId === 'Info') {
    const flags = b.readUInt32BE(x + 4);
    if (flags & 1) frames = b.readUInt32BE(x + 8);
    m.info.push(['Bitrate mode', tagId === 'Xing' ? 'VBR' : 'CBR']);
    const enc = latin1(b.subarray(x + 120, x + 129)).replace(/[^\x20-\x7e]/g, '').trim();
    if (/^(LAME|Lavc|Lavf)/.test(enc)) {
      m.info.push(['Encoder', enc]);
      const d = x + 141; // LAME tag: 12-bit encoder delay, 12-bit padding
      if (d + 3 <= b.length) { const delay = (b[d] << 4) | (b[d + 1] >> 4), padding = ((b[d + 1] & 15) << 8) | b[d + 2]; if (delay < 4096 && padding < 4096) m.gapless = { delay, padding }; }
    }
  } else if (latin1(b.subarray(i + 36, i + 40)) === 'VBRI') {
    frames = b.readUInt32BE(i + 36 + 14);
    m.info.push(['Bitrate mode', 'VBR (VBRI)']);
  }
  if (frames) { m.durationSec = Math.max(0, frames * h.spf - (m.gapless ? m.gapless.delay + m.gapless.padding : 0)) / h.sampleRate; m.bitrate = Math.round(audioBytes * 8 / m.durationSec); }
  else { m.bitrate = h.bitrate; m.durationSec = audioBytes * 8 / h.bitrate; m.estimated = true; }
  m.totalFrames = Math.round(m.durationSec * m.sampleRate);
  if (src.size >= 128) {
    const v1 = parseId3v1(await src.read(src.size - 128, 128));
    if (v1) { m.info.push(['ID3v1', 'yes']); for (const t of v1) if (!m.tags.some(x => x[0] === t[0])) m.tags.push(t); }
  }
  return m;
}

// ---------- Vorbis comments (FLAC, Ogg) ----------
const VC_NAMES = { TITLE: 'Title', ARTIST: 'Artist', ALBUM: 'Album', ALBUMARTIST: 'Album artist', DATE: 'Date', GENRE: 'Genre', TRACKNUMBER: 'Track', DISCNUMBER: 'Disc', COMMENT: 'Comment', DESCRIPTION: 'Comment', COMPOSER: 'Composer', ENCODER: 'Encoder', COPYRIGHT: 'Copyright', ISRC: 'ISRC', BPM: 'BPM', LYRICS: 'Lyrics' };

function parseVorbisComment(b, m) {
  if (b.length < 8) return;
  let p = 0;
  const vl = b.readUInt32LE(p); p += 4;
  const vendor = utf8(b.subarray(p, p + vl)); p += vl;
  if (vendor) m.info.push(['Vendor', clean(vendor)]);
  if (p + 4 > b.length) return;
  const n = b.readUInt32LE(p); p += 4;
  for (let k = 0; k < n && p + 4 <= b.length; k++) {
    const l = b.readUInt32LE(p); p += 4;
    const s = utf8(b.subarray(p, p + l)); p += l;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).toUpperCase(), val = clean(s.slice(eq + 1));
    if (key === 'METADATA_BLOCK_PICTURE') { m.info.push(['Cover art', 'yes']); continue; }
    if (val) m.tags.push([VC_NAMES[key] || key, val]);
  }
}

// ---------- FLAC ----------
async function readFlac(src) {
  const m = { format: 'flac', tags: [], info: [] };
  let p = 0;
  const id = await src.read(0, 10);
  if (latin1(id.subarray(0, 3)) === 'ID3') { const t = parseId3v2(await src.read(0, 4 * 1048576)); if (t) { p = t.size; m.tags.push(...t.tags); } }
  if (latin1(await src.read(p, 4)) !== 'fLaC') throw new AudioFormatError('The fLaC marker is missing: this is not a FLAC file.');
  p += 4;
  let last = false, info = null, guard = 0;
  while (!last && p + 4 <= src.size && guard++ < 1000) {
    const h = await src.read(p, 4);
    if (h.length < 4) break;
    last = !!(h[0] & 0x80);
    const type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 0) info = await src.read(p + 4, 34);
    else if (type === 4) parseVorbisComment(await src.read(p + 4, Math.min(len, 1048576)), m);
    else if (type === 6) m.info.push(['Cover art', `yes (${len} bytes)`]);
    else if (type === 3) m.info.push(['Seek table', 'yes']);
    p += 4 + len;
  }
  if (!info || info.length < 34) throw new AudioFormatError('The FLAC STREAMINFO block is missing or cut short.');
  m.sampleRate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4);
  m.channels = ((info[12] >> 1) & 7) + 1;
  m.bitDepth = (((info[12] & 1) << 4) | (info[13] >> 4)) + 1;
  m.totalFrames = (info[13] & 15) * 2 ** 32 + info.readUInt32BE(14);
  m.durationSec = m.sampleRate ? m.totalFrames / m.sampleRate : 0;
  m.bitrate = m.durationSec ? Math.round((src.size - p) * 8 / m.durationSec) : 0;
  m.codec = `FLAC ${m.bitDepth}-bit`;
  const md5 = info.subarray(18, 34).toString('hex');
  if (!/^0+$/.test(md5)) m.info.push(['MD5 of audio', md5]);
  return m;
}

// ---------- Ogg ----------
function oggPackets(b, maxPackets) {
  const packets = []; let cur = []; let p = 0, serial = null;
  while (p + 27 <= b.length && packets.length < maxPackets) {
    if (latin1(b.subarray(p, p + 4)) !== 'OggS') break;
    const segs = b[p + 26];
    if (serial === null) serial = b.readUInt32LE(p + 14);
    let q = p + 27 + segs;
    for (let s = 0; s < segs; s++) {
      const l = b[p + 27 + s];
      cur.push(b.subarray(q, q + l)); q += l;
      if (l < 255) { packets.push(Buffer.concat(cur)); cur = []; }
    }
    p = q;
  }
  return { packets, serial };
}

async function readOgg(src) {
  const m = { format: 'ogg', tags: [], info: [] };
  const { packets, serial } = oggPackets(await src.read(0, 1048576), 2);
  if (!packets.length) throw new AudioFormatError('No Ogg page found.');
  const id = packets[0];
  let granuleRate, preSkip = 0;
  if (latin1(id.subarray(0, 8)) === 'OpusHead') {
    m.format = 'opus'; m.codec = 'Opus'; m.channels = id[9]; preSkip = id.readUInt16LE(10);
    m.sampleRate = 48000; granuleRate = 48000;
    const inRate = id.readUInt32LE(12);
    if (inRate) m.info.push(['Original sample rate', `${inRate} Hz`]);
    if (packets[1] && latin1(packets[1].subarray(0, 8)) === 'OpusTags') parseVorbisComment(packets[1].subarray(8), m);
  } else if (id[0] === 1 && latin1(id.subarray(1, 7)) === 'vorbis') {
    m.codec = 'Vorbis'; m.channels = id[11]; m.sampleRate = id.readUInt32LE(12); granuleRate = m.sampleRate;
    const nominal = id.readInt32LE(20);
    if (nominal > 0) m.nominalBitrate = nominal;
    if (packets[1] && packets[1][0] === 3) parseVorbisComment(packets[1].subarray(7), m);
  } else if (latin1(id.subarray(1, 5)) === 'FLAC') {
    throw new AudioFormatError('Ogg FLAC is not supported. Native .flac files are.');
  } else throw new AudioFormatError('This Ogg stream is not Vorbis or Opus.');
  m.bitDepth = null;
  // duration: granule position of the last page of the first stream
  const tail = await src.read(Math.max(0, src.size - 65536), 65536);
  let granule = 0;
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] === 0x4f && latin1(tail.subarray(i, i + 4)) === 'OggS' && tail.readUInt32LE(i + 14) === serial) {
      const g = Number(tail.readBigInt64LE(i + 6));
      if (g > 0) { granule = g; break; }
    }
  }
  m.durationSec = granule ? Math.max(0, granule - preSkip) / granuleRate : 0;
  m.totalFrames = Math.round(m.durationSec * m.sampleRate);
  m.bitrate = m.durationSec ? Math.round(src.size * 8 / m.durationSec) : m.nominalBitrate || 0;
  return m;
}

// ---------- MP4 / M4A ----------
function boxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = b.readUInt32BE(p); const type = latin1(b.subarray(p + 4, p + 8)); let hdr = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const child = (b, box, type, skip = 0) => box && boxes(b, box.start + skip, box.end).find(x => x.type === type);

const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const AOT = { 1: 'AAC Main', 2: 'AAC-LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'HE-AAC (SBR)', 29: 'HE-AAC v2 (PS)', 23: 'AAC-LD', 39: 'AAC-ELD' };
const ILST = { '©nam': 'Title', '©ART': 'Artist', '©alb': 'Album', aART: 'Album artist', '©day': 'Date', '©gen': 'Genre', '©wrt': 'Composer', '©too': 'Encoder', '©cmt': 'Comment', cprt: 'Copyright', '©lyr': 'Lyrics', tmpo: 'BPM' };

function readDescLen(b, p) { let len = 0, i = 0; for (; i < 4; i++) { const c = b[p + i]; len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; } return { len, n: i + 1 }; }

function parseEsds(b, box) {
  const r = { oti: 0, asc: null, avgBitrate: 0 };
  let p = box.start + 4;
  const end = box.end;
  while (p < end) {
    const tag = b[p]; const { len, n } = readDescLen(b, p + 1); const body = p + 1 + n;
    if (tag === 3) { const flags = b[body + 2]; p = body + 3 + (flags & 0x80 ? 2 : 0) + (flags & 0x40 ? 1 + b[body + 3] : 0) + (flags & 0x20 ? 2 : 0); continue; }
    if (tag === 4) { r.oti = b[body]; r.avgBitrate = b.readUInt32BE(body + 9); p = body + 13; continue; }
    if (tag === 5) { r.asc = Buffer.from(b.subarray(body, body + len)); break; }
    p = body + len;
  }
  return r;
}

function parseAsc(asc) {
  if (!asc || asc.length < 2) return null;
  let aot = asc[0] >> 3, fi = ((asc[0] & 7) << 1) | (asc[1] >> 7);
  const ch = (asc[1] >> 3) & 15;
  if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
  return { aot, sampleRate: AAC_RATES[fi] || 0, channels: ch };
}

async function readMp4(src) {
  const m = { format: 'm4a', tags: [], info: [] };
  let p = 0, moov = null, guard = 0, brand = '';
  while (p + 8 <= src.size && guard++ < 10000) {
    const h = await src.read(p, 16);
    let size = h.readUInt32BE(0); const type = latin1(h.subarray(4, 8));
    if (size === 1) size = Number(h.readBigUInt64BE(8)); else if (size === 0) size = src.size - p;
    if (size < 8) break;
    if (type === 'ftyp') brand = latin1(h.subarray(8, 12)).trim();
    if (type === 'moov') {
      if (size > MAX_MOOV) throw new AudioFormatError('The moov box is larger than 64 MB.');
      moov = await src.read(p, size);
      break;
    }
    p += size;
  }
  if (!moov) throw new AudioFormatError('No moov box found: the MP4 file is incomplete.');
  if (brand) m.info.push(['Brand', brand]);
  const root = { start: 8, end: moov.length };
  const traks = boxes(moov, root.start, root.end).filter(x => x.type === 'trak');
  let found = null;
  for (const t of traks) {
    const mdia = child(moov, t, 'mdia'); const hdlr = child(moov, mdia, 'hdlr');
    if (hdlr && latin1(moov.subarray(hdlr.start + 8, hdlr.start + 12)) === 'soun') { found = { t, mdia }; break; }
  }
  if (!found) throw new AudioFormatError('This MP4 file has no audio track.');
  if (traks.some(t => { const h = child(moov, child(moov, t, 'mdia'), 'hdlr'); return h && latin1(moov.subarray(h.start + 8, h.start + 12)) === 'vide'; })) m.info.push(['Video track', 'yes (audio only is shown)']);
  const mdhd = child(moov, found.mdia, 'mdhd');
  const v = moov[mdhd.start];
  const timescale = v === 1 ? moov.readUInt32BE(mdhd.start + 20) : moov.readUInt32BE(mdhd.start + 12);
  const dur = v === 1 ? Number(moov.readBigUInt64BE(mdhd.start + 24)) : moov.readUInt32BE(mdhd.start + 16);
  m.durationSec = timescale ? dur / timescale : 0;
  const stbl = child(moov, child(moov, found.mdia, 'minf'), 'stbl');
  const stsd = child(moov, stbl, 'stsd');
  const entry = boxes(moov, stsd.start + 8, stsd.end)[0];
  if (!entry) throw new AudioFormatError('The audio track has no sample description.');
  m.channels = moov.readUInt16BE(entry.start + 16);
  m.bitDepth = null;
  m.sampleRate = moov.readUInt32BE(entry.start + 24) >>> 16;
  const sub = boxes(moov, entry.start + 28, entry.end);
  if (entry.type === 'mp4a') {
    const esds = sub.find(x => x.type === 'esds');
    const e = esds ? parseEsds(moov, esds) : { oti: 0x40 };
    const a = parseAsc(e.asc);
    if (e.oti === 0x40 || e.oti === 0x67 || e.oti === 0x66) {
      m.codec = a ? AOT[a.aot] || `AAC (object type ${a.aot})` : 'AAC';
      m.codecString = `mp4a.40.${a ? a.aot : 2}`;
      if (a && a.sampleRate && (a.aot === 2 || !m.sampleRate)) m.sampleRate = a.sampleRate;
      if (a && a.channels) m.channels = a.channels;
    } else if (e.oti === 0x6b || e.oti === 0x69) { m.codec = 'MP3 in MP4'; m.codecString = 'mp3'; }
    else m.codec = `mp4a (object type 0x${e.oti.toString(16)})`;
    if (e.avgBitrate) m.bitrate = e.avgBitrate;
    m.asc = e.asc;
  } else if (entry.type === 'alac') { m.codec = 'Apple Lossless (ALAC)'; m.codecString = 'alac'; const ab = sub.find(x => x.type === 'alac'); if (ab) m.bitDepth = moov[ab.start + 9]; }
  else if (entry.type === 'Opus') { m.codec = 'Opus in MP4'; m.codecString = 'opus'; }
  else if (entry.type === 'fLaC') { m.codec = 'FLAC in MP4'; m.codecString = 'flac'; }
  else if (entry.type === 'ac-3' || entry.type === 'ec-3') { m.codec = entry.type === 'ac-3' ? 'Dolby AC-3' : 'Dolby E-AC-3'; m.codecString = entry.type; }
  else m.codec = entry.type;
  // sample table, used by the WebCodecs path
  const stsz = child(moov, stbl, 'stsz'), stsc = child(moov, stbl, 'stsc');
  const stco = child(moov, stbl, 'stco') || child(moov, stbl, 'co64');
  if (stsz && stsc && stco) {
    const fixed = moov.readUInt32BE(stsz.start + 4), count = moov.readUInt32BE(stsz.start + 8);
    const sizes = new Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || moov.readUInt32BE(stsz.start + 12 + i * 4);
    const nChunks = moov.readUInt32BE(stco.start + 4), is64 = stco.type === 'co64';
    const chunkOff = i => (is64 ? Number(moov.readBigUInt64BE(stco.start + 8 + i * 8)) : moov.readUInt32BE(stco.start + 8 + i * 4));
    const nsc = moov.readUInt32BE(stsc.start + 4), runs = [];
    for (let i = 0; i < nsc; i++) runs.push([moov.readUInt32BE(stsc.start + 8 + i * 12), moov.readUInt32BE(stsc.start + 12 + i * 12)]);
    const offsets = new Array(count);
    let s = 0;
    for (let r = 0; r < runs.length; r++) {
      const firstChunk = runs[r][0] - 1, lastChunk = r + 1 < runs.length ? runs[r + 1][0] - 1 : nChunks;
      for (let c = firstChunk; c < lastChunk && s < count; c++) {
        let o = chunkOff(c);
        for (let k = 0; k < runs[r][1] && s < count; k++) { offsets[s] = o; o += sizes[s]; s++; }
      }
    }
    m.samples = { offsets: offsets.slice(0, s), sizes: sizes.slice(0, s) };
    if (!m.bitrate && m.durationSec) m.bitrate = Math.round(sizes.reduce((a, b) => a + b, 0) * 8 / m.durationSec);
  }
  // iTunes tags: moov/udta/meta/ilst
  const meta = child(moov, child(moov, root, 'udta'), 'meta', 0);
  const ilst = meta && boxes(moov, meta.start + 4, meta.end).find(x => x.type === 'ilst');
  if (ilst) {
    for (const it of boxes(moov, ilst.start, ilst.end)) {
      const data = boxes(moov, it.start, it.end).find(x => x.type === 'data');
      if (!data) continue;
      const kind = moov.readUInt32BE(data.start) & 0xffffff, payload = moov.subarray(data.start + 8, data.end);
      if (it.type === 'covr') { m.info.push(['Cover art', `yes (${payload.length} bytes)`]); continue; }
      if (it.type === 'trkn' || it.type === 'disk') { if (payload.length >= 6) m.tags.push([it.type === 'trkn' ? 'Track' : 'Disc', `${payload.readUInt16BE(2)}${payload.readUInt16BE(4) ? '/' + payload.readUInt16BE(4) : ''}`]); continue; }
      if (it.type === 'tmpo' && payload.length >= 2) { m.tags.push(['BPM', String(payload.readUInt16BE(0))]); continue; }
      if (kind === 1 && ILST[it.type]) { const val = clean(utf8(payload)); if (val) m.tags.push([ILST[it.type], val]); }
    }
  }
  m.totalFrames = Math.round(m.durationSec * m.sampleRate);
  return m;
}

// ---------- ADTS AAC ----------
async function readAdts(src) {
  const m = { format: 'aac', tags: [], info: [] };
  let start = 0;
  const first = await src.read(0, 10);
  if (latin1(first.subarray(0, 3)) === 'ID3') { const t = parseId3v2(await src.read(0, 4 * 1048576)); if (t) { start = t.size; m.tags.push(...t.tags); } }
  const scanBytes = Math.min(src.size - start, 32 * 1048576);
  const b = await src.read(start, scanBytes);
  if (!(b[0] === 0xff && (b[1] & 0xf6) === 0xf0)) throw new AudioFormatError('No ADTS frame found at the start of the file.');
  const aot = (b[2] >> 6) + 1, fi = (b[2] >> 2) & 15, ch = ((b[2] & 1) << 2) | (b[3] >> 6);
  m.sampleRate = AAC_RATES[fi] || 0; m.channels = ch; m.bitDepth = null;
  m.codec = `${AOT[aot] || 'AAC'} (ADTS)`; m.codecString = `mp4a.40.${aot}`;
  let p = 0, frames = 0;
  while (p + 7 <= b.length && b[p] === 0xff && (b[p + 1] & 0xf6) === 0xf0) {
    const len = ((b[p + 3] & 3) << 11) | (b[p + 4] << 3) | (b[p + 5] >> 5);
    if (len < 7) break;
    frames += (b[p + 6] & 3) + 1; p += len;
  }
  const secs = frames * 1024 / (m.sampleRate || 44100);
  if (scanBytes < src.size - start && p) { m.durationSec = secs * (src.size - start) / p; m.estimated = true; } else m.durationSec = secs;
  m.bitrate = m.durationSec ? Math.round((src.size - start) * 8 / m.durationSec) : 0;
  m.totalFrames = Math.round(m.durationSec * m.sampleRate);
  return m;
}

/** Reads format, stream parameters and tags. */
async function readMetadata(src, name) {
  if (!src.size) throw new AudioFormatError('The file is empty.');
  const head = await src.read(0, 12);
  const kind = detect(head, name);
  const m = kind === 'wav' ? await readWav(src) : kind === 'mp3' ? await readMp3(src) : kind === 'flac' ? await readFlac(src)
    : kind === 'ogg' ? await readOgg(src) : kind === 'mp4' ? await readMp4(src) : await readAdts(src);
  m.fileSize = src.size;
  // keep only the first value of each tag name, in file order
  const seen = new Set();
  m.tags = m.tags.filter(([k, v]) => { const key = k + '\u0000' + v; if (seen.has(key)) return false; seen.add(key); return true; });
  return m;
}

module.exports = { readMetadata, detect, parseId3v2, parseId3v1, parseAsc, mp3Header, AudioFormatError };
