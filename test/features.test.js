// Tests for the study features: spaced repetition, grand test, image questions, voice/lectures,
// coach and weekly report, flashcards, similar, high-yield, exam plan and study buddies.
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
const { handleMessage, parseDate, makePlan, clozeCards, GRAND_DAY } = await import('../src/bot.js');
const { runDueDailies } = await import('../src/scheduler.js');
const { localNow, addDays } = await import('../src/time.js');

const ME = '911111111111';
const FRIEND = '912222222222';
let out = [];
setSink((to, p) => out.push({ ...p, to }));
tg.setSink((to, p) => out.push({ ...p, to }));
let files = {};
let n = 0;
const sendAs = (from, extra) => handleMessage({ from, id: `f${++n}`, ...extra }, { download: async (id) => files[id] });
const send = (extra) => sendAs(ME, extra);
const say = (body, from = ME) => sendAs(from, { type: 'text', text: { body } });
const tap = (id, from = ME) => sendAs(from, { type: 'interactive', interactive: { list_reply: { id } } });
const bodyOf = (p) => (p.type === 'text' ? p.text.body : p.interactive?.body?.text ?? p.image?.caption);
const lastText = () => bodyOf(out.at(-1));
const texts = () => out.map(bodyOf).join('\n---\n');

function mockGemini(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const text = handler(body);
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] }));
  };
  config.gemini.apiKey = 'test-key';
  return {
    calls,
    restore() {
      globalThis.fetch = real;
      config.gemini.apiKey = '';
    },
  };
}

const SEED = [
  ['Pharmacology', 'Antiepileptics', 'Drug of choice for absence seizures', ['Ethosuximide', 'Phenytoin', 'Carbamazepine', 'Phenobarbitone'], 0, 'pyq', '2019'],
  ['Pharmacology', 'Antiepileptics', 'Drug of choice for absence seizures with tonic clonic seizures', ['Valproate', 'Ethosuximide', 'Phenytoin', 'Lamotrigine'], 0, 'pyq', '2021'],
  ['Pharmacology', 'Antiepileptics', 'Antiepileptic causing gingival hyperplasia', ['Phenytoin', 'Valproate', 'Ethosuximide', 'Topiramate'], 0, 'bank', ''],
  ['Pharmacology', 'Anticoagulants', 'Antidote for heparin overdose', ['Vitamin K', 'Protamine sulfate', 'Desferrioxamine', 'Flumazenil'], 1, 'pyq', '2019'],
  ['Pathology', 'Neoplasia', 'Most common tumour marker for hepatocellular carcinoma', ['AFP', 'CEA', 'CA-125', 'PSA'], 0, 'bank', ''],
  ['Pathology', 'Neoplasia', 'Psammoma bodies are seen in', ['Papillary carcinoma thyroid', 'Follicular carcinoma', 'Medullary carcinoma', 'Anaplastic carcinoma'], 0, 'bank', ''],
  ['Medicine', 'Cardiology', 'Drug of choice for paroxysmal SVT', ['Adenosine', 'Digoxin', 'Amiodarone', 'Lignocaine'], 0, 'bank', ''],
  ['Medicine', 'Endocrinology', 'Most common cause of hypothyroidism worldwide', ['Iodine deficiency', 'Hashimoto thyroiditis', 'Radiation', 'Surgery'], 0, 'bank', ''],
  ['Surgery', 'Breast', 'Most common site of breast carcinoma', ['Upper outer quadrant', 'Upper inner quadrant', 'Lower outer quadrant', 'Central'], 0, 'bank', ''],
  ['Community Medicine', 'Epidemiology', 'Incidence is best measured by', ['Cohort study', 'Case control study', 'Cross sectional study', 'Ecological study'], 0, 'bank', ''],
  ['Obstetrics & Gynaecology', 'Labour', 'Most common position of occiput at engagement', ['Left occipito anterior', 'Right occipito anterior', 'Direct occipito posterior', 'Left occipito posterior'], 0, 'bank', ''],
  ['Microbiology', 'Bacteriology', 'Satellitism is shown by', ['Haemophilus influenzae', 'Staphylococcus aureus', 'Streptococcus pyogenes', 'E. coli'], 0, 'bank', ''],
];

