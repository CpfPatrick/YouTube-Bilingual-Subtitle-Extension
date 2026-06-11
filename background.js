// MV3 service worker: owns all DeepSeek API traffic (the endpoint is
// hardcoded — the content script never supplies a URL), the per-video
// translation cache, and key testing.
'use strict';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const CACHE_MAX_VIDEOS = 80;
const CACHE_PRUNE_COUNT = 20;
const MAX_OUTPUT_TOKENS = 4000;

const SYSTEM_PROMPT = [
  'You are a professional subtitle translator. Translate English subtitle lines',
  'into Simplified Chinese (简体中文).',
  '',
  'Rules:',
  '- Translate into natural, idiomatic Chinese, as a fluent native speaker would',
  '  phrase it for subtitles.',
  '- Output ONLY the translation. Never add explanations, annotations, pinyin,',
  '  or commentary. Never include English words except proper nouns that have no',
  '  standard Chinese name. Never use any language other than Simplified Chinese.',
  '- Translate each line independently but use the other lines as context.',
  '  Do not merge, split, or reorder lines.',
  '- Respond in json: an object with a single key "translations" whose value is',
  '  an array of strings with exactly the same length and order as the input',
  '  array. Example: {"translations": ["第一行的翻译", "第二行的翻译"]}'
].join('\n');

const mem = new Map(); // cacheKey -> {ts, n, t}
const loadInFlight = new Map(); // cacheKey -> Promise, dedupes concurrent storage loads

let inFlightCount = 0;
let keepaliveTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function trackInFlight(delta) {
  inFlightCount += delta;
  if (inFlightCount > 0 && !keepaliveTimer) {
    // Extension API calls reset the SW's 30s idle timer.
    keepaliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  } else if (inFlightCount <= 0 && keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

// ---------- storage helpers ----------

function storageGet(area, keys) {
  return new Promise((resolve, reject) => chrome.storage[area].get(keys, (items) => {
    chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(items);
  }));
}

function storageSet(area, items) {
  return new Promise((resolve, reject) => chrome.storage[area].set(items, () => {
    chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve();
  }));
}

function storageRemove(area, keys) {
  return new Promise((resolve, reject) => chrome.storage[area].remove(keys, () => {
    chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve();
  }));
}

async function getApiKey() {
  const { apiKey } = await storageGet('local', { apiKey: '' });
  return (apiKey || '').trim();
}

async function getModel() {
  const { model } = await storageGet('sync', { model: DEFAULT_MODEL });
  return (model || DEFAULT_MODEL).trim();
}

// ---------- translation cache ----------

function cacheKey(videoId, trackKey) {
  return 'cache:' + videoId + ':' + trackKey;
}

async function loadEntry(videoId, trackKey, n) {
  const key = cacheKey(videoId, trackKey);
  let entry = mem.get(key);
  if (!entry) {
    let p = loadInFlight.get(key);
    if (!p) {
      p = storageGet('local', [key]).then((stored) => {
        const e = mem.get(key) || stored[key] || null;
        if (e) mem.set(key, e);
        return e;
      }).finally(() => loadInFlight.delete(key));
      loadInFlight.set(key, p);
    }
    entry = await p;
  }
  if (entry && entry.n !== n) entry = null; // track changed shape — treat as miss
  return entry;
}

// All concurrent handlers for a key must mutate ONE shared entry object,
// registered in mem synchronously, so slice writes merge instead of clobbering.
async function getOrCreateEntry(videoId, trackKey, n) {
  const key = cacheKey(videoId, trackKey);
  let entry = await loadEntry(videoId, trackKey, n);
  if (!entry) {
    entry = mem.get(key);
    if (!entry || entry.n !== n) {
      entry = { ts: Date.now(), n, t: new Array(n).fill(null) };
      mem.set(key, entry);
    }
  }
  return entry;
}

async function saveEntry(videoId, trackKey, entry) {
  const key = cacheKey(videoId, trackKey);
  const latest = mem.get(key);
  if (latest && latest !== entry && latest.n === entry.n) {
    for (let i = 0; i < entry.n; i++) {
      if (entry.t[i] == null) entry.t[i] = latest.t[i];
    }
  }
  entry.ts = Date.now();
  mem.set(key, entry);
  try {
    await storageSet('local', { [key]: entry });
  } catch (e) {
    // Likely quota — evict aggressively and retry once; keep in mem regardless.
    await pruneCache(key, true).catch(() => {});
    try {
      await storageSet('local', { [key]: entry });
    } catch (e2) {
      return;
    }
  }
  await pruneCache(key);
}

// cacheIndex read-modify-write cycles are serialized through a module-level
// promise chain (a single SW instance handles all messages, so this suffices).
let indexLock = Promise.resolve();

function pruneCache(touchedKey, force) {
  const run = indexLock.then(() => pruneCacheLocked(touchedKey, force));
  indexLock = run.catch(() => {});
  return run;
}

async function pruneCacheLocked(touchedKey, force) {
  const { cacheIndex } = await storageGet('local', { cacheIndex: {} });
  cacheIndex[touchedKey] = Date.now();
  const keys = Object.keys(cacheIndex);
  if (force || keys.length > CACHE_MAX_VIDEOS) {
    keys.sort((a, b) => cacheIndex[a] - cacheIndex[b]);
    const doomed = keys.filter((k) => k !== touchedKey).slice(0, CACHE_PRUNE_COUNT);
    // Sweep entries that lost their index update (orphans) while we're here.
    const all = await storageGet('local', null);
    for (const k of Object.keys(all)) {
      if (k.startsWith('cache:') && !(k in cacheIndex)) doomed.push(k);
    }
    for (const k of doomed) {
      delete cacheIndex[k];
      mem.delete(k);
    }
    if (doomed.length) await storageRemove('local', doomed);
  }
  await storageSet('local', { cacheIndex });
}

async function clearCache() {
  const all = await storageGet('local', null);
  const doomed = Object.keys(all).filter((k) => k.startsWith('cache:'));
  doomed.push('cacheIndex');
  await storageRemove('local', doomed);
  mem.clear();
}

// ---------- DeepSeek client ----------

// Returns {t: string[]|null, truncated: boolean}. Throws AUTH:..., HTTP ..., NETWORK.
async function callDeepSeek(key, model, lines) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify({
          model,
          temperature: 1.3,
          max_tokens: MAX_OUTPUT_TOKENS,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: 'Translate these ' + lines.length + ' subtitle lines:\n' + JSON.stringify(lines) }
          ]
        })
      });
    } catch (e) {
      await sleep(500 * Math.pow(2, attempt) + Math.random() * 250);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error('AUTH:' + res.status);
    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status;
      await sleep(500 * Math.pow(2, attempt) + Math.random() * 250);
      continue;
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let data;
    try { data = await res.json(); } catch (e) { return { t: null, truncated: false }; }
    const choice = data && data.choices && data.choices[0];
    const truncated = !!(choice && choice.finish_reason === 'length');
    const content = choice && choice.message && choice.message.content;
    if (!content) return { t: null, truncated }; // documented JSON-mode quirk: occasional empty content
    let parsed;
    try { parsed = JSON.parse(content); } catch (e) { return { t: null, truncated }; }
    const t = parsed && parsed.translations;
    if (Array.isArray(t) && t.length === lines.length) return { t: t.map((s) => String(s)), truncated: false };
    return { t: null, truncated }; // length mismatch — caller splits and retries
  }
  throw new Error(lastStatus ? 'HTTP ' + lastStatus : 'NETWORK');
}

