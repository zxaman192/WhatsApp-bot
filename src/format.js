// One look for every message, on WhatsApp and Telegram.
// Commands the user can type are shown as `code` (tap to copy on Telegram), so they stand out from bold text.
const COMMANDS =
  'q|question|test|grand|revise|spot|flash|similar|stop|skip|explain|where|why|hy|exam|plan|today|coach|stats|bank|report|daily|buddy|lb|name|fix|delete|menu|help|settings|database|db';
const CMD = new RegExp(`(^|[^\\w*\`])\\*((?:${COMMANDS})(?:[\\s:][^*\\n]{0,60})?)\\*(?![\\w*])`, 'g');

export function polish(text) {
  return String(text ?? '')
    // AI answers sometimes come back in Markdown; WhatsApp would show the raw # and ** marks.
    .replace(/^\s*#{1,6}\s+(.+)$/gm, (_, h) => `*${h.replace(/\*/g, '')}*`)
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '*$1*')
    .replace(CMD, '$1`$2`')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Headline letters in Unicode bold sans (𝗡𝗘𝗘𝗧 𝗣𝗚), for welcome and intro titles. Looks the same on WhatsApp and Telegram. */
export function fancy(text) {
  return [...String(text)]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5d4 + c - 65);
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ee + c - 97);
      if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ec + c - 48);
      return ch;
    })
    .join('');
}
