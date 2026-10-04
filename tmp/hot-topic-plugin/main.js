/* Cindy Ghost v3 browser logic. The panel talks to this page via BroadcastChannel. */
const CHANNEL_NAME = 'hot-topic-plugin';
const TOOL_METHODS = new Set(['rank_hot_topics', 'load_hot_topic_fixture']);
const PANEL_METHODS = new Set(['rank_hot_topics', 'load_hot_topic_fixture', 'pick_media_crawler']);
const SUPPORTED_PLATFORMS = new Set(['douyin', 'kuaishou']);
const DEFAULT_WEIGHTS = { engagement: 0.4, audienceMatch: 0.35, keywordRelevance: 0.25 };
const TIME_RANGES = ['7d', '1m', '3m', '6m', '1y', '3y', 'all'];
const inFlightPanelCalls = new Map();
const completedPanelCalls = new Map();
const cancelledPanelCalls = new Set();
let savedState = normalizeProfileState({});
let channel = null;
let profileRevision = 0;
let initialProfileLoad = Promise.resolve();

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function cleanKeywordList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, 80))
    .filter(Boolean))].slice(0, 50);
}

function cleanWeights(value) {
  if (!isRecord(value)) return undefined;
  const result = {};
  for (const key of ['engagement', 'audienceMatch', 'keywordRelevance']) {
    const parsed = Number(value[key]);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) result[key] = parsed;
  }
  return Object.keys(result).length ? result : undefined;
}

function cleanProfile(value, partial = false, fallbackId = 'profile-default') {
  if (!isRecord(value)) return partial ? {} : { id: fallbackId, name: '我的创作档案', accountName: '', platforms: ['douyin', 'kuaishou'], niche: '', audience: '', contentStyle: '', includeKeywords: [], excludeKeywords: [], minKeywordHits: 1, minLikes: 10000, minFollowers: 0, topN: 5, timeRange: '1m', rankingWeights: DEFAULT_WEIGHTS };
  const profile = {};
  if (!partial || hasOwn(value, 'id')) profile.id = /^[A-Za-z0-9_-]{1,64}$/.test(boundedString(value.id, 64)) ? value.id : fallbackId;
  if (!partial || hasOwn(value, 'name')) profile.name = boundedString(value.name, 60) || '我的创作档案';
  if (!partial || hasOwn(value, 'accountName')) profile.accountName = boundedString(value.accountName, 80);
  if (!partial || hasOwn(value, 'platforms')) {
    profile.platforms = Array.isArray(value.platforms)
      ? [...new Set(value.platforms.filter((platform) => SUPPORTED_PLATFORMS.has(platform)))].slice(0, 2)
      : ['douyin', 'kuaishou'];
  }
  for (const [key, maxLength] of [['niche', 120], ['audience', 600], ['contentStyle', 240]]) {
    if (!partial || hasOwn(value, key)) profile[key] = boundedString(value[key], maxLength);
  }
  for (const key of ['includeKeywords', 'excludeKeywords']) {
    if (!partial || hasOwn(value, key)) profile[key] = cleanKeywordList(value[key]);
  }
  if (!partial || hasOwn(value, 'minKeywordHits')) {
    const minimum = Number(value.minKeywordHits);
    profile.minKeywordHits = Number.isInteger(minimum) && minimum >= 1 && minimum <= 3 ? minimum : 1;
  }
  for (const key of ['minLikes', 'minFollowers']) {
    if (!partial || hasOwn(value, key)) {
      const minimum = Number(value[key]);
      profile[key] = Number.isInteger(minimum) && minimum >= 0 && minimum <= 1000000000 ? minimum : (key === 'minLikes' ? 10000 : 0);
    }
  }
  if (!partial || hasOwn(value, 'topN')) {
    const topN = Number(value.topN);
    profile.topN = Number.isInteger(topN) && topN >= 1 && topN <= 50 ? topN : 5;
  }
  if (!partial || hasOwn(value, 'rankingWeights')) {
    profile.rankingWeights = cleanWeights(value.rankingWeights) || { ...DEFAULT_WEIGHTS };
  }
  if (!partial || hasOwn(value, 'timeRange')) {
    profile.timeRange = TIME_RANGES.includes(value.timeRange) ? value.timeRange : '1m';
  }
  return profile;
}

