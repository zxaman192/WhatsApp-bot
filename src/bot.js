import * as store from './db.js';
import * as wa from './messenger.js';
import { answerCallback } from './telegram.js';
import { config, isAllowed } from './config.js';
import { SUBJECTS, EXAM_WEIGHT, matchSubject, findSubjectIn } from './subjects.js';
import { ingest, formatSummary } from './ingest/index.js';
import { classify } from './ingest/keywords.js';
import { aiAvailable, mediaAvailable, explain as aiExplain, transcribe, flashcards as aiFlashcards } from './ingest/ai.js';
import { localNow, addDays, daysBetween } from './time.js';

const LETTERS = ['A', 'B', 'C', 'D'];

const HELP = `*NEET PG prep bot* 📚

*Add material*
Send a PDF, a photo of a page, or paste text (here or in the Telegram bot; both share one database): notes, a question bank or PYQs. I file each question and note under its subject and topic. A caption like "pharma" helps.
- Photo with caption *spot: <answer>*: saves an image question
- A YouTube link or a lecture recording: notes and MCQs from it
- A voice note: ask anything by voice

*Practise*
- *q*: one question now (*q pharma* for one subject)
- *test*, *test pharma 20*, *test pyq 2022*, *test 10 thyroid*
- *grand*: full 200-question mock, timed, +4/−1 (*grand 50* for a shorter one)
- *revise*: questions due for review; *due* shows how many
- *spot*: an image question
- *flash* / *flash pharma*: flashcards from your notes
- *similar*: questions like the last one
- *stop*: end a test

*Learn from your notes*
- *explain <topic>* or just ask, e.g. "DOC for absence seizures?"
- *where <topic>*: where it appears in your notes and questions
- *why*: explain the last question from your notes
- *hy* / *hy pharma*: high-yield topics from your PYQs

*Plan and track*
- *exam 15-01-2027*: set your exam date; then *plan* and *today*
- *coach*: your weakest topics, with drills
- *bank*, *stats*, *report*
- *daily 07:30*, *daily off*, *daily pharma*
- *name Harsh*, *buddy*, *lb*: study with friends`;

// ---------- helpers ----------

function questionCard(q, header) {
  const tags = [q.subject, q.topic !== 'General' ? q.topic : null].filter(Boolean).join(' › ');
  const pyq = q.origin === 'pyq' ? ` · PYQ${q.year ? ' ' + q.year : ''}${q.exam && q.exam !== 'NEET PG' ? ' ' + q.exam : ''}` : '';
  const opts = q.options.map((o, i) => `*${LETTERS[i]}.* ${o}`).join('\n');
  return `${header ? `*${header}* · ` : ''}_${tags}${pyq}_\n\n${q.stem}\n\n${opts}\n\nTap an option or reply A, B, C or D.`;
}

