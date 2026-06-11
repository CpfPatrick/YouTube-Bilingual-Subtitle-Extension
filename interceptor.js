// MAIN-world script, document_start. Patches fetch/XHR before YouTube's player
// loads so the player's own /api/timedtext responses (which carry valid POT
// tokens) can be captured. No chrome.* APIs exist in this world — all
// communication with content.js goes through window.postMessage.
(() => {
  'use strict';
  if (window.__bsubMain) return;
  window.__bsubMain = true;

  // Buffer recent timedtext bodies: the player may fetch captions before
  // content.js (document_idle) starts listening.
  const ttBuffer = [];
  const TT_BUFFER_MAX = 5;

  function post(msg) {
    try {
      window.postMessage(Object.assign({ source: 'bsub-main' }, msg), window.location.origin);
    } catch (e) { /* unclonable payload — drop */ }
  }

  function onTimedtext(url, body) {
    if (typeof body !== 'string' || body.length === 0) return;
    try { console.debug('[bsub:main] timedtext captured:', url.slice(0, 160)); } catch (e) {}
    ttBuffer.push({ url, body });
    if (ttBuffer.length > TT_BUFFER_MAX) ttBuffer.shift();
    post({ type: 'TIMEDTEXT', url, body });
  }

  function isTimedtext(url) {
    return typeof url === 'string' && url.indexOf('/api/timedtext') !== -1;
  }

  const origFetch = window.fetch;
  window.fetch = function (input) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = typeof input === 'string' ? input
        : (input && typeof input.url === 'string') ? input.url
        : String(input);
      if (isTimedtext(url)) {
        p.then((res) => {
          try {
            res.clone().text().then((body) => onTimedtext(url, body), () => {});
          } catch (e) { /* body already used */ }
        }, () => {});
      }
    } catch (e) { /* never break the page's fetch */ }
    return p;
  };

  const xhrProto = XMLHttpRequest.prototype;
  const origOpen = xhrProto.open;
  const origSend = xhrProto.send;
  xhrProto.open = function (method, url) {
    try { this.__bsubUrl = typeof url === 'string' ? url : String(url); } catch (e) {}
    return origOpen.apply(this, arguments);
  };
  xhrProto.send = function () {
    try {
      if (isTimedtext(this.__bsubUrl)) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              onTimedtext(this.__bsubUrl, this.responseText);
            }
          } catch (e) {}
        });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function trackName(t) {
    if (!t || !t.name) return '';
    if (t.name.simpleText) return t.name.simpleText;
    if (t.name.runs) return t.name.runs.map((r) => r.text).join('');
    return '';
  }

  // Freshest source first; ytInitialPlayerResponse goes stale after SPA
  // navigation, so it is the last resort (still correct on full page loads).
  function readPlayerResponse() {
    const player = getPlayer();
    try {
      if (player && typeof player.getPlayerResponse === 'function') {
        const pr = player.getPlayerResponse();
        if (pr && pr.videoDetails) return { pr, source: 'player-api' };
      }
    } catch (e) {}
    try {
      const app = document.querySelector('ytd-app');
      const pr = app && app.data && app.data.playerResponse;
      if (pr && pr.videoDetails) return { pr, source: 'ytd-app' };
    } catch (e) {}
    try {
      const pr = window.ytInitialPlayerResponse;
      if (pr && pr.videoDetails) return { pr, source: 'initial-response' };
    } catch (e) {}
    return null;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'bsub-isolated') return;
    const { id, type, payload } = e.data;
    const reply = (p) => post({ id, type: 'RESULT', payload: p });
    try {
      if (type === 'PING') {
        reply('PONG');
      } else if (type === 'GET_PLAYER_RESPONSE') {
        const found = readPlayerResponse();
        if (!found) return reply(null);
        const pr = found.pr;
        const details = pr.videoDetails || {};
        const tracklist = (pr.captions && pr.captions.playerCaptionsTracklistRenderer) || {};
        const tracks = (tracklist.captionTracks || []).map((t) => ({
          baseUrl: t.baseUrl || '',
          languageCode: t.languageCode || '',
          kind: t.kind || '',
          vssId: t.vssId || '',
          name: trackName(t)
        }));
        reply({
          videoId: details.videoId || null,
          isLive: !!details.isLive,
          source: found.source,
          tracks
        });
      } else if (type === 'SET_TRACK') {
        const player = getPlayer();
        if (player && typeof player.setOption === 'function' && payload && payload.languageCode) {
          player.setOption('captions', 'track', { languageCode: payload.languageCode });
          reply(true);
        } else {
          reply(false);
        }
      } else if (type === 'GET_POT_URLS') {
        const urls = performance.getEntriesByType('resource')
          .map((en) => en.name)
          .filter((n) => n.indexOf('timedtext') !== -1 && n.indexOf('&pot=') !== -1);
        reply(urls);
      } else if (type === 'GET_TT_BUFFER') {
        reply(ttBuffer.slice());
      } else {
        reply(null);
      }
    } catch (err) {
      reply(null);
    }
  });

  try { console.debug('[bsub:main] interceptor installed'); } catch (e) {}
})();
