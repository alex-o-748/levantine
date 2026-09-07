#!/usr/bin/env python3
"""Synthesise the dialogue lines the app has no recording for.

Words are not synthesised. Lingua Libre covers them with real speakers, and a
neural voice reading a bare citation form is exactly where these models drift
on stress and vowel length — the learner would be memorising the drift. What
no recording can ever cover is a *sentence*, which is why the Texts tab lost
its listening mode. That is the gap this fills.

Two backends, both dialect-native rather than Modern Standard:

  omnivoice  oddadmix/lahgtna-omnivoice-v2 — OmniVoice fine-tuned on 13 Arabic
             dialects, Lebanese/Syrian/Palestinian among them.
  leva       mohammedaly22/leva-tts — XTTS-v2 fine-tuned on 50k utterances that
             lahgtna-omnivoice-v2 generated. A distillation of the first, so
             expect its ceiling to be lower; its weights also inherit XTTS-v2's
             non-commercial Coqui Public Model License.

Neither runs in the browser and neither needs to: clips are generated once, on
one GPU, and committed like the Commons recordings. The app stays static.

    # on a GPU box (see tools/synth_job.sh for HF Jobs / Colab)
    python3 tools/synth_lines.py --backend omnivoice        # -> build/synth/omnivoice/
    python3 tools/synth_lines.py --backend leva             # -> build/synth/leva/

    # anywhere, no GPU needed
    python3 tools/synth_lines.py --plan                     # what would be generated
    python3 tools/synth_lines.py --compare                  # -> build/synth-compare.html
    python3 tools/synth_lines.py --promote omnivoice        # -> audio/synth/ + manifest

Staging into build/ rather than straight into audio/ is the point: nothing
ships until someone has listened to it against the other backend. --promote is
the only step that writes to audio/.
"""

import argparse, base64, hashlib, html, json, re, shutil, sys, tempfile
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_audio import TRANSLIT, duration, find_ffmpeg, normalise, transcode

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data.js"
CONFIG = ROOT / "tools" / "synth.json"
STAGE = ROOT / "build" / "synth"
COMPARE = ROOT / "build" / "synth-compare.html"
OUT = ROOT / "audio" / "synth"
MANIFEST = ROOT / "audio" / "synth-manifest.json"

BACKENDS = ("omnivoice", "leva")


# ————————————————————— data.js —————————————————————

# One text object per top-level entry, one line per single-line object inside
# it. Both are matched exactly rather than loosely: data.js is hand-maintained
# and consistently formatted, and a regex that quietly matches half a file is
# how you ship a manifest missing a third of the dialogue.
TEXT_BLOCK = re.compile(r"\n  \{\n(?P<body>.*?)\n  \},", re.S)
LINE = re.compile(
    r'^\s*\{ (?:sp: "(?P<sp>[^"]*)", )?ar: "(?P<ar>[^"]*)", en: "(?P<en>[^"]*)" \},$', re.M)
FIELD = lambda body, name: (re.search(rf'^    {name}: "([^"]*)",$', body, re.M) or [None, None])[1]


def read_texts(path=DATA):
    """The TEXTS array out of data.js, as the app sees it."""
    src = path.read_text(encoding="utf-8")
    try:
        block = src[src.index("const TEXTS"):]
    except ValueError:
        sys.exit(f"{path}: no TEXTS block — has data.js been restructured?")
    texts = []
    for m in TEXT_BLOCK.finditer(block):
        body = m.group("body")
        tid = FIELD(body, "id")
        if not tid:
            continue
        lines = [{"sp": ln.group("sp"), "ar": ln.group("ar"), "en": ln.group("en")}
                 for ln in LINE.finditer(body)]
        texts.append({"id": tid, "title": FIELD(body, "title"),
                      "titleAr": FIELD(body, "titleAr"), "lines": lines})
    if not texts or not any(t["lines"] for t in texts):
        sys.exit(f"{path}: TEXTS parsed to nothing — the formatting this script "
                 f"matches (one line object per line) has changed.")
    return texts


# ————————————————————— the job list —————————————————————

class Job:
    """One line of one text, and the voice that should read it."""

    def __init__(self, text, i, line, voice_name, voice):
        self.text_id, self.i = text["id"], i
        self.ar, self.en = line["ar"], line["en"]
        self.voice_name, self.voice = voice_name, voice

    # Named for the text and its position so a staged directory reads in order,
    # and hashed on the words actually spoken so an edit in data.js produces a
    # new filename instead of silently keeping the clip of the old sentence.
    def slug(self, backend):
        h = hashlib.sha1(f"{normalise(self.ar)}|{self.voice_name}|{backend}"
                         .encode()).hexdigest()[:6]
        return f"{self.text_id}-{self.i:02d}-{h}"


