// WhatsApp Web mode: buttons become numbered replies, and the login is stored in the database.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const store = await import('../src/db.js');
const { renderPayload, mapReply, rememberChoices, toBotMessage } = await import('../src/waweb.js');

before(() => store.initDb('memory'));

test('buttons become numbered choices and a number picks one', () => {
  const r = renderPayload({
    to: '911',
    type: 'interactive',
    interactive: { type: 'button', body: { text: 'Pick one' }, action: { buttons: [{ reply: { id: 'm:q', title: 'Question' } }, { reply: { id: 'm:test', title: 'Test' } }] } },
  });
  assert.match(r.text, /Pick one\n\n\*1\.\* Question\n\*2\.\* Test\n\n_Reply with a number\._/);
  rememberChoices('911', r.choices);
  assert.deepEqual(mapReply('911', ' 2 '), { type: 'interactive', interactive: { list_reply: { id: 'm:test' } } });
  assert.equal(mapReply('911', '7'), null);
  assert.equal(mapReply('911', 'hello'), null);
  assert.equal(mapReply('922', '1'), null);
});

test('an answer list keeps letters for the answers and numbers extras from 5', () => {
  const rows = ['A', 'B', 'C', 'D'].map((t, i) => ({ id: `ans:9:${i}`, title: t, description: `opt ${t}` }));
  rows.push({ id: 'gskip:9', title: 'Skip', description: 'Leave it blank' });
  const r = renderPayload({
    to: '933',
    type: 'interactive',
    interactive: { type: 'list', body: { text: '❓ Q\n\n_Tap A, B, C or D below._' }, action: { button: 'Answer', sections: [{ title: 'x', rows }] } },
  });
  assert.match(r.text, /_Reply A, B, C or D\._/);
  assert.doesNotMatch(r.text, /opt A/);
  assert.match(r.text, /\*5\.\* Skip · _Leave it blank_/);
  rememberChoices('933', r.choices);
  assert.equal(mapReply('933', '1'), null, 'typing 1 is left to answer A');
  assert.equal(mapReply('933', '5').interactive.list_reply.id, 'gskip:9');
});

test('WhatsApp Web messages map to the bot message shape', () => {
  const key = { id: 'X1', remoteJid: '91@s.whatsapp.net' };
  assert.deepEqual(toBotMessage({ key, pushName: 'H', message: { conversation: 'hi' } }, '91'), { from: '91', id: 'X1', firstName: 'H', type: 'text', text: { body: 'hi' } });
  const doc = toBotMessage({ key, message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf', caption: 'pyq' } } } } }, '91');
  assert.equal(doc.type, 'document');
  assert.deepEqual(doc.document, { id: 'X1', mime_type: 'application/pdf', filename: 'a.pdf', caption: 'pyq' });
  assert.equal(toBotMessage({ key, message: { imageMessage: { mimetype: 'image/jpeg' } } }, '91').type, 'image');
  assert.equal(toBotMessage({ key, message: { reactionMessage: {} } }, '91'), null);
});

test('login keys are saved, replaced and removed in batches', async () => {
  await store.authSet([['creds', '{"a":1}'], ['k-1', 'one'], ['k-1', 'uno'], ['k-2', 'two']]);
  assert.deepEqual(await store.authGet(['creds', 'k-1', 'k-2', 'k-3']), { creds: '{"a":1}', 'k-1': 'uno', 'k-2': 'two' });
  await store.authSet([['k-2', null], ['k-1', 'eins']]);
  assert.deepEqual(await store.authGet(['k-1', 'k-2']), { 'k-1': 'eins' });
  await store.authClear();
  assert.deepEqual(await store.authGet(['creds']), {});
});
