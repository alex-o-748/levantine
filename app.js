/* Yalla — Levantine Arabic learner. Vanilla JS, no build step. */
"use strict";

// ————————————————————— State —————————————————————

const STORE_KEY = "yalla.progress.v1";
const SETTINGS_KEY = "yalla.settings.v1";

// Leitner boxes → review interval in days. Box 0 = new/again.
const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const DAY_MS = 24 * 60 * 60 * 1000;

const HISTORY_KEY = "yalla.history.v1";

let progress = load(STORE_KEY, {});          // { [wordId]: {box, due} }
let settings = load(SETTINGS_KEY, { newPerDay: 8, translit: true });
// What each day's sessions got through: { [day]: {reviewed, recalled, learned, knew} }.
// It is what lets a session end on "here's what today added up to" and the
// Today tab show a streak, rather than one undifferentiated stream of cards.
let history = load(HISTORY_KEY, {});

function load(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") }; }
  catch { return fallback; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// The learner's own calendar day, not UTC's: a streak that breaks because an
// evening session landed on the next UTC date is no streak at all.
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayKey() { return dayKey(); }

function dueWords() {
  const now = Date.now();
  return VOCAB.filter(w => progress[w.id] && progress[w.id].due <= now);
}
// Words with a recording come first. A recording is the only audio the app
// has, so a word without one is taught silently — that is worth postponing,
// but not worth dropping the word over.
function newWords(limit, exclude = []) {
  const fresh = VOCAB.filter(w => !progress[w.id] && !exclude.includes(w));
  const spoken = fresh.filter(hasClip);
  return spoken.concat(fresh.filter(w => !hasClip(w))).slice(0, limit);
}
// New words already introduced today still count against the daily budget —
// except ones the learner already knew (Easy on first sight): those were never
// really taught, and letting them eat the budget left the learner stuck on the
// same handful of words with nothing new to move on to.
function introducedToday() {
  return Object.values(progress).filter(p => p.introduced === todayKey() && !p.known).length;
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

// A day's work comes in two parts with an end: first the words that are due
// again, then today's new ones. The session used to deal both from a single
// pile, so it never said which kind of card you were on or how far through
// either you were — and a pile that refilled itself felt like it never ended.

const EMPTY_LOG = { reviewed: 0, recalled: 0, learned: 0, knew: 0 };
function logFor(day = todayKey()) { return { ...EMPTY_LOG, ...history[day] }; }
function bump(field) {
  const day = todayKey();
  history[day] = logFor(day);
  history[day][field]++;
  save(HISTORY_KEY, history);
}
function activeOn(day) {
  const h = logFor(day);
  return h.reviewed + h.learned + h.knew > 0;
}
// Consecutive days with a session. Today only counts once it has one, but not
// having practised yet this morning doesn't break yesterday's run.
function streak() {
  const d = new Date();
  if (!activeOn(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (activeOn(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// Progress written before there was a history still says which day each word
// was introduced, so a returning learner keeps the days they already put in.
if (localStorage.getItem(HISTORY_KEY) === null) {
  for (const p of Object.values(progress)) {
    if (!p.introduced) continue;
    history[p.introduced] = logFor(p.introduced);
    history[p.introduced][p.known ? "knew" : "learned"]++;
  }
  save(HISTORY_KEY, history);
}

// How far apart a word's reviews have grown says how well it has stuck.
const STAGES = [
  { key: "mastered", label: "Mastered", minBox: 5 },  // a month or more between reviews
  { key: "familiar", label: "Familiar", minBox: 3 },  // a week or two
  { key: "learning", label: "Learning", minBox: 0 },  // still coming back within days
];
function stageOf(p) { return STAGES.find(s => (p.box || 0) >= s.minBox).key; }
function stageCounts() {
  const counts = { mastered: 0, familiar: 0, learning: 0, unseen: 0 };
  for (const w of VOCAB) counts[progress[w.id] ? stageOf(progress[w.id]) : "unseen"]++;
  return counts;
}

function learnedTodayWords() {
  const day = todayKey();
  return VOCAB.filter(w => progress[w.id] && progress[w.id].introduced === day && !progress[w.id].known);
}

// What tomorrow holds, so finishing today ends on something to come back to.
function tomorrowForecast() {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 2);  // midnight at the end of tomorrow
  const reviews = Object.values(progress).filter(p => p.due < end.getTime()).length;
  const fresh = Math.min(settings.newPerDay, VOCAB.filter(w => !progress[w.id]).length);
  return { reviews, fresh };
}

function plural(n, one, many = one + "s") { return `${n} ${n === 1 ? one : many}`; }

function chips(words) {
  return `<div class="chips" dir="rtl">${words.map(w =>
    `<span class="chip" title="${esc(w.en)}">${esc(w.ar)}</span>`).join("")}</div>`;
}

function planStep(n, title, state, detail, extra = "") {
  return `
    <li class="plan-step ${state}">
      <span class="plan-mark">${state === "done" ? "✓" : n}</span>
      <div class="plan-body">
        <b>${title}</b>
        <span class="muted">${detail}</span>
        ${extra}
      </div>
    </li>`;
}

function renderToday() {
  sessionEl.classList.add("hidden");
  todaySummary.classList.remove("hidden");
  const due = dueWords();
  const budget = Math.max(0, settings.newPerDay - introducedToday());
  const fresh = newWords(budget);
  const log = logFor();
  const done = !due.length && !fresh.length;
  const started = log.reviewed + log.learned + log.knew > 0;

  const reviewStep = due.length
    ? planStep(1, "Review", "todo",
        `${plural(due.length, "word")} you've seen before` + (log.reviewed ? ` · ${log.reviewed} done` : ""))
    : planStep(1, "Review", "done",
        log.reviewed ? `${plural(log.reviewed, "word")} reviewed` : "Nothing due today");

  const learnedToday = learnedTodayWords();
  const unseenLeft = newWords(1).length;
  const newStep = fresh.length
    ? planStep(2, "New words", "todo",
        `${plural(fresh.length, "new word")} for today` + (learnedToday.length ? ` · ${learnedToday.length} done` : ""),
        chips(fresh))
    : planStep(2, "New words", "done",
        learnedToday.length ? `${plural(learnedToday.length, "new word")} learned`
          : unseenLeft ? "None today" : "You've started every word 🎉",
        learnedToday.length ? chips(learnedToday) : "");

  const t = tomorrowForecast();
  todaySummary.innerHTML = `
    <div class="card hero">
      ${done
        ? `<div class="big-check">✓</div>
           <div class="hero-ar" dir="rtl">كل شي خلص لليوم</div>
           <p class="muted">That's everything for today.</p>`
        : `<div class="hero-ar" dir="rtl">يلا نتعلم!</div>
           <p class="muted">Let's learn — today's session has two parts.</p>`}
      <ol class="plan">${reviewStep}${newStep}</ol>
      ${done
        ? `<p class="tomorrow">Tomorrow: ${plural(t.reviews, "review")}${
             t.fresh ? ` + ${plural(t.fresh, "new word")}` : ""}.</p>
           ${unseenLeft
             ? `<button class="btn ghost" id="btn-more">Extra: learn ${settings.newPerDay} more words</button>`
             : ""}`
        : `<button class="btn primary big" id="btn-start">${started ? "Continue" : "Start"} — ${
             due.length ? "review" : "new words"}</button>`}
    </div>
    ${progressCard()}`;
  const start = document.getElementById("btn-start");
  if (start) start.onclick = () => startSession(due, fresh);
  const more = document.getElementById("btn-more");
  if (more) more.onclick = () => startSession([], newWords(settings.newPerDay));
}

function progressCard() {
  const s = streak();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(`<span class="day${activeOn(dayKey(d)) ? " on" : ""}${i === 0 ? " today" : ""}" title="${dayKey(d)}">
      <i></i>${d.toLocaleDateString("en", { weekday: "narrow" })}</span>`);
  }
  const c = stageCounts();
  const seg = key => c[key]
    ? `<div class="seg ${key}" style="flex:${c[key]}" title="${c[key]} ${key}"></div>` : "";
  const legend = [...STAGES.map(st => [st.key, st.label]), ["unseen", "Not started"]]
    .map(([key, label]) => `<span><i class="sw ${key}"></i>${label} <b>${c[key]}</b></span>`).join("");
  return `
    <div class="card progress-card">
      <div class="pc-head">
        <b>Your progress</b>
        <span class="streak">${s ? `🔥 ${plural(s, "day")} in a row` : "Start a streak today"}</span>
      </div>
      <div class="week">${days.join("")}</div>
      <div class="stagebar">${seg("mastered")}${seg("familiar")}${seg("learning")}${seg("unseen")}</div>
      <div class="legend">${legend}</div>
    </div>`;
}

// The session runs as phases — reviews, then new words — each with its own
// count, so "3 of 8" means three of today's eight new words, not three cards
// of some total that grows as you go.
let phases = [], phaseIx = 0, stats = null;

const PHASE_LABEL = { review: "Review", new: "New words" };

function startSession(due, fresh) {
  // Counts are the day's, not this sitting's: coming back to a session you
  // left after three of eight new words picks up at 3/8, not 0/5.
  const log = logFor();
  const learned = learnedTodayWords().length;
  phases = [];
  if (due.length) phases.push({ kind: "review", queue: due.slice(), total: log.reviewed + due.length, done: log.reviewed });
  if (fresh.length) phases.push({ kind: "new", queue: fresh.slice(), total: learned + fresh.length, done: learned });
  phaseIx = 0;
  stats = { reviewed: 0, recalled: 0, learned: [], knew: [], missed: new Set() };
  todaySummary.classList.add("hidden");
  sessionEl.classList.remove("hidden");
  nextCard();
}

function sessionSteps() {
  return `<div class="steps">${phases.map((ph, i) => `
    <span class="step${i < phaseIx ? " done" : i === phaseIx ? " current" : ""}">
      ${i < phaseIx ? "✓ " : ""}${PHASE_LABEL[ph.kind]} ${ph.done}/${ph.total}
    </span>`).join("")}</div>`;
}

function nextCard() {
  const phase = phases[phaseIx];
  if (!phase.queue.length) {
    phaseIx++;
    if (phaseIx < phases.length) phaseBreak(); else endSession();
    return;
  }
  const word = phase.queue[0];
  const isNew = !progress[word.id];
  const badge = stats.missed.has(word.id) ? '<span class="badge again">again</span>'
    : isNew ? '<span class="badge">new word</span>'
    : '<span class="badge review">review</span>';
  sessionEl.innerHTML = `
    <div class="session-top">
      ${sessionSteps()}
      <button class="btn ghost" id="btn-quit">End</button>
    </div>
    <div class="progressbar slim"><div style="width:${Math.round(100 * phase.done / phase.total)}%"></div></div>
    <div class="card flashcard" id="flashcard">
      ${badge}
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
        <button class="btn grade-easy">${isNew ? "Knew it" : "Easy"}</button>
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

// A word already known on first sight skips straight to a two-week interval.
const KNOWN_BOX = 4;

function grade(word, quality) {
  const phase = phases[phaseIx];
  const isNew = !progress[word.id];
  const p = progress[word.id] || { box: 0, introduced: todayKey() };
  phase.queue.shift();
  if (isNew && quality === 2) {
    // Already known: it was never really taught, so it doesn't count toward
    // today's new words — the next unseen word takes its slot and the target
    // stays where it was.
    p.known = true;
    p.box = KNOWN_BOX;
    p.due = Date.now() + INTERVALS[p.box] * DAY_MS;
    stats.knew.push(word);
    bump("knew");
    const next = newWords(1, [word, ...phase.queue]);
    if (next.length) phase.queue.push(next[0]); else phase.total--;
  } else if (quality === 0) {
    delete p.known;
    p.box = 1;
    p.due = Date.now(); // seen again later this session
    phase.queue.push(word);   // re-queue at the end of this part
    stats.missed.add(word.id);
  } else {
    p.box = Math.min(INTERVALS.length - 1, (p.box || 0) + quality);
    p.due = Date.now() + INTERVALS[p.box] * DAY_MS;
    phase.done++;
    if (phase.kind === "review") {
      stats.reviewed++;
      bump("reviewed");
      if (!stats.missed.has(word.id)) { stats.recalled++; bump("recalled"); }
    } else {
      stats.learned.push(word);
      bump("learned");
    }
  }
  progress[word.id] = p;
  save(STORE_KEY, progress);
  nextCard();
}

// A pause between the two parts: the reviews are finished and say so, before
// the new words begin.
function phaseBreak() {
  const next = phases[phaseIx];
  sessionEl.innerHTML = `
    <div class="session-top">${sessionSteps()}</div>
    <div class="card hero">
      <div class="big-check">✓</div>
      <h2>Reviews done</h2>
      <p>${plural(stats.reviewed, "word")} reviewed — ${stats.recalled} remembered first time.</p>
      <p class="muted">Next: ${plural(next.queue.length, "new word")}.</p>
      <div class="actions">
        <button class="btn primary big" id="btn-next">Start new words</button>
        <button class="btn ghost" id="btn-later">Later</button>
      </div>
    </div>`;
  document.getElementById("btn-next").onclick = nextCard;
  document.getElementById("btn-later").onclick = renderToday;
}

function endSession() {
  const allDone = !dueWords().length && !newWords(Math.max(0, settings.newPerDay - introducedToday())).length;
  const s = streak();
  const t = tomorrowForecast();
  const recap = [];
  if (stats.reviewed) recap.push(`<div class="stat"><b>${stats.reviewed}</b><span>reviewed</span></div>`);
  if (stats.learned.length) recap.push(`<div class="stat"><b>${stats.learned.length}</b><span>new words learned</span></div>`);
  if (stats.knew.length) recap.push(`<div class="stat"><b>${stats.knew.length}</b><span>already knew</span></div>`);
  sessionEl.innerHTML = `
    <div class="card hero closure">
      <div class="big-check">✓</div>
      <div class="hero-ar" dir="rtl">يعطيك العافية!</div>
      <h2>${allDone ? "Today's session is complete" : "Session finished"}</h2>
      <div class="stats">${recap.join("")}</div>
      ${stats.reviewed
        ? `<p class="muted">${stats.recalled} of ${stats.reviewed} reviews remembered first time.</p>` : ""}
      ${stats.learned.length ? `
        <div class="learned">
          <h3>Learned today</h3>
          ${stats.learned.map(w => `
            <div class="learned-row">
              <span class="w-ar" dir="rtl">${esc(w.ar)}</span>
              <span class="w-en">${esc(w.en)}</span>
            </div>`).join("")}
        </div>` : ""}
      ${s ? `<p class="streak">🔥 ${plural(s, "day")} in a row</p>` : ""}
      ${allDone ? `<p class="tomorrow">Tomorrow: ${plural(t.reviews, "review")}${
        t.fresh ? ` + ${plural(t.fresh, "new word")}` : ""}.</p>` : ""}
      <button class="btn primary" id="btn-back">Done</button>
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
      history = {};
      save(STORE_KEY, progress);
      save(HISTORY_KEY, history);
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
