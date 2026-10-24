const QUALITY_LABELS = {
  6: '240P', 16: '360P', 32: '480P',
  64: '720P', 74: '720P60',
  80: '1080P', 112: '1080P+', 116: '1080P60',
  120: '4K', 125: 'HDR', 126: 'Dolby Vision', 127: '8K',
};

const CODEC_LABELS = {
  7:  { short: 'H.264', note: '兼容性最好' },
  12: { short: 'H.265', note: '体积更小' },
  13: { short: 'AV1',   note: '体积最小，需新播放器' },
};

const AUDIO_ID_LABELS = {
  30216: '64K', 30232: '132K', 30280: '192K',
  30250: 'Dolby', 30251: 'FLAC',
};

function sanitize(s) {
  let out = (s || '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')                        // control chars
    .replace(/[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]/g, '')                        // zero-width / joiners / BOM
    .replace(/[\ufe00-\ufe0f]/g, '')                        // variation selectors
    .replace(/\p{Extended_Pictographic}/gu, '')   // emoji (keeps CJK)
    .replace(/[\\/:*?"<>|]/g, '_')                // filesystem-reserved
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.\s]+$/g, '');                     // no trailing dot/space
  out = [...out].slice(0, 100).join('').trim();   // slice by code point, not unit
  return out || 'bilibili';
}

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  Object.assign(n, props);
  for (const c of children) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

async function readPageInfo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/bilibili\.com\/(video|bangumi\/play|list)\//.test(tab.url)) {
    return { error: '请在 B 站视频页 (bilibili.com/video/…、/bangumi/play/… 或 /list/…) 打开此插件' };
  }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: () => {
      const info = window.__playinfo__ || null;
      const state = window.__INITIAL_STATE__ || null;
      const title = (document.title || '')
        .replace(/_哔哩哔哩_bilibili$/, '')
        .replace(/ - 哔哩哔哩$/, '');
      let bvid = null, aid = null, cid = null;
      // /video/BVxxxx in the path, or ?bvid= / ?oid= in the query — the latter
      // is how /list/watchlater and favlist players carry the current video.
      const url = new URL(location.href);
      const m = location.pathname.match(/\/video\/(BV[\w]+)/);
      if (m) bvid = m[1];
      bvid = bvid || url.searchParams.get('bvid');
      const oid = url.searchParams.get('oid');
      if (oid && /^\d+$/.test(oid)) aid = Number(oid);
      // Which part of a multi-part (多P) video is on screen. B站 switches parts
      // via SPA routing and only updates the URL's ?p=, so this is the one
      // reliable signal for the selected part. `pages` lists every part with
      // its own cid and survives part switches (it's the whole set).
      const p = Number(url.searchParams.get('p')) || 1;
      let pages = null;
      if (state?.videoData) {
        bvid = bvid || state.videoData.bvid;
        aid = aid || state.videoData.aid;
        cid = cid || state.videoData.cid;
        pages = state.videoData.pages || null;
      }
      if (state?.epInfo) {
        aid = aid || state.epInfo.aid;
        cid = cid || state.epInfo.cid;
      }
      return { playinfo: info, initialState: state, title, bvid, aid, cid, p, pages };
    },
  });
  return res.result;
}

async function fetchPlayurl({ bvid, aid, cid }) {
  if (!cid) throw new Error('缺少 cid，无法请求 playurl');
  const params = new URLSearchParams({
    fnval: '4048', fnver: '0', fourk: '1', qn: '127',
  });
  if (bvid) params.set('bvid', bvid);
  if (aid) params.set('avid', String(aid));
  params.set('cid', String(cid));
  const url = `https://api.bilibili.com/x/player/wbi/playurl?${params}`;
  const r = await fetch(url, { credentials: 'include' });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`playurl 接口错误: ${j.message || j.code}`);
  return j.data;
}

// --- Subtitles -------------------------------------------------------------

