const assert = require('node:assert/strict');
const test = require('node:test');
const { buildReviewApiUrl, normalizePublicReviewPages } = require('./public-review-collector.cjs');

test('normalizes public TapTap review response without inventing unavailable fields', () => {
  const result = normalizePublicReviewPages([{
    data: {
      total: 42,
      next_page: '/webapiv2/review/v2/list-by-app?app_id=236627&from=1',
      list: [{
        app: { id: 236627, title: '伊瑟' },
        moment: {
          id_str: 'moment-1',
          created_time: 1790261938,
          edited_time: 1790261938,
          device: 'PC 客户端',
          author: { user: { name: '玩家甲' } },
          review: { id: 50506099, score: 5, contents: { text: '游戏很好玩，战斗很有策略。' } },
          app: { id: 236627, title: '伊瑟' },
          stat: { ups: 13 },
        },
      }],
    },
  }], { appId: '236627' });
  assert.equal(result.source_type, 'public');
  assert.equal(result.game.name, '伊瑟');
  assert.equal(result.reviews.length, 1);
  assert.equal(result.reviews[0].review_id, '50506099');
  assert.equal(result.reviews[0].raw_text, '游戏很好玩，战斗很有策略。');
  assert.equal(result.reviews[0].rating, 5);
  assert.equal(result.reviews[0].likes, 13);
  assert.equal(result.reviews[0].game_version, null);
  assert.equal(result.pagination.total, 42);
  assert.match(result.reviews[0].source_url, /\/review\/50506099$/);
});

test('builds the public list endpoint and preserves next-page URLs', () => {
  assert.match(buildReviewApiUrl('236627'), /app_id=236627/);
  assert.match(buildReviewApiUrl('236627', '/webapiv2/review/v2/list-by-app?from=10'), /from=10/);
});
