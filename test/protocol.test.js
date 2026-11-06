'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateWebviewMessage, planDecode, publicMeta, encodeResult } = require('../src/core/protocol');
const { buildHtml } = require('../src/html');
const { Analyzer } = require('../src/core/analysis');
const { meta } = require('./helpers');
const S = { maxWavMB: 2048, maxDecodedMB: 600 };

test('only known webview messages pass validation', () => {
  assert.deepStrictEqual(validateWebviewMessage({ type: 'ready', extra: 1 }), { ok: true, msg: { type: 'ready' } });
  assert.ok(validateWebviewMessage({ type: 'ffmpeg' }).ok);
  assert.ok(validateWebviewMessage({ type: 'copy', text: 'stats' }).ok);
  for (const bad of [null, 'ready', {}, { type: 'exec' }, { type: 'copy' }, { type: 'copy', text: '' }, { type: 'copy', text: 'x'.repeat(20001) }, { type: 'copy', text: 5 }]) assert.strictEqual(validateWebviewMessage(bad).ok, false, JSON.stringify(bad));
  assert.strictEqual(validateWebviewMessage({ type: 'decodeFailed', message: 'y'.repeat(900) }).msg.message.length, 500);
});

test('decode plan: WAV in the host, compressed in the webview, caps with a message', async () => {
  const wav = await meta('sweep-44k-s16.wav');
  assert.strictEqual(planDecode(wav, S).mode, 'host');
  const big = { ...wav, fileSize: 3000 * 1048576 };
  const p = planDecode(big, S); assert.strictEqual(p.mode, 'none'); assert.match(p.reason, /audioPreview\.maxWavMB/);
  const flac = await meta('night-loop.flac');
  assert.strictEqual(planDecode(flac, S).mode, 'webview');
  const long = { ...flac, totalFrames: 44100 * 3600, durationSec: 3600 };
  const q = planDecode(long, S); assert.strictEqual(q.mode, 'none'); assert.match(q.reason, /audioPreview\.maxDecodedMB/);
  assert.strictEqual(planDecode({ ...wav, wav: null, unsupported: 'MS ADPCM WAV data cannot be decoded here.' }, S).reason, 'MS ADPCM WAV data cannot be decoded here.');
});

test('public metadata has no file system path and JSON-safe stats', async () => {
  const m = await meta('night-loop.m4a');
  const pub = publicMeta(m, 'night-loop.m4a');
  assert.ok(!JSON.stringify(pub).includes('/Users/'));
  assert.strictEqual(typeof pub.asc, 'string');
  const a = new Analyzer({ sampleRate: 8000, channels: 1, totalFrames: 800 });
  a.push([new Float32Array(800)]);
  const enc = encodeResult(a.result());
  assert.strictEqual(enc.stats.integrated, null, 'silence is -inf, sent as null');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(enc)), enc);
});

test('webview HTML has a strict CSP and escapes the title', () => {
  const h = buildHtml({ cspSource: 'vscode-resource:', scriptUri: 'vscode-resource:/w.js', styleUri: 'vscode-resource:/w.css', title: '<img src=x onerror=alert(1)>.wav', nonce: 'abc' });
  const csp = h.match(/content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'nonce-abc'/);
  assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'|https?:/);
  assert.match(csp, /'wasm-unsafe-eval'/, 'WASM is allowed for the Opus decoder, eval is not');
  assert.ok(!h.includes('<img src=x'));
  assert.strictEqual((h.match(/<script/g) || []).length, 1);
});