async function sendQuestion(phone, q, header, { skip = false } = {}) {
  const rows = q.options.map((o, i) => ({ id: `ans:${q.id}:${i}`, title: LETTERS[i], description: o }));
  if (skip) rows.push({ id: `gskip:${q.id}`, title: 'Skip', description: 'Leave it blank (0 marks)' });
  await wa.sendList(phone, questionCard(q, header), 'Answer', rows, 'Choose one');
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pct = (c, n) => (n ? Math.round((100 * c) / n) : 0);
const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const where = (row) => {
  const loc = [row.filename, row.page ? `p.${row.page}` : null].filter(Boolean).join(' ');
  return `${row.subject} › ${row.topic}${loc ? ` (${loc})` : ''}`;
};

/** The best matching passage from the user's notes for a question, or null. */
async function noteReference(q) {
  const hits = await store.searchNotes(`${q.stem} ${q.options[q.answer]}`, { limit: 1, subject: q.subject });
  const hit = hits[0] || (await store.searchNotes(`${q.stem} ${q.options[q.answer]}`, { limit: 1 }))[0];
  return hit ? `📖 *Your notes:* ${where(hit)}\n${hit.snippet}` : null;
}

function inWindow(user) {
  return user.last_inbound_at && Date.now() - new Date(user.last_inbound_at).getTime() < 23.5 * 3600 * 1000;
}

// ---------- practice ----------

async function askSingle(phone, user, { subject = null, mode = 'single', qid = null, header = null } = {}) {
  const id = qid || (await store.pickQuestions(phone, { count: 1, subject }))[0];
  if (!id) {
    await wa.sendText(phone, subject ? `No ${subject} questions yet. Send me some material first.` : 'Your question bank is empty. Send me a PDF, photo or text of notes or questions first.');
    return false;
  }
  const q = await store.getQuestion(id);
  await store.updateUser(phone, { state: { ...user.state, current: { qid: id, mode }, test: null } });
  await sendQuestion(phone, q, header ?? (mode === 'daily' ? 'Question of the day' : null));
  return true;
}

async function startTest(phone, user, opts) {
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
  await wa.sendText(phone, `📝 *Test: ${test.label}*, ${ids.length} questions${note}. Send *stop* any time to finish early.`);
  await sendQuestion(phone, await store.getQuestion(ids[0]), `Q 1/${ids.length}`);
}

async function finishTest(phone, user, test) {
  const answered = test.index;
  const lines = [`🏁 *Test finished: ${test.label}*`, `Score: *${test.correct}/${answered}*${answered ? ` (${Math.round((100 * test.correct) / answered)}%)` : ''}`];
  const topics = Object.entries(test.perTopic).sort((a, b) => a[1].c / a[1].n - b[1].c / b[1].n);
  if (topics.length > 1) {
    lines.push('', '*By topic*');
    for (const [t, v] of topics) lines.push(`- ${t}: ${v.c}/${v.n}`);
  }
  if (test.wrong.length) {
    lines.push('', '*Review these*');
    for (const w of test.wrong.slice(0, 15)) lines.push(`- ${w}`);
    lines.push('', 'Send *revise* to retry the ones you got wrong.');
  }
  await store.updateUser(phone, { state: { ...user.state, test: null, current: null } });
  await wa.sendText(phone, lines.join('\n'));
}

async function handleAnswer(phone, user, qid, chosen) {
  const cur = user.state.current;
  if (!cur || cur.qid !== qid) {
    await wa.sendText(phone, 'That question is already closed. Send *q* for a new one.');
    return;
  }
  const q = await store.getQuestion(qid);
  const correct = chosen === q.answer;
  await store.recordAttempt(phone, qid, chosen, correct, cur.mode);
  const due = await store.scheduleReview(phone, qid, correct);
  if (cur.mode === 'grand' && user.state.test?.grand) return grandStep(phone, user, q, correct ? 'c' : 'w');

  const lines = [
    correct ? `✅ *Correct!* ${LETTERS[q.answer]}. ${q.options[q.answer]}` : `❌ You chose ${LETTERS[chosen]}. Correct answer: *${LETTERS[q.answer]}. ${q.options[q.answer]}*`,
  ];
  if (q.explanation) lines.push('', q.explanation);
  if (!q.answer_checked) lines.push('', '_The source had no answer key; this answer was worked out by AI, so double-check it._');
  const ref = await noteReference(q);
  if (ref) lines.push('', ref);
  else if (q.filename) lines.push('', `📄 From ${q.filename}${q.page ? ` p.${q.page}` : ''}`);
  if (!correct && due) lines.push('', `🔁 I'll bring this one back on ${shortDate(due)}.`);

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
  lines.push('', 'Send *q* for another, *why* to go deeper, or *similar* for questions like this.');
  await wa.sendText(phone, lines.join('\n'));
}


// ---------- grand test ----------

const timeLeft = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};

/** A full mock: questions spread across subjects like the real paper, 1.05 min per question, +4/−1. */
async function startGrand(phone, user, n) {
  const total = Math.min(Math.max(n || 200, 10), 200);
  const counts = {};
  for (const r of await store.bankSummary()) counts[r.subject] = (counts[r.subject] || 0) + r.n;
  const subjects = SUBJECTS.filter((s) => counts[s]);
  if (!subjects.length) return wa.sendText(phone, 'Your question bank is empty. Send me some material first.');
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
  const lines = [
    timeUp ? "⏰ *Time's up!*" : null,
    `🏁 *Grand test finished*`,
    `Marks: *${marks}/${4 * test.ids.length}*`,
    `✅ ${test.correct} right · ❌ ${test.wrongN} wrong · ⏭ ${test.skipped} skipped${notReached ? ` · ${notReached} not reached` : ''}`,
    attempted ? `Accuracy: ${pct(test.correct, attempted)}% of attempted` : null,
    `Time: ${timeLeft(used)} of ${timeLeft(test.minutes * 60000)}`,
  ].filter(Boolean);
  const subjects = Object.entries(test.perSubject).sort((a, b) => a[1].c / a[1].n - b[1].c / b[1].n);
  if (subjects.length > 1) {
    lines.push('', '*By subject* (weakest first)');
    for (const [s, v] of subjects) lines.push(`- ${s}: ${4 * v.c - v.w} marks (${v.c}/${v.n})`);
  }
  if (test.wrongN) lines.push('', 'Every question you got wrong is now in your review queue. Send *revise* to go over them.');
  await store.updateUser(phone, { state: { ...user.state, test: null, current: null } });
  await wa.sendText(phone, lines.join('\n'));
}

