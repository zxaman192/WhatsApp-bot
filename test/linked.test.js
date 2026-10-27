// One person on WhatsApp and Telegram shares one account: a question started on one app is answered on the other.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';

config.dryRun = true;
config.telegram.dryRun = true;
config.anthropic.apiKey = '';
config.gemini.apiKey = '';
config.allowedNumbers = [];
config.telegram.allowedIds = ['5'];
config.linkedAccounts = [['915550000000', 'tg:5']];

const store = await import('../src/db.js');
// Titles are set in Unicode bold letters; tests read them as plain text.
const { unfancy } = await import('../src/format.js');
const plain = (p) => JSON.parse(unfancy(JSON.stringify(p)));
const { setSink } = await import('../src/whatsapp.js');
const tg = await import('../src/telegram.js');
const { handleMessage } = await import('../src/bot.js');

const WA = '915550000000';
const TG = 'tg:5';
let out = [];
setSink((to, p) => out.push(plain({ ...p, to })));
tg.setSink((to, p) => out.push(plain({ ...p, to })));
let n = 0;
const say = (from, body) => handleMessage({ from, id: `l${++n}`, type: 'text', text: { body } });

before(async () => {
  await store.initDb('memory');
  await store.addQuestion({ subject: 'Pharmacology', topic: 'Antiepileptics', stem: 'Drug of choice for absence seizures', options: ['Ethosuximide', 'Phenytoin', 'Carbamazepine', 'Phenobarbitone'], answer: 0, explanation: '', year: '', exam: '', answerChecked: true, origin: 'bank', page: null });
  await say(TG, 'hi');
});
after(() => store.closeDb());

test('a question asked on WhatsApp can be answered on Telegram, and stats are shared', async () => {
  out = [];
  await say(WA, 'q');
  assert.equal(out.at(-1).to, WA, 'the question goes to the app that asked');
  assert.ok((await store.getUser(TG)).state.current, 'the open question lives on the shared account');
  out = [];
  await say(TG, 'A');
  assert.equal(out[0].to, TG);
  assert.equal((await store.userStats(WA)).total ?? (await store.userStats(TG)).total, (await store.userStats(TG)).total);
  const rows = await store.allUsers();
  assert.ok(!rows.some((u) => u.phone === WA), 'the linked number gets no separate daily question');
});
