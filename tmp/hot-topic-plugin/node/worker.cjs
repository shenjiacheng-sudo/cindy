'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const collector = require('./crawler-adapter.cjs');
const { normalizePublishedAt, normalizeTimeRange, cutoffForRange } = require('./publication-time.cjs');

const FIXTURE_PATH = path.join(__dirname, '..', 'data', 'douyin-snapshot.json');
const MAX_VIDEOS = 5000;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const ACTIVE_COLLECTIONS = new Map();
const DEFAULT_WEIGHTS = Object.freeze({ engagement: 0.4, audienceMatch: 0.35, keywordRelevance: 0.25 });
const STOP_WORDS = new Set([
  '以及', '因为', '所以', '这个', '那个', '这些', '那些', '关注', '需要', '希望', '喜欢', '面向', '针对',
  '关心', '用户', '粉丝', '观众', '内容', '视频', '他们', '我们', '你们', '自己', '可以', '进行', '相关',
  '如何', '什么', '怎么', '比较', '尤其', '主要', '以及', '以及', '希望', '正在', '年龄', '地区', '职业',
  '岁', '人群', '拥有', '对于', '目前', '普通', '一个', '一些', '没有', '并且', '同时', '或者', '还有',
]);

class WorkerError extends Error {
  constructor(code, message, rpcCode) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.rpcCode = rpcCode || -32602;
  }
}

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function pickString(raw, keys, maxLength) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return boundedText(value, maxLength);
  }
  return '';
}

function pickIdentifier(raw, keys, maxLength) {
  for (const key of keys) {
    const value = raw[key];
    if ((typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isSafeInteger(value))) {
      return String(value).trim().slice(0, maxLength);
    }
  }
  return '';
}

function normalizePlatform(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'douyin' || key === 'dy') return 'douyin';
  if (key === 'kuaishou' || key === 'ks' || key === 'kwai') return 'kuaishou';
  if (key === 'xhs' || key === 'xiaohongshu') return 'xhs';
  return null;
}

function platformForHost(host) {
  const domains = {
    douyin: ['douyin.com', 'iesdouyin.com'],
    kuaishou: ['kuaishou.com', 'kwai.com'],
    xhs: ['xiaohongshu.com', 'xhslink.com'],
  };
  for (const [platform, allowedDomains] of Object.entries(domains)) {
    if (allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return platform;
  }
  return null;
}

function safeDisplayVideoUrl(value, platform) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const hostPlatform = platformForHost(url.hostname.toLowerCase());
    const expectedPlatform = normalizePlatform(platform);
    if (!hostPlatform || (expectedPlatform && hostPlatform !== expectedPlatform)) return null;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function inferPlatform(raw) {
  const declared = normalizePlatform(pickString(raw, ['platform'], 40));
  if (declared) return declared;
  if (raw.aweme_id !== undefined || raw.aweme_url) return 'douyin';
  if (raw.video_id !== undefined || raw.video_url) return 'kuaishou';

  const videoUrl = pickString(raw, ['videoUrl', 'aweme_url', 'video_url'], 2000);
  try {
    return platformForHost(new URL(videoUrl).hostname.toLowerCase());
  } catch {
    // Missing or invalid links do not establish the source platform.
  }
  return null;
}

function parseMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== 'string') return null;

  const text = value.trim().replace(/,/g, '');
  if (!text) return null;
  const compact = text.match(/^(\d+(?:\.\d+)?)\s*(万|亿)$/u);
  if (compact) {
    const multiplier = compact[2] === '亿' ? 100000000 : 10000;
    const parsed = Number(compact[1]) * multiplier;
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
}

function normalizeVideo(raw, index, platformHint) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WorkerError('INVALID_VIDEO', `第 ${index + 1} 条视频记录必须是对象。`);
  }
  const hintedPlatform = normalizePlatform(platformHint);
  const title = pickString(raw, ['title', 'desc', 'caption'], 500);
  const text = pickString(raw, ['text', 'desc', 'title', 'caption'], 6000);
  const id = pickIdentifier(raw, ['id', 'aweme_id', 'video_id', 'photo_id', 'videoId', 'photoId'], 160) || `row-${index + 1}`;
  const platform = inferPlatform(raw) || hintedPlatform;
  const publishedAt = ['publishedAt', 'publish_time', 'create_time', 'timestamp']
    .map((key) => normalizePublishedAt(raw[key])).find(Boolean) || null;
  const rawVideoUrl = pickString(raw, ['videoUrl', 'aweme_url', 'video_url'], 2000);

  return {
    id,
    platform,
    title,
    text,
    author: pickString(raw, ['author', 'nickname', 'authorName', 'author_name'], 160) || null,
    authorUrl: safeDisplayVideoUrl(pickString(raw, ['authorUrl', 'author_url'], 2000), platform),
    videoUrl: safeDisplayVideoUrl(rawVideoUrl, platform),
    likes: parseMetric(raw.likes === undefined ? raw.liked_count : raw.likes),
    collects: parseMetric(raw.collects === undefined ? raw.collected_count : raw.collects),
    comments: parseMetric(raw.comments === undefined ? raw.comment_count : raw.comments),
    publishedAt,
  };
}

