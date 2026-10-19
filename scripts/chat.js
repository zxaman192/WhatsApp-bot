// Talk to the bot in your terminal, no WhatsApp needed.
//   npm run chat
// Type messages as you would on WhatsApp. Extra commands:
//   /file path/to/notes.pdf [caption]   send a file (PDF, image or .txt)
//   /tap <id>                           tap a list row or button (ids are printed with each menu)
//   /daily                              send yourself today's question now
//   /quit
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { config } from '../src/config.js';
import { initDb, closeDb } from '../src/db.js';
import { setSink } from '../src/whatsapp.js';
import { handleMessage, sendDaily } from '../src/bot.js';

config.dryRun = true;
const ME = config.allowedNumbers[0] || '910000000000';
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.md': 'text/plain' };

setSink((_to, p) => {
  console.log('\n\x1b[32m🤖 Bot\x1b[0m');
  if (p.type === 'text') console.log(p.text.body);
  else if (p.type === 'interactive') {
    console.log(p.interactive.body.text);
    const rows = p.interactive.action.sections?.[0]?.rows || p.interactive.action.buttons?.map((b) => b.reply) || [];
    for (const r of rows) console.log(`  [/tap ${r.id}] ${r.title}${r.description ? ' — ' + r.description : ''}`);
  } else console.log(JSON.stringify(p));
});

await initDb();
let files = {};
let n = 0;
const msg = (extra) => ({ from: ME, id: `local-${++n}`, timestamp: String(Date.now() / 1000), ...extra });
const download = async (id) => files[id];

const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => rl.setPrompt('\n\x1b[36mYou › \x1b[0m') || rl.prompt();
console.log(`Chatting as ${ME}. Database: ${config.databaseUrl ? 'Postgres (DATABASE_URL)' : config.pgliteDir}. Claude: ${config.anthropic.apiKey ? 'on' : 'off'}. Type "help".`);
prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (!process.stdin.isTTY) console.log(line);
  if (!line) { prompt(); continue; }
  if (line === '/quit') break;
  if (line === '/daily') { await sendDaily(ME); prompt(); continue; }
  if (line.startsWith('/tap ')) {
    const id = line.slice(5).trim();
    await handleMessage(msg({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: id } } }));
    prompt();
    continue;
  }
  if (line.startsWith('/file ')) {
    const [path, ...cap] = line.slice(6).trim().split(' ');
    const mime = MIME[extname(path).toLowerCase()] || 'text/plain';
    const id = `media-${n}`;
    files = { [id]: { buffer: await readFile(path), mimeType: mime } };
    const type = mime.startsWith('image/') ? 'image' : 'document';
    await handleMessage(msg({ type, [type]: { id, mime_type: mime, filename: basename(path), caption: cap.join(' ') } }), { download });
    prompt();
    continue;
  }
  await handleMessage(msg({ type: 'text', text: { body: line } }));
  prompt();
}
rl.close();
await closeDb();
