// Exits 0 when a run is due, 1 when this trigger can be skipped (quiet hours and this hour already checked).
// Uses no npm packages, so the workflow can call it before installing anything. Usage: node scripts/due.js [state.json]
import { readFileSync } from 'node:fs';
import { due, quiet } from '../src/schedule.js';

let state = { levels: [] };
try { state = JSON.parse(readFileSync(process.argv[2] ?? 'state/state.json', 'utf8')); } catch { /* no state yet: run */ }
const now = Math.floor(Date.now() / 1000), run = due(state, now);
console.log(run ? `due${quiet(state, now) ? ' (quiet hours: hourly check)' : ''}` : 'skip: quiet hours, this hour is already checked');
process.exit(run ? 0 : 1);
