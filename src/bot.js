import * as store from './db.js';
import * as wa from './messenger.js';
import { answerCallback } from './telegram.js';
import { config, isAllowed } from './config.js';
import { SUBJECTS, EXAM_WEIGHT, matchSubject, findSubjectIn } from './subjects.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ingest, formatSummary, runJob, whenText } from './ingest/index.js';
import { classify } from './ingest/keywords.js';
import { aiAvailable, mediaAvailable, explain as aiExplain, explainQuestion, transcribe, flashcards as aiFlashcards, AiBusyError } from './ingest/ai.js';
import { localNow, addDays, daysBetween } from './time.js';

const LETTERS = ['A', 'B', 'C', 'D'];

const HELP = `📚 *NEET PG Study Bot*
_Your notes, question banks and PYQs in one place._

📥 *Add material*
• Send a *PDF*, a *photo* of a page, or *paste text*: notes, Q-banks, PYQs. I sort everything by subject and topic (a caption like "pharma" helps).
• Photo with caption *spot: answer* → an image question
• *YouTube link* or *lecture recording* → notes and MCQs
• *Voice note* → ask anything by voice

📝 *Practise*
• *q* · one question (*q pharma*)
• *test* · *test pharma 20* · *test pyq 2022* · *test thyroid*
• *grand* · timed mock, +4/−1
• *revise* · questions due for review
• *spot* · image question   • *flash* · flashcards
• *similar* · more like the last one   • *stop* · end a test

🧠 *Learn*
• Just ask: _"DOC for absence seizures?"_
• *explain* topic · *where* topic · *why* (last question)
• *hy* · high-yield topics from your PYQs

📆 *Plan and track*
• *exam 15-01-2027* → *plan* · *today*
• *coach* · *stats* · *bank* · *report*
• *daily 07:30* · *daily off* · *daily pharma*
• *buddy* · *lb* · *name Harsh*`;

// ---------- helpers ----------

function questionCard(q, header) {
  const tags = [q.subject, q.topic !== 'General' ? q.topic : null].filter(Boolean).join(' › ');
  const pyq = q.origin === 'pyq' ? ` · 🏷 PYQ${q.year ? ' ' + q.year : ''}${q.exam && q.exam !== 'NEET PG' ? ' ' + q.exam : ''}` : '';
  const opts = q.options.map((o, i) => `*${LETTERS[i]}.*  ${o}`).join('\n');
  return [header ? `🩺 *${header}*` : null, `📘 _${tags}_${pyq}`, '', `*${q.stem.trim()}*`, '', opts, '', '_Tap an option or reply A–D._']
    .filter((l) => l !== null)
    .join('\n');
}

async function sendQuestion(phone, q, header, { skip = false } = {}) {
  const rows = q.options.map((o, i) => ({ id: `ans:${q.id}:${i}`, title: LETTERS[i], description: o }));
  if (skip) rows.push({ id: `gskip:${q.id}`, title: 'Skip', description: 'Leave it blank (0 marks)' });
  await wa.sendList(phone, questionCard(q, header), 'Answer', rows, 'Choose one');
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pct = (c, n) => (n ? Math.round((100 * c) / n) : 0);
/** Fisher–Yates. */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Text plus up to 3 buttons. WhatsApp button messages hold 1024 characters, so longer text goes first on its own. */
async function sendWithButtons(phone, text, buttons, prompt = 'What next?') {
  if (text.length <= (wa.isTelegram(phone) ? 4000 : 1000)) return wa.sendButtons(phone, text, buttons);
  await wa.sendText(phone, text);
  return wa.sendButtons(phone, prompt, buttons);
}

const NEXT_BUTTONS = (qid) => [
  { id: 'next', title: '➡️ Next' },
  { id: `why:${qid}`, title: '🤔 Why' },
  { id: `sim:${qid}`, title: '🔗 Similar' },
];

const EMPTY_BANK = 'Your question bank is empty. Send me a PDF, a photo of a page, or pasted text of notes or questions to fill it.';

/** The part of a long note around the first place the query words appear. */
export function excerptAround(content, query, size = 2500) {
  if (content.length <= size) return content;
  const lower = content.toLowerCase();
  const hits = store.searchTerms(query).map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = hits.length ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(at - Math.floor(size / 4), content.length - size));
  return `${start ? '…' : ''}${content.slice(start, start + size)}${start + size < content.length ? '…' : ''}`;
}

/** A short line for when the AI can't answer right now. */
const restingLine = (e) =>
  e instanceof AiBusyError
    ? `_The AI has used up its free quota for now${e.resetAt ? ` (back ${whenText(e.resetAt)})` : ''}, so here is what your notes say._`
    : '_The AI could not answer just now, so here is what your notes say._';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** ▰▰▰▰▰▰▱▱▱▱ for a percentage. */
const bar = (p, len = 10) => {
  const full = Math.max(0, Math.min(len, Math.round((p / 100) * len)));
  return '▰'.repeat(full) + '▱'.repeat(len - full);
};
const quote = (text) => String(text).trim().split('\n').map((l) => `> ${l}`).join('\n');
const grade = (p) => (p >= 80 ? '🌟 Excellent!' : p >= 65 ? '👏 Well done!' : p >= 50 ? '💪 Good effort, keep going.' : '📖 Worth revising these topics.');

const where = (row) => {
  const loc = [row.filename, row.page ? `p.${row.page}` : null].filter(Boolean).join(' ');
  return `${row.subject} › ${row.topic}${loc ? ` (${loc})` : ''}`;
};

/** The lines of a note that best match a query: its bold title plus the most relevant facts, as bullets. */
export function noteLines(content, query, max = 4) {
  const terms = store.searchTerms(query);
  let lines = String(content).split('\n').map((l) => l.trim()).filter(Boolean);
  // Older notes are one run-on paragraph: use sentences instead of lines.
  if (lines.length < 3) lines = String(content).split(/(?<=[.;])\s+(?=[A-Z0-9*•])/).map((l) => l.trim()).filter(Boolean);
  let title = /^\*[^*]+\*:?$/.test(lines[0] || '') ? lines.shift() : null;
  const lead = !title && (lines[0] || '').match(/^([^:.\n]{3,40}):\s*(.*)$/);
  if (lead) {
    title = `*${lead[1].trim()}*`;
    lines[0] = lead[2];
  }
  const score = (l) => terms.filter((t) => l.toLowerCase().includes(t)).length;
  const ranked = lines.map((l, i) => ({ l, i, s: score(l) })).filter((x) => x.s > 0);
  const picked = (ranked.length ? ranked.sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max) : lines.slice(0, max).map((l, i) => ({ l, i })))
    .sort((a, b) => a.i - b.i)
    .map((x) => clip(/^[•\-]/.test(x.l) ? x.l.replace(/^-\s*/, '• ') : `• ${x.l}`, 300));
  return [title, ...picked].filter(Boolean).join('\n');
}

/** The best matching passage from the user's notes for a question, or null. */
async function noteReference(q) {
  const query = `${q.stem} ${q.options[q.answer]}`;
  const hits = await store.searchNotes(query, { limit: 1, subject: q.subject });
  const hit = hits[0] || (await store.searchNotes(query, { limit: 1 }))[0];
  return hit ? `📖 *From your notes* · _${where(hit)}_\n${quote(noteLines(hit.content, `${q.options[q.answer]} ${q.stem}`, 3))}` : null;
}

function inWindow(user) {
  return user.last_inbound_at && Date.now() - new Date(user.last_inbound_at).getTime() < 23.5 * 3600 * 1000;
}

// ---------- practice ----------

/** A test is running: offer to carry on or end it rather than silently dropping it. */
async function testRunning(phone, user) {
  const t = user.state.test;
  if (!t) return false;
  await wa.sendButtons(phone, `You're in the middle of ${t.grand ? 'a grand test' : `a test (${t.label})`}: question ${t.index + 1} of ${t.ids.length}.`, [
    { id: 'tcont', title: '▶️ Continue' },
    { id: 'tend', title: '⏹ End test' },
  ]);
  return true;
}

async function askSingle(phone, user, { subject = null, mode = 'single', qid = null, header = null } = {}) {
  if (await testRunning(phone, user)) return false;
  const id = qid || (await store.pickQuestions(phone, { count: 1, subject }))[0];
  if (!id) {
    await wa.sendText(phone, subject ? `No ${subject} questions yet. Send me notes or questions on it and I'll add them.` : EMPTY_BANK);
    return false;
  }
  const q = await store.getQuestion(id);
  await store.updateUser(phone, { state: { ...user.state, current: { qid: id, mode }, test: null } });
  await sendQuestion(phone, q, header ?? (mode === 'daily' ? 'Question of the day' : null));
  return true;
}

async function startTest(phone, user, opts) {
  if (await testRunning(phone, user)) return;
  const count = Math.min(Math.max(opts.count || 10, 1), 100);
  let filter = { subject: opts.subject, pyqOnly: opts.pyqOnly, year: opts.year, wrongOnly: opts.wrongOnly, ids: opts.ids || null };
  let label = [opts.wrongOnly ? 'Revision' : null, opts.subject, opts.pyqOnly || opts.year ? `PYQ${opts.year ? ' ' + opts.year : ''}` : null]
    .filter(Boolean)
    .join(' · ');

  if (opts.topic) {
    // Match the topic name first, then fall back to a full-text search of the questions.
    if (await store.countQuestions({ subject: opts.subject, topic: opts.topic })) {
      filter.topic = opts.topic;
    } else {
      const hits = await store.searchQuestions(opts.topic, { limit: 300 });
      filter.ids = hits.filter((h) => !opts.subject || h.subject === opts.subject).map((h) => h.id);
    }
    label = [label, `"${opts.topic}"`].filter(Boolean).join(' · ');
  }

  const ids = await store.pickQuestions(phone, { ...filter, count });
  if (!ids.length) {
    await wa.sendText(
      phone,
      opts.wrongOnly ? 'Nothing to revise: your review queue is empty. 🎉' : `I found no questions for ${label || 'that'}. Send *bank* to see what's there.`
    );
    return;
  }
  const test = { ids, index: 0, correct: 0, wrong: [], label: opts.label || label || 'Mixed', perTopic: {} };
  await store.updateUser(phone, { state: { ...user.state, test, current: { qid: ids[0], mode: 'test' } } });
  const note = ids.length < count ? ` (only ${ids.length} available)` : '';
  await wa.sendText(phone, `📝 *Test · ${test.label}*\n${plural(ids.length, 'question')}${note} · send *stop* any time to finish early. Good luck! 🍀`);
  await sendQuestion(phone, await store.getQuestion(ids[0]), `Q 1/${ids.length}`);
}

async function finishTest(phone, user, test) {
  const answered = test.index;
  const p = pct(test.correct, answered);
  const lines = [`🏁 *Test finished* · ${test.label}`, ''];
  if (answered) lines.push(`🎯 Score: *${test.correct}/${answered}* (${p}%)`, bar(p), grade(p));
  else lines.push('No questions answered.');
  const topics = Object.entries(test.perTopic).sort((a, b) => a[1].c / a[1].n - b[1].c / b[1].n);
  if (topics.length > 1) {
    lines.push('', '📊 *By topic*');
    for (const [t, v] of topics) lines.push(`${bar(pct(v.c, v.n), 5)} ${t} · ${v.c}/${v.n}`);
  }
  if (test.wrong.length) {
    lines.push('', '❌ *Review these*');
    for (const w of test.wrong.slice(0, 15)) lines.push(`• ${w}`);
  }
  await store.updateUser(phone, { state: { ...user.state, test: null, current: null } });
  const buttons = test.wrong.length
    ? [{ id: 'revise', title: '🔁 Revise mistakes' }, { id: 'newtest', title: '📝 New test' }, { id: 'stats', title: '📊 Stats' }]
    : [{ id: 'newtest', title: '📝 New test' }, { id: 'next', title: '➡️ One question' }, { id: 'stats', title: '📊 Stats' }];
  await sendWithButtons(phone, lines.join('\n'), buttons);
}

