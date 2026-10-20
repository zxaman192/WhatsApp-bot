// Sends to WhatsApp or Telegram depending on the user id ("tg:<chat id>" is Telegram).
import * as wa from './whatsapp.js';
import * as tg from './telegram.js';
import { polish } from './format.js';

const pick = (to) => (tg.isTelegramId(to) ? tg : wa);

export const sendText = (to, body) => pick(to).sendText(to, polish(body));
export const sendButtons = (to, body, buttons) => pick(to).sendButtons(to, polish(body), buttons);
export const sendList = (to, body, label, rows, title) => pick(to).sendList(to, polish(body), label, rows, title);
export const sendMenu = (to, body, buttons, columns = 2, label) => pick(to).sendMenu(to, polish(body), buttons, columns, label);
/** Telegram: also install the quick-access keyboard. WhatsApp: plain text. */
export const sendWithKeyboard = (to, body) => (tg.isTelegramId(to) ? tg.sendWithKeyboard(to, polish(body)) : wa.sendText(to, polish(body)));
export const sendImage = (to, buffer, mime, caption) => pick(to).sendImage(to, buffer, mime, caption && polish(caption));
export const sendTemplate = (to, name, lang) => wa.sendTemplate(to, name, lang);
export const downloadMedia = (to, mediaId) => (tg.isTelegramId(to) ? tg.downloadFile(mediaId) : wa.downloadMedia(mediaId));
export const isTelegram = tg.isTelegramId;
/** Show "typing…" (Telegram only; WhatsApp Cloud API has no equivalent for bots). */
export const typing = (to) => (tg.isTelegramId(to) ? tg.typing(to) : undefined);
