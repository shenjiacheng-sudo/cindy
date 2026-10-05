const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeReview } = require('./review-normalizer.cjs');

test('normalizes TapTap-shaped data without inventing absent fields', () => {
  const review = normalizeReview({ review_id: 12, contents: '很卡', score: 2, created_time: 1790812800, updated_time: 1790812800, device: '', url: 'https://example.test/review/12' }, { game_id: 'game-1', source: 'TapTap Review' });
  assert.equal(review.review_id, 12);
  assert.equal(review.raw_text, '很卡');
  assert.equal(review.game_version, null);
  assert.equal(review.likes, null);
  assert.equal(review.source, 'TapTap Review');
  assert.match(review.created_at_iso, /^2026-/);
});

test('rejects missing text and invalid ratings', () => {
  assert.throws(() => normalizeReview({ review_id: 'x', contents: '', score: 2, created_time: 1 }));
  assert.throws(() => normalizeReview({ review_id: 'x', contents: 'x', score: 6, created_time: 1 }));
});