def plan(texts, cfg):
    voices, per_text = cfg.get("voices", {}), cfg.get("texts", {})
    jobs, unknown = [], set()
    for text in texts:
        narrator = per_text.get(text["id"], {}).get("voice")
        for i, line in enumerate(text["lines"]):
            # A dialogue names its speaker; a monologue is read by the narrator
            # this text was assigned. Falling through to `default` for both
            # would give every monologue the same voice.
            name = line["sp"] or narrator or "default"
            voice = voices.get(name)
            if voice is None:
                if name != "default":
                    unknown.add(name)
                voice = cfg.get("default", {})
            jobs.append(Job(text, i, line, name, voice))
    if unknown:
        # Not fatal — the line still gets read — but it gets read in the default
        # voice, which is how a two-hander ends up sounding like one person.
        print(f"warning: no voice configured for {', '.join(sorted(unknown))} "
              f"— using `default`. Add them to {CONFIG.name}.\n", file=sys.stderr)
    return jobs


# ————————————————————— backends —————————————————————

class OmniVoice:
    """oddadmix/lahgtna-omnivoice-v2, via the `lahgtna-omnivoice` package.

    Voice design (`instruct`) rather than cloning by default. Upstream warns
    that voice design was trained on Chinese and English only and generalises
    unevenly, but the Lahgtna fine-tune adds the Arabic dialect attributes, and
    the alternative — cloning — needs 3-10 s of reference speech that this
    project does not have going spare. Set `ref`/`ref_text` on a voice in
    synth.json to clone instead; see the note there before you do.
    """

    name = "omnivoice"

    def __init__(self, cfg, device=None):
        self.cfg = cfg
        self.dialect = cfg.get("_dialect", "")
        try:
            import torch
            from omnivoice import OmniVoice as _Model
        except ImportError as e:
            sys.exit(f"{e}. Install the backend first:\n"
                     f"    pip install lahgtna-omnivoice   # or `omnivoice` upstream,\n"
                     f"                                    # plus a CUDA torch build\n"
                     f"Both publish the same `omnivoice` module. "
                     f"See tools/synth_job.sh for a runner that does this for you.")
        device = device or ("cuda:0" if torch.cuda.is_available() else "cpu")
        dtype = torch.float16 if device.startswith("cuda") else torch.float32
        print(f"loading {cfg['model']} on {device} …")
        self.model = _Model.from_pretrained(cfg["model"], device_map=device, dtype=dtype)

    def instruct_for(self, job):
        if job.voice.get("instruct"):
            return job.voice["instruct"]
        # Attributes are comma-separated and freely combinable; gender is the
        # only one the config asks for, dialect is global.
        bits = [job.voice.get("gender", "female")]
        if self.dialect:
            bits.append(self.dialect)
        return ", ".join(bits)

    def generate(self, job, dst, speed):
        import soundfile as sf
        kwargs = {"text": job.ar, "speed": speed}
        if self.cfg.get("num_step"):
            kwargs["num_step"] = self.cfg["num_step"]
        ref = job.voice.get("ref")
        if ref:
            kwargs["ref_audio"] = str(ROOT / ref)
            if job.voice.get("ref_text"):
                kwargs["ref_text"] = job.voice["ref_text"]
        else:
            kwargs["instruct"] = self.instruct_for(job)
        audio = self.model.generate(**kwargs)
        sf.write(str(dst), audio[0], 24000)

    def voices(self):
        return []  # voice design takes free text; there is no fixed list

    def validate(self, jobs):
        for job in jobs:
            ref = job.voice.get("ref")
            if ref and not (ROOT / ref).exists():
                sys.exit(f"{job.voice_name}: reference clip {ref} not found")