// Bilibili exposes both human-authored and AI-generated subtitles through the
// player/v2 endpoint. Requires the user to be logged in (cookies are sent via
// credentials:'include'; rules.json fixes up referer/origin for hdslb.com).
async function fetchSubtitles({ bvid, aid, cid }) {
  if (!cid) return [];
  const params = new URLSearchParams();
  if (bvid) params.set('bvid', bvid);
  if (aid) params.set('aid', String(aid));
  params.set('cid', String(cid));
  const url = `https://api.bilibili.com/x/player/wbi/v2?${params}`;
  let j;
  try {
    const r = await fetch(url, { credentials: 'include' });
    j = await r.json();
  } catch {
    return [];
  }
  if (j.code !== 0) return [];
  const subs = j.data?.subtitle?.subtitles || [];
  return subs
    .map(s => ({
      lan: s.lan,
      lanDoc: s.lan_doc,
      isAi: s.type === 1 || /^ai[-_]/i.test(s.lan || '') || /自动生成|AI/i.test(s.lan_doc || ''),
      url: s.subtitle_url?.startsWith('//') ? 'https:' + s.subtitle_url : s.subtitle_url,
    }))
    .filter(s => s.url);
}

function srtTime(sec) {
  const total = Math.max(0, sec);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const whole = Math.floor(total);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

// Bilibili subtitle JSON -> SRT
function jsonToSrt(body) {
  return body
    .map((it, i) =>
      `${i + 1}\n${srtTime(it.from)} --> ${srtTime(it.to)}\n${(it.content || '').trim()}\n`)
    .join('\n');
}

async function onDownloadSubtitle(sub, baseName, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '下载中…';
  try {
    const r = await fetch(sub.url, { credentials: 'omit' });
    const j = await r.json();
    const body = j.body || [];
    if (!body.length) {
      setStatus(`「${sub.lanDoc}」字幕是空的。`, true);
      btn.textContent = original;
      btn.disabled = false;
      return;
    }
    const srt = jsonToSrt(body);
    const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
    const objUrl = URL.createObjectURL(blob);
    const lanTag = sanitize(sub.lan || sub.lanDoc || 'sub');
    await chrome.downloads.download({ url: objUrl, filename: `${baseName}.${lanTag}.srt` });
    setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    btn.textContent = '已保存';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1500);
  } catch (e) {
    setStatus('字幕下载失败: ' + e.message, true);
    btn.textContent = original;
    btn.disabled = false;
  }
}

