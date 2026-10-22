// Who may use the bot. Anyone can message it; strangers get a welcome and can request access, and the
// moderators (the ids in TELEGRAM_ALLOWED_IDS / ALLOWED_NUMBERS) accept or decline on Telegram.
// Each accepted person has their own record and stats; only moderators can change the study material.
import * as store from './db.js';
import * as wa from './messenger.js';
import { config, isAllowed } from './config.js';
import { localNow } from './time.js';
import { fancy } from './format.js';

export const isModerator = (phone) => isAllowed(phone);
export const canUse = (phone, user) => isModerator(phone) || user?.access === 'approved';

const MENU = { id: 'm:menu', title: '🏠 Menu' };
const USERS = { id: 'usr:list', title: '👥 Users' };

const platform = (id) => (wa.isTelegram(id) ? `Telegram · ID ${String(id).slice(3)}` : `WhatsApp · +${id}`);
const who = (u) => u.name || (wa.isTelegram(u.phone) ? `Telegram user ${u.phone.slice(3)}` : `+${u.phone}`);
const pct = (c, n) => (n ? Math.round((100 * c) / n) : 0);

function ago(ts) {
  if (!ts) return 'never';
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

const WELCOME = (name) => `👋 Hi${name ? ` ${name}` : ''}! Welcome to
🩺 ${fancy('NEET PG Study Bot')}
_Your pocket study partner for NEET PG._

✨ *What you get*
📝 Practice questions from PYQs and a big question bank
🧪 Tests and full mock exams, timed like the real one
🧠 Ask any doubt and get a short, clear answer
🔁 Smart revision that brings back what you got wrong
📊 Your own progress report, streaks and weak topics

🔐 *This bot is invite-only*
Tap *Request access* below. The admin will check it and you'll get a message right here once you're in. It's free.`;

const APPROVED = (name) => `🎉 ${fancy(`You're in${name ? `, ${name}` : ''}!`)}
_Your access is approved. Welcome aboard!_

🚀 *How to start*
1️⃣ Tap *🏠 Menu* to see everything
2️⃣ Try *📝 Question* for a quick one
3️⃣ Or just type a doubt, like _"DOC for absence seizures?"_

⏰ Every morning at ${config.defaultDailyTime} I'll send you one question of the day. Change the time in ⚙️ Settings.

📊 Your answers, scores and streaks are saved to your own account.`;

const PENDING = '⏳ *Request sent*\n\nThe admin has your request. You\'ll get a message here as soon as it\'s approved.';
const DECLINED = '🙏 Sorry, your access request wasn\'t approved this time.';

async function notifyModerators(body, buttons) {
  const mods = config.telegram.allowedIds.map((id) => `tg:${id}`);
  if (!mods.length) return console.warn('Access request: no moderator Telegram id is set (TELEGRAM_ALLOWED_IDS).');
  for (const m of mods) await wa.sendButtons(m, body, buttons).catch((e) => console.error('Moderator notice failed:', e.message));
}

/** A message from someone who can't use the bot yet. */
export async function gate(phone, user, msg) {
  const name = !user.name && msg.firstName ? String(msg.firstName).slice(0, 30) : null;
  await store.updateUser(phone, { last_inbound_at: new Date().toISOString(), ...(name ? { name } : {}) });
  if (name) user.name = name;
  const tapped = msg.interactive?.list_reply?.id || msg.interactive?.button_reply?.id;
  const typed = (msg.text?.body || '').trim().toLowerCase();
  if (user.access === 'pending') return wa.sendText(phone, PENDING);
  if (user.access === 'declined' || user.access === 'removed') return wa.sendText(phone, DECLINED);
  if (tapped === 'acc:req' || /^(request|request access|join|access)$/.test(typed)) {
    await store.updateUser(phone, { access: 'pending', access_requested_at: new Date().toISOString() });
    console.log(`Access requested by ${platform(phone)}`);
    await notifyModerators(
      `🙋 *New access request*\n\n👤 *${who(user)}*${msg.username ? ` (@${msg.username})` : ''}\n📱 ${platform(phone)}\n🕒 ${new Date().toLocaleString('en-IN', { timeZone: config.timezone, dateStyle: 'medium', timeStyle: 'short' })}`,
      [{ id: `acc:ok:${phone}`, title: '✅ Accept' }, { id: `acc:no:${phone}`, title: '❌ Decline' }]
    );
    return wa.sendText(phone, PENDING);
  }
  return wa.sendButtons(phone, WELCOME(user.name), [{ id: 'acc:req', title: '🙋 Request access' }]);
}

/** A moderator's tap on Accept / Decline / Remove / a user in the list. Returns false if it isn't one. */
export async function moderatorTap(phone, replyId) {
  if (!replyId.startsWith('acc:') && !replyId.startsWith('usr:')) return false;
  await decide(phone, replyId);
  return true;
}

async function decide(phone, replyId) {
  if (!isModerator(phone)) return wa.sendText(phone, '🔒 Only the admin can do that.');
  if (replyId === 'usr:list') return showUsers(phone);
  if (replyId.startsWith('usr:')) return showUser(phone, replyId.slice(4));
  const [, action] = replyId.split(':');
  const target = replyId.split(':').slice(2).join(':');
  const u = await store.findUser(target);
  if (!u) return wa.sendText(phone, 'That person is no longer in the database.');
  const next = { ok: 'approved', no: 'declined', rm: 'removed' }[action];
  if (!next) return;
  if (u.access === next) return wa.sendButtons(phone, `That was already done: *${who(u)}* is ${next}.`, [USERS]);
  await store.updateUser(target, { access: next, ...(next === 'approved' ? { last_daily_date: localNow().date } : {}) });
  console.log(`Access ${next} for ${platform(target)}`);
  if (next === 'approved') await wa.sendButtons(target, APPROVED(u.name), [MENU]).catch((e) => console.error('Approval notice failed:', e.message));
  else if (next === 'declined') await wa.sendText(target, DECLINED).catch(() => {});
  else await wa.sendText(target, '🔒 Your access to this bot has been removed.').catch(() => {});
  const verb = { approved: '✅ Accepted', declined: '❌ Declined', removed: '🚫 Removed' }[next];
  return wa.sendButtons(phone, `${verb} *${who(u)}*\n_${platform(target)}_`, [{ id: `usr:${target}`, title: '👤 View user' }, USERS]);
}

/** The moderator's list of everyone who has used or asked to use the bot. */
export async function showUsers(phone) {
  const rows = (await store.listUsers()).filter((u) => !isModerator(u.phone));
  if (!rows.length) return wa.sendButtons(phone, '👥 *Users*\n\nNobody else has messaged the bot yet.', [MENU]);
  const order = { pending: 0, approved: 1, removed: 2, declined: 3 };
  rows.sort((a, b) => (order[a.access] ?? 4) - (order[b.access] ?? 4) || new Date(b.last_inbound_at || 0) - new Date(a.last_inbound_at || 0));
  const icon = { pending: '⏳', approved: '✅', declined: '❌', removed: '🚫' };
  const count = (s) => rows.filter((u) => u.access === s).length;
  const lines = [
    '👥 *Users*',
    `_✅ ${count('approved')} active  ·  ⏳ ${count('pending')} waiting  ·  ❌ ${count('declined') + count('removed')} declined_`,
    '',
    ...rows.slice(0, 30).map((u) => `${icon[u.access] || '👋'} *${who(u)}* · ${wa.isTelegram(u.phone) ? 'Telegram' : 'WhatsApp'}\n     ${u.n ? `${u.n} answered · ${pct(u.c, u.n)}%` : 'no answers yet'} · active ${ago(u.last_inbound_at)}`),
    ...(rows.length > 30 ? [`_…and ${rows.length - 30} more_`] : []),
    '',
    '_Tap a person to see their stats._',
  ];
  const buttons = rows.slice(0, 9).map((u) => ({ id: `usr:${u.phone}`, title: `${icon[u.access] || '👋'} ${who(u)}`.slice(0, 24) }));
  return wa.sendMenu(phone, lines.join('\n'), [...buttons, MENU], 1, 'People');
}

/** One person's record and stats, for the moderator. */
export async function showUser(phone, target) {
  const u = await store.findUser(target);
  if (!u) return wa.sendButtons(phone, 'That person is no longer in the database.', [USERS]);
  const s = await store.userStats(target);
  const st = await store.streak(target);
  const status = { pending: '⏳ Waiting for your answer', approved: '✅ Has access', declined: '❌ Declined', removed: '🚫 Access removed' }[u.access] || '👋 Hasn\'t asked for access';
  const lines = [
    `👤 *${who(u)}*`,
    `_${platform(target)}_`,
    '',
    `🔐 *Access:* ${status}`,
    `🕒 *Last active:* ${ago(u.last_inbound_at)}`,
    u.access_requested_at ? `🙋 *Asked:* ${ago(u.access_requested_at)}` : null,
    u.exam_date ? `📆 *Exam:* ${u.exam_date}` : null,
    '',
    '📊 *Stats*',
    s.overall.n ? `🎯 *Accuracy:* ${pct(s.overall.c, s.overall.n)}% _(${s.overall.c} of ${s.overall.n} right)_` : '_No answers yet._',
    s.overall.n ? `🔥 *Streak:* ${st} ${st === 1 ? 'day' : 'days'}  ·  📅 active ${s.activeDaysThisWeek}/7 days this week` : null,
  ].filter((l) => l !== null);
  if (s.bySubject.length) lines.push('', '📚 *By subject*', ...s.bySubject.slice(0, 8).map((r) => `• ${r.subject}: *${pct(r.c, r.n)}%* _(${r.c}/${r.n})_`));
  if (s.weakTopics.length) lines.push('', '⚠️ *Weakest topics*', ...s.weakTopics.map((r) => `• ${r.topic} _(${r.subject})_: *${pct(r.c, r.n)}%*`));
  const actions =
    u.access === 'approved'
      ? [{ id: `acc:rm:${target}`, title: '🚫 Remove access' }]
      : [{ id: `acc:ok:${target}`, title: '✅ Accept' }, ...(u.access === 'pending' ? [{ id: `acc:no:${target}`, title: '❌ Decline' }] : [])];
  return wa.sendButtons(phone, lines.join('\n'), [...actions, USERS].slice(0, 3));
}

export const ADMIN_ONLY = '🔒 *Admin only*\n\nOnly the admin can add or change study material. You can practise, take tests, ask doubts and track your own stats.';