function loadFixture() {
  let parsed;
  try {
    const stat = fs.statSync(FIXTURE_PATH);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      throw new WorkerError('FIXTURE_INVALID', '随包示例数据文件不是有效的小型数据文件。', -32603);
    }
    parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('FIXTURE_READ_FAILED', '无法读取随包示例数据。', -32603);
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_VIDEOS) {
    throw new WorkerError('FIXTURE_INVALID', '随包示例数据必须是有限的视频数组。', -32603);
  }
  return parsed.map(normalizeVideo);
}

function tokenize(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  let segments = [];
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
    segments = Array.from(segmenter.segment(text), (item) => item.segment);
  } else {
    segments = text.split(/[^\p{L}\p{N}]+/u);
  }
  const words = new Set();
  for (const segment of segments) {
    const word = segment.replace(/^[#@]+/u, '').trim();
    if (!word || STOP_WORDS.has(word) || /^\d+(?:[-.]\d+)?$/u.test(word)) continue;
    const length = Array.from(word).length;
    if (length < 2) continue;
    words.add(word);
  }
  return [...words];
}

function cleanKeywords(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, 80).toLowerCase())
    .filter(Boolean))].slice(0, 50);
}

function positiveMetric(value) {
  return value === null || value === undefined ? 0 : Math.max(0, value);
}

function maxLog(values) {
  let max = 1;
  for (const value of values) max = Math.max(max, Math.log10(positiveMetric(value) + 1));
  return max;
}

function cleanWeights(value) {
  const weights = { ...DEFAULT_WEIGHTS };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(DEFAULT_WEIGHTS)) {
      const candidate = Number(value[key]);
      if (Number.isFinite(candidate) && candidate >= 0) weights[key] = Math.min(1, candidate);
    }
  }
  let total = weights.engagement + weights.audienceMatch + weights.keywordRelevance;
  if (!(total > 0)) {
    Object.assign(weights, DEFAULT_WEIGHTS);
    total = 1;
  }
  for (const key of Object.keys(weights)) weights[key] /= total;
  return weights;
}

function scoreVideo(video, config, maxima, includeKeywords, excludeKeywords, audienceTokens, weights) {
  const searchable = `${video.title} ${video.text} ${video.author || ''}`.normalize('NFKC').toLowerCase();
  const excludedBy = excludeKeywords.find((keyword) => searchable.includes(keyword)) || null;
  const keywordHits = includeKeywords.filter((keyword) => searchable.includes(keyword)).length;
  const audienceHits = audienceTokens.filter((term) => searchable.includes(term)).length;
  const keywordRelevance = includeKeywords.length ? keywordHits / includeKeywords.length : 0.5;
  const audienceMatch = audienceTokens.length
    ? Math.min(1, audienceHits / Math.min(6, audienceTokens.length))
    : 0.5;
  const likes = positiveMetric(video.likes);
  const collects = positiveMetric(video.collects);
  const engagement = (Math.log10(likes + 1) / maxima.likes) * 0.6
    + (Math.log10(collects + 1) / maxima.collects) * 0.4;
  const score = excludedBy
    ? 0
    : (engagement * weights.engagement
      + audienceMatch * weights.audienceMatch
      + keywordRelevance * weights.keywordRelevance) * 100;

  return {
    ...video,
    score: Math.round(score),
    scoreBreakdown: {
      engagement: Math.round(engagement * 100),
      audienceMatch: Math.round(audienceMatch * 100),
      keywordRelevance: Math.round(keywordRelevance * 100),
    },
    excludedBy,
  };
}

