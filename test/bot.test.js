// End-to-end tests against an in-memory Postgres (PGlite), with WhatsApp sends captured.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';

config.dryRun = true;
config.anthropic.apiKey = ''; // never call Claude from tests
config.allowedNumbers = [];
config.dailyTemplate.name = 'daily_question';

const store = await import('../src/db.js');
const { setSink } = await import('../src/whatsapp.js');
const tg = await import('../src/telegram.js');
const { handleMessage, parseTestArgs } = await import('../src/bot.js');
const { runDueDailies } = await import('../src/scheduler.js');
const { parseFormattedMcqs } = await import('../src/ingest/textParser.js');
const { findSubjectIn, matchSubject } = await import('../src/subjects.js');

const ME = '919876543210';
let out = [];
setSink((to, p) => out.push(p));
tg.setSink((to, p) => out.push({ ...p, to }));
let n = 0;
const send = (extra) => handleMessage({ from: ME, id: `t${++n}`, ...extra }, { download: async (id) => files[id] });
const say = (body) => send({ type: 'text', text: { body } });
const tap = (id) => send({ type: 'interactive', interactive: { list_reply: { id } } });
const lastText = () => {
  const p = out.at(-1);
  return p.type === 'text' ? p.text.body : p.interactive?.body?.text;
};
let files = {};

const BANK = `
1. Drug of choice for absence seizures is
a) Ethosuximide
b) Phenytoin
c) Carbamazepine
d) Phenobarbitone
Ans: a
Explanation: Ethosuximide blocks T-type calcium channels in thalamic neurons.

2. Which beta blocker has intrinsic sympathomimetic activity? (NEET PG 2019)
(a) Propranolol (b) Pindolol (c) Atenolol (d) Metoprolol
Answer: (b)

3. Antidote for heparin overdose
A. Vitamin K
B. Protamine sulfate
C. Desferrioxamine
D. Flumazenil
Ans. B
`;

before(async () => {
  await store.initDb('memory');
});
after(async () => {
  await store.closeDb();
});
beforeEach(() => {
  out = [];
});

test('subject aliases', () => {
  assert.equal(matchSubject('pharma'), 'Pharmacology');
  assert.equal(matchSubject('OBG'), 'Obstetrics & Gynaecology');
  assert.equal(matchSubject('psm'), 'Community Medicine');
  assert.equal(findSubjectIn('Marrow_pharma_notes.pdf'), 'Pharmacology');
  assert.equal(matchSubject('thyroid'), null);
});

test('offline MCQ parser reads common layouts', () => {
  const r = parseFormattedMcqs(BANK);
  assert.equal(r.questions.length, 3);
  assert.deepEqual(r.questions[1].options, ['Propranolol', 'Pindolol', 'Atenolol', 'Metoprolol']);
  assert.equal(r.questions[1].answer, 1);
  assert.equal(r.questions[1].year, '2019');
  assert.equal(r.questions[2].answer, 1);
  assert.match(r.questions[0].explanation, /T-type/);
});

test('test command arguments', () => {
  assert.deepEqual(parseTestArgs('pharma 20 pyq 2022'), { count: 20, subject: 'Pharmacology', pyqOnly: true, year: '2022', topic: null });
  assert.deepEqual(parseTestArgs('10 thyroid storm'), { count: 10, subject: null, pyqOnly: false, year: null, topic: 'thyroid storm' });
});

test('upload a text question bank with a caption: sorted under the subject', async () => {
  files = { m1: { buffer: Buffer.from(BANK), mimeType: 'text/plain' } };
  await send({ type: 'document', document: { id: 'm1', mime_type: 'text/plain', filename: 'pharma_qbank.txt', caption: 'pharma' } });
  assert.match(lastText(), /Added 3 questions/);
  assert.match(lastText(), /Pharmacology/);
  // Same file again: all duplicates.
  await send({ type: 'document', document: { id: 'm1', mime_type: 'text/plain', filename: 'pharma_qbank.txt', caption: 'pharma' } });
  assert.match(lastText(), /3 were already in your bank/);
});

test('single question, answer by tapping, note reference shown', async () => {
  await store.addNote({ subject: 'Pharmacology', topic: 'Antiepileptics', content: 'Ethosuximide is the drug of choice for absence seizures; valproate if mixed seizures.', page: 12 });
  await say('q pharma');
  const card = out.at(-1);
  assert.equal(card.type, 'interactive');
  const rows = card.interactive.action.sections[0].rows;
  assert.equal(rows.length, 4);
  const user = await store.getUser(ME);
  const q = await store.getQuestion(user.state.current.qid);
  out = [];
  await tap(`ans:${q.id}:${q.answer}`);
  assert.match(lastText(), /Correct/);
  // Tapping the same question again is rejected.
  await tap(`ans:${q.id}:${q.answer}`);
  assert.match(lastText(), /already closed/);
});

test('note reference after answering cites file and page', async () => {
  // Force the absence-seizure question.
  const { rows } = { rows: await store.searchQuestions('absence seizures') };
  const qid = rows[0].id;
  const user = await store.getUser(ME);
  await store.updateUser(ME, { state: { ...user.state, current: { qid, mode: 'single' } } });
  await say('b');
  assert.match(lastText(), /You chose B/);
  assert.match(lastText(), /Your notes:\* Pharmacology › Antiepileptics \(p\.12\)/);
});

test('full test flow with typed answers and a summary', async () => {
  await say('test pharma 3');
  assert.match(out[0].text.body, /Test: Pharmacology/);
  for (let i = 0; i < 3; i++) await say('A');
  assert.match(lastText(), /Test finished/);
  assert.match(lastText(), /Score: \*\d\/3\*/);
});

