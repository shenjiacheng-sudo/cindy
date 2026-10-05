const assert = require('node:assert/strict');
const test = require('node:test');
const { handle } = require('./worker.cjs');

test('worker returns a synthetic analysis result', () => {
  const result = handle({ jsonrpc: '2.0', id: 1, method: 'analyze_player_feedback', params: { window: '7d' } });
  assert.equal(result.source_type, 'synthetic');
  assert.equal(result.summary.review_count, 5);
  assert.equal(result.summary.valid_feedback_count, 8);
});

test('worker returns traceable evidence', () => {
  const result = handle({ jsonrpc: '2.0', id: 2, method: 'get_feedback_evidence', params: { reference: 'feedback-002' } });
  assert.equal(result.kind, 'feedback_item');
  assert.equal(result.feedback_item.evidence, '打 Boss 特别卡');
  assert.equal(result.review.review_id, 'review-001');
});

test('worker rejects unknown methods', () => {
  const result = handle({ jsonrpc: '2.0', id: 3, method: 'unknown' });
  assert.equal(result.__error.message, 'METHOD_NOT_FOUND');
});
