import * as store from './db.js';
import { isAllowed } from './config.js';
import { sendDaily, sendWeekly, resumeJobs } from './bot.js';
import { localNow } from './time.js';

const isSunday = (day) => new Date(`${day}T12:00:00Z`).getUTCDay() === 0;

/** Send the daily question to everyone whose time has come and who hasn't had one today; on Sundays, the weekly report too. */
export async function runDueDailies(now = new Date()) {
  const { date, time } = localNow(now);
  const sent = [];
  for (const u of await store.allUsers()) {
    if (!isAllowed(u.phone) || u.daily_time > time) continue;
    // Claim the day first (atomically) so a slow send, a crash or a second instance can't cause a double send.
    if (u.daily_enabled && u.last_daily_date !== date && (await store.claimDay(u.phone, 'last_daily_date', date))) {
      try {
        if (await sendDaily(u.phone)) sent.push(u.phone);
      } catch (e) {
        console.error(`Daily question to ${u.phone} failed:`, e.message);
      }
    }
    // The weekly report waits until WhatsApp's 24-hour window is open, so it is retried until it goes out that Sunday.
    if (isSunday(date) && u.last_weekly_date !== date) {
      try {
        if (await sendWeekly(u.phone)) await store.claimDay(u.phone, 'last_weekly_date', date);
      } catch (e) {
        await store.claimDay(u.phone, 'last_weekly_date', date);
        console.error(`Weekly report to ${u.phone} failed:`, e.message);
      }
    }
  }
  return sent;
}

export function startScheduler() {
  let busy = false;
  const tick = async () => {
    // A slow tick (many users, slow network) must not overlap the next one.
    if (busy) return;
    busy = true;
    try {
      await runDueDailies();
    } catch (e) {
      console.error('Scheduler error', e);
    } finally {
      busy = false;
    }
  };
  tick();
  // Uploads interrupted by a restart, or paused until the AI quota resets, carry on by themselves.
  const resume = () => resumeJobs().catch((e) => console.error('Resuming uploads failed', e));
  setTimeout(resume, 5000);
  setInterval(resume, 5 * 60 * 1000);
  return setInterval(tick, 60 * 1000);
}