function normalizeProfileState(value) {
  const stored = isRecord(value) ? value : {};
  const legacy = !Array.isArray(stored.profiles) && (
    typeof stored.niche === 'string' || typeof stored.audience === 'string' || typeof stored.contentStyle === 'string'
  );
  const rawProfiles = Array.isArray(stored.profiles)
    ? stored.profiles.slice(0, 10)
    : (legacy ? [{ ...stored, id: 'legacy-profile', name: '我的创作档案' }] : []);
  const usedIds = new Set();
  const profiles = rawProfiles.map((raw, index) => {
    const profile = cleanProfile(raw, false, `profile-${index + 1}`);
    if (usedIds.has(profile.id)) {
      let suffix = 1;
      let candidate = `profile-${index + 1}-${suffix}`;
      while (usedIds.has(candidate)) candidate = `profile-${index + 1}-${++suffix}`;
      profile.id = candidate;
    }
    usedIds.add(profile.id);
    return profile;
  });
  if (profiles.length === 0) profiles.push(cleanProfile({}, false, 'profile-default'));
  const activeProfileId = profiles.some((profile) => profile.id === stored.activeProfileId)
    ? stored.activeProfileId
    : profiles[0].id;
  const crawlerRoot = typeof stored.crawlerRoot === 'string' && stored.crawlerRoot.trim()
    ? stored.crawlerRoot.trim().slice(0, 2048)
    : null;
  return { schemaVersion: 2, activeProfileId, crawlerRoot, profiles };
}

function getActiveProfile() {
  return savedState.profiles.find((profile) => profile.id === savedState.activeProfileId) || savedState.profiles[0];
}

function cleanVideos(value) {
  if (!Array.isArray(value)) return undefined;
  if (value.length > 100) throw Object.assign(new Error('单次最多分析 100 条视频。'), { code: 'TOO_MANY_VIDEOS' });
  const keys = [
    'id', 'aweme_id', 'video_id', 'photo_id', 'platform', 'title', 'desc', 'text', 'caption',
    'author', 'nickname', 'authorName', 'author_name', 'authorUrl', 'author_url',
    'videoUrl', 'aweme_url', 'video_url', 'likes', 'liked_count', 'collects', 'collected_count',
    'comments', 'comment_count', 'followers', 'follower_count', 'fans_count', 'author_follower_count', 'user_fans', 'publishedAt', 'publish_time', 'create_time',
  ];
  const result = value.map((item) => {
    if (!isRecord(item)) return {};
    const clean = {};
    for (const key of keys) {
      if (!hasOwn(item, key)) continue;
      const entry = item[key];
      if (typeof entry === 'string') clean[key] = entry.slice(0, ['text', 'desc'].includes(key) ? 6000 : 2048);
      else if (typeof entry === 'number' && Number.isFinite(entry)) clean[key] = entry;
    }
    return clean;
  });
  const serialized = JSON.stringify(result);
  const byteLength = typeof TextEncoder === 'function'
    ? new TextEncoder().encode(serialized).byteLength
    : serialized.length * 3;
  if (byteLength > 180 * 1024) throw Object.assign(new Error('视频数据超过本机工具的安全大小限制。'), { code: 'VIDEOS_TOO_LARGE' });
  return result;
}

function profileWithOverrides(overrides) {
  const profile = { ...getActiveProfile(), ...cleanProfile(overrides, true) };
  if (isRecord(overrides) && hasOwn(overrides, 'videos')) profile.videos = cleanVideos(overrides.videos);
  if (isRecord(overrides) && hasOwn(overrides, 'platform')) profile.platform = boundedString(overrides.platform, 24).toLowerCase();
  return profile;
}

function sendPanelResult(reqId, payload) {
  if (!channel || !reqId) return;
  const message = { type: 'panel-result', reqId, ...payload };
  channel.postMessage(message);
  completedPanelCalls.delete(reqId);
  completedPanelCalls.set(reqId, message);
  while (completedPanelCalls.size > 48) completedPanelCalls.delete(completedPanelCalls.keys().next().value);
}

function sendPanelProgress(reqId, message) {
  if (channel && reqId) channel.postMessage({ type: 'collector-progress', reqId, message });
}

async function writeSavedState() {
  const response = await fetch('/kv', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(savedState),
  });
  if (!response.ok) throw Object.assign(new Error('本机采集环境暂时无法保存。'), { code: 'STATE_SAVE_FAILED' });
}