class Leva:
    """mohammedaly22/leva-tts — an XTTS-v2 fine-tune, loaded through Coqui TTS.

    XTTS fine-tunes are published as a checkpoint plus config plus speaker file
    rather than through a single loader, and the exact filenames vary by
    publisher. So: pull the repo, find those three by their conventional names,
    and say plainly what was in the snapshot if they are not there — better
    than a stack trace from inside the library.
    """

    name = "leva"

    def __init__(self, cfg, device=None):
        self.cfg = cfg
        try:
            import torch
            from huggingface_hub import snapshot_download
            from TTS.tts.configs.xtts_config import XttsConfig
            from TTS.tts.models.xtts import Xtts
        except ImportError as e:
            sys.exit(f"{e}. Install the backend first:\n"
                     f"    pip install coqui-tts huggingface_hub\n"
                     f"See tools/synth_job.sh for a runner that does this for you.")
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"downloading {cfg['model']} …")
        repo = Path(snapshot_download(cfg["model"]))
        conf = self._find(repo, ["config.json"])
        ckpt = self._find(repo, ["model.pth", "best_model.pth", "checkpoint.pth"])
        vocab = self._find(repo, ["vocab.json"], required=False)
        config = XttsConfig()
        config.load_json(str(conf))
        self.model = Xtts.init_from_config(config)
        self.model.load_checkpoint(config, checkpoint_path=str(ckpt),
                                   vocab_path=str(vocab) if vocab else None,
                                   use_deepspeed=False)
        self.model.to(self.device)

    @staticmethod
    def _find(repo, names, required=True):
        for n in names:
            hits = sorted(repo.rglob(n))
            if hits:
                return hits[0]
        if not required:
            return None
        have = "\n  ".join(sorted(str(p.relative_to(repo)) for p in repo.rglob("*") if p.is_file()))
        sys.exit(f"none of {names} in the {repo.name} snapshot. It holds:\n  {have}\n"
                 f"Point tools/synth.json at the right files, or use --backend omnivoice.")

    def voices(self):
        sm = getattr(self.model, "speaker_manager", None)
        return sorted(getattr(sm, "speakers", {}) or {}) if sm else []

    # Checked before the first line rather than at the line that trips it: an
    # hour of generation that dies two thirds through on an unmapped character
    # is an hour of GPU time spent for nothing.
    def validate(self, jobs):
        known = self.voices()
        if not known:
            sys.exit(f"{self.cfg['model']} exposes no built-in speakers, so every line "
                     f"would be read in one default voice. Use --backend omnivoice, or "
                     f"give each voice in {CONFIG.name} a reference clip.")
        missing, unknown = set(), set()
        for job in jobs:
            name = job.voice.get("leva_speaker")
            # Reading every character in one voice silently is worse than
            # stopping: the per-character mapping is the whole point.
            (missing if not name else unknown if name not in known else set()).add(job.voice_name)
        if missing or unknown:
            sys.exit((f"no `leva_speaker` set for: {', '.join(sorted(missing))}\n" if missing else "")
                     + (f"unknown `leva_speaker` for: {', '.join(sorted(unknown))}\n" if unknown else "")
                     + f"This checkpoint ships: {', '.join(known)}")

    def generate(self, job, dst, speed):
        import torch, torchaudio
        # Addressed by key rather than unpacked positionally — the entry is a
        # dict, and which of the two tensors comes out first is not a contract.
        entry = self.model.speaker_manager.speakers[job.voice["leva_speaker"]]
        out = self.model.inference(text=job.ar, language=self.cfg.get("language", "ar"),
                                   gpt_cond_latent=entry["gpt_cond_latent"],
                                   speaker_embedding=entry["speaker_embedding"],
                                   speed=speed)
        wav = out["wav"]
        wav = wav if hasattr(wav, "dim") else torch.tensor(wav)
        torchaudio.save(str(dst), wav.detach().cpu().reshape(1, -1), 24000)


def open_backend(name, cfg, device=None):
    spec = dict(cfg["backends"][name])
    spec["_dialect"] = cfg.get("dialect", "")
    return {"omnivoice": OmniVoice, "leva": Leva}[name](spec, device)


# ————————————————————— staging —————————————————————

