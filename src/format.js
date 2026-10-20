// One look for every message, on WhatsApp and Telegram.
// Commands the user can type are shown as `code` (tap to copy on Telegram), so they stand out from bold text.
const COMMANDS =
  'q|question|test|grand|revise|spot|flash|similar|stop|skip|explain|where|why|hy|exam|plan|today|coach|stats|bank|report|daily|buddy|lb|name|fix|delete|menu|help|settings|database|db';
const CMD = new RegExp(`(^|[^\\w*\`])\\*((?:${COMMANDS})(?:[\\s:][^*\\n]{0,60})?)\\*(?![\\w*])`, 'g');

export function polish(text) {
  return String(text ?? '')
    .replace(CMD, '$1`$2`')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