async function refreshSavedState() {
  const revision = profileRevision;
  try {
    const response = await fetch('/kv');
    if (!response.ok) return;
    const next = normalizeProfileState(await response.json());
    if (revision === profileRevision) savedState = next;
  } catch {
    // A picker or Agent request still works with the in-memory plugin state.
  }
}

async function callWorker(method, params, options = {}) {
  const response = await cindy.node.request({
    method,
    params: params || {},
    ...(options.callId ? { callId: options.callId, cancelWithCall: true } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxTotalMs ? { maxTotalMs: options.maxTotalMs } : {}),
  });
  if (!response || response.ok !== true) {
    const error = new Error(response && response.message ? response.message : '本地分析进程没有返回结果。');
    error.code = response && response.errorCode ? response.errorCode : 'NODE_REQUEST_FAILED';
    throw error;
  }
  return response.result;
}

function selectedPlatform(profile, requested) {
  const value = boundedString(requested, 24).toLowerCase();
  if (value && !SUPPORTED_PLATFORMS.has(value)) throw Object.assign(new Error('本机试用版仅支持抖音或快手。'), { code: 'UNSUPPORTED_PLATFORM' });
  const platform = value || profile.platforms[0];
  if (!platform || !profile.platforms.includes(platform)) {
    throw Object.assign(new Error('请先在当前博主档案中勾选本次要采集的平台。'), { code: 'PLATFORM_NOT_SELECTED' });
  }
  return platform;
}

function collectionParams(overrides, requestId) {
  const params = profileWithOverrides(overrides);
  const hasVideos = Array.isArray(params.videos) && params.videos.length > 0;
  if (hasVideos) return params;
  if (!params.niche || !params.audience) {
    throw Object.assign(new Error('请先在插件面板填写当前博主档案的赛道与目标粉丝。'), { code: 'PROFILE_INCOMPLETE' });
  }
  const minKeywordHits = Number.isInteger(Number(params.minKeywordHits))
    ? Math.max(1, Math.min(3, Number(params.minKeywordHits)))
    : 1;
  if (new Set(params.includeKeywords.map((word) => word.normalize("NFKC").toLowerCase())).size < minKeywordHits) {
    throw Object.assign(new Error("请至少填写 " + minKeywordHits + " 个不同关键词；入选视频必须命中其中 " + minKeywordHits + " 个。"), { code: "KEYWORDS_REQUIRED" });
  }
  params.minKeywordHits = minKeywordHits;
  const platform = selectedPlatform(params, params.platform);
  if (!savedState.crawlerRoot) {
    throw Object.assign(new Error('请先在插件面板选择本机已有的 MediaCrawler 项目目录。'), { code: 'COLLECTOR_NOT_CONFIGURED' });
  }
  return {
    ...params,
    platform,
    collect: true,
    crawlerRoot: savedState.crawlerRoot,
    requestId,
  };
}

function friendlyPickerError(picked) {
  const code = picked && (picked.errorCode || picked.code);
  if (code === 'CANCELLED') return Object.assign(new Error('你取消了目录选择。需要试用时可在面板中重新选择。'), { code });
  if (code === 'BUSY') return Object.assign(new Error('当前已有一个系统目录选择窗口，请稍后重试。'), { code });
  if (code === 'RATE_LIMITED') return Object.assign(new Error('目录选择操作过于频繁，请稍后再试。'), { code });
  return Object.assign(new Error('目录选择没有完成；请在系统窗口中亲自选择 MediaCrawler 项目目录。'), { code: code || 'PICK_FAILED' });
}

async function pickMediaCrawlerDirectory() {
  const picked = await cindy.pick({ mode: 'directory', title: '选择已有的 MediaCrawler 项目目录' });
  if (!picked || picked.ok !== true || typeof picked.path !== 'string' || !picked.path.trim()) throw friendlyPickerError(picked);
  savedState = normalizeProfileState({ ...savedState, crawlerRoot: picked.path });
  await writeSavedState();
  profileRevision += 1;
  if (channel) channel.postMessage({ type: 'profile-updated', state: savedState });
  return { state: savedState, directoryName: boundedString(picked.name, 120) || 'MediaCrawler' };
}

async function handlePanelCancel(message) {
  const reqId = typeof message.reqId === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(message.reqId)
    ? message.reqId
    : '';
  if (!reqId || !inFlightPanelCalls.has(reqId)) return;
  cancelledPanelCalls.add(reqId);
  sendPanelProgress(reqId, '正在停止本次采集并清理临时文件…');
  try { await callWorker('cancel_collection', { requestId: reqId }, { timeoutMs: 10000 }); } catch { /* The active Worker request also aborts on Host shutdown. */ }
}

