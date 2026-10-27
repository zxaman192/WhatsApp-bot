// Print every screen the bot sends, as Telegram would get it, so the formatting can be reviewed in one place.
//   node scripts/screens.js [whatsapp]
import { config } from '../src/config.js';

config.dryRun = true;
config.telegram.dryRun = true;
config.anthropic.apiKey = '';
config.gemini.apiKey = '';
config.groq.apiKey = '';
config.telegram.allowedIds = ['1'];
config.allowedNumbers = [];

const store = await import('../src/db.js');
const wa = await import('../src/whatsapp.js');
const tg = await import('../src/telegram.js');
const { handleMessage } = await import('../src/bot.js');

const asWhatsApp = process.argv[2] === 'whatsapp';
const ME = asWhatsApp ? '911111111111' : 'tg:1';
const show = (_to, p) => {
  if (p.type === 'telegram') {
    console.log(p.text);
    const kb = p.reply_markup?.inline_keyboard || p.reply_markup?.keyboard || [];
    for (const row of kb) console.log('   ' + row.map((b) => `[ ${b.text} ]`).join(' '));
  } else if (p.type === 'text') console.log(p.text.body);
  else if (p.type === 'interactive') {
    console.log(p.interactive.body.text);
    const rows = p.interactive.action.sections?.flatMap((s) => s.rows) || p.interactive.action.buttons?.map((b) => b.reply) || [];
    for (const r of rows) console.log(`   [ ${r.title} ]${r.description ? ' ' + r.description : ''}`);
  } else console.log(JSON.stringify(p).slice(0, 300));
  console.log('──────────');
};
wa.setSink(show);
tg.setSink(show);

await store.initDb('memory');
const SEED = [
  ['Pharmacology', 'Antiepileptics', 'Drug of choice for absence seizures', ['Ethosuximide', 'Phenytoin', 'Carbamazepine', 'Phenobarbitone'], 0, 'pyq', '2019'],
  ['Pharmacology', 'Anticoagulants', 'Antidote for heparin overdose', ['Vitamin K', 'Protamine sulfate', 'Desferrioxamine', 'Flumazenil'], 1, 'bank', ''],
  ['Pathology', 'Neoplasia', 'Psammoma bodies are seen in', ['Papillary carcinoma thyroid', 'Follicular carcinoma', 'Medullary carcinoma', 'Anaplastic carcinoma'], 0, 'bank', ''],
  ['Medicine', 'Cardiology', 'Drug of choice for paroxysmal SVT', ['Adenosine', 'Digoxin', 'Amiodarone', 'Lignocaine'], 0, 'pyq', '2021'],
  ['ENT', 'Nose', 'Most common site of epistaxis', ["Little's area", 'Woodruff plexus', 'Inferior turbinate', 'Septal spur'], 0, 'bank', ''],
];
const src = await store.addSource('dams ent.pdf', 'pdf', ME);
for (const [subject, topic, stem, options, answer, origin, year] of SEED) {
  await store.addQuestion({ subject, topic, stem, options, answer, explanation: 'Ethosuximide blocks T-type calcium channels in the thalamus.', year, exam: year ? 'NEET PG' : '', answerChecked: true, origin, page: 3, sourceId: src });
}
await store.addNote({ subject: 'Pharmacology', topic: 'Antiepileptics', content: '*Absence seizures*\n• Ethosuximide is the drug of choice for absence seizures.\n• Valproate if generalised tonic-clonic seizures coexist.\n• Phenytoin causes gingival hyperplasia.', page: 3, sourceId: src });

let n = 0;
const send = (extra) => handleMessage({ from: ME, id: `s${++n}`, ...extra }, { download: async () => ({ buffer: Buffer.from(''), mimeType: 'text/plain' }) });
const say = async (body) => { console.log(`\n▶ YOU: ${body}\n`); await send({ type: 'text', text: { body } }); };
const tap = async (id) => { console.log(`\n▶ TAP: ${id}\n`); await send({ type: 'interactive', interactive: { list_reply: { id } } }); };

const script = (process.argv[3] || '').split('|').filter(Boolean);
const steps = script.length ? script : [
  'hi', 'menu', 'help', 'q', 'A', 'why', 'similar', 'q', 'B', 'test 3', 'A', 'B', 'C', 'stats', 'bank', 'today', 'revise',
  'grand', 'coach', 'flash', 'hy', 'spot', 'settings', 'database', 'tap:db:files:0', `tap:dbf:${src}`, 'explain ethosuximide',
  'where absence seizure', 'asdfgh', 'exam 2027-03-01', 'name Harsh', 'delete my data',
];
for (const s of steps) s.startsWith('tap:') ? await tap(s.slice(4)) : await say(s);
await new Promise((r) => setTimeout(r, 300));
await store.closeDb();
process.exit(0);
