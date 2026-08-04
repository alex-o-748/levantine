/* Yalla — Levantine Arabic learner. Vanilla JS, no build step. */
"use strict";

// ————————————————————— State —————————————————————

const STORE_KEY = "yalla.progress.v1";
const SETTINGS_KEY = "yalla.settings.v1";
const AUDIO_CACHE_KEY = "yalla.audiocache.v1";

// Leitner boxes → review interval in days. Box 0 = new/again.
const INTERVALS = [0, 1, 3, 7, 14, 30, 60];
const DAY_MS = 24 * 60 * 60 * 1000;

let progress = load(STORE_KEY, {});          // { [wordId]: {box, due} }
let settings = load(SETTINGS_KEY, {
  newPerDay: 8, translit: true, rate: 0.8,
  urbanQaf: true,   // speak ق as hamza (urban Levantine), matching the transliterations
  voiceURI: "",     // "" = auto-pick
});
let audioCache = load(AUDIO_CACHE_KEY, {});  // { [arabic]: url | "" }

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
function newWords(limit) {
  return VOCAB.filter(w => !progress[w.id]).slice(0, limit);
}
// New words already introduced today still count against the daily budget.
function introducedToday() {
  return Object.values(progress).filter(p => p.introduced === todayKey()).length;
}

// ————————————————————— Audio —————————————————————

let voices = [];
function arabicVoices() {
  if (!voices.length) voices = speechSynthesis.getVoices();
  return voices.filter(v => /^ar/i.test(v.lang));
}
// Voices that accepted an utterance but never actually spoke. Chrome lists
// some voices (typically network-backed ones) that silently produce nothing:
// no audio, no error event. They're dropped from the rotation once caught.
const deadVoices = new Set();

// Ordered list to try: the user's pick first, then Levantine regional voices
// (Edge ships ar-LB/ar-SY/ar-JO neural ones), preferring locally installed
// voices at each step since network voices are the ones that tend to fail.
function voiceCandidates() {
  const ar = arabicVoices().filter(v => !deadVoices.has(v.voiceURI));
  const chosen = ar.find(v => v.voiceURI === settings.voiceURI);
  const rank = v =>
    (/^ar-(LB|SY|JO|PS)/i.test(v.lang) ? 0 : 2) + (v.localService === false ? 1 : 0);
  const rest = ar.filter(v => v !== chosen).sort((a, b) => rank(a) - rank(b));
  return chosen ? [chosen, ...rest] : rest;
}
function pickArabicVoice() { return voiceCandidates()[0] || null; }
if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => {
    voices = speechSynthesis.getVoices();
    populateVoicePicker();
  };
}

// MSA-trained voices misread some dialect words from their lexicon (e.g.
// مرحبا → "marḥaban" with classical nunation). Respell those before
// speaking, and optionally read ق as hamza the way urban Levantine does.
const AR_LETTER = "\\u0620-\\u064A";
const TTS_FIX_RULES = Object.entries(TTS_FIXES)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([from, to]) =>
    [new RegExp(`(?<![${AR_LETTER}])${from}(?![${AR_LETTER}])`, "g"), to]);

function ttsText(text) {
  let out = text;
  for (const [re, to] of TTS_FIX_RULES) out = out.replace(re, to);
  if (settings.urbanQaf) out = out.replace(/قا/g, "آ").replace(/ق/g, "أ");
  return out;
}

// Speaks `text`, walking down the candidate list if a voice turns out to be
// silent. Returns a handle whose `onend` fires once speech finishes (or once
// every candidate has been exhausted), so callers can chain playback.
function speak(text, rate = settings.rate) {
  if (!("speechSynthesis" in window)) return null;
  speechSynthesis.cancel();
  const candidates = voiceCandidates();
  const handle = { onend: null, onerror: null };
  const finish = () => { if (handle.onend) handle.onend(); };

  const say = i => {
    const voice = candidates[i] || null; // past the end: let the browser choose
    const u = new SpeechSynthesisUtterance(ttsText(text));
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = "ar"; }
    u.rate = rate;
    let started = false;
    u.onstart = () => { started = true; };
    u.onend = u.onerror = finish;
    speechSynthesis.speak(u);
    // Watchdog: if nothing is speaking or queued shortly after, this voice
    // swallowed the utterance — retire it and try the next one.
    if (voice) setTimeout(() => {
      if (started || speechSynthesis.speaking || speechSynthesis.pending) return;
      deadVoices.add(voice.voiceURI);
      say(i + 1);
    }, 1400);
  };
  say(0);
  return handle;
}

