// Sends to WhatsApp or Telegram depending on the user id ("tg:<chat id>" is Telegram).
import * as wa from './whatsapp.js';
import * as tg from './telegram.js';

const pick = (to) => (tg.isTelegramId(to) ? tg : wa);

export const sendText = (to, body) => pick(to).sendText(to, body);
export const sendButtons = (to, body, buttons) => pick(to).sendButtons(to, body, buttons);
export const sendList = (to, body, label, rows, title) => pick(to).sendList(to, body, label, rows, title);
export const sendTemplate = (to, name, lang) => wa.sendTemplate(to, name, lang);
export const downloadMedia = (to, mediaId) => (tg.isTelegramId(to) ? tg.downloadFile(mediaId) : wa.downloadMedia(mediaId));
export const isTelegram = tg.isTelegramId;
