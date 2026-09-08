/* Yalla — Levantine Arabic learner. Vanilla JS, no build step. */
"use strict";

// ————————————————————— State —————————————————————

const STORE_KEY = "yalla.progress.v1";
const SETTINGS_KEY = "yalla.settings.v1";

// Leitner boxes → review interval in days. Box 0 = new/again.
const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const DAY_MS = 24 * 60 * 60 * 1000;

let progress = load(STORE_KEY, {});          // { [wordId]: {box, due} }
let settings = load(SETTINGS_KEY, { newPerDay: 8, translit: true });

function load(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") }; }
  catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

function todayKey() { return new Date().toISOString().slice(0, 10); }

function dueWords() {
  const now = Date.now();
  return VOCAB.filter(w => progress[w.id] && progress[w.id].due <= now);
}
// Words with a recording come first. A recording is the only audio the app
// has, so a word without one is taught silently — that is worth postponing,
// but not worth dropping the word over.
function newWords(limit) {
  const fresh = VOCAB.filter(w => !progress[w.id]);
  const spoken = fresh.filter(hasClip);
  return spoken.concat(fresh.filter(w => !hasClip(w))).slice(0, limit);
}
// New words already introduced today still count against the daily budget.
function introducedToday() {
  return Object.values(progress).filter(p => p.introduced === todayKey()).length;
}
// Spread new words evenly through the reviews instead of queuing all due
// reviews first: an unbounded review backlog would otherwise crowd new
// words out of every session that doesn't clear it, and learning stalls.
function interleave(due, fresh) {
  if (!due.length) return fresh.slice();
  if (!fresh.length) return due.slice();
  const out = [];
  const step = fresh.length / due.length;
  let acc = 0, fi = 0;
  for (const w of due) {
    out.push(w);
    acc += step;
    while (acc >= 1 && fi < fresh.length) { out.push(fresh[fi++]); acc -= 1; }
  }
  while (fi < fresh.length) out.push(fresh[fi++]);
  return out;
}

// ————————————————————— Recordings —————————————————————

// Word audio ships with the app: tools/build_audio.py picks one recording per
// word from the Lingua Libre corpus, levels it and writes audio/manifest.json.
// Nothing is searched for at play time, so every learner hears the same clip
// and hears it immediately — the old live Commons lookup gave neither.
let clips = new Map();          // normAr(word) -> { file, speaker }
let credits = [];               // speakers to name, per CC BY-SA
let manifestFailed = false;
const clipsReady = fetch("audio/manifest.json")
  .then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then(m => {
    for (const lesson of m.lessons || [])
      for (const c of lesson.clips || [])
        clips.set(normAr(c.ar), { file: c.file, speaker: c.speaker });
    credits = [...new Set([...clips.values()].map(c => c.speaker))].sort();
    renderCredits();
  })
  .catch(() => { manifestFailed = true; });

function clipFor(word) { return clips.get(normAr(word.ar)); }
function hasClip(word) { return clips.has(normAr(word.ar)); }

// ————————————————————— Synthetic lines —————————————————————

// Sentences are the one thing recordings can't cover: Lingua Libre is a
// word-at-a-time corpus, so the dialogues had no audio at all. They are
// synthesised instead — by a model trained on Levantine, not the browser's
// Modern Standard voice that this app threw out — and generated at build time
// by tools/synth_lines.py, listened to, and committed like any other clip.
//
// Words are deliberately NOT synthesised. A model reading a bare citation form
// is where it drifts on stress and vowel length, and that is precisely what a
// flashcard would drill in. A word is a real recording or it is silent.
let synthLines = new Map();     // textId -> [{ i, ar, file, dur, voice }]
let synthEngine = null;         // which model spoke them, for the credit
const synthReady = fetch("audio/synth-manifest.json")
  .then(r => r.ok ? r.json() : Promise.reject(r.status))
  .then(m => {
    for (const [id, lines] of Object.entries(m.texts || {})) synthLines.set(id, lines);
    synthEngine = m.engine || null;
  })
  // Optional by design: no manifest simply means nobody has run the synthesis
  // yet, and the texts stay the reading exercise they were.
  .catch(() => { synthLines = new Map(); });

// A clip is keyed by position but validated against the words it was generated
// from, so editing a line in data.js retires its audio instead of leaving the
// old sentence playing under the new text.
function synthFor(text, i) {
  const clip = (synthLines.get(text.id) || []).find(c => c.i === i);
  return clip && normAr(clip.ar) === normAr(text.lines[i].ar) ? clip : null;
}
function hasSynth(text) {
  return text.lines.some((_, i) => synthFor(text, i));
}

function renderCredits() {
  const el = document.getElementById("credits");
  if (!el || !credits.length) return;
  el.innerHTML =
    `<h3>Recordings</h3><p class="muted">Every word this app speaks is a native ` +
    `South Levantine speaker: ` +
    credits.map(c => `<b>${esc(c)}</b>`).join(", ") +
    `, recorded for <a href="https://lingualibre.org/" target="_blank" rel="noopener">Lingua Libre</a> ` +
    `and used under <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" ` +
    `rel="noopener">CC BY-SA 4.0</a>. ${clips.size} of ${VOCAB.length} words are covered; ` +
    `the rest are shown without audio rather than spoken by a machine.</p>` +
    (synthEngine ? synthCredit() : "");
}

// Named, not buried. A learner deciding how much to trust what they just heard
// needs to know whether it came from a person, and which model it came from if
// it didn't.
function synthCredit() {
  const link = synthEngine.license_url
    ? `<a href="${esc(synthEngine.license_url)}" target="_blank" rel="noopener">${esc(synthEngine.model)}</a>`
    : `<b>${esc(synthEngine.model)}</b>`;
  return `<h3>Synthetic voices</h3><p class="muted">The dialogue lines under ` +
    `<b>Texts</b> have no recording — no word-at-a-time corpus can supply a whole ` +
    `sentence — so they are spoken by ${link}, a text-to-speech model trained on ` +
    `Arabic dialects rather than Modern Standard` +
    (synthEngine.dialect ? ` (${esc(synthEngine.dialect)})` : "") +
    `. They are marked <span class="synth-dot">◈</span> wherever they play. Individual ` +
    `words are never synthesised: those are recordings or silence.` +
    (synthEngine.license ? ` Model licence: ${esc(synthEngine.license)}.` : "") + `</p>`;
}

let currentAudio = null;

// play() resolving only means playback was allowed to begin — a 404, a codec
// the browser can't decode, or a stalled download all resolve and then go
// quiet. Wait for an actual `playing` event before trusting the recording.
function tryPlayRecording(url) {
  return new Promise(resolve => {
    const audio = new Audio(url);
    currentAudio = audio;
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      if (!ok && currentAudio === audio) currentAudio = null;
      resolve(ok ? audio : null);
    };
    audio.onplaying = () => finish(true);
    audio.onerror = () => finish(false);
    setTimeout(() => finish(false), 3000);
    audio.play().catch(() => finish(false));
  });
}

