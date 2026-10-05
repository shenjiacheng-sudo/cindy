'use strict';

const CHANNEL_NAME = 'voice-of-player';
const TOOL_METHODS = new Set(['load_player_feedback_fixture', 'analyze_player_feedback', 'get_feedback_evidence', 'collect_public_reviews']);
const PANEL_METHODS = new Set(['load_player_feedback_fixture', 'analyze_player_feedback', 'get_feedback_evidence', 'collect_public_reviews']);
const PUBLIC_REVIEW_HOST = 'www.taptap.cn';
const PUBLIC_REVIEW_DATA_PATH = 'public-reviews/236627.json';
let channel = null;
const completed = new Map();
const inFlight = new Map();

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function cleanId(value) { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,96}$/.test(value) ? value : ''; }
function cleanAppId(value) { return typeof value === 'string' && /^[0-9]{1,32}$/.test(value) ? value : '236627'; }
function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function makeAnonymousUid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'voice-of-player-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}
function publicReviewUrl(appId, nextPage, pageSize) {
  if (nextPage) return new URL(nextPage, 'https://' + PUBLIC_REVIEW_HOST).toString();
  const url = new URL('https://' + PUBLIC_REVIEW_HOST + '/webapiv2/review/v2/list-by-app');
  url.searchParams.set('app_id', appId);
  url.searchParams.set('limit', String(pageSize));
  url.searchParams.set('sort', 'hot');
  return url.toString();
}

async function collectPublicReviews(args, options) {
  const appId = cleanAppId(args && args.app_id);
  const pageSize = clampInteger(args && args.page_size, 10, 1, 20);
  const maxPages = clampInteger(args && args.max_pages, 1, 1, 10);
  const uid = makeAnonymousUid();
  const pages = [];
  let nextPage = null;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await cindy.fetch({
      url: publicReviewUrl(appId, nextPage, pageSize),
      headers: {
        Accept: 'application/json',
        'X-UA': 'V=1&PN=Web&LANG=zh_CN&VN_CODE=100000000&LOC=CN&PLT=PC&DS=Android&UID=' + uid,
      },
      timeoutMs: 30000,
      ...(options && options.callId ? { callId: options.callId } : {}),
    });
    if (!response || response.ok !== true) throw Object.assign(new Error(response && response.message ? response.message : 'TapTap 公开评论请求失败。'), { code: response && response.errorCode ? response.errorCode : 'PUBLIC_FETCH_FAILED' });
    if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('TapTap 公开评论返回 HTTP ' + response.status + '。'), { code: 'PUBLIC_FETCH_HTTP_' + response.status });
    let payload;
    try { payload = JSON.parse(response.body); } catch { throw Object.assign(new Error('TapTap 公开评论返回的不是 JSON。'), { code: 'PUBLIC_RESPONSE_INVALID' }); }
    pages.push(payload);
    nextPage = payload && payload.data && payload.data.next_page ? payload.data.next_page : null;
    if (!nextPage || !payload.data || !Array.isArray(payload.data.list) || payload.data.list.length === 0) break;
  }
  const result = await callWorker('normalize_public_reviews', { appId, pages }, options);
  const saved = await cindy.fs({ op: 'write', root: 'data', path: PUBLIC_REVIEW_DATA_PATH, content: JSON.stringify(result, null, 2) });
  if (!saved || saved.ok !== true) throw Object.assign(new Error(saved && saved.message ? saved.message : '公开评论 JSON 保存失败。'), { code: saved && saved.errorCode ? saved.errorCode : 'PUBLIC_SAVE_FAILED' });
  return { ...result, saved_path: saved.path || PUBLIC_REVIEW_DATA_PATH };
}

async function executeMethod(method, args, options) {
  if (method === 'collect_public_reviews') return collectPublicReviews(args || {}, options || {});
  return callWorker(method, args || {}, options || {});
}

async function callWorker(method, params, options) {
  const response = await cindy.node.request({
    method,
    params: params || {},
    ...(options && options.callId ? { callId: options.callId, cancelWithCall: true } : {}),
    timeoutMs: (options && options.timeoutMs) || 30000,
  });
  if (!response || response.ok !== true) throw Object.assign(new Error(response && response.message ? response.message : '本地分析进程没有返回结果。'), { code: response && response.errorCode ? response.errorCode : 'NODE_REQUEST_FAILED' });
  return response.result;
}

function publishResult(reqId, payload) {
  const message = { type: 'panel-result', reqId, ...payload };
  completed.set(reqId, message);
  while (completed.size > 32) completed.delete(completed.keys().next().value);
  if (channel) channel.postMessage(message);
}

async function handlePanelRequest(message) {
  if (!isRecord(message) || message.type !== 'panel-request') return;
  const reqId = cleanId(message.reqId);
  if (!reqId) return;
  if (completed.has(reqId)) { channel.postMessage(completed.get(reqId)); return; }
  if (!PANEL_METHODS.has(message.method)) { publishResult(reqId, { ok: false, errorCode: 'METHOD_NOT_ALLOWED', message: '面板不允许执行此操作。' }); return; }
  let work = inFlight.get(reqId);
  if (!work) {
    work = executeMethod(message.method, isRecord(message.params) ? message.params : {}, { timeoutMs: 30000 });
    inFlight.set(reqId, work);
  }
  try { publishResult(reqId, { ok: true, result: await work }); }
  catch (error) { publishResult(reqId, { ok: false, errorCode: error.code || 'ANALYSIS_FAILED', message: error.message || '玩家反馈分析失败。' }); }
  finally { inFlight.delete(reqId); }
}

if (typeof BroadcastChannel === 'function') {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener('message', (event) => { void handlePanelRequest(event.data); });
}

cindy.onHostMessage(async (message) => {
  if (!message || message.type !== 'tool-call' || !TOOL_METHODS.has(message.tool)) return;
  try {
    const result = await executeMethod(message.tool, isRecord(message.args) ? message.args : {}, { callId: cleanId(message.callId), timeoutMs: 30000 });
    if (channel) channel.postMessage({ type: 'agent-result', result });
    await cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result });
  } catch (error) {
    await cindy.send({ type: 'tool-result', callId: message.callId, ok: false, errorCode: error.code || 'ANALYSIS_FAILED', message: error.message || '玩家反馈分析失败。' });
  }
});

module.exports = typeof module === 'object' ? { callWorker } : undefined;
