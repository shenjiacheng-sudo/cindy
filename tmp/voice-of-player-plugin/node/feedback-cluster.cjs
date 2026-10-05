'use strict';

function keyPart(value) {
  return String(value || '').trim().toLocaleLowerCase().replace(new RegExp(String.fromCharCode(92) + 's+', 'g'), '');
}

function clusterKey(item) {
  return [item.feedback_type, item.topic, item.target].map(keyPart).join('|');
}

function clusterFeedbackItems(items, options) {
  if (!Array.isArray(items)) throw new Error('INVALID_FEEDBACK_ITEMS');
  const sourceType = (options && options.sourceType) || 'synthetic';
  const groups = new Map();
  for (const item of items) {
    if (!item || item.is_valid !== true) continue;
    const key = clusterKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].map(([key, group]) => {
    const feedbackIds = group.map((item) => item.feedback_id);
    const reviewIds = [...new Set(group.map((item) => item.review_id))];
    const sentimentBreakdown = {};
    const severityBreakdown = {};
    for (const item of group) {
      sentimentBreakdown[item.sentiment] = (sentimentBreakdown[item.sentiment] || 0) + 1;
      severityBreakdown[item.severity] = (severityBreakdown[item.severity] || 0) + 1;
    }
    return {
      cluster_id: 'cluster:' + key,
      topic: group[0].topic || group[0].target || '未命名反馈主题',
      target: group[0].target || null,
      feedback_type: group[0].feedback_type,
      feedback_count: group.length,
      review_count: reviewIds.length,
      feedback_ids: feedbackIds,
      review_ids: reviewIds,
      representative_items: group.slice(0, 3),
      sentiment_breakdown: sentimentBreakdown,
      severity_breakdown: severityBreakdown,
      source_type: sourceType,
    };
  }).sort((a, b) => b.feedback_count - a.feedback_count || a.cluster_id.localeCompare(b.cluster_id));
}

function getClusterReviews(cluster, reviews) {
  const ids = new Set(cluster.review_ids || []);
  return (reviews || []).filter((review) => ids.has(review.review_id));
}

module.exports = { clusterFeedbackItems, getClusterReviews, clusterKey };
