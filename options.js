'use strict';

const DEFAULT_MODEL = 'deepseek-v4-flash';

const apiKeyInput = document.getElementById('apiKey');
const modelInput = document.getElementById('model');
const statusEl = document.getElementById('status');
const cacheStatusEl = document.getElementById('cacheStatus');

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok ? 'ok' : 'err';
}

chrome.storage.local.get({ apiKey: '' }, ({ apiKey }) => {
  apiKeyInput.value = apiKey;
});
chrome.storage.sync.get({ model: DEFAULT_MODEL }, ({ model }) => {
  modelInput.value = model;
});

document.getElementById('toggleKey').addEventListener('click', () => {
  const hidden = apiKeyInput.type === 'password';
  apiKeyInput.type = hidden ? 'text' : 'password';
  document.getElementById('toggleKey').textContent = hidden ? 'Hide' : 'Show';
});

document.getElementById('save').addEventListener('click', () => {
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || DEFAULT_MODEL;
  chrome.storage.local.set({ apiKey }, () => {
    if (chrome.runtime.lastError) return setStatus('Save failed: ' + chrome.runtime.lastError.message, false);
    chrome.storage.sync.set({ model }, () => {
      if (chrome.runtime.lastError) return setStatus('Save failed: ' + chrome.runtime.lastError.message, false);
      setStatus('Saved', true);
    });
  });
});

document.getElementById('test').addEventListener('click', async () => {
  setStatus('Testing…', true);
  const res = await chrome.runtime.sendMessage({
    type: 'TEST_KEY',
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim()
  }).catch(() => null);
  if (res && res.ok) setStatus('OK — key works', true);
  else setStatus('Failed: ' + (res && res.error || 'no response'), false);
});

document.getElementById('clearCache').addEventListener('click', async () => {
  cacheStatusEl.textContent = 'Clearing…';
  const res = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }).catch(() => null);
  cacheStatusEl.textContent = res && res.ok ? 'Cache cleared' : 'Failed to clear cache';
});