// Returns an array aligned to lines; failed leaves become nulls so one bad
// half never discards the sibling half's paid-for translations. AUTH aborts.
async function translateLines(key, model, lines, depth) {
  depth = depth || 0;
  let r = await callDeepSeek(key, model, lines);
  // An identical retry after truncation would truncate identically — skip it.
  if (!r.t && !r.truncated) r = await callDeepSeek(key, model, lines);
  if (r.t) return r.t;
  if (lines.length > 1 && depth < 3) {
    const mid = Math.ceil(lines.length / 2);
    const half = async (ls) => {
      try {
        return await translateLines(key, model, ls, depth + 1);
      } catch (e) {
        if (String(e && e.message || e).startsWith('AUTH')) throw e;
        return new Array(ls.length).fill(null);
      }
    };
    const a = await half(lines.slice(0, mid));
    const b = await half(lines.slice(mid));
    return a.concat(b);
  }
  if (depth === 0) throw new Error('BAD_OUTPUT');
  return new Array(lines.length).fill(null);
}

// ---------- message handlers ----------

async function handleGetCache(msg) {
  const entry = await loadEntry(msg.videoId, msg.trackKey, msg.n);
  if (entry) await pruneCache(cacheKey(msg.videoId, msg.trackKey)); // refresh LRU ts
  return { ok: true, t: entry ? entry.t : null };
}

async function handleTranslateBatch(msg) {
  const { videoId, trackKey, n, startIndex, lines } = msg;
  if (!videoId || !Array.isArray(lines) || !lines.length ||
      !Number.isInteger(startIndex) || startIndex < 0 || !Number.isInteger(n) ||
      startIndex + lines.length > n) {
    return { ok: false, error: 'BAD_REQUEST' };
  }
  const key = await getApiKey();
  if (!key) return { ok: false, error: 'NO_KEY' };
  const model = await getModel();

  const entry = await getOrCreateEntry(videoId, trackKey, n);
  const cachedSlice = entry.t.slice(startIndex, startIndex + lines.length);
  if (cachedSlice.every((x) => x != null)) {
    return { ok: true, startIndex, translations: cachedSlice };
  }

  trackInFlight(1);
  let translations;
  try {
    translations = await translateLines(key, model, lines);
  } catch (e) {
    const m = String(e && e.message || e);
    return { ok: false, error: m.startsWith('AUTH') ? 'AUTH' : m };
  } finally {
    trackInFlight(-1);
  }

  if (translations.every((x) => x == null)) return { ok: false, error: 'BAD_OUTPUT' };
  for (let i = 0; i < translations.length; i++) {
    if (translations[i] != null) entry.t[startIndex + i] = translations[i];
  }
  await saveEntry(videoId, trackKey, entry);
  // respond from the merged entry so previously-cached lines fill any failed leaves
  return { ok: true, startIndex, translations: entry.t.slice(startIndex, startIndex + lines.length) };
}

async function handleTestKey(msg) {
  const key = (msg.apiKey || '').trim() || await getApiKey();
  if (!key) return { ok: false, error: 'NO_KEY' };
  const model = (msg.model || '').trim() || await getModel();
  trackInFlight(1);
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: 'Reply with this exact json: {"ok": true}' }]
      })
    });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'NETWORK' };
  } finally {
    trackInFlight(-1);
  }
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'GET_CACHE': return handleGetCache(msg);
    case 'TRANSLATE_BATCH': return handleTranslateBatch(msg);
    case 'TEST_KEY': return handleTestKey(msg);
    case 'CLEAR_CACHE': await clearCache(); return { ok: true };
    default: return { ok: false, error: 'UNKNOWN_TYPE' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => {
    sendResponse({ ok: false, error: String(err && err.message || err) });
  });
  return true; // keep the channel open for the async sendResponse
});
