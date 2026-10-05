const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const reviews = JSON.parse(fs.readFileSync(path.join(root, 'data/reviews.fixture.json'), 'utf8'));
const expected = JSON.parse(fs.readFileSync(path.join(root, 'data/expected-feedback.fixture.json'), 'utf8'));

test('fixture is explicitly synthetic and review ids are unique', () => {
  assert.equal(reviews.sourceType, 'synthetic');
  const ids = reviews.reviews.map((review) => review.review_id);
  assert.equal(new Set(ids).size, ids.length);
});

test('expected evidence is contained by raw review text', () => {
  const textById = new Map(reviews.reviews.map((review) => [review.review_id, review.raw_text]));
  for (const item of expected.items) assert.ok(textById.get(item.review_id).includes(item.evidence));
});

test('unavailable source fields stay null', () => {
  const review = reviews.reviews[0];
  assert.equal(review.game_version, null);
  assert.equal(review.likes, null);
  assert.equal(review.device, null);
});
