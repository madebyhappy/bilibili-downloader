const { FFmpeg } = self.FFmpegWASM || {};

let ffmpeg = null;
let ffmpegLoading = null;
let currentJob = null;

class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.cancelled = true;
  }
}

function throwIfCancelled(job) {
  if (job?.cancelled) throw new CancelledError();
}

let currentLabel = '';

function post(type, payload = {}) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}

// label rides on every progress message so it survives a service-worker restart
// mid-download (MV3 wipes the SW's in-memory state; only re-sent fields survive).
function progress(phase, pct, message) {
  post('progress', { payload: { phase, progress: pct, message, label: currentLabel } });
}

async function loadFFmpeg() {
  if (ffmpeg && ffmpeg.loaded) return ffmpeg;
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    const inst = new FFmpeg();
    inst.on('log', ({ message }) => console.log('[ffmpeg]', message));
    inst.on('progress', ({ progress: p }) => {
      if (typeof p === 'number' && p >= 0 && p <= 1) {
        progress('mux', Math.round(p * 100), `合并中… ${Math.round(p * 100)}%`);
      }
    });
    await inst.load({
      coreURL: chrome.runtime.getURL('vendor/ffmpeg-core.js'),
      wasmURL: chrome.runtime.getURL('vendor/ffmpeg-core.wasm'),
    });
    ffmpeg = inst;
    return inst;
  })();
  return ffmpegLoading;
}

const STALL_MS = 15000; // no bytes for 15s -> treat as stalled and try backup URL
const RANGE_CHUNK_SIZE = 8 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 3; // parallel range requests — gentle enough to avoid CDN drops, still faster than serial

function parseContentRange(value) {
  const m = String(value || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === '*' ? 0 : Number(m[3]),
  };
}

function makeStallController(job) {
  const ctrl = new AbortController();
  job?.controllers.add(ctrl);
  let stallTimer = null;
  const arm = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ctrl.abort(new Error('stalled')), STALL_MS);
  };
  const clear = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    job?.controllers.delete(ctrl);
  };
  return { ctrl, arm, clear };
}

async function readResponseAsUint8(res, expectedLength, onBytes) {
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (expectedLength && buf.byteLength !== expectedLength) {
      throw new Error(`incomplete response: ${buf.byteLength}/${expectedLength} bytes`);
    }
    onBytes?.(buf.byteLength);
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes?.(value.length);
  }
  if (expectedLength && received !== expectedLength) {
    throw new Error(`incomplete response: ${received}/${expectedLength} bytes`);
  }

  const combined = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.length;
  }
  return combined;
}

async function fetchRange(url, start, end, onChunkProgress, job) {
  const { ctrl, arm, clear } = makeStallController(job);
  arm();
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Range: `bytes=${start}-${end}` },
    });
  } catch (e) {
    clear();
    throw e;
  }

  if (res.status !== 206) {
    clear();
    if (res.status === 200 && start === 0) {
      return { fullResponse: res };
    }
    throw new Error(`range HTTP ${res.status}`);
  }

  const range = parseContentRange(res.headers.get('content-range'));
  if (!range || range.start !== start || range.end !== end) {
    clear();
    throw new Error(`bad content-range: ${res.headers.get('content-range') || 'missing'}`);
  }

  try {
    const expected = end - start + 1;
    const bytes = await readResponseAsUint8(res, expected, (n) => {
      arm();
      onChunkProgress?.(n);
    });
    return { bytes, total: range.total };
  } finally {
    clear();
  }
}

async function getRemoteSize(url, job) {
  const { ctrl, arm, clear } = makeStallController(job);
  arm();
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Range: 'bytes=0-0' },
    });
  } catch (e) {
    clear();
    throw e;
  }
  try {
    if (res.status === 206) {
      const range = parseContentRange(res.headers.get('content-range'));
      if (!range?.total) throw new Error('missing content-range total');
      await readResponseAsUint8(res, 1, () => arm());
      return range.total;
    }
    if (res.status === 200) {
      const total = Number(res.headers.get('content-length')) || 0;
      return { fullResponse: res, total };
    }
    throw new Error(`HTTP ${res.status}`);
  } finally {
    clear();
  }
}

