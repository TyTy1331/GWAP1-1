import { esc, tag } from './telegram.js';
import { TF_LABEL } from './config.js';
import { statsText } from './reports.js';

const REPORT = /#(\d{1,3})\s*(TP|SL|B\/?E)\b/gi;

// "#05TP", "#5 sl", "#7BE", "#8 b/e", "#12 TP and #13SL" → [{num, outcome}]
export function parseReports(text) {
  return [...String(text).matchAll(REPORT)].map((m) => ({ num: Number(m[1]), outcome: m[2].toUpperCase().replace('/', '') }));
}

// A bare "TP" / "sl" / "b/e" sent as a Telegram reply to an alert counts for the trade number in that alert.
export function replyReport(msg) {
  const m = /^\s*(TP|SL|B\/?E)\s*[.!✅❌]*\s*$/i.exec(msg.text ?? '');
  const num = /#(\d{1,3})\b/.exec(msg.reply_to_message?.text ?? '');
  return m && num ? `#${num[1]}${m[1]}` : null;
}

const label = (l) => `${tag(l.num)} ${l.pair.split(':').pop()} ${TF_LABEL[l.tf]} ${l.dir === 'bull' ? 'BUY' : 'SELL'}`;

// Records a reported outcome on the newest trade with that number. Returns the reply text.
export function applyReport(state, { num, outcome }, now) {
  const level = state.levels.filter((l) => l.num === num).sort((a, b) => b.formedClose - a.formedClose)[0];
  if (!level) return `❓ No trade ${tag(num)} found. Only the last 14 days are kept.`;
  const changed = level.reported && level.reported !== outcome;
  Object.assign(level, { reported: outcome, reportedAt: now });
  return `📝 ${esc(label(level))} ${changed ? 'changed to' : 'marked'} ${{ TP: 'TP ✅', SL: 'SL ❌', BE: 'B/E ➖' }[outcome]}. It will be in the weekly recap.`;
}

// Reads new messages sent to the bot. Only the configured chat can report trades; when the bot
// is added to another group, it tells the configured chat that group's ID.
export async function readInbox(state, { token, chatId, fetchFn = fetch, now }) {
  const replies = [];
  // Telegram returns at most 100 updates per call and keeps unread ones for 24h: read until empty.
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ offset: String((state.tgOffset ?? 0) + 1), limit: '100', timeout: '0', allowed_updates: '["message","my_chat_member"]' });
    const res = await fetchFn(`https://api.telegram.org/bot${token}/getUpdates?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`Telegram getUpdates ${res.status}`);
    if (!data.result?.length) break;
    for (const u of data.result) {
      state.tgOffset = Math.max(state.tgOffset ?? 0, u.update_id);
      const joined = u.my_chat_member;
      if (joined && ['member', 'administrator'].includes(joined.new_chat_member?.status) && String(joined.chat.id) !== chatId) {
        replies.push({ id: `joined:${joined.chat.id}`, text: `📍 I was added to "${esc(joined.chat.title ?? 'a chat')}". Its chat ID is <code>${joined.chat.id}</code>. To send alerts there, set the TELEGRAM_CHAT_ID secret to this number.` });
        continue;
      }
      const msg = u.message;
      if (!msg?.text || String(msg.chat.id) !== chatId) continue;
      if (/^\/stats(@\w+)?\s*$/i.test(msg.text)) { replies.push({ id: `stats:${u.update_id}`, text: statsText(state, now) }); continue; }
      parseReports(replyReport(msg) ?? msg.text).forEach((r, i) => replies.push({ id: `report:${u.update_id}:${i}`, text: applyReport(state, r, now) }));
    }
  }
  return replies;
}
