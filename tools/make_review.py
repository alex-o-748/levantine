#!/usr/bin/env python3
"""Generate a listening-review page for everything the pipeline can build.

One self-contained HTML file with every clip embedded as a data URI, so it can
be published or opened straight from disk with no server and no audio hosting.
Reviewers mark each clip keep / unsure / drop; the verdicts drive which
recordings survive into tools/selection.json.

    python3 tools/build_audio.py          # first: build audio/
    python3 tools/make_review.py          # then: build/review.html

Recordings whose filename is not Arabic ("1", "Monday") never reach audio/ —
the written form is unknown until someone listens — so they are transcoded on
the fly here and given a text box instead of a word.
"""
import base64, json, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build_audio as B


def uri(path):
    return "data:audio/mpeg;base64," + base64.b64encode(Path(path).read_bytes()).decode()


def built_lessons(manifest):
    """The lessons already encoded into audio/ by build_audio.py."""
    out = []
    for L in manifest["lessons"]:
        clips = [{"id": Path(c["file"]).stem, "ar": c["ar"], "dur": c["dur"],
                  "src": uri(ROOT / c["file"])} for c in L["clips"]]
        out.append({"id": L["id"], "title": L["title"], "speaker": L["speaker"],
                    "kind": "word", "clips": clips})
    return out


def unlabelled_lesson(tmpdir):
    """Clips the pipeline skips, transcoded here so they can be transcribed."""
    recs, _ = B.index_corpus()
    ffmpeg = B.find_ffmpeg()
    items = []
    for speaker, words in B.by_speaker(recs).items():
        for key, takes in words.items():
            if B.ARABIC.search(key):
                continue
            take = max(takes, key=lambda r: r.size)
            dst = Path(tmpdir) / f"{B.slug(take.word, speaker)}.mp3"
            with tempfile.NamedTemporaryFile(suffix=Path(take.entry).suffix) as raw:
                raw.write(take.read()); raw.flush()
                dur = B.transcode(ffmpeg, raw.name, dst)
            items.append({"id": dst.stem, "label": take.word, "speaker": speaker,
                          "dur": dur, "src": uri(dst)})
    items.sort(key=lambda m: (m["speaker"], m["label"]))
    return items