function makeIdeas(video, config) {
  const title = video.title || '这个主题';
  const niche = boundedText(config.niche, 120) || '你的赛道';
  const audience = boundedText(config.audience, 600) || '目标粉丝';
  const style = boundedText(config.contentStyle, 240) || '真实案例与清晰拆解';
  const shortTitle = Array.from(title).slice(0, 32).join('');
  return {
    hook: `可以尝试把“${shortTitle}”改成面向${audience}的具体问题或结果开场，再用一个真实细节建立情境。`,
    format: `建议测试“${style}”的表达方式：调整原内容的叙事顺序、场景或演示步骤，而不是照搬镜头。`,
    angle: `结合${niche}加入自己的经历、专业判断或可复用清单，让观点来自你的实际经验。`,
  };
}

// Eligibility is independent of ranking weights: popularity cannot buy relevance.
function qualifyVideo(video, config) {
  const text = `${video.title} ${video.text}`.normalize("NFKC").toLowerCase();
  const keywords = [...new Set(cleanKeywords(config.includeKeywords).map((word) => word.normalize("NFKC")))];
  const keywordHits = keywords.filter((word) => text.includes(word));
  const niche = boundedText(config.niche, 120).normalize("NFKC").toLowerCase();
  const generic = new Set(["剧情", "搞笑", "内容", "分享", "视频", "日常", "故事", "创作", "账号", "成长"]);
  const nicheTerms = tokenize(niche).filter((word) => !generic.has(word));
  const campusTerms = ["校园", "学校", "教室", "课堂", "同桌", "班主任", "班级", "上课", "下课", "大学", "高中", "初中", "小学", "校服", "宿舍", "学长", "学姐"];
  const campus = niche.includes("校园");
  const nicheHits = (campus ? campusTerms : nicheTerms).filter((word) => text.includes(word));
  const nicheMatch = campus ? nicheHits.length > 0 : nicheTerms.length > 0 && nicheHits.length === nicheTerms.length;
  const reasons = [];
  if (video.likes === null || video.likes < 10000) reasons.push("likes");
  if (!nicheMatch) reasons.push("niche");
  if (keywordHits.length < 2) reasons.push("keywords");
  return { passed: reasons.length === 0, reasons, keywordHits, nicheHits, method: "title-description-text" };
}

function rankHotTopics(params, now = Date.now()) {
  const config = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  if (config.videos !== undefined && !Array.isArray(config.videos)) {
    throw new WorkerError('INVALID_VIDEOS', 'videos 必须是数组。');
  }
  const localSource = config.source === 'local-mediacrawler-search';
  const callerVideos = Array.isArray(config.videos) && config.videos.length > 0;
  const useProvidedVideos = callerVideos || localSource;
  const sourceVideos = useProvidedVideos ? config.videos : loadFixture();
  if (sourceVideos.length > MAX_VIDEOS) {
    throw new WorkerError('TOO_MANY_VIDEOS', `单次最多分析 ${MAX_VIDEOS} 条视频。`);
  }
  // Only real IDs establish identity. Anonymous records must not collide with row-N IDs.
  const seen = new Set();
  const uniqueVideos = [];
  for (const [index, raw] of sourceVideos.entries()) {
    const video = normalizeVideo(raw, index, config.platform);
    const id = pickIdentifier(raw, ['id', 'aweme_id', 'video_id', 'photo_id', 'videoId', 'photoId'], 160);
    const key = id ? JSON.stringify([video.platform, id]) : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    uniqueVideos.push(video);
  }
  const timeRange = normalizeTimeRange(config.timeRange);
  const cutoff = cutoffForRange(timeRange, now);
  let missingPublishTimeCount = 0;
  let outsideTimeRangeCount = 0;
  const videos = uniqueVideos.filter((video) => {
    if (cutoff === null) return true;
    if (!video.publishedAt) { missingPublishTimeCount++; return false; }
    const published = Date.parse(video.publishedAt);
    if (published < cutoff || published > now) { outsideTimeRangeCount++; return false; }
    return true;
  });
  const includeKeywords = cleanKeywords(config.includeKeywords);
  const excludeKeywords = cleanKeywords(config.excludeKeywords);
  const audienceTokens = tokenize(`${config.niche || ''} ${config.audience || ''}`);
  const weights = cleanWeights(config.rankingWeights);
  const maxima = {
    likes: maxLog(videos.map((video) => video.likes)),
    collects: maxLog(videos.map((video) => video.collects)),
  };
  const scored = videos.map((video) => scoreVideo(video, config, maxima, includeKeywords, excludeKeywords, audienceTokens, weights));
  const excludedCount = scored.filter((video) => video.excludedBy).length;
  const topNValue = Number(config.topN);
  const topN = Number.isInteger(topNValue) ? Math.max(1, Math.min(50, topNValue)) : 10;
  const qualified = scored.map((video) => ({ ...video, qualification: qualifyVideo(video, config) }));
  const filteredByReason = { likes: 0, niche: 0, keywords: 0 };
  for (const video of qualified) {
    for (const reason of video.qualification.reasons) filteredByReason[reason] += 1;
  }
  const items = qualified
    .filter((video) => !video.excludedBy && video.qualification.passed)
    .map((video) => ({ ...video, ideas: makeIdeas(video, config) }))
    .sort((a, b) => b.score - a.score
      || positiveMetric(b.collects) - positiveMetric(a.collects)
      || positiveMetric(b.likes) - positiveMetric(a.likes))
    .slice(0, topN);

  const sourceLabel = localSource
    ? `本机${config.platform === 'kuaishou' ? '快手' : '抖音'}关键词搜索（非全站热榜）`
    : (callerVideos ? '调用方传入数据' : '随包静态示例（非实时）');
  const result = {
    source: localSource ? 'local-mediacrawler-search' : (callerVideos ? 'caller' : 'bundled-demo'),
    sourceLabel,
    candidateCount: sourceVideos.length,
    uniqueCount: uniqueVideos.length,
    duplicateCount: sourceVideos.length - uniqueVideos.length,
    timeRange,
    timeCutoff: cutoff === null ? null : new Date(cutoff).toISOString(),
    evaluatedAt: new Date(now).toISOString(),
    missingPublishTimeCount,
    outsideTimeRangeCount,
    excludedCount,
    filteredCount: missingPublishTimeCount + outsideTimeRangeCount
      + qualified.filter((video) => video.excludedBy || !video.qualification.passed).length,
    filteredByReason,
    eligibility: { minLikes: 10000, minKeywordHits: 2, requireNicheMatch: true, method: "title-description-text" },
    total: items.length,
    requestedCount: topN,
    shortfall: Math.max(0, topN - items.length),
    rankingWeights: weights,
    items,
  };
  if (config.platform) result.platform = config.platform;
  if (localSource && typeof config.fetchedAt === 'string') result.fetchedAt = config.fetchedAt;
  if (localSource && Array.isArray(config.queryKeywords)) result.queryKeywords = config.queryKeywords.slice(0, 3);
  return result;
}

