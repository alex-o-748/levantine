# يلا — Yalla: Levantine Arabic

A small, dependency-free web app for learning **spoken Levantine Arabic (شامي)** —
the dialect of Jordan, Palestine, Lebanon, and Syria — rather than Modern Standard Arabic.

## Features

- **Daily words** — ~150 curated everyday conversational words and phrases
  (Arabic script, transliteration, English), introduced a few per day as
  flashcards with simple spaced repetition (Leitner boxes). Progress is saved
  in your browser (`localStorage`) — no account, no server.
- **Texts with a listening focus** — short Levantine dialogues and monologues.
  In *listening mode* the transcript is blurred: play a line, try to understand
  it by ear, then tap to reveal the Arabic (and optionally the translation).
- **Open knowledge sources**
  - Every word has an in-app **Wiktionary** definition lookup (the app prefers
    the *South/North Levantine Arabic* sections) plus a link to the full entry.
  - Word audio is fetched from **Wikimedia Commons** — Lingua Libre recordings
    by native Levantine speakers (language codes `ajp`/`apc`, CC BY-SA) — when
    a recording exists. A gold ring around the speaker button means you're
    hearing a real human recording.
  - When no recording exists (and for full sentences), the app falls back to
    your browser's Arabic text-to-speech. Note: browser TTS voices are Modern
    Standard Arabic flavoured, so treat sentence audio as an approximation.

## Pronunciation tuning

MSA-trained TTS voices misread some dialect words — most famously مرحبا, which
gets classical nunation ("marḥaban") instead of the Levantine *marḥaba*. The
app corrects this in three ways:

1. **Respelling map** — `TTS_FIXES` in `data.js` substitutes a fully
   vocalised spelling before speaking (`مرحبا` → `مَرْحَبَا`), which overrides
   the voice's lexicon. If a word sounds wrong to you, add an entry there
   (or a per-word `tts` field on the vocab item).
2. **Urban qāf** — a setting (on by default, matching the transliterations)
   that converts ق to hamza in the spoken text only, so قهوة is spoken
   *ʾahwe* rather than *qahwa*. Turn it off if you prefer qāf/g realisations.
3. **Voice picker** — the app auto-prefers *locally installed* regional Levantine voices
   (`ar-LB`, `ar-SY`, `ar-JO`, `ar-PS`) when the system has them, and the
   Settings tab lets you pick one explicitly. Microsoft Edge ships neural
   voices for all of these and they sound far closer to the dialect than
   the default MSA voice; Chrome/Safari system voices are usually MSA only.
   Some browsers list voices that accept an utterance and then silently play
   nothing (typically network-backed ones), so playback watchdogs each voice
   and moves to the next candidate if speech never starts — ending at the
   browser default. **Settings → Test** speaks a sample through the current
   voice if you want to check one by hand.

## Running it

It's a static site — no build step, no dependencies.

```sh
# any static server works, e.g.:
python3 -m http.server 8000
# then open http://localhost:8000
```

Or just open `index.html` directly in a browser (Wiktionary/Commons lookups
need an internet connection; everything else works offline).

It also deploys as-is to **GitHub Pages**: repository *Settings → Pages →
Deploy from a branch*, pick the branch and `/ (root)`.

## Structure

| File | Purpose |
|---|---|
| `index.html` | Page shell and tabs (Today / Words / Texts / Settings) |
| `data.js` | The vocabulary (`VOCAB`) and listening texts (`TEXTS`) |
| `app.js` | Flashcards, spaced repetition, audio, Wiktionary API client |
| `style.css` | Styling (light/dark, RTL-aware) |
| `tools/fetch-commons-audio.py` | Bulk-index (and optionally download) a Lingua Libre speaker's recordings |

### Bulk audio from Commons

At runtime the app looks up one recording at a time with two Commons search
calls per word — fine for a handful of cards, slow and online-only at scale.
A single Lingua Libre speaker's category holds thousands of recordings whose
filenames already name the word, so one pass over the category gives a
complete word → file map:

```sh
# ~10 API calls, no media downloaded: writes audio-index.json
python3 tools/fetch-commons-audio.py

# same, plus the wav files themselves into audio/
python3 tools/fetch-commons-audio.py --download
```

`--category` picks a different speaker (the default is
*Lingua Libre pronunciation by AdrianAbdulBaha*, a Levantine `ajp`/`apc`
speaker). Index keys are normalised — diacritics, tatweel and punctuation
stripped — so they match `VOCAB` spellings. Downloads are resumable: re-run
the same command to retry anything that failed.

Commons does **not** transcode WAV, so `--download` gets uncompressed PCM
(the script prints the total before starting). To ship the audio with the
site, convert it first:

```sh
mkdir -p audio-opus
for f in audio/*.wav; do
  ffmpeg -nostdin -i "$f" -c:a libopus -b:a 24k -ac 1 \
    "audio-opus/$(basename "${f%.wav}").opus"
done
```


### Adding content

Add a word to `VOCAB` in `data.js`:

```js
{ ar: "شوب", tr: "shōb", en: "hot weather, heat", cat: "Everyday" },
```

`wik` optionally overrides the Wiktionary page title when the dictionary
spelling differs (e.g. hamza-less spellings). Add a text to `TEXTS` with a
list of `{ sp?, ar, en }` lines — `sp` is an optional speaker name.

## License / attribution

Code: MIT. Dictionary definitions and native-speaker audio are fetched at
runtime from [Wiktionary](https://en.wiktionary.org) and
[Wikimedia Commons](https://commons.wikimedia.org) and are licensed
CC BY-SA by their contributors.
