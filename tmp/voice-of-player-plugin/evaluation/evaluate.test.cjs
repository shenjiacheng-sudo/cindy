const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluate } = require('./evaluate.cjs');

test('synthetic baseline satisfies hard data invariants', () => {
  const metrics = evaluate();
  assert.equal(metrics.item_count_exact_match, true);
  assert.equal(metrics.evidence_accuracy, 1);
  assert.equal(metrics.traceability_complete, true);
});