// A word is played from its recording or not at all. The browser's own speech
// synthesis used to cover the gap and it made the app worse: MSA-trained voices
// read the dialect with classical endings and a qaf nobody says here, teaching
// a pronunciation the learner then has to unlearn. Silence is the honest answer
// for a word; a dialect-trained model reading a whole sentence is a different
// question, and one the Texts tab answers below.
async function playWord(word, btn) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  const clip = clipFor(word);
  if (!clip) return;
  if (btn) btn.classList.add("playing");
  const done = () => btn && btn.classList.remove("playing");
  const audio = await tryPlayRecording(clip.file);
  if (audio) audio.onended = audio.onerror = done;
  else done();  // 404 or an undecodable file: nothing to fall back to
}

// Plays a clip and resolves when it stops, so lines can be chained into a
// whole-dialogue playthrough.
async function playClip(file, btn) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (btn) btn.classList.add("playing");
  const audio = await tryPlayRecording(file);
  return new Promise(resolve => {
    const done = () => { if (btn) btn.classList.remove("playing"); resolve(); };
    if (audio) audio.onended = audio.onerror = done;
    else done();
  });
}

function stopAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  document.querySelectorAll(".btn.playing").forEach(b => b.classList.remove("playing"));
}

// ————————————————————— Wiktionary —————————————————————

const modal = document.getElementById("modal");
const modalBody = document.getElementById("modal-body");
const modalTitle = document.getElementById("modal-title");
const modalLink = document.getElementById("modal-link");

