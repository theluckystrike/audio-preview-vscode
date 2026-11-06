'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FIX, meta } = require('./helpers');
const { FileSource } = require('../src/core/source');
const { streamWav, decodePcm } = require('../src/core/wav');
const { Analyzer, fft } = require('../src/core/analysis');

const ref = Object.fromEntries(fs.readFileSync(path.join(FIX, 'ebur128.txt'), 'utf8').trim().split('\n').map(l => l.split(' ')).map(([f, v]) => [f, Number(v)]));

async function analyze(name, chunkBytes) {
  const m = await meta(name);
  const s = await FileSource.open(path.join(FIX, name));
  const a = new Analyzer({ sampleRate: m.sampleRate, channels: m.channels, totalFrames: m.totalFrames });
  await streamWav(s, m, p => a.push(p), { chunkBytes });
  await s.close();
  return a.result();
}

test('integrated loudness matches ffmpeg ebur128 within 0.1 LU', async () => {
  for (const f of ['sweep-44k-s16.wav', 'tone-1k-48k-s24.wav']) {
    const r = await analyze(f);
    assert.ok(Math.abs(r.stats.integrated - ref[f]) <= 0.1, `${f}: ${r.stats.integrated} vs ${ref[f]}`);
  }
});

test('-20 dBFS 1 kHz sine: peak -20 dBFS, RMS -23 dBFS, -20 LUFS', async () => {
  const r = await analyze('tone-1k-48k-s24.wav');
  assert.ok(Math.abs(r.stats.peakDb + 20) < 0.01);
  assert.ok(Math.abs(r.stats.rmsDb + 23.01) < 0.02);
  assert.ok(Math.abs(r.stats.shortTermMax + 20) < 0.1 && Math.abs(r.stats.momentaryMax + 20) < 0.1);
  assert.strictEqual(r.stats.clipped, 0);
});

test('results do not depend on the chunk size', async () => {
  const a = await analyze('sweep-44k-s16.wav', 4096), b = await analyze('sweep-44k-s16.wav', 3 * 1048576);
  assert.strictEqual(a.stats.integrated.toFixed(6), b.stats.integrated.toFixed(6));
  assert.deepStrictEqual(Array.from(a.spectrogram.data), Array.from(b.spectrogram.data));
  assert.deepStrictEqual(Array.from(a.waveform.max[0]), Array.from(b.waveform.max[0]));
});

test('float WAV with a full-scale click counts clipped samples and a 0 dBFS peak', async () => {
  const r = await analyze('noise-22k-f32.wav');
  assert.strictEqual(r.stats.peakDb, 0);
  assert.ok(r.stats.clipped >= 1);
});

test('spectrogram puts a 1 kHz tone in the right row', async () => {
  const r = await analyze('tone-1k-48k-s24.wav');
  const sp = r.spectrogram, col = Math.floor(sp.cols / 2);
  let best = 0, row = -1;
  for (let y = 0; y < sp.rows; y++) if (sp.data[y * sp.cols + col] > best) { best = sp.data[y * sp.cols + col]; row = y; }
  const f = sp.minHz * Math.pow(sp.maxHz / sp.minHz, (sp.rows - 1 - row + 0.5) / sp.rows);
  assert.ok(f > 900 && f < 1120, `peak row at ${f} Hz`);
});

test('waveform buckets hold the signal range', async () => {
  const r = await analyze('tone-8k-u8.wav');
  const max = Math.max(...r.waveform.max[0]), min = Math.min(...r.waveform.min[0]);
  assert.ok(Math.abs(max - 0.5) < 0.02 && Math.abs(min + 0.5) < 0.02);
});

test('FFT of a pure bin has one peak', () => {
  const n = 64, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos(2 * Math.PI * 5 * i / n);
  fft(re, im);
  const mags = Array.from(re, (v, i) => Math.hypot(v, im[i]));
  assert.ok(Math.abs(mags[5] - 32) < 1e-9 && mags[6] < 1e-9);
});

test('PCM decoder: 24-bit sign extension, A-law and mu-law', () => {
  const p = decodePcm(Buffer.from([0x00, 0x00, 0x80, 0xff, 0xff, 0x7f]), { kind: 'int', bits: 24 }, 1);
  assert.strictEqual(p[0][0], -1); assert.ok(Math.abs(p[0][1] - 1) < 1e-6);
  const al = decodePcm(Buffer.from([0xd5, 0x55]), { kind: 'alaw', bits: 8 }, 1)[0];
  assert.ok(Math.abs(al[0]) < 0.001 && Math.abs(al[1]) < 0.001);
  const mu = decodePcm(Buffer.from([0xff, 0x00]), { kind: 'mulaw', bits: 8 }, 1)[0];
  assert.strictEqual(mu[0], 0); assert.ok(mu[1] < -0.9);
});

test('very short input still gives finite stats', () => {
  const a = new Analyzer({ sampleRate: 8000, channels: 1, totalFrames: 100 });
  a.push([new Float32Array(100).fill(0.25)]);
  const r = a.result();
  assert.ok(Number.isFinite(r.stats.integrated)); assert.strictEqual(r.waveform.buckets, 100);
});
