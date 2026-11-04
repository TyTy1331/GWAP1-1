import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const freshState = () => ({
  version: 1, pairs: {}, levels: [], results: [], sent: {}, failed: {}, outbox: [],
  news: null, throttle: {}, lastCheckin: null, lastRecap: null, nextNum: 1, tgOffset: 0,
});

// Never crashes a run: a missing or unreadable file starts fresh (the caller warns).
export function loadState(path) {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s?.version !== 1) throw new Error('unknown state version');
    return { state: { ...freshState(), ...s }, fresh: false };
  } catch (e) {
    return { state: freshState(), fresh: true, reason: e.code === 'ENOENT' ? 'no state file' : e.message };
  }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 1));
}
