'use strict';
/* global acquireVsCodeApi, AudioDecoder, EncodedAudioChunk, OfflineAudioContext */
// Webview UI. All file content goes into the DOM through textContent, never as HTML.
const { Analyzer } = require('../core/analysis');
const { fmtTime, fmtDb, fmtBytes, channelName, adtsFrames, oggOpusStream, encodeWav16, colorMap, statsText } = require('../core/webutil');
const { OpusDecoder } = require('opus-decoder');

const vscode = acquireVsCodeApi();
const app = document.getElementById('app');
const LUT = colorMap();
const S = { meta: null, plan: null, src: null, result: null, loop: { a: null, b: null, on: false }, drag: null, planes: null };
const audio = new Audio();
audio.preload = 'auto';
audio.preservesPitch = true;

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k === 'style') for (const d of v.split(';')) { const i = d.indexOf(':'); if (i > 0) e.style.setProperty(d.slice(0, i).trim(), d.slice(i + 1).trim()); } // CSSOM: allowed by the CSP
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
const $ = id => document.getElementById(id);

// ---------- layout ----------
function renderShell() {
  const m = S.meta;
  const facts = [m.codec, m.sampleRate ? (m.sampleRate / 1000).toFixed(m.sampleRate % 1000 ? 1 : 0) + ' kHz' : null, m.channels ? (m.channels === 1 ? 'mono' : m.channels === 2 ? 'stereo' : m.channels + ' ch') : null,
    m.bitDepth ? m.bitDepth + '-bit' : null, (m.estimated ? '~' : '') + fmtTime(m.durationSec, true), m.bitrate ? Math.round(m.bitrate / 1000) + ' kb/s' : null, fmtBytes(m.fileSize)].filter(Boolean);
  const title = (m.tags.find(t => t[0] === 'Title') || [])[1], artist = (m.tags.find(t => t[0] === 'Artist') || [])[1];
  app.textContent = '';
  app.append(
    el('header', { class: 'top' },
      el('div', { class: 'name' }, el('span', { class: 'badge', text: m.format.toUpperCase() }), el('span', { class: 'file', text: m.name }),
        title ? el('span', { class: 'song', text: (artist ? artist + ' - ' : '') + title }) : null),
      el('div', { class: 'facts', text: facts.join('  ·  ') })),
    el('div', { class: 'transport' },
      el('button', { id: 'play', class: 'primary', title: 'Play or pause (Space)', text: 'Play', onclick: togglePlay }),
      el('span', { id: 'time', class: 'time', text: `0:00.00 / ${fmtTime(m.durationSec, true)}` }),
      el('label', { class: 'ctl' }, 'Speed ', el('select', { id: 'speed', title: 'Playback speed, pitch kept', onchange: e => { audio.playbackRate = Number(e.target.value); } },
        ...[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(v => { const o = el('option', { value: String(v), text: v + 'x' }); if (v === 1) o.selected = true; return o; }))),
      el('label', { class: 'ctl' }, 'Volume ', el('input', { id: 'vol', type: 'range', min: '0', max: '1', step: '0.01', value: '0.8', oninput: e => { audio.volume = Number(e.target.value); } })),
      el('span', { class: 'sep' }),
      el('button', { id: 'loop', title: 'Loop the region (L). Drag on the waveform to set it.', text: 'Loop off', onclick: toggleLoop }),
      el('button', { title: 'Set loop start at the playhead ([)', text: 'Set A', onclick: () => setLoopPoint('a') }),
      el('button', { title: 'Set loop end at the playhead (])', text: 'Set B', onclick: () => setLoopPoint('b') }),
      el('button', { title: 'Clear the loop region', text: 'Clear', onclick: clearLoop }),
      el('span', { id: 'loopinfo', class: 'muted' })),
    el('div', { id: 'status', class: 'status' }),
    el('div', { id: 'views', class: 'views' },
      el('div', { class: 'lane' }, el('canvas', { id: 'wave' }), el('div', { id: 'waveaxis', class: 'yaxis' })),
      el('div', { class: 'lane' }, el('canvas', { id: 'spec' }), el('div', { id: 'specaxis', class: 'yaxis' })),
      el('div', { id: 'region', class: 'region' }), el('div', { id: 'head', class: 'playhead' }), el('div', { id: 'hover', class: 'hover' })),
    el('div', { id: 'taxis', class: 'taxis' }),
    el('div', { class: 'panels' },
      el('section', { class: 'panel' }, el('h2', { text: 'Loudness' }), el('div', { id: 'stats', class: 'stats' }, el('p', { class: 'muted', text: 'Waiting for the samples...' }))),
      el('section', { class: 'panel' }, el('h2', { text: 'File' }), metaTable()),
      el('section', { class: 'panel' }, el('h2', { text: 'Tags' }), tagTable())),
  );
  const views = $('views');
  views.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  views.addEventListener('mouseleave', () => { $('hover').style.display = 'none'; });
  views.addEventListener('dblclick', clearLoop);
  drawAxes();
}

function kv(rows) {
  const t = el('table', { class: 'kv' });
  for (const [k, v] of rows) t.append(el('tr', {}, el('th', { text: k }), el('td', { text: String(v) })));
  return t;
}
function metaTable() {
  const m = S.meta;
  const rows = [['Format', m.format.toUpperCase()], ['Codec', m.codec], ['Sample rate', m.sampleRate ? m.sampleRate + ' Hz' : 'unknown'], ['Channels', m.channels || 'unknown'],
    ['Bit depth', m.bitDepth ? m.bitDepth + '-bit' : 'n/a (lossy)'], ['Duration', (m.estimated ? 'about ' : '') + fmtTime(m.durationSec, true)], ['Bitrate', m.bitrate ? Math.round(m.bitrate / 1000) + ' kb/s' : 'unknown'],
    ['File size', fmtBytes(m.fileSize)], ...m.info];
  return kv(rows);
}
function tagTable() { return S.meta.tags.length ? kv(S.meta.tags) : el('p', { class: 'muted', text: 'No tags in this file.' }); }

function setStatus(text, kind, extra) {
  const s = $('status');
  if (!s) return;
  s.textContent = '';
  s.className = 'status' + (kind ? ' ' + kind : '');
  if (text) s.append(el('span', { text }));
  if (extra) s.append(extra);
}

// ---------- drawing ----------
function sizeCanvas(c, h) {
  const w = c.parentElement.clientWidth - 56, dpr = window.devicePixelRatio || 1;
  c.style.width = w + 'px'; c.style.height = h + 'px'; c.width = Math.max(1, Math.round(w * dpr)); c.height = Math.round(h * dpr);
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
const css = n => getComputedStyle(document.body).getPropertyValue(n).trim();

function drawWave() {
  const c = $('wave'); if (!c) return;
  const ch = Math.max(1, Math.min(S.meta.channels || 1, 8));
  const laneH = ch > 2 ? 48 : 80;
  const { g, w, h } = sizeCanvas(c, laneH * ch);
  g.clearRect(0, 0, w, h);
  const color = css('--vscode-charts-blue') || '#3794ff';
  for (let k = 0; k < ch; k++) {
    const top = k * laneH, mid = top + laneH / 2, amp = laneH / 2 - 3;
    g.fillStyle = 'rgba(128,128,128,0.08)'; g.fillRect(0, top + 1, w, laneH - 2);
    g.fillStyle = 'rgba(128,128,128,0.35)'; g.fillRect(0, mid, w, 1);
    if (!S.result) continue;
    const wf = S.result.waveform, mn = wf.min[k], mx = wf.max[k], B = wf.buckets;
    g.fillStyle = color;
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor(x * B / w), b1 = Math.max(b0 + 1, Math.floor((x + 1) * B / w));
      let lo = 1, hi = -1;
      for (let b = b0; b < b1 && b < B; b++) { if (mn[b] < lo) lo = mn[b]; if (mx[b] > hi) hi = mx[b]; }
      if (hi < lo) continue;
      const y0 = mid - hi * amp, y1 = mid - lo * amp;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    g.fillStyle = css('--vscode-descriptionForeground') || '#999'; g.font = '10px sans-serif';
    g.fillText(channelName(S.meta.channels, k), 4, top + 12);
  }
}

function drawSpec() {
  const c = $('spec'); if (!c) return;
  const { g, w, h } = sizeCanvas(c, 180);
  g.fillStyle = '#04040f'; g.fillRect(0, 0, w, h);
  if (!S.result) return;
  const sp = S.result.spectrogram;
  const data = sp.data || Uint8Array.from(atob(sp.b64), ch => ch.charCodeAt(0));
  const img = new ImageData(sp.cols, sp.rows);
  for (let i = 0; i < data.length; i++) { const v = data[i] * 3; img.data[i * 4] = LUT[v]; img.data[i * 4 + 1] = LUT[v + 1]; img.data[i * 4 + 2] = LUT[v + 2]; img.data[i * 4 + 3] = 255; }
  const off = document.createElement('canvas'); off.width = sp.cols; off.height = sp.rows;
  off.getContext('2d').putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(off, 0, 0, w, h);
}

function drawAxes() {
  const m = S.meta, dur = m.durationSec || 0;
  const ta = $('taxis'); ta.textContent = '';
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const step = steps.find(s => dur / s <= 10) || 3600;
  for (let t = 0; t <= dur + 1e-9 && dur > 0; t += step) ta.append(el('span', { style: `left:${((t / dur) * 100).toFixed(3)}%`, text: fmtTime(t, step < 1) }));
  const sa = $('specaxis'); sa.textContent = '';
  if (S.result) {
    const sp = S.result.spectrogram, lo = sp.minHz, hi = sp.maxHz;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (f < lo || f > hi) continue;
      const y = 1 - Math.log(f / lo) / Math.log(hi / lo);
      sa.append(el('span', { style: `top:${(y * 100).toFixed(2)}%`, text: f >= 1000 ? f / 1000 + 'k' : String(f) }));
    }
  }
  const wa = $('waveaxis'); wa.textContent = '';
}

function drawAll() { drawWave(); drawSpec(); drawAxes(); updateOverlay(); }
window.addEventListener('resize', () => { if (S.meta) drawAll(); });

// ---------- transport ----------
const dur = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : S.meta ? S.meta.durationSec : 0);
function togglePlay() {
  if (S.failed && S.audioError) { setStatus(S.failed, 'warn'); return; }
  if (audio.paused) {
    if (S.loop.on && S.loop.b != null && (audio.currentTime < S.loop.a || audio.currentTime >= S.loop.b)) audio.currentTime = S.loop.a;
    audio.play().catch(e => setStatus('Playback failed: ' + e.message, 'warn'));
  } else audio.pause();
}
function seek(t) { audio.currentTime = Math.max(0, Math.min(dur(), t)); updateOverlay(); }
function setLoopPoint(k) {
  S.loop[k] = audio.currentTime;
  if (S.loop.a != null && S.loop.b != null && S.loop.b < S.loop.a) [S.loop.a, S.loop.b] = [S.loop.b, S.loop.a];
  if (S.loop.a != null && S.loop.b != null) S.loop.on = true;
  loopUi();
}
function clearLoop() { S.loop = { a: null, b: null, on: false }; loopUi(); }
function toggleLoop() { if (S.loop.a == null || S.loop.b == null) { S.loop.a = 0; S.loop.b = dur(); } S.loop.on = !S.loop.on; loopUi(); }
function loopUi() {
  const b = $('loop'); if (!b) return;
  b.textContent = S.loop.on ? 'Loop on' : 'Loop off';
  b.classList.toggle('on', S.loop.on);
  $('loopinfo').textContent = S.loop.a != null && S.loop.b != null ? `${fmtTime(S.loop.a, true)} to ${fmtTime(S.loop.b, true)}` : '';
  updateOverlay();
}
function updateOverlay() {
  const d = dur(), views = $('views'); if (!views || !d) return;
  const w = views.clientWidth - 56;
  $('head').style.transform = `translateX(${(audio.currentTime / d) * w}px)`;
  const r = $('region');
  if (S.loop.a != null && S.loop.b != null) { r.style.display = 'block'; r.style.left = (S.loop.a / d) * w + 'px'; r.style.width = Math.max(1, ((S.loop.b - S.loop.a) / d) * w) + 'px'; r.classList.toggle('on', S.loop.on); }
  else r.style.display = 'none';
  const t = $('time'); if (t) t.textContent = `${fmtTime(audio.currentTime, true)} / ${fmtTime(d, true)}`;
}
function frame() {
  if (S.loop.on && S.loop.b != null && !audio.paused && audio.currentTime >= S.loop.b) audio.currentTime = S.loop.a;
  if (!audio.paused) updateOverlay();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
audio.addEventListener('play', () => { const b = $('play'); if (b) b.textContent = 'Pause'; });
audio.addEventListener('pause', () => { const b = $('play'); if (b) b.textContent = 'Play'; updateOverlay(); });
audio.addEventListener('ended', () => { if (S.loop.on && S.loop.a != null) { audio.currentTime = S.loop.a; audio.play().catch(() => {}); } });
audio.addEventListener('loadedmetadata', () => { if (S.meta) drawAxes(); updateOverlay(); });
audio.addEventListener('error', () => { S.audioError = true; maybeBlobPlayback(); });

function timeAt(ev) {
  const r = $('wave').getBoundingClientRect();
  return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * dur();
}
function onDown(ev) { if (ev.button !== 0 || !S.meta) return; S.drag = { x: ev.clientX, t: timeAt(ev), moved: false }; }
function onMove(ev) {
  const views = $('views'); if (!views) return;
  const r = $('wave').getBoundingClientRect();
  if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= views.getBoundingClientRect().bottom) {
    const h = $('hover'); h.style.display = 'block'; h.style.left = (ev.clientX - r.left) + 'px'; h.textContent = fmtTime(timeAt(ev), true);
  }
  if (!S.drag) return;
  if (Math.abs(ev.clientX - S.drag.x) > 4) S.drag.moved = true;
  if (S.drag.moved) { const t = timeAt(ev); S.loop.a = Math.min(S.drag.t, t); S.loop.b = Math.max(S.drag.t, t); S.loop.on = true; loopUi(); }
}
function onUp(ev) {
  if (!S.drag) return;
  const d = S.drag; S.drag = null;
  if (!d.moved) seek(timeAt(ev));
  else if (audio.currentTime < S.loop.a || audio.currentTime > S.loop.b) seek(S.loop.a);
}
window.addEventListener('keydown', ev => {
  if (!S.meta || ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
  if (ev.code === 'Space') { ev.preventDefault(); togglePlay(); }
  else if (ev.key === 'ArrowLeft') seek(audio.currentTime - (ev.shiftKey ? 1 : 5));
  else if (ev.key === 'ArrowRight') seek(audio.currentTime + (ev.shiftKey ? 1 : 5));
  else if (ev.key === 'Home') seek(S.loop.on ? S.loop.a : 0);
  else if (ev.key === 'l' || ev.key === 'L') toggleLoop();
  else if (ev.key === '[') setLoopPoint('a');
  else if (ev.key === ']') setLoopPoint('b');
});

// ---------- stats ----------
function renderStats() {
  const st = S.result.stats, box = $('stats'); box.textContent = '';
  const big = (label, v, unit, hint) => el('div', { class: 'big', title: hint }, el('div', { class: 'v', text: fmtDb(v) }), el('div', { class: 'u', text: unit }), el('div', { class: 'l', text: label }));
  box.append(
    el('div', { class: 'bigrow' },
      big('Integrated', st.integrated, 'LUFS', 'ITU-R BS.1770-4 gated loudness of the whole file'),
      big('Short-term max', st.shortTermMax, 'LUFS', 'Loudest 3 s window'),
      big('Momentary max', st.momentaryMax, 'LUFS', 'Loudest 400 ms window'),
      big('Sample peak', st.peakDb, 'dBFS', 'Highest absolute sample value'),
      big('RMS', st.rmsDb, 'dBFS', 'Unweighted RMS of all channels')),
    kv([['Clipped samples', st.clipped ? `${st.clipped} at full scale` : 'none'], ...st.channels.map((c, i) => [channelName(S.meta.channels, i), `peak ${fmtDb(c.peakDb, 'dBFS')}, RMS ${fmtDb(c.rmsDb, 'dBFS')}, DC ${c.dc == null ? '0' : c.dc.toFixed(5)}`])]),
    el('button', { class: 'copy', text: 'Copy stats', onclick: () => vscode.postMessage({ type: 'copy', text: statsText(S.meta, st) }) }));
}

function report(how, extra) {
  let sent = false;
  const send = () => { if (sent) return; sent = true; vscode.postMessage({ type: 'decoded', how, playable: Number.isFinite(audio.duration) && audio.duration > 0 && !S.audioError, ...extra }); };
  if (audio.readyState >= 1 || S.audioError) send(); else { audio.addEventListener('loadedmetadata', send, { once: true }); setTimeout(send, 3000); }
}

function showResult(r, label, how, ms) {
  S.result = r;
  report(how || 'host', { ms: ms || 0, integrated: r.stats.integrated == null ? null : r.stats.integrated });
  drawAll();
  renderStats();
  setStatus(label, 'ok');
}

// ---------- decoding in the webview ----------
const yieldUi = () => new Promise(r => setTimeout(r, 0));
async function analyzePlanes(planes, sampleRate) {
  const a = new Analyzer({ sampleRate, channels: planes.length, totalFrames: planes[0].length });
  const step = 1 << 18, n = planes[0].length;
  for (let i = 0; i < n; i += step) {
    a.push(planes.map(p => p.subarray(i, Math.min(n, i + step))));
    setStatus(`Analysing... ${Math.round((i / n) * 100)}%`);
    await yieldUi();
  }
  return a.result();
}

async function decodeWebAudio(bytes) {
  const rate = Math.max(3000, Math.min(768000, S.meta.sampleRate || 48000));
  const ctx = new OfflineAudioContext(1, 1, rate);
  const buf = await ctx.decodeAudioData(bytes);
  const planes = [];
  for (let c = 0; c < buf.numberOfChannels; c++) planes.push(buf.getChannelData(c));
  return { planes, sampleRate: buf.sampleRate };
}

async function decodeWebCodecs(u8) {
  const m = S.meta;
  if (typeof AudioDecoder === 'undefined') throw new Error('WebCodecs is not available');
  let chunks, description;
  if (m.format === 'aac') {
    const frames = adtsFrames(u8);
    if (!frames.length) throw new Error('no ADTS frames');
    const b = u8[frames[0].start + 2], c = u8[frames[0].start + 3];
    const aot = (b >> 6) + 1, fi = (b >> 2) & 15, ch = ((b & 1) << 2) | (c >> 6);
    description = new Uint8Array([(aot << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3)]);
    chunks = frames.map(f => u8.subarray(f.start + f.hdr, f.end));
  } else {
    if (!m.samples) throw new Error('no sample table');
    description = m.asc ? Uint8Array.from(atob(m.asc), x => x.charCodeAt(0)) : undefined;
    chunks = m.samples.offsets.map((o, i) => u8.subarray(o, o + m.samples.sizes[i]));
  }
  const cfg = { codec: m.codecString || 'mp4a.40.2', sampleRate: m.sampleRate, numberOfChannels: m.channels || 2, description };
  const sup = await AudioDecoder.isConfigSupported(cfg);
  if (!sup.supported) throw new Error(`this VS Code build has no ${m.codec} decoder`);
  const out = []; let err = null, rate = m.sampleRate, chans = m.channels;
  const dec = new AudioDecoder({
    output: ad => { rate = ad.sampleRate; chans = ad.numberOfChannels; const p = []; for (let c = 0; c < chans; c++) { const a = new Float32Array(ad.numberOfFrames); ad.copyTo(a, { planeIndex: c, format: 'f32-planar' }); p.push(a); } out.push(p); ad.close(); },
    error: e => { err = e; },
  });
  dec.configure(cfg);
  const us = 1024 / rate * 1e6;
  for (let i = 0; i < chunks.length; i++) {
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * us), data: chunks[i] }));
    if (i % 500 === 499) { setStatus(`Decoding... ${Math.round((i / chunks.length) * 100)}%`); await yieldUi(); }
  }
  await dec.flush();
  if (err) throw err;
  const total = out.reduce((n, p) => n + p[0].length, 0);
  if (!total) throw new Error('the decoder returned no audio');
  const planes = [];
  for (let c = 0; c < chans; c++) { const a = new Float32Array(total); let o = 0; for (const p of out) { a.set(p[c], o); o += p[c].length; } planes.push(a); }
  return { planes, sampleRate: rate, viaWebCodecs: true };
}

