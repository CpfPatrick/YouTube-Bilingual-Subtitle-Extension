'use strict';

const enabledInput = document.getElementById('enabled');
const warningEl = document.getElementById('warning');
const statusEl = document.getElementById('status');

chrome.storage.sync.get({ enabled: true }, ({ enabled }) => {
  enabledInput.checked = enabled !== false;
});

chrome.storage.local.get({ apiKey: '' }, ({ apiKey }) => {
  warningEl.classList.toggle('show', !apiKey.trim());
});

enabledInput.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enabledInput.checked });
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || '';
}

async function refreshStatus() {
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) { /* no tab access */ }
  if (!tab || !tab.id) { setStatus(''); return; }

  // tab.url is visible for youtube.com (content_scripts match grants host access)
  const onWatch = tab.url && tab.url.includes('youtube.com/watch');
  const onYouTube = tab.url && tab.url.includes('youtube.com');
  if (!onYouTube) { setStatus('Open a YouTube video to use the extension.'); return; }

  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
  } catch (e) { /* no content script in this tab */ }
  if (!res) {
    setStatus('Not running in this tab — reload the page (tabs opened before the extension loaded need a reload).', 'problem');
    return;
  }
  if (!res.enabled) { setStatus('Disabled.'); return; }
  if (!onWatch) { setStatus('Open a video to start.'); return; }
  if (res.noKey) { setStatus('API key missing or rejected — open Settings.', 'problem'); return; }
  switch (res.state) {
    case 'idle': setStatus('Idle — waiting for a video.'); break;
    case 'waiting-player': setStatus('Waiting for the player…'); break;
    case 'acquiring': setStatus('Loading subtitles…'); break;
    case 'translating': setStatus('Translating ' + res.translated + '/' + res.total + '…', 'active'); break;
    case 'ready': setStatus('Active ✓ (' + res.translated + '/' + res.total + ' lines)', 'active'); break;
    case 'failed': setStatus('Failed — see [bsub] logs in the page console.', 'problem'); break;
    default: setStatus(String(res.state || ''));
  }
}

refreshStatus();
setInterval(refreshStatus, 1000);