function loadHotTopicFixture() {
  const items = loadFixture();
  return {
    source: 'bundled-demo',
    sourceLabel: '随包静态示例（非实时）',
    total: items.length,
    items,
  };
}

async function handleRequestAsync(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new WorkerError('INVALID_REQUEST', '请求必须是对象。', -32600);
  }
  if (request.method === 'cancel_collection') {
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    const requestId = boundedText(params.requestId, 160);
    const active = ACTIVE_COLLECTIONS.get(requestId);
    if (active) active.controller.abort();
    return { cancelled: Boolean(active) };
  }
  if (request.method === 'rank_hot_topics') {
    const params = request.params && typeof request.params === 'object' ? request.params : {};
    if (params.collect !== true) return rankHotTopics(params);
    const platform = normalizePlatform(params.platform);
    if (platform !== 'douyin' && platform !== 'kuaishou') {
      throw new WorkerError('UNSUPPORTED_PLATFORM', '本机试用版仅支持抖音或快手。');
    }
    if (ACTIVE_COLLECTIONS.size > 0) throw new WorkerError('COLLECTOR_BUSY', '已有一次本机采集正在运行；请先等待完成或取消当前采集。');
    const requestId = boundedText(params.requestId, 160) || `collector-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (ACTIVE_COLLECTIONS.has(requestId)) throw new WorkerError('COLLECTOR_ALREADY_RUNNING', '这次采集已经在运行中。');
    const controller = new AbortController();
    const active = { controller, promise: null };
    ACTIVE_COLLECTIONS.set(requestId, active);
    const heartbeat = setInterval(() => {
      process.stderr.write('hot-topic: local collection is still running\n');
    }, 20000);
    try {
      const evaluatedAt = Date.now();
      const targetValue = Number(params.topN);
      const target = Number.isInteger(targetValue) ? Math.max(1, Math.min(50, targetValue)) : 10;
      const collected = await collector.collectMediaCrawler({
        crawlerRoot: params.crawlerRoot,
        profile: params,
        platform,
        maxItems: 500,
        shouldStop: (videos) => rankHotTopics({ ...params, videos, platform,
          source: 'local-mediacrawler-search', collect: false }, evaluatedAt).total >= target,
        signal: controller.signal,
        onProgress: () => {},
      });
      if (controller.signal.aborted) throw new WorkerError('COLLECTOR_CANCELLED', '本次采集已取消。');
      const result = rankHotTopics({
        ...params,
        videos: collected.videos,
        source: 'local-mediacrawler-search',
        platform: collected.platform,
        fetchedAt: collected.fetchedAt,
        queryKeywords: collected.queryKeywords,
        collect: false,
      }, evaluatedAt);
      result.collectionEndReason = result.shortfall === 0 ? 'target-reached' : (collected.endReason || 'search-ended');
      const reasons = {
        'search-ended': '本轮关键词搜索已结束',
        'candidate-limit': '已检查本轮最多 500 条候选',
        'time-limit': '已达到本轮 12 分钟时间上限',
        'collector-error': '平台请求或采集过程未正常完成',
      };
      result.completionMessage = result.shortfall
        ? '目标 ' + target + ' 条，找到 ' + result.total + ' 条合格视频，还差 ' + result.shortfall + ' 条；'
          + (reasons[result.collectionEndReason] || reasons['search-ended']) + '。未降低筛选要求或用不合格内容补足。'
        : '已找到 ' + target + ' 条符合筛选要求的视频。';
      return result;
    } catch (error) {
      if (error instanceof collector.CollectorError) {
        throw new WorkerError(error.code, error.message, -32000);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      ACTIVE_COLLECTIONS.delete(requestId);
    }
  }
  return handleRequest(request);
}

function handleRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new WorkerError('INVALID_REQUEST', '请求必须是对象。', -32600);
  }
  if (request.method === 'load_hot_topic_fixture') return loadHotTopicFixture();
  if (request.method === 'rank_hot_topics') return rankHotTopics(request.params || {});
  throw new WorkerError('METHOD_NOT_FOUND', `未知方法：${String(request.method || '未提供')}`, -32601);
}

function rpcError(id, error) {
  const workerError = error instanceof WorkerError
    ? error
    : new WorkerError('INTERNAL_ERROR', '分析进程发生未预期错误。', -32603);
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: workerError.rpcCode,
      errorCode: workerError.code,
      message: workerError.message,
    },
  };
}

function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return rpcError(null, new WorkerError('PARSE_ERROR', '请求不是有效 JSON。', -32700));
  }
  const id = request && (typeof request.id === 'string' || typeof request.id === 'number') ? request.id : null;
  try {
    return { jsonrpc: '2.0', id, result: handleRequest(request) };
  } catch (error) {
    return rpcError(id, error);
  }
}

function handleLineAsync(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return Promise.resolve(rpcError(null, new WorkerError('PARSE_ERROR', '请求不是有效 JSON。', -32700)));
  }
  const id = request && (typeof request.id === 'string' || typeof request.id === 'number') ? request.id : null;
  return Promise.resolve()
    .then(() => handleRequestAsync(request))
    .then((result) => ({ jsonrpc: '2.0', id, result }))
    .catch((error) => rpcError(id, error));
}

function runStdio() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (line.length > MAX_REQUEST_BYTES) {
      process.stdout.write(`${JSON.stringify(rpcError(null, new WorkerError('REQUEST_TOO_LARGE', '请求超过大小限制。', -32600)))}\n`);
      return;
    }
    void handleLineAsync(line).then((response) => {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
  const shutdown = () => {
    collector.abortAll();
    for (const active of ACTIVE_COLLECTIONS.values()) active.controller.abort();
    const deadline = setTimeout(() => process.exit(1), 12000);
    deadline.unref();
    const wait = setInterval(() => {
      if (ACTIVE_COLLECTIONS.size === 0) {
        clearInterval(wait);
        clearTimeout(deadline);
        process.exit(0);
      }
    }, 100);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

// Cindy's Node Runtime requires the declared entry from its wrapper, so the plugin
// module is not require.main there. The trusted wrapper marks this environment with
// __CINDY_NODE__; keep direct execution for local tests and diagnostics as well.
const isCindyNodeRuntime =
  typeof globalThis.__CINDY_NODE__ === 'object' && globalThis.__CINDY_NODE__ !== null;
if (require.main === module || isCindyNodeRuntime) runStdio();

module.exports = {
  DEFAULT_WEIGHTS,
  WorkerError,
  parseMetric,
  normalizeVideo,
  loadFixture,
  tokenize,
  cleanWeights,
  qualifyVideo,
  rankHotTopics,
  loadHotTopicFixture,
  handleRequest,
  handleRequestAsync,
  handleLine,
  handleLineAsync,
};