/** Opus in Ogg with libopus compiled to WASM (opus-decoder, MIT), for VS Code builds without an Opus decoder. */
async function decodeOpusWasm(u8) {
  const st = oggOpusStream(u8);
  if (!st) throw new Error('no Opus stream found');
  const h = st.head;
  const dec = new OpusDecoder({ channels: h.channels, preSkip: h.preSkip, streamCount: h.streamCount, coupledStreamCount: h.coupledStreamCount, channelMappingTable: h.mapping });
  await dec.ready;
  const parts = [];
  try {
    for (let i = 0; i < st.packets.length; i += 500) {
      const r = dec.decodeFrames(st.packets.slice(i, i + 500));
      if (r.samplesDecoded) parts.push(r.channelData);
      setStatus(`Decoding Opus... ${Math.round((i / st.packets.length) * 100)}%`);
      await yieldUi();
    }
  } finally { dec.free(); }
  const ch = h.channels, total = parts.reduce((n, p) => n + p[0].length, 0);
  if (!total) throw new Error('the Opus decoder returned no audio');
  const planes = [];
  for (let c = 0; c < ch; c++) { const a = new Float32Array(total); let o = 0; for (const p of parts) { a.set(p[c], o); o += p[c].length; } planes.push(a); }
  return { planes, sampleRate: 48000, viaWasm: true };
}

