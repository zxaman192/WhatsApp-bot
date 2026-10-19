import * as store from './db.js';
import * as wa from './messenger.js';
import { answerCallback } from './telegram.js';
import { config, isAllowed } from './config.js';
import { SUBJECTS, matchSubject } from './subjects.js';
import { ingest, formatSummary } from './ingest/index.js';
import { aiAvailable, explain as aiExplain } from './ingest/ai.js';
import { localNow } from './time.js';

const LETTERS = ['A', 'B', 'C', 'D'];

const HELP = `*NEET PG prep bot* 📚

*Add material*
Send a PDF, a photo of a page, or paste text (here or in the Telegram bot; both share one database): notes, a question bank or PYQs. I split it into questions and notes and file each one under its subject and topic. A caption like "pharma" helps.

*Practise*
- *q*: one question now (*q pharma* for one subject)
- *test*: pick a subject and length
- *test pharma 20*, *test pyq 2022*, *test 10 thyroid*
- *revise*: retry questions you got wrong
- *stop*: end a test

*Learn from your notes*
- *explain <topic>* or just ask, e.g. "DOC for absence seizures?"
- *where <topic>*: where it appears in your notes and questions
- *why*: explain the last question from your notes

*Track*
- *bank*: what's in your database
- *stats*: your accuracy and weak topics
- *daily 07:30*, *daily off*, *daily pharma*: your question of the day`;

// ---------- helpers ----------

function questionCard(q, header) {
  const tags = [q.subject, q.topic !== 'General' ? q.topic : null].filter(Boolean).join(' › ');
  const pyq = q.origin === 'pyq' ? ` · PYQ${q.year ? ' ' + q.year : ''}${q.exam && q.exam !== 'NEET PG' ? ' ' + q.exam : ''}` : '';
  const opts = q.options.map((o, i) => `*${LETTERS[i]}.* ${o}`).join('\n');
  return `${header ? `*${header}* · ` : ''}_${tags}${pyq}_\n\n${q.stem}\n\n${opts}\n\nTap an option or reply A, B, C or D.`;
}

async function sendQuestion(phone, q, header) {
  await wa.sendList(
    phone,
    questionCard(q, header),
    'Answer',
    q.options.map((o, i) => ({ id: `ans:${q.id}:${i}`, title: LETTERS[i], description: o })),
    'Choose one'
  );
}

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

async function askSingle(phone, user, { subject = null, mode = 'single' } = {}) {
  const [id] = await store.pickQuestions(phone, { count: 1, subject });
  if (!id) {
    await wa.sendText(phone, subject ? `No ${subject} questions yet. Send me some material first.` : 'Your question bank is empty. Send me a PDF, photo or text of notes or questions first.');
    return false;
  }
  const q = await store.getQuestion(id);
  await store.updateUser(phone, { state: { ...user.state, current: { qid: id, mode }, test: null } });
  await sendQuestion(phone, q, mode === 'daily' ? 'Question of the day' : null);
  return true;
}