const MAX_CHUNK_RETRIES = 10; // be stubborn — a flaky chunk must never sink the whole file

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find a URL that reports the total size. Returns { total } (server supports
// Range) or { fullResponse, total } (server ignored Range and sent a 200).
async function probeSize(urls, job) {
  let lastErr = null;
  for (const url of urls) {
    throwIfCancelled(job);
    try {
      const info = await getRemoteSize(url, job);
      if (typeof info === 'object' && info.fullResponse) {
        return { fullResponse: info.fullResponse, url, total: info.total };
      }
      return { url, total: info };
    } catch (e) {
      throwIfCancelled(job);
      lastErr = e;
      console.warn(`[bilibili-dl] size probe failed (${hostOf(url)}): ${e?.message || e}`);
    }
  }
  throw lastErr || new Error('no source returned a size');
}

// Download one [start,end] chunk, retrying across all URLs. Reports byte
// deltas via onDelta (positive while receiving, negative to roll back a failed
// partial attempt) so the caller's running total stays accurate across retries.
async function fetchChunkWithRetry(urls, start, end, job, onDelta) {
  const size = end - start + 1;
  const attempts = Math.max(urls.length, MAX_CHUNK_RETRIES);
  // Different chunks start on different CDN sources so the pool doesn't all
  // hammer the primary node at once (which is what triggers the drops).
  const base = Math.floor(start / RANGE_CHUNK_SIZE);
  let lastErr = null;
  for (let a = 0; a < attempts; a++) {
    throwIfCancelled(job);
    const url = urls[(a + base) % urls.length];
    let got = 0;
    try {
      const { bytes } = await fetchRange(url, start, end, (n) => {
        got += n;
        onDelta(n);
      }, job);
      if (!bytes) throw new Error('server ignored Range mid-file');
      if (bytes.length !== size) throw new Error(`chunk size ${bytes.length}/${size}`);
      return bytes;
    } catch (e) {
      throwIfCancelled(job);
      lastErr = e;
      if (got) onDelta(-got); // roll back this failed attempt's bytes
      console.warn(`[bilibili-dl] chunk ${start}-${end} failed (${hostOf(url)}): ${e?.message || e}. retry ${a + 1}/${attempts}`);
      if (a + 1 < attempts) await sleep(Math.min(600 * 2 ** a, 5000)); // exp backoff, capped 5s
    }
  }
  throw lastErr || new Error(`chunk ${start}-${end} failed after ${attempts} tries`);
}

// Resumable chunked download: completed chunks are kept, only a failed chunk is
// re-fetched — a single stalled node no longer restarts the whole file.
async function fetchChunkedResumable(urls, onProgress, job, concurrency) {
  const probe = await probeSize(urls, job);

  // Server won't honor Range on this URL: stream the full 200 response.
  if (probe.fullResponse) {
    let received = 0;
    return await readResponseAsUint8(probe.fullResponse, probe.total, (n) => {
      received += n;
      onProgress(received, probe.total || received);
    });
  }

  const total = probe.total;
  const combined = new Uint8Array(total);
  let received = 0;
  const onDelta = (d) => { received += d; onProgress(received, total); };

  // Split into chunk ranges, then drain them with a pool of N workers running
  // concurrently. Multiple connections each get their own per-connection speed
  // cap from the CDN, so aggregate throughput is much closer to the real line.
  const ranges = [];
  for (let start = 0; start < total; start += RANGE_CHUNK_SIZE) {
    ranges.push([start, Math.min(start + RANGE_CHUNK_SIZE - 1, total - 1)]);
  }

  let next = 0;
  let failed = null;
  async function worker(k) {
    if (k) await sleep(k * 250); // stagger connection ramp-up
    while (!failed && !job.cancelled) {
      const i = next++;
      if (i >= ranges.length) return;
      const [start, end] = ranges[i];
      try {
        const bytes = await fetchChunkWithRetry(urls, start, end, job, onDelta);
        combined.set(bytes, start);
      } catch (e) {
        failed = failed || e;
        return;
      }
    }
  }

  const poolSize = Math.min(concurrency || DOWNLOAD_CONCURRENCY, ranges.length);
  await Promise.all(Array.from({ length: poolSize }, (_, k) => worker(k)));
  if (job.cancelled) throwIfCancelled(job);
  if (failed) throw failed;
  if (received !== total) throw new Error(`incomplete download: ${received}/${total} bytes`);
  return combined;
}

async function fetchOneAsUint8(url, onProgress, job) {
  const { ctrl, arm, clear } = makeStallController(job);
  arm();
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } catch (e) {
    clear();
    throw e;
  }
  if (!res.ok) {
    clear();
    throw new Error(`HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    clear();
    const buf = await res.arrayBuffer();
    if (total && buf.byteLength !== total) {
      throw new Error(`incomplete response: ${buf.byteLength}/${total} bytes`);
    }
    onProgress(buf.byteLength, buf.byteLength);
    return new Uint8Array(buf);
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let lastTick = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      arm();
      const now = Date.now();
      if (now - lastTick > 200) {
        onProgress(received, total || received);
        lastTick = now;
      }
    }
  } finally {
    clear();
  }
  if (total && received !== total) {
    throw new Error(`incomplete response: ${received}/${total} bytes`);
  }
  onProgress(received, total || received);
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { combined.set(c, offset); offset += c.length; }
  return combined;
}

async function fetchAsUint8(urls, onProgress, job, concurrency) {
  const list = Array.isArray(urls) ? urls : [urls];
  if (!list.length) throw new Error('no url');
  try {
    return await fetchChunkedResumable(list, onProgress, job, concurrency);
  } catch (e) {
    throwIfCancelled(job);
    console.warn(`[bilibili-dl] resumable download failed: ${e?.message || e}. last-resort full GET`);
    // Last resort only: whole-file GET per URL (no resume; the old behaviour).
    let lastErr = e;
    for (const url of list) {
      try {
        onProgress(0, 0);
        return await fetchOneAsUint8(url, onProgress, job);
      } catch (e2) {
        throwIfCancelled(job);
        lastErr = e2;
        console.warn(`[bilibili-dl] full GET failed (${hostOf(url)}): ${e2?.message || e2}`);
      }
    }
    throw lastErr || new Error('all sources failed');
  }
}

const activeBlobUrls = new Set();

async function doMerge(payload) {
  const job = { cancelled: false, controllers: new Set(), muxing: false };
  currentJob = job;
  const { videoUrls, audioUrls, videoUrl, audioUrl, filename } = payload;
  currentLabel = payload.label || '';
  const vUrls = videoUrls || (videoUrl ? [videoUrl] : []);
  const aUrls = audioUrls || (audioUrl ? [audioUrl] : []);
  // accelerate = parallel (from popup toggle); serial (1) is the gentle fallback.
  const concurrency = payload.concurrency || DOWNLOAD_CONCURRENCY;
  const mb = n => (n / 1024 / 1024).toFixed(1);

  try {
    // Each stream fills the bar 0→100 on its own, then resets for the next —
    // so the bar always reflects the real byte ratio of the current stream.
    progress('video', 0, '下载视频…');
    const videoBytes = await fetchAsUint8(vUrls, (r, t) => {
      const pct = t ? Math.round((r / t) * 100) : 0;
      progress('video', pct, `下载视频 ${mb(r)}${t ? '/' + mb(t) : ''} MB`);
    }, job, concurrency);
    throwIfCancelled(job);

    progress('audio', 0, '下载音频…');
    const audioBytes = await fetchAsUint8(aUrls, (r, t) => {
      const pct = t ? Math.round((r / t) * 100) : 0;
      progress('audio', pct, `下载音频 ${mb(r)}${t ? '/' + mb(t) : ''} MB`);
    }, job, concurrency);
    throwIfCancelled(job);

    progress('ffmpeg-load', 0, '加载 ffmpeg (首次会等几秒)…');
    job.muxing = true;
    const ff = await loadFFmpeg();
    throwIfCancelled(job);

    progress('mux', 0, '合并中…');
    await ff.writeFile('video.m4s', videoBytes);
    await ff.writeFile('audio.m4s', audioBytes);

    let code = await ff.exec([
      '-i', 'video.m4s',
      '-i', 'audio.m4s',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y', 'out.mp4',
    ]);
    throwIfCancelled(job);
    if (code !== 0) {
      progress('mux', 0, '重试合并 (不带 faststart)…');
      code = await ff.exec([
        '-i', 'video.m4s',
        '-i', 'audio.m4s',
        '-c', 'copy',
        '-y', 'out.mp4',
      ]);
      throwIfCancelled(job);
      if (code !== 0) throw new Error(`ffmpeg exit ${code}`);
    }

    progress('read', 100, '读取输出…');
    const output = await ff.readFile('out.mp4');
    job.muxing = false;

    await ff.deleteFile('video.m4s').catch(() => {});
    await ff.deleteFile('audio.m4s').catch(() => {});
    await ff.deleteFile('out.mp4').catch(() => {});

    const blob = new Blob([output], { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);

    progress('save', 100, '交给下载器…');
    post('result', { blobUrl, filename });
  } catch (e) {
    if (job.cancelled || e?.cancelled) {
      post('cancelled', {});
    } else {
      console.error(e);
      post('error', { message: e.message });
    }
    if (ffmpeg?.loaded) {
      for (const f of ['video.m4s', 'audio.m4s', 'out.mp4']) {
        ffmpeg.deleteFile(f).catch(() => {});
      }
    }
  } finally {
    if (currentJob === job) currentJob = null;
  }
}

function cancelCurrentJob() {
  const job = currentJob;
  if (!job || job.cancelled) return;
  job.cancelled = true;
  for (const ctrl of job.controllers) {
    ctrl.abort(new DOMException('cancelled', 'AbortError'));
  }
  // ffmpeg.wasm has no per-exec abort; killing the worker is the only way to
  // stop a running mux. The core reloads lazily on the next merge.
  if (job.muxing && ffmpeg) {
    try { ffmpeg.terminate(); } catch (e) { /* already dead */ }
    ffmpeg = null;
    ffmpegLoading = null;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'merge') {
    doMerge(msg.payload);
  } else if (msg.type === 'cancel') {
    cancelCurrentJob();
  } else if (msg.type === 'revoke') {
    URL.revokeObjectURL(msg.blobUrl);
    activeBlobUrls.delete(msg.blobUrl);
  }
});
