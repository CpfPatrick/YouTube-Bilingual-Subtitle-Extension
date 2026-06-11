// ISOLATED-world content script. Orchestrates: track selection, caption
// acquisition (via the MAIN-world interceptor), translation batching through
// the service worker, and the bilingual overlay.
(() => {
  'use strict';

  const MAX_IN_FLIGHT = 3;
  const BATCH_MAX_LINES = 20;
  const BATCH_MAX_CHARS = 1200;
  const PLAYER_POLL_BUDGET_MS = 30000;

  const log = (...a) => console.info('[bsub]', ...a);
  const warn = (...a) => console.warn('[bsub]', ...a);

  let settings = { enabled: true };
  let epoch = 0;
  let S = null; // current video session

  // ---------- utilities ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function watchVideoId() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  function playerEl() {
    return document.getElementById('movie_player');
  }

  function videoEl() {
    return document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video');
  }

  function adShowing() {
    const p = playerEl();
    return !!(p && p.classList.contains('ad-showing'));
  }

  async function sendMessageSafe(msg) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await chrome.runtime.sendMessage(msg);
        if (r !== undefined) return r;
      } catch (e) { /* SW restarting / port closed — retry once */ }
      await sleep(150);
    }
    return null;
  }

  // ---------- bridge to MAIN-world interceptor ----------

  const pendingReqs = new Map();
  let reqSeq = 0;

  function bridgeRequest(type, payload, timeoutMs) {
    return new Promise((resolve) => {
      const id = ++reqSeq;
      pendingReqs.set(id, resolve);
      window.postMessage({ source: 'bsub-isolated', id, type, payload }, window.location.origin);
      setTimeout(() => {
        if (pendingReqs.delete(id)) resolve(null);
      }, timeoutMs || 1000);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'bsub-main') return;
    if (e.data.type === 'TIMEDTEXT') {
      onTimedtext(e.data.url, e.data.body, 'interception');
      return;
    }
    if (e.data.type === 'RESULT') {
      const resolve = pendingReqs.get(e.data.id);
      if (resolve) {
        pendingReqs.delete(e.data.id);
        resolve(e.data.payload);
      }
    }
  });

  // ---------- timedtext handling ----------

  function ttParams(url) {
    try { return new URL(url, 'https://www.youtube.com').searchParams; }
    catch (e) { return null; }
  }

  function matchesSession(url, sess) {
    const p = ttParams(url);
    if (!p) return false;
    if (p.get('tlang')) return false;
    if (p.get('fmt') !== 'json3') return false;
    if (p.get('v') && sess.videoId && p.get('v') !== sess.videoId) return false;
    if ((p.get('kind') === 'asr') !== (sess.track.kind === 'asr')) return false;
    return p.get('lang') === sess.track.languageCode;
  }

  function onTimedtext(url, body, via) {
    const sess = S;
    if (!sess || sess.cues || !sess.track) return;
    if (!matchesSession(url, sess)) return;
    const cues = parseJson3(body);
    if (cues && cues.length) ingestCues(sess, cues, via);
  }

  function parseJson3(body) {
    let data;
    try { data = JSON.parse(body); } catch (e) { return null; }
    if (!data || !Array.isArray(data.events)) return null;
    const raw = [];
    for (const ev of data.events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      const text = ev.segs.map((s) => (s && s.utf8) || '').join('')
        .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      const startMs = ev.tStartMs || 0;
      const endMs = startMs + (ev.dDurationMs || 3000);
      if (ev.aAppend && raw.length) {
        const prev = raw[raw.length - 1];
        if (text) prev.text = (prev.text + ' ' + text).trim();
        prev.endMs = Math.max(prev.endMs, endMs);
        continue;
      }
      if (!text) continue;
      raw.push({ startMs, endMs, text });
    }
    const cues = [];
    for (const c of raw) {
      const prev = cues[cues.length - 1];
      // ASR rolling windows repeat lines back-to-back; only merge when the
      // repeats are contiguous, not the same words said minutes apart.
      if (prev && prev.text === c.text && c.startMs <= prev.endMs + 500) {
        prev.endMs = Math.max(prev.endMs, c.endMs);
        continue;
      }
      cues.push(c);
    }
    cues.forEach((c, i) => { c.index = i; });
    return cues;
  }

  // ---------- watch-page HTML fallback (no MAIN world needed) ----------

  function extractJsonValue(html, anchor, openCh, closeCh) {
    const i = html.indexOf(anchor);
    if (i < 0) return null;
    const start = html.indexOf(openCh, i + anchor.length - 1);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = start; j < html.length; j++) {
      const ch = html[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) {
        depth--;
        if (!depth) {
          try { return JSON.parse(html.slice(start, j + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  async function fetchWatchPageInfo(videoId) {
    try {
      const res = await fetch('https://www.youtube.com/watch?v=' + videoId, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const html = await res.text();
      const rawTracks = extractJsonValue(html, '"captionTracks":', '[', ']');
      if (!Array.isArray(rawTracks) || !rawTracks.length) return null;
      const details = extractJsonValue(html, '"videoDetails":', '{', '}') || {};
      return {
        videoId: details.videoId || videoId,
        isLive: !!details.isLive,
        source: 'watch-html',
        tracks: rawTracks.map((t) => ({
          baseUrl: t.baseUrl || '',
          languageCode: t.languageCode || '',
          kind: t.kind || '',
          vssId: t.vssId || '',
          name: (t.name && (t.name.simpleText ||
            (t.name.runs && t.name.runs.map((r) => r.text).join('')))) || ''
        }))
      };
    } catch (e) {
      return null;
    }
  }

  // ---------- session lifecycle ----------

  function newSession(videoId) {
    epoch++;
    S = {
      epoch,
      videoId,
      state: 'waiting-player', // -> acquiring -> translating -> ready | failed
      bridgeOk: false,
      track: null,
      trackKey: '',
      cues: null,
      maxCueDurMs: 3000,
      translations: [],
      batches: [],
      inFlight: 0,
      noKey: false,
      timer: null,
      videoListenerEl: null,
      lastEn: null,
      lastZh: null
    };
    return S;
  }

  function teardown() {
    epoch++;
    if (S) {
      if (S.timer) clearInterval(S.timer);
      if (S.videoListenerEl) S.videoListenerEl.removeEventListener('timeupdate', onTimeUpdate);
      S = null;
    }
    delete document.documentElement.dataset.bsub;
    removeOverlay();
  }

  function alive(sess) {
    return sess && sess.epoch === epoch && settings.enabled;
  }

  function fail(sess, reason, noticeText) {
    sess.state = 'failed';
    delete document.documentElement.dataset.bsub;
    warn(reason, '(video:', sess.videoId + ')');
    mountOverlay();
    if (noticeText) notice(noticeText);
  }

  async function start(trigger) {
    const videoId = watchVideoId();
    if (!settings.enabled || !videoId) { teardown(); return; }
    if (S && S.videoId === videoId && S.state !== 'failed') return;
    teardown();
    const sess = newSession(videoId);
    log('session start', videoId, '(trigger: ' + (trigger || 'init') + ')');

    const pong = await bridgeRequest('PING', {}, 700);
    if (!alive(sess)) return;
    sess.bridgeOk = pong === 'PONG';
    if (!sess.bridgeOk) warn('MAIN-world bridge unresponsive — using watch-page HTML for metadata');

    // Player info poll. Ads are waited out inside the loop: during ads the
    // player response can describe the wrong content.
    let info = null;
    let lastHtmlTry = 0;
    const deadline = Date.now() + PLAYER_POLL_BUDGET_MS;
    while (alive(sess) && Date.now() < deadline) {
      if (adShowing()) { await sleep(500); continue; }
      if (sess.bridgeOk) {
        info = await bridgeRequest('GET_PLAYER_RESPONSE', {}, 800);
        if (info && info.videoId === videoId) break;
        info = null;
      }
      if (!info && Date.now() - lastHtmlTry > 5000) {
        lastHtmlTry = Date.now();
        info = await fetchWatchPageInfo(videoId);
        if (info) break;
      }
      await sleep(400);
    }
    if (!alive(sess)) return;
    if (!info) {
      fail(sess, 'could not read player data',
        "Bilingual subtitles: couldn't read player data — will retry when playback starts");
      return;
    }
    log('player info via', info.source || 'bridge', '—', (info.tracks || []).length, 'caption tracks');

    if (info.isLive) {
      sess.state = 'failed';
      mountOverlay();
      notice('Live videos are not supported');
      log('live video — idle');
      return;
    }

    const track = pickEnglishTrack(info.tracks);
    if (!track) {
      sess.state = 'failed';
      mountOverlay();
      notice('No English subtitles available');
      log('no English track — idle. Available:', (info.tracks || []).map((t) => t.languageCode).join(',') || 'none');
      return;
    }
    sess.track = track;
    sess.trackKey = track.vssId || ('l.' + track.languageCode);
    sess.state = 'acquiring';
    log('track:', sess.trackKey, track.kind === 'asr' ? '(auto-generated)' : '(manual)');

    await waitForAdToClear(sess);
    if (!alive(sess)) return;

    mountOverlay();
    document.documentElement.dataset.bsub = 'on';

    const ok = await acquireCues(sess);
    if (!alive(sess)) return;
    if (!ok) {
      fail(sess, 'caption acquisition failed on all paths', 'Subtitles unavailable for this video');
    }
  }

  function pickEnglishTrack(tracks) {
    if (!Array.isArray(tracks)) return null;
    const en = tracks.filter((t) => (t.languageCode || '').toLowerCase().startsWith('en'));
    return en.find((t) => t.kind !== 'asr') || en.find((t) => t.kind === 'asr') || null;
  }

  async function waitForAdToClear(sess) {
    while (alive(sess)) {
      if (!adShowing()) return;
      await sleep(500);
    }
  }

  // ---------- caption acquisition (3-step fallback chain) ----------

  function ccButton() {
    return document.querySelector('.ytp-subtitles-button');
  }

  function ensureCcOn() {
    const btn = ccButton();
    if (btn && btn.getAttribute('aria-pressed') === 'false') btn.click();
  }

  function toggleCc() {
    const btn = ccButton();
    if (btn) btn.click();
  }

  async function waitForCues(sess, ms) {
    const deadline = Date.now() + ms;
    while (alive(sess) && Date.now() < deadline) {
      if (sess.cues) return true;
      await sleep(150);
    }
    return !!(sess && sess.cues);
  }

  async function acquireCues(sess) {
    // Step 0: the player may have fetched captions before we started.
    const buffered = await bridgeRequest('GET_TT_BUFFER', {}, 800) || [];
    for (const item of buffered) {
      if (!alive(sess) || sess.cues) break;
      onTimedtext(item.url, item.body, 'buffered interception');
    }
    if (sess.cues) return true;

    // Step 1: make the player itself request our English track (POT-immune).
    if (sess.bridgeOk) {
      ensureCcOn();
      await bridgeRequest('SET_TRACK', { languageCode: sess.track.languageCode }, 800);
      if (await waitForCues(sess, 3000)) return true;
      if (!alive(sess)) return false;
      log('interception path produced no cues in 3s — trying direct fetch');
    }

    // Step 2: direct fetch of the track URL (works for non-POT-gated videos).
    try {
      const url = new URL(sess.track.baseUrl, 'https://www.youtube.com');
      url.searchParams.delete('xosf');
      url.searchParams.set('fmt', 'json3');
      const res = await fetch(url.toString());
      if (res.ok) {
        const body = await res.text();
        if (body) {
          const cues = parseJson3(body);
          if (cues && cues.length && alive(sess) && !sess.cues) {
            ingestCues(sess, cues, 'direct fetch');
            return true;
          }
        } else {
          log('direct fetch returned empty body (POT-gated video) — trying POT-URL reuse');
        }
      } else {
        log('direct fetch failed: HTTP', res.status);
      }
    } catch (e) {
      log('direct fetch error:', String(e));
    }
    if (!alive(sess)) return false;
    if (sess.cues) return true;

    // Step 3: reuse a POT-bearing URL the player already issued.
    let potUrls = await bridgeRequest('GET_POT_URLS', {}, 800) || [];
    if (!potUrls.length) {
      toggleCc();
      await sleep(600);
      if (!alive(sess)) return false;
      toggleCc();
      await sleep(900);
      if (!alive(sess)) return false;
      if (sess.cues) return true; // the toggle itself may have been intercepted
      potUrls = await bridgeRequest('GET_POT_URLS', {}, 800) || [];
    }
    if (!alive(sess)) return false;
    // Resource entries persist across SPA navigations — prefer a URL issued
    // for THIS video so we never ingest the previous video's captions.
    const sameVideo = potUrls.filter((u) => {
      const p = ttParams(u);
      return p && p.get('v') === sess.videoId;
    });
    const pool = sameVideo.length ? sameVideo : potUrls;
    const last = pool[pool.length - 1];
    if (last) {
      try {
        const url = new URL(last);
        url.searchParams.set('fmt', 'json3');
        url.searchParams.set('lang', sess.track.languageCode);
        url.searchParams.set('v', sess.videoId);
        url.searchParams.delete('tlang');
        url.searchParams.delete('xosf');
        const res = await fetch(url.toString());
        if (res.ok) {
          const body = await res.text();
          const cues = body ? parseJson3(body) : null;
          if (cues && cues.length && alive(sess) && !sess.cues) {
            ingestCues(sess, cues, 'POT-URL reuse');
            return true;
          }
        }
      } catch (e) {
        log('POT-URL reuse error:', String(e));
      }
    } else {
      log('no POT-bearing timedtext URLs observed');
    }
    return !!sess.cues;
  }

  // ---------- translation pipeline ----------

  async function ingestCues(sess, cues, via) {
    if (!alive(sess) || sess.cues) return;
    sess.cues = cues;
    sess.maxCueDurMs = cues.reduce((m, c) => Math.max(m, c.endMs - c.startMs), 3000);
    sess.translations = new Array(cues.length).fill(null);
    sess.batches = buildBatches(cues);
    sess.state = 'translating';
    log('cues acquired via', via + ':', cues.length, 'lines,', sess.batches.length, 'batches');
    startRenderLoop(sess);

    const cached = await sendMessageSafe({
      type: 'GET_CACHE', videoId: sess.videoId, trackKey: sess.trackKey, n: cues.length
    });
    if (!alive(sess)) return;
    if (cached && cached.ok && Array.isArray(cached.t)) {
      let hits = 0;
      for (let i = 0; i < cues.length; i++) {
        if (cached.t[i] != null) { sess.translations[i] = cached.t[i]; hits++; }
      }
      if (hits) log('cache:', hits + '/' + cues.length, 'lines already translated');
    }
    for (const b of sess.batches) {
      const done = sess.cues
        .slice(b.startIndex, b.startIndex + b.lines.length)
        .every((c) => sess.translations[c.index] != null);
      if (done) b.status = 'done';
    }
    pump(sess);
  }

  function buildBatches(cues) {
    const batches = [];
    let cur = null;
    let chars = 0;
    for (const c of cues) {
      if (!cur || cur.lines.length >= BATCH_MAX_LINES || chars + c.text.length > BATCH_MAX_CHARS) {
        cur = { startIndex: c.index, lines: [], status: 'pending', retried: false };
        batches.push(cur);
        chars = 0;
      }
      cur.lines.push(c.text);
      chars += c.text.length;
    }
    return batches;
  }

  function currentTimeMs() {
    const v = videoEl();
    return v ? v.currentTime * 1000 : 0;
  }

  function nextBatch(sess) {
    let pool = sess.batches.filter((b) => b.status === 'pending');
    if (!pool.length) pool = sess.batches.filter((b) => b.status === 'retry');
    if (!pool.length) return null;
    const t = currentTimeMs();
    let best = null;
    let bestScore = Infinity;
    for (const b of pool) {
      const first = sess.cues[b.startIndex];
      const lastCue = sess.cues[b.startIndex + b.lines.length - 1];
      let score;
      if (t >= first.startMs && t <= lastCue.endMs) score = -1;
      else if (first.startMs > t) score = first.startMs - t;
      else score = 1e12 + (t - lastCue.endMs); // batches behind the playhead go last
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  function pump(sess) {
    if (!alive(sess) || sess.noKey) return;
    while (sess.inFlight < MAX_IN_FLIGHT) {
      const b = nextBatch(sess);
      if (!b) break;
      sendBatch(sess, b);
    }
    updatePipelineState(sess);
  }

  function updatePipelineState(sess) {
    if (!sess.cues || sess.state !== 'translating') return;
    let unfinished = 0, failed = 0;
    for (const b of sess.batches) {
      if (b.status === 'done') continue;
      if (b.status === 'failed') { failed++; continue; }
      unfinished++;
    }
    if (!unfinished && sess.inFlight === 0) {
      sess.state = 'ready';
      log('translation finished:', failed ? failed + ' batches failed' : 'all batches done');
    }
  }

  async function sendBatch(sess, b) {
    b.status = 'inflight';
    sess.inFlight++;
    const res = await sendMessageSafe({
      type: 'TRANSLATE_BATCH',
      videoId: sess.videoId,
      trackKey: sess.trackKey,
      n: sess.cues.length,
      startIndex: b.startIndex,
      lines: b.lines
    });
    sess.inFlight--;
    if (!alive(sess)) return;
    if (res && res.ok && Array.isArray(res.translations)) {
      let missing = false;
      for (let i = 0; i < res.translations.length && i < b.lines.length; i++) {
        if (res.translations[i] != null) sess.translations[b.startIndex + i] = res.translations[i];
        else missing = true;
      }
      if (!missing) {
        b.status = 'done';
      } else {
        // partial result — failed leaves came back as nulls; retry those once
        b.status = b.retried ? 'failed' : 'retry';
        b.retried = true;
      }
    } else if (res && res.error === 'NO_KEY') {
      b.status = 'pending';
      sess.noKey = true;
      warn('no API key set');
      notice('Set your DeepSeek API key in the extension settings');
    } else if (res && res.error === 'AUTH') {
      b.status = 'pending';
      sess.noKey = true;
      warn('API key rejected by DeepSeek');
      notice('DeepSeek rejected the API key — check it in the extension settings');
    } else {
      warn('batch failed:', res && res.error || 'no response from service worker');
      b.status = b.retried ? 'failed' : 'retry';
      b.retried = true;
    }
    pump(sess);
  }

  // ---------- overlay & rendering ----------

  let overlay = null;
  let enLine = null;
  let zhLine = null;
  let noticeLine = null;
  let noticeTimer = null;
  let resizeObs = null;

  function mountOverlay() {
    const player = playerEl();
    if (!player) return;
    if (overlay && overlay.isConnected && overlay.parentElement === player) return;
    removeOverlay();
    overlay = document.createElement('div');
    overlay.id = 'bsub-overlay';
    overlay.setAttribute('aria-live', 'off');
    enLine = document.createElement('div');
    enLine.className = 'bsub-line bsub-en';
    zhLine = document.createElement('div');
    zhLine.className = 'bsub-line bsub-zh';
    noticeLine = document.createElement('div');
    noticeLine.className = 'bsub-line bsub-notice';
    overlay.append(enLine, zhLine, noticeLine);
    player.appendChild(overlay);
    // fresh empty lines — force the next render to repopulate them
    if (S) { S.lastEn = null; S.lastZh = null; }
    sizeOverlay(player);
    resizeObs = new ResizeObserver(() => sizeOverlay(player));
    resizeObs.observe(player);
  }

  function removeOverlay() {
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (overlay) { overlay.remove(); overlay = null; enLine = zhLine = noticeLine = null; }
    if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null; }
  }

  function sizeOverlay(player) {
    if (!overlay) return;
    const h = player.clientHeight || 480;
    const px = Math.max(13, Math.min(34, h * 0.028));
    overlay.style.fontSize = px.toFixed(1) + 'px';
  }

  function setLine(el, text) {
    if (!el) return;
    if (!text) {
      el.textContent = '';
      el.classList.remove('bsub-visible');
      return;
    }
    if (el.textContent !== text) el.textContent = text;
    el.classList.add('bsub-visible');
  }

  function notice(text) {
    mountOverlay();
    if (!noticeLine) return;
    setLine(noticeLine, text);
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => setLine(noticeLine, ''), 4000);
  }

  function activeCues(cues, t, maxDurMs) {
    let lo = 0, hi = cues.length - 1, last = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].startMs <= t) { last = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    const out = [];
    // scan back as far as the longest cue could still be active
    for (let i = last; i >= 0; i--) {
      if (t - cues[i].startMs > (maxDurMs || 3000)) break;
      if (cues[i].startMs <= t && t < cues[i].endMs) out.push(cues[i]);
    }
    out.reverse();
    return out;
  }

  function onTimeUpdate() {
    if (S) render(S);
  }

  function startRenderLoop(sess) {
    if (sess.timer) return;
    sess.timer = setInterval(() => {
      if (!alive(sess)) { clearInterval(sess.timer); return; }
      render(sess);
    }, 250);
  }

  function render(sess) {
    if (!alive(sess) || !sess.cues) return;
    const player = playerEl();
    const v = videoEl();
    if (!player || !v) return;
    if (v !== sess.videoListenerEl) {
      if (sess.videoListenerEl) sess.videoListenerEl.removeEventListener('timeupdate', onTimeUpdate);
      v.addEventListener('timeupdate', onTimeUpdate);
      sess.videoListenerEl = v;
    }
    mountOverlay();
    if (player.classList.contains('ad-showing')) {
      if (sess.lastEn !== null || sess.lastZh !== null) {
        setLine(enLine, '');
        setLine(zhLine, '');
        sess.lastEn = null; // force repopulation when the ad ends
        sess.lastZh = null;
      }
      return;
    }
    const t = v.currentTime * 1000;
    const active = activeCues(sess.cues, t, sess.maxCueDurMs);
    const en = active.map((c) => c.text).join('\n');
    let zh = '';
    if (active.length) {
      const parts = active.map((c) => sess.translations[c.index]);
      if (parts.some((p) => p != null)) zh = parts.map((p) => p || '…').join('\n');
      else if (!sess.noKey) zh = '…';
    }
    if (en !== sess.lastEn) { setLine(enLine, en); sess.lastEn = en; }
    if (zh !== sess.lastZh) { setLine(zhLine, zh); sess.lastZh = zh; }
  }

  // ---------- wiring ----------

  document.addEventListener('yt-navigate-finish', () => { start('yt-navigate-finish'); });
  document.addEventListener('yt-page-data-updated', () => { maybeRecover('yt-page-data-updated'); });

  // Media events recover sessions that failed during ads / slow player init.
  document.addEventListener('playing', () => { maybeRecover('playing'); }, true);
  document.addEventListener('loadeddata', () => { maybeRecover('loadeddata'); }, true);

  function maybeRecover(trigger) {
    if (!settings.enabled) return;
    const videoId = watchVideoId();
    if (!videoId) return;
    if (S && S.videoId === videoId && S.state !== 'failed') return;
    start(trigger);
  }

  document.addEventListener('seeking', () => {
    // re-prioritize pending batches around the new position
    if (S) pump(S);
  }, true);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.enabled) {
      settings.enabled = changes.enabled.newValue !== false;
      log('enabled ->', settings.enabled);
      if (settings.enabled) start('toggle');
      else teardown();
    }
    if (area === 'local' && changes.apiKey && changes.apiKey.newValue) {
      if (S) { S.noKey = false; pump(S); }
    }
  });

  // Popup status queries arrive via chrome.tabs.sendMessage.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'GET_STATUS') {
      sendResponse({
        ok: true,
        enabled: settings.enabled,
        state: S ? S.state : 'idle',
        videoId: S ? S.videoId : null,
        noKey: S ? S.noKey : false,
        total: S && S.cues ? S.cues.length : 0,
        translated: S ? S.translations.reduce((n, x) => n + (x != null ? 1 : 0), 0) : 0
      });
    }
  });

  log('content script loaded on', location.pathname);
  chrome.storage.sync.get({ enabled: true }, (prefs) => {
    settings.enabled = prefs.enabled !== false;
    if (settings.enabled) start('init');
  });
})();
