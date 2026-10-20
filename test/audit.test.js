// Robustness and chat-polish tests: every command and odd input gets a clean reply, tests can't be
// clobbered, the AI falls back gracefully when it is out of quota, and paused uploads resume.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';

config.dryRun = true;
config.telegram.dryRun = true;
config.anthropic.apiKey = '';
config.gemini.apiKey = '';
config.allowedNumbers = [];

const store = await import('../src/db.js');
const { setSink } = await import('../src/whatsapp.js');
const tg = await import('../src/telegram.js');
const { handleMessage, excerptAround, resumeJobs } = await import('../src/bot.js');
const { whenText } = await import('../src/ingest/index.js');
const { resetResting } = await import('../src/ingest/gemini.js');

const ME = '913333333333';
let out = [];
setSink((to, p) => out.push({ ...p, to }));
tg.setSink((to, p) => out.push({ ...p, to }));
let n = 0;
const sendAs = (from, extra) => handleMessage({ from, id: `a${++n}`, ...extra }, { download: async () => ({ buffer: Buffer.from(''), mimeType: 'text/plain' }) });
const say = (body, from = ME) => sendAs(from, { type: 'text', text: { body } });
const tap = (id, from = ME) => sendAs(from, { type: 'interactive', interactive: { list_reply: { id } } });
const bodyOf = (p) => (p.type === 'text' ? p.text.body : p.interactive?.body?.text ?? p.image?.caption ?? '');
const lastText = () => bodyOf(out.at(-1));
const buttonsOf = (p) => (p.interactive?.action?.buttons || []).map((b) => b.reply.id);
const texts = () => out.map(bodyOf).join('\n---\n');

const SEED = [
  ['Pharmacology', 'Antiepileptics', 'Drug of choice for absence seizures', ['Ethosuximide', 'Phenytoin', 'Carbamazepine', 'Phenobarbitone'], 0, 'pyq', '2019'],
  ['Pharmacology', 'Anticoagulants', 'Antidote for heparin overdose', ['Vitamin K', 'Protamine sulfate', 'Desferrioxamine', 'Flumazenil'], 1, 'bank', ''],
  ['Pathology', 'Neoplasia', 'Psammoma bodies are seen in', ['Papillary carcinoma thyroid', 'Follicular carcinoma', 'Medullary carcinoma', 'Anaplastic carcinoma'], 0, 'bank', ''],
  ['Medicine', 'Cardiology', 'Drug of choice for paroxysmal SVT', ['Adenosine', 'Digoxin', 'Amiodarone', 'Lignocaine'], 0, 'bank', ''],
];

before(async () => {
  await store.initDb('memory');
  for (const [subject, topic, stem, options, answer, origin, year] of SEED) {
    await store.addQuestion({ subject, topic, stem, options, answer, explanation: '', year, exam: year ? 'NEET PG' : '', answerChecked: true, origin, page: null });
  }
  await store.addNote({ subject: 'Pharmacology', topic: 'Antiepileptics', content: 'Ethosuximide is the drug of choice for absence seizures. Phenytoin causes gingival hyperplasia.', page: 3 });
});
after(async () => {
  await store.closeDb();
});
beforeEach(() => {
  out = [];
});