HTML = r"""<title>Yalla Clip Review</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=Noto+Naskh+Arabic:wght@400;600&display=swap">
<style>
:root{
  --bg:#f4f7f6; --surface:#ffffff; --surface-2:#eef3f2;
  --ink:#14201e; --muted:#5d6f6b; --faint:#8a9b97;
  --line:#dbe4e2; --line-strong:#c3d1ce;
  --accent:#1f6f6b; --accent-soft:#dcecea;
  --good:#2c7a52; --good-soft:#dcefe3;
  --bad:#b0433a; --bad-soft:#f7e0dd;
  --unsure:#a8761f; --unsure-soft:#f6e9d2;
  --shadow:0 1px 2px rgba(20,32,30,.06),0 8px 24px rgba(20,32,30,.06);
}
:root:not([data-theme="light"]){ @media (prefers-color-scheme:dark){
  --bg:#0e1514; --surface:#161f1e; --surface-2:#1c2726;
  --ink:#e4ecea; --muted:#94a7a3; --faint:#6c807c;
  --line:#25302f; --line-strong:#33413f;
  --accent:#54b5ae; --accent-soft:#16302e;
  --good:#5fbd88; --good-soft:#142a1f;
  --bad:#e08078; --bad-soft:#2e1a18;
  --unsure:#d5a54e; --unsure-soft:#2b2213;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25);
}}
:root[data-theme="dark"]{
  --bg:#0e1514; --surface:#161f1e; --surface-2:#1c2726;
  --ink:#e4ecea; --muted:#94a7a3; --faint:#6c807c;
  --line:#25302f; --line-strong:#33413f;
  --accent:#54b5ae; --accent-soft:#16302e;
  --good:#5fbd88; --good-soft:#142a1f;
  --bad:#e08078; --bad-soft:#2e1a18;
  --unsure:#d5a54e; --unsure-soft:#2b2213;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.25);
}
*{box-sizing:border-box}
body{
  background:var(--bg); color:var(--ink); margin:0;
  font-family:"IBM Plex Sans",system-ui,-apple-system,sans-serif;
  font-size:15px; line-height:1.5;
}
.wrap{max-width:940px; margin:0 auto; padding:0 20px 96px}

/* ── header ─────────────────────────────────────────── */
header{
  position:sticky; top:0; z-index:20; background:var(--bg);
  border-bottom:1px solid var(--line); padding:18px 0 12px; margin-bottom:26px;
}
.masthead{display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; margin-bottom:14px}
h1{font-size:19px; font-weight:600; margin:0; letter-spacing:-.01em}
.sub{color:var(--muted); font-size:13px}
.bar{height:5px; background:var(--surface-2); border-radius:3px; overflow:hidden; display:flex}
.bar i{display:block; height:100%; transition:width .25s ease}
.bar .g{background:var(--good)} .bar .u{background:var(--unsure)} .bar .b{background:var(--bad)}
.tally{
  display:flex; gap:18px; align-items:center; margin-top:10px; flex-wrap:wrap;
  font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12.5px;
  font-variant-numeric:tabular-nums; color:var(--muted);
}
.tally b{color:var(--ink); font-weight:500}
.tally .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;vertical-align:baseline}
.spacer{flex:1}
.toggle{
  font:inherit; font-size:12.5px; color:var(--muted); background:var(--surface);
  border:1px solid var(--line-strong); border-radius:6px; padding:4px 10px; cursor:pointer;
}
.toggle[aria-pressed="true"]{background:var(--accent-soft); border-color:var(--accent); color:var(--accent)}
.toggle:focus-visible,.pill:focus-visible,.play:focus-visible,.word input:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px;
}

/* ── lessons ────────────────────────────────────────── */
section{margin-bottom:34px}
.lhead{display:flex; align-items:baseline; gap:10px; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid var(--line)}
.lhead h2{font-size:15px; font-weight:600; margin:0}
.lhead .who{
  font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:11.5px;
  color:var(--faint); letter-spacing:.02em;
}
.lhead .n{margin-left:auto; font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:11.5px; color:var(--faint)}

.rows{display:flex; flex-direction:column; gap:2px}
.row{
  display:grid; grid-template-columns:38px minmax(0,1fr) 52px auto;
  align-items:center; gap:12px; padding:6px 10px; border-radius:7px;
  background:var(--surface); border:1px solid transparent;
}
.row.cursor{border-color:var(--accent); background:var(--accent-soft)}
.row.done{background:var(--surface-2)}
.row.cursor.done{background:var(--accent-soft)}

.play{
  width:32px; height:32px; border-radius:50%; border:1px solid var(--line-strong);
  background:var(--surface); color:var(--accent); cursor:pointer;
  display:grid; place-items:center; padding:0; flex:none;
}
.play:hover{border-color:var(--accent)}
.play.playing{background:var(--accent); color:var(--surface); border-color:var(--accent)}
.play svg{width:12px; height:12px; fill:currentColor}

.word{min-width:0; display:flex; align-items:center; gap:10px}
.ar{
  font-family:"Noto Naskh Arabic",serif; font-size:25px; line-height:1.35;
  direction:rtl; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.label{
  font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:14px;
  color:var(--faint); flex:none; min-width:66px;
}
.word input{
  font-family:"Noto Naskh Arabic",serif; font-size:20px; direction:rtl;
  background:var(--surface); color:var(--ink);
  border:1px solid var(--line-strong); border-radius:6px;
  padding:2px 9px; width:170px;
}
.word input::placeholder{font-family:"IBM Plex Sans",sans-serif; font-size:13px; color:var(--faint)}
.dur{
  font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:11.5px;
  color:var(--faint); font-variant-numeric:tabular-nums; text-align:right;
}
.verdict{display:flex; gap:3px}
.pill{
  font:inherit; font-size:12px; padding:3px 11px; cursor:pointer;
  background:var(--surface); color:var(--muted);
  border:1px solid var(--line-strong);
}
.pill:first-child{border-radius:6px 0 0 6px}
.pill:last-child{border-radius:0 6px 6px 0}
.pill+.pill{margin-left:-1px}
.pill:hover{color:var(--ink)}
.pill[aria-pressed="true"]{font-weight:500; z-index:1; position:relative}
.pill.g[aria-pressed="true"]{background:var(--good-soft); border-color:var(--good); color:var(--good)}
.pill.u[aria-pressed="true"]{background:var(--unsure-soft); border-color:var(--unsure); color:var(--unsure)}
.pill.b[aria-pressed="true"]{background:var(--bad-soft); border-color:var(--bad); color:var(--bad)}

.empty{color:var(--faint); font-size:13px; padding:14px 10px; font-style:italic}

/* ── footer ─────────────────────────────────────────── */
.keys{
  position:fixed; bottom:0; left:0; right:0; background:var(--surface);
  border-top:1px solid var(--line); padding:9px 20px; z-index:20;
  font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:11.5px; color:var(--muted);
  display:flex; gap:20px; justify-content:center; flex-wrap:wrap;
}
kbd{
  font:inherit; background:var(--surface-2); border:1px solid var(--line-strong);
  border-bottom-width:2px; border-radius:4px; padding:1px 6px; color:var(--ink);
}
.credits{
  margin-top:34px; padding-top:16px; border-top:1px solid var(--line);
  font-size:12.5px; color:var(--faint); line-height:1.65;
}
.credits a{color:var(--muted)}
.saving{font-size:11.5px; color:var(--faint); font-family:"IBM Plex Mono",monospace}
@media (max-width:620px){
  .row{grid-template-columns:34px minmax(0,1fr); row-gap:6px}
  .dur{display:none}
  .verdict{grid-column:2}
  .keys{display:none}
  .wrap{padding-bottom:28px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
<header>
  <div class="masthead">
    <h1>Yalla Clip Review</h1>
    <span class="sub" id="sub"></span>
  </div>
  <div class="bar" id="bar"><i class="g"></i><i class="u"></i><i class="b"></i></div>
  <div class="tally">
    <span><span class="dot" style="background:var(--good)"></span>keep <b id="n-good">0</b></span>
    <span><span class="dot" style="background:var(--unsure)"></span>unsure <b id="n-unsure">0</b></span>
    <span><span class="dot" style="background:var(--bad)"></span>drop <b id="n-bad">0</b></span>
    <span class="spacer"></span>
    <span class="saving" id="saving"></span>
    <button class="toggle" id="filter" aria-pressed="false">Unreviewed only</button>
  </div>
</header>
<main id="list"></main>
<div class="credits" id="credits"></div>
</div>
<div class="keys">
  <span><kbd>J</kbd>&nbsp;<kbd>K</kbd> move &amp; play</span>
  <span><kbd>R</kbd> replay</span>
  <span><kbd>1</kbd> keep</span>
  <span><kbd>2</kbd> unsure</span>
  <span><kbd>3</kbd> drop</span>
</div>

<script>
const DATA = __DATA__;
const PLAY = '<svg viewBox="0 0 12 12"><path d="M2 1l8 5-8 5z"/></svg>';
const STOP = '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

const flat = [];
DATA.lessons.forEach(L => L.clips.forEach(c => flat.push({ ...c, lesson: L.id, kind: L.kind })));

let state = {};            // id -> {verdict, word}
let cursor = 0, onlyTodo = false, audio = null, playingId = null, db = null;

/* ── storage: db when the viewer grants it, localStorage otherwise ── */
const LS = "yalla.review.v1";
function localLoad(){ try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } }
function localSave(){ try { localStorage.setItem(LS, JSON.stringify(state)); } catch {} }

function note(msg){ document.getElementById("saving").textContent = msg; }

async function persist(id){
  const rec = state[id];
  localSave();
  if (!db) return;
  try {
    await db.doc("reviews/" + id).set({
      verdict: rec.verdict || "",
      word: rec.word || "",
      lesson: (flat.find(c => c.id === id) || {}).lesson || "",
      at: new Date().toISOString(),
    });
    note("saved");
  } catch (e) {
    note(e && e.code === "resource_exhausted" ? "saving too fast — slowing down" : "saved on this device only");
  }
}

/* ── rendering ── */
function render(){
  const list = document.getElementById("list");
  list.innerHTML = "";
  DATA.lessons.forEach(L => {
    const shown = L.clips.filter(c => !onlyTodo || !(state[c.id] || {}).verdict);
    const sec = document.createElement("section");
    const done = L.clips.filter(c => (state[c.id] || {}).verdict).length;
    sec.innerHTML =
      '<div class="lhead"><h2></h2><span class="who"></span>' +
      '<span class="n">' + done + " / " + L.clips.length + "</span></div>" +
      '<div class="rows"></div>';
    sec.querySelector("h2").textContent = L.title;
    sec.querySelector(".who").textContent = L.speaker;
    const rows = sec.querySelector(".rows");
    if (!shown.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "All reviewed.";
      rows.append(e);
    }
    shown.forEach(c => rows.append(rowFor(c, L)));
    list.append(sec);
  });
  tally();
  markCursor();
}

function rowFor(c, L){
  const rec = state[c.id] || {};
  const row = document.createElement("div");
  row.className = "row" + (rec.verdict ? " done" : "");
  row.dataset.id = c.id;

  const play = document.createElement("button");
  play.className = "play";
  play.innerHTML = playingId === c.id ? STOP : PLAY;
  play.setAttribute("aria-label", "Play " + (c.ar || c.label));
  play.onclick = () => { cursor = flat.findIndex(x => x.id === c.id); markCursor(); toggle(c); };

  const word = document.createElement("div");
  word.className = "word";
  if (L.kind === "transcribe") {
    const lab = document.createElement("span");
    lab.className = "label";
    lab.textContent = c.label;
    const input = document.createElement("input");
    input.value = rec.word || "";
    input.placeholder = "what it says…";
    input.setAttribute("aria-label", "Arabic for " + c.label);
    input.oninput = () => { state[c.id] = { ...(state[c.id] || {}), word: input.value }; };
    input.onchange = () => persist(c.id);
    word.append(lab, input);
  } else {
    const ar = document.createElement("span");
    ar.className = "ar";
    ar.textContent = c.ar;
    word.append(ar);
  }

  const dur = document.createElement("div");
  dur.className = "dur";
  dur.textContent = c.dur ? c.dur.toFixed(2) + "s" : "";

  const v = document.createElement("div");
  v.className = "verdict";
  [["g", "good", "Keep"], ["u", "unsure", "?"], ["b", "bad", "Drop"]].forEach(([cls, val, label]) => {
    const b = document.createElement("button");
    b.className = "pill " + cls;
    b.textContent = label;
    b.setAttribute("aria-pressed", rec.verdict === val ? "true" : "false");
    b.onclick = () => setVerdict(c.id, val);
    v.append(b);
  });

  row.append(play, word, dur, v);
  return row;
}

function tally(){
  const counts = { good: 0, unsure: 0, bad: 0 };
  Object.values(state).forEach(r => { if (r.verdict) counts[r.verdict]++; });
  const total = flat.length, done = counts.good + counts.unsure + counts.bad;
  document.getElementById("n-good").textContent = counts.good;
  document.getElementById("n-unsure").textContent = counts.unsure;
  document.getElementById("n-bad").textContent = counts.bad;
  document.getElementById("sub").textContent =
    done + " of " + total + " reviewed · " + DATA.speakers.length + " speakers";
  const bar = document.getElementById("bar");
  bar.children[0].style.width = (100 * counts.good / total) + "%";
  bar.children[1].style.width = (100 * counts.unsure / total) + "%";
  bar.children[2].style.width = (100 * counts.bad / total) + "%";
}

function setVerdict(id, val){
  const cur = (state[id] || {}).verdict;
  state[id] = { ...(state[id] || {}), verdict: cur === val ? "" : val };
  persist(id);
  const row = document.querySelector('.row[data-id="' + id + '"]');
  if (row) {
    row.classList.toggle("done", !!state[id].verdict);
    row.querySelectorAll(".pill").forEach((b, i) =>
      b.setAttribute("aria-pressed", ["good", "unsure", "bad"][i] === state[id].verdict ? "true" : "false"));
  }
  if (onlyTodo && state[id].verdict) render(); else tally();
  document.querySelectorAll("section").forEach((sec, i) => {
    const L = DATA.lessons[i];
    sec.querySelector(".n").textContent =
      L.clips.filter(c => (state[c.id] || {}).verdict).length + " / " + L.clips.length;
  });
}

/* ── playback ── */
function toggle(c){
  if (playingId === c.id) { stop(); return; }
  stop();
  audio = new Audio(c.src);
  playingId = c.id;
  audio.onended = audio.onerror = stop;
  audio.play().catch(stop);
  paint();
}
function stop(){
  if (audio) { audio.pause(); audio = null; }
  playingId = null;
  paint();
}
function paint(){
  document.querySelectorAll(".row").forEach(r => {
    const b = r.querySelector(".play");
    const on = r.dataset.id === playingId;
    b.classList.toggle("playing", on);
    b.innerHTML = on ? STOP : PLAY;
  });
}

/* ── cursor ── */
function visible(){
  return [...document.querySelectorAll(".row")].map(r => r.dataset.id);
}
function markCursor(){
  const ids = visible();
  if (!ids.length) return;
  const id = flat[cursor] && ids.includes(flat[cursor].id) ? flat[cursor].id : ids[0];
  cursor = flat.findIndex(c => c.id === id);
  document.querySelectorAll(".row").forEach(r => r.classList.toggle("cursor", r.dataset.id === id));
}
function move(step){
  const ids = visible();
  if (!ids.length) return;
  const here = ids.indexOf(flat[cursor] ? flat[cursor].id : "");
  const next = ids[Math.min(ids.length - 1, Math.max(0, (here < 0 ? 0 : here) + step))];
  cursor = flat.findIndex(c => c.id === next);
  markCursor();
  const row = document.querySelector('.row[data-id="' + next + '"]');
  if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
  toggle(flat[cursor]);
}

document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "j" || k === "arrowdown") { e.preventDefault(); move(1); }
  else if (k === "k" || k === "arrowup") { e.preventDefault(); move(-1); }
  else if (k === "r" || k === " ") { e.preventDefault(); if (flat[cursor]) { stop(); toggle(flat[cursor]); } }
  else if (k === "1" || k === "2" || k === "3") {
    if (!flat[cursor]) return;
    e.preventDefault();
    setVerdict(flat[cursor].id, { 1: "good", 2: "unsure", 3: "bad" }[k]);
  }
});

document.getElementById("filter").onclick = e => {
  onlyTodo = !onlyTodo;
  e.currentTarget.setAttribute("aria-pressed", String(onlyTodo));
  render();
};

/* ── credits: CC BY-SA obliges us to name the speakers ── */
document.getElementById("credits").innerHTML =
  "Recordings by " + DATA.speakers.map(s => "<b>" + s + "</b>").join(", ") +
  ' for <a href="https://lingualibre.org/">Lingua Libre</a>, licensed ' +
  '<a href="' + DATA.license.license_url + '">' + DATA.license.license + "</a>. " +
  "Trimmed, level-matched and re-encoded for review. Built " + DATA.generated.slice(0, 10) + ".";

/* ── boot: render immediately, hydrate when the store answers ── */
state = localLoad();
render();
note("saving on this device");

(window.claude ? claude.use("db") : Promise.resolve(null)).then(async d => {
  if (!d) return;
  db = d;
  try {
    const snap = await db.collection("reviews").limit(1000).get();
    snap.docs.forEach(doc => {
      const v = doc.data() || {};
      state[doc.id] = { verdict: v.verdict || "", word: v.word || "" };
    });
    localSave();
    render();
    note("saved to this page");
  } catch {
    note("saving on this device");
  }
});
</script>
"""