before(async () => {
  await store.initDb('memory');
  for (const [subject, topic, stem, options, answer, origin, year] of SEED) {
    await store.addQuestion({ subject, topic, stem, options, answer, explanation: '', year, exam: year ? 'NEET PG' : '', answerChecked: true, origin, page: null });
  }
  await store.addNote({ subject: 'Pharmacology', topic: 'Antiepileptics', content: 'Ethosuximide is the drug of choice for absence seizures. Valproate is preferred when absence occurs with generalised tonic clonic seizures. Phenytoin causes gingival hyperplasia and hirsutism.', page: 3 });
  await say('hi'); // creates the user
});
after(async () => {
  await store.closeDb();
});
beforeEach(() => {
  out = [];
});

async function openQuestion(phone = ME) {
  const u = await store.getUser(phone);
  return store.getQuestion(u.state.current.qid);
}

test('exam dates in common formats', () => {
  assert.equal(parseDate('2027-01-15'), '2027-01-15');
  assert.equal(parseDate('15-01-2027'), '2027-01-15');
  assert.equal(parseDate('15/1/2027'), '2027-01-15');
  assert.equal(parseDate('15th Jan 2027'), '2027-01-15');
  assert.equal(parseDate('January 15, 2027'), '2027-01-15');
  assert.equal(parseDate('31-02-2027'), null);
  assert.equal(parseDate('pharma 20'), null);
});

test('plan: weak heavy subjects get more days, the last days are for grand tests', () => {
  const plan = makePlan('2026-10-20', '2027-01-28', { Medicine: { n: 20, c: 4 }, Surgery: { n: 20, c: 19 } });
  assert.equal(plan.days.length, 100);
  assert.deepEqual(plan.days.slice(-10), Array(10).fill(GRAND_DAY));
  const count = (s) => plan.days.filter((d) => d === s).length;
  assert.ok(count('Medicine') > count('Surgery'), 'weak Medicine gets more days than strong Surgery');
  assert.ok(count('Radiology') >= 1);
  // Days of a subject are spread out, not in one block.
  assert.notEqual(plan.days[0], plan.days[1]);
  const short = makePlan('2026-10-20', '2026-10-22');
  assert.deepEqual(short.days, [GRAND_DAY, GRAND_DAY]);
});

test('fill-in-the-blank flashcards without AI', () => {
  const cards = clozeCards('Ethosuximide is the drug of choice for absence seizures. Phenytoin causes gingival hyperplasia in 20% of patients.');
  assert.equal(cards.length, 2);
  assert.equal(cards[1].back, '20%');
  assert.match(cards[1].front, /in ____ of patients/);
  assert.ok(cards[0].front.includes('____'));
});

test('spaced repetition: a wrong answer comes back tomorrow, then after 3, 7 and 21 days', async () => {
  const [q] = await store.searchQuestions('heparin overdose');
  const u = await store.getUser(ME);
  await store.updateUser(ME, { state: { ...u.state, current: { qid: q.id, mode: 'single' } } });
  await tap(`ans:${q.id}:0`);
  assert.match(lastText(), /You chose _A/);
  assert.match(lastText(), /Back for review on/);
  const today = localNow().date;
  const row = async () => (await store.reviewCounts(ME));
  assert.deepEqual(await row(), { due: 0, total: 1 });
  await say('due');
  assert.match(lastText(), /0 questions due for review today, 1 in your queue/);
  // Correct answers move it along the boxes until it leaves the queue.
  assert.equal(await store.scheduleReview(ME, q.id, true), addDays(today, 3));
  assert.equal(await store.scheduleReview(ME, q.id, true), addDays(today, 7));
  assert.equal(await store.scheduleReview(ME, q.id, true), addDays(today, 21));
  assert.equal(await store.scheduleReview(ME, q.id, true), null);
  assert.deepEqual(await row(), { due: 0, total: 0 });
  // Due reviews are asked first.
  await store.scheduleReview(ME, q.id, false);
  const [pick] = await store.pickQuestions(ME, { count: 1 });
  assert.notEqual(pick, q.id, 'not due until tomorrow');
});

