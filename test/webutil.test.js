'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { FIX } = require('./helpers');
const { fmtTime, fmtDb, adtsFrames, oggOpusStream, encodeWav16, colorMap, statsText } = require('../src/core/webutil');
const { BufferSource } = require('../src/core/source');
const { readMetadata } = require('../src/core/metadata');

test('time and dB formatting', () => {
  assert.strictEqual(fmtTime(0, true), '0:00.00'); assert.strictEqual(fmtTime(75.5, true), '1:15.50'); assert.strictEqual(fmtTime(3725), '1:02:05');
  assert.strictEqual(fmtDb(-Infinity), '-inf'); assert.strictEqual(fmtDb(null, 'LUFS'), '-inf LUFS'); assert.strictEqual(fmtDb(-14.04, 'LUFS'), '-14.0 LUFS');
});

test('ADTS splitter finds every frame of the fixture', () => {
  const u8 = new Uint8Array(fs.readFileSync(path.join(FIX, 'night-loop.aac')));
  const f = adtsFrames(u8);
  assert.ok(f.length > 340);
  assert.strictEqual(f[f.length - 1].end, u8.length);
});

test('WAV blob encoder round-trips through the WAV parser', async () => {
  const n = 1000, a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { a[i] = Math.sin(i / 10) * 0.5; b[i] = -a[i]; }
  const bytes = new Uint8Array(encodeWav16([a, b], 22050));
  const m = await readMetadata(new BufferSource(bytes), 'x.wav');
  assert.strictEqual(m.channels, 2); assert.strictEqual(m.sampleRate, 22050); assert.strictEqual(m.totalFrames, n);
});

test('colour map spans dark to bright', () => {
  const l = colorMap();
  assert.ok(l[0] + l[1] + l[2] < 40 && l[765] + l[766] + l[767] > 600);
});

test('stats text lists loudness and each channel', () => {
  const t = statsText({ name: 'a.wav', codec: 'PCM 16-bit', sampleRate: 44100, channels: 2, bitDepth: 16, durationSec: 4 },
    { integrated: -14.2, shortTermMax: -12, momentaryMax: -10, peakDb: -1, rmsDb: -16, clipped: 0, channels: [{ peakDb: -1, rmsDb: -16, dc: 0 }, { peakDb: -2, rmsDb: -17, dc: null }] });
  assert.match(t, /Integrated loudness: -14\.2 LUFS/); assert.match(t, /Left: peak -1\.0 dBFS/); assert.match(t, /Right: peak -2\.0 dBFS/);
});

test('Ogg Opus reader: head fields and audio packets', () => {
  const st = oggOpusStream(new Uint8Array(fs.readFileSync(path.join(FIX, 'night-loop.opus'))));
  assert.strictEqual(st.head.channels, 2); assert.strictEqual(st.head.preSkip, 312);
  assert.deepStrictEqual([st.head.streamCount, st.head.coupledStreamCount], [1, 1]);
  assert.ok(st.packets.length >= 400, String(st.packets.length)); // 8 s of 20 ms packets
  assert.strictEqual(oggOpusStream(new Uint8Array(fs.readFileSync(path.join(FIX, 'night-loop.ogg')))), null, 'Vorbis is not Opus');
});

test('Opus WASM decoder decodes the fixture to 8 s of audio', async () => {
  const { OpusDecoder } = await import('opus-decoder');
  const st = oggOpusStream(new Uint8Array(fs.readFileSync(path.join(FIX, 'night-loop.opus'))));
  const d = new OpusDecoder({ channels: 2, preSkip: st.head.preSkip, streamCount: 1, coupledStreamCount: 1, channelMappingTable: [0, 1] });
  await d.ready;
  const r = d.decodeFrames(st.packets); d.free();
  assert.ok(Math.abs(r.samplesDecoded / 48000 - 8) < 0.03, String(r.samplesDecoded));
});