test('first contact gets a short onboarding, then help', async () => {
  await sendAs(ME, { type: 'text', text: { body: 'hi' }, firstName: 'Harsh' });
  assert.match(lastText(), /Hi Harsh! I'm your NEET PG study partner/);
  assert.equal((await store.getUser(ME)).name, 'Harsh', 'name taken from Telegram');
  await say('help');
  assert.match(lastText(), /NEET PG prep bot/);
});

test('every command and odd input gets a clean reply, never an error', async () => {
  const inputs = [
    'q', 'q pharma', 'q nonsense', 'question', 'test', 'test pharma 5', 'test pyq 2019', 'test 3 zzzzunknown', 'stop',
    'revise', 'due', 'spot', 'flash', 'flash pharma', 'similar', 'why', 'explain', 'explain absence seizures', 'where', 'where phenytoin',
    'hy', 'hy pharma', 'coach', 'plan', 'today', 'exam', 'exam 32-13-2020', 'exam 15-01-2020', 'bank', 'stats', 'report', 'daily',
    'daily 25:99', 'daily 7am', 'daily pharma', 'daily all', 'daily off', 'daily on', 'name', 'buddy', 'buddy add ZZZZ', 'lb',
    'skip', 'grand', 'A', '5', '?', '!!!', '😀', '   ', 'DOC for absence seizures?', 'moa of heparin', 'stop',
  ];
  for (const text of inputs) {
    out = [];
    await say(text);
    assert.ok(out.length, `no reply to "${text}"`);
    assert.doesNotMatch(texts(), /something went wrong|undefined|NaN|\[object/i, `bad reply to "${text}": ${texts()}`);
  }
  for (const id of ['ans:999999:0', 'ans:x:y', 'gskip:1', 'spot:1:0', 'flash:show:3', 'simtest', 'drill:7', 'tcont', 'tend', 'reltest', 'why:999999', 'sim:999999', 'next', 'stats', 'bank', 'coach', 'newtest', 'gstart:50', 'stop', 'unknown:thing']) {
    out = [];
    await (id === 'stop' ? say('stop') : tap(id));
    assert.doesNotMatch(texts(), /something went wrong|undefined|NaN|\[object/i, `bad reply to tap "${id}": ${texts()}`);
  }
  await say('stop');
});

test('an answer offers Next, Why and Similar buttons', async () => {
  await say('q pharma');
  const qid = (await store.getUser(ME)).state.current.qid;
  const q = await store.getQuestion(qid);
  out = [];
  await tap(`ans:${qid}:${q.answer}`);
  assert.match(texts(), /Correct/);
  assert.deepEqual(buttonsOf(out.at(-1)), ['next', `why:${qid}`, `sim:${qid}`]);
  out = [];
  await tap(`why:${qid}`);
  assert.match(texts(), new RegExp(q.options[q.answer]));
  out = [];
  await tap('next');
  assert.ok((await store.getUser(ME)).state.current, 'Next opens a new question');
});

test('a running test is not silently dropped by q, test or grand', async () => {
  await say('stop');
  await say('test 3');
  const before = (await store.getUser(ME)).state.test;
  assert.ok(before);
  for (const cmd of ['q', 'test pharma', 'grand 50']) {
    out = [];
    await say(cmd);
    assert.match(lastText(), /middle of a test/);
    assert.deepEqual(buttonsOf(out.at(-1)), ['tcont', 'tend']);
  }
  assert.deepEqual((await store.getUser(ME)).state.test.ids, before.ids);
  out = [];
  await tap('tcont');
  assert.match(lastText(), /Q 1\/3/);
  await tap('tend');
  assert.match(texts(), /Test finished/);
  assert.equal((await store.getUser(ME)).state.test, null);
});

test('two quick taps on the same question count once', async () => {
  await say('q');
  const qid = (await store.getUser(ME)).state.current.qid;
  out = [];
  await Promise.all([tap(`ans:${qid}:0`), tap(`ans:${qid}:1`)]);
  const r = await store.userStats(ME);
  const closed = out.filter((p) => /already closed/.test(bodyOf(p))).length;
  assert.equal(closed, 1, texts());
  assert.ok(r.overall.n >= 1);
});

test('explain falls back to the notes when the AI is out of quota', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded. Please retry in 2h0m0s.' } }), { status: 429 });
  config.gemini.apiKey = 'test-key';
  resetResting();
  try {
    await say('explain absence seizures');
    assert.match(texts(), /used up its free quota/);
    assert.match(texts(), /Ethosuximide/);
    assert.doesNotMatch(texts(), /something went wrong/);
  } finally {
    globalThis.fetch = real;
    config.gemini.apiKey = '';
    resetResting();
  }
});

test('search understands medical shorthand', () => {
  assert.deepEqual(store.searchTerms('DOC for HTN'), ['drug', 'choice', 'hypertension']);
  assert.ok(store.searchTerms('IV fluids in DKA').includes('iv'));
  assert.ok(store.searchTerms('IV fluids in DKA').includes('ketoacidosis'));
});

test('long notes are cut around the match, not from the start', () => {
  const content = `${'filler words here. '.repeat(400)}Ethosuximide is the drug of choice. ${'more filler. '.repeat(400)}`;
  const ex = excerptAround(content, 'ethosuximide', 1000);
  assert.ok(ex.length <= 1002);
  assert.match(ex, /Ethosuximide/);
});

test('resume times read naturally', () => {
  const now = new Date('2026-10-20T04:00:00Z'); // 9:30 AM in India
  assert.equal(whenText(new Date(now.getTime() + 20 * 60e3), now), 'within the hour');
  assert.equal(whenText(new Date('2026-10-20T12:00:00Z'), now), 'at 5:30 PM');
  assert.equal(whenText(new Date('2026-10-21T03:00:00Z'), now), 'tomorrow at 8:30 AM');
});

test('a paused upload job resumes and reports when done', async () => {
  const sourceId = await store.addSource('paused.pdf', 'pdf', ME);
  const id = await store.createJob({ phone: ME, filename: 'paused.pdf', caption: '', data: Buffer.from('not a pdf'), sourceId, parts: 1 });
  await store.updateJob(id, { status: 'paused', resume_at: new Date(Date.now() - 1000).toISOString() });
  await resumeJobs();
  // A broken file fails cleanly and tells the user, and the job is not retried forever.
  assert.match(texts(), /couldn't finish reading \*paused\.pdf\*/);
  assert.equal((await store.getJob(id)).status, 'failed');
  assert.deepEqual(await store.resumableJobs(), []);
});
