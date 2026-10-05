'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeReviews } = require('./review-normalizer.cjs');
const { extractFeedbackItems } = require('./feedback-extractor.cjs');
const { clusterFeedbackItems, getClusterReviews } = require('./feedback-cluster.cjs');

const ROOT = path.join(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function fixtureClassifier() {
  const expected = readJson('data/expected-feedback.fixture.json');
  const byReview = new Map();
  for (const item of expected.items) {
    if (!byReview.has(item.review_id)) byReview.set(item.review_id, []);
    byReview.get(item.review_id).push(item);
  }
  return (review) => byReview.get(String(review.review_id)) || [];
}

function runFixtureAnalysis() {
  const fixture = readJson('data/reviews.fixture.json');
  const reviews = normalizeReviews(fixture.reviews, { source: fixture.sourceType, game_id: fixture.game.game_id });
  const classifier = fixtureClassifier();
  const feedbackItems = reviews.flatMap((review) => extractFeedbackItems(review, classifier));
  const clusters = clusterFeedbackItems(feedbackItems, { sourceType: fixture.sourceType });
  return {
    source_type: fixture.sourceType,
    game: fixture.game,
    query: fixture.query,
    reviews,
    feedback_items: feedbackItems,
    clusters,
    summary: {
      review_count: reviews.length,
      valid_feedback_count: feedbackItems.length,
      invalid_review_count: reviews.length - new Set(feedbackItems.map((item) => item.review_id)).size,
      cluster_count: clusters.length,
    },
  };
}

function findEvidence(result, reference) {
  const item = result.feedback_items.find((candidate) => candidate.feedback_id === reference);
  if (item) {
    return { kind: 'feedback_item', feedback_item: item, review: result.reviews.find((review) => review.review_id === item.review_id) || null };
  }
  const cluster = result.clusters.find((candidate) => candidate.cluster_id === reference);
  if (cluster) return { kind: 'cluster', cluster, reviews: getClusterReviews(cluster, result.reviews) };
  const review = result.reviews.find((candidate) => String(candidate.review_id) === String(reference));
  if (review) return { kind: 'review', review };
  throw new Error('REFERENCE_NOT_FOUND');
}

module.exports = { runFixtureAnalysis, findEvidence, readJson };