async function startTest(phone, user, opts) {
  const count = Math.min(Math.max(opts.count || 10, 1), 100);
  let filter = { subject: opts.subject, pyqOnly: opts.pyqOnly, year: opts.year, wrongOnly: opts.wrongOnly };
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
      opts.wrongOnly ? 'Nothing to revise: you have no wrong answers waiting. 🎉' : `I found no questions for ${label || 'that'}. Send *bank* to see what's there.`
    );
    return;
  }
  const test = { ids, index: 0, correct: 0, wrong: [], label: label || 'Mixed', perTopic: {} };
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

  const lines = [
    correct ? `✅ *Correct!* ${LETTERS[q.answer]}. ${q.options[q.answer]}` : `❌ You chose ${LETTERS[chosen]}. Correct answer: *${LETTERS[q.answer]}. ${q.options[q.answer]}*`,
  ];
  if (q.explanation) lines.push('', q.explanation);
  if (!q.answer_checked) lines.push('', '_The source had no answer key; this answer was worked out by AI, so double-check it._');
  const ref = await noteReference(q);
  if (ref) lines.push('', ref);
  else if (q.filename) lines.push('', `📄 From ${q.filename}${q.page ? ` p.${q.page}` : ''}`);

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
  lines.push('', 'Send *q* for another, *why* to go deeper, or *test* for a full test.');
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
  const lines = [`📊 *Your progress*`, `Answered ${s.overall.n}, correct ${s.overall.c} (${pct(s.overall.c, s.overall.n)})`, `Active ${s.activeDaysThisWeek}/7 days this week`];
  lines.push('', '*By subject*');
  for (const r of s.bySubject) lines.push(`- ${r.subject}: ${r.c}/${r.n} (${pct(r.c, r.n)})`);
  if (s.weakTopics.length) {
    lines.push('', '*Weakest topics*');
    for (const r of s.weakTopics) lines.push(`- ${r.subject} › ${r.topic}: ${pct(r.c, r.n)}`);
    lines.push('', 'Send *revise* to go over your wrong answers.');
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
    if (msg.type === 'document' || msg.type === 'image') {
      const media = msg[msg.type];
      const { buffer, mimeType } = await download(media.id);
      return await handleUpload(phone, {
        buffer,
        mimeType: media.mime_type || mimeType || guessMime(media.filename),
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
      if (kind === 'daily') return await askSingle(phone, user, { subject: user.daily_subject, mode: 'daily' });
    }
    // Quick-reply button on the daily template
    if (msg.type === 'button') return await askSingle(phone, user, { subject: user.daily_subject, mode: 'daily' });

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
    if (letter) return await wa.sendText(phone, 'No question is open right now. Send *q* for one.');

    switch (cmd) {
      case 'hi': case 'hello': case 'hey': case 'help': case 'menu': case 'start':
        return await wa.sendText(phone, HELP);
      case 'q': case 'question': case 'quiz': case 'next':
        return await askSingle(phone, user, { subject: matchSubject(restWords[0]) });
      case 'test': case 'exam': case 'mock':
        if (!rest) return await testPicker(phone);
        return await startTest(phone, user, parseTestArgs(rest));
      case 'revise': case 'revision': case 'wrong': case 'mistakes':
        return await startTest(phone, user, { ...parseTestArgs(rest), wrongOnly: true, count: parseTestArgs(rest).count || 20 });
      case 'stop': case 'end': case 'finish': case 'quit':
        if (user.state.test) return await finishTest(phone, user, user.state.test);
        await store.updateUser(phone, { state: { ...user.state, current: null } });
        return await wa.sendText(phone, 'Nothing running. Send *q* or *test* when you are ready.');
      case 'skip':
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

    // Long pasted text or something shaped like MCQs → add it to the bank.
    if (looksLikeMaterial(text)) {
      return await handleUpload(phone, { buffer: Buffer.from(text, 'utf8'), mimeType: 'text/plain', filename: 'pasted text', caption: '' });
    }
    // Anything else is a question for the notes.
    return await explain(phone, text);
  } catch (err) {
    console.error('Error handling message', err);
    await wa.sendText(phone, `Sorry, something went wrong: ${err.message}`).catch(() => {});
  }
}

/** Send today's question to one user (called by the scheduler). */
export async function sendDaily(phone) {
  const user = await store.getUser(phone);
  // Telegram has no 24-hour rule; WhatsApp does.
  if (wa.isTelegram(phone) || inWindow(user)) {
    await askSingle(phone, user, { subject: user.daily_subject, mode: 'daily' });
  } else if (config.dailyTemplate.name) {
    // Outside WhatsApp's 24h window only an approved template is allowed; tapping it opens the window.
    await wa.sendTemplate(phone, config.dailyTemplate.name, config.dailyTemplate.lang);
  } else {
    console.log(`Skipping daily question for ${phone}: outside the 24h window and no DAILY_TEMPLATE_NAME set.`);
    return false;
  }
  return true;
}