async function handleAnswer(phone, user, qid, chosen) {
  const cur = user.state.current;
  if (!cur || cur.qid !== qid) {
    await wa.sendText(phone, 'That question is already closed. Send *q* for a new one.');
    return;
  }
  // A late answer in a timed mock: the clock ran out before it came in.
  if (cur.mode === 'grand' && user.state.test?.grand && Date.now() > user.state.test.endsAt) {
    return finishGrand(phone, user, user.state.test, true);
  }
  const q = await store.getQuestion(qid);
  if (!q || !(chosen >= 0 && chosen < q.options.length)) {
    await store.updateUser(phone, { state: { ...user.state, current: null } });
    return wa.sendButtons(phone, 'That question is no longer in your database.', [{ id: 'next', title: '➡️ Next' }]);
  }
  const correct = chosen === q.answer;
  await store.recordAttempt(phone, qid, chosen, correct, cur.mode);
  const due = await store.scheduleReview(phone, qid, correct);
  if (cur.mode === 'grand' && user.state.test?.grand) return grandStep(phone, user, q, correct ? 'c' : 'w');

  const lines = correct
    ? ['✅ *Correct!*', quote(`*${LETTERS[q.answer]}. ${q.options[q.answer]}*`)]
    : [`❌ *Not quite.* You chose ${LETTERS[chosen]}. ${q.options[chosen] ?? ''}`, '', '*Correct answer*', quote(`*${LETTERS[q.answer]}. ${q.options[q.answer]}*`)];
  if (q.explanation) lines.push('', `💡 ${q.explanation.trim()}`);
  if (!q.answer_checked) lines.push('', '⚠️ _No answer key in the source; the AI worked this one out, so double-check it._');
  const ref = await noteReference(q);
  if (ref) lines.push('', ref);
  else if (q.filename) lines.push('', `📄 _From ${q.filename}${q.page ? `, p.${q.page}` : ''}_`);
  if (!correct && due) lines.push('', `🔁 _Back for review on ${shortDate(due)}._`);

  const state = { ...user.state, lastQid: qid, current: null };
  const test = state.test;
  if (test && cur.mode === 'test') {
    test.index++;
    const key = q.topic !== 'General' ? q.topic : q.subject;
    const t = (test.perTopic[key] ??= { n: 0, c: 0 });
    t.n++;
    if (correct) { test.correct++; t.c++; } else test.wrong.push(`${q.stem.slice(0, 70)}${q.stem.length > 70 ? '…' : ''} → ${LETTERS[q.answer]}. ${q.options[q.answer]}`);
    await wa.sendText(phone, lines.join('\n'));
    if (test.index >= test.ids.length) return finishTest(phone, { ...user, state }, test);
    state.current = { qid: test.ids[test.index], mode: 'test' };
    await store.updateUser(phone, { state });
    return sendQuestion(phone, await store.getQuestion(test.ids[test.index]), `Q ${test.index + 1}/${test.ids.length}`);
  }
  await store.updateUser(phone, { state });
  await sendWithButtons(phone, lines.join('\n'), NEXT_BUTTONS(qid));
}


// ---------- grand test ----------

const timeLeft = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

/** A full mock: questions spread across subjects like the real paper, 1.05 min per question, +4/−1. */
async function startGrand(phone, user, n) {
  if (await testRunning(phone, user)) return;
  const total = Math.min(Math.max(n || 200, 10), 200);
  const counts = {};
  for (const r of await store.bankSummary()) counts[r.subject] = (counts[r.subject] || 0) + r.n;
  const subjects = SUBJECTS.filter((s) => counts[s]);
  if (!subjects.length) return wa.sendText(phone, EMPTY_BANK);
  const sumW = subjects.reduce((a, s) => a + EXAM_WEIGHT[s], 0);
  let ids = [];
  for (const s of subjects) {
    const want = Math.round((total * EXAM_WEIGHT[s]) / sumW);
    if (want) ids.push(...(await store.pickQuestions(phone, { subject: s, count: want })));
  }
  if (ids.length < total) {
    for (const id of await store.pickQuestions(phone, { count: total * 2 })) {
      if (ids.length >= total) break;
      if (!ids.includes(id)) ids.push(id);
    }
  }
  ids = shuffle(ids.slice(0, total));
  if (!ids.length) return wa.sendText(phone, EMPTY_BANK);
  const minutes = Math.round(ids.length * 1.05);
  const now = Date.now();
  const test = { grand: true, ids, index: 0, correct: 0, wrongN: 0, skipped: 0, perSubject: {}, label: 'Grand test', startedAt: now, endsAt: now + minutes * 60000, minutes };
  await store.updateUser(phone, { state: { ...user.state, test, current: { qid: ids[0], mode: 'grand' } } });
  const short = ids.length < total ? ` (your bank has only ${ids.length})` : '';
  await wa.sendText(
    phone,
    `🏆 *Grand test*: ${ids.length} questions${short}, ${timeLeft(minutes * 60000)} on the clock.\nMarking is +4 for right, −1 for wrong, 0 for skipped. Answers come at the end. Send *skip* to leave one blank or *stop* to finish early.`
  );
  return sendGrandQuestion(phone, test);
}

async function grandChooser(phone, user) {
  if (await testRunning(phone, user)) return;
  return wa.sendButtons(phone, '🏆 *Grand mock*\nTimed like the real paper (1.05 min per question), +4 right / −1 wrong, answers at the end.\n\nHow long?', [
    { id: 'gstart:200', title: '200 Q · 3.5 h' },
    { id: 'gstart:100', title: '100 Q · 1h 45m' },
    { id: 'gstart:50', title: '50 Q · 53 min' },
  ]);
}

async function sendGrandQuestion(phone, test) {
  const q = await store.getQuestion(test.ids[test.index]);
  await sendQuestion(phone, q, `Q ${test.index + 1}/${test.ids.length} · ⏱ ${timeLeft(test.endsAt - Date.now())} left`, { skip: true });
}

/** outcome: 'c' correct, 'w' wrong, 's' skipped. */
async function grandStep(phone, user, q, outcome) {
  const test = user.state.test;
  const s = (test.perSubject[q.subject] ??= { n: 0, c: 0, w: 0 });
  s.n++;
  if (outcome === 'c') { test.correct++; s.c++; } else if (outcome === 'w') { test.wrongN++; s.w++; } else test.skipped++;
  test.index++;
  const state = { ...user.state, lastQid: q.id, test, current: null };
  if (test.index >= test.ids.length) return finishGrand(phone, { ...user, state }, test);
  if (Date.now() > test.endsAt) return finishGrand(phone, { ...user, state }, test, true);
  state.current = { qid: test.ids[test.index], mode: 'grand' };
  await store.updateUser(phone, { state });
  return sendGrandQuestion(phone, test);
}

async function grandSkip(phone, user) {
  return grandStep(phone, user, await store.getQuestion(user.state.current.qid), 's');
}

async function finishGrand(phone, user, test, timeUp = false) {
  const marks = 4 * test.correct - test.wrongN;
  const attempted = test.correct + test.wrongN;
  const notReached = test.ids.length - test.index;
  const used = Math.min(Date.now(), test.endsAt) - test.startedAt;
  const max = 4 * test.ids.length;
  const lines = [
    timeUp ? "⏰ *Time's up!*" : null,
    `🏁 *Grand test finished*`,
    '',
    `🎯 Marks: *${marks}/${max}*`,
    bar(pct(Math.max(0, marks), max)),
    `✅ ${test.correct} right · ❌ ${test.wrongN} wrong · ⏭ ${test.skipped} skipped${notReached ? ` · ${notReached} not reached` : ''}`,
    attempted ? `🎯 Accuracy: ${pct(test.correct, attempted)}% of attempted` : null,
    `⏱ Time: ${timeLeft(used)} of ${timeLeft(test.minutes * 60000)}`,
  ].filter((l) => l !== null);
  const subjects = Object.entries(test.perSubject).sort((a, b) => a[1].c / a[1].n - b[1].c / b[1].n);
  if (subjects.length > 1) {
    lines.push('', '📊 *By subject* (weakest first)');
    for (const [s, v] of subjects) lines.push(`${bar(pct(v.c, v.n), 5)} ${s} · ${4 * v.c - v.w} marks (${v.c}/${v.n})`);
  }
  if (test.wrongN) lines.push('', 'Every question you got wrong is now in your review queue.');
  await store.updateUser(phone, { state: { ...user.state, test: null, current: null } });
  await sendWithButtons(
    phone,
    lines.join('\n'),
    test.wrongN
      ? [{ id: 'revise', title: '🔁 Revise mistakes' }, { id: 'coach', title: '🎯 Coach' }, { id: 'stats', title: '📊 Stats' }]
      : [{ id: 'coach', title: '🎯 Coach' }, { id: 'stats', title: '📊 Stats' }]
  );
}

// ---------- notes: explain / where ----------

async function explain(phone, user, query) {
  wa.typing(phone);
  const subject = findSubjectIn(query);
  let notes = await store.searchNotes(query, { limit: 5, subject });
  if (!notes.length && subject) notes = await store.searchNotes(query, { limit: 5 });
  const qs = await store.searchQuestions(query, { limit: 300 });
  const sources = notes.length ? `\n\n📚 *Sources*\n${notes.map((n, i) => `_[${i + 1}] ${where(n)}_`).join('\n')}` : '';
  const finish = async (text) => {
    if (!qs.length) return wa.sendText(phone, text);
    await store.updateUser(phone, { state: { ...user.state, related: qs.slice(0, 50).map((h) => h.id) } });
    return sendWithButtons(phone, `${text}\n\n📝 ${plural(qs.length, 'related question')} in your bank.`, [{ id: 'reltest', title: '📝 Practise these' }], 'Practise them?');
  };
  const snippets = () => notes.map((n, i) => `📖 *[${i + 1}] ${where(n)}*\n${quote(noteLines(n.content, query))}`).join('\n\n');

  if (!aiAvailable()) {
    if (!notes.length) return finish(`Nothing about "${clip(query, 60)}" in your notes yet.`);
    return finish(`🔎 *From your notes*\n\n${snippets()}`);
  }
  if (!notes.length) await wa.sendText(phone, '🔎 Nothing in your notes on that yet, answering from standard sources…');
  const excerpts = notes.map((n) => ({ label: where(n), text: excerptAround(n.content, query) }));
  // Matching questions from the bank help too: their explanations are often the best summary of a fact.
  for (const h of qs.slice(0, 3)) {
    const q = await store.getQuestion(h.id);
    excerpts.push({
      label: `Q-bank: ${q.subject} › ${q.topic}${q.year ? ` (PYQ ${q.year})` : ''}`,
      text: `${q.stem}\nAnswer: ${q.options[q.answer]}${q.explanation ? `\n${q.explanation}` : ''}`,
    });
  }
  try {
    const answer = await aiExplain(query, excerpts);
    return finish(`${answer}${sources}`);
  } catch (e) {
    console.error('Explain failed:', e.message);
    if (!notes.length) return finish(e instanceof AiBusyError ? `${restingLine(e).replace(', so here is what your notes say', '')}\nNothing about "${clip(query, 60)}" in your notes either. Try again later.` : 'Sorry, I could not answer that just now. Please try again.');
    return finish(`${restingLine(e)}\n\n${snippets()}`);
  }
}