// Look up a native-speaker recording on Wikimedia Commons (Lingua Libre —
// files are tagged with the Levantine language codes ajp/apc). Cached.
async function findCommonsAudio(arabic) {
  if (arabic in audioCache) return audioCache[arabic] || null;
  const word = arabic.replace(/[؟!،.]/g, "").trim();
  const query = `intitle:"${word}" (intitle:"ajp" OR intitle:"apc") filetype:audio`;
  const url = "https://commons.wikimedia.org/w/api.php?origin=*&action=query&format=json" +
    "&list=search&srnamespace=6&srlimit=1&srsearch=" + encodeURIComponent(query);
  // Hard deadline: a slow or blocked Commons must never hold up playback.
  const signal = AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined;
  try {
    const res = await fetch(url, { signal });
    const data = await res.json();
    const hit = data?.query?.search?.[0];
    let fileUrl = "";
    if (hit) {
      const info = await fetch(
        "https://commons.wikimedia.org/w/api.php?origin=*&action=query&format=json&prop=imageinfo&iiprop=url&titles=" +
        encodeURIComponent(hit.title), { signal }
      ).then(r => r.json());
      const pages = info?.query?.pages || {};
      fileUrl = Object.values(pages)[0]?.imageinfo?.[0]?.url || "";
    }
    audioCache[arabic] = fileUrl;
    save(AUDIO_CACHE_KEY, audioCache);
    return fileUrl || null;
  } catch {
    return null; // offline / API hiccup — don't cache, retry next time
  }
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

async function playWord(word, btn) {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  if (btn) { btn.classList.add("playing"); btn.classList.remove("native"); }
  const done = () => btn && btn.classList.remove("playing");
  try {
    const nativeUrl = await findCommonsAudio(word.ar);
    if (nativeUrl) {
      const audio = await tryPlayRecording(nativeUrl);
      if (audio) {
        audio.onended = audio.onerror = done;
        if (btn) btn.classList.add("native");
        return;
      }
      // Bad URL/codec — forget it so the next click retries the lookup.
      delete audioCache[word.ar];
      save(AUDIO_CACHE_KEY, audioCache);
    }
  } catch { /* fall through to speech synthesis */ }
  const u = speak(word.tts || word.ar); // per-word override beats the global fixes
  if (u) u.onend = done; else done();
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
  if (start) start.onclick = () => startSession([...due, ...fresh]);
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
      <button class="btn audio" id="fc-audio" title="Listen">🔊</button>
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
  document.getElementById("fc-audio").onclick = e => playWord(word, e.currentTarget);
  document.getElementById("fc-wik").onclick = () => openWiktionary(word);
  document.getElementById("fc-reveal").onclick = () => {
    document.getElementById("fc-answer").classList.remove("hidden");
    document.getElementById("fc-grade").classList.remove("hidden");
    document.getElementById("fc-reveal").classList.add("hidden");
  };
  // Auto-play the word when the card appears (new words especially).
  playWord(word, document.getElementById("fc-audio"));
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
        <button class="btn audio small" data-act="audio" title="Listen">🔊</button>
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
      <span class="text-title-en">${esc(t.title)} · ${t.lines.length} lines</span>
    </button>`).join("");
  textList.querySelectorAll(".text-card").forEach(c =>
    c.onclick = () => openText(TEXTS.find(t => t.id === c.dataset.id)));
}

let playingAll = false;

function openText(text) {
  textList.classList.add("hidden");
  textView.classList.remove("hidden");
  playingAll = false;
  textView.innerHTML = `
    <div class="text-head">
      <button class="btn ghost" id="btn-texts-back">← Texts</button>
      <h2 dir="rtl">${esc(text.titleAr)}</h2>
      <span class="text-level">${text.level}</span>
    </div>
    <div class="text-toolbar">
      <button class="btn primary" id="btn-playall">▶ Play all</button>
      <label class="toggle"><input type="checkbox" id="chk-listening" checked> Listening mode (hide text)</label>
      <label class="toggle"><input type="checkbox" id="chk-trans"> Show translation</label>
    </div>
    <p class="muted listen-hint" id="listen-hint">
      🎧 Listen first. Tap ▶ on a line to hear it, tap the blurred line to reveal it.
    </p>
    <div class="lines" id="lines">
      ${text.lines.map((l, i) => `
        <div class="line" data-i="${i}">
          <button class="btn audio small line-play" title="Play line">▶</button>
          <div class="line-body">
            <div class="line-ar veiled" dir="rtl">
              ${l.sp ? `<span class="line-sp">${esc(l.sp)}:</span> ` : ""}${esc(l.ar)}
            </div>
            <div class="line-en hidden">${esc(l.en)}</div>
          </div>
        </div>`).join("")}
    </div>`;

  document.getElementById("btn-texts-back").onclick = () => { stopAll(); renderTextList(); };

  const linesEl = document.getElementById("lines");
  const chkListening = document.getElementById("chk-listening");
  const chkTrans = document.getElementById("chk-trans");

  function applyModes() {
    linesEl.querySelectorAll(".line-ar").forEach(el =>
      el.classList.toggle("veiled", chkListening.checked && !el.classList.contains("revealed")));
    linesEl.querySelectorAll(".line-en").forEach(el =>
      el.classList.toggle("hidden", !chkTrans.checked));
    document.getElementById("listen-hint").classList.toggle("hidden", !chkListening.checked);
  }
  chkListening.onchange = () => {
    // Re-veil everything when turning listening mode back on.
    linesEl.querySelectorAll(".line-ar").forEach(el => el.classList.remove("revealed"));
    applyModes();
  };
  chkTrans.onchange = applyModes;

  linesEl.addEventListener("click", e => {
    const line = e.target.closest(".line");
    if (!line) return;
    const i = +line.dataset.i;
    if (e.target.closest(".line-play")) {
      stopAll();
      highlight(i);
      speak(text.lines[i].ar);
    } else {
      const arEl = line.querySelector(".line-ar");
      arEl.classList.add("revealed");
      arEl.classList.remove("veiled");
    }
  });

  function highlight(i) {
    linesEl.querySelectorAll(".line").forEach((el, j) =>
      el.classList.toggle("current", j === i));
  }

  document.getElementById("btn-playall").onclick = async function () {
    if (playingAll) { stopAll(); this.textContent = "▶ Play all"; return; }
    playingAll = true;
    this.textContent = "⏸ Stop";
    for (let i = 0; i < text.lines.length && playingAll; i++) {
      highlight(i);
      await speakAsync(text.lines[i].ar);
      if (playingAll) await pause(700);
    }
    playingAll = false;
    this.textContent = "▶ Play all";
    highlight(-1);
  };

  applyModes();
}

function speakAsync(text) {
  return new Promise(resolve => {
    const u = speak(text);
    if (!u) return resolve();
    u.onend = u.onerror = resolve;
  });
}
function pause(ms) { return new Promise(r => setTimeout(r, ms)); }
function stopAll() {
  playingAll = false;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
}

// ————————————————————— Settings —————————————————————

function populateVoicePicker() {
  const sel = document.getElementById("set-voice");
  const hint = document.getElementById("voice-hint");
  if (!sel || !("speechSynthesis" in window)) return;
  const ar = arabicVoices();
  sel.innerHTML =
    `<option value="">Auto — prefers Levantine (ar-LB/SY/JO) voices</option>` +
    ar.map(v => `<option value="${esc(v.voiceURI)}"${v.voiceURI === settings.voiceURI ? " selected" : ""}>` +
      `${esc(v.name)} (${esc(v.lang)}${v.localService === false ? ", online" : ""})</option>`).join("");
  if (!hint) return;
  hint.textContent = ar.length
    ? `${ar.length} Arabic voice${ar.length === 1 ? "" : "s"} available. Hit Test — if you hear ` +
      `nothing, pick another one; “online” voices need a working connection.`
    : "No Arabic voice is installed on this device, so speech will be silent. " +
      "Install an Arabic language pack (Windows/Android settings), or use Microsoft Edge, " +
      "which ships Levantine voices. Native word recordings from Wikimedia still work.";
  hint.classList.toggle("warn", !ar.length);
}

function initSettings() {
  const perDay = document.getElementById("set-newperday");
  const translit = document.getElementById("set-translit");
  const rate = document.getElementById("set-rate");
  const rateLabel = document.getElementById("rate-label");
  const voiceSel = document.getElementById("set-voice");
  const urbanQaf = document.getElementById("set-urbanqaf");
  perDay.value = String(settings.newPerDay);
  translit.checked = settings.translit;
  rate.value = String(settings.rate);
  rateLabel.textContent = settings.rate + "×";
  urbanQaf.checked = settings.urbanQaf;
  populateVoicePicker();

  perDay.onchange = () => { settings.newPerDay = +perDay.value; save(SETTINGS_KEY, settings); renderToday(); };
  translit.onchange = () => { settings.translit = translit.checked; save(SETTINGS_KEY, settings); renderWords(); };
  rate.oninput = () => { settings.rate = +rate.value; rateLabel.textContent = rate.value + "×"; save(SETTINGS_KEY, settings); };
  voiceSel.onchange = () => {
    settings.voiceURI = voiceSel.value;
    deadVoices.delete(voiceSel.value); // give an explicitly chosen voice a fresh chance
    save(SETTINGS_KEY, settings);
    speak("مرحبا"); // preview the chosen voice
  };
  document.getElementById("btn-testvoice").onclick = () => speak("مرحبا، كيفك؟");
  urbanQaf.onchange = () => { settings.urbanQaf = urbanQaf.checked; save(SETTINGS_KEY, settings); };

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

initWordsTab();
renderTextList();
initSettings();
renderToday();