async function openWiktionary(word) {
  const page = word.wik || word.ar.replace(/[؟!،.]/g, "").trim();
  modalTitle.textContent = word.ar;
  modalLink.href = "https://en.wiktionary.org/wiki/" + encodeURIComponent(page);
  modalBody.innerHTML = "<p class='muted'>Loading from Wiktionary…</p>";
  modal.classList.remove("hidden");
  try {
    const res = await fetch(
      "https://en.wiktionary.org/api/rest_v1/page/definition/" +
      encodeURIComponent(page) + "?redirect=true"
    );
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    // Prefer Levantine sections, fall back to Arabic, then anything.
    const sections = [];
    for (const key of Object.keys(data)) {
      for (const sec of data[key]) {
        const lang = sec.language || "";
        const prio = /Levantine/i.test(lang) ? 0 : /^Arabic$/i.test(lang) ? 1 : 2;
        sections.push({ prio, sec });
      }
    }
    sections.sort((a, b) => a.prio - b.prio);
    if (!sections.length) throw new Error("empty");
    modalBody.innerHTML = sections.slice(0, 3).map(({ sec }) => `
      <div class="wik-section">
        <h4>${esc(sec.language)} · ${esc(sec.partOfSpeech || "")}</h4>
        <ol>${(sec.definitions || []).slice(0, 4)
          .map(d => `<li>${sanitize(d.definition)}</li>`).join("")}</ol>
      </div>`).join("");
  } catch {
    modalBody.innerHTML =
      "<p class='muted'>No entry found via the API — try the Wiktionary link below.</p>";
  }
}
document.getElementById("modal-close").onclick = () => modal.classList.add("hidden");
modal.onclick = e => { if (e.target === modal) modal.classList.add("hidden"); };

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Wiktionary definitions arrive as HTML; keep text and strip tags/links.
function sanitize(html) {
  const div = document.createElement("div");
  div.innerHTML = html || "";
  return esc(div.textContent || "");
}

// ————————————————————— Tabs —————————————————————

document.getElementById("tabs").addEventListener("click", e => {
  const btn = e.target.closest(".tab");
  if (!btn) return;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === btn));
  document.querySelectorAll(".view").forEach(v =>
    v.classList.toggle("active", v.id === "view-" + btn.dataset.tab));
  // A dialogue playing on into another tab is nobody's intention.
  stopPlayAll();
  if (btn.dataset.tab === "today") renderToday();
});

// ————————————————————— Today / flashcard session —————————————————————

const todaySummary = document.getElementById("today-summary");
const sessionEl = document.getElementById("session");

function renderToday() {
  sessionEl.classList.add("hidden");
  todaySummary.classList.remove("hidden");
  const due = dueWords();
  const budget = Math.max(0, settings.newPerDay - introducedToday());
  const fresh = newWords(budget);
  const learned = Object.keys(progress).length;
  const pct = Math.round(100 * learned / VOCAB.length);
  todaySummary.innerHTML = `
    <div class="card hero">
      <div class="hero-ar" dir="rtl">يلا نتعلم!</div>
      <p class="muted">Let's learn — your daily Levantine session.</p>
      <div class="stats">
        <div class="stat"><b>${fresh.length}</b><span>new words</span></div>
        <div class="stat"><b>${due.length}</b><span>reviews due</span></div>
        <div class="stat"><b>${learned}/${VOCAB.length}</b><span>words started</span></div>
      </div>
      <div class="progressbar"><div style="width:${pct}%"></div></div>
      ${fresh.length + due.length
        ? `<button class="btn primary big" id="btn-start">Start session</button>`
        : `<p class="done-msg">كل شي خلص لليوم — all done for today! 🎉<br>
           <span class="muted">Come back tomorrow, or browse Words and Texts.</span></p>`}
    </div>`;
  const start = document.getElementById("btn-start");
  if (start) start.onclick = () => startSession(interleave(due, fresh));
}

let queue = [], sessionTotal = 0;

function startSession(words) {
  queue = words.slice();
  sessionTotal = queue.length;
  todaySummary.classList.add("hidden");
  sessionEl.classList.remove("hidden");
  nextCard();
}