def stage(name, cfg, jobs, root=STAGE, device=None, force=False):
    """Generate every line with one backend into build/synth/<backend>/."""
    ffmpeg = find_ffmpeg()
    out = root / name
    out.mkdir(parents=True, exist_ok=True)
    backend = open_backend(name, cfg, device)
    if hasattr(backend, "validate"):
        backend.validate(jobs)
    speed = cfg.get("speed", 1.0)

    clips, seen = {}, set()
    for job in jobs:
        dst = out / f"{job.slug(name)}.mp3"
        if force or not dst.exists():
            with tempfile.NamedTemporaryFile(suffix=".wav") as raw:
                backend.generate(job, raw.name, speed)
                # The same trim, gain and 24 kHz mono MP3 the Lingua Libre
                # clips get. Not tidiness: a text line and a word card play
                # back to back in one session, and a synthetic line arriving
                # several dB louder than the recordings is the first thing a
                # learner notices about it.
                dur = transcode(ffmpeg, raw.name, dst)
        else:
            dur = duration(ffmpeg, dst)
        clips.setdefault(job.text_id, []).append(
            {"i": job.i, "ar": job.ar, "file": dst.name, "dur": dur, "voice": job.voice_name})
        seen.add(dst.name)
        print(f"  {job.text_id:>7} {job.i:>2}  {job.voice_name:<10} {job.ar[:44]}")

    write_manifest(out / "manifest.json", name, cfg, clips, prefix="")
    for p in out.glob("*.mp3"):        # lines edited in data.js leave their old clip behind
        if p.name not in seen:
            p.unlink()
    total = sum(p.stat().st_size for p in out.glob("*.mp3"))
    print(f"\n{len(jobs)} lines, {total/1024:.0f} KB in {out.relative_to(ROOT)}")
    print(f"Listen before shipping:  python3 tools/synth_lines.py --compare")


def write_manifest(path, name, cfg, clips, prefix):
    spec = cfg["backends"][name]
    manifest = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        # The app reads this to decide whether to label the audio. It is not a
        # detail to leave implicit: a learner is owed the difference between a
        # person and a model.
        "synthetic": True,
        "engine": {"backend": name, "model": spec["model"],
                   "dialect": cfg.get("dialect", ""), "speed": cfg.get("speed", 1.0),
                   "license": spec.get("license", ""), "license_url": spec.get("license_url", "")},
        "texts": {tid: [dict(c, file=prefix + c["file"]) for c in sorted(ls, key=lambda c: c["i"])]
                  for tid, ls in clips.items()},
    }
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return manifest


# ————————————————————— compare —————————————————————

def compare(root=STAGE, dst=COMPARE):
    """One page, every line, both backends side by side.

    Data URIs so it opens from the filesystem with no server, the same trick
    tools/make_review.py uses — the point is to listen on whatever machine the
    staged audio landed on, not to stand a server up first.
    """
    staged = [(n, json.loads((root / n / "manifest.json").read_text(encoding="utf-8")))
              for n in BACKENDS if (root / n / "manifest.json").exists()]
    if not staged:
        sys.exit(f"nothing staged under {root.relative_to(ROOT)} — run --backend first.")
    texts = {t["id"]: t for t in read_texts()}

    def uri(name, f):
        return "data:audio/mpeg;base64," + base64.b64encode((root / name / f).read_bytes()).decode()

    rows = []
    for tid, text in texts.items():
        rows.append(f"<h2>{html.escape(text['titleAr'])} <small>{html.escape(text['title'] or '')}</small></h2>")
        for i, line in enumerate(text["lines"]):
            players = []
            for name, man in staged:
                clip = next((c for c in man["texts"].get(tid, []) if c["i"] == i), None)
                players.append(
                    f"<div class=take><span class=who>{html.escape(name)}</span>"
                    + (f"<audio controls preload=none src='{uri(name, clip['file'])}'></audio>"
                       f"<span class=dur>{clip['dur']}s</span>" if clip else "<em>not staged</em>")
                    + "</div>")
            rows.append(
                f"<div class=line><div class=ar dir=rtl>"
                f"{('<b>' + html.escape(line['sp']) + ':</b> ') if line['sp'] else ''}"
                f"{html.escape(line['ar'])}</div>"
                f"<div class=en>{html.escape(line['en'])}</div>{''.join(players)}</div>")

    engines = " · ".join(f"{n}: {m['engine']['model']}" for n, m in staged)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(f"""<!doctype html><meta charset=utf-8>
<title>Synthetic line review</title>
<style>
 body {{ font: 15px/1.6 system-ui, sans-serif; max-width: 820px; margin: 2rem auto;
        padding: 0 1rem; background: #fbfbfa; color: #1d1c1a; }}
 h1 {{ margin-bottom: .2rem }} h2 {{ margin-top: 2.2rem; }}
 h2 small {{ font-weight: 400; color: #6b6a67; font-size: .8em; }}
 .note {{ color: #6b6a67; }}
 .line {{ border: 1px solid #e2e0dc; border-radius: 10px; padding: .7rem .9rem; margin: .7rem 0;
          background: #fff; }}
 .ar {{ font-size: 1.3rem; }} .en {{ color: #6b6a67; font-size: .9rem; margin-bottom: .5rem; }}
 .take {{ display: flex; align-items: center; gap: .6rem; margin-top: .35rem; }}
 .who {{ font-size: .78rem; width: 5.5rem; color: #6b6a67; }}
 .dur {{ font-size: .78rem; color: #6b6a67; }}
 audio {{ height: 32px; flex: 1; }}
</style>
<h1>Synthetic line review</h1>
<p class=note>{html.escape(engines)}</p>
<p class=note>Listen to both takes of each line. Pick the backend that reads the
dialect — not the one that sounds smoothest — then
<code>python3 tools/synth_lines.py --promote &lt;backend&gt;</code>. Anything that
comes out as Modern Standard, with case endings or a classical qāf, is the
failure this whole pipeline exists to avoid: reject it rather than ship it.</p>
{''.join(rows)}
""", encoding="utf-8")
    print(f"{dst.relative_to(ROOT)}  ({dst.stat().st_size/1024:.0f} KB, "
          f"{', '.join(n for n, _ in staged)})")


