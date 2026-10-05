(function () {
  'use strict';
  const channel = new BroadcastChannel('voice-of-player');
  const status = document.getElementById('status');
  const summary = document.getElementById('summary');
  const clusters = document.getElementById('clusters');
  const evidence = document.getElementById('evidence');
  const sourceBadge = document.getElementById('source-badge');
  const publicAppId = document.getElementById('public-app-id');
  const pending = new Map();
  let sequence = 0;
  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
  function request(method, params) {
    const reqId = 'panel-' + (++sequence);
    return new Promise((resolve, reject) => { pending.set(reqId, { resolve, reject }); channel.postMessage({ type: 'panel-request', reqId, method, params: params || {} }); });
  }
  channel.addEventListener('message', (event) => {
    const message = event.data || {};
    if (message.type !== 'panel-result') return;
    const entry = pending.get(message.reqId);
    if (!entry) return;
    pending.delete(message.reqId);
    if (message.ok) entry.resolve(message.result); else entry.reject(new Error(message.message || '分析失败。'));
  });
  function renderResult(result) {
    const data = result.summary || {};
    summary.hidden = false;
    summary.innerHTML = '<div class="stat"><span class="stat-value">' + data.review_count + '</span><span class="stat-label">原始评论</span></div>' +
      '<div class="stat"><span class="stat-value">' + data.valid_feedback_count + '</span><span class="stat-label">玩家反馈</span></div>' +
      '<div class="stat"><span class="stat-value">' + data.cluster_count + '</span><span class="stat-label">反馈主题</span></div>';
    clusters.innerHTML = result.clusters.map((cluster) => '<article class="cluster"><button type="button" data-reference="' + escapeHtml(cluster.cluster_id) + '"><h3>' + escapeHtml(cluster.topic) + '</h3><div class="cluster-meta">' + cluster.feedback_count + ' 条反馈 · ' + cluster.review_count + ' 条评论 · ' + escapeHtml(cluster.feedback_type) + '</div></button></article>').join('');
    clusters.querySelectorAll('[data-reference]').forEach((button) => button.addEventListener('click', () => showEvidence(button.dataset.reference)));
  }
  function renderPublicResult(result) {
    const reviews = result.reviews || [];
    summary.hidden = false;
    summary.innerHTML = '<div class="stat"><span class="stat-value">' + reviews.length + '</span><span class="stat-label">已采集评论</span></div>' +
      '<div class="stat"><span class="stat-value">' + (result.pagination && result.pagination.total != null ? result.pagination.total : '—') + '</span><span class="stat-label">页面总数</span></div>' +
      '<div class="stat"><span class="stat-value">JSON</span><span class="stat-label">已保存到插件数据</span></div>';
    sourceBadge.textContent = '公开数据';
    clusters.innerHTML = reviews.map((review) => '<article class="cluster"><button type="button" data-public-review="' + escapeHtml(review.review_id) + '"><h3>' + escapeHtml(review.raw_text.slice(0, 70)) + (review.raw_text.length > 70 ? '…' : '') + '</h3><div class="cluster-meta">' + escapeHtml(review.author || '匿名玩家') + ' · ' + escapeHtml(String(review.rating || '—')) + ' 星 · ' + escapeHtml(review.device || '设备未知') + '</div></button></article>').join('') || '<p class="empty">没有采集到公开评论。</p>';
    clusters.querySelectorAll('[data-public-review]').forEach((button) => button.addEventListener('click', () => {
      const review = reviews.find((item) => item.review_id === button.dataset.publicReview);
      if (!review) return;
      evidence.innerHTML = '<p class="evidence-label">原评论 · ' + escapeHtml(review.review_id) + '</p><p class="quote">' + escapeHtml(review.raw_text) + '</p><p class="muted">来源：' + escapeHtml(review.source_url) + '</p>';
    }));
  }
  async function showEvidence(reference) {
    evidence.innerHTML = '<p class="muted">正在读取证据…</p>';
    try {
      const result = await request('get_feedback_evidence', { reference });
      const reviewList = result.review ? [result.review] : (result.reviews || []);
      const item = result.feedback_item;
      evidence.innerHTML = (item ? '<p class="evidence-label">证据片段</p><p class="quote">' + escapeHtml(item.evidence) + '</p>' : '') + reviewList.map((review) => '<p class="evidence-label">原评论 · ' + escapeHtml(review.review_id) + '</p><p class="quote">' + escapeHtml(review.raw_text) + '</p>').join('');
    } catch (error) { evidence.innerHTML = '<p class="status">' + escapeHtml(error.message) + '</p>'; }
  }
  async function run() {
    status.textContent = '正在分析本地合成评论…';
    try { const result = await request('analyze_player_feedback', { window: '7d' }); renderResult(result); status.textContent = '分析完成。结果明确标记为合成数据。'; }
    catch (error) { status.textContent = error.message; }
  }
  async function collectPublic() {
    const appId = publicAppId.value.trim() || '236627';
    status.textContent = '正在读取 TapTap 公开评价…';
    try {
      const result = await request('collect_public_reviews', { app_id: appId, max_pages: 1 });
      renderPublicResult(result);
      status.textContent = '已采集并保存公开评价 JSON。';
    } catch (error) { status.textContent = error.message; }
  }
  document.getElementById('run').addEventListener('click', run);
  document.getElementById('collect-public').addEventListener('click', collectPublic);
})();
