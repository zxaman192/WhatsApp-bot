import * as store from './db.js';
import { isAllowed } from './config.js';
import { sendDaily } from './bot.js';
import { localNow } from './time.js';

/** Send the daily question to everyone whose time has come and who hasn't had one today. */
export async function runDueDailies(now = new Date()) {
  const { date, time } = localNow(now);
  const sent = [];
  for (const u of await store.allUsers()) {
    if (!u.daily_enabled || !isAllowed(u.phone)) continue;
    if (u.last_daily_date === date || u.daily_time > time) continue;
    // Mark first so a slow send or a crash can't cause a double send.
    await store.updateUser(u.phone, { last_daily_date: date });
    try {
      if (await sendDaily(u.phone)) sent.push(u.phone);
    } catch (e) {
      console.error(`Daily question to ${u.phone} failed:`, e.message);
    }
  }
  return sent;
}

export function startScheduler() {
  const tick = () => runDueDailies().catch((e) => console.error('Scheduler error', e));
  tick();
  return setInterval(tick, 60 * 1000);
}