# ————————————————————— promote —————————————————————

def promote(name, cfg, root=STAGE, out=OUT, manifest=MANIFEST):
    """Copy one staged backend into audio/ — the only step that ships bytes."""
    src = root / name
    staged = src / "manifest.json"
    if not staged.exists():
        sys.exit(f"{name} is not staged — run --backend {name} first.")
    man = json.loads(staged.read_text(encoding="utf-8"))
    out.mkdir(parents=True, exist_ok=True)

    seen = set()
    for clips in man["texts"].values():
        for c in clips:
            shutil.copy2(src / c["file"], out / c["file"])
            seen.add(c["file"])
    for p in out.glob("*.mp3"):        # whatever the previous backend left
        if p.name not in seen:
            p.unlink()

    write_manifest(manifest, name, cfg,
                   {tid: [{k: v for k, v in c.items()} for c in clips]
                    for tid, clips in man["texts"].items()},
                   prefix="audio/synth/")
    total = sum(p.stat().st_size for p in out.glob("*.mp3"))
    print(f"{len(seen)} clips, {total/1024:.0f} KB -> {out.relative_to(ROOT)}\n"
          f"manifest -> {manifest.relative_to(ROOT)}")


# ————————————————————— cli —————————————————————

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", choices=BACKENDS, help="generate every line with this model")
    ap.add_argument("--compare", action="store_true", help="build build/synth-compare.html")
    ap.add_argument("--promote", choices=BACKENDS, help="ship a staged backend into audio/")
    ap.add_argument("--plan", action="store_true", help="list the lines and voices, generate nothing")
    ap.add_argument("--list-voices", action="store_true", help="print the backend's built-in speakers")
    ap.add_argument("--config", type=Path, default=CONFIG)
    ap.add_argument("--stage", type=Path, default=STAGE)
    ap.add_argument("--device", help='e.g. "cuda:0", "mps", "cpu" (default: cuda if present)')
    ap.add_argument("--force", action="store_true", help="re-generate clips that already exist")
    args = ap.parse_args()

    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    texts = read_texts()
    jobs = plan(texts, cfg)

    if args.plan:
        by_voice = {}
        for j in jobs:
            by_voice.setdefault(j.voice_name, []).append(j)
        print(f"{len(jobs)} lines across {len(texts)} texts, "
              f"{len(by_voice)} voices, speed {cfg.get('speed', 1.0)}\n")
        for tid in dict.fromkeys(j.text_id for j in jobs):
            for j in (x for x in jobs if x.text_id == tid):
                print(f"  {j.text_id:>7} {j.i:>2}  {j.voice_name:<10} {j.ar}")
            print()
        print("  " + "  ".join(f"{v}×{len(js)}" for v, js in sorted(by_voice.items())))
        return
    if args.list_voices:
        if not args.backend:
            sys.exit("--list-voices needs --backend")
        names = open_backend(args.backend, cfg, args.device).voices()
        print("\n".join(names) if names else
              f"{args.backend} has no fixed speaker list (it takes a free-text voice description).")
        return
    if args.backend:
        stage(args.backend, cfg, jobs, args.stage, args.device, args.force)
    if args.compare:
        compare(args.stage)
    if args.promote:
        promote(args.promote, cfg, args.stage)
    if not (args.backend or args.compare or args.promote):
        ap.print_help()


if __name__ == "__main__":
    main()