async function whereIs(phone, query) {
  const notes = await store.searchNotes(query, { limit: 10 });
  const qs = await store.searchQuestions(query, { limit: 300 });
  if (!notes.length && !qs.length) return wa.sendText(phone, `"${query}" doesn't appear in your notes or question bank yet.`);
  const lines = [`🔎 *"${query}"* in your material`];
  if (notes.length) {
    lines.push('', `*Notes* (${notes.length}${notes.length === 10 ? '+' : ''})`);
    for (const n of notes) lines.push(`- ${where(n)}`);
  }
  if (qs.length) {
    const groups = {};
    for (const q of qs) {
      const k = `${q.subject} › ${q.topic}`;
      const g = (groups[k] ??= { n: 0, pyq: new Set(), files: new Set() });
      g.n++;
      if (q.origin === 'pyq' && q.year) g.pyq.add(q.year);
      if (q.filename) g.files.add(q.filename);
    }
    lines.push('', `*Questions* (${qs.length})`);
    for (const [k, g] of Object.entries(groups).sort((a, b) => b[1].n - a[1].n).slice(0, 10)) {
      const extra = [g.pyq.size ? `PYQ ${[...g.pyq].sort().join(', ')}` : null, [...g.files].slice(0, 2).join(', ') || null].filter(Boolean).join(' · ');
      lines.push(`- ${k}: ${g.n}${extra ? ` (${extra})` : ''}`);
    }
  }
  lines.push('', `Send *explain ${query.slice(0, 40)}* for a summary or *test ${query.slice(0, 40)}* to practise.`);
  await wa.sendText(phone, lines.join('\n'));
}

async function why(phone, user, qid = user.state.lastQid) {
  if (!qid) return wa.sendText(phone, 'Answer a question first, then send *why*.');
  const q = await store.getQuestion(qid);
  if (!q) return wa.sendText(phone, 'That question is no longer in your bank.');
  wa.typing(phone);
  const query = `${q.stem} ${q.options[q.answer]}`;
  let notes = await store.searchNotes(query, { limit: 4, subject: q.subject });
  if (!notes.length) notes = await store.searchNotes(query, { limit: 3 });
  const sources = notes.length ? `\n\n📚 *Sources*\n${notes.map((n, i) => `_[${i + 1}] ${where(n)}_`).join('\n')}` : '';
  const buttons = [{ id: 'next', title: '➡️ Next' }, { id: `sim:${qid}`, title: '🔗 Similar' }];
  const offline = () => {
    const lines = [`✅ *${LETTERS[q.answer]}. ${q.options[q.answer]}*`];
    if (q.explanation) lines.push('', `💡 ${q.explanation.trim()}`);
    if (notes.length) lines.push('', ...notes.slice(0, 2).map((n, i) => `📖 *[${i + 1}] ${where(n)}*\n${quote(noteLines(n.content, query, 3))}`));
    if (!q.explanation && !notes.length) lines.push('', 'No explanation stored and nothing on it in your notes yet.');
    return lines.join('\n');
  };
  if (!aiAvailable()) return sendWithButtons(phone, offline(), buttons);
  try {
    const answer = await explainQuestion(q, notes.map((n) => ({ label: where(n), text: excerptAround(n.content, query) })));
    return sendWithButtons(phone, `${answer}${sources}`, buttons);
  } catch (e) {
    console.error('Why failed:', e.message);
    return sendWithButtons(phone, `${restingLine(e).replace('what your notes say', 'what I have')}\n\n${offline()}`, buttons);
  }
}

// ---------- info ----------

async function showBank(phone) {
  const rows = await store.bankSummary();
  const notes = await store.notesSummary();
  if (!rows.length && !notes.length) return wa.sendText(phone, 'Your database is empty. Send me a PDF, photo or text to get started.');
  const bySubject = {};
  for (const r of rows) (bySubject[r.subject] ??= []).push(r);
  const noteMap = Object.fromEntries(notes.map((n) => [n.subject, n]));
  const total = rows.reduce((s, r) => s + r.n, 0);
  const lines = [`📚 *Your bank: ${plural(total, 'question')}*`];
  for (const s of SUBJECTS) {
    const topics = bySubject[s];
    const n = noteMap[s];
    if (!topics && !n) continue;
    const count = topics ? topics.reduce((a, r) => a + r.n, 0) : 0;
    const pyq = topics ? topics.reduce((a, r) => a + r.pyq, 0) : 0;
    lines.push('', `📘 *${s}* · ${count} Q${pyq ? ` (${pyq} PYQ)` : ''}${n ? ` · 📝 ${plural(n.topics, 'topic')}` : ''}`);
    if (topics) lines.push(`_${topics.slice(0, 6).map((t) => `${t.topic} ${t.n}`).join(' · ')}${topics.length > 6 ? ` · +${topics.length - 6} more` : ''}_`);
  }
  await wa.sendText(phone, lines.join('\n'));
}

async function showStats(phone) {
  const s = await store.userStats(phone);
  if (!s.overall.n) return wa.sendText(phone, 'No answers yet. Send *q* to start.');
  const [st, rc] = [await store.streak(phone), await store.reviewCounts(phone)];
  const p = pct(s.overall.c, s.overall.n);
  const lines = [
    `📊 *Your progress*`,
    '',
    `🎯 Accuracy: *${p}%* (${s.overall.c}/${s.overall.n})`,
    bar(p),
    `🔥 Streak: *${plural(st, 'day')}* · active ${s.activeDaysThisWeek}/7 days this week`,
    rc.total ? `🔁 Review: *${rc.due}* due today, ${rc.total} in queue` : '🔁 Review queue empty',
  ];
  lines.push('', '📚 *By subject*');
  for (const r of s.bySubject) lines.push(`${bar(pct(r.c, r.n), 5)} ${r.subject} · ${pct(r.c, r.n)}% (${r.c}/${r.n})`);
  if (s.weakTopics.length) {
    lines.push('', '⚠️ *Weakest topics*');
    for (const r of s.weakTopics) lines.push(`• ${r.subject} › ${r.topic} · ${pct(r.c, r.n)}%`);
  }
  const buttons = [{ id: 'coach', title: '🎯 Coach' }, ...(rc.due ? [{ id: 'revise', title: '🔁 Revise' }] : []), { id: 'next', title: '➡️ Question' }];
  await sendWithButtons(phone, lines.join('\n'), buttons);
}