def main():
    manifest_path = ROOT / "audio" / "manifest.json"
    if not manifest_path.exists():
        sys.exit("no audio/manifest.json — run tools/build_audio.py first")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    lessons = built_lessons(manifest)

    with tempfile.TemporaryDirectory() as tmp:
        unlab = unlabelled_lesson(tmp)
        if unlab:
            lessons.append({
                "id": "unlabelled",
                "title": "Unlabelled recordings",
                "speaker": " \u00b7 ".join(sorted({m["speaker"] for m in unlab})),
                "kind": "transcribe",
                "clips": [{k: m[k] for k in ("id", "label", "dur", "src")} | {"ar": ""}
                          for m in unlab],
            })

        # Every speaker whose audio this page plays, so the CC-BY-SA credit is complete.
        speakers = sorted({L["speaker"] for L in manifest["lessons"]}
                          | {m["speaker"] for m in unlab})
        data = {"lessons": lessons, "speakers": speakers,
                "generated": manifest["generated"], "license": manifest["source"]}

        out = ROOT / "build" / "review.html"
        out.parent.mkdir(exist_ok=True)
        out.write_text(HTML.replace("__DATA__", json.dumps(data, ensure_ascii=False)),
                       encoding="utf-8")

    total = sum(len(L["clips"]) for L in lessons)
    print(f"{out}  —  {out.stat().st_size/1024/1024:.2f} MB, {total} clips, "
          f"{len(speakers)} speakers")


if __name__ == "__main__":
    main()
