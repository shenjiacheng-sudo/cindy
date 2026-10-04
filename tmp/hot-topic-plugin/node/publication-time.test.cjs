'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { normalizePublishedAt, cutoffForRange, TIME_RANGES } = require('./publication-time.cjs');
const { normalizeVideo, rankHotTopics } = require('./worker.cjs');
const panel = require('../panel.js');
const now = Date.parse('2026-10-02T12:00:00Z');
const config = { niche: '校园剧情', audience: '学生', includeKeywords: ['校园', '同桌'], topN: 50 };
const video = (id, publishedAt, extra = {}) => ({ id, platform: 'douyin', title: '校园同桌反转', likes: 10000, publishedAt, ...extra });

test('publication dates accept seconds, milliseconds, numeric strings and ISO offsets', () => {
  for (const value of [now, now / 1000, String(now), String(now / 1000), '2026-10-02T20:00:00+08:00', '2026-10-02 12:00:00']) {
    assert.equal(normalizePublishedAt(value), '2026-10-02T12:00:00.000Z');
  }
  assert.equal(normalizePublishedAt('2026-10-02'), '2026-10-02T00:00:00.000Z');
  for (const value of [null, undefined, '', 'yesterday', '2026-02-30', '2026-13-01', '2026-01-01T25:00:00Z', NaN, Infinity, -1, 0, {}]) {
    assert.equal(normalizePublishedAt(value), null, String(value));
  }
  assert.equal(normalizeVideo({ publish_time: now / 1000 }, 0).publishedAt, '2026-10-02T12:00:00.000Z');
  assert.equal(normalizeVideo({ publishedAt: 'bad', create_time: now }, 0).publishedAt, '2026-10-02T12:00:00.000Z');
});

test('all six ranges include the cutoff and now, but reject earlier, future and missing dates', () => {
  const dates = { '7d': '2026-09-25', '1m': '2026-09-02', '3m': '2026-07-02', '6m': '2026-04-02', '1y': '2025-10-02', '3y': '2023-10-02' };
  for (const [timeRange, date] of Object.entries(dates)) {
    const cutoff = Date.parse(date + 'T12:00:00Z');
    assert.equal(cutoffForRange(timeRange, now), cutoff);
    const result = rankHotTopics({ ...config, timeRange, videos: [
      video('boundary', cutoff), video('now', now), video('old', cutoff - 1), video('future', now + 1), video('missing', null), video('invalid', 'bad'),
    ] }, now);
    assert.deepEqual(result.items.map(x => x.id), ['boundary', 'now']);
    assert.equal(result.outsideTimeRangeCount, 2);
    assert.equal(result.missingPublishTimeCount, 2);
    assert.equal(result.filteredCount, 4);
  }
  const unrestricted = rankHotTopics({ ...config, timeRange: 'all', videos: [video('undated', null), video('old', '2020-01-01')] }, now);
  assert.equal(unrestricted.total, 2);
  assert.equal(unrestricted.timeCutoff, null);
  const defaulted = rankHotTopics({ ...config, videos: [video('old', '2020-01-01')] }, now);
  assert.equal(defaulted.timeRange, '1m');
  assert.equal(defaulted.total, 0);
});

test('calendar month and year subtraction clamps month ends and leap days', () => {
  assert.equal(new Date(cutoffForRange('1m', Date.parse('2026-03-31T12:34:56Z'))).toISOString(), '2026-02-28T12:34:56.000Z');
  assert.equal(new Date(cutoffForRange('1y', Date.parse('2024-02-29T12:34:56Z'))).toISOString(), '2023-02-28T12:34:56.000Z');
});

test('deduplication precedes scoring and topN, respects platform and does not merge anonymous records', () => {
  const input = [video('same', now), video('same', now, { likes: 99999999 }), video('other', now), video('same', now, { platform: 'kuaishou' }), video(undefined, now), video(undefined, now)];
  const result = rankHotTopics({ ...config, videos: input }, now);
  assert.equal(result.candidateCount, 6);
  assert.equal(result.uniqueCount, 5);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.total, 5);
  assert.equal(result.items.filter(x => x.id === 'same').length, 2);
  assert.ok(result.items.every(x => x.likes === 10000));
  const baseline = rankHotTopics({ ...config, videos: [input[0], ...input.slice(2)] }, now);
  assert.deepEqual(result.items, baseline.items.map((x, i) => ({ ...x, id: i >= 3 ? 'row-' + (i + 2) : x.id })));
  const aliased = rankHotTopics({ ...config, videos: [
    { aweme_id: '123', title: '校园同桌', liked_count: 10000, create_time: now / 1000 },
    { id: '123', platform: 'dy', title: '校园同桌', likes: 10000, publishedAt: now },
  ] }, now);
  assert.equal(aliased.total, 1);
  assert.equal(aliased.duplicateCount, 1);
});

test('profile migration and main normalization retain range per profile without overwriting other fields', async () => {
  const stored = { crawlerRoot: '/picked/crawler', activeProfileId: 'a', profiles: [
    { id: 'a', niche: '校园剧情', timeRange: '7d' }, { id: 'b', niche: '职场', timeRange: '3y' }, { id: 'c', niche: '美食' },
  ] };
  const state = panel.normalizeProfileState(stored);
  assert.deepEqual(state.profiles.map(x => x.timeRange), ['7d', '3y', '1m']);
  assert.equal(state.crawlerRoot, stored.crawlerRoot);
  const context = { module: { exports: {} }, cindy: { onHostMessage() {} }, fetch: async () => ({ ok: false }), console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), context);
  for (const timeRange of TIME_RANGES) {
    assert.equal(context.module.exports.cleanProfile({ timeRange }, true).timeRange, timeRange);
  }
  assert.equal(Object.hasOwn(context.module.exports.cleanProfile({ niche: '校园' }, true), 'timeRange'), false);
  assert.equal(context.module.exports.normalizeProfileState(stored).profiles[1].timeRange, '3y');
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  for (const value of TIME_RANGES) assert.ok(html.includes('value="' + value + '"'));
});
