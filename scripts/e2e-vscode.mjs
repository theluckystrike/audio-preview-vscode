// Dev-only end-to-end check in a real VS Code. Opens each fixture with this extension, waits for the
// webview to report how it decoded the file, and saves a window screenshot for chosen files.
// usage: node scripts/e2e-vscode.mjs <workDir> <port> <outJson> <file>... (prefix a file with "shot:" to capture it)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [work, port, outJson, ...files] = process.argv.slice(2);
const ext = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ud = path.join(work, 'ud'), out = path.join(work, 'reports');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(path.join(ud, 'User'), { recursive: true }); fs.mkdirSync(out, { recursive: true });
const assoc = Object.fromEntries(['wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac'].map(e => [`*.${e}`, 'audioPreview.player']));
fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({ 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true,
  'window.zoomLevel': 0, 'workbench.colorTheme': 'Default Dark Modern', 'workbench.activityBar.location': 'hidden', 'workbench.statusBar.visible': false, 'window.commandCenter': false,
  'workbench.layoutControl.enabled': false, 'workbench.editor.showTabs': 'single', 'workbench.editorAssociations': assoc, 'audioPreview.ffmpegPath': '/nonexistent/ffmpeg' }));
const code = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const child = spawn(code, [`--remote-debugging-port=${port}`, '--user-data-dir', ud, '--extensions-dir', path.join(work, 'ext'), '--skip-welcome', '--disable-workspace-trust',
  `--extensionDevelopmentPath=${ext}`, '--new-window'], { env: { ...process.env, AUDIO_PREVIEW_E2E: out }, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
let ws, send;
try {
  await sleep(6000);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && !t.url.includes('webview'));
  ws = new WebSocket(page.webSocketDebuggerUrl); let id = 0; const pend = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  await new Promise(r => (ws.onopen = r));
  send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  const key = async (k, code) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text: k === ' ' ? ' ' : k, unmodifiedText: k }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code }); };
  for (const spec of files) {
    const shot = spec.startsWith('shot:'), file = path.resolve(shot ? spec.slice(5) : spec), name = path.basename(file);
    const t0 = Date.now();
    spawn(code, ['--user-data-dir', ud, '--reuse-window', file], { stdio: 'ignore' });
    let rep = null;
    while (Date.now() - t0 < 30000) { try { rep = JSON.parse(fs.readFileSync(path.join(out, name + '.json'), 'utf8')); break; } catch { await sleep(250); } }
    results.push({ name, ...(rep || { how: 'timeout' }), wallMs: Date.now() - t0 });
    if (shot && rep) {
      await sleep(500);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: 640, y: 80, button: 'left', clickCount: 1 });
      await key(' ', 'Space'); await sleep(1300); await key('[', 'BracketLeft'); await sleep(2200); await key(']', 'BracketRight'); await sleep(900);
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(work, name + '.png'), Buffer.from(r.result.data, 'base64'));
      await key(' ', 'Space');
    }
  }
} catch (e) { results.push({ error: String(e.stack || e) }); }
try { ws && ws.close(); } catch {}
child.kill('SIGTERM'); await sleep(1500);
spawn('pkill', ['-f', ud]);
fs.writeFileSync(outJson, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