function maybeBlobPlayback() {
  if (!S.audioError || !S.planes || S.blobbed) return;
  S.blobbed = true;
  const url = URL.createObjectURL(new Blob([encodeWav16(S.planes.planes, S.planes.sampleRate)], { type: 'audio/wav' }));
  S.audioError = false;
  audio.src = url;
}

function offerFfmpeg(reason) {
  S.failed = reason;
  $('views').classList.add('empty'); $('taxis').classList.add('empty');
  const st = $('stats'); st.textContent = ''; st.append(el('p', { class: 'muted', text: 'No samples to measure. See the message above.' }));
  setStatus(reason, 'warn');
  report('failed', { note: reason });
  vscode.postMessage({ type: 'decodeFailed', message: reason });
}

async function decodeInWebview() {
  setStatus('Decoding...');
  let bytes;
  try { bytes = await (await fetch(S.src)).arrayBuffer(); } catch (e) { setStatus('Could not read the file: ' + e.message, 'warn'); return; }
  const t0 = performance.now();
  let d = null, firstErr = null;
  try { d = await decodeWebAudio(bytes.slice(0)); } catch (e) { firstErr = e; }
  if (!d && S.meta.format === 'opus') {
    try { d = await decodeOpusWasm(new Uint8Array(bytes)); } catch (e) { firstErr = e; }
  }
  if (!d && (S.meta.format === 'm4a' || S.meta.format === 'aac')) {
    try { d = await decodeWebCodecs(new Uint8Array(bytes)); } catch (e) { firstErr = e; }
  }
  if (!d) {
    const aac = /AAC|ALAC|AC-3/.test(S.meta.codec);
    offerFfmpeg(aac
      ? `VS Code cannot decode ${S.meta.codec} audio: its built-in Chromium has no decoder for it. Install ffmpeg (or set audioPreview.ffmpegPath) to decode it here, or convert the file to FLAC or Opus. The file details and tags are below.`
      : `This file could not be decoded (${firstErr && firstErr.message ? firstErr.message : 'unknown error'}). The file details and tags are below.`);
    return;
  }
  S.planes = d;
  if (d.viaWebCodecs || d.viaWasm) { S.audioError = true; maybeBlobPlayback(); } else maybeBlobPlayback();
  const r = await analyzePlanes(d.planes, d.sampleRate);
  const ms = Math.round(performance.now() - t0);
  const how = d.viaWebCodecs ? 'webcodecs' : d.viaWasm ? 'wasm' : 'webaudio';
  showResult(r, `Decoded ${{ webcodecs: 'with WebCodecs', wasm: 'with the built-in Opus decoder', webaudio: 'with Web Audio' }[how]} and analysed in ${ms} ms.`, how, ms);
}

