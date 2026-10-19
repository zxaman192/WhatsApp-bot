import * as store from './db.js';
import { isAllowed } from './config.js';
import { sendDaily, sendWeekly } from './bot.js';
import { localNow } from './time.js';

const isSunday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() === 0;

/** Send the daily question to everyone whose time has come and who hasn't had one today; on Sundays, the weekly report too. */
export async function runDueDailies(now = new Date()) {
  const { date, time } = localNow(now);
  const sent = [];
  for (const u of await store.allUsers()) {
    if (!isAllowed(u.phone) || u.daily_time > time) continue;
    if (u.daily_enabled && u.last_daily_date !== date) {
      // Mark first so a slow send or a crash can't cause a double send.
      await store.updateUser(u.phone, { last_daily_date: date });
      try {
        if (await sendDaily(u.phone)) sent.push(u.phone);
      } catch (e) {
        console.error(`Daily question to ${u.phone} failed:`, e.message);
      }
    }
    // The weekly report waits until WhatsApp's 24-hour window is open, so it is retried until it goes out that Sunday.
    if (isSunday(date) && u.last_weekly_date !== date) {
      try {
        if (await sendWeekly(u.phone)) await store.updateUser(u.phone, { last_weekly_date: date });
      } catch (e) {
        await store.updateUser(u.phone, { last_weekly_date: date });
        console.error(`Weekly report to ${u.phone} failed:`, e.message);
      }
    }
  }
  return sent;
}

export function startScheduler() {
  const tick = () => runDueDailies().catch((e) => console.error('Scheduler error', e));
  tick();
  return setInterval(tick, 60 * 1000);
}
