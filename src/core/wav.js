'use strict';
// Decodes WAV sample data chunk by chunk into planar Float32 arrays.

function alaw(v) {
  v ^= 0x55;
  let t = (v & 0x0f) << 4; const seg = (v & 0x70) >> 4;
  t = seg === 0 ? t + 8 : seg === 1 ? t + 0x108 : (t + 0x108) << (seg - 1);
  return (v & 0x80 ? t : -t) / 32768;
}
function mulaw(v) {
  v = ~v & 0xff;
  let t = ((v & 0x0f) << 3) + 0x84; t <<= (v & 0x70) >> 4;
  return (v & 0x80 ? 0x84 - t : t - 0x84) / 32768;
}
const ALAW = new Float32Array(256).map((_, i) => alaw(i));
const MULAW = new Float32Array(256).map((_, i) => mulaw(i));

/** Converts interleaved bytes (whole frames) to planar Float32. */
function decodePcm(buf, wav, channels) {
  const bps = wav.bits / 8, frames = Math.floor(buf.length / (bps * channels));
  const out = []; for (let c = 0; c < channels; c++) out.push(new Float32Array(frames));
  let p = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v;
      if (wav.kind === 'int') {
        if (bps === 2) v = buf.readInt16LE(p) / 32768;
        else if (bps === 3) v = ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)) << 8 >> 8) / 8388608;
        else if (bps === 1) v = (buf[p] - 128) / 128;
        else v = buf.readInt32LE(p) / 2147483648;
      } else if (wav.kind === 'float') v = bps === 4 ? buf.readFloatLE(p) : buf.readDoubleLE(p);
      else if (wav.kind === 'alaw') v = ALAW[buf[p]];
      else v = MULAW[buf[p]];
      out[c][i] = v;
      p += bps;
    }
  }
  return out;
}

/**
 * Streams the data chunk. onChunk(planes) is awaited between reads so the host stays responsive.
 * @returns {Promise<number>} frames decoded
 */
async function streamWav(src, meta, onChunk, opts = {}) {
  const wav = meta.wav, ch = meta.channels;
  const frameBytes = wav.blockAlign;
  const chunkFrames = Math.max(1, Math.floor((opts.chunkBytes || 4 * 1048576) / frameBytes));
  const maxFrames = opts.maxFrames != null ? Math.min(opts.maxFrames, meta.totalFrames) : meta.totalFrames;
  let done = 0;
  while (done < maxFrames) {
    if (opts.cancelled && opts.cancelled()) break;
    const n = Math.min(chunkFrames, maxFrames - done);
    const buf = await src.read(wav.dataOffset + done * frameBytes, n * frameBytes);
    if (!buf.length) break;
    const planes = decodePcm(buf, wav, ch);
    if (!planes[0].length) break;
    await onChunk(planes, done);
    done += planes[0].length;
  }
  return done;
}

module.exports = { decodePcm, streamWav };
