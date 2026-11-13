import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './validation.cases.mjs';

for (const c of run()) {
  test(`검증 사례 [${c.cat}] ${c.cond}`, () => {
    assert.equal(c.overall, c.expect, `기상 기준 판정 ${c.overall} (기대 ${c.expect})`);
    if (c.expectOps) assert.equal(c.ops, c.expectOps, `주의 ${c.ops} (기대 ${c.expectOps})`);
  });
}
