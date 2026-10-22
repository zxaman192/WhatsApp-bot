// Public mode: strangers request access, the moderator accepts or declines on Telegram and sees everyone's stats.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';

config.dryRun = true;
config.telegram.dryRun = true;
config.anthropic.apiKey = '';
config.gemini.apiKey = '';
config.allowedNumbers = ['910000000001'];
config.telegram.allowedIds = ['1'];

const store = await import('../src/db.js');
const { setSink } = await import('../src/whatsapp.js');
const tg = await import('../src/telegram.js');
const { handleMessage } = await import('../src/bot.js');
const { runDueDailies } = await import('../src/scheduler.js');

const MOD = 'tg:1';
const NEW = '919999900000';
const OTHER = 'tg:42';
let out = [];
setSink((to, p) => out.push({ ...p, to }));
tg.setSink((to, p) => out.push({ ...p, to }));
let n = 0;
const send = (from, extra) => handleMessage({ from, id: `a${++n}`, ...extra });
const say = (from, body, extra = {}) => send(from, { type: 'text', text: { body }, ...extra });
const tap = (from, id) => send(from, { type: 'interactive', interactive: { list_reply: { id } } });
const body = (p) => p.raw ?? (p.type === 'text' ? p.text.body : p.interactive?.body?.text);
const ids = (p) => (p.reply_markup?.inline_keyboard?.flat().map((b) => b.callback_data)) ?? (p.interactive?.action?.buttons?.map((b) => b.reply.id) || p.interactive?.action?.sections?.flatMap((s) => s.rows.map((r) => r.id)) || []);
const to = (who) => out.filter((p) => p.to === who);

before(async () => {
  await store.initDb('memory');
  await store.addQuestion({ subject: 'Pharmacology', topic: 'Antiepileptics', stem: 'Drug of choice for absence seizures', options: ['Ethosuximide', 'Phenytoin', 'Carbamazepine', 'Phenobarbitone'], answer: 0, explanation: '', year: '', exam: '', answerChecked: true, origin: 'bank', page: null });
});
after(() => store.closeDb());

test('a stranger gets the welcome and can request access; the moderator is asked on Telegram', async () => {
  out = [];
  await say(NEW, 'hi', { firstName: 'Riya' });
  const welcome = to(NEW).at(-1);
  assert.match(body(welcome), /invite-only/);
  assert.match(body(welcome), /Riya/);
  assert.deepEqual(ids(welcome), ['acc:req']);
  await say(NEW, 'q');
  assert.match(body(to(NEW).at(-1)), /invite-only/, 'no practice before access');

  out = [];
  await tap(NEW, 'acc:req');
  assert.match(body(to(NEW).at(-1)), /Request sent/);
  const ask = to(MOD).at(-1);
  assert.match(body(ask), /New access request/);
  assert.match(body(ask), /Riya/);
  assert.deepEqual(ids(ask), [`acc:ok:${NEW}`, `acc:no:${NEW}`]);
  out = [];
  await tap(NEW, 'acc:req');
  assert.equal(to(MOD).length, 0, 'asking twice does not ping the moderator again');
  assert.equal((await runDueDailies(new Date('2030-01-01T12:00:00Z'))).includes(NEW), false, 'no daily question while waiting');
});

test('accepting lets them practise with their own record, but not change the material', async () => {
  out = [];
  await tap(MOD, `acc:ok:${NEW}`);
  assert.match(body(to(NEW).at(-1)), /in, Riya|approved/i);
  assert.match(body(to(MOD).at(-1)), /Accepted/);
  out = [];
  await say(NEW, 'q');
  assert.match(body(to(NEW).at(-1)), /absence seizures/);
  await say(NEW, 'A');
  assert.equal((await store.userStats(NEW)).overall.n, 1);
  assert.equal((await store.userStats(MOD)).overall.n, 0, 'separate stats');
  out = [];
  await send(NEW, { type: 'document', document: { id: 'x', mime_type: 'application/pdf', filename: 'x.pdf' } });
  assert.match(body(to(NEW).at(-1)), /Admin only/);
  await say(NEW, 'database');
  assert.match(body(to(NEW).at(-1)), /Admin only/);
  await say(NEW, 'menu');
  assert.ok(!ids(to(NEW).at(-1)).includes('m:db'));
  await tap(NEW, `acc:ok:${OTHER}`);
  assert.match(body(to(NEW).at(-1)), /Only the admin/);
});

test('declining, and the moderator users list with stats', async () => {
  await say(OTHER, 'hello');
  await tap(OTHER, 'acc:req');
  out = [];
  await tap(MOD, `acc:no:${OTHER}`);
  assert.match(body(to(OTHER).at(-1)), /wasn't approved/);
  out = [];
  await say(MOD, 'users');
  const list = to(MOD).at(-1);
  assert.match(body(list), /Riya/);
  assert.match(body(list), /1 answered · 100%/);
  assert.ok(ids(list).includes(`usr:${NEW}`));
  out = [];
  await tap(MOD, `usr:${NEW}`);
  assert.match(body(to(MOD).at(-1)), /Accuracy:.*100%/);
  assert.ok(ids(to(MOD).at(-1)).includes(`acc:rm:${NEW}`));
  await tap(MOD, `acc:rm:${NEW}`);
  out = [];
  await say(NEW, 'q');
  assert.match(body(to(NEW).at(-1)), /wasn't approved/);
});
