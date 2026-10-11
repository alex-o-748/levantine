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

- **Today tab**: `#today-summary` lists the plan (`.plan-step`, `.done` once a
  part is finished). `#btn-start` → flashcard front (`.fc-ar`) → `#fc-reveal`
  → grade buttons (`.grade-again` re-queues the card within its part;
  per-part counters are the `.step` pills in `.session-top`). Reviews come
  first; with new words still to go, `#btn-next` on the break card starts
  them. The last card leads to the recap, `#btn-back` back to the summary.
  Seed `yalla.progress.v1` in `addInitScript` with past-due entries to get a
  review part. Reload and confirm the summary and `.progress-card` survive
  (`yalla.history.v1` holds the per-day counts).
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
  Audio assertions should target the recordings that ship in `audio/`: after
  clicking a speaker button, assert the request for the word's `.mp3` and the
  `.native` class on the button.
- Word audio is local — `audio/manifest.json` maps a word to its clip, and
  nothing is fetched from Commons at play time. A word with no clip falls back
  to speech synthesis, which is silent in headless, so pick a word the manifest
  covers (منيح does). `.native` only appears once the element actually fires
  `playing`, so launch Chromium with `--autoplay-policy=no-user-gesture-required`.
