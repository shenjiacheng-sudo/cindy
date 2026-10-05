'use strict';

const SENTIMENTS = new Set(['positive', 'negative', 'neutral', 'mixed']);
const TYPES = new Set(['problem', 'suggestion', 'praise', 'question']);
const SEVERITIES = new Set(['high', 'medium', 'low']);

function validateFeedbackItem(item, review) {
  if (!item || typeof item !== 'object') throw new Error('INVALID_FEEDBACK_ITEM');
  if (!item.feedback_id || item.review_id !== review.review_id) throw new Error('INVALID_FEEDBACK_REFERENCE');
  if (typeof item.is_valid !== 'boolean') throw new Error('INVALID_FEEDBACK_VALIDITY');
  if (!SENTIMENTS.has(item.sentiment) || !TYPES.has(item.feedback_type) || !SEVERITIES.has(item.severity)) throw new Error('INVALID_FEEDBACK_ENUM');
  if (typeof item.evidence !== 'string' || !item.evidence || !review.raw_text.includes(item.evidence)) throw new Error('INVALID_FEEDBACK_EVIDENCE');
  if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error('INVALID_FEEDBACK_CONFIDENCE');
  if (item.category !== null && item.category !== undefined && typeof item.category !== 'string') throw new Error('INVALID_FEEDBACK_CATEGORY');
  return item;
}

function extractFeedbackItems(review, classifier) {
  if (!review || typeof review.raw_text !== 'string') throw new Error('INVALID_REVIEW_FOR_EXTRACTION');
  if (typeof classifier !== 'function') throw new Error('CLASSIFIER_REQUIRED');
  const items = classifier(review);
  if (!Array.isArray(items)) throw new Error('INVALID_CLASSIFIER_RESULT');
  return items.map((item, index) => validateFeedbackItem(Object.assign({ feedback_id: review.review_id + ':feedback-' + (index + 1) }, item), review));
}

module.exports = { extractFeedbackItems, validateFeedbackItem };
