#!/usr/bin/env python3
"""Build an offline index (and optionally a local copy) of a Lingua Libre
pronunciation category on Wikimedia Commons.

The app currently finds recordings with two live Commons search calls per word,
which is slow, fails offline, and only ever finds one file at a time. A whole
speaker's category is a few thousand files whose names already say which word
they are, so one pass over the category gives a word -> file map for everything
that speaker ever recorded.

    # index only (~10 API calls, no media downloaded)
    python3 tools/fetch-commons-audio.py

    # index + download the wav files into audio/
    python3 tools/fetch-commons-audio.py --download

Stdlib only, to match the rest of this repo. Re-running is cheap: already
downloaded files with the right size are skipped.
"""

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://commons.wikimedia.org/w/api.php"
UPLOAD_BASE = "https://upload.wikimedia.org/wikipedia/commons/"

DEFAULT_CATEGORY = "Category:Lingua Libre pronunciation by AdrianAbdulBaha"

# Lingua Libre names every file "LL-Q<lang qid> (<iso>)-<speaker>-<word>.wav".
LL_NAME = re.compile(r"^LL-Q\d+ \((?P<iso>[a-z-]{2,8})\)-(?P<rest>.+)\.(?P<ext>[a-z0-9]+)$")

# Arabic diacritics and tatweel: present in some recorded words, never in the
# app's vocabulary, so both sides are normalised before matching.
DIACRITICS = re.compile(r"[ً-ْٰـ]")
PUNCT = re.compile(r"[،؛؟!?.,'\"()\[\]]")


def normalize(word):
    return PUNCT.sub("", DIACRITICS.sub("", word)).strip()


