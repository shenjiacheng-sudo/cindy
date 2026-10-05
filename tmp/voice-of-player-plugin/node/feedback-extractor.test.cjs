const assert = require('node:assert/strict');
const test = require('node:test');
const { extractFeedbackItems } = require('./feedback-extractor.cjs');

const review = { review_id: 'review-001', raw_text: '新版本美术挺好的，但是打 Boss 特别卡，而且活动奖励也太抠了。' };
const classifier = () => [
  { review_id: 'review-001', is_valid: true, sentiment: 'positive', category: null, topic: '美术', target: '美术表现', feedback_type: 'praise', severity: 'low', evidence: '新版本美术挺好的', confidence: 0.98 },
  { review_id: 'review-001', is_valid: true, sentiment: 'negative', category: 'Bug / 功能异常', topic: 'Boss 战卡顿', target: 'Boss 战', feedback_type: 'problem', severity: 'high', evidence: '打 Boss 特别卡', confidence: 0.97 },
  { review_id: 'review-001', is_valid: true, sentiment: 'negative', category: null, topic: '活动奖励不足', target: '活动奖励', feedback_type: 'problem', severity: 'medium', evidence: '活动奖励也太抠了', confidence: 0.96 },
];

test('splits one review into three traceable items', () => {
  const items = extractFeedbackItems(review, classifier);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((item) => item.review_id), ['review-001', 'review-001', 'review-001']);
});

test('rejects evidence absent from the raw review', () => {
  assert.throws(() => extractFeedbackItems(review, () => [{ ...classifier()[0], evidence: '模型编造的证据' }]), /INVALID_FEEDBACK_EVIDENCE/);
});