async function handlePanelRequest(message) {
  if (!isRecord(message) || message.type !== 'panel-request') return;
  const reqId = typeof message.reqId === 'string' && /^[a-zA-Z0-9._:-]{1,96}$/.test(message.reqId)
    ? message.reqId
    : '';
  if (!reqId) return;
  const completed = completedPanelCalls.get(reqId);
  if (completed) {
    channel.postMessage(completed);
    return;
  }
  if (!PANEL_METHODS.has(message.method)) {
    sendPanelResult(reqId, { ok: false, errorCode: 'METHOD_NOT_ALLOWED', message: '面板不允许执行此操作。' });
    return;
  }
  let work = inFlightPanelCalls.get(reqId);
  if (!work) {
    work = (async () => {
      await initialProfileLoad;
      if (message.method === 'pick_media_crawler') return pickMediaCrawlerDirectory();
      if (message.method === 'load_hot_topic_fixture') return callWorker(message.method, {});
      if (cancelledPanelCalls.has(reqId)) throw Object.assign(new Error('本次采集已取消。'), { code: 'COLLECTOR_CANCELLED' });
      const params = collectionParams(message.params, reqId);
      const startedAt = Date.now();
      sendPanelProgress(reqId, '已进入后台搜索；正在检查登录状态和采集环境…');
      const heartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        const message = elapsed < 90
          ? '后台搜索已运行 ' + elapsed + ' 秒；正在补充候选并筛选合格视频…'
          : '后台搜索已运行 ' + elapsed + ' 秒；平台响应较慢，仍在等待结果（登录等待最多 90 秒）…';
        sendPanelProgress(reqId, message);
      }, 5000);
      try {
        return await callWorker('rank_hot_topics', params, { timeoutMs: 60000, maxTotalMs: 900000 });
      } finally {
        clearInterval(heartbeat);
      }
    })();
    inFlightPanelCalls.set(reqId, work);
  }
  try {
    const result = await work;
    sendPanelResult(reqId, { ok: true, result });
  } catch (error) {
    sendPanelResult(reqId, {
      ok: false,
      errorCode: error && error.code ? String(error.code) : 'ANALYSIS_FAILED',
      message: error instanceof Error ? error.message : '本次热点分析失败。',
    });
  } finally {
    inFlightPanelCalls.delete(reqId);
    cancelledPanelCalls.delete(reqId);
  }
}

if (typeof BroadcastChannel === 'function') {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener('message', (event) => {
    const message = event.data;
    if (!isRecord(message)) return;
    if (message.type === 'profile-updated' && isRecord(message.state)) {
      profileRevision += 1;
      savedState = normalizeProfileState(message.state);
      return;
    }
    if (message.type === 'panel-cancel') {
      void handlePanelCancel(message);
      return;
    }
    if (message.type === 'panel-request') void handlePanelRequest(message);
  });
}

initialProfileLoad = refreshSavedState();

cindy.onHostMessage(async (message) => {
  if (!message || message.type !== 'tool-call' || !TOOL_METHODS.has(message.tool)) return;

  try {
    if (message.tool === 'rank_hot_topics') await refreshSavedState();
    const result = message.tool === 'rank_hot_topics'
      ? await callWorker(message.tool, collectionParams(message.args, boundedString(message.callId, 160)), {
        callId: boundedString(message.callId, 160),
        timeoutMs: 60000,
        maxTotalMs: 900000,
      })
      : await callWorker(message.tool, isRecord(message.args) ? message.args : {}, {
        callId: boundedString(message.callId, 160),
        timeoutMs: 30000,
      });

    if (message.tool === 'rank_hot_topics' && channel) channel.postMessage({ type: 'agent-result', result });
    await cindy.send({ type: 'tool-result', callId: message.callId, ok: true, result });
  } catch (error) {
    await cindy.send({
      type: 'tool-result',
      callId: message.callId,
      ok: false,
      errorCode: error && error.code ? String(error.code) : 'ANALYSIS_FAILED',
      message: error instanceof Error ? error.message : '热点分析失败，请重试。',
    });
  }
});

module.exports = typeof module === 'object' ? {
  normalizeProfileState,
  cleanProfile,
  collectionParams,
  selectedPlatform,
} : undefined;
