'use strict';
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { buildHtml } = require('./html');
const { FileSource, BufferSource } = require('./core/source');
const { readMetadata } = require('./core/metadata');
const { streamWav } = require('./core/wav');
const { Analyzer } = require('./core/analysis');
const { validateWebviewMessage, planDecode, publicMeta, encodeResult } = require('./core/protocol');
const { createRatingPrompt } = require('./rate');
const { registerSupport, commandUris, showLinks } = require('./support');

let rating = { success() {} };

const VIEW_TYPE = 'audioPreview.player';

function settings() {
  const c = vscode.workspace.getConfiguration('audioPreview');
  return {
    maxWavMB: c.get('maxWavMB', 2048), maxDecodedMB: c.get('maxDecodedMB', 600),
    maxRemoteFileMB: c.get('maxRemoteFileMB', 512), ffmpegPath: c.get('ffmpegPath', 'ffmpeg') || 'ffmpeg',
  };
}

async function openSource(uri) {
  if (uri.scheme === 'file') return FileSource.open(uri.fsPath);
  const limit = settings().maxRemoteFileMB;
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > limit * 1048576) throw new Error(`This file is not on local disk and is ${(stat.size / 1048576).toFixed(0)} MB. Such files are read whole, and the limit is ${limit} MB (setting audioPreview.maxRemoteFileMB).`);
  return new BufferSource(await vscode.workspace.fs.readFile(uri));
}

const tick = () => new Promise(r => setImmediate(r));

/** Streams a WAV source through the analyzer and reports progress. */
async function analyzeWav(src, meta, onProgress, cancelled) {
  const a = new Analyzer({ sampleRate: meta.sampleRate, channels: meta.channels, totalFrames: meta.totalFrames });
  let last = 0;
  await streamWav(src, meta, async (planes, done) => {
    a.push(planes);
    const now = Date.now();
    if (now - last > 150) { last = now; onProgress((done + planes[0].length) / Math.max(1, meta.totalFrames)); }
    await tick();
  }, { cancelled, chunkBytes: 2 * 1048576 });
  return a.result();
}

function probeFfmpeg(bin) {
  return new Promise(resolve => {
    execFile(bin, ['-hide_banner', '-version'], { timeout: 4000, windowsHide: true }, (err, out) => resolve(err ? null : String(out).split('\n')[0].slice(0, 120)));
  });
}

