#!/usr/bin/env python3
"""Turn Lingua Libre recordings into the app's audio/ directory.

The corpus is a build input, never a runtime asset: users fetch one small MP3
per word from GitHub Pages, not a zip. This script is what stands between the
two — it selects the handful of recordings the curriculum actually uses,
makes them sound consistent, and records who to credit.

    python3 tools/build_audio.py --report     # what's in corpus/, no writes
    python3 tools/build_audio.py              # build audio/ from selection.json

Drop any number of Lingua Libre archives (or unpacked trees) into corpus/ and
re-run; new sources are picked up automatically. Needs ffmpeg, which it will
fetch via `pip install imageio-ffmpeg` if the system has none.
"""

import argparse, hashlib, json, os, re, shutil, subprocess, sys, tempfile, unicodedata, zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CORPUS, OUT, SELECT = ROOT / "corpus", ROOT / "audio", ROOT / "tools" / "selection.json"
DATA = ROOT / "data.js"
AUDIO_EXT = {".ogg", ".wav", ".flac", ".mp3", ".opus"}

# Lingua Libre recordings are CC BY-SA 4.0. Shipping them obliges us to credit
# the speaker, so every clip carries its provenance into the manifest.
LICENSE = "CC BY-SA 4.0"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"
CORPUS_URL = "https://lingualibre.org/"


# ————————————————————— Arabic —————————————————————

DIACRITICS = re.compile(r"[ً-ْٰـ]")
ARABIC = re.compile(r"[ؠ-ي]")

def normalise(s):
    """Fold the spelling variations that keep a word from matching itself.

    Contributors write the same word with and without harakat, with أ or ا,
    with ى or ي. The app's data.js does the same. Matching on the raw string
    silently loses recordings, so both sides go through this first.
    """
    s = unicodedata.normalize("NFC", s)
    s = DIACRITICS.sub("", s)
    s = re.sub(r"[أإآٱ]", "ا", s)
    s = s.replace("ى", "ي").replace("ؤ", "و").replace("ئ", "ي")
    s = re.sub(r"[؟!،.,?]", "", s)
    return re.sub(r"\s+", " ", s).strip()


# The words the app teaches outside the corpus-derived lessons — the curated
# vocabulary in data.js. Read straight out of the source rather than duplicated
# into selection.json: the app now has no speech synthesis, so a word the
# curriculum teaches and the corpus happens to hold must never be missed
# because nobody remembered to copy it across. Only the VOCAB block is scanned;
# the lessons below it are already selected by speaker, and the dialogues after
# it are sentences no single-word recording could cover.
def app_vocabulary(path=DATA):
    src = path.read_text(encoding="utf-8")
    try:
        block = src[src.index("const VOCAB"):src.index("const TEXTS")]
    except ValueError:
        sys.exit(f"{path}: could not find the VOCAB block — has data.js been restructured?")
    return re.findall(r'ar:\s*"([^"]+)"', block)


# Rough Arabic→ASCII purely for readable filenames — never shown to a learner,
# so it only has to be stable and collision-resistant, not correct.
TRANSLIT = {
    "ا": "a", "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "h", "خ": "kh",
    "د": "d", "ذ": "dh", "ر": "r", "ز": "z", "س": "s", "ش": "sh", "ص": "s",
    "ض": "d", "ط": "t", "ظ": "z", "ع": "3", "غ": "gh", "ف": "f", "ق": "q",
    "ك": "k", "ل": "l", "م": "m", "ن": "n", "ه": "h", "و": "w", "ي": "y",
    "ة": "a", "ء": "2", " ": "-",
}

def slug(word, speaker):
    base = "".join(TRANSLIT.get(c, "") for c in normalise(word)).strip("-") or "clip"
    # The hash keeps two speakers' takes of one word from colliding, and keeps
    # filenames stable across runs so git sees no churn.
    h = hashlib.sha1(f"{normalise(word)}|{speaker}".encode()).hexdigest()[:6]
    return f"{base[:32]}-{h}"


# ————————————————————— ffmpeg —————————————————————

def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("ffmpeg not found. Install it, or: pip install imageio-ffmpeg")


def measure(ffmpeg, path, prefilter=""):
    """Peak and mean level in dBFS, via ffmpeg's volumedetect.

    `prefilter` runs first, so levels can be measured on audio in the state the
    gain will actually be applied to — trimming silence lifts mean level by a
    couple of dB, and measuring before it overshoots the target by that much.
    """
    af = f"{prefilter},volumedetect" if prefilter else "volumedetect"
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path), "-af", af,
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    def grab(key):
        m = re.search(rf"{key}:\s*(-?[\d.]+) dB", out)
        return float(m.group(1)) if m else None
    return grab("max_volume"), grab("mean_volume")


