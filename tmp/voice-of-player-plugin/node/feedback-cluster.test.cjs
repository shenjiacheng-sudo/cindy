const assert = require('node:assert/strict');
const test = require('node:test');
const { clusterFeedbackItems, getClusterReviews } = require('./feedback-cluster.cjs');

test('clusters comparable items and preserves review provenance', () => {
  const items = [
    { feedback_id: 'a', review_id: 'r1', is_valid: true, sentiment: 'negative', feedback_type: 'problem', topic: 'Boss 卡顿', target: 'Boss 战', severity: 'high' },
    { feedback_id: 'b', review_id: 'r2', is_valid: true, sentiment: 'negative', feedback_type: 'problem', topic: 'Boss 卡顿', target: 'Boss 战', severity: 'medium' },
    { feedback_id: 'c', review_id: 'r3', is_valid: true, sentiment: 'positive', feedback_type: 'praise', topic: 'Boss 卡顿', target: 'Boss 战', severity: 'low' },
  ];
  const clusters = clusterFeedbackItems(items, { sourceType: 'synthetic' });
  assert.equal(clusters.length, 2);
  const problem = clusters.find((cluster) => cluster.feedback_type === 'problem');
  assert.equal(problem.feedback_count, 2);
  assert.deepEqual(problem.review_ids, ['r1', 'r2']);
  assert.equal(problem.source_type, 'synthetic');
});

test('looks up source reviews from a cluster', () => {
  const cluster = { review_ids: ['r2'] };
  assert.deepEqual(getClusterReviews(cluster, [{ review_id: 'r1' }, { review_id: 'r2' }]), [{ review_id: 'r2' }]);
});
