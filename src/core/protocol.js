'use strict';
// Messages between the extension host and the webview, plus the decode plan.

const MB = 1048576;

/** Accepts only known webview messages with valid fields. */
function validateWebviewMessage(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return { ok: false };
  switch (raw.type) {
    case 'ready': return { ok: true, msg: { type: 'ready' } };
    case 'ffmpeg': return { ok: true, msg: { type: 'ffmpeg' } };
    case 'copy':
      if (typeof raw.text !== 'string' || !raw.text.length || raw.text.length > 20000) return { ok: false };
      return { ok: true, msg: { type: 'copy', text: raw.text } };
    case 'decodeFailed':
      return { ok: true, msg: { type: 'decodeFailed', message: typeof raw.message === 'string' ? raw.message.slice(0, 500) : '' } };
    case 'decoded': // the webview reports how the samples were decoded; written to disk only by the dev e2e check
      if (!['host', 'webaudio', 'webcodecs', 'wasm', 'failed', 'skipped'].includes(raw.how)) return { ok: false };
      return { ok: true, msg: { type: 'decoded', how: raw.how, ms: Number(raw.ms) || 0, integrated: typeof raw.integrated === 'number' ? raw.integrated : null, playable: !!raw.playable, note: typeof raw.note === 'string' ? raw.note.slice(0, 300) : '' } };
    default: return { ok: false };
  }
}

/**
 * Decides where the samples get decoded.
 * host: WAV, streamed in the extension host. webview: Web Audio or WebCodecs in the webview. none: metadata only.
 */
function planDecode(meta, s) {
  const fileMB = meta.fileSize / MB;
  if (meta.wav) {
    if (fileMB > s.maxWavMB) return { mode: 'none', reason: `This WAV file is ${fileMB.toFixed(0)} MB. The waveform, spectrogram and loudness are made for files up to ${s.maxWavMB} MB (setting audioPreview.maxWavMB). Playback still works.` };
    return { mode: 'host' };
  }
  if (meta.format === 'wav') return { mode: 'none', reason: meta.unsupported };
  const decodedMB = (meta.totalFrames || meta.durationSec * (meta.sampleRate || 48000)) * Math.max(1, meta.channels || 2) * 4 / MB;
  if (decodedMB > s.maxDecodedMB || fileMB > s.maxDecodedMB) {
    return { mode: 'none', reason: `This file decodes to about ${decodedMB.toFixed(0)} MB of samples, above the ${s.maxDecodedMB} MB limit (setting audioPreview.maxDecodedMB). Playback still works. The waveform, spectrogram and loudness are skipped.` };
  }
  return { mode: 'webview', decodedMB: Math.round(decodedMB) };
}

const fin = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

/** Metadata the webview may see: no file paths, no internal offsets except the MP4 sample table. */
function publicMeta(meta, name) {
  return {
    name, format: meta.format, codec: meta.codec || '', codecString: meta.codecString || null,
    sampleRate: meta.sampleRate || 0, channels: meta.channels || 0, bitDepth: meta.bitDepth || null,
    durationSec: fin(meta.durationSec) || 0, estimated: !!meta.estimated, bitrate: meta.bitrate || 0, fileSize: meta.fileSize,
    totalFrames: meta.totalFrames || 0,
    tags: meta.tags.slice(0, 200).map(([k, v]) => [String(k).slice(0, 100), String(v).slice(0, 2000)]),
    info: meta.info.slice(0, 100).map(([k, v]) => [String(k).slice(0, 100), String(v).slice(0, 500)]),
    asc: meta.asc ? Buffer.from(meta.asc).toString('base64') : null,
    samples: meta.samples && meta.samples.offsets.length <= 2000000 ? meta.samples : null,
  };
}

/** Analyzer result to a JSON-safe message body. */
function encodeResult(r) {
  const round = a => Array.from(a, v => Math.round(v * 10000) / 10000);
  const st = r.stats;
  return {
    frames: r.frames,
    stats: {
      peakDb: fin(st.peakDb), rmsDb: fin(st.rmsDb), clipped: st.clipped, integrated: fin(st.integrated), momentaryMax: fin(st.momentaryMax), shortTermMax: fin(st.shortTermMax),
      channels: st.channels.map(c => ({ peakDb: fin(c.peakDb), rmsDb: fin(c.rmsDb), dc: fin(c.dc) })),
    },
    waveform: { buckets: r.waveform.buckets, min: r.waveform.min.map(round), max: r.waveform.max.map(round) },
    spectrogram: { cols: r.spectrogram.cols, rows: r.spectrogram.rows, minHz: r.spectrogram.minHz, maxHz: r.spectrogram.maxHz, b64: Buffer.from(r.spectrogram.data).toString('base64') },
  };
}

module.exports = { validateWebviewMessage, planDecode, publicMeta, encodeResult };
