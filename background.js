const OFFSCREEN_URL = 'offscreen.html';

let state = { phase: 'idle', progress: 0, message: '', filename: '', label: '' };

const IDLE_PHASES = new Set(['idle', 'done', 'error', 'cancelled']);

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'stateUpdate', state }).catch(() => {});
  const badge = IDLE_PHASES.has(state.phase)
    ? ''
    : state.progress ? `${state.progress}%` : '…';
  chrome.action.setBadgeText({ text: badge }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({
    color: state.phase === 'error' ? '#d33' : '#00a1d6',
  }).catch(() => {});
}

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run ffmpeg.wasm to mux DASH video+audio streams',
  });
}

async function closeOffscreenIfIdle() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existing.length > 0) await chrome.offscreen.closeDocument();
  } catch (e) {
    // ignore
  }
}

async function startMerge(payload) {
  await ensureOffscreen();
  state = { phase: 'starting', progress: 0, message: '开始…', filename: payload.filename, label: payload.label || '' };
  broadcastState();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'merge', payload });
  return { ok: true };
}

async function handleResult({ blobUrl, filename }) {
  state = { phase: 'saving', progress: 100, message: '交给下载器…', filename };
  broadcastState();

  const id = await new Promise((res, rej) => {
    chrome.downloads.download({ url: blobUrl, filename, saveAs: false }, (dlId) => {
      if (chrome.runtime.lastError || !dlId) rej(new Error(chrome.runtime.lastError?.message || 'download failed'));
      else res(dlId);
    });
  });

  await new Promise((resolve) => {
    function listener(delta) {
      if (delta.id !== id) return;
      const s = delta.state?.current;
      if (s === 'complete' || s === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        resolve(s);
      }
    }
    chrome.downloads.onChanged.addListener(listener);
  });

  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl }).catch(() => {});

  state = { phase: 'done', progress: 100, message: `已保存: ${filename}`, filename, label: state.label };
  broadcastState();

  // auto reset badge after a while, keep offscreen for reuse of ffmpeg core
  resetToIdleLater('done', 8000);
}

function resetToIdleLater(fromPhase, ms) {
  setTimeout(() => {
    if (state.phase === fromPhase) {
      state = { phase: 'idle', progress: 0, message: '', filename: '', label: '' };
      broadcastState();
    }
  }, ms);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ping') {
    sendResponse(state);
    return;
  }
  if (msg.type === 'merge') {
    startMerge(msg.payload).then(sendResponse).catch(e => {
      state = { phase: 'error', progress: 0, message: e.message, filename: '' };
      broadcastState();
      sendResponse({ ok: false, error: e.message });
    });
    return true;
  }
  if (msg.type === 'cancel') {
    // Too late to cancel once the blob is handed to the downloads API.
    if (IDLE_PHASES.has(state.phase) || state.phase === 'saving') {
      sendResponse({ ok: false });
      return;
    }
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'cancel' }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'cancelled') {
    state = { phase: 'cancelled', progress: 0, message: '已取消', filename: '', label: '' };
    broadcastState();
    resetToIdleLater('cancelled', 4000);
    return;
  }
  if (msg.type === 'progress') {
    state = { ...state, ...msg.payload };
    broadcastState();
    return;
  }
  if (msg.type === 'result') {
    handleResult(msg).catch(e => {
      state = { phase: 'error', progress: 0, message: e.message, filename: '' };
      broadcastState();
    });
    return;
  }
  if (msg.type === 'error') {
    state = { phase: 'error', progress: 0, message: msg.message || '未知错误', filename: '' };
    broadcastState();
    return;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
});
