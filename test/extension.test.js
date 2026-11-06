'use strict';
// Runs the extension host code with a mocked vscode module and real fixture files.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { FIX } = require('./helpers');

const root = path.join(__dirname, '..');
const registered = { editors: [], commands: {} };
let clipboard = '';
const settings = {};
const mkUri = p => ({ scheme: 'file', path: p, fsPath: p, with(o) { return mkUri(o.path || p); } });
const vscodeMock = {
  Uri: { joinPath: (u, ...p) => mkUri(path.join(u.fsPath || u.path, ...p)), file: mkUri },
  window: { registerCustomEditorProvider: (id, provider) => { registered.editors.push({ id, provider }); return { dispose() {} }; } },
  commands: { registerCommand: (id, fn) => { registered.commands[id] = fn; return { dispose() {} }; }, executeCommand: async () => {} },
  workspace: { getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }), fs: {}, isTrusted: true },
  env: { clipboard: { writeText: async t => { clipboard = t; } } },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };
const ext = require('../src/extension');
const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-preview-test-'));
test.after(() => fs.rmSync(storage, { recursive: true, force: true }));

test('activate registers the editor and every command in package.json', () => {
  ext.activate({ subscriptions: [], extensionUri: mkUri(root), globalStorageUri: mkUri(storage) });
  const pkg = require('../package.json');
  assert.deepStrictEqual(registered.editors.map(e => e.id), pkg.contributes.customEditors.map(e => e.viewType));
  assert.deepStrictEqual(Object.keys(registered.commands).sort(), pkg.contributes.commands.map(c => c.command).sort());
  assert.strictEqual(pkg.keywords.length, 30); assert.strictEqual(new Set(pkg.keywords).size, 30);
  assert.strictEqual(pkg.publisher, 'zovo');
});

function fakePanel() {
  const sent = [], waiters = [];
  let onMsg, onDispose;
  const panel = {
    webview: {
      cspSource: 'vscode-resource:', options: {}, html: '',
      asWebviewUri: u => ({ toString: () => 'vscode-resource:' + u.path }),
      postMessage: m => { sent.push(JSON.parse(JSON.stringify(m))); waiters.slice().forEach(w => w()); return Promise.resolve(true); },
      onDidReceiveMessage: fn => { onMsg = fn; },
    },
    onDidDispose: fn => { onDispose = fn; },
  };
  const until = pred => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + JSON.stringify(sent.map(m => m.type)))), 10000);
    const check = () => { const m = sent.find(pred); if (m) { clearTimeout(timer); resolve(m); } };
    waiters.push(check); check();
  });
  return { panel, sent, until, send: m => onMsg(m), dispose: () => onDispose() };
}

async function open(name) {
  const provider = registered.editors[0].provider, f = fakePanel();
  await provider.resolveCustomEditor(provider.openCustomDocument(mkUri(path.join(FIX, name))), f.panel);
  return f;
}

test('a WAV file: meta first, then a host analysis; copy goes to the clipboard', async () => {
  const f = await open('sweep-44k-s16.wav');
  assert.match(f.panel.webview.html, /Content-Security-Policy/);
  assert.strictEqual(f.panel.webview.options.enableScripts, true);
  assert.ok(f.panel.webview.options.localResourceRoots.some(u => u.fsPath === FIX), 'the file folder is a resource root');
  f.send({ type: 'ready' });
  const meta = await f.until(m => m.type === 'meta');
  assert.strictEqual(meta.plan.mode, 'host'); assert.strictEqual(meta.meta.sampleRate, 44100);
  assert.match(meta.src, /sweep-44k-s16\.wav$/);
  const a = await f.until(m => m.type === 'analysis');
  assert.ok(Math.abs(a.result.stats.integrated + 8.2) < 0.1);
  assert.strictEqual(a.result.waveform.min.length, 2);
  assert.ok(Buffer.from(a.result.spectrogram.b64, 'base64').length === a.result.spectrogram.cols * a.result.spectrogram.rows);
  assert.ok(f.sent.findIndex(m => m.type === 'meta') < f.sent.findIndex(m => m.type === 'analysis'));
  f.send({ type: 'copy', text: 'Integrated loudness: -8.2 LUFS' });
  await f.until(m => m.type === 'copied');
  assert.strictEqual(clipboard, 'Integrated loudness: -8.2 LUFS');
  const before = f.sent.length;
  f.send({ type: 'run', cmd: 'rm -rf /' }); f.send(null); f.send({ type: 'copy', text: 7 });
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(f.sent.length, before, 'invalid messages get no reply');
  f.dispose();
});

test('compressed files are planned for the webview with their sample table', async () => {
  const f = await open('night-loop.m4a');
  f.send({ type: 'ready' });
  const meta = await f.until(m => m.type === 'meta');
  assert.strictEqual(meta.plan.mode, 'webview');
  assert.ok(meta.meta.samples.offsets.length > 300);
  await new Promise(r => setTimeout(r, 30));
  assert.ok(!f.sent.some(m => m.type === 'analysis'));
  f.dispose();
});