function renderSubtitles(subs, title) {
  const container = document.getElementById('subtitles');
  container.innerHTML = '';
  if (!subs.length) return;

  const baseName = sanitize(title);
  container.appendChild(el('div', { className: 'codec-header', textContent: '字幕 (SRT)' }));

  for (const sub of subs) {
    const row = el('div', { className: 'row' });
    const info = el('div', { className: 'row-info' });
    const titleLine = el('div', { className: 'row-title' });
    titleLine.appendChild(document.createTextNode(sub.lanDoc || sub.lan));
    if (sub.isAi) titleLine.appendChild(el('span', { className: 'ai-tag', textContent: 'AI' }));
    info.appendChild(titleLine);
    info.appendChild(el('div', { className: 'row-sub', textContent: sub.lan }));
    row.appendChild(info);
    const btn = el('button', { className: 'dl-btn', textContent: '下载' });
    btn.onclick = () => onDownloadSubtitle(sub, baseName, btn);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

// Recover cid from bvid/aid when the page state doesn't carry it (e.g. the
// /list/watchlater and favlist players). Returns the first part's cid.
async function fetchPageList({ bvid, aid }) {
  const params = new URLSearchParams();
  if (bvid) params.set('bvid', bvid);
  else if (aid) params.set('aid', String(aid));
  else return [];
  const r = await fetch(`https://api.bilibili.com/x/player/pagelist?${params}`, { credentials: 'include' });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`pagelist 接口错误: ${j.message || j.code}`);
  return j.data || [];
}

async function fetchCid(ids) {
  const pages = await fetchPageList(ids);
  return pages[0]?.cid || null;
}

function collectUrls(entry) {
  const raw = [
    entry.baseUrl, entry.base_url,
    ...(entry.backupUrl || entry.backup_url || []),
  ];
  const seen = new Set();
  const urls = [];
  for (const u of raw) {
    if (!u) continue;
    const https = u.startsWith('http://') ? 'https://' + u.slice(7) : u;
    if (seen.has(https)) continue;
    seen.add(https);
    urls.push(https);
  }
  // Prefer direct source (upos-*.bilivideo.com) over MCDN / PCDN (slower, throttled, often drops).
  urls.sort((a, b) => {
    const score = u =>
      /mcdn\./.test(u) ? 2 :
      /szbdyd\.com|\.pcdn\./.test(u) ? 1 : 0;
    return score(a) - score(b);
  });
  return urls;
}

function extractStreams(data) {
  if (!data) return null;
  const out = { videos: [], audios: [] };
  if (data.dash) {
    for (const v of data.dash.video || []) {
      out.videos.push({
        id: v.id, codecid: v.codecid, bandwidth: v.bandwidth,
        width: v.width, height: v.height, frameRate: v.frameRate,
        urls: collectUrls(v),
      });
    }
    for (const a of data.dash.audio || []) {
      out.audios.push({ id: a.id, bandwidth: a.bandwidth, urls: collectUrls(a) });
    }
    if (data.dash.dolby?.audio) {
      for (const a of data.dash.dolby.audio) {
        out.audios.push({ id: 30250, bandwidth: a.bandwidth, urls: collectUrls(a) });
      }
    }
    if (data.dash.flac?.audio) {
      const a = data.dash.flac.audio;
      out.audios.push({ id: 30251, bandwidth: a.bandwidth, urls: collectUrls(a) });
    }
  }
  return out;
}

function pickBestAudio(audios) {
  if (!audios.length) return null;
  const flac = audios.find(a => a.id === 30251);
  if (flac) return flac;
  const dolby = audios.find(a => a.id === 30250);
  if (dolby) return dolby;
  return [...audios].sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

function makeRow(v, c, audio, baseName) {
  const q = QUALITY_LABELS[v.id] || `qn${v.id}`;
  const row = el('div', { className: 'row' });
  const info = el('div', { className: 'row-info' });
  info.appendChild(el('div', { className: 'row-title', textContent: q }));
  info.appendChild(el('div', {
    className: 'row-sub',
    textContent: `${v.width}×${v.height} · ${v.frameRate || ''}fps · ${Math.round(v.bandwidth / 1000)}kbps`,
  }));
  row.appendChild(info);
  const btn = el('button', { className: 'dl-btn', textContent: '下载' });
  const filename = `${baseName}_${q}_${c.short}.mp4`;
  btn.onclick = () => onDownload(v, audio, filename, `${q} · ${c.short}`);
  row.appendChild(btn);
  return row;
}

// H.264 primary (top, expanded), then H.265 and AV1 as collapsible sections
const CODEC_LAYOUT_ORDER = [7, 12, 13];

function renderQualities(streams, title) {
  const container = document.getElementById('qualities');
  container.innerHTML = '';

  if (!streams.videos.length) {
    container.appendChild(el('div', { className: 'empty', textContent: '这个视频没有 DASH 视频流可用。' }));
    return;
  }

  const bestAudio = pickBestAudio(streams.audios);
  const audioHint = document.getElementById('audio-hint');
  audioHint.textContent = bestAudio
    ? `将自动配对音频：${AUDIO_ID_LABELS[bestAudio.id] || 'id ' + bestAudio.id}`
    : '(此视频没有独立音轨可拿)';

  // Dedup: highest-bandwidth entry per (qn, codec)
  const buckets = new Map();
  for (const v of streams.videos) {
    const key = `${v.id}-${v.codecid}`;
    if (!buckets.has(key) || buckets.get(key).bandwidth < v.bandwidth) buckets.set(key, v);
  }

  // Group by codec, each sorted by resolution desc
  const byCodec = new Map();
  for (const v of buckets.values()) {
    if (!byCodec.has(v.codecid)) byCodec.set(v.codecid, []);
    byCodec.get(v.codecid).push(v);
  }
  for (const arr of byCodec.values()) {
    arr.sort((a, b) => (b.id - a.id) || (b.bandwidth - a.bandwidth));
  }

  // Preferred order, plus any unknown codecs appended at the end
  const codecs = [
    ...CODEC_LAYOUT_ORDER.filter(c => byCodec.has(c)),
    ...[...byCodec.keys()].filter(c => !CODEC_LAYOUT_ORDER.includes(c)),
  ];
  if (!codecs.length) return;

  const baseName = sanitize(title);
  const primary = codecs[0];
  const c0 = CODEC_LABELS[primary] || { short: `c${primary}`, note: '' };

  // Primary group: header + flat rows, always visible
  container.appendChild(el('div', {
    className: 'codec-header',
    textContent: c0.note ? `${c0.short} · ${c0.note}` : c0.short,
  }));
  for (const v of byCodec.get(primary)) {
    container.appendChild(makeRow(v, c0, bestAudio, baseName));
  }

  // Remaining codecs: collapsible dropdowns
  for (const codec of codecs.slice(1)) {
    const c = CODEC_LABELS[codec] || { short: `c${codec}`, note: '' };
    const details = el('details', { className: 'codec-group' });
    const summary = el('summary');
    summary.appendChild(el('span', { className: 'summary-title', textContent: c.short }));
    if (c.note) summary.appendChild(el('span', { className: 'summary-note', textContent: c.note }));
    details.appendChild(summary);
    for (const v of byCodec.get(codec)) {
      details.appendChild(makeRow(v, c, bestAudio, baseName));
    }
    container.appendChild(details);
  }
}

const ACCEL_CONCURRENCY = 3; // parallel connections when 加速 is on; 1 = serial (gentle)

async function onDownload(video, audio, filename, label) {
  if (!audio) {
    setStatus('无音轨，无法合成 mp4。', true);
    return;
  }
  if (!video.urls?.length || !audio.urls?.length) {
    setStatus('拿不到可用的下载地址。', true);
    return;
  }
  const accel = document.getElementById('accel-toggle')?.checked;
  disableButtons(true);
  const resp = await chrome.runtime.sendMessage({
    type: 'merge',
    payload: {
      videoUrls: video.urls, audioUrls: audio.urls, filename, label,
      concurrency: accel ? ACCEL_CONCURRENCY : 1,
    },
  });
  if (!resp?.ok) {
    disableButtons(false);
    setStatus(resp?.error || '启动失败', true);
  }
}

function disableButtons(disabled) {
  for (const b of document.querySelectorAll('.dl-btn')) b.disabled = disabled;
  const t = document.getElementById('accel-toggle');
  if (t) t.disabled = disabled;
}

function setStatus(text, isError = false) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.className = isError ? 'error' : '';
}

function applyState(state) {
  const p = document.getElementById('progress');
  const pl = document.getElementById('progress-label');
  const pm = document.getElementById('progress-message');
  const pf = document.getElementById('progress-fill');
  const ended = ['idle', 'done', 'error', 'cancelled'];
  const busy = state && state.phase && !ended.includes(state.phase);
  if (state?.phase === 'error') {
    setStatus('出错: ' + (state.message || ''), true);
    disableButtons(false);
    p.hidden = true;
    return;
  }
  if (state?.phase === 'done' || state?.phase === 'cancelled') {
    setStatus(state.message || '完成', false);
    disableButtons(false);
    p.hidden = true;
    return;
  }
  if (busy) {
    setStatus('处理中，可以关掉这个弹窗，不影响…');
    disableButtons(true);
    p.hidden = false;
    pl.textContent = state.label ? `正在下载：${state.label}` : '';
    pm.textContent = state.message || '';
    pf.style.width = (state.progress || 0) + '%';
    // Blob is already handed to the downloads API at this point.
    document.getElementById('cancel-btn').disabled = state.phase === 'saving';
  } else {
    p.hidden = true;
    disableButtons(false);
  }
}

document.getElementById('cancel-btn').onclick = async () => {
  const btn = document.getElementById('cancel-btn');
  btn.disabled = true;
  btn.textContent = '取消中…';
  await chrome.runtime.sendMessage({ type: 'cancel' }).catch(() => {});
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '取消下载';
  }, 1500);
};

