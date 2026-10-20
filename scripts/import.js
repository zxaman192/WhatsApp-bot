// Bulk-import files from your computer straight into the database.
//   npm run import -- notes/pharma.pdf qbank/*.pdf --caption "pharma"
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { initDb, closeDb } from '../src/db.js';
import { ingest, formatSummary } from '../src/ingest/index.js';

const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const args = process.argv.slice(2);
const ci = args.indexOf('--caption');
const caption = ci >= 0 ? args.splice(ci, 2)[1] : '';
if (!args.length) {
  console.log('Usage: npm run import -- <file> [more files] [--caption "subject"]');
  process.exit(1);
}

await initDb();
for (const path of args) {
  const summary = await ingest({
    buffer: await readFile(path),
    mimeType: MIME[extname(path).toLowerCase()] || 'text/plain',
    filename: basename(path),
    caption,
    addedBy: 'import',
    onProgress: async (m) => console.log(`  ${m}`),
  });
  console.log(formatSummary(summary, basename(path)).replace(/\*/g, ''), '\n');
}
await closeDb();
