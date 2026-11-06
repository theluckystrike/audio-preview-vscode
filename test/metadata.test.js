'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { meta } = require('./helpers');
const { BufferSource } = require('../src/core/source');
const { readMetadata, parseId3v2, parseAsc, mp3Header } = require('../src/core/metadata');

const tag = (m, k) => (m.tags.find(t => t[0] === k) || [])[1];
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('WAV 16-bit stereo: header and LIST INFO tags', async () => {
  const m = await meta('sweep-44k-s16.wav');
  assert.strictEqual(m.format, 'wav'); assert.strictEqual(m.codec, 'PCM 16-bit');
  assert.strictEqual(m.sampleRate, 44100); assert.strictEqual(m.channels, 2); assert.strictEqual(m.bitDepth, 16);
  assert.strictEqual(m.totalFrames, 176400); assert.strictEqual(m.durationSec, 4);
  assert.strictEqual(tag(m, 'Title'), 'Sine Sweep'); assert.strictEqual(tag(m, 'Artist'), 'Zovo Test Signals');
  assert.strictEqual(tag(m, 'Comment'), '20 Hz to 20 kHz <b>&amp;</b>', 'markup is kept as plain text');
  assert.deepStrictEqual(m.wav, { kind: 'int', bits: 16, dataOffset: m.wav.dataOffset, dataSize: 705600, blockAlign: 4 });
});

test('WAV 24-bit, float 32 and 8-bit variants', async () => {
  const a = await meta('tone-1k-48k-s24.wav'); assert.strictEqual(a.bitDepth, 24); assert.strictEqual(a.sampleRate, 48000); assert.strictEqual(a.durationSec, 3);
  const b = await meta('noise-22k-f32.wav'); assert.strictEqual(b.codec, 'IEEE float 32-bit'); assert.strictEqual(b.wav.kind, 'float'); assert.strictEqual(b.channels, 1);
  const c = await meta('tone-8k-u8.wav'); assert.strictEqual(c.bitDepth, 8); assert.strictEqual(c.totalFrames, 8000);
});

test('MP3: ID3v2.3 and v2.4 tags, LAME gapless duration', async () => {
  const a = await meta('night-loop.mp3');
  assert.strictEqual(a.codec, 'MPEG-1 Layer III'); assert.strictEqual(a.sampleRate, 44100); assert.strictEqual(a.channels, 2);
  near(a.durationSec, 8, 0.001, 'duration'); near(a.bitrate, 128000, 3000, 'bitrate');
  assert.strictEqual(tag(a, 'Title'), 'Night Loop'); assert.strictEqual(tag(a, 'Track'), '3'); assert.strictEqual(tag(a, 'Genre'), 'Electronic');
  const b = await meta('sweep.mp3');
  near(b.durationSec, 4, 0.001, 'duration'); assert.strictEqual(tag(b, 'Comment'), '20 Hz to 20 kHz <b>&amp;</b>');
  assert.ok(b.info.some(i => i[0] === 'ID3 version' && i[1] === '2.4'));
});

test('FLAC: STREAMINFO and Vorbis comments', async () => {
  const m = await meta('night-loop.flac');
  assert.strictEqual(m.codec, 'FLAC 24-bit'); assert.strictEqual(m.bitDepth, 24); assert.strictEqual(m.totalFrames, 352800); assert.strictEqual(m.durationSec, 8);
  assert.strictEqual(tag(m, 'Album'), 'Fixtures'); assert.ok(m.info.some(i => i[0] === 'MD5 of audio' && /^[0-9a-f]{32}$/.test(i[1])));
});

test('Ogg Vorbis and Opus: codec, channels, duration from the last granule', async () => {
  const v = await meta('night-loop.ogg');
  assert.strictEqual(v.format, 'ogg'); assert.strictEqual(v.codec, 'Vorbis'); assert.strictEqual(v.sampleRate, 44100); near(v.durationSec, 8, 0.01, 'vorbis');
  const o = await meta('night-loop.opus');
  assert.strictEqual(o.format, 'opus'); assert.strictEqual(o.sampleRate, 48000); assert.strictEqual(o.channels, 2); near(o.durationSec, 8, 0.01, 'opus');
  assert.strictEqual(tag(o, 'Title'), 'Night Loop');
});

test('M4A: AAC-LC from esds, iTunes tags, sample table', async () => {
  const m = await meta('night-loop.m4a');
  assert.strictEqual(m.format, 'm4a'); assert.strictEqual(m.codec, 'AAC-LC'); assert.strictEqual(m.codecString, 'mp4a.40.2');
  assert.strictEqual(m.sampleRate, 44100); assert.strictEqual(m.channels, 2); near(m.durationSec, 8, 0.05, 'duration');
  assert.strictEqual(tag(m, 'Title'), 'Night Loop'); assert.strictEqual(tag(m, 'Track'), '3');
  assert.ok(m.samples.offsets.length > 300); assert.strictEqual(m.samples.offsets.length, m.samples.sizes.length);
  for (let i = 1; i < m.samples.offsets.length; i++) assert.ok(m.samples.offsets[i] >= m.samples.offsets[i - 1] + m.samples.sizes[i - 1] || i === 0);
  assert.deepStrictEqual(parseAsc(m.asc).aot, 2);
});

test('ADTS AAC: profile, rate and frame-counted duration', async () => {
  const m = await meta('night-loop.aac');
  assert.strictEqual(m.codec, 'AAC-LC (ADTS)'); assert.strictEqual(m.sampleRate, 44100); near(m.durationSec, 8, 0.05, 'duration');
});

test('broken and foreign files give clear errors', async () => {
  await assert.rejects(meta('broken-header.wav'), /fmt chunk/);
  await assert.rejects(meta('broken.flac'), /STREAMINFO/);
  await assert.rejects(readMetadata(new BufferSource(new Uint8Array(0)), 'x.wav'), /empty/);
  await assert.rejects(readMetadata(new BufferSource(new TextEncoder().encode('hello world, not audio')), 'notes.txt'), /does not look like/);
});

test('ID3 parser: UTF-16 text and garbage frames', () => {
  const body = Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from('Ünïcode', 'utf16le')]);
  const frame = Buffer.concat([Buffer.from('TIT2'), Buffer.from([0, 0, 0, body.length, 0, 0]), body]);
  const hdr = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, frame.length + 10]);
  const t = parseId3v2(Buffer.concat([hdr, frame, Buffer.alloc(10)]));
  assert.deepStrictEqual(t.tags, [['Title', 'Ünïcode']]);
  assert.strictEqual(mp3Header(Buffer.from([0xff, 0xfb, 0xf0, 0]), 0), null, 'bad bitrate index is rejected');
});
