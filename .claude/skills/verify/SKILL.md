---
name: verify
description: Build/launch/drive recipe for verifying the Yalla Levantine Arabic web app end-to-end.
---

# Verifying this app

Static site, no build step. Serve the repo root and drive it with Playwright
(globally installed at `/opt/node22/lib/node_modules/playwright`; Chromium in
`/opt/pw-browsers`).

```sh
python3 -m http.server 8090 &   # from the repo root
```

## Flows worth driving

- **Today tab**: `#btn-start` → flashcard front (`.fc-ar`) → `#fc-reveal` →
  grade buttons (`.grade-again` re-queues the card; counter in
  `.session-top .muted`). Reload the page and confirm `#today-summary`
  still shows started words / due reviews (localStorage persistence).
- **Words tab**: `#word-search`, speaker button `[data-act="audio"]`,
  Wiktionary modal `[data-act="wik"]` → `#modal-body`.
- **Texts tab**: open a `.text-card`; in listening mode all `.line-ar` have
  `.veiled`; clicking a line reveals it; `#chk-trans` toggles `.line-en`;
  `#chk-listening` off un-veils everything.
- **Settings**: `#btn-reset` fires a `confirm()` dialog — attach a Playwright
  dialog handler before clicking.

## Gotchas

- **Headless Chromium can't reach the internet here.** The agent proxy
  rejects Chromium's requests (and this environment's network policy blocks
  `*.wikimedia.org` outright, 403 on CONNECT). Do NOT pass a `proxy` option
  to `chromium.launch` — it breaks even `localhost` page loads. Instead
  `page.route()` the external hosts (`en.wiktionary.org`,
  `commons.wikimedia.org`, `upload.wikimedia.org`) and fulfill with fixture
  JSON in the real API shapes; abort `fonts.g*.com`. The app must degrade
  gracefully when those routes abort — that's a valid state to assert too.
- To assert on TTS output (text fed to the engine, chosen voice), stub the
  engine in `page.addInitScript`: replace `SpeechSynthesisUtterance` with a
  plain class and install a recording fake via
  `Object.defineProperty(window, 'speechSynthesis', { value: ... })` —
  plain assignment silently fails (readonly accessor) and the native engine
  then rejects the fake utterance class.
- Headless has no speech-synthesis voices; `speak()` is a silent no-op.
  Audio assertions should target the Commons path: after clicking a speaker
  button, check `localStorage['yalla.audiocache.v1']` and the `.native`
  class on the button.
