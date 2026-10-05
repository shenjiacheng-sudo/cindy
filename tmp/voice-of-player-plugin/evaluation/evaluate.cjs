'use strict';

const assert = require('node:assert/strict');
const { runFixtureAnalysis, readJson } = require('../node/pipeline.cjs');

function evaluate() {
  const result = runFixtureAnalysis();
  const expected = readJson('data/expected-feedback.fixture.json');
  const expectedClusters = readJson('data/expected-clusters.fixture.json');
  const actualById = new Map(result.feedback_items.map((item) => [item.feedback_id, item]));
  let evidenceCorrect = 0;
  for (const item of expected.items) {
    const actual = actualById.get(item.feedback_id);
    if (actual && actual.evidence === item.evidence) evidenceCorrect += 1;
  }
  const actualClusterIds = new Set(result.clusters.map((cluster) => cluster.cluster_id));
  const clusterRecall = expectedClusters.clusters.filter((cluster) => actualClusterIds.has(cluster.cluster_id)).length / expectedClusters.clusters.length;
  const metrics = {
    review_count: result.summary.review_count,
    expected_feedback_count: expected.items.length,
    actual_feedback_count: result.feedback_items.length,
    item_count_exact_match: result.feedback_items.length === expected.items.length,
    evidence_accuracy: evidenceCorrect / expected.items.length,
    cluster_recall: clusterRecall,
    traceability_complete: result.feedback_items.every((item) => result.reviews.some((review) => review.review_id === item.review_id)),
  };
  assert.equal(metrics.item_count_exact_match, true);
  assert.equal(metrics.evidence_accuracy, 1);
  assert.equal(metrics.traceability_complete, true);
  return metrics;
}

if (require.main === module) process.stdout.write(JSON.stringify(evaluate(), null, 2) + '\n');

module.exports = { evaluate };
