'use strict';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && value.trim() && !Number.isNaN(new Date(value).getTime())) return new Date(value).toISOString();
  throw new Error('INVALID_REVIEW_' + field.toUpperCase());
}

function normalizeReview(raw, context) {
  if (!isRecord(raw)) throw new Error('INVALID_REVIEW');
  const text = raw.contents !== undefined ? raw.contents : raw.raw_text;
  const created = raw.created_time !== undefined ? raw.created_time : raw.created_at;
  const updated = raw.updated_time !== undefined ? raw.updated_time : raw.updated_at === undefined ? created : raw.updated_at;
  if (!raw.review_id || typeof text !== 'string' || !text.trim() || created === undefined) throw new Error('INVALID_REVIEW_REQUIRED_FIELD');
  const review = {
    review_id: raw.review_id,
    game_id: raw.game_id === undefined ? (context && context.game_id) || null : raw.game_id,
    raw_text: text.trim(),
    created_at: created,
    updated_at: updated,
    created_at_iso: timestamp(created, 'created_at'),
    updated_at_iso: timestamp(updated, 'updated_at'),
    rating: raw.score === undefined ? raw.rating : raw.score,
    game_version: raw.game_version === undefined ? null : raw.game_version,
    likes: raw.likes === undefined ? null : raw.likes,
    device: raw.device === undefined ? null : raw.device,
    source: raw.source || (context && context.source) || 'Unknown',
    source_url: raw.url === undefined ? (raw.source_url || null) : raw.url,
    images: Array.isArray(raw.images) ? raw.images.slice() : [],
    author: raw.author === undefined ? null : raw.author,
    comments: Array.isArray(raw.comments) ? raw.comments.slice() : [],
    comment_total: raw.comment_total === undefined ? 0 : raw.comment_total,
    has_official_comment: raw.has_official_comment === true,
  };
  if (!Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5) throw new Error('INVALID_REVIEW_RATING');
  return review;
}

function normalizeReviews(rawReviews, context) {
  if (!Array.isArray(rawReviews)) throw new Error('INVALID_REVIEWS');
  return rawReviews.map((raw) => normalizeReview(raw, context));
}

module.exports = { normalizeReview, normalizeReviews };