function initAccelToggle() {
  const toggle = document.getElementById('accel-toggle');
  const hint = document.getElementById('accel-hint');
  const paint = (on) => { hint.textContent = on ? '多线程并行，更快' : '单线程，最稳（弱网/大文件推荐）'; };
  chrome.storage.local.get({ accelerate: true }).then(({ accelerate }) => {
    toggle.checked = !!accelerate;
    paint(toggle.checked);
  });
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ accelerate: toggle.checked });
    paint(toggle.checked);
  });
}
initAccelToggle();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'stateUpdate') applyState(msg.state);
});

async function main() {
  let pageInfo;
  try {
    pageInfo = await readPageInfo();
  } catch (e) {
    setStatus('读取页面失败: ' + e.message, true);
    return;
  }
  if (pageInfo.error) {
    setStatus(pageInfo.error, true);
    return;
  }

  document.getElementById('title').textContent = pageInfo.title || '(未取到标题)';

  // /list/ players (watchlater, favlist) often lack cid in page state — recover
  // it from the pagelist API so playurl + subtitles work.
  if (!pageInfo.cid && (pageInfo.bvid || pageInfo.aid)) {
    try {
      pageInfo.cid = await fetchCid(pageInfo);
    } catch (e) {
      console.warn('cid fallback failed', e);
    }
  }

  // Multi-part (多P): __playinfo__ and videoData.cid are the server-rendered
  // snapshot of whichever part first loaded — an in-page part switch only
  // changes ?p= and the title, never these. Resolve the selected part's own
  // cid and, for any multi-part video, drop the stale __playinfo__ so the
  // stream is re-fetched for that part instead of silently repeating part 1.
  if (pageInfo.bvid || pageInfo.aid) {
    let pages = pageInfo.pages;
    if (!pages || !pages.length) {
      try { pages = await fetchPageList(pageInfo); }
      catch (e) { console.warn('pagelist failed', e); }
    }
    if (pages && pages.length > 1) {
      const sel = pages.find(pg => pg.page === pageInfo.p) || pages[pageInfo.p - 1];
      if (sel?.cid) {
        pageInfo.cid = sel.cid;
        pageInfo.playinfo = null;
      }
    }
  }

  let data = pageInfo.playinfo?.data || pageInfo.playinfo?.result || pageInfo.playinfo || null;
  let streams = data ? extractStreams(data) : null;

  const needFallback = !streams || !streams.videos.length;
  if (needFallback) {
    if (!pageInfo.cid) {
      setStatus('页面没有 __playinfo__，也拿不到 cid，无法回退到 API。刷新页面重试。', true);
      return;
    }
    setStatus('正在获取该分P的视频流…');
    try {
      data = await fetchPlayurl(pageInfo);
      streams = extractStreams(data);
    } catch (e) {
      setStatus('API 回退失败: ' + e.message, true);
      return;
    }
  }

  if (!streams || !streams.videos.length) {
    setStatus('这个视频找不到可用的 DASH 视频流。', true);
    return;
  }

  setStatus('选一个分辨率：');
  renderQualities(streams, pageInfo.title);

  // Subtitles are best-effort: failures here shouldn't block video download.
  fetchSubtitles(pageInfo)
    .then(subs => renderSubtitles(subs, pageInfo.title))
    .catch(e => console.warn('subtitle fetch failed', e));

  const bgState = await chrome.runtime.sendMessage({ type: 'ping' }).catch(() => null);
  if (bgState) applyState(bgState);
}

main().catch(e => {
  console.error(e);
  setStatus('出错: ' + e.message, true);
});