function nextCard() {
  if (!queue.length) { endSession(); return; }
  const word = queue[0];
  const isNew = !progress[word.id];
  const doneCount = sessionTotal - queue.length;
  sessionEl.innerHTML = `
    <div class="session-top">
      <div class="progressbar slim"><div style="width:${Math.round(100 * doneCount / sessionTotal)}%"></div></div>
      <span class="muted">${doneCount}/${sessionTotal}</span>
      <button class="btn ghost" id="btn-quit">End</button>
    </div>
    <div class="card flashcard" id="flashcard">
      ${isNew ? '<span class="badge">new word</span>' : '<span class="badge review">review</span>'}
      <div class="fc-ar" dir="rtl">${esc(word.ar)}</div>
      ${hasClip(word)
        ? `<button class="btn audio" id="fc-audio" title="Listen">🔊</button>`
        : `<div class="no-clip" title="No native recording for this word yet">no recording</div>`}
      <div class="fc-answer hidden" id="fc-answer">
        ${settings.translit ? `<div class="fc-tr">${esc(word.tr)}</div>` : ""}
        <div class="fc-en">${esc(word.en)}</div>
        <button class="btn ghost small" id="fc-wik">Wiktionary</button>
      </div>
      <button class="btn primary" id="fc-reveal">Show answer</button>
      <div class="grade hidden" id="fc-grade">
        <button class="btn grade-again">Again</button>
        <button class="btn grade-good">Good</button>
        <button class="btn grade-easy">Easy</button>
      </div>
    </div>`;
  document.getElementById("btn-quit").onclick = renderToday;
  const fcAudio = document.getElementById("fc-audio");
  if (fcAudio) fcAudio.onclick = e => playWord(word, e.currentTarget);
  document.getElementById("fc-wik").onclick = () => openWiktionary(word);
  document.getElementById("fc-reveal").onclick = () => {
    document.getElementById("fc-answer").classList.remove("hidden");
    document.getElementById("fc-grade").classList.remove("hidden");
    document.getElementById("fc-reveal").classList.add("hidden");
  };
  // Auto-play the word when the card appears (new words especially).
  if (fcAudio) playWord(word, fcAudio);
  sessionEl.querySelector(".grade-again").onclick = () => grade(word, 0);
  sessionEl.querySelector(".grade-good").onclick = () => grade(word, 1);
  sessionEl.querySelector(".grade-easy").onclick = () => grade(word, 2);
}

function grade(word, quality) {
  const p = progress[word.id] || { box: 0, introduced: todayKey() };
  queue.shift();
  if (quality === 0) {
    p.box = 1;
    p.due = Date.now(); // seen again later this session
    queue.push(word);   // re-queue at the end
  } else {
    p.box = Math.min(INTERVALS.length - 1, (p.box || 0) + quality);
    p.due = Date.now() + INTERVALS[p.box] * DAY_MS;
  }
  progress[word.id] = p;
  save(STORE_KEY, progress);
  nextCard();
}

function endSession() {
  sessionEl.innerHTML = `
    <div class="card hero">
      <div class="hero-ar" dir="rtl">يعطيك العافية!</div>
      <p>Session finished — ${sessionTotal} card${sessionTotal === 1 ? "" : "s"} done.</p>
      <button class="btn primary" id="btn-back">Back</button>
    </div>`;
  document.getElementById("btn-back").onclick = renderToday;
}

// ————————————————————— Words browser —————————————————————

const wordList = document.getElementById("word-list");
const wordSearch = document.getElementById("word-search");
const catFilter = document.getElementById("cat-filter");

function initWordsTab() {
  const cats = [...new Set(VOCAB.map(w => w.cat))];
  catFilter.innerHTML = `<option value="">All categories</option>` +
    cats.map(c => `<option>${esc(c)}</option>`).join("");
  wordSearch.oninput = renderWords;
  catFilter.onchange = renderWords;
  renderWords();
}

