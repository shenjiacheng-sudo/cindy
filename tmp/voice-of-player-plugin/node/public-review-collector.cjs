'use strict';

const DEFAULT_APP_ID = '236627';
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 20;
const MAX_PAGES = 10;

function asString(value) {
  return value == null ? '' : String(value);
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function cleanText(value) {
  return asString(value).replace(/\s+/g, ' ').trim();
}

function buildReviewApiUrl(appId, nextPage) {
  if (nextPage) {
    return new URL(nextPage, 'https://www.taptap.cn').toString();
  }
  const url = new URL('https://www.taptap.cn/webapiv2/review/v2/list-by-app');
  url.searchParams.set('app_id', appId);
  url.searchParams.set('limit', String(DEFAULT_PAGE_SIZE));
  url.searchParams.set('sort', 'hot');
  return url.toString();
}

function extractReview(item, appId) {
  const moment = item && item.moment ? item.moment : item;
  const review = moment && moment.review ? moment.review : item && item.review ? item.review : null;
  if (!review || review.id == null) return null;
  const app = item && item.app ? item.app : (moment && moment.app ? moment.app : {});
  const author = moment && moment.author && moment.author.user ? moment.author.user : {};
  const contents = review.contents || {};
  const reviewId = String(review.id);
  const text = cleanText(contents.text || contents.raw_text);
  if (!text) return null;
  return {
    review_id: reviewId,
    game_id: String(app.id || appId),
    raw_text: text,
    created_at: unixSecondsToIso(moment.created_time),
    updated_at: unixSecondsToIso(moment.edited_time || moment.publish_time || moment.created_time),
    rating: Number.isFinite(Number(review.score)) ? Number(review.score) : null,
    game_version: null,
    likes: (item && item.stat && Number.isFinite(Number(item.stat.ups))) ? Number(item.stat.ups) :
      (moment && moment.stat && Number.isFinite(Number(moment.stat.ups)) ? Number(moment.stat.ups) : null),
    device: moment.device || null,
    source: 'TapTap Public Review',
    source_url: 'https://www.taptap.cn/review/' + reviewId,
    images: Array.isArray(review.images) ? review.images : [],
    author: author.name || null,
    comments: [],
    comment_total: null,
    has_official_comment: null,
  };
}

function normalizePublicReviewPages(pages, options = {}) {
  const appId = String(options.appId || DEFAULT_APP_ID);
  const pageList = Array.isArray(pages) ? pages : [];
  const reviews = [];
  const seen = new Set();
  let total = null;
  let nextPage = null;
  let gameName = options.gameName || null;
  for (const page of pageList) {
    const data = page && page.data ? page.data : page;
    if (!data || !Array.isArray(data.list)) continue;
    if (!gameName) {
      const firstItem = data.list[0];
      const firstApp = firstItem && (firstItem.app || (firstItem.moment && firstItem.moment.app));
      gameName = firstApp && firstApp.title ? String(firstApp.title) : null;
    }
    if (Number.isFinite(Number(data.total)) && Number(data.total) > 0) total = Number(data.total);
    nextPage = data.next_page || null;
    for (const item of data.list) {
      const review = extractReview(item, appId);
      if (!review || seen.has(review.review_id)) continue;
      seen.add(review.review_id);
      reviews.push(review);
    }
  }
  return {
    source_type: 'public',
    game: { game_id: appId, name: gameName },
    source_url: 'https://www.taptap.cn/app/' + appId + '/review',
    collected_at: new Date().toISOString(),
    query: { app_id: appId, sort: 'hot', page_size: DEFAULT_PAGE_SIZE, max_pages: pageList.length },
    reviews,
    pagination: { total, fetched_count: reviews.length, next_page: nextPage },
  };
}

function clampPageSize(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, number));
}

function clampPageLimit(value) {
  const number = Number(value);
  if (!Number.isInteger(number)) return 1;
  return Math.max(1, Math.min(MAX_PAGES, number));
}

module.exports = {
  DEFAULT_APP_ID,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_PAGES,
  buildReviewApiUrl,
  clampPageSize,
  clampPageLimit,
  normalizePublicReviewPages,
};
