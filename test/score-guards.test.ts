// The held-out set can only be scored deliberately. These runs stop before any lead is
// read or any model is called.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/score.ts', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 });

describe('scoring guards', () => {
  test('the held-out split needs --final', () => {
    const out = run('--split', 'test');
    assert.equal(out.status, 2);
    assert.match(out.stderr, /needs --final/);
  });

  test('a rules-only look at the held-out split is refused', () => {
    const out = run('--split', 'test', '--final', '--rules-only');
    assert.equal(out.status, 2);
    assert.match(out.stderr, /still be a look/);
  });

  test('an unknown split is refused', () => {
    assert.equal(run('--split', 'nope').status, 2);
    assert.equal(run().status, 2);
  });
});