test('grand test: timed, +4/−1, skip, no answers until the end', async () => {
  await say('grand 10');
  assert.match(out[0].text.body, /Grand test started\*\n\n📝 \*10\* questions/);
  assert.match(out[0].text.body, /11m\* on the clock/);
  const card = out.at(-1);
  assert.match(card.interactive.body.text, /Question 1 of 10  ·  ⏱ 11m left/);
  assert.equal(card.interactive.action.sections[0].rows.at(-1).title, 'Skip');

  let right = 0;
  let wrong = 0;
  for (let i = 0; i < 9; i++) {
    out = [];
    const q = await openQuestion();
    const pickRight = i % 3 !== 0;
    await tap(`ans:${q.id}:${pickRight ? q.answer : (q.answer + 1) % 4}`);
    pickRight ? right++ : wrong++;
    assert.equal(out.length, 1, 'only the next question, no explanation');
    assert.match(lastText(), new RegExp(`Question ${i + 2} of 10`));
  }
  await say('skip');
  const result = lastText();
  assert.match(result, /Grand test complete/);
  assert.match(result, new RegExp(`Marks: ${4 * right - wrong}/40\\*`));
  assert.match(result, new RegExp(`✅ ${right} right  ·  ❌ ${wrong} wrong  ·  ⏭ 1 skipped`));
  assert.match(result, /By subject/);
  assert.match(result, /review queue/);
});