async function setDaily(phone, user, arg) {
  if (!arg) {
    return wa.sendText(phone, `Daily question is *${user.daily_enabled ? 'on' : 'off'}* at ${user.daily_time} (${config.timezone})${user.daily_subject ? `, ${user.daily_subject} only` : ''}.\nChange it with *daily 21:00*, *daily off*, *daily pharma* or *daily all*.`);
  }
  if (/^(off|stop|no)$/i.test(arg)) {
    await store.updateUser(phone, { daily_enabled: false });
    return wa.sendText(phone, 'Daily question turned off. Send *daily on* to restart.');
  }
  if (/^(on|start|yes)$/i.test(arg)) {
    await store.updateUser(phone, { daily_enabled: true });
    return wa.sendText(phone, `Daily question is on at ${user.daily_time}.`);
  }
  const t = arg.match(/^(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?$/i);
  if (t) {
    let h = Number(t[1]);
    const m = Number(t[2] || 0);
    if (t[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
    if (t[3]?.toLowerCase() === 'am' && h === 12) h = 0;
    if (h > 23 || m > 59) return wa.sendText(phone, 'That time looks off. Try *daily 07:30* or *daily 9pm*.');
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    await store.updateUser(phone, { daily_time: time, daily_enabled: true });
    return wa.sendText(phone, `⏰ You'll get a question every day at ${time} (${config.timezone}).`);
  }
  if (/^(all|any|mixed)$/i.test(arg)) {
    await store.updateUser(phone, { daily_subject: null });
    return wa.sendText(phone, 'Daily question will come from all subjects.');
  }
  const subject = matchSubject(arg);
  if (subject) {
    await store.updateUser(phone, { daily_subject: subject });
    return wa.sendText(phone, `Daily question will come from ${subject}.`);
  }
  return wa.sendText(phone, 'Try *daily 07:30*, *daily off*, *daily pharma* or *daily all*.');
}

async function testPicker(phone) {
  const rows = await store.bankSummary();
  const counts = {};
  for (const r of rows) counts[r.subject] = (counts[r.subject] || 0) + r.n;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 9);
  if (!top.length) return wa.sendText(phone, 'Your question bank is empty. Send me some material first.');
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await wa.sendList(
    phone,
    'Which subject should the test cover?',
    'Pick subject',
    [{ id: 'tsub:*', title: 'All subjects', description: `${total} questions` }, ...top.map(([s, n]) => ({ id: `tsub:${s}`, title: s, description: `${n} questions` }))],
    'Subjects'
  );
}

/** Parse "test pharma 20 pyq 2022 thyroid" into options. */
export function parseTestArgs(text) {
  const opts = { count: null, subject: null, pyqOnly: false, year: null, topic: null };
  const rest = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (/^(19|20)\d{2}$/.test(tok)) opts.year = tok;
    else if (/^\d{1,3}$/.test(tok)) opts.count = Number(tok);
    else if (/^pyqs?$/i.test(tok)) opts.pyqOnly = true;
    else if (!opts.subject && matchSubject(tok)) opts.subject = matchSubject(tok);
    else if (!/^(of|on|from|questions?|qs?|mcqs?)$/i.test(tok)) rest.push(tok);
  }
  if (rest.length) opts.topic = rest.join(' ');
  return opts;
}

// ---------- image questions (spotters) ----------

async function saveSpot(phone, { buffer, mimeType, caption }) {
  const m = caption.match(/^spot\b\s*([^:]*):\s*(.+)$/is);
  if (!m || !m[2].trim()) return wa.sendText(phone, 'Put the answer after "spot:", e.g. *spot: Erythema nodosum* (add a subject before the colon if you like: *spot derma: Psoriasis*).');
  if (!/^image\//.test(mimeType || '')) return wa.sendText(phone, 'Image questions need a photo or image file.');
  const answer = m[2].trim().slice(0, 100);
  const named = findSubjectIn(m[1]);
  const cls = classify(answer);
  const subject = named || cls?.subject || 'Medicine';
  const topic = cls && cls.subject === subject ? cls.topic : 'Spotters';
  const sourceId = await store.addSource('spot image', 'image', phone);
  const isNew = await store.addImageQuestion({ subject, topic, answer, image: buffer, mime: mimeType, sourceId });
  if (!isNew) return wa.sendText(phone, 'That image is already in your bank.');
  return wa.sendText(phone, `🖼️ Saved an image question: *${answer}* (${subject}). Send *spot* to be quizzed.`);
}

async function askSpot(phone, user, arg) {
  if (user.state.test) return wa.sendText(phone, 'Finish your test first (or send *stop*), then send *spot*.');
  const item = await store.pickImageQuestion(phone, matchSubject(arg));
  if (!item) {
    return wa.sendText(phone, 'No image questions yet. Send a photo (an X-ray, specimen, skin lesion, instrument…) with the caption *spot: <answer>* to add one.');
  }
  const wrong = await store.imageDistractors(item.id, item.subject, item.answer, 3);
  await wa.sendImage(phone, Buffer.from(item.image), item.image_mime || 'image/jpeg', `🖼️ Spot it · ${item.subject}\nWhat is this?`);
  if (wrong.length >= 3) {
    const options = shuffle([item.answer, ...wrong]);
    await store.updateUser(phone, { state: { ...user.state, current: null, spot: { qid: item.id, options, answer: options.indexOf(item.answer) } } });
    return wa.sendList(
      phone,
      `${options.map((o, i) => `*${LETTERS[i]}.* ${o}`).join('\n')}\n\nTap an option or reply A, B, C or D.`,
      'Answer',
      options.map((o, i) => ({ id: `spot:${item.id}:${i}`, title: LETTERS[i], description: o })),
      'Choose one'
    );
  }
  await store.updateUser(phone, { state: { ...user.state, current: null, spot: { qid: item.id, free: true, answerText: item.answer } } });
  return wa.sendText(phone, 'Type your answer. (Once you have 4 or more image questions I give you options to pick from.)');
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameAnswer = (a, b) => {
  const x = norm(a);
  const y = norm(b);
  return Boolean(x) && (x === y || (x.length >= 4 && (y.includes(x) || x.includes(y))));
};

async function answerSpot(phone, user, { index = null, text = null, qid = null }) {
  const spot = user.state.spot;
  if (!spot || (qid != null && spot.qid !== qid)) return wa.sendText(phone, 'That image question is already closed. Send *spot* for another.');
  const right = spot.free ? spot.answerText : spot.options[spot.answer];
  const correct = spot.free ? sameAnswer(text, right) : index === spot.answer;
  await store.recordAttempt(phone, spot.qid, correct ? 0 : 1, correct, 'spot');
  await store.updateUser(phone, { state: { ...user.state, spot: null } });
  return wa.sendText(phone, `${correct ? `✅ *Correct!* It's ${right}.` : `❌ It's *${right}*.`}\n\nSend *spot* for another.`);
}

// ---------- voice notes, lectures, YouTube ----------

const MAX_MEDIA = 14 * 1024 * 1024;
const NEED_GEMINI = 'Voice notes, lecture recordings and YouTube links need a Gemini key. Add GEMINI_API_KEY in the bot settings on Render (free at aistudio.google.com).';

async function handleAudio(phone, msg, download) {
  const media = msg.audio || msg.video;
  if (!mediaAvailable()) return wa.sendText(phone, `🎙️ ${NEED_GEMINI}`);
  const { buffer, mimeType } = await download(media.id);
  if (buffer.length > MAX_MEDIA) {
    return wa.sendText(phone, 'That recording is over 14 MB, too big to read in one go. Send a shorter clip, or the YouTube link if the lecture is on YouTube.');
  }
  const mime = (media.mime_type || mimeType || 'audio/ogg').split(';')[0];
  const caption = media.caption || '';
  // Short voice notes are questions; anything long (or captioned "lecture") is study material.
  const lecture = /lecture|class|notes/i.test(caption) || (media.duration || 0) > 300 || buffer.length > 1024 * 1024;
  if (lecture) return handleUpload(phone, { buffer, mimeType: mime, filename: 'lecture recording', caption });
  wa.typing(phone);
  let text;
  try {
    text = await transcribe(buffer, mime);
  } catch (e) {
    if (!(e instanceof AiBusyError)) throw e;
    return wa.sendText(phone, `🎙️ The AI has used up its free quota for now, so I can't listen to voice notes until ${e.resetAt ? whenText(e.resetAt).replace(/^at /, '') : 'later'}. Type your question instead.`);
  }
  if (!text) return wa.sendText(phone, "I couldn't make out any words in that voice note.");
  await wa.sendText(phone, `🎙️ _"${clip(text, 300)}"_`);
  return handle({ ...msg, type: 'text', text: { body: text } }, { download });
}

const YOUTUBE = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?\S*v=|shorts\/|live\/)|youtu\.be\/)[\w-]+\S*/i;

async function handleLink(phone, url, caption) {
  if (!mediaAvailable()) return wa.sendText(phone, `📺 ${NEED_GEMINI}`);
  return handleUpload(phone, { buffer: Buffer.from(url, 'utf8'), mimeType: 'text/uri-list', filename: 'YouTube lecture', caption });
}

// ---------- coach and weekly report ----------

async function coach(phone, user) {
  const s = await store.userStats(phone);
  const rc = await store.reviewCounts(phone);
  const weak = s.weakTopics.slice(0, 3);
  if (!weak.length) {
    return wa.sendText(
      phone,
      `I need a few more answers (3 or more per topic) to find your weak spots. Send *test* to get going.${rc.due ? ` Meanwhile ${plural(rc.due, 'question')} ${rc.due === 1 ? 'is' : 'are'} due for review: send *revise*.` : ''}`
    );
  }
  await store.updateUser(phone, { state: { ...user.state, coach: weak.map((w) => ({ subject: w.subject, topic: w.topic })) } });
  const lines = ['🎯 *Your coach*', 'These topics cost you the most marks right now:'];
  lines.push('');
  weak.forEach((w, i) => lines.push(`${i + 1}. *${w.topic}* · _${w.subject}_\n${bar(pct(w.c, w.n), 5)} ${pct(w.c, w.n)}% (${w.c}/${w.n})`));
  if (rc.due) lines.push('', `🔁 ${plural(rc.due, 'question')} due for review today: send *revise*.`);
  lines.push('', 'Tap one to drill 10 questions on it.');
  return wa.sendList(
    phone,
    lines.join('\n'),
    'Drill',
    weak.map((w, i) => ({ id: `drill:${i}`, title: w.topic, description: `${w.subject} · ${pct(w.c, w.n)}%` })),
    'Weak topics'
  );
}

async function weeklyReport(phone, user) {
  const w = await store.weekSummary(phone);
  if (!w.n && !w.pn) return null;
  const s = await store.userStats(phone);
  const st = await store.streak(phone);
  const rc = await store.reviewCounts(phone);
  const lines = [
    '📅 *Your week*',
    `Answered ${w.n}${w.n ? ` (${pct(w.c, w.n)}% right)` : ''}${w.pn ? `, against ${w.pn} (${pct(w.pc, w.pn)}%) the week before` : ''}`,
    `🔥 Streak: ${plural(st, 'day')}`,
  ];
  if (s.weakTopics.length) {
    lines.push('', '*Work on these next*');
    for (const r of s.weakTopics.slice(0, 3)) lines.push(`- ${r.subject} › ${r.topic}: ${pct(r.c, r.n)}%`);
  }
  if (rc.due) lines.push('', `🔁 ${plural(rc.due, 'question')} due for review.`);
  const today = localNow().date;
  if (user.exam_date && user.exam_date > today) lines.push(`📆 ${plural(daysBetween(today, user.exam_date), 'day')} to your exam.`);
  lines.push('', 'Send *coach* to drill your weak topics.');
  return lines.join('\n');
}

/** Sunday report (called by the scheduler). Returns true if it was sent. */
export async function sendWeekly(phone) {
  const user = await store.getUser(phone);
  if (!wa.isTelegram(phone) && !inWindow(user)) return false;
  const text = await weeklyReport(phone, user);
  if (!text) return false;
  await wa.sendText(phone, text);
  return true;
}

// ---------- flashcards ----------

const CLOZE_SKIP = new Set(
  'which there their these those about after before because between during under other being having would could should also often usually patient patients common commonly'.split(' ')
);

/** Fill-in-the-blank cards from a note, for when there is no AI. */
export function clozeCards(text, n = 5) {
  const sentences = String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.;!?])\s+|\s+[-•]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30 && s.length <= 250);
  const cards = [];
  for (const s of sentences) {
    const words = s.match(/[A-Za-z][A-Za-z0-9-]{4,}|\b\d+(?:\.\d+)?\s?(?:%|mg|mm|cm|ml|kg|days?|weeks?|months?|years?)?/g) || [];
    const usable = words.filter((w) => !CLOZE_SKIP.has(w.toLowerCase()));
    const key =
      usable.find((w) => /^\d/.test(w)) ||
      usable.find((w) => /^[A-Z]/.test(w) && !s.startsWith(w)) ||
      usable.filter((w) => !/^\d/.test(w)).sort((a, b) => b.length - a.length)[0];
    if (!key) continue;
    cards.push({ front: s.replace(key, '____'), back: key.trim() });
    if (cards.length >= n) break;
  }
  return cards;
}

async function startFlash(phone, user, { subject = null, topic = null } = {}) {
  const note = await store.pickNote({ subject, topic });
  if (!note) {
    return wa.sendText(phone, topic || subject ? `No notes on ${topic || subject} yet.` : 'No notes yet. Send me some notes first (PDF, photo or text).');
  }
  let cards = [];
  if (aiAvailable()) {
    try {
      cards = await aiFlashcards(note.content);
    } catch (e) {
      console.error('Flashcards failed, using fill-in-the-blanks:', e.message);
    }
  }
  if (!cards.length) cards = clozeCards(note.content);
  if (!cards.length) return wa.sendText(phone, `That note (${where(note)}) is too short for flashcards. Send *flash* again for another.`);
  const flash = { cards, i: 0, known: 0, missed: [], source: where(note) };
  await store.updateUser(phone, { state: { ...user.state, flash } });
  return showCard(phone, flash);
}

const showCard = (phone, f) =>
  wa.sendButtons(phone, `🃏 *Card ${f.i + 1}/${f.cards.length}* · _${f.source}_\n\n${f.cards[f.i].front}`, [{ id: `flash:show:${f.i}`, title: 'Show answer' }]);

async function flashTap(phone, user, action, index) {
  const f = user.state.flash;
  if (!f || index !== f.i) return wa.sendText(phone, 'That card is done. Send *flash* for more.');
  const card = f.cards[f.i];
  if (action === 'show') {
    return wa.sendButtons(phone, `💡 ${card.back}`, [
      { id: `flash:yes:${f.i}`, title: '✅ Knew it' },
      { id: `flash:no:${f.i}`, title: "❌ Didn't" },
    ]);
  }
  if (action === 'yes') f.known++;
  else f.missed.push(card);
  f.i++;
  if (f.i < f.cards.length) {
    await store.updateUser(phone, { state: { ...user.state, flash: f } });
    return showCard(phone, f);
  }
  await store.updateUser(phone, { state: { ...user.state, flash: null } });
  const lines = [`🃏 Done: you knew *${f.known}/${f.cards.length}*.`];
  if (f.missed.length) {
    lines.push('', '*Go over these*');
    for (const c of f.missed) lines.push(`- ${c.front} → *${c.back}*`);
  }
  lines.push('', 'Send *flash* for another set.');
  return wa.sendText(phone, lines.join('\n'));
}

function parseSubjectTopic(arg) {
  const words = arg.split(/\s+/).filter(Boolean);
  const subject = words.length ? matchSubject(words[0]) : null;
  const topic = (subject ? words.slice(1) : words).join(' ') || null;
  return { subject, topic };
}

// ---------- similar / high-yield ----------

async function similar(phone, user) {
  if (!user.state.lastQid) return wa.sendText(phone, 'Answer a question first, then send *similar*.');
  const q = await store.getQuestion(user.state.lastQid);
  if (!q) return wa.sendText(phone, 'That question is no longer in your bank. Send *q* for a new one.');
  const hits = await store.similarQuestions(q, 5);
  if (!hits.length) return wa.sendText(phone, 'No similar questions in your bank yet.');
  await store.updateUser(phone, { state: { ...user.state, similar: hits.map((h) => h.id) } });
  const lines = [`🔗 *Questions like:* _${clip(q.stem, 80)}_`, ''];
  hits.forEach((h, i) =>
    lines.push(`${i + 1}. ${clip(h.stem, 90)}\n   _${h.subject} › ${h.topic}${h.origin === 'pyq' ? ` · PYQ${h.year ? ' ' + h.year : ''}` : ''}_`)
  );
  return wa.sendButtons(phone, lines.join('\n'), [{ id: 'simtest', title: 'Practise these' }]);
}