function renderWords() {
  const q = wordSearch.value.trim().toLowerCase();
  const cat = catFilter.value;
  const rows = VOCAB.filter(w =>
    (!cat || w.cat === cat) &&
    (!q || w.ar.includes(q) || w.tr.toLowerCase().includes(q) || w.en.toLowerCase().includes(q)));
  let lastCat = null, html = "";
  for (const w of rows) {
    if (w.cat !== lastCat) { html += `<h3 class="cat-head">${esc(w.cat)}</h3>`; lastCat = w.cat; }
    const p = progress[w.id];
    html += `
      <div class="word-row" data-id="${w.id}">
        ${hasClip(w)
          ? `<button class="btn audio small" data-act="audio" title="Listen">🔊</button>`
          : `<span class="btn audio small silent" title="No native recording for this word yet">·</span>`}
        <div class="word-main">
          <span class="w-ar" dir="rtl">${esc(w.ar)}</span>
          ${settings.translit ? `<span class="w-tr">${esc(w.tr)}</span>` : ""}
          <span class="w-en">${esc(w.en)}</span>
        </div>
        <span class="w-box" title="spaced-repetition level">${p ? "●".repeat(Math.min(p.box, 5)) : ""}</span>
        <button class="btn ghost small" data-act="wik" title="Wiktionary">📖</button>
      </div>`;
  }
  wordList.innerHTML = html || "<p class='muted'>No matches.</p>";
}

wordList.addEventListener("click", e => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const word = VOCAB[+btn.closest(".word-row").dataset.id];
  if (btn.dataset.act === "audio") playWord(word, btn);
  else openWiktionary(word);
});

// ————————————————————— Texts (listening practice) —————————————————————

const textList = document.getElementById("text-list");
const textView = document.getElementById("text-view");

function renderTextList() {
  textView.classList.add("hidden");
  textList.classList.remove("hidden");
  textList.innerHTML = TEXTS.map(t => `
    <button class="card text-card" data-id="${t.id}">
      <span class="text-level">${t.level}</span>
      <span class="text-title-ar" dir="rtl">${esc(t.titleAr)}</span>
      <span class="text-title-en">${esc(t.title)} · ${t.lines.length} lines${
        hasSynth(t) ? ` · <span class="synth-dot" title="Synthetic voices">◈</span> audio` : ""}</span>
    </button>`).join("");
  textList.querySelectorAll(".text-card").forEach(c =>
    c.onclick = () => openText(TEXTS.find(t => t.id === c.dataset.id)));
}

let playingAll = false;

