'use strict';
// Streaming audio analyzer. Feed planar Float32 chunks; get waveform peaks, a spectrogram,
// sample peak, RMS and an ITU-R BS.1770-4 loudness estimate. No DOM and no Node APIs, so the
// extension host (WAV) and the webview (decoded MP3, FLAC, Ogg, Opus, AAC) run the same code.

/** In-place radix-2 FFT. re and im have length n (a power of two). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** K-weighting biquads for any sample rate (same derivation as libebur128). */
function kWeighting(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const pre = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const rlb = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [pre, rlb];
}

const toDb = x => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const lufs = ms => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);

class Analyzer {
  /**
   * @param {{sampleRate:number, channels:number, totalFrames:number, buckets?:number, columns?:number, fftSize?:number, rows?:number}} o
   */
  constructor(o) {
    this.sr = o.sampleRate; this.ch = o.channels; this.total = Math.max(1, o.totalFrames);
    this.buckets = Math.max(1, Math.min(o.buckets || 1600, this.total));
    this.min = []; this.max = [];
    for (let c = 0; c < this.ch; c++) { this.min.push(new Float32Array(this.buckets).fill(1)); this.max.push(new Float32Array(this.buckets).fill(-1)); }
    this.peak = new Float64Array(this.ch); this.sumSq = new Float64Array(this.ch); this.sum = new Float64Array(this.ch); this.clipped = 0;
    // loudness: 100 ms segments, 400 ms momentary blocks (75 % overlap), 3 s short-term
    this.filters = kWeighting(this.sr);
    this.fstate = []; for (let c = 0; c < this.ch; c++) this.fstate.push(new Float64Array(8));
    this.weights = []; for (let c = 0; c < this.ch; c++) this.weights.push(this.ch === 6 ? (c === 3 ? 0 : c >= 4 ? 1.41 : 1) : 1);
    this.segLen = Math.max(1, Math.round(this.sr / 10)); this.segPos = 0; this.segAcc = 0; this.segments = [];
    // spectrogram on the mono mix
    this.n = o.fftSize || 2048; this.cols = Math.max(1, Math.min(o.columns || 900, this.total)); this.rows = o.rows || 192;
    this.ring = new Float32Array(this.n); this.pos = 0; this.nextCol = 0;
    this.spec = new Uint8Array(this.cols * this.rows);
    this.win = new Float32Array(this.n); for (let i = 0; i < this.n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (this.n - 1));
    this.re = new Float64Array(this.n); this.im = new Float64Array(this.n);
    this.rowBins = this._rowMap();
    this.frames = 0;
  }

  colStart(c) { return Math.floor(c * Math.max(0, this.total - this.n) / Math.max(1, this.cols - 1 || 1)); }

  _rowMap() { // log frequency rows from 30 Hz to Nyquist; each row = [bin lo, bin hi)
    const nyq = this.sr / 2, lo = Math.min(30, nyq / 4), map = [];
    const half = this.n / 2;
    for (let r = 0; r <= this.rows; r++) map.push(Math.min(half, Math.max(1, Math.round(lo * Math.pow(nyq / lo, r / this.rows) / nyq * half))));
    return map;
  }

  /** @param {Float32Array[]} planes one array per channel, same length */
  push(planes) {
    const len = planes[0].length, ch = this.ch, total = this.total, B = this.buckets;
    for (let c = 0; c < ch; c++) {
      const x = planes[c], mn = this.min[c], mx = this.max[c];
      const st = this.fstate[c];
      const [p, r] = this.filters;
      let pk = this.peak[c], ss = this.sumSq[c], s = this.sum[c], clip = 0;
      let x1 = st[0], x2 = st[1], y1 = st[2], y2 = st[3], z1 = st[4], z2 = st[5];
      const kw = this.kbuf || (this.kbuf = []);
      const k = kw[c] && kw[c].length >= len ? kw[c] : (kw[c] = new Float64Array(len));
      for (let i = 0; i < len; i++) {
        const v = x[i];
        const a = v < 0 ? -v : v;
        if (a > pk) pk = a;
        if (a >= 0.99997) clip++;
        ss += v * v; s += v;
        const b = Math.floor((this.frames + i) * B / total);
        const bi = b < B ? b : B - 1;
        if (v < mn[bi]) mn[bi] = v;
        if (v > mx[bi]) mx[bi] = v;
        const y = p.b0 * v + p.b1 * x1 + p.b2 * x2 - p.a1 * y1 - p.a2 * y2;
        x2 = x1; x1 = v;
        const z = r.b0 * y + r.b1 * y1 + r.b2 * y2 - r.a1 * z1 - r.a2 * z2;
        y2 = y1; y1 = y; z2 = z1; z1 = z;
        k[i] = z * z;
      }
      st[0] = x1; st[1] = x2; st[2] = y1; st[3] = y2; st[4] = z1; st[5] = z2;
      this.peak[c] = pk; this.sumSq[c] = ss; this.sum[c] = s; this.clipped += clip;
    }
    // loudness segments
    for (let i = 0; i < len; i++) {
      let e = 0;
      for (let c = 0; c < ch; c++) e += this.weights[c] * this.kbuf[c][i];
      this.segAcc += e;
      if (++this.segPos === this.segLen) { this.segments.push(this.segAcc / this.segLen); this.segAcc = 0; this.segPos = 0; }
    }
    // spectrogram
    for (let i = 0; i < len; i++) {
      let m = 0;
      for (let c = 0; c < ch; c++) m += planes[c][i];
      this.ring[this.pos % this.n] = m / ch;
      this.pos++;
      while (this.nextCol < this.cols && this.pos >= this.colStart(this.nextCol) + this.n) this._column(this.nextCol++);
    }
    this.frames += len;
  }