async function showHighYield(phone, arg) {
  const subject = matchSubject(arg) || matchSubject(arg.split(/\s+/)[0]);
  const { fromPyq, rows } = await store.highYield(phone, subject);
  if (!rows.length) return wa.sendText(phone, subject ? `No ${subject} questions yet.` : 'Your question bank is empty. Send me some material first.');
  const lines = [
    `⭐ *High-yield${subject ? `: ${subject}` : ''}*`,
    fromPyq ? '_Topics asked most often in your PYQs_' : '_No PYQs tagged yet, so this ranks topics by how many questions you have on them._',
    '',
  ];
  rows.forEach((r, i) => {
    const asked = fromPyq ? (r.years ? `asked in ${plural(r.years, 'year')} (${r.year_list})` : `${r.n} PYQ`) : `${r.n} Q`;
    const mine = r.mine ? `you ${pct(r.mine.c, r.mine.n)}%` : 'not tried yet';
    lines.push(`${i + 1}. ${subject ? '' : `${r.subject} › `}${r.topic}: ${asked} · ${mine}`);
  });
  lines.push('', 'Send *test <topic>* to practise one.');
  return wa.sendText(phone, lines.join('\n'));
}

// ---------- exam countdown and plan ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const GRAND_DAY = 'Grand tests & revision';

