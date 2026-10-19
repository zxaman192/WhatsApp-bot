// Picks the AI provider: AI_PROVIDER if set, otherwise whichever key is present (Gemini first, as it has a free tier).
import { config } from '../config.js';
import { claudeAvailable, extractWithClaude, explainFromNotes } from './claude.js';
import { geminiAvailable, extractWithGemini, explainWithGemini } from './gemini.js';

export function provider() {
  const want = config.aiProvider;
  if (want === 'claude') return claudeAvailable() ? 'claude' : null;
  if (want === 'gemini') return geminiAvailable() ? 'gemini' : null;
  if (want === 'none') return null;
  return geminiAvailable() ? 'gemini' : claudeAvailable() ? 'claude' : null;
}

export const aiAvailable = () => provider() !== null;

export const extract = (blocks, opts) => (provider() === 'gemini' ? extractWithGemini(blocks, opts) : extractWithClaude(blocks, opts));

export const explain = (question, excerpts) =>
  provider() === 'gemini' ? explainWithGemini(question, excerpts) : explainFromNotes(question, excerpts);