  _column(c) {
    const n = this.n, start = this.colStart(c), re = this.re, im = this.im;
    for (let i = 0; i < n; i++) {
      const p = start + i;
      const v = p < this.pos && p >= this.pos - n ? this.ring[p % n] : 0;
      re[i] = v * this.win[i]; im[i] = 0;
    }
    fft(re, im);
    const rows = this.rows, map = this.rowBins, norm = 4 / n; // Hann gain 0.5, one-sided x2
    for (let r = 0; r < rows; r++) {
      let best = 0;
      for (let b = map[r], e = Math.max(map[r] + 1, map[r + 1]); b < e; b++) { const m = re[b] * re[b] + im[b] * im[b]; if (m > best) best = m; }
      const db = 10 * Math.log10(best * norm * norm + 1e-20); // 0 dB = full-scale sine
      const v = Math.round((db + 120) / 120 * 255);
      this.spec[(rows - 1 - r) * this.cols + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  loudness() {
    const seg = this.segments.slice();
    if (this.segPos > 0 && seg.length < 4) seg.push(this.segAcc / this.segPos); // very short files
    const blocks = [];
    for (let i = 0; i + 4 <= seg.length; i++) blocks.push((seg[i] + seg[i + 1] + seg[i + 2] + seg[i + 3]) / 4);
    if (!blocks.length && seg.length) blocks.push(seg.reduce((a, b) => a + b, 0) / seg.length);
    let momentaryMax = -Infinity;
    for (const b of blocks) momentaryMax = Math.max(momentaryMax, lufs(b));
    let shortTermMax = -Infinity;
    if (seg.length >= 30) {
      let acc = 0;
      for (let i = 0; i < seg.length; i++) { acc += seg[i]; if (i >= 30) acc -= seg[i - 30]; if (i >= 29) shortTermMax = Math.max(shortTermMax, lufs(acc / 30)); }
    } else shortTermMax = blocks.length ? lufs(seg.reduce((a, b) => a + b, 0) / seg.length) : -Infinity;
    const abs = blocks.filter(b => lufs(b) > -70);
    let integrated = -Infinity;
    if (abs.length) {
      const rel = lufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
      const gated = abs.filter(b => lufs(b) > rel);
      if (gated.length) integrated = lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
    }
    return { integrated, momentaryMax, shortTermMax };
  }

  result() {
    while (this.nextCol < this.cols) this._column(this.nextCol++);
    const frames = Math.max(1, this.frames);
    const channels = [];
    for (let c = 0; c < this.ch; c++) {
      channels.push({ peakDb: toDb(this.peak[c]), rmsDb: toDb(Math.sqrt(this.sumSq[c] / frames)), dc: this.sum[c] / frames });
      // buckets never touched (only when frames < total) stay flat
      for (let b = 0; b < this.buckets; b++) if (this.min[c][b] > this.max[c][b]) { this.min[c][b] = 0; this.max[c][b] = 0; }
    }
    let allSq = 0; for (let c = 0; c < this.ch; c++) allSq += this.sumSq[c];
    return {
      frames: this.frames,
      stats: {
        peakDb: toDb(Math.max(...this.peak)), rmsDb: toDb(Math.sqrt(allSq / (frames * this.ch))),
        clipped: this.clipped, channels, ...this.loudness(),
      },
      waveform: { buckets: this.buckets, min: this.min, max: this.max },
      spectrogram: { cols: this.cols, rows: this.rows, data: this.spec, minHz: this.sr / 2 * this.rowBins[0] / (this.n / 2), maxHz: this.sr / 2, sampleRate: this.sr },
    };
  }
}

module.exports = { Analyzer, fft, kWeighting, toDb };