/** Converts a file to 16-bit WAV with the user's own ffmpeg. Returns the cached file path. */
async function ffmpegToWav(bin, input, cacheDir) {
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const st = await fs.promises.stat(input);
  const key = crypto.createHash('sha1').update(`${input}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 16);
  const out = path.join(cacheDir, key + '.wav');
  // keep the cache small: drop files older than one day
  for (const f of await fs.promises.readdir(cacheDir)) {
    const p = path.join(cacheDir, f);
    try { const s = await fs.promises.stat(p); if (Date.now() - s.mtimeMs > 86400000) await fs.promises.unlink(p); } catch { /* gone */ }
  }
  if (fs.existsSync(out)) return out;
  const tmp = out + '.part';
  await new Promise((resolve, reject) => {
    execFile(bin, ['-nostdin', '-hide_banner', '-v', 'error', '-i', input, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', '-f', 'wav', '-y', tmp],
      { timeout: 300000, windowsHide: true, maxBuffer: 1048576 }, err => (err ? reject(new Error('ffmpeg could not decode this file: ' + String(err.message).split('\n').slice(-2).join(' ').slice(0, 300))) : resolve()));
  });
  await fs.promises.rename(tmp, out);
  return out;
}

class AudioEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return { uri, dispose() {} }; }

  async resolveCustomEditor(document, panel) {
    const ctx = this.context;
    const uri = document.uri;
    const dist = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
    const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
    const cacheUri = vscode.Uri.joinPath(ctx.globalStorageUri, 'ffmpeg-cache');
    const folder = uri.with({ path: path.posix.dirname(uri.path) });
    // Command links are limited to the two support commands and the settings page (footer "Hide" link).
    panel.webview.options = { enableScripts: true, enableCommandUris: commandUris('audioPreview'), localResourceRoots: [dist, media, folder, cacheUri] };
    const name = path.posix.basename(uri.path);
    panel.webview.html = buildHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css')).toString(),
      title: name,
      showSupportLinks: showLinks(vscode, 'audioPreview'),
    });

    let disposed = false;
    const post = m => { if (!disposed) panel.webview.postMessage(m); };
    const cancelled = () => disposed;

    let counted = false; // one success per opened tab, for the rating prompt
    let original = null; // metadata of the file itself, kept when ffmpeg made a WAV copy
    const showFile = async (fileUri, converted) => {
      const t0 = Date.now();
      let src = null;
      try {
        src = await openSource(fileUri);
        const meta = await readMetadata(src, name);
        const plan = planDecode(meta, settings());
        if (!converted) original = meta;
        const shown = converted && original ? { ...original, sampleRate: meta.sampleRate, channels: meta.channels, totalFrames: meta.totalFrames, info: [...original.info, ['Decoded by', 'your ffmpeg (cached WAV copy)']] } : meta;
        post({ type: 'meta', meta: publicMeta(shown, name), plan, src: panel.webview.asWebviewUri(fileUri).toString(), converted: !!converted, openMs: Date.now() - t0 });
        if (!counted) { counted = true; rating.success(); }
        if (plan.mode === 'host') {
          const t1 = Date.now();
          const r = await analyzeWav(src, meta, pct => post({ type: 'progress', pct }), cancelled);
          if (!disposed) post({ type: 'analysis', result: encodeResult(r), ms: Date.now() - t1 });
        }
      } catch (e) {
        post({ type: 'error', message: e && e.message ? e.message : String(e) });
      } finally {
        if (src) await src.close();
      }
    };

    panel.webview.onDidReceiveMessage(async raw => {
      const v = validateWebviewMessage(raw);
      if (!v.ok) return;
      const msg = v.msg;
      if (msg.type === 'ready') return showFile(uri, false);
      if (msg.type === 'decoded') {
        const dir = process.env.AUDIO_PREVIEW_E2E; // dev-only end-to-end check
        if (dir) fs.promises.writeFile(path.join(dir, name + '.json'), JSON.stringify({ name, ...msg, ua: undefined })).catch(() => {});
        return;
      }
      if (msg.type === 'copy') { await vscode.env.clipboard.writeText(msg.text); post({ type: 'copied' }); return; }
      if (msg.type === 'decodeFailed') {
        const ok = uri.scheme === 'file' && vscode.workspace.isTrusted !== false ? await probeFfmpeg(settings().ffmpegPath) : null;
        post({ type: 'ffmpegOffer', available: !!ok, version: ok || null });
        return;
      }
      if (msg.type === 'ffmpeg') {
        if (uri.scheme !== 'file') { post({ type: 'error', message: 'ffmpeg decoding works only for files on local disk.' }); return; }
        post({ type: 'progress', pct: 0, label: 'Decoding with ffmpeg...' });
        try {
          const out = await ffmpegToWav(settings().ffmpegPath, uri.fsPath, cacheUri.fsPath);
          if (!disposed) await showFile(vscode.Uri.file(out), true);
        } catch (e) { post({ type: 'error', message: e.message || String(e) }); }
      }
    });
    panel.onDidDispose(() => { disposed = true; });
  }
}

function activate(context) {
  registerSupport({ vscode, context, prefix: 'audioPreview', selfId: 'zovo.audio-preview-vscode' });
  rating = createRatingPrompt({ vscode, context, extensionId: 'zovo.audio-preview-vscode', section: 'audioPreview', message: (n) => `Audio Preview has opened ${n} files for you. A rating helps other people find it.` });
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new AudioEditorProvider(context), {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('audioPreview.openWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', 'zovo.audio-preview-vscode#audioPreview.start', false)),
    vscode.commands.registerCommand('audioPreview.openWith', async uri => {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, AudioEditorProvider, VIEW_TYPE, analyzeWav, ffmpegToWav };