// ---------- messages ----------
window.addEventListener('message', ev => {
  const m = ev.data;
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'meta') {
    S.meta = m.meta; S.plan = m.plan; S.src = m.src; S.result = null; S.failed = null; S.planes = null; S.blobbed = false; S.audioError = false;
    renderShell();
    audio.src = m.src;
    if (m.converted) setStatus('Decoded with ffmpeg.', 'ok');
    if (m.plan.mode === 'none') { setStatus(m.plan.reason, 'warn'); report('skipped', { note: m.plan.reason }); }
    else if (m.plan.mode === 'host') setStatus('Reading samples...');
    else decodeInWebview();
    drawAll();
  } else if (m.type === 'progress') {
    if (!S.meta) app.textContent = m.label || '';
    else setStatus(m.label || `Reading samples... ${Math.round(m.pct * 100)}%`);
  } else if (m.type === 'analysis') {
    showResult(m.result, `Analysed ${fmtTime(m.result.frames / (S.meta.sampleRate || 1), true)} of audio in ${m.ms} ms.`);
  } else if (m.type === 'ffmpegOffer') {
    if (m.available) {
      setStatus($('status').textContent, 'warn', el('button', { class: 'primary inline', text: 'Decode with ffmpeg', title: m.version || 'ffmpeg', onclick: () => vscode.postMessage({ type: 'ffmpeg' }) }));
    }
  } else if (m.type === 'copied') {
    setStatus('Stats copied to the clipboard.', 'ok');
  } else if (m.type === 'error') {
    report('failed', { note: m.message });
    if (!S.meta) { app.textContent = ''; app.append(el('div', { class: 'status warn' }, el('span', { text: m.message }))); }
    else setStatus(m.message, 'warn');
  }
});

vscode.postMessage({ type: 'ready' });
