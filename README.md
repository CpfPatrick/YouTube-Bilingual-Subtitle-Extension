# Bilingual Subtitles for YouTube (EN + 中文)

A Chrome extension that replaces YouTube's native captions with **stacked bilingual subtitles** — the original English line with a natural, idiomatic **Simplified Chinese** translation right below it, translated on the fly by the [DeepSeek API](https://platform.deepseek.com).

English on top, 中文 below, always in sync. No frameworks, no build step — plain JavaScript, 9 files.

[中文说明在下方](#中文说明)

---

## Features

- **Bilingual stacked display** — original English + 简体中文 overlaid on the player, replacing (not fighting) YouTube's native caption box. Native captions are hidden with CSS and restored instantly when the extension is toggled off.
- **Watch-point-first translation** — subtitles are translated in batches starting from where you're watching, then ahead to the end of the video. Lines on screen are ready within ~2–4 seconds; everything after that is translated before you get to it. Seeking re-prioritizes the queue.
- **POT-token immune caption capture** — since 2025 YouTube gates its subtitle endpoint behind Proof-of-Origin tokens for many videos (direct fetches silently return empty bodies). This extension intercepts the player's *own* caption responses from a MAIN-world script instead, with two fallbacks (direct fetch, POT-URL reuse) and a page-HTML metadata fallback.
- **Per-video translation cache** — rewatching a video costs zero API calls and renders instantly. LRU-pruned at 80 videos.
- **Faithful translation style** — the prompt enforces natural, idiomatic Chinese with *nothing added*: no explanations, no pinyin, no mixed languages, no creative rewrites.
- **Self-diagnosing** — the popup shows live status ("Translating 64/180…", "Active ✓", or what went wrong), and every stage logs to the page console under the `[bsub]` prefix.
- Works with both manual and auto-generated (ASR) English tracks, survives YouTube's SPA navigation, fullscreen, theater mode, and ads.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select the project folder.
4. **Reload any YouTube tabs that were already open** (content scripts only attach to pages loaded after the extension).

Requires Chrome 111+.

## Setup

1. Get an API key at [platform.deepseek.com](https://platform.deepseek.com) (the default model is `deepseek-v4-flash` — fast and very cheap).
2. Click the extension icon → **Settings** → paste your key → **Test connection** → Save.
3. Open any YouTube video with English subtitles. Done.

**Cost:** at DeepSeek's pricing ($0.14/M input, $0.28/M output tokens), a 15-minute video translates for well under **$0.001**, and only on first watch — rewatches hit the local cache.

## How it works

```
YouTube player ──requests──► /api/timedtext (json3, with its own POT token)
        │
[interceptor.js — MAIN world, document_start]
  patches fetch/XHR, captures the response body
        │ window.postMessage
[content.js — ISOLATED world]
  parses cues → batches (≤20 lines) → priority queue around the playhead
        │ chrome.runtime.sendMessage
[background.js — service worker]
  POST api.deepseek.com/chat/completions (deepseek-v4-flash, JSON mode)
  write-through cache in chrome.storage.local
        │
[overlay] EN + 中文 rendered inside #movie_player, synced to video time
```

Caption acquisition tries, in order: (1) intercept the player's own request — immune to POT gating; (2) direct fetch of the track URL — works for non-gated videos; (3) reuse a POT-bearing URL the player already issued. Track metadata comes from the player API, with a watch-page-HTML fallback if the MAIN-world bridge is unavailable.

The DeepSeek call sends whole batches (not single lines) so the model sees context — that's what makes the Chinese idiomatic — with `temperature: 1.3` (DeepSeek's recommended setting for translation) and strict JSON output. Failed batches back off, split in half, and retry; transient 429/5xx are absorbed automatically.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Nothing happens on a video | Click the extension icon — the popup status says exactly what's wrong. Most common: the tab was open before the extension loaded → reload the page. |
| "API key missing or rejected" | Settings → paste key → Test connection. |
| Still stuck | Open DevTools on the video page, filter the console for `[bsub]` — every stage (player detection, track choice, acquisition path, batch progress) is logged. Open an issue with those lines. |

## Privacy

- Your API key is stored in `chrome.storage.local` only — it never syncs and never leaves your device except to authenticate with DeepSeek.
- The only data sent anywhere is the English subtitle text, sent to `api.deepseek.com` for translation. No analytics, no tracking, no other network calls.

## Limitations

- Desktop `www.youtube.com` only (no `m.youtube.com`, no embedded players).
- English → Simplified Chinese only (by design — it's the product).
- Live streams are not supported (VODs of ended streams work).
- Videos with no English track show a notice and leave native captions untouched.

## Project layout

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: MAIN + ISOLATED content scripts, service worker |
| `interceptor.js` | MAIN world: fetch/XHR patch, player API bridge |
| `content.js` | Orchestrator: tracks, cues, batching, overlay, navigation |
| `background.js` | DeepSeek client, retries, translation cache |
| `overlay.css` | Hides native captions, styles the bilingual overlay |
| `options.*` / `popup.*` | API key settings / toggle + live status |

No dependencies, no build step. Edit a file, hit reload on `chrome://extensions`, refresh the tab.

## License

MIT

---

# 中文说明

把 YouTube 原生字幕替换为**上下双语字幕**:上面是英文原文,下面是 DeepSeek 实时翻译的自然、地道**简体中文**。

## 安装

1. 下载本仓库,打开 `chrome://extensions`,开启右上角**开发者模式**。
2. 点击**加载已解压的扩展程序**,选择本项目文件夹。
3. **刷新已经打开的 YouTube 标签页**(扩展加载前打开的页面不会注入脚本)。

需要 Chrome 111+。

## 配置

1. 在 [platform.deepseek.com](https://platform.deepseek.com) 获取 API 密钥(默认模型 `deepseek-v4-flash`,快且便宜)。
2. 点扩展图标 → **Settings** → 粘贴密钥 → **Test connection** → 保存。
3. 打开任意带英文字幕的视频即可。

**费用:**一个 15 分钟的视频翻译成本远低于 0.001 美元,且仅首次观看产生——重看走本地缓存,零调用、秒出。

## 工作原理(简述)

- 页面主世界脚本截获播放器自己的字幕请求(自带有效 POT 令牌,绕开 2025 年起 YouTube 对字幕接口的令牌校验),另有直接拉取、POT URL 复用、页面 HTML 解析三重回退。
- 字幕按批(≤20 行)整批送翻,**从播放点优先**:正在看的字幕 2~4 秒内就位,其余在你看到之前翻完;拖进度条会重排队列。
- 提示词强制只输出自然地道的简体中文——不加解释、不带拼音、不混其他语言。
- 译文按视频缓存,重看不再调用 API。

## 排查问题

点扩展图标看弹窗状态(如"Translating 64/180…"或具体错误);更详细的日志在视频页控制台,过滤 `[bsub]` 前缀。最常见的问题:扩展加载前已打开的标签页需要刷新一次。

## 隐私

API 密钥只存本机(`chrome.storage.local`),不同步、不外传;唯一发出的数据是英文字幕文本(发往 `api.deepseek.com` 用于翻译)。无统计、无跟踪。