test('grand test ends when time is up', async () => {
  await say('grand 10');
  const u = await store.getUser(ME);
  await store.updateUser(ME, { state: { ...u.state, test: { ...u.state.test, endsAt: Date.now() - 1000 } } });
  const q = await openQuestion();
  await tap(`ans:${q.id}:${q.answer}`);
  assert.match(lastText(), /Time's up/);
  // The answer came in after the clock ran out, so it isn't scored.
  assert.match(lastText(), /✅ 0 right  ·  ❌ 0 wrong  ·  ⏭ 0 skipped  ·  10 not reached/);
});

test('image questions: save with "spot:", typed answer, then multiple choice', async () => {
  await say('spot');
  assert.match(lastText(), /No image questions yet/);
  files = { i1: { buffer: Buffer.from('fake-jpeg-1'), mimeType: 'image/jpeg' } };
  await send({ type: 'image', image: { id: 'i1', mime_type: 'image/jpeg', caption: 'spot derma: Erythema nodosum' } });
  assert.match(lastText(), /Saved an image question: \*Erythema nodosum\* \(Dermatology\)/);
  await send({ type: 'image', image: { id: 'i1', mime_type: 'image/jpeg', caption: 'spot: Erythema nodosum' } });
  assert.match(lastText(), /already in your bank/);

  out = [];
  await say('spot');
  assert.equal(out[0].type, 'image');
  assert.match(out[0].image.caption, /Spot it · Dermatology/);
  assert.match(lastText(), /Type your answer/);
  await say('erythema nodosum');
  assert.match(lastText(), /Correct/);

  for (const [i, ans] of ['Psoriasis', 'Lichen planus', 'Vitiligo'].entries()) {
    files[`i${i + 2}`] = { buffer: Buffer.from(`fake-jpeg-${i + 2}`), mimeType: 'image/jpeg' };
    await send({ type: 'image', image: { id: `i${i + 2}`, mime_type: 'image/jpeg', caption: `spot derma: ${ans}` } });
  }
  out = [];
  await say('spot');
  const list = out.at(-1);
  const rows = list.interactive.action.sections[0].rows;
  assert.equal(rows.length, 4);
  const u = await store.getUser(ME);
  await tap(rows[u.state.spot.answer].id);
  assert.match(lastText(), /Correct/);
  // Image questions never show up in normal tests.
  const ids = await store.pickQuestions(ME, { count: 100 });
  for (const id of ids) assert.notEqual((await store.getQuestion(id)).origin, 'image');
});

test('voice notes need Gemini; with it they are transcribed and handled as text', async () => {
  files = { v1: { buffer: Buffer.from('ogg'), mimeType: 'audio/ogg' } };
  await send({ type: 'audio', audio: { id: 'v1', mime_type: 'audio/ogg; codecs=opus' } });
  assert.match(lastText(), /need a Gemini key/);

  const g = mockGemini(() => 'bank');
  try {
    out = [];
    await send({ type: 'audio', audio: { id: 'v1', mime_type: 'audio/ogg; codecs=opus' } });
    assert.deepEqual(g.calls[0].contents[0].parts[0], { inline_data: { mime_type: 'audio/ogg', data: Buffer.from('ogg').toString('base64') } });
    assert.match(out[0].text.body, /"bank"/);
    assert.match(lastText(), /Your question bank/);
  } finally {
    g.restore();
  }
});

test('YouTube lectures and long recordings become notes and questions (Gemini)', async () => {
  await say('https://youtu.be/abc123XYZ pharma');
  assert.match(lastText(), /need a Gemini key/);
  const result = {
    kind: 'notes',
    questions: [{ subject: 'Pharmacology', topic: 'Autonomic Nervous System', stem: 'Drug of choice for anaphylaxis', options: ['Adrenaline', 'Atropine', 'Dopamine', 'Noradrenaline'], answer_index: 0, explanation: '', answer_given_in_source: false, origin: 'notes', year: '', exam: '', page: 0 }],
    notes: [{ subject: 'Pharmacology', topic: 'Autonomic Nervous System', content: 'Adrenaline 0.5 mg IM is the first-line treatment of anaphylaxis.', page: 0 }],
  };
  const g = mockGemini(() => JSON.stringify(result));
  try {
    out = [];
    await say('https://youtu.be/abc123XYZ pharma');
    assert.deepEqual(g.calls[0].contents[0].parts[0], { file_data: { file_uri: 'https://youtu.be/abc123XYZ' } });
    assert.match(g.calls[0].contents[0].parts.at(-1).text, /recorded lecture/);
    assert.match(lastText(), /Upload complete\*\n_YouTube lecture_\n\n📝 \*Questions:\* 1\n📖 \*Note sections:\* 1/);

    files = { lec: { buffer: Buffer.alloc(2 * 1024 * 1024, 1), mimeType: 'audio/mpeg' } };
    out = [];
    result.questions[0].stem = 'Route of adrenaline in anaphylaxis';
    result.notes[0].content = 'Give adrenaline intramuscularly in the anterolateral thigh.';
    await send({ type: 'audio', audio: { id: 'lec', mime_type: 'audio/mpeg' } });
    assert.match(g.calls[1].contents[0].parts[0].inline_data.mime_type, /audio\/mpeg/);
    assert.match(lastText(), /_lecture recording_/);
  } finally {
    g.restore();
  }
});

test('coach finds weak topics and drills them', async () => {
  await say('coach');
  // Make Antiepileptics weak: three wrong answers.
  for (const q of await store.searchQuestions('seizures gingival', {})) await store.recordAttempt(ME, q.id, 3, false, 'single');
  const ae = await store.searchQuestions('antiepileptic');
  for (const q of ae) await store.recordAttempt(ME, q.id, 3, false, 'single');
  out = [];
  await say('coach');
  assert.match(lastText(), /Your coach/);
  assert.match(lastText(), /\*1\. Antiepileptics\* _\(Pharmacology\)_/);
  const row = out.at(-1).interactive.action.sections[0].rows.find((r) => r.title === 'Antiepileptics');
  out = [];
  await tap(row.id);
  assert.match(out[0].text.body, /Test: Pharmacology · "Antiepileptics"/);
  await say('stop');
});

test('flashcards from notes without AI: show, knew it, missed, summary', async () => {
  await say('flash pharma antiepileptics');
  let card = out.at(-1);
  assert.match(card.interactive.body.text, /Flashcard 1 of \d\*\n_Pharmacology › Antiepileptics \(p\.3\)_/);
  const total = Number(card.interactive.body.text.match(/Flashcard 1 of (\d)/)[1]);
  for (let i = 0; i < total; i++) {
    await tap(`flash:show:${i}`);
    assert.match(lastText(), /💡/);
    await tap(i === 0 ? `flash:no:${i}` : `flash:yes:${i}`);
  }
  assert.match(lastText(), new RegExp(`You knew \\*${total - 1} of ${total}\\*`));
  assert.match(lastText(), /Go over these/);
  await tap('flash:yes:0');
  assert.match(lastText(), /That card is done/);
});

test('similar questions and practising them', async () => {
  const [q] = await store.searchQuestions('absence seizures tonic clonic');
  const u = await store.getUser(ME);
  await store.updateUser(ME, { state: { ...u.state, lastQid: q.id } });
  await say('similar');
  assert.match(lastText(), /Similar questions/);
  assert.match(lastText(), /absence seizures/i);
  out = [];
  await tap('simtest');
  assert.match(out[0].text.body, /Test: Similar questions/);
  await say('stop');
});

test('high-yield ranks topics by PYQ years', async () => {
  await say('hy');
  assert.match(lastText(), /High-yield/);
  assert.match(lastText(), /\*1\. Antiepileptics\* _\(Pharmacology\)_\n    asked in 2 years \(2019, 2021\)/);
  await say('hy patho');
  assert.match(lastText(), /No PYQs tagged yet/);
});

test('exam date, plan, today, and the daily question follows the plan', async () => {
  const today = localNow().date;
  const exam = addDays(today, 60);
  await say(`exam ${exam.split('-').reverse().join('-')}`);
  assert.match(lastText(), /60 days to go/);
  await say('plan');
  assert.match(lastText(), /D-60 · exam on/);
  assert.match(lastText(), /Last 6 days: grand tests and revision/);
  assert.match(lastText(), /Next 7 days/);
  await say('today');
  assert.match(lastText(), /Today's plan\*  ·  D-60\n\n📘 Today's subject: \*/);
  const subject = lastText().match(/Today's subject: \*(.+?)\*/)[1];

  await store.updateUser(ME, { last_daily_date: null, last_inbound_at: new Date().toISOString(), daily_time: '00:00', daily_enabled: true });
  out = [];
  await runDueDailies();
  const card = out.find((p) => p.to === ME && p.type === 'interactive');
  assert.match(card.interactive.body.text, new RegExp(`Question of the day · D-60 · Today: ${subject.replace(/[&]/g, '\\$&')}`));
});

test('study buddies share the daily question and a leaderboard', async () => {
  await say('name Harsh');
  await say('hi', FRIEND);
  await say('name Riya', FRIEND);
  out = [];
  await say('buddy');
  const code = lastText().match(/Your code: \*(\w{6})\*/)[1];
  await say(`buddy add ${code}`, FRIEND);
  assert.match(lastText(), /You joined Harsh's group \(2 members\)/);
  await say('buddy');
  assert.match(lastText(), /Riya/);

  await store.updateUser(ME, { last_daily_date: null, last_inbound_at: new Date().toISOString(), daily_time: '00:00' });
  await store.updateUser(FRIEND, { last_daily_date: null, last_inbound_at: new Date().toISOString(), daily_time: '00:00', daily_enabled: true });
  out = [];
  await runDueDailies();
  const [a, b] = await Promise.all([store.getUser(ME), store.getUser(FRIEND)]);
  assert.ok(a.state.current && b.state.current);
  assert.equal(a.state.current.qid, b.state.current.qid, 'same daily question for the group');
  assert.match(out.find((p) => p.to === FRIEND).interactive.body.text, /same for your group/);

  await tap(`ans:${b.state.current.qid}:0`, FRIEND);
  out = [];
  await say('lb');
  assert.match(lastText(), /Leaderboard/);
  assert.match(lastText(), /Harsh \(you\)/);
  assert.match(lastText(), /Riya/);
  await say('buddy leave', FRIEND);
  assert.match(lastText(), /left your study group/);
});

test('weekly report goes out on Sunday, once', async () => {
  await store.updateUser(ME, { last_inbound_at: new Date().toISOString(), daily_time: '07:00', last_daily_date: '2026-10-25' });
  out = [];
  // Sunday 25 Oct 2026, 08:00 IST
  await runDueDailies(new Date('2026-10-25T02:30:00Z'));
  const report = out.find((p) => p.to === ME && p.type === 'text' && /Your week/.test(p.text.body));
  assert.ok(report, 'weekly report sent');
  assert.match(report.text.body, /Streak/);
  out = [];
  await runDueDailies(new Date('2026-10-25T03:30:00Z'));
  assert.ok(!out.some((p) => p.to === ME && /Your week/.test(bodyOf(p) || '')), 'not twice');
  await say('report');
  assert.match(lastText(), /Your week/);
  await say('stats');
  assert.match(lastText(), /[Ss]treak/);
  assert.match(lastText(), /in queue/);
});
