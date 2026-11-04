import { esc, tag } from './telegram.js';
import { TF_LABEL } from './config.js';

const REPORT = /#(\d{1,3})\s*(TP|SL)\b/gi;

// "#05TP", "#5 sl", "#12 TP and #13SL" → [{num, outcome}]
export function parseReports(text) {
  return [...String(text).matchAll(REPORT)].map((m) => ({ num: Number(m[1]), outcome: m[2].toUpperCase() }));
}

const label = (l) => `${tag(l.num)} ${l.pair.split(':').pop()} ${TF_LABEL[l.tf]} ${l.dir === 'bull' ? 'BUY' : 'SELL'}`;

// Records a reported outcome on the newest trade with that number. Returns the reply text.
export function applyReport(state, { num, outcome }, now) {
  const level = state.levels.filter((l) => l.num === num).sort((a, b) => b.formedClose - a.formedClose)[0];
  if (!level) return `❓ No trade ${tag(num)} found. Only the last 14 days are kept.`;
  const changed = level.reported && level.reported !== outcome;
  Object.assign(level, { reported: outcome, reportedAt: now });
  return `📝 ${esc(label(level))} ${changed ? 'changed to' : 'marked'} ${outcome === 'TP' ? 'TP ✅' : 'SL ❌'}. It will be in the weekly recap.`;
}

// Reads new messages sent to the bot. Only the configured chat can report trades; when the bot
// is added to another group, it tells the configured chat that group's ID.
export async function readInbox(state, { token, chatId, fetchFn = fetch, now }) {
  const replies = [];
  const params = new URLSearchParams({ offset: String((state.tgOffset ?? 0) + 1), timeout: '0', allowed_updates: '["message","my_chat_member"]' });
  const res = await fetchFn(`https://api.telegram.org/bot${token}/getUpdates?${params}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`Telegram getUpdates ${res.status}`);
  for (const u of data.result ?? []) {
    state.tgOffset = Math.max(state.tgOffset ?? 0, u.update_id);
    const joined = u.my_chat_member;
    if (joined && ['member', 'administrator'].includes(joined.new_chat_member?.status) && String(joined.chat.id) !== chatId) {
      replies.push({ id: `joined:${joined.chat.id}`, text: `📍 I was added to "${esc(joined.chat.title ?? 'a chat')}". Its chat ID is <code>${joined.chat.id}</code>. To send alerts there, set the TELEGRAM_CHAT_ID secret to this number.` });
      continue;
    }
    const msg = u.message;
    if (!msg?.text || String(msg.chat.id) !== chatId) continue;
    parseReports(msg.text).forEach((r, i) => replies.push({ id: `report:${u.update_id}:${i}`, text: applyReport(state, r, now) }));
  }
  return replies;
}