/** "2027-01-15", "15-01-2027", "15/1/2027", "15 jan 2027", "Jan 15, 2027" → "2027-01-15", or null. */
export function parseDate(text) {
  const s = String(text).trim().toLowerCase().replace(/,/g, ' ').replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/\s+/g, ' ');
  let y, m, d, x;
  if ((x = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) [y, m, d] = [x[1], x[2], x[3]];
  else if ((x = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [d, m, y] = [x[1], x[2], x[3]];
  else if ((x = s.match(/^(\d{1,2}) ([a-z]+) (\d{4})$/))) [d, m, y] = [x[1], MONTHS.indexOf(x[2].slice(0, 3)) + 1, x[3]];
  else if ((x = s.match(/^([a-z]+) (\d{1,2}) (\d{4})$/))) [m, d, y] = [MONTHS.indexOf(x[1].slice(0, 3)) + 1, x[2], x[3]];
  else return null;
  [y, m, d] = [y, m, d].map(Number);
  if (!m || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return addDays(iso, 0) === iso ? iso : null; // rejects 31 Feb and friends
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(day) {
  const d = new Date(`${day}T12:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
}
const longDate = (day) => `${shortDate(day)} ${day.slice(0, 4)}`;

/**
 * One subject per day until the exam. Days per subject follow exam weight × (1.5 − accuracy),
 * so weak, heavy subjects get more; the last 10% of days (at least 3) are for grand tests and revision.
 */
export function makePlan(today, examDate, accuracy = {}) {
  const days = daysBetween(today, examDate);
  const reserve = Math.min(days, Math.max(3, Math.ceil(days * 0.1)));
  const study = days - reserve;
  const score = Object.fromEntries(
    SUBJECTS.map((s) => {
      const a = accuracy[s];
      return [s, EXAM_WEIGHT[s] * (1.5 - (a && a.n >= 5 ? a.c / a.n : 0.5))];
    })
  );
  const totalScore = Object.values(score).reduce((a, b) => a + b, 0);
  const raw = SUBJECTS.map((s) => [s, (study * score[s]) / totalScore]);
  const alloc = Object.fromEntries(raw.map(([s, v]) => [s, Math.floor(v)]));
  let left = study - Object.values(alloc).reduce((a, b) => a + b, 0);
  for (const [s] of [...raw].sort((a, b) => (b[1] % 1) - (a[1] % 1))) {
    if (left <= 0) break;
    alloc[s]++;
    left--;
  }
  // Smooth weighted round robin, so a subject's days are spread out rather than in one block.
  const seq = [];
  const cur = Object.fromEntries(SUBJECTS.map((s) => [s, 0]));
  for (let i = 0; i < study; i++) {
    let best = null;
    for (const s of SUBJECTS) {
      if (!alloc[s]) continue;
      cur[s] += alloc[s];
      if (!best || cur[s] > cur[best]) best = s;
    }
    cur[best] -= study;
    seq.push(best);
  }
  for (let i = 0; i < reserve; i++) seq.push(GRAND_DAY);
  return { start: today, exam: examDate, days: seq };
}

function planSubject(user, today = localNow().date) {
  const plan = user.state.plan;
  if (!plan || plan.exam !== user.exam_date) return null;
  return plan.days[daysBetween(plan.start, today)] || null;
}

async function askExamDate(phone, user) {
  await store.updateUser(phone, { state: { ...user.state, awaiting: 'exam' } });
  return wa.sendText(phone, '📆 When is your exam? Type the date, e.g. *15-01-2027*.');
}

async function setExam(phone, user, date) {
  const today = localNow().date;
  if (date <= today) return wa.sendText(phone, 'That date is not in the future. Send it like *exam 15-01-2027*.');
  const plan = makePlan(today, date, await store.subjectAccuracy(phone));
  await store.updateUser(phone, { exam_date: date, state: { ...user.state, plan } });
  return wa.sendText(
    phone,
    `📆 Exam on *${longDate(date)}*: ${plural(daysBetween(today, date), 'day')} to go.\nI've made you a day-by-day plan. Send *plan* to see it or *today* for today's subject. Your daily question now follows the plan.`
  );
}

async function showPlan(phone, user, arg) {
  if (!user.exam_date) return wa.sendText(phone, 'Tell me your exam date first, e.g. *exam 15-01-2027*.');
  const today = localNow().date;
  const left = daysBetween(today, user.exam_date);
  if (left <= 0) return wa.sendText(phone, 'Your exam date has passed. Set the next one with *exam <date>*.');
  let state = user.state;
  if (/^(new|redo|again|rebalance|reset)$/i.test(arg) || !planSubject(user, today)) {
    state = { ...state, plan: makePlan(today, user.exam_date, await store.subjectAccuracy(phone)) };
    await store.updateUser(phone, { state });
  }
  const plan = state.plan;
  const offset = daysBetween(plan.start, today);
  const remaining = plan.days.slice(offset);
  const counts = {};
  for (const s of remaining) if (s !== GRAND_DAY) counts[s] = (counts[s] || 0) + 1;
  const reserve = remaining.filter((s) => s === GRAND_DAY).length;
  const lines = [
    `📆 *D-${left}* · exam on ${longDate(user.exam_date)}`,
    '',
    '*Days per subject*',
    Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(' · '),
    `Last ${plural(reserve, 'day')}: grand tests and revision`,
    '',
    '*Next 7 days*',
  ];
  remaining.slice(0, 7).forEach((s, i) => lines.push(`- ${i === 0 ? 'Today' : shortDate(addDays(today, i))}: ${s}`));
  lines.push('', 'Weaker, heavier subjects get more days. Send *plan new* to rebalance after more practice.');
  return wa.sendText(phone, lines.join('\n'));
}

async function showToday(phone, user) {
  if (!user.exam_date) return wa.sendText(phone, 'Tell me your exam date first, e.g. *exam 15-01-2027*. Then I plan a subject for each day.');
  const today = localNow().date;
  const left = daysBetween(today, user.exam_date);
  if (left <= 0) return wa.sendText(phone, 'Your exam date has passed. Set the next one with *exam <date>*.');
  let subject = planSubject(user, today);
  if (!subject) {
    const plan = makePlan(today, user.exam_date, await store.subjectAccuracy(phone));
    await store.updateUser(phone, { state: { ...user.state, plan } });
    subject = plan.days[0];
  }
  if (subject === GRAND_DAY) {
    return wa.sendButtons(phone, `📆 *D-${left}* · Today: grand tests and revision.`, [
      { id: 'grand', title: 'Grand test' },
      { id: 'revise', title: 'Revise' },
    ]);
  }
  return wa.sendButtons(phone, `📆 *D-${left}* · Today: *${subject}*.`, [
    { id: `ptest:${subject}`, title: '10-question test' },
    { id: `pflash:${subject}`, title: 'Flashcards' },
    { id: `phy:${subject}`, title: 'High-yield' },
  ]);
}

function dailyContext(user) {
  const today = localNow().date;
  const parts = ['Question of the day'];
  let subject = user.daily_subject;
  if (user.exam_date && user.exam_date > today) {
    parts.push(`D-${daysBetween(today, user.exam_date)}`);
    const p = planSubject(user, today);
    if (p) {
      parts.push(`Today: ${p === GRAND_DAY ? 'grand test' : p}`);
      if (!subject && p !== GRAND_DAY) subject = p;
    }
  }
  if (user.buddy_group) parts.push('same for your group');
  return { header: parts.join(' · '), subject };
}

/** The daily question: follows the plan, and is the same for everyone in a buddy group. */
async function dailyQuestion(phone, user) {
  let { header, subject } = dailyContext(user);
  if (subject && !user.daily_subject && !(await store.countQuestions({ subject }))) subject = null;
  const pick = async () => (await store.pickQuestions(phone, { count: 1, subject }))[0] || (await store.pickQuestions(phone, { count: 1 }))[0];
  const qid = user.buddy_group ? await store.groupDailyQuestion(user.buddy_group, localNow().date, pick) : null;
  return askSingle(phone, user, { subject, mode: 'daily', qid, header });
}

// ---------- study buddies ----------

const displayName = (u) => u.name || (wa.isTelegram(u.phone) ? 'Telegram friend' : `…${String(u.phone).slice(-4)}`);

async function buddy(phone, user, rest) {
  const [sub, arg] = rest.split(/\s+/);
  if (/^(add|join)$/i.test(sub || '')) {
    if (!arg) return wa.sendText(phone, "Send *buddy add CODE* with your friend's code.");
    const other = await store.findUserByCode(arg);
    if (!other) return wa.sendText(phone, `No one has the code ${arg.toUpperCase()}. Ask your friend to send *buddy* to see theirs.`);
    if (other.phone === phone) return wa.sendText(phone, "That's your own code. Share it with a friend; they send *buddy add* with it.");
    const group = other.buddy_group || `g${store.buddyCode(other.phone)}`;
    if (!other.buddy_group) await store.updateUser(other.phone, { buddy_group: group });
    await store.updateUser(phone, { buddy_group: group });
    const members = await store.groupMembers(group);
    return wa.sendText(
      phone,
      `👥 You joined ${displayName(other)}'s group (${plural(members.length, 'member')}). You'll all get the same question of the day. Send *lb* for this week's leaderboard.`
    );
  }
  if (/^(leave|exit|quit)$/i.test(sub || '')) {
    await store.updateUser(phone, { buddy_group: null });
    return wa.sendText(phone, 'You left your study group.');
  }
  const lines = [
    '👥 *Study buddies*',
    `Your code: *${store.buddyCode(phone)}*`,
    'A friend using this bot sends *buddy add <your code>* to join you. You then get the same daily question and a weekly leaderboard (*lb*).',
  ];
  if (user.buddy_group) {
    const members = await store.groupMembers(user.buddy_group);
    lines.push('', '*Your group*', ...members.map((m) => `- ${displayName(m)}${m.phone === phone ? ' (you)' : ''}`), '', 'Send *buddy leave* to leave.');
  }
  if (!user.name) lines.push('', 'Set the name your friends see: *name Harsh*.');
  return wa.sendText(phone, lines.join('\n'));
}

async function leaderboard(phone, user) {
  const members = user.buddy_group ? await store.groupMembers(user.buddy_group) : [{ phone, name: user.name }];
  const board = await store.weekBoard(members.map((m) => m.phone));
  const rows = members.map((m) => ({ ...m, ...board[m.phone], phone: m.phone })).sort((a, b) => b.c - a.c || b.n - a.n);
  const medal = (i) => ['🥇', '🥈', '🥉'][i] || `${i + 1}.`;
  const lines = ['🏆 *Leaderboard* (last 7 days)', ''];
  rows.forEach((r, i) =>
    lines.push(`${medal(i)} ${displayName(r)}${r.phone === phone ? ' (you)' : ''}: ${r.c} right of ${r.n} · ${r.days}/7 days · 🔥${r.streak}`)
  );
  if (!user.buddy_group) lines.push('', 'Send *buddy* to add friends and compete.');
  return wa.sendText(phone, lines.join('\n'));
}

// ---------- uploads ----------

// Render's free plan sleeps after 15 idle minutes, which would kill a long upload; ping ourselves meanwhile.
function keepAwake() {
  if (!config.publicUrl) return () => {};
  const t = setInterval(() => fetch(`${config.publicUrl.replace(/\/$/, '')}/health`).catch(() => {}), 4 * 60 * 1000);
  return () => clearInterval(t);
}

const progressTo = (phone) => (msg) => wa.sendText(phone, msg).catch((e) => console.error('Progress message failed:', e.message));

const UPLOAD_BUTTONS = [
  { id: 'next', title: '➡️ Practise' },
  { id: 'bank', title: '📚 Bank' },
];

// Uploads can take many minutes, so they run outside the per-user lock: the user can practise meanwhile.
const background = new AsyncLocalStorage();
function afterLock(work) {
  const later = background.getStore();
  if (!later) return work;
  later.push(work);
}

function handleUpload(phone, { buffer, mimeType, filename, caption }) {
  return afterLock(
    (async () => {
      const stop = keepAwake();
      try {
        await wa.sendText(phone, `📥 Got ${filename ? `*${filename}*` : 'it'}. Reading and sorting it now; big files can take a few minutes.`);
        wa.typing(phone);
        const summary = await ingest({ buffer, mimeType, filename, caption, addedBy: phone, onProgress: progressTo(phone) });
        const text = formatSummary(summary, filename);
        if (summary.questions) await sendWithButtons(phone, text, UPLOAD_BUTTONS, 'Ready to practise?');
        else await wa.sendText(phone, text);
      } catch (e) {
        console.error('Upload failed', e);
        await wa.sendText(phone, `Sorry, I couldn't read ${filename ? `*${filename}*` : 'that'}: ${clip(String(e.message || e), 200)}`).catch(() => {});
      } finally {
        stop();
      }
    })()
  );
}

/** Carry on with uploads interrupted by a restart or paused for AI quota (called by the scheduler). */
export async function resumeJobs() {
  for (const { id } of await store.resumableJobs()) {
    const job = await store.getJob(id);
    if (!job?.data || !isAllowed(job.phone)) {
      await store.updateJob(id, { status: 'failed', data: null });
      continue;
    }
    const stop = keepAwake();
    try {
      console.log(`Resuming upload ${id} (${job.filename}), ${(job.done_parts || []).length}/${job.parts} parts done`);
      const summary = await runJob(id, { onProgress: progressTo(job.phone) });
      if (!summary) continue; // already running
      if (summary.paused && job.status === 'paused') continue; // still no quota; it tells the user only once
      const text = formatSummary(summary, job.filename);
      await wa.sendText(job.phone, summary.paused ? text : `📄 Finished reading *${job.filename}*.\n\n${text}`);
    } catch (e) {
      console.error(`Upload ${id} failed:`, e);
      await store.updateJob(id, { status: 'failed', data: null }).catch(() => {});
      await wa.sendText(job.phone, `Sorry, I couldn't finish reading *${job.filename}*: ${clip(String(e.message || e), 200)}`).catch(() => {});
    } finally {
      stop();
    }
  }
}

const guessMime = (name = '') =>
  ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[
    name.split('.').pop().toLowerCase()
  ] || 'text/plain';

const looksLikeMaterial = (text) => text.length > 500 || (/\n\s*\(?[aA]\s*[).]/.test(text) && /\n\s*\(?[dD]\s*[).]/.test(text));


// ---------- menus ----------

// Most-used first: WhatsApp lists show only the first 10.
const MAIN_MENU = [
  { id: 'm:q', title: '📝 Question', description: 'One question now' },
  { id: 'm:test', title: '🧪 Test', description: 'Pick a subject and length' },
  { id: 'm:revise', title: '🔁 Revise', description: 'Questions due for review' },
  { id: 'm:grand', title: '🏆 Grand mock', description: 'Timed, +4/−1' },
  { id: 'm:today', title: '📆 Today & plan', description: 'Your plan to exam day' },
  { id: 'm:coach', title: '🎯 Coach', description: 'Drill your weakest topics' },
  { id: 'm:flash', title: '🃏 Flashcards', description: 'From your notes' },
  { id: 'm:hy', title: '⭐ High-yield', description: 'Most-asked PYQ topics' },
  { id: 'm:stats', title: '📊 Stats', description: 'Your progress' },
  { id: 'm:db', title: '🗂 Database', description: 'Files, fixes, deletions' },
  { id: 'm:spot', title: '🖼 Spot', description: 'Image question' },
  { id: 'm:settings', title: '⚙️ Settings', description: 'Daily time, exam, name' },
  { id: 'm:ask', title: '🧠 Ask', description: 'Ask from your notes' },
  { id: 'm:help', title: '📖 All commands', description: 'Typed shortcuts' },
];

async function showMenu(phone, user) {
  const [t, rc, st] = [await store.dbTotals(), await store.reviewCounts(phone), await store.streak(phone)];
  const lines = [
    `📚 *NEET PG Study Bot*${user.name ? ` · Hi ${user.name}!` : ''}`,
    '',
    `🗃 ${plural(t.questions, 'question')} · ${plural(t.notes, 'note section')}`,
    `${st ? `🔥 ${plural(st, 'day')} streak` : '🌱 Answer a question to start a streak'}${rc.due ? ` · 🔁 ${rc.due} due today` : ''}`,
  ];
  if (user.exam_date && user.exam_date > localNow().date) lines.push(`📆 D-${daysBetween(localNow().date, user.exam_date)} to your exam`);
  lines.push('', 'What would you like to do? You can also just ask a question or send a PDF.');
  if (wa.isTelegram(phone) && !user.state.kb) {
    // Install the quick-access keyboard once.
    await store.updateUser(phone, { state: { ...user.state, kb: true } });
    await wa.sendWithKeyboard(phone, '⌨️ Quick buttons are under the chat box.');
  }
  return wa.sendMenu(phone, lines.join('\n'), wa.isTelegram(phone) ? MAIN_MENU : MAIN_MENU.slice(0, 10), 2, 'Open menu');
}

const BACK = { id: 'm:menu', title: '🏠 Menu' };

async function showSettings(phone, user) {
  const lines = [
    '⚙️ *Settings*',
    '',
    `⏰ Daily question: *${user.daily_enabled ? `on at ${user.daily_time}` : 'off'}*${user.daily_subject ? ` · ${user.daily_subject} only` : ''}`,
    `📆 Exam date: *${user.exam_date ? longDate(user.exam_date) : 'not set'}*`,
    `👤 Name: *${user.name || 'not set'}*`,
  ];
  return wa.sendMenu(phone, lines.join('\n'), [
    { id: 'set:time', title: '⏰ Daily time' },
    { id: user.daily_enabled ? 'set:off' : 'set:on', title: user.daily_enabled ? '🔕 Daily off' : '🔔 Daily on' },
    { id: 'set:exam', title: '📆 Exam date' },
    { id: 'set:name', title: '👤 Name' },
    { id: 'm:buddy', title: '👥 Study buddies' },
    BACK,
  ]);
}

const DAILY_TIMES = ['06:00', '07:00', '08:00', '12:00', '16:00', '19:00', '21:00', '22:00'];

// ---------- managing the database ----------

async function dbMenu(phone, user) {
  const t = await store.dbTotals();
  const jobs = await store.activeJobs();
  const lines = [
    '🗂 *Your database*',
    '',
    `📝 ${plural(t.questions, 'question')}${t.pyq ? ` (${t.pyq} PYQ)` : ''}`,
    `📖 ${plural(t.notes, 'note section')}`,
    t.images ? `🖼 ${plural(t.images, 'image question')}` : null,
    `📄 ${plural(t.files, 'uploaded file')}`,
  ];
  lines.splice(0, lines.length, ...lines.filter((l) => l !== null));
  if (t.unchecked) lines.push(`⚠️ ${t.unchecked} answers worked out by AI (no key in the source)`);
  if (jobs.length) {
    lines.push('', '⏳ *Still reading*');
    for (const j of jobs) {
      const done = (j.done_parts || []).length;
      lines.push(`• ${j.filename}: ${done}/${j.parts} parts${j.status === 'paused' ? ` · resumes ${whenText(j.resume_at)}` : ''}`);
    }
  }
  const last = user.state.lastQid ? [{ id: 'db:fix', title: '✏️ Fix last answer' }, { id: 'db:delq', title: '🗑 Delete last Q' }] : [];
  return wa.sendMenu(phone, lines.join('\n'), [{ id: 'db:files:0', title: '📄 My uploads' }, { id: 'bank', title: '📚 By subject' }, ...last, BACK]);
}

const PAGE = 8;
const fileDate = (d) => new Date(d).toLocaleDateString('en-GB', { timeZone: config.timezone, day: 'numeric', month: 'short' });
const fileLine = (f) => `${f.questions} Q · ${f.notes} notes · ${fileDate(f.created_at)}`;

async function dbFiles(phone, offset = 0) {
  const files = await store.listSources(PAGE + 1, offset);
  if (!files.length) return wa.sendButtons(phone, '📄 No uploads yet. Send me a PDF, photo or text to start.', [BACK]);
  const rows = files.slice(0, PAGE).map((f) => ({ id: `dbf:${f.id}`, title: clip(f.filename || 'untitled', 24), description: fileLine(f) }));
  if (files.length > PAGE) rows.push({ id: `db:files:${offset + PAGE}`, title: '➡️ Older files' });
  rows.push({ id: 'm:db', title: '⬅️ Back' });
  const body = `📄 *Your uploads*${offset ? ` (from #${offset + 1})` : ''}\n\nTap a file to see it or delete it.`;
  return wa.isTelegram(phone) ? wa.sendMenu(phone, body, rows.map((r) => ({ ...r, title: r.description ? `${r.title} · ${r.description}` : r.title })), 1) : wa.sendList(phone, body, 'Files', rows, 'Uploads');
}

async function dbFile(phone, id) {
  const f = await store.getSource(id);
  if (!f) return wa.sendButtons(phone, 'That file is no longer in your database.', [{ id: 'db:files:0', title: '📄 My uploads' }]);
  return wa.sendButtons(phone, `📄 *${f.filename || 'untitled'}*\n\n📝 ${plural(f.questions, 'question')}\n📖 ${plural(f.notes, 'note section')}\n📅 Added ${fileDate(f.created_at)}`, [
    { id: `dbdel:${f.id}`, title: '🗑 Delete file' },
    { id: 'db:files:0', title: '⬅️ Back' },
  ]);
}

async function dbConfirmDelete(phone, id) {
  const f = await store.getSource(id);
  if (!f) return wa.sendText(phone, 'That file is no longer in your database.');
  return wa.sendButtons(phone, `⚠️ Delete *${f.filename || 'untitled'}* and its ${plural(f.questions, 'question')} and ${plural(f.notes, 'note section')}? Your answers to those questions go too. This can't be undone.`, [
    { id: `dbdelok:${f.id}`, title: '🗑 Yes, delete' },
    { id: 'm:db', title: '✖️ Cancel' },
  ]);
}

async function dbFixPrompt(phone, user) {
  const q = user.state.lastQid && (await store.getQuestion(user.state.lastQid));
  if (!q) return wa.sendText(phone, 'Answer a question first; then you can fix its answer key here.');
  return wa.sendMenu(
    phone,
    `✏️ *Fix the answer key*\n\n*${clip(q.stem, 300)}*\n\n${q.options.map((o, i) => `${i === q.answer ? '✅' : '▫️'} *${LETTERS[i]}.* ${o}`).join('\n')}\n\nWhich option is correct?`,
    [...q.options.map((o, i) => ({ id: `dbfix:${q.id}:${i}`, title: `${LETTERS[i]}. ${clip(o, 20)}` })), { id: 'm:db', title: '✖️ Cancel' }]
  );
}

async function dbFix(phone, user, qid, index) {
  const q = await store.getQuestion(qid);
  if (!q || !(index >= 0 && index < q.options.length)) return wa.sendText(phone, 'That question is no longer in your database.');
  await store.setAnswer(qid, index);
  return wa.sendButtons(phone, `✅ Saved. The answer is now *${LETTERS[index]}. ${q.options[index]}*.`, [{ id: 'next', title: '➡️ Next' }, { id: 'm:db', title: '🗂 Database' }]);
}

async function dbDeletePrompt(phone, user) {
  const q = user.state.lastQid && (await store.getQuestion(user.state.lastQid));
  if (!q) return wa.sendText(phone, 'Answer a question first; then you can delete it here.');
  return wa.sendButtons(phone, `⚠️ Delete this question?\n\n_${clip(q.stem, 300)}_`, [
    { id: `dbdq:${q.id}`, title: '🗑 Yes, delete' },
    { id: 'm:db', title: '✖️ Cancel' },
  ]);
}

async function dbDeleteQuestion(phone, user, qid) {
  const ok = await store.deleteQuestion(qid);
  const state = { ...user.state };
  if (state.lastQid === qid) state.lastQid = null;
  if (state.current?.qid === qid) state.current = null;
  await store.updateUser(phone, { state });
  return wa.sendButtons(phone, ok ? '🗑 Question deleted.' : 'That question was already gone.', [{ id: 'next', title: '➡️ Next' }, { id: 'm:db', title: '🗂 Database' }]);
}

// ---------- entry point ----------

/**
 * Handle one inbound WhatsApp message (the `messages[i]` object from the webhook).
 * `download(mediaId)` is injectable for tests.
 */
export async function handleMessage(msg, opts = {}) {
  const later = [];
  await background.run(later, () => withLock(msg.from, () => handle(msg, opts)));
  await Promise.all(later);
}

// One message at a time per user, so two quick taps can't both answer the same question or clobber each other's state.
const queues = new Map();
function withLock(key, fn) {
  const run = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => queues.get(key) === tail && queues.delete(key));
  return run;
}

const ONBOARDING = (name) => `👋 Hi${name ? ` ${name}` : ''}! I'm your NEET PG study partner.

*1.* Send me your material: a PDF, a photo of a page, or pasted text. Notes, question banks and PYQs all work; I sort everything by subject and topic.
*2.* Practise: *q* for one question, *test* for a test, *grand* for a timed mock.
*3.* Ask me anything, e.g. "DOC for absence seizures?", and I answer from your notes.

Every morning I send a question of the day. Tap *🏠 Menu* any time to find everything.`;

async function handle(msg, { download = (id) => wa.downloadMedia(msg.from, id) } = {}) {
  const phone = msg.from;
  if (msg.callbackId) answerCallback(msg.callbackId);
  if (!isAllowed(phone)) {
    // Telegram bots are public, so strangers can find them. Tell them their id so the owner can allow it.
    if (wa.isTelegram(phone)) {
      await wa.sendText(phone, `This is a private bot. Your Telegram ID is ${phone.slice(3)}. To use it, add that number to TELEGRAM_ALLOWED_IDS in the bot's settings.`);
    }
    return;
  }
  try {
    const user = await store.getUser(phone);
    const firstContact = !user.last_inbound_at;
    // A brand-new user starts getting the daily question tomorrow, not a minute after saying hi.
    const name = !user.name && msg.firstName ? String(msg.firstName).slice(0, 30) : null;
    await store.updateUser(phone, {
      last_inbound_at: new Date().toISOString(),
      ...(firstContact ? { last_daily_date: localNow().date } : {}),
      ...(name ? { name } : {}),
    });
    if (name) user.name = name;
    if (firstContact && msg.type === 'text' && /^(hi|hello|hey|start|help|menu)\b/i.test(msg.text?.body || '')) {
      await wa.sendWithKeyboard(phone, ONBOARDING(user.name));
      user.state = { ...user.state, kb: true };
      await store.updateUser(phone, { state: user.state });
      return await showMenu(phone, user);
    }

    // Uploads
    if (msg.type === 'audio' || msg.type === 'video') return await handleAudio(phone, msg, download);
    if (msg.type === 'document' || msg.type === 'image') {
      const media = msg[msg.type];
      let file;
      try {
        file = await download(media.id);
      } catch (e) {
        console.error('Download failed:', e.message);
        const name = media.filename ? `*${media.filename}*` : 'that file';
        if (/too big/i.test(e.message)) return await wa.sendText(phone, `📥 ${name} is over Telegram's 20 MB limit for bots. Split it into smaller PDFs (or compress it) and send the parts.`);
        return await wa.sendText(phone, `📥 I couldn't download ${name} (connection problem). Please send it again.`);
      }
      const { buffer, mimeType } = file;
      const mime = media.mime_type || mimeType || guessMime(media.filename);
      if (/^spot\b/i.test(media.caption || '')) return await saveSpot(phone, { buffer, mimeType: mime, caption: media.caption });
      return await handleUpload(phone, {
        buffer,
        mimeType: mime,
        filename: media.filename || (msg.type === 'image' ? 'photo' : 'document'),
        caption: media.caption || '',
      });
    }

    // Taps on lists / buttons
    const replyId = msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id;
    if (replyId) {
      const [kind, a, b] = replyId.split(':');
      if (kind === 'ans') return await handleAnswer(phone, user, Number(a), Number(b));
      if (kind === 'tsub') {
        await store.updateUser(phone, { state: { ...user.state, pendingTestSubject: a === '*' ? null : a } });
        return await wa.sendButtons(phone, 'How many questions?', [
          { id: 'tcnt:10', title: '10 questions' },
          { id: 'tcnt:25', title: '25 questions' },
          { id: 'tcnt:50', title: '50 questions' },
        ]);
      }
      if (kind === 'tcnt') return await startTest(phone, user, { subject: user.state.pendingTestSubject || null, count: Number(a) });
      if (kind === 'daily') return await dailyQuestion(phone, user);
      if (kind === 'gskip') {
        if (!user.state.test?.grand || user.state.current?.qid !== Number(a)) return await wa.sendText(phone, 'That question is already closed.');
        return await grandSkip(phone, user);
      }
      if (kind === 'spot') return await answerSpot(phone, user, { qid: Number(a), index: Number(b) });
      if (kind === 'flash') return await flashTap(phone, user, a, Number(b));
      if (kind === 'simtest') {
        const ids = user.state.similar || [];
        if (!ids.length) return await wa.sendText(phone, 'Send *similar* first.');
        return await startTest(phone, user, { ids, count: ids.length, label: 'Similar questions' });
      }
      if (kind === 'drill') {
        const d = user.state.coach?.[Number(a)];
        if (!d) return await coach(phone, user);
        return await startTest(phone, user, { subject: d.subject, topic: d.topic, count: 10 });
      }
      if (kind === 'ptest') return await startTest(phone, user, { subject: a, count: 10 });
      if (kind === 'pflash') return await startFlash(phone, user, { subject: a });
      if (kind === 'phy') return await showHighYield(phone, a);
      if (kind === 'm') {
        if (a === 'menu') return await showMenu(phone, user);
        if (a === 'q') return await askSingle(phone, user);
        if (a === 'test') return (await testRunning(phone, user)) || (await testPicker(phone));
        if (a === 'revise') return await startTest(phone, user, { wrongOnly: true, count: 20 });
        if (a === 'grand') return await grandChooser(phone, user);
        if (a === 'today') return user.exam_date ? await showToday(phone, user) : await askExamDate(phone, user);
        if (a === 'coach') return await coach(phone, user);
        if (a === 'flash') return await startFlash(phone, user);
        if (a === 'hy') return await showHighYield(phone, '');
        if (a === 'stats') return await showStats(phone);
        if (a === 'db') return await dbMenu(phone, user);
        if (a === 'spot') return await askSpot(phone, user, '');
        if (a === 'settings') return await showSettings(phone, user);
        if (a === 'buddy') return await buddy(phone, user, '');
        if (a === 'ask') return await wa.sendText(phone, '🧠 Type your question, e.g. _"DOC for absence seizures?"_ or _"explain thyroid storm"_. I answer from your notes and cite them.');
        if (a === 'help') return await sendWithButtons(phone, HELP, [BACK], 'Back to the menu?');
      }
      if (kind === 'set') {
        if (a === 'on' || a === 'off') return await setDaily(phone, user, a);
        if (a === 'time') {
          return await wa.sendMenu(phone, `⏰ When should the daily question come? (${config.timezone})
Or type e.g. *daily 07:30*.`, DAILY_TIMES.map((t) => ({ id: `dtime:${t.replace(':', '')}`, title: t })), 4);
        }
        if (a === 'exam') return await askExamDate(phone, user);
        if (a === 'name') {
          await store.updateUser(phone, { state: { ...user.state, awaiting: 'name' } });
          return await wa.sendText(phone, '👤 What should I call you? Type your name.');
        }
      }
      if (kind === 'dtime') return await setDaily(phone, user, `${a.slice(0, 2)}:${a.slice(2)}`);
      if (kind === 'db') {
        if (a === 'files') return await dbFiles(phone, Number(b) || 0);
        if (a === 'fix') return await dbFixPrompt(phone, user);
        if (a === 'delq') return await dbDeletePrompt(phone, user);
      }
      if (kind === 'dbf') return await dbFile(phone, Number(a));
      if (kind === 'dbdel') return await dbConfirmDelete(phone, Number(a));
      if (kind === 'dbdelok') {
        const f = await store.getSource(Number(a));
        if (!f) return await wa.sendText(phone, 'That file was already deleted.');
        const r = await store.deleteSource(f.id);
        return await wa.sendButtons(phone, `🗑 Deleted *${f.filename || 'untitled'}*: ${plural(r.questions, 'question')} and ${plural(r.notes, 'note section')} removed.`, [{ id: 'db:files:0', title: '📄 My uploads' }, BACK]);
      }
      if (kind === 'wipeok') {
        const r = await store.deleteUserData(phone);
        return await wa.sendText(phone, `🗑 Done. Your data is deleted (${plural(r.attempts, 'answer')} removed). Send *menu* any time to start fresh.`);
      }
      if (kind === 'dbfix') return await dbFix(phone, user, Number(a), Number(b));
      if (kind === 'dbdq') return await dbDeleteQuestion(phone, user, Number(a));
      if (kind === 'grand') return await startGrand(phone, user, 200);
      if (kind === 'gstart') return await startGrand(phone, user, Number(a) || 200);
      if (kind === 'revise') return await startTest(phone, user, { wrongOnly: true, count: 20 });
      if (kind === 'next') return await askSingle(phone, user);
      if (kind === 'why') return await why(phone, user, Number(a) || undefined);
      if (kind === 'sim') return await similar(phone, { ...user, state: { ...user.state, lastQid: Number(a) || user.state.lastQid } });
      if (kind === 'newtest') return (await testRunning(phone, user)) || (await testPicker(phone));
      if (kind === 'stats') return await showStats(phone);
      if (kind === 'help') return await wa.sendText(phone, HELP);
      if (kind === 'bank') return await showBank(phone);
      if (kind === 'coach') return await coach(phone, user);
      if (kind === 'reltest') {
        const ids = user.state.related || [];
        if (!ids.length) return await wa.sendText(phone, 'Ask me about a topic first.');
        return await startTest(phone, user, { ids, count: Math.min(ids.length, 20), label: 'Related questions' });
      }
      if (kind === 'tcont') {
        const t = user.state.test;
        if (!t || !user.state.current) return await wa.sendText(phone, 'No test is running. Send *test* to start one.');
        if (t.grand) return await sendGrandQuestion(phone, t);
        return await sendQuestion(phone, await store.getQuestion(user.state.current.qid), `Q ${t.index + 1}/${t.ids.length}`);
      }
      if (kind === 'tend') {
        if (user.state.test?.grand) return await finishGrand(phone, user, user.state.test);
        if (user.state.test) return await finishTest(phone, user, user.state.test);
        return await wa.sendText(phone, 'No test is running.');
      }
    }
    // Quick-reply button on the daily template
    if (msg.type === 'button') return await dailyQuestion(phone, user);

    const text = (msg.text?.body || '').trim();
    if (!text) return await showMenu(phone, user);
    // Quick-keyboard buttons send "📝 Question"; commands work with or without the emoji or a leading slash.
    const cmdText = text.replace(/^[^\p{L}\p{N}(]+/u, '');
    const lower = cmdText.toLowerCase();
    const [cmd, ...restWords] = lower.split(/\s+/);
    const rest = cmdText.slice(cmd.length).trim();

    // A reply to "What should I call you?" or "When is your exam?"
    const awaiting = user.state.awaiting;
    if (awaiting) {
      await store.updateUser(phone, { state: { ...user.state, awaiting: null } });
      user.state = { ...user.state, awaiting: null };
      if (awaiting === 'exam') {
        const date = parseDate(text);
        if (date) return await setExam(phone, user, date);
        if (!/^(menu|home|stop|cancel|help|q|question|test|revise|stats)$/.test(cmd)) {
          await store.updateUser(phone, { state: { ...user.state, awaiting: 'exam' } });
          return await wa.sendText(phone, "I couldn't read that date. Try *15-01-2027* or *15 Jan 2027*.");
        }
      }
      if (awaiting === 'name' && text.length <= 30 && !/^(menu|help|stop|cancel)$/i.test(lower)) {
        await store.updateUser(phone, { name: text });
        return await wa.sendButtons(phone, `👋 Nice to meet you, *${text}*!`, [BACK]);
      }
    }

    // A letter answers the open question.
    const letter = text.match(/^\(?([a-dA-D1-4])\)?\.?$/);
    if (letter && user.state.current) {
      const i = /\d/.test(letter[1]) ? Number(letter[1]) - 1 : LETTERS.indexOf(letter[1].toUpperCase());
      return await handleAnswer(phone, user, user.state.current.qid, i);
    }
    if (letter && user.state.spot && !user.state.spot.free) {
      const i = /\d/.test(letter[1]) ? Number(letter[1]) - 1 : LETTERS.indexOf(letter[1].toUpperCase());
      return await answerSpot(phone, user, { index: i });
    }
    if (letter && !user.state.spot?.free) return await wa.sendText(phone, 'No question is open right now. Send *q* for one.');

    switch (cmd) {
      case 'hi': case 'hello': case 'hey': case 'menu': case 'start': case 'home':
        return await showMenu(phone, user);
      case 'help': case 'commands':
        return await sendWithButtons(phone, HELP, [BACK], 'Back to the menu?');
      case 'settings': case 'setting':
        return await showSettings(phone, user);
      case 'database': case 'db': case 'manage': case 'files': case 'uploads':
        return await dbMenu(phone, user);
      case 'fix': {
        const l = rest.match(/^\(?([a-d])\)?$/i);
        if (!l) return await dbFixPrompt(phone, user);
        if (!user.state.lastQid) return await wa.sendText(phone, 'Answer a question first, then send *fix B* to correct its key.');
        return await dbFix(phone, user, user.state.lastQid, LETTERS.indexOf(l[1].toUpperCase()));
      }
      case 'delete': case 'remove':
        if (/^my\s+(data|account|progress)/i.test(rest)) {
          return await wa.sendButtons(phone, '⚠️ *Delete my data*\n\nThis erases your answers, scores, revision schedule and settings. Uploaded notes and questions stay. This can’t be undone.', [{ id: 'wipeok', title: '🗑 Yes, delete' }, BACK]);
        }
        return await dbDeletePrompt(phone, user);
      case 'q': case 'question': case 'quiz': case 'next':
        return await askSingle(phone, user, { subject: matchSubject(restWords[0]) });
      case 'test':
        if (!rest) return await testPicker(phone);
        return await startTest(phone, user, parseTestArgs(rest));
      case 'exam': {
        const date = rest && parseDate(rest.replace(/^(on|date|is)\s+/i, ''));
        if (date) return await setExam(phone, user, date);
        if (rest) return await startTest(phone, user, parseTestArgs(rest));
        if (user.exam_date) return await showToday(phone, user);
        return await wa.sendText(phone, 'When is your exam? Send it like *exam 15-01-2027* and I will plan your days.');
      }
      case 'grand': case 'mock': case 'fullmock': {
        const n = Number(restWords.find((w) => /^\d+$/.test(w)));
        if (n) return await startGrand(phone, user, n);
        return await grandChooser(phone, user);
      }
      case 'plan': case 'schedule':
        return await showPlan(phone, user, rest);
      case 'today':
        return await showToday(phone, user);
      case 'spot': case 'spotter': case 'spotters': case 'image':
        return await askSpot(phone, user, restWords[0]);
      case 'flash': case 'flashcard': case 'flashcards': case 'cards':
        return await startFlash(phone, user, parseSubjectTopic(rest));
      case 'similar': case 'related': case 'more':
        return await similar(phone, user);
      case 'highyield': case 'hy': case 'high-yield': case 'important':
        return await showHighYield(phone, rest);
      case 'coach': case 'weak': case 'drill':
        return await coach(phone, user);
      case 'due': case 'reviews': {
        const rc = await store.reviewCounts(phone);
        return await wa.sendText(phone, rc.total ? `🔁 ${plural(rc.due, 'question')} due for review today, ${rc.total} in your queue. Send *revise* to start.` : 'Your review queue is empty. Questions you get wrong come back after 1, 3, 7 and 21 days.');
      }
      case 'report': case 'week': case 'weekly':
        return await wa.sendText(phone, (await weeklyReport(phone, user)) || 'Nothing to report yet. Answer a few questions first.');
      case 'name':
        if (!rest) return await wa.sendText(phone, `Your name is ${user.name ? `*${user.name}*` : 'not set'}. Set it with *name Harsh*.`);
        await store.updateUser(phone, { name: rest.slice(0, 30) });
        return await wa.sendText(phone, `👋 Hi ${rest.slice(0, 30)}! Your study buddies will see that name.`);
      case 'buddy': case 'buddies': case 'friends': case 'group':
        return await buddy(phone, user, rest);
      case 'leaderboard': case 'lb': case 'board': case 'rank':
        return await leaderboard(phone, user);
      case 'revise': case 'revision': case 'wrong': case 'mistakes':
        return await startTest(phone, user, { ...parseTestArgs(rest), wrongOnly: true, count: parseTestArgs(rest).count || 20 });
      case 'stop': case 'end': case 'finish': case 'quit':
        if (user.state.test?.grand) return await finishGrand(phone, user, user.state.test);
        if (user.state.test) return await finishTest(phone, user, user.state.test);
        await store.updateUser(phone, { state: { ...user.state, current: null } });
        return await wa.sendText(phone, 'Nothing running. Send *q* or *test* when you are ready.');
      case 'skip':
        if (user.state.test?.grand && user.state.current) return await grandSkip(phone, user);
        if (user.state.test) return await wa.sendText(phone, 'Pick your best guess, or send *stop* to end the test.');
        return await askSingle(phone, user);
      case 'bank': case 'subjects':
        return await showBank(phone);
      case 'stats': case 'progress': case 'score':
        return await showStats(phone);
      case 'daily':
        return await setDaily(phone, user, rest);
      case 'why':
        return await why(phone, user);
      case 'where': case 'find': case 'search': case 'locate':
        if (!rest) return await wa.sendText(phone, 'What should I look for? e.g. *where thyroid storm*');
        return await whereIs(phone, rest.replace(/^(is|are)\s+/i, ''));
      case 'explain': case 'notes': case 'revise-topic': case 'teach':
        if (!rest) {
          if (user.state.lastQid) return await why(phone, user);
          return await wa.sendText(phone, 'What should I explain? For example: *explain thyroid storm*, or just ask "DOC for absence seizures?"');
        }
        return await explain(phone, user, rest.replace(/^(me\s+)?(about\s+)?/i, ''));
    }

    // A typed answer to an image question.
    if (user.state.spot?.free) return await answerSpot(phone, user, { text });
    // A YouTube lecture → notes and questions.
    const yt = text.match(YOUTUBE);
    if (yt) return await handleLink(phone, yt[0], text.replace(yt[0], '').trim());
    // Long pasted text or something shaped like MCQs → add it to the bank.
    if (looksLikeMaterial(text)) {
      return await handleUpload(phone, { buffer: Buffer.from(text, 'utf8'), mimeType: 'text/plain', filename: 'pasted text', caption: '' });
    }
    // Too short or no real words ("?", "ok", an emoji): not a question worth searching for.
    if (!store.searchTerms(text).length) {
      if (/^(ok|okay|k|thanks|thank you|thx|ty|cool|nice|great|👍|🙏)\W*$/i.test(text)) return await wa.sendText(phone, '👍');
      return await wa.sendButtons(phone, "I didn't catch that. Ask me a medical question (e.g. \"DOC for absence seizures?\"), send study material, or pick one:", [
        { id: 'next', title: '➡️ A question' },
        { id: 'newtest', title: '📝 A test' },
        { id: 'help', title: '📖 Help' },
      ]);
    }
    // Anything else is a question for the notes.
    return await explain(phone, user, text);
  } catch (err) {
    console.error('Error handling message', err);
    const reply =
      err instanceof AiBusyError
        ? `The AI has used up its free quota for now${err.resetAt ? ` and is back ${whenText(err.resetAt)}` : ''}. Practice (*q*, *test*) still works.`
        : 'Sorry, something went wrong on my side. Please try again in a moment.';
    await wa.sendText(phone, reply).catch((e) => console.error('Could not send the error reply:', e.message));
  }
}

/** Send today's question to one user (called by the scheduler). */
export async function sendDaily(phone) {
  const user = await store.getUser(phone);
  // Mid-test, a daily question would cut into the test; they're studying anyway.
  if (user.state.test) return false;
  // Telegram has no 24-hour rule; WhatsApp does.
  if (wa.isTelegram(phone) || inWindow(user)) {
    await dailyQuestion(phone, user);
  } else if (config.dailyTemplate.name) {
    // Outside WhatsApp's 24h window only an approved template is allowed; tapping it opens the window.
    await wa.sendTemplate(phone, config.dailyTemplate.name, config.dailyTemplate.lang);
  } else {
    console.log(`Skipping daily question for ${phone}: outside the 24h window and no DAILY_TEMPLATE_NAME set.`);
    return false;
  }
  return true;
}