// A text is a listening drill when it has audio and a reading exercise when it
// doesn't — the same view either way, so a half-synthesised corpus doesn't need
// two code paths. Its audio is always synthetic (no recording covers a whole
// sentence), which is why every play control here carries the ◈ mark: a learner
// should never have to guess whether they just heard a person.
function openText(text) {
  textList.classList.add("hidden");
  textView.classList.remove("hidden");
  playingAll = false;
  const spoken = hasSynth(text);
  textView.innerHTML = `
    <div class="text-head">
      <button class="btn ghost" id="btn-texts-back">← Texts</button>
      <h2 dir="rtl">${esc(text.titleAr)}</h2>
      <span class="text-level">${text.level}</span>
    </div>
    <div class="text-toolbar">
      ${spoken ? `<button class="btn primary synthetic" id="btn-playall">▶ Play all</button>
      <label class="toggle"><input type="checkbox" id="chk-listening" checked> Listening mode (hide text)</label>` : ""}
      <label class="toggle"><input type="checkbox" id="chk-trans"> Show translation</label>
    </div>
    ${spoken ? `<p class="muted listen-hint" id="listen-hint">
      🎧 Listen first. Tap ▶ on a line to hear it, tap the blurred line to reveal it.
    </p>
    <p class="synth-note">
      <span class="synth-dot">◈</span> These lines are read by
      ${synthEngine ? esc(synthEngine.model) : "a text-to-speech model"}, not by a
      native speaker. Trust the word recordings over them for pronunciation.
    </p>` : `<p class="muted listen-hint">
      Read the Arabic first, then tap a line for the English.
    </p>`}
    <div class="lines" id="lines">
      ${text.lines.map((l, i) => {
        const clip = synthFor(text, i);
        return `
        <div class="line" data-i="${i}">
          ${clip ? `<button class="btn audio small line-play synthetic" title="Play line (synthetic voice)">▶</button>` : ""}
          <div class="line-body">
            <div class="line-ar${spoken ? " veiled" : ""}" dir="rtl">
              ${l.sp ? `<span class="line-sp">${esc(l.sp)}:</span> ` : ""}${esc(l.ar)}
            </div>
            <div class="line-en hidden">${esc(l.en)}</div>
          </div>
        </div>`;
      }).join("")}
    </div>`;

  document.getElementById("btn-texts-back").onclick = () => { stopPlayAll(); renderTextList(); };

  const linesEl = document.getElementById("lines");
  const chkTrans = document.getElementById("chk-trans");
  const chkListening = document.getElementById("chk-listening");

  function applyModes() {
    const veil = chkListening && chkListening.checked;
    linesEl.querySelectorAll(".line-ar").forEach(el =>
      el.classList.toggle("veiled", veil && !el.classList.contains("revealed")));
    linesEl.querySelectorAll(".line-en").forEach(el =>
      el.classList.toggle("hidden", !chkTrans.checked));
    const hint = document.getElementById("listen-hint");
    if (hint && chkListening) hint.classList.toggle("hidden", !veil);
  }
  chkTrans.onchange = applyModes;
  if (chkListening) chkListening.onchange = () => {
    // Re-veil everything when listening mode is switched back on, so the
    // exercise resets rather than resuming with half the text already given up.
    linesEl.querySelectorAll(".line-ar").forEach(el => el.classList.remove("revealed"));
    applyModes();
  };

  function highlight(i) {
    linesEl.querySelectorAll(".line").forEach((el, j) =>
      el.classList.toggle("current", j === i));
  }

  linesEl.addEventListener("click", e => {
    const line = e.target.closest(".line");
    if (!line) return;
    const i = +line.dataset.i;
    if (e.target.closest(".line-play")) {
      stopPlayAll();
      highlight(i);
      const clip = synthFor(text, i);
      if (clip) playClip(clip.file, e.target.closest(".line-play"));
      return;
    }
    // Tapping the line itself reveals it: the Arabic when it's veiled, and the
    // translation either way.
    const arEl = line.querySelector(".line-ar");
    arEl.classList.add("revealed");
    arEl.classList.remove("veiled");
    line.querySelector(".line-en").classList.remove("hidden");
  });

  const playAll = document.getElementById("btn-playall");
  if (playAll) playAll.onclick = async function () {
    if (playingAll) { stopPlayAll(); return; }
    playingAll = true;
    this.textContent = "⏸ Stop";
    for (let i = 0; i < text.lines.length && playingAll; i++) {
      const clip = synthFor(text, i);
      if (!clip) continue;
      highlight(i);
      await playClip(clip.file, null);
      if (playingAll) await new Promise(r => setTimeout(r, 700));
    }
    if (playingAll) { playingAll = false; highlight(-1); }
    this.textContent = "▶ Play all";
  };

  applyModes();
}

function stopPlayAll() {
  playingAll = false;
  stopAudio();
  const btn = document.getElementById("btn-playall");
  if (btn) btn.textContent = "▶ Play all";
  document.querySelectorAll(".line.current").forEach(el => el.classList.remove("current"));
}

// ————————————————————— Settings —————————————————————

function initSettings() {
  const perDay = document.getElementById("set-newperday");
  const translit = document.getElementById("set-translit");
  perDay.value = String(settings.newPerDay);
  translit.checked = settings.translit;

  perDay.onchange = () => { settings.newPerDay = +perDay.value; save(SETTINGS_KEY, settings); renderToday(); };
  translit.onchange = () => { settings.translit = translit.checked; save(SETTINGS_KEY, settings); renderWords(); };

  document.getElementById("btn-reset").onclick = () => {
    if (confirm("Reset all learning progress? This cannot be undone.")) {
      progress = {};
      save(STORE_KEY, progress);
      renderToday();
      renderWords();
    }
  };
}

// ————————————————————— Boot —————————————————————

// Every view asks which words have a recording, and the text list asks which
// dialogues have audio, so wait for both manifests rather than render a silent
// app and correct it a moment later. The synthetic one is optional: it settles
// either way, and its absence just means the texts are a reading exercise.
Promise.all([clipsReady, synthReady]).then(() => {
  // Again, now both manifests are in: the word manifest renders the credits as
  // soon as it lands, and whether the synthetic voices got named there depended
  // on which fetch happened to finish first.
  renderCredits();
  if (manifestFailed) {
    document.getElementById("main").insertAdjacentHTML("afterbegin",
      `<p class="voice-hint warn">Word recordings failed to load, so the app has no audio. ` +
      `Check your connection and reload.</p>`);
  }
  initWordsTab();
  renderTextList();
  initSettings();
  renderToday();
});
