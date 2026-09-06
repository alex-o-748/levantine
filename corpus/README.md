# corpus/ — raw source recordings (not committed)

Drop the Lingua Libre dump here, e.g.:

    corpus/lingua-libre/
      ajp/…   South Levantine
      apc/…   North Levantine

Everything under `corpus/` is gitignored. It is a build input only: the dump
stays on whatever machine runs the extraction, and nothing in it is served.

What *does* get committed is the derivative:

- `audio/` — only the clips the app actually plays, transcoded for the browser
- `audio/manifest.json` — word → file, plus speaker, licence and attribution

Regenerate both with `tools/build_audio.py` (see that script for usage).