test('a broken file shows an error message in the webview', async () => {
  const f = await open('broken-header.wav');
  f.send({ type: 'ready' });
  const e = await f.until(m => m.type === 'error');
  assert.match(e.message, /fmt chunk/);
  f.dispose();
});

test('closing the editor stops a running analysis', async () => {
  const f = await open('tone-1k-48k-s24.wav');
  f.send({ type: 'ready' });
  await f.until(m => m.type === 'meta');
  f.dispose();
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!f.sent.some(m => m.type === 'analysis'), 'no analysis after dispose');
});

test('ffmpeg fallback converts an M4A to a cached WAV and analyses it', { skip: !require('child_process').spawnSync('ffmpeg', ['-version']).stdout }, async () => {
  const f = await open('night-loop.m4a');
  f.send({ type: 'ready' });
  await f.until(m => m.type === 'meta');
  f.send({ type: 'decodeFailed', message: 'no AAC decoder' });
  const offer = await f.until(m => m.type === 'ffmpegOffer');
  assert.strictEqual(offer.available, true);
  f.send({ type: 'ffmpeg' });
  const meta = await f.until(m => m.type === 'meta' && m.converted);
  assert.strictEqual(meta.meta.format, 'm4a', 'the original codec and tags stay');
  assert.strictEqual(meta.plan.mode, 'host');
  assert.ok(meta.meta.info.some(i => i[0] === 'Decoded by'));
  assert.ok(meta.src.includes('ffmpeg-cache'));
  const a = await f.until(m => m.type === 'analysis');
  assert.ok(Math.abs(a.result.stats.integrated - -13.5) < 0.5, 'AAC loudness is close to the FLAC source');
  f.dispose();
});

test('a 30 MB WAV: the header shows before the samples, with progress in between', async () => {
  const p = path.join(storage, 'big.wav'), frames = 48000 * 160, data = frames * 4;
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22);
  hdr.writeUInt32LE(48000, 24); hdr.writeUInt32LE(192000, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(data, 40);
  const fd = fs.openSync(p, 'w'); fs.writeSync(fd, hdr);
  const block = Buffer.alloc(48000 * 4);
  for (let i = 0; i < 48000; i++) { const v = Math.round(Math.sin(2 * Math.PI * 440 * i / 48000) * 3276); block.writeInt16LE(v, i * 4); block.writeInt16LE(v, i * 4 + 2); }
  for (let s = 0; s < 160; s++) fs.writeSync(fd, block);
  fs.closeSync(fd);
  const provider = registered.editors[0].provider, f = fakePanel();
  await provider.resolveCustomEditor(provider.openCustomDocument(mkUri(p)), f.panel);
  const t0 = Date.now();
  f.send({ type: 'ready' });
  const meta = await f.until(m => m.type === 'meta');
  const metaMs = Date.now() - t0;
  assert.ok(metaMs < 500, `header in ${metaMs} ms`);
  assert.strictEqual(meta.meta.durationSec, 160);
  const a = await f.until(m => m.type === 'analysis');
  assert.ok(f.sent.some(m => m.type === 'progress'), 'progress was reported');
  assert.ok(Math.abs(a.result.stats.peakDb - 20 * Math.log10(3276 / 32768)) < 0.01);
  f.dispose();
  fs.unlinkSync(p);
});

// ---------- support links (Sponsor, More free viewers) ----------
test('support: package.json has the sponsor field, the two commands and the setting', () => {
  const pkg = require('../package.json');
  const support = require('../src/support');
  assert.strictEqual(pkg.sponsor.url, 'https://github.com/sponsors/theluckystrike');
  assert.strictEqual(pkg.sponsor.url, support.sponsorUrl());
  const ids = pkg.contributes.commands.map(c => c.command);
  assert.ok(ids.includes('audioPreview.supportDeveloper') && ids.includes('audioPreview.moreViewers'));
  const props = Object.assign({}, ...[].concat(pkg.contributes.configuration).map(c => c.properties));
  assert.strictEqual(props['audioPreview.showSupportLinks'].default, true);
  assert.ok(support.otherProducts('zovo.audio-preview-vscode').every(x => x.id !== 'zovo.audio-preview-vscode'));
});

test('support: the footer shows by default and audioPreview.showSupportLinks=false hides it', async () => {
  try {
    for (const [value, shown] of [[undefined, true], [false, false]]) {
      if (value === undefined) delete settings.showSupportLinks; else settings.showSupportLinks = value;
      const f = await open('sweep-44k-s16.wav');
      const html = f.panel.webview.html;
      assert.strictEqual(/id="zovo-support"/.test(html), shown, String(value));
      assert.strictEqual(html.includes('command:audioPreview.moreViewers'), shown);
      assert.deepStrictEqual(f.panel.webview.options.enableCommandUris, ['audioPreview.supportDeveloper', 'audioPreview.moreViewers', 'workbench.action.openSettings']);
      f.dispose();
    }
  } finally { delete settings.showSupportLinks; }
});