test('revise picks wrong answers', async () => {
  await say('revise');
  assert.match(out[0].text.body, /Revision/);
  await say('stop');
  assert.match(lastText(), /Test finished/);
});

test('where shows notes and questions locations', async () => {
  await say('where absence seizures');
  assert.match(lastText(), /Notes/);
  assert.match(lastText(), /Pharmacology › Antiepileptics/);
  assert.match(lastText(), /Questions/);
});

test('explain without Claude returns matching note snippets', async () => {
  await say('explain ethosuximide');
  assert.match(lastText(), /From your notes/);
  assert.match(lastText(), /\*Ethosuximide\*/i);
});

test('bank and stats', async () => {
  await say('bank');
  assert.match(lastText(), /Your bank: 3 questions/);
  await say('stats');
  assert.match(lastText(), /Your progress/);
});

test('daily settings and scheduler', async () => {
  await say('daily 7:30 pm');
  assert.match(lastText(), /19:30/);
  await store.updateUser(ME, { last_daily_date: null, last_inbound_at: new Date().toISOString() });
  out = [];
  // 19:31 IST = 14:01 UTC
  const sent = await runDueDailies(new Date('2026-10-20T14:01:00Z'));
  assert.deepEqual(sent, [ME]);
  assert.match(out[0].interactive.body.text, /Question of the day/);
  // Not twice on the same day.
  assert.deepEqual(await runDueDailies(new Date('2026-10-20T14:30:00Z')), []);
  // Outside the 24h window: template instead.
  await store.updateUser(ME, { last_inbound_at: new Date(Date.now() - 2 * 86400e3).toISOString() });
  out = [];
  await runDueDailies(new Date('2026-10-21T14:01:00Z'));
  assert.equal(out[0].type, 'template');
});

test('PDF upload without Claude key explains what is missing', async () => {
  files = { p1: { buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf' } };
  await send({ type: 'document', document: { id: 'p1', mime_type: 'application/pdf', filename: 'notes.pdf' } });
  assert.match(lastText(), /needs the Claude API key/);
});

test('PDFs are split into 15-page chunks with page offsets', async () => {
  const { PDFDocument } = await import('pdf-lib');
  const { pdfChunks } = await import('../src/ingest/index.js');
  const doc = await PDFDocument.create();
  for (let i = 0; i < 32; i++) doc.addPage();
  const chunks = [];
  for await (const c of pdfChunks(Buffer.from(await doc.save()))) chunks.push([c.firstPage, c.lastPage, c.total]);
  assert.deepEqual(chunks, [[1, 15, 32], [16, 30, 32], [31, 32, 32]]);
});

test('telegram updates become bot messages', () => {
  assert.deepEqual(tg.toBotMessage({ message: { message_id: 5, chat: { id: 42 }, text: '/test@neetbot pharma 10' } }).text, { body: 'test pharma 10' });
  const doc = tg.toBotMessage({ message: { message_id: 6, chat: { id: 42 }, caption: 'micro', document: { file_id: 'F1', file_name: 'micro.pdf', mime_type: 'application/pdf' } } });
  assert.equal(doc.from, 'tg:42');
  assert.deepEqual(doc.document, { id: 'F1', mime_type: 'application/pdf', filename: 'micro.pdf', caption: 'micro' });
  const photo = tg.toBotMessage({ message: { message_id: 7, chat: { id: 42 }, photo: [{ file_id: 'small' }, { file_id: 'big' }] } });
  assert.equal(photo.image.id, 'big');
  const cb = tg.toBotMessage({ callback_query: { id: 'c1', data: 'ans:3:1', message: { chat: { id: 42 } } } });
  assert.equal(cb.interactive.list_reply.id, 'ans:3:1');
});

test('telegram: strangers are told their id, allowed users share the same bank', async () => {
  await handleMessage({ from: 'tg:777', id: 'tg-x1', type: 'text', text: { body: 'hi' } });
  assert.equal(out.at(-1).type, 'telegram');
  assert.match(out.at(-1).text, /Your Telegram ID is 777/);

  config.telegram.allowedIds = ['777'];
  out = [];
  const more = BANK.replace(/Drug of choice for absence seizures is/, 'Drug of choice for myoclonic seizures is').replace('Antidote for heparin overdose', 'Antidote for warfarin overdose');
  files = { tgf: { buffer: Buffer.from(more), mimeType: null } };
  await handleMessage(
    { from: 'tg:777', id: 'tg-x2', type: 'document', document: { id: 'tgf', mime_type: 'text/plain', filename: 'pharma2.txt', caption: 'pharma' } },
    { download: async (id) => files[id] }
  );
  assert.match(out.at(-1).text, /Added 2 questions/);
  assert.match(out.at(-1).text, /1 were already in your bank/);

  // The WhatsApp user sees the Telegram upload.
  await say('bank');
  assert.match(lastText(), /Your bank: 5 questions/);

  // Questions on Telegram come with A–D buttons on one row.
  out = [];
  await handleMessage({ from: 'tg:777', id: 'tg-x3', type: 'text', text: { body: 'q' } });
  const kb = out.at(-1).reply_markup.inline_keyboard;
  assert.equal(kb.length, 1);
  assert.deepEqual(kb[0].map((b) => b.text), ['A', 'B', 'C', 'D']);
  await handleMessage({ from: 'tg:777', id: 'tg-x4', callbackId: 'c9', type: 'interactive', interactive: { list_reply: { id: kb[0][0].callback_data } } });
  assert.match(out.at(-1).text, /Correct|You chose A/);
});
