import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, freshState } from '../src/state.js';

const dir = mkdtempSync(join(tmpdir(), 'nowick-'));

test('state round-trips', () => {
  const p = join(dir, 'a', 'state.json');
  const s = freshState();
  s.levels.push({ id: 'x', status: 'active' });
  saveState(p, s);
  assert.deepEqual(loadState(p).state, s);
});

test('missing file and corrupt file start fresh without throwing', () => {
  assert.equal(loadState(join(dir, 'nope.json')).reason, 'no state file');
  const p = join(dir, 'bad.json');
  writeFileSync(p, '{not json');
  const r = loadState(p);
  assert.equal(r.fresh, true);
  assert.deepEqual(r.state, freshState());
});