def api_get(params, ua, retries=4):
    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": ua})
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.load(res)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            if attempt == retries - 1:
                raise
            wait = 2 ** attempt
            print(f"  api error ({err}); retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)


def list_category(category, ua, limit=None):
    """Yield {title, url, size} for every file in the category.

    generator=categorymembers + prop=imageinfo gets names and URLs together,
    500 at a time, so a 4000-file category is ~8 requests rather than 4000.
    """
    params = {
        "action": "query",
        "format": "json",
        "formatversion": "2",
        "generator": "categorymembers",
        "gcmtitle": category,
        "gcmtype": "file",
        "gcmnamespace": "6",
        "gcmlimit": "500",
        "prop": "imageinfo",
        "iiprop": "url|size|mime",
    }
    seen = 0
    while True:
        data = api_get(params, ua)
        if "error" in data:
            sys.exit("Commons API error: %s" % data["error"].get("info", data["error"]))
        for page in data.get("query", {}).get("pages", []):
            info = (page.get("imageinfo") or [{}])[0]
            if not info.get("url"):
                continue
            yield {"title": page["title"], "url": info["url"], "size": info.get("size", 0)}
            seen += 1
            if limit and seen >= limit:
                return
        if "continue" not in data:
            return
        params.update(data["continue"])


def parse_word(title, speaker):
    """'File:LL-Q1137779 (ajp)-AdrianAbdulBaha-كتاب.wav' -> ('كتاب', 'ajp')."""
    name = title[len("File:"):] if title.startswith("File:") else title
    m = LL_NAME.match(name)
    if not m:
        return None, None
    rest = m.group("rest")
    # The word itself can contain "-", so strip the known speaker prefix rather
    # than splitting on the first hyphen.
    if speaker and rest.startswith(speaker + "-"):
        word = rest[len(speaker) + 1:]
    elif "-" in rest:
        word = rest.split("-", 1)[1]
    else:
        return None, None
    return word.strip(), m.group("iso")


def download(entry, out_dir, ua):
    """Fetch one file. Returns 'ok', 'skip', or an error string."""
    name = urllib.parse.unquote(entry["url"].rsplit("/", 1)[-1])
    path = os.path.join(out_dir, name)
    if os.path.exists(path) and (not entry["size"] or os.path.getsize(path) == entry["size"]):
        return "skip"
    tmp = path + ".part"
    try:
        req = urllib.request.Request(entry["url"], headers={"User-Agent": ua})
        with urllib.request.urlopen(req, timeout=120) as res, open(tmp, "wb") as fh:
            while True:
                chunk = res.read(65536)
                if not chunk:
                    break
                fh.write(chunk)
        os.replace(tmp, path)
        return "ok"
    except Exception as err:  # noqa: BLE001 - one bad file must not stop the run
        if os.path.exists(tmp):
            os.unlink(tmp)
        return "error: %s" % err


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--category", default=DEFAULT_CATEGORY)
    ap.add_argument("--speaker", default=None,
                    help="speaker name as it appears in filenames "
                         "(default: taken from the category name)")
    ap.add_argument("--index", default="audio-index.json", help="where to write the word map")
    ap.add_argument("--download", action="store_true", help="also fetch the media files")
    ap.add_argument("--out", default="audio", help="directory for downloaded files")
    ap.add_argument("--jobs", type=int, default=4, help="parallel downloads (keep this modest)")
    ap.add_argument("--limit", type=int, default=0, help="stop after N files (for testing)")
    ap.add_argument("--contact", default="https://github.com/alex-o-748/levantine",
                    help="contact URL or email for the User-Agent header")
    args = ap.parse_args()

    # Wikimedia blocks requests without a descriptive User-Agent (403/429).
    ua = "yalla-levantine-audio/1.0 (%s) python-urllib" % args.contact

    speaker = args.speaker
    if speaker is None:
        m = re.search(r"pronunciation by (.+)$", args.category)
        speaker = m.group(1).strip() if m else ""

    print("Listing %s ..." % args.category)
    files, unparsed = [], 0
    for entry in list_category(args.category, ua, args.limit or None):
        word, iso = parse_word(entry["title"], speaker)
        if not word:
            unparsed += 1
            continue
        entry.update(word=word, iso=iso)
        files.append(entry)
        if len(files) % 500 == 0:
            print("  %d files" % len(files))

    if not files:
        sys.exit("No Lingua Libre files found — check the category name.")

    total = sum(f["size"] for f in files)
    langs = {}
    for f in files:
        langs[f["iso"]] = langs.get(f["iso"], 0) + 1
    print("Found %d files (%.0f MB), languages: %s%s" % (
        len(files), total / 1e6,
        ", ".join("%s=%d" % kv for kv in sorted(langs.items(), key=lambda kv: -kv[1])),
        ", %d unparsed names skipped" % unparsed if unparsed else ""))

    # Build the index, grouped by language code: a speaker records in every
    # language they speak, and the app prefers Levantine (ajp/apc) over other
    # Arabic varieties. Within a language the first recording of a word wins —
    # the rest are the same speaker saying the same thing.
    words, dupes = {}, 0
    for f in files:
        key = normalize(f["word"])
        if not key or not f["url"].startswith(UPLOAD_BASE):
            continue
        by_lang = words.setdefault(f["iso"], {})
        if key in by_lang:
            dupes += 1
            continue
        by_lang[key] = f["url"][len(UPLOAD_BASE):]

    distinct = len(set().union(*words.values())) if words else 0
    index = {
        "category": args.category,
        "speaker": speaker,
        "base": UPLOAD_BASE,
        "count": distinct,
        "words": words,
    }
    with open(args.index, "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("Wrote %s: %d distinct words across %d language(s)%s (%.0f KB)" % (
        args.index, distinct, len(words),
        ", %d duplicate recordings dropped" % dupes if dupes else "",
        os.path.getsize(args.index) / 1e3))

    if not args.download:
        print("\nIndex only. Re-run with --download to fetch the audio itself.")
        return

    os.makedirs(args.out, exist_ok=True)
    print("\nDownloading %d files into %s/ with %d jobs ..." % (len(files), args.out, args.jobs))
    done = {"ok": 0, "skip": 0, "error": 0}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {pool.submit(download, f, args.out, ua): f for f in files}
        for i, fut in enumerate(concurrent.futures.as_completed(futures), 1):
            result = fut.result()
            if result.startswith("error"):
                done["error"] += 1
                print("  %s: %s" % (futures[fut]["title"], result), file=sys.stderr)
            else:
                done[result] += 1
            if i % 200 == 0:
                print("  %d/%d" % (i, len(files)))
    print("Done: %d downloaded, %d already present, %d failed."
          % (done["ok"], done["skip"], done["error"]))
    if done["error"]:
        print("Re-run the same command to retry the failures.")


if __name__ == "__main__":
    main()
