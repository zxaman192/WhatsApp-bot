import { config } from './config.js';

const graph = () => `https://graph.facebook.com/${config.whatsapp.graphVersion}`;

// In DRY_RUN mode (and in tests / the terminal simulator) messages go to this sink instead of WhatsApp.
let sink = (to, payload) => console.log(`[DRY_RUN → ${to}]`, JSON.stringify(payload, null, 2));
export function setSink(fn) {
  sink = fn;
}

async function post(payload) {
  if (config.dryRun) {
    sink(payload.to, payload);
    return;
  }
  const res = await fetch(`${graph()}/${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp send failed (${res.status}): ${body}`);
  }
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function sendText(to, body) {
  // WhatsApp caps text bodies at 4096 chars.
  return post({ to, type: 'text', text: { body: clip(body, 4096), preview_url: false } });
}

/** Up to 3 quick-reply buttons. buttons: [{id, title}] */
export function sendButtons(to, body, buttons) {
  return post({
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(body, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id, title: clip(b.title, 20) } })),
      },
    },
  });
}

/** A list picker with up to 10 rows. rows: [{id, title, description?}] */
export function sendList(to, body, buttonLabel, rows, sectionTitle = 'Options') {
  return post({
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(body, 4096) },
      action: {
        button: clip(buttonLabel, 20),
        sections: [
          {
            title: clip(sectionTitle, 24),
            rows: rows.slice(0, 10).map((r) => ({
              id: r.id,
              title: clip(r.title, 24),
              ...(r.description ? { description: clip(r.description, 72) } : {}),
            })),
          },
        ],
      },
    },
  });
}

/** Approved template, needed to start a conversation after the 24h window closes. */
export function sendTemplate(to, name, lang) {
  return post({ to, type: 'template', template: { name, language: { code: lang } } });
}

/** Download media a user sent. Returns { buffer, mimeType }. */
export async function downloadMedia(mediaId) {
  const auth = { Authorization: `Bearer ${config.whatsapp.token}` };
  const meta = await fetch(`${graph()}/${mediaId}`, { headers: auth });
  if (!meta.ok) throw new Error(`Media lookup failed (${meta.status})`);
  const { url, mime_type: mimeType } = await meta.json();
  const file = await fetch(url, { headers: auth });
  if (!file.ok) throw new Error(`Media download failed (${file.status})`);
  return { buffer: Buffer.from(await file.arrayBuffer()), mimeType };
}