# Contributors record at wildly different levels — the samples here span 8 dB
# of peak and sit ~30 dB below full scale, which would make a lesson lurch in
# volume from card to card. EBU R128 loudnorm is the usual answer but wants
# >3 s of audio to measure; these clips are ~1 s. So: lift each clip to a
# common RMS, then hold peaks below -1 dBFS so nothing clips.
TARGET_RMS_DB = -20.0
PEAK_CEILING_DB = -1.5

# Mono first so the level maths and adelay see one channel; then trim the dead
# air contributors leave around a word, padding 60 ms back on afterwards so the
# gate can't shave off the first consonant.
MONO = "aformat=channel_layouts=mono"
TRIM = ("silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,"
        "areverse,"
        "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,"
        "areverse")

def transcode(ffmpeg, src, dst):
    # Pass 1: measure the trimmed, mono audio — the thing the gain lands on.
    peak, mean = measure(ffmpeg, src, f"{MONO},{TRIM}")
    gain = 0.0
    if mean is not None:
        gain = TARGET_RMS_DB - mean
        if peak is not None:
            gain = min(gain, PEAK_CEILING_DB - peak)
    # Pass 2: gain, then a limiter — resampling to 24 kHz and MP3 quantisation
    # both overshoot the source peak, so the arithmetic ceiling alone isn't
    # enough to keep clips off 0 dBFS.
    af = (f"{MONO},{TRIM},volume={gain:.2f}dB,alimiter=limit=0.84:level=disabled,"
          "adelay=60,apad=pad_dur=0.06")
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
           "-af", af, "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "48k", str(dst)]
    subprocess.run(cmd, check=True, capture_output=True)
    return duration(ffmpeg, dst)


def duration(ffmpeg, path):
    out = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path)],
                         capture_output=True, text=True).stderr
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", out)
    return round(int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3)), 2) if m else None


# ————————————————————— the corpus —————————————————————

class Recording:
    """One take of one word by one speaker, wherever it physically lives."""
    def __init__(self, word, speaker, archive, entry, size):
        self.word, self.speaker = word, speaker
        self.archive, self.entry, self.size = archive, entry, size
        self.key = normalise(word)

    def read(self):
        if self.archive:
            with zipfile.ZipFile(self.archive) as z:
                return z.read(self.entry)
        return Path(self.entry).read_bytes()


def index_corpus(corpus=CORPUS):
    """Every recording under corpus/, from any number of zips or loose trees.

    Lingua Libre lays archives out as <language>/<speaker>/<word>.ogg, and some
    exports prefix entries with a stray '/' — hence the lstrip.
    """
    recs, sources = [], []
    if not corpus.exists():
        return recs, sources
    for zp in sorted(corpus.glob("*.zip")):
        sources.append({"archive": zp.name,
                        "sha256": hashlib.sha256(zp.read_bytes()).hexdigest()})
        with zipfile.ZipFile(zp) as z:
            for info in z.infolist():
                p = info.filename.lstrip("/")
                if Path(p).suffix.lower() not in AUDIO_EXT:
                    continue
                parts = p.split("/")
                if len(parts) < 2:
                    continue
                word, speaker = read_name(Path(parts[-1]).stem, parts[-2])
                recs.append(Recording(word, speaker, zp, info.filename, info.file_size))
    for d in sorted(x for x in corpus.iterdir() if x.is_dir()):
        for f in sorted(d.rglob("*")):
            if f.is_file() and f.suffix.lower() in AUDIO_EXT:
                word, speaker = read_name(f.stem, f.parent.name)
                recs.append(Recording(word, speaker, None, str(f), f.stat().st_size))
        sources.append({"directory": d.name})
    return recs, sources


# Commons names every Lingua Libre file "LL-Q<qid> (<iso>)-<speaker>-<word>",
# which is what tools/fetch-commons-audio.py downloads — flat, no directory per
# speaker. The dataset zips instead use <language>/<speaker>/<word>. Read both,
# so a corpus assembled either way indexes the same.
# The word is what follows the LAST hyphen, not the first: contributor names
# carry hyphens ("Jean-Pierre") far more often than recorded Arabic words do.
LL_NAME = re.compile(r"^LL-Q\d+[\s_]*\([^)]*\)[-_](?P<speaker>.+)-(?P<word>[^-]+)$")

def read_name(stem, parent):
    m = LL_NAME.match(stem)
    return (m.group("word"), m.group("speaker")) if m else (stem, parent)


def by_speaker(recs):
    out = {}
    for r in recs:
        out.setdefault(r.speaker, {}).setdefault(r.key, []).append(r)
    return out


# ————————————————————— build —————————————————————

def report(recs):
    spk = by_speaker(recs)
    print(f"{len(recs)} recordings, {len(spk)} speakers\n")
    for s, words in sorted(spk.items(), key=lambda kv: -len(kv[1])):
        non_arabic = [w for w in words if not ARABIC.search(w)]
        note = f"   ({len(non_arabic)} non-Arabic filenames)" if non_arabic else ""
        print(f"  {len(words):5d} words  {s}{note}")