// ---------- notes: explain / where ----------

async function explain(phone, query) {
  const notes = await store.searchNotes(query, { limit: 5 });
  const qs = await store.searchQuestions(query, { limit: 300 });
  const tail = qs.length ? `\n\n📝 ${qs.length} related question${qs.length > 1 ? 's' : ''} in your bank. Send *test ${query.slice(0, 40)}* to practise them.` : '';

  if (!aiAvailable()) {
    if (!notes.length) return wa.sendText(phone, `Nothing about "${query}" in your notes yet.${tail}`);
    const body = notes.map((n, i) => `*[${i + 1}] ${where(n)}*\n${n.snippet}`).join('\n\n');
    return wa.sendText(phone, `From your notes:\n\n${body}${tail}`);
  }

  await wa.sendText(phone, notes.length ? '🔎 Looking through your notes…' : '🔎 Nothing in your notes on that yet, answering from standard sources…');
  const excerpts = notes.map((n) => ({ label: where(n), text: n.content.slice(0, 3000) }));
  const answer = await aiExplain(query, excerpts);
  const sources = notes.length ? `\n\n📚 *Sources*\n${notes.map((n, i) => `[${i + 1}] ${where(n)}`).join('\n')}` : '';
  await wa.sendText(phone, `${answer}${sources}${tail}`);
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

async function why(phone, user) {
  const qid = user.state.lastQid;
  if (!qid) return wa.sendText(phone, 'Answer a question first, then send *why*.');
  const q = await store.getQuestion(qid);
  return explain(phone, `${q.stem} Answer: ${q.options[q.answer]}. Explain why this is correct and why the other options (${q.options.filter((_, i) => i !== q.answer).join('; ')}) are wrong.`);
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
  const lines = [`📚 *Your bank: ${total} questions*`];
  for (const s of SUBJECTS) {
    const topics = bySubject[s];
    const n = noteMap[s];
    if (!topics && !n) continue;
    const count = topics ? topics.reduce((a, r) => a + r.n, 0) : 0;
    const pyq = topics ? topics.reduce((a, r) => a + r.pyq, 0) : 0;
    lines.push('', `*${s}*: ${count} Q${pyq ? ` (${pyq} PYQ)` : ''}${n ? ` · notes on ${n.topics} topics` : ''}`);
    if (topics) lines.push(topics.slice(0, 6).map((t) => `${t.topic} ${t.n}`).join(' · ') + (topics.length > 6 ? ` · +${topics.length - 6} more` : ''));
  }
  await wa.sendText(phone, lines.join('\n'));
}

async function showStats(phone) {
  const s = await store.userStats(phone);
  if (!s.overall.n) return wa.sendText(phone, 'No answers yet. Send *q* to start.');
  const pct = (c, n) => `${Math.round((100 * c) / n)}%`;
  const [st, rc] = [await store.streak(phone), await store.reviewCounts(phone)];
  const lines = [
    `📊 *Your progress*`,
    `Answered ${s.overall.n}, correct ${s.overall.c} (${pct(s.overall.c, s.overall.n)})`,
    `Active ${s.activeDaysThisWeek}/7 days this week · 🔥 ${plural(st, 'day')} streak`,
    `🔁 ${rc.due} due for review today, ${rc.total} in your review queue`,
  ];
  lines.push('', '*By subject*');
  for (const r of s.bySubject) lines.push(`- ${r.subject}: ${r.c}/${r.n} (${pct(r.c, r.n)})`);
  if (s.weakTopics.length) {
    lines.push('', '*Weakest topics*');
    for (const r of s.weakTopics) lines.push(`- ${r.subject} › ${r.topic}: ${pct(r.c, r.n)}`);
    lines.push('', 'Send *coach* to drill them, or *revise* for your review queue.');
  }
  await wa.sendText(phone, lines.join('\n'));
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
  const text = await transcribe(buffer, mime);
  if (!text) return wa.sendText(phone, "I couldn't make out any words in that voice note.");
  await wa.sendText(phone, `🎙️ _"${clip(text, 300)}"_`);
  return handleMessage({ ...msg, type: 'text', text: { body: text } }, { download });
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
  weak.forEach((w, i) => lines.push(`${i + 1}. ${w.subject} › ${w.topic}: ${pct(w.c, w.n)}% (${w.c}/${w.n})`));
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

async function handleUpload(phone, { buffer, mimeType, filename, caption }) {
  await wa.sendText(phone, `📥 Got ${filename ? `*${filename}*` : 'it'}. Reading and sorting it now; big files can take a few minutes.`);
  const summary = await ingest({
    buffer,
    mimeType,
    filename,
    caption,
    addedBy: phone,
    onProgress: (msg) => wa.sendText(phone, msg),
  });
  await wa.sendText(phone, formatSummary(summary, filename));
}

const guessMime = (name = '') =>
  ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[
    name.split('.').pop().toLowerCase()
  ] || 'text/plain';

const looksLikeMaterial = (text) => text.length > 500 || (/\n\s*\(?[aA]\s*[).]/.test(text) && /\n\s*\(?[dD]\s*[).]/.test(text));

// ---------- entry point ----------

/**
 * Handle one inbound WhatsApp message (the `messages[i]` object from the webhook).
 * `download(mediaId)` is injectable for tests.
 */
export async function handleMessage(msg, { download = (id) => wa.downloadMedia(msg.from, id) } = {}) {
  const phone = msg.from;
  if (msg.callbackId) answerCallback(msg.callbackId);
  if (!isAllowed(phone)) {
    // Telegram bots are public, so strangers can find them. Tell them their id so the owner can allow it.
    if (wa.isTelegram(phone)) {
      await wa.sendText(phone, `This is a private bot. Your Telegram ID is ${phone.slice(3)}. To use it, add that number to TELEGRAM_ALLOWED_IDS in the bot's settings.`);
    }
    return;
  }
  const user = await store.getUser(phone);
  const firstContact = !user.last_inbound_at;
  // A brand-new user starts getting the daily question tomorrow, not a minute after saying hi.
  await store.updateUser(phone, {
    last_inbound_at: new Date().toISOString(),
    ...(firstContact ? { last_daily_date: localNow().date } : {}),
  });

  try {
    // Uploads
    if (msg.type === 'audio' || msg.type === 'video') return await handleAudio(phone, msg, download);
    if (msg.type === 'document' || msg.type === 'image') {
      const media = msg[msg.type];
      const { buffer, mimeType } = await download(media.id);
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
      if (kind === 'grand') return await startGrand(phone, user, 200);
      if (kind === 'revise') return await startTest(phone, user, { wrongOnly: true, count: 20 });
    }
    // Quick-reply button on the daily template
    if (msg.type === 'button') return await dailyQuestion(phone, user);

    const text = (msg.text?.body || '').trim();
    if (!text) return await wa.sendText(phone, 'Send *help* to see what I can do.');
    const lower = text.toLowerCase();
    const [cmd, ...restWords] = lower.split(/\s+/);
    const rest = text.slice(cmd.length).trim();

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
      case 'hi': case 'hello': case 'hey': case 'help': case 'menu': case 'start':
        return await wa.sendText(phone, HELP);
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
      case 'grand': case 'mock': case 'fullmock':
        return await startGrand(phone, user, Number(restWords.find((w) => /^\d+$/.test(w))) || 200);
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
      case 'bank': case 'subjects': case 'database': case 'db':
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
        if (!rest) return await why(phone, user);
        return await explain(phone, rest.replace(/^(me\s+)?(about\s+)?/i, ''));
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
    // Anything else is a question for the notes.
    return await explain(phone, text);
  } catch (err) {
    console.error('Error handling message', err);
    await wa.sendText(phone, `Sorry, something went wrong: ${err.message}`).catch((e) => console.error('Could not send the error reply:', e.message));
  }
}

/** Send today's question to one user (called by the scheduler). */
export async function sendDaily(phone) {
  const user = await store.getUser(phone);
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
