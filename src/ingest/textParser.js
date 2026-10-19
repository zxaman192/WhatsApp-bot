// Offline parser for text that is already laid out as numbered MCQs, e.g.
//
//   1. Drug of choice for absence seizures?
//   a) Ethosuximide   b) Phenytoin
//   c) Carbamazepine  d) Phenobarbitone
//   Ans: a
//   Explanation: ...
//
// Used when no Claude API key is set, and as a cheap first pass. Anything messier goes to Claude.

const Q_START = /^\s*(?:Q(?:uestion)?\s*\.?\s*)?(\d{1,4})\s*[.)\]:-]\s+(.*)$/i;
const OPT = /(?:^|\s)\(?([a-dA-D])\s*[).:\]]\s+/g;
const ANS = /^\s*(?:correct\s+)?(?:ans(?:wer)?|key)\s*[.:\-]?\s*\(?([a-dA-D])\)?\b/i;
const EXPL = /^\s*(?:explanation|expl|exp|reason|solution)\s*[.:\-]\s*(.*)$/i;
const YEAR = /\b(?:NEET\s*PG|AIIMS|INI[\s-]*CET|PGI|FMGE|AIPGMEE|JIPMER)?\s*[([]?\s*((?:19|20)\d{2})\s*[)\]]?/i;

function splitOptions(text) {
  const marks = [...text.matchAll(OPT)];
  if (marks.length < 4) return null;
  // Use the first a, b, c, d marks in order.
  const want = ['a', 'b', 'c', 'd'];
  const seq = [];
  for (const m of marks) {
    if (m[1].toLowerCase() === want[seq.length]) seq.push(m);
    if (seq.length === 4) break;
  }
  if (seq.length < 4) return null;
  const options = seq.map((m, i) => {
    const start = m.index + m[0].length;
    const end = i < 3 ? seq[i + 1].index : text.length;
    return text.slice(start, end).trim();
  });
  return { before: text.slice(0, seq[0].index).trim(), options };
}

// A line made only of answer-key pairs: "1-b 2-c 3-a", "12. (d)", "1 b, 2 a".
const KEY_LINE = /^\s*(?:\d{1,4}\s*[.)\-:]?\s*\(?[a-dA-D]\)?[\s,;|]*)+$/;
const KEY_PAIR = /(\d{1,4})\s*[.)\-:]?\s*\(?([a-dA-D])\)?(?![a-zA-Z])/g;

export function parseFormattedMcqs(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const key = {};
  const blocks = [];
  let cur = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (KEY_LINE.test(line) && /\d/.test(line)) {
      for (const k of line.matchAll(KEY_PAIR)) key[k[1]] = 'abcd'.indexOf(k[2].toLowerCase());
      continue;
    }
    if (/^\s*(answer\s*key|answers|key)\s*:?\s*$/i.test(line)) continue;
    const m = line.match(Q_START);
    // A new numbered line starts a question unless it looks like an option or answer line.
    if (m && !ANS.test(line) && !/^\s*\(?[a-d]\s*[).]/i.test(line)) {
      if (cur) blocks.push(cur);
      cur = { lines: [m[2]], num: m[1], line: li };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) blocks.push(cur);

  const questions = [];
  let skipped = 0;
  for (const b of blocks) {
    let answer = null;
    let explanation = '';
    const body = [];
    let inExpl = false;
    for (const l of b.lines) {
      const a = l.match(ANS);
      const e = l.match(EXPL);
      if (a) { answer = 'abcd'.indexOf(a[1].toLowerCase()); inExpl = false; continue; }
      if (e) { explanation = e[1]; inExpl = true; continue; }
      if (inExpl) { explanation += (explanation ? ' ' : '') + l.trim(); continue; }
      body.push(l);
    }
    if (answer == null && key[b.num] != null) answer = key[b.num];
    const split = splitOptions(body.join('\n'));
    if (!split || answer == null || answer < 0 || !split.before) { skipped++; continue; }
    const y = split.before.match(YEAR);
    questions.push({
      stem: split.before.replace(/\s+/g, ' ').trim(),
      options: split.options.map((o) => o.replace(/\s+/g, ' ')),
      answer,
      explanation: explanation.trim(),
      year: y && /pg|aiims|ini|pgi|fmge|aipgmee|jipmer/i.test(y[0]) ? y[1] : '',
      line: b.line,
    });
  }
  return { questions, skipped, blocks: blocks.length };
}