def build(recs, spec, out=OUT, force=False):
    ffmpeg = find_ffmpeg()
    spk = by_speaker(recs)
    out.mkdir(parents=True, exist_ok=True)
    lessons, seen, skipped, taken = [], set(), [], set()

    for lesson in spec["lessons"]:
        speaker = lesson["speaker"]
        # A lesson normally names one speaker so its voice stays consistent.
        # "*" pools every speaker instead — for supplementary coverage of words
        # that already exist in the app, where having a recording at all beats
        # having the same voice throughout.
        if speaker == "*":
            available = {}
            for words in spk.values():
                for key, takes in words.items():
                    available.setdefault(key, []).extend(takes)
        elif speaker not in spk:
            sys.exit(f"unknown speaker {speaker!r} — run --report to list them")
        else:
            available = spk[speaker]
        wanted = lesson.get("words", "*")
        if wanted == "*":
            keys = sorted(available)
        elif wanted == "vocab":
            # Everything the app teaches that anyone recorded. Words an earlier
            # lesson already claimed are left to it, so no word ships twice
            # under two speakers with only one of them reachable.
            keys = [k for k in dict.fromkeys(normalise(w) for w in app_vocabulary())
                    if k not in taken]
        else:
            keys = [normalise(w) for w in wanted]
        # Where a listening pass rejects a recording — misread word, botched
        # take, a filename the audio doesn't match — name it here rather than
        # narrowing `words`, so the reason stays attached to the decision.
        dropped = {normalise(w) for w in lesson.get("exclude", [])}

        clips = []
        for key in keys:
            if key in dropped:
                skipped.append((lesson["id"], key, "excluded by review"))
                continue
            takes = available.get(key)
            if not takes:
                skipped.append((lesson["id"], key, "no recording"))
                continue
            # Filenames like "1" or "Monday" label the audio in English; the
            # Arabic they actually contain is unknown until someone listens,
            # so they can't be shipped as flashcards yet.
            if not ARABIC.search(key):
                skipped.append((lesson["id"], key, "non-Arabic filename"))
                continue
            take = max(takes, key=lambda r: r.size)  # longest take: least clipped
            name = slug(take.word, take.speaker)
            dst = out / f"{name}.mp3"
            if force or not dst.exists():
                with tempfile.NamedTemporaryFile(suffix=Path(take.entry).suffix) as tmp:
                    tmp.write(take.read()); tmp.flush()
                    dur = transcode(ffmpeg, tmp.name, dst)
            else:
                dur = duration(ffmpeg, dst)
            # Speaker rides on every clip, not just the lesson: a pooled lesson
            # has several, and CC-BY-SA credit is owed per recording.
            clips.append({"ar": take.word, "file": f"audio/{name}.mp3", "dur": dur,
                          "speaker": take.speaker})
            seen.add(f"{name}.mp3")
            taken.add(key)
            print(f"  {lesson['id']:>10}  {take.word:<20} {dst.name}")

        voices = sorted({c["speaker"] for c in clips})
        lessons.append({"id": lesson["id"], "title": lesson.get("title", lesson["id"]),
                        "speaker": " · ".join(voices) if speaker == "*" else speaker,
                        "clips": clips})

    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {"corpus": CORPUS_URL, "license": LICENSE, "license_url": LICENSE_URL,
                   "archives": spec.get("_sources", [])},
        "lessons": lessons,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n",
                                       encoding="utf-8")

    # A clip nothing references is a leftover from an earlier selection; left in
    # place it would ship bytes no learner can reach.
    orphans = [p for p in out.glob("*.mp3") if p.name not in seen]
    for p in orphans:
        p.unlink()

    total = sum(p.stat().st_size for p in out.glob("*.mp3"))
    print(f"\n{sum(len(l['clips']) for l in lessons)} clips, {total/1024:.0f} KB total"
          + (f", {len(orphans)} orphan(s) removed" if orphans else ""))
    if skipped:
        print(f"\nskipped {len(skipped)}:")
        for lid, key, why in skipped[:20]:
            print(f"  {lid:>10}  {key:<20} {why}")
        if len(skipped) > 20:
            print(f"  … and {len(skipped)-20} more")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", type=Path, default=CORPUS)
    ap.add_argument("--select", type=Path, default=SELECT)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--report", action="store_true", help="describe corpus/ and exit")
    ap.add_argument("--force", action="store_true", help="re-encode clips that already exist")
    args = ap.parse_args()

    recs, sources = index_corpus(args.corpus)
    if not recs:
        sys.exit(f"no recordings under {args.corpus} — see corpus/README.md")
    if args.report:
        return report(recs)

    spec = json.loads(args.select.read_text(encoding="utf-8"))
    spec["_sources"] = sources
    build(recs, spec, args.out, args.force)


if __name__ == "__main__":
    main()
