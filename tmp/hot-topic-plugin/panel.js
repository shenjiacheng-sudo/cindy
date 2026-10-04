(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) api.mount(root.document, root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CHANNEL_NAME = 'hot-topic-plugin';
  const WAKE_URL = 'cindy-ghost://hot-topic-plugin/wake';
  const PROFILE_STATE_VERSION = 2;
  const SUPPORTED_PLATFORMS = ['douyin', 'kuaishou'];
  const TIME_RANGES = { '7d': '近一周', '1m': '近一个月', '3m': '近一个季度', '6m': '近半年', '1y': '近一年', '3y': '近三年', all: '不限时间' };
  const DEFAULT_WEIGHTS = { engagement: 0.4, audienceMatch: 0.35, keywordRelevance: 0.25 };
  const MAX_PROFILES = 10;
  const COLLECT_TIMEOUT_MS = 15 * 60 * 1000;

  function boundedText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);
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

  function safeExternalUrl(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || !platformForHost(url.hostname.toLowerCase())) return null;
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  function clampScore(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0;
  }

  function formatMetric(value) {
    if (value === null || value === undefined || value === '') return '不可用';
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return '不可用';
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(parsed);
  }

  function platformLabel(value) {
    const key = String(value || '').toLowerCase();
    if (key === 'douyin' || key === 'dy') return '抖音';
    if (key === 'kuaishou' || key === 'ks' || key === 'kwai') return '快手';
    if (key === 'xhs' || key === 'xiaohongshu') return '小红书';
    return value ? String(value) : '平台不可用';
  }

  function parseKeywordInput(value) {
    return [...new Set(String(value || '').split(/[,，、\n]+/).map((term) => term.trim()).filter(Boolean))].slice(0, 50);
  }

  function makeProfileId(root) {
    const source = root || (typeof globalThis !== 'undefined' ? globalThis : {});
    const id = source.crypto && typeof source.crypto.randomUUID === 'function'
      ? source.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `profile-${id}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  }

  function normalizeProfile(value, fallbackId, index) {
    const profile = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const id = typeof profile.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(profile.id)
      ? profile.id
      : (fallbackId || `profile-${index + 1}`);
    const platforms = Array.isArray(profile.platforms)
      ? [...new Set(profile.platforms.filter((item) => SUPPORTED_PLATFORMS.includes(item)))].slice(0, 2)
      : [...SUPPORTED_PLATFORMS];
    const topNValue = Number(profile.topN);
    const weights = profile.rankingWeights && typeof profile.rankingWeights === 'object'
      ? profile.rankingWeights
      : DEFAULT_WEIGHTS;
    const weight = (key) => {
      const candidate = Number(weights[key]);
      return Number.isFinite(candidate) && candidate >= 0 && candidate <= 1 ? candidate : DEFAULT_WEIGHTS[key];
    };
    return {
      id,
      name: boundedText(profile.name, 60) || '我的创作档案',
      accountName: boundedText(profile.accountName, 80),
      platforms,
      niche: boundedText(profile.niche, 120),
      audience: boundedText(profile.audience, 600),
      contentStyle: boundedText(profile.contentStyle, 240),
      includeKeywords: Array.isArray(profile.includeKeywords)
        ? [...new Set(profile.includeKeywords.filter((item) => typeof item === 'string').map((item) => item.trim().slice(0, 80)).filter(Boolean))].slice(0, 50)
        : [],
      minKeywordHits: Number.isInteger(Number(profile.minKeywordHits)) && Number(profile.minKeywordHits) >= 1 && Number(profile.minKeywordHits) <= 3 ? Number(profile.minKeywordHits) : 1,
      minLikes: Number.isInteger(Number(profile.minLikes)) && Number(profile.minLikes) >= 0 && Number(profile.minLikes) <= 1000000000 ? Number(profile.minLikes) : 10000,
      minFollowers: Number.isInteger(Number(profile.minFollowers)) && Number(profile.minFollowers) >= 0 && Number(profile.minFollowers) <= 1000000000 ? Number(profile.minFollowers) : 0,
      excludeKeywords: Array.isArray(profile.excludeKeywords)
        ? [...new Set(profile.excludeKeywords.filter((item) => typeof item === 'string').map((item) => item.trim().slice(0, 80)).filter(Boolean))].slice(0, 50)
        : [],
      timeRange: Object.prototype.hasOwnProperty.call(TIME_RANGES, profile.timeRange) ? profile.timeRange : '1m',
      topN: Number.isInteger(topNValue) && topNValue >= 1 && topNValue <= 50 ? topNValue : 5,
      rankingWeights: {
        engagement: weight('engagement'),
        audienceMatch: weight('audienceMatch'),
        keywordRelevance: weight('keywordRelevance'),
      },
    };
  }

  function createProfile(root, index) {
    return normalizeProfile({ name: `新建档案 ${Number(index || 0) + 1}` }, makeProfileId(root), index || 0);
  }

  function normalizeProfileState(value, root) {
    const stored = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const legacy = !Array.isArray(stored.profiles) && (
      typeof stored.niche === 'string' || typeof stored.audience === 'string' || typeof stored.contentStyle === 'string'
    );
    const rawProfiles = Array.isArray(stored.profiles)
      ? stored.profiles.slice(0, MAX_PROFILES)
      : (legacy ? [{ ...stored, id: 'legacy-profile', name: '我的创作档案' }] : []);
    const usedIds = new Set();
    const profiles = rawProfiles.map((profile, index) => {
      const normalized = normalizeProfile(profile, `profile-${index + 1}`, index);
      if (usedIds.has(normalized.id)) {
        let suffix = 1;
        let candidate = `profile-${index + 1}-${suffix}`;
        while (usedIds.has(candidate)) candidate = `profile-${index + 1}-${++suffix}`;
        normalized.id = candidate;
      }
      usedIds.add(normalized.id);
      return normalized;
    });
    if (profiles.length === 0) profiles.push(normalizeProfile({ name: '我的创作档案' }, 'profile-default', 0));
    const activeProfileId = profiles.some((profile) => profile.id === stored.activeProfileId)
      ? stored.activeProfileId
      : profiles[0].id;
    const crawlerRoot = typeof stored.crawlerRoot === 'string' && stored.crawlerRoot.trim()
      ? stored.crawlerRoot.trim().slice(0, 2048)
      : null;
    return { schemaVersion: PROFILE_STATE_VERSION, activeProfileId, crawlerRoot, profiles };
  }

  function activeProfile(state) {
    const normalized = normalizeProfileState(state);
    return normalized.profiles.find((profile) => profile.id === normalized.activeProfileId) || normalized.profiles[0];
  }

  function renderBreakdown(label, value) {
    const score = clampScore(value);
    return `<div class="breakdown-row"><span>${label}</span><span class="breakdown-track" aria-hidden="true"><span class="breakdown-fill" style="width:${score}%"></span></span><span class="breakdown-value">${score} 分</span></div>`;
  }

  function renderItem(item, index) {
    const row = item && typeof item === 'object' ? item : {};
    const title = typeof row.title === 'string' && row.title.trim() ? row.title : '标题不可用';
    const author = typeof row.author === 'string' && row.author.trim() ? row.author : '作者不可用';
    const score = clampScore(row.score);
    const publishedDate = typeof row.publishedAt === 'string' ? new Date(row.publishedAt) : null;
    const publishedLabel = publishedDate && Number.isFinite(publishedDate.getTime())
      ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(publishedDate)
      : '不可用';
    const breakdown = row.scoreBreakdown && typeof row.scoreBreakdown === 'object' ? row.scoreBreakdown : {};
    const ideas = row.ideas && typeof row.ideas === 'object' ? row.ideas : {};
    const qualification = row.qualification && typeof row.qualification === 'object' ? row.qualification : {};
    const evidence = qualification.passed === true
      ? '<p class="data-note">文本依据：' + escapeHtml((qualification.nicheHits || []).join('、'))
        + '；关键词：' + escapeHtml((qualification.keywordHits || []).join('、')) + '</p>'
      : '';
    const url = safeExternalUrl(row.videoUrl);
    const link = url
      ? `<a class="video-link" href="${escapeHtml(url)}" aria-label="在系统浏览器打开原视频">打开原视频 ↗</a>`
      : '<span class="unavailable-link">原视频链接不可用</span>';

    return `<article class="result-card">
      <div class="result-head">
        <span class="rank">#${index + 1}</span>
        <div class="result-title-wrap"><h3>${escapeHtml(title)}</h3><p class="result-subtitle">作者：${escapeHtml(author)} · ${escapeHtml(platformLabel(row.platform))}</p></div>
        <span class="total-score">${score} 分</span>
      </div>
      <div class="metric-row" aria-label="视频互动数据">
        <span class="metric">发布 <strong>${escapeHtml(publishedLabel)}</strong></span>
        <span class="metric">点赞 <strong>${formatMetric(row.likes)}</strong></span>
        <span class="metric">粉丝 <strong>${formatMetric(row.followers)}</strong></span>
        <span class="metric">收藏 <strong>${formatMetric(row.collects)}</strong></span>
        <span class="metric">评论 <strong>${formatMetric(row.comments)}</strong></span>
      </div>
      <div class="breakdown" aria-label="匹配分项">
        ${renderBreakdown('互动表现', breakdown.engagement)}
        ${renderBreakdown('画像匹配', breakdown.audienceMatch)}
        ${renderBreakdown('关键词', breakdown.keywordRelevance)}
      </div>
      ${evidence}
      <div class="ideas"><h4>怎么拍出自己的版本</h4>
        <p class="idea-row"><b>开场：</b>${escapeHtml(ideas.hook || '可结合目标粉丝提出一个具体问题或结果。')}</p>
        <p class="idea-row"><b>形式：</b>${escapeHtml(ideas.format || '可尝试改变叙事顺序、场景或演示方式。')}</p>
        <p class="idea-row"><b>个人化角度：</b>${escapeHtml(ideas.angle || '结合自己的真实经历、专业能力或案例重新表达。')}</p>
      </div>
      ${link}
    </article>`;
  }

  function renderResults(items) {
    if (!Array.isArray(items)) return '';
    return items.map((item, index) => renderItem(item, index)).join('');
  }

  function sourceLabel(source, platform) {
    if (source === 'bundled-demo') return '随包示例 · 非实时';
    if (source === 'local-mediacrawler-search') return `本机${platformLabel(platform)}关键词搜索 · 非全站热榜`;
    if (source === 'caller') return '调用方传入数据';
    return '分析结果';
  }

  function requestId(root) {
    const id = root.crypto && typeof root.crypto.randomUUID === 'function'
      ? root.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `panel-${id}`;
  }

  function panelRequest(root, channel, method, params, onRequestId, timeoutMs = COLLECT_TIMEOUT_MS) {
    if (!channel) return Promise.reject(new Error('当前环境不支持插件面板通信，请重开面板后重试。'));
    const reqId = requestId(root);
    if (typeof onRequestId === 'function') onRequestId(reqId);
    const packet = { type: 'panel-request', reqId, method, params };

    return new Promise((resolve, reject) => {
      let retryTimer = null;
      let timeoutTimer = null;
      let settled = false;
      const cleanup = () => {
        if (retryTimer !== null) root.clearInterval(retryTimer);
        if (timeoutTimer !== null) root.clearTimeout(timeoutTimer);
        channel.removeEventListener('message', onMessage);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (!message || message.type !== 'panel-result' || message.reqId !== reqId) return;
        if (message.ok === true && message.result) finish(resolve, message.result);
        else finish(reject, new Error(message.message || '插件操作失败，请重试。'));
      };

      channel.addEventListener('message', onMessage);
      timeoutTimer = root.setTimeout(() => {
        finish(reject, new Error('本次本机操作等待超时。请稍后重试；需要登录时会显示扫码窗口。'));
      }, timeoutMs);

      root.fetch(WAKE_URL, { cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok) throw new Error('无法唤醒插件逻辑。请确认插件已启用后重试。');
          const state = await response.json();
          if (state && state.state === 'fused') throw new Error('插件逻辑多次启动失败，已暂时停止。请到插件设置中重新启用后再试。');
          if (settled) return;
          const send = () => { if (!settled) channel.postMessage(packet); };
          send();
          retryTimer = root.setInterval(send, 250);
        })
        .catch((error) => finish(reject, error instanceof Error ? error : new Error('唤醒插件失败，请重试。')));
    });
  }

  function getElement(doc, id) {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`插件面板缺少必要元素：${id}`);
    return element;
  }

  function mount(doc, root) {
    const form = getElement(doc, 'profile-form');
    const profileSelect = getElement(doc, 'profile-select');
    const profileName = getElement(doc, 'profile-name');
    const accountName = getElement(doc, 'account-name');
    const platformDouyin = getElement(doc, 'platform-douyin');
    const platformKuaishou = getElement(doc, 'platform-kuaishou');
    const niche = getElement(doc, 'niche');
    const audience = getElement(doc, 'audience');
    const style = getElement(doc, 'content-style');
    const topN = getElement(doc, 'top-n');
    const timeRange = getElement(doc, 'time-range');
    const include = getElement(doc, 'include-keywords');
    const exclude = getElement(doc, 'exclude-keywords');
    const status = getElement(doc, 'status');
    const crawlerStatus = getElement(doc, 'crawler-status');
    const crawlerPath = getElement(doc, 'crawler-path');
    const runPlatform = getElement(doc, 'run-platform');
    const runButton = getElement(doc, 'run-ranking');
    const cancelButton = getElement(doc, 'cancel-run');
    const resetButton = getElement(doc, 'reset-profile');
    const addProfileButton = getElement(doc, 'add-profile');
    const deleteProfileButton = getElement(doc, 'delete-profile');
    const selectCrawlerButton = getElement(doc, 'select-crawler');
    const emptyState = getElement(doc, 'empty-state');
    const emptyMessage = getElement(doc, 'empty-message');
    const results = getElement(doc, 'results');
    const summary = getElement(doc, 'summary');
    const resultCount = getElement(doc, 'result-count');
    const source = getElement(doc, 'source-label');
    const channel = typeof root.BroadcastChannel === 'function' ? new root.BroadcastChannel(CHANNEL_NAME) : null;
    let state = normalizeProfileState({});
    let busy = false;
    let pickerBusy = false;
    let activeRequestId = null;
    let lastResult = null;
    let persistTimer = null;
    let userEdited = false;

    const setStatus = (target, statusValue, message) => {
      target.dataset.state = statusValue;
      target.textContent = message;
    };

    const setEmpty = (message) => {
      emptyMessage.textContent = message;
      emptyState.hidden = false;
      results.hidden = true;
    };

    const clearResults = (message) => {
      lastResult = null;
      summary.hidden = true;
      results.innerHTML = '';
      results.hidden = true;
      source.textContent = '等待采集';
      resultCount.textContent = '等待采集';
      setEmpty(message);
    };

    const active = () => state.profiles.find((profile) => profile.id === state.activeProfileId) || state.profiles[0];

    const readForm = () => {
      const weightValue = (id, fallback) => {
        const value = getElement(doc, id).value.trim();
        if (!value) return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
      };
      return normalizeProfile({
        ...active(),
        name: profileName.value.trim(),
        accountName: accountName.value.trim(),
        platforms: [
          ...(platformDouyin.checked ? ['douyin'] : []),
          ...(platformKuaishou.checked ? ['kuaishou'] : []),
        ],
        niche: niche.value.trim(),
        audience: audience.value.trim(),
        contentStyle: style.value.trim(),
        includeKeywords: parseKeywordInput(include.value),
        excludeKeywords: parseKeywordInput(exclude.value),
        minKeywordHits: Number(getElement(doc, 'min-keyword-hits').value || 1),
        minLikes: Number(getElement(doc, 'min-likes').value || 10000),
        minFollowers: Number(getElement(doc, 'min-followers').value || 0),
        topN: Number(topN.value || 5),
        timeRange: timeRange.value,
        rankingWeights: {
          engagement: weightValue('weight-engagement', DEFAULT_WEIGHTS.engagement),
          audienceMatch: weightValue('weight-audience', DEFAULT_WEIGHTS.audienceMatch),
          keywordRelevance: weightValue('weight-keywords', DEFAULT_WEIGHTS.keywordRelevance),
        },
      }, active().id, 0);
    };

    const writeForm = (profile) => {
      const value = normalizeProfile(profile, 'profile-default', 0);
      profileName.value = value.name;
      accountName.value = value.accountName;
      platformDouyin.checked = value.platforms.includes('douyin');
      platformKuaishou.checked = value.platforms.includes('kuaishou');
      niche.value = value.niche;
      audience.value = value.audience;
      style.value = value.contentStyle;
      topN.value = String(value.topN);
      timeRange.value = value.timeRange;
      include.value = value.includeKeywords.join('，');
      exclude.value = value.excludeKeywords.join('，');
      getElement(doc, 'min-keyword-hits').value = String(value.minKeywordHits);
      getElement(doc, 'min-likes').value = String(value.minLikes);
      getElement(doc, 'min-followers').value = String(value.minFollowers);
      getElement(doc, 'weight-engagement').value = String(value.rankingWeights.engagement);
      getElement(doc, 'weight-audience').value = String(value.rankingWeights.audienceMatch);
      getElement(doc, 'weight-keywords').value = String(value.rankingWeights.keywordRelevance);
      renderRunPlatforms(value);
    };

    const renderProfiles = () => {
      profileSelect.replaceChildren();
      state.profiles.forEach((profile) => {
        const option = doc.createElement('option');
        option.value = profile.id;
        option.textContent = profile.accountName ? `${profile.name} · ${profile.accountName}` : profile.name;
        profileSelect.appendChild(option);
      });
      profileSelect.value = state.activeProfileId;
      profileSelect.disabled = busy;
      deleteProfileButton.disabled = busy || state.profiles.length <= 1;
      addProfileButton.disabled = busy || state.profiles.length >= MAX_PROFILES;
    };

    const renderRunPlatforms = (profile) => {
      const enabled = profile.platforms;
      const previous = runPlatform.value;
      runPlatform.replaceChildren();
      if (enabled.length === 0) {
        const option = doc.createElement('option');
        option.value = '';
        option.textContent = '请先选择平台';
        runPlatform.appendChild(option);
        runPlatform.disabled = busy;
        return;
      }
      enabled.forEach((platform) => {
        const option = doc.createElement('option');
        option.value = platform;
        option.textContent = platformLabel(platform);
        runPlatform.appendChild(option);
      });
      runPlatform.value = enabled.includes(previous) ? previous : enabled[0];
      runPlatform.disabled = busy;
    };

    const syncBusyUi = () => {
      profileSelect.disabled = busy;
      runPlatform.disabled = busy;
      for (const control of form.querySelectorAll('input, textarea, select')) control.disabled = busy;
      addProfileButton.disabled = busy || state.profiles.length >= MAX_PROFILES;
      deleteProfileButton.disabled = busy || state.profiles.length <= 1;
      selectCrawlerButton.disabled = busy || pickerBusy;
      runButton.disabled = busy;
      resetButton.disabled = busy;
      cancelButton.hidden = !busy;
      if (!busy) cancelButton.disabled = false;
    };

    const refreshCrawlerStatus = () => {
      if (state.crawlerRoot) {
        setStatus(crawlerStatus, 'success', '已选择本机目录；开始采集前会检查虚拟环境与浏览器。');
        crawlerPath.textContent = `采集环境：${state.crawlerRoot.split(/[\\/]/).filter(Boolean).pop() || '已选择'}`;
        crawlerPath.hidden = false;
      } else {
        setStatus(crawlerStatus, 'idle', '请先选择本机已有的 MediaCrawler 项目目录。');
        crawlerPath.textContent = '';
        crawlerPath.hidden = true;
      }
    };

    const saveState = async () => {
      state.schemaVersion = PROFILE_STATE_VERSION;
      const response = await root.fetch('/kv', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (!response.ok) throw new Error('博主档案暂时无法保存。');
      if (channel) channel.postMessage({ type: 'profile-updated', state });
    };

    const saveCurrentProfile = async () => {
      const updated = readForm();
      const index = state.profiles.findIndex((profile) => profile.id === state.activeProfileId);
      if (index >= 0) state.profiles[index] = updated;
      renderProfiles();
      await saveState();
    };

    const renderResult = (value) => {
      const result = value && typeof value === 'object' ? value : {};
      const items = Array.isArray(result.items) ? result.items : [];
      lastResult = result;
      source.textContent = sourceLabel(result.source, result.platform) + (result.completionMessage ? ' · ' + result.completionMessage : '');
      resultCount.textContent = items.length + ' 条推荐 · ' + (TIME_RANGES[result.timeRange] || '不限时间');
      const first = items[0];
      summary.innerHTML = [
        `<div class="summary-item"><span>候选视频</span><strong>${formatMetric(result.candidateCount || items.length)}</strong></div>`,
        `<div class="summary-item"><span>最高综合分</span><strong>${first ? clampScore(first.score) : 0}</strong></div>`,
        `<div class="summary-item"><span>未达标内容</span><strong>${formatMetric(result.filteredCount ?? result.excludedCount ?? 0)}</strong></div>`,
      ].join('');
      summary.innerHTML += [
        ['重复视频', result.duplicateCount],
        ['超出时间范围', result.outsideTimeRangeCount],
        ['发布时间缺失或无效', result.missingPublishTimeCount],
      ].map(([label, count]) => '<div class="summary-item"><span>' + label + '</span><strong>' + formatMetric(count || 0) + '</strong></div>').join('');
      summary.hidden = false;
      if (items.length === 0) {
        results.innerHTML = '';
        results.hidden = true;
        emptyState.hidden = false;
        emptyMessage.textContent = result.candidateCount > 0
          ? '没有视频同时满足所选时间范围、最低点赞数、最低粉丝量、赛道相关和关键词命中门槛，本次不推荐。可调整筛选门槛或时间范围。'
          : '本次采集没有返回可排序的视频；请检查登录状态或更换关键词。';
        return;
      }
      results.innerHTML = renderResults(items);
      results.hidden = false;
      emptyState.hidden = true;
    };

    const run = async () => {
      if (busy) return;
      const profile = readForm();
      if (!profile.name) {
        setStatus(status, 'error', '请先填写档案名称。');
        profileName.focus();
        return;
      }
      if (!profile.niche) {
        setStatus(status, 'error', '请先填写赛道，例如“美食探店”或“职场成长”。');
        niche.focus();
        return;
      }
      if (!profile.audience) {
        setStatus(status, 'error', '请描述目标粉丝及其关注需求，再开始采集。');
        audience.focus();
        return;
      }
      if (!profile.platforms.length) {
        setStatus(status, 'error', '至少选择一个采集平台。');
        platformDouyin.focus();
        return;
      }
      if (!state.crawlerRoot) {
        setStatus(status, 'error', '请先选择本机已有的 MediaCrawler 项目目录。');
        selectCrawlerButton.focus();
        return;
      }
      if (!Number.isInteger(profile.topN) || profile.topN < 1 || profile.topN > 50) {
        setStatus(status, 'error', '推荐数量需要是 1–50 之间的整数。');
        topN.focus();
        return;
      }
      if (!Number.isInteger(profile.minKeywordHits) || profile.minKeywordHits < 1 || profile.minKeywordHits > 3) {
        setStatus(status, 'error', '关键词最低命中数需要是 1–3 之间的整数。');
        getElement(doc, 'min-keyword-hits').focus();
        return;
      }
      const weights = Object.values(profile.rankingWeights);
      if (weights.some((value) => !Number.isFinite(value) || value < 0 || value > 1) || weights.every((value) => value === 0)) {
        setStatus(status, 'error', '排序权重需要在 0–1 之间，且至少一项大于 0。');
        getElement(doc, 'weight-engagement').focus();
        return;
      }
      if (!profile.platforms.includes(runPlatform.value)) {
        setStatus(status, 'error', '本次平台不在当前档案的选择范围内。');
        return;
      }

      busy = true;
      syncBusyUi();
      setStatus(status, 'loading', '正在后台搜索并筛选；需要登录时会显示一个扫码窗口，登录后自动关闭。');
      setEmpty('正在检查环境并准备关键词搜索…');
      try {
        await saveCurrentProfile();
        const result = await panelRequest(root, channel, 'rank_hot_topics', {
          ...profile,
          platform: runPlatform.value,
        }, (reqId) => { activeRequestId = reqId; });
        renderResult(result);
        setStatus(status, 'success', result.completionMessage || '采集与排序完成。');
      } catch (error) {
        const message = error instanceof Error ? error.message : '本次采集失败，请重试。';
        setStatus(status, 'error', `${message}${lastResult ? ' 下方仍保留上次成功结果。' : ''}`);
        if (!lastResult) setEmpty('本次采集没有完成。请确认网络与登录状态，或重选采集环境后再试。');
      } finally {
        busy = false;
        activeRequestId = null;
        syncBusyUi();
      }
    };

    profileSelect.addEventListener('change', async () => {
      if (busy) return;
      const nextProfileId = profileSelect.value;
      try { await saveCurrentProfile(); } catch { /* Switching remains local and retryable. */ }
      state.activeProfileId = nextProfileId;
      renderProfiles();
      writeForm(active());
      clearResults('切换了博主档案；运行一次采集后查看该档案的结果。');
      setStatus(status, 'idle', `已切换到「${active().name}」。`);
    });

    addProfileButton.addEventListener('click', async () => {
      if (busy || state.profiles.length >= MAX_PROFILES) return;
      try { await saveCurrentProfile(); } catch { /* Continue with in-memory state. */ }
      const next = createProfile(root, state.profiles.length);
      state.profiles.push(next);
      state.activeProfileId = next.id;
      renderProfiles();
      writeForm(next);
      clearResults('填写新档案后运行一次采集，结果会显示在这里。');
      userEdited = true;
      setStatus(status, 'idle', '新档案已创建；填写赛道、受众和账号风格。');
      try { await saveState(); } catch { setStatus(status, 'error', '新档案暂未保存；修改任一字段后会重试。'); }
    });

    deleteProfileButton.addEventListener('click', async () => {
      if (busy || state.profiles.length <= 1) return;
      const currentName = active().name;
      state.profiles = state.profiles.filter((profile) => profile.id !== state.activeProfileId);
      state.activeProfileId = state.profiles[0].id;
      renderProfiles();
      writeForm(active());
      clearResults('已删除档案；运行一次采集查看当前档案的结果。');
      userEdited = true;
      setStatus(status, 'success', `已删除「${currentName}」档案。`);
      try { await saveState(); } catch { setStatus(status, 'error', '档案删除尚未保存；请检查插件存储后重试。'); }
    });

    selectCrawlerButton.addEventListener('click', async () => {
      if (busy || pickerBusy) return;
      pickerBusy = true;
      syncBusyUi();
      setStatus(crawlerStatus, 'loading', '正在打开系统目录选择器…');
      try {
        const picked = await panelRequest(root, channel, 'pick_media_crawler', {});
        state = normalizeProfileState(picked.state || { ...state, crawlerRoot: picked.crawlerRoot });
        renderProfiles();
        writeForm(active());
        refreshCrawlerStatus();
        try { await saveState(); } catch { setStatus(crawlerStatus, 'error', '目录已选择，但设置暂未保存；请重试。'); }
      } catch (error) {
        const message = error instanceof Error ? error.message : '目录选择未完成。';
        setStatus(crawlerStatus, 'error', message);
      } finally {
        pickerBusy = false;
        syncBusyUi();
      }
    });

    runButton.addEventListener('click', () => { void run(); });
    form.addEventListener('submit', (event) => { event.preventDefault(); void run(); });
    resetButton.addEventListener('click', async () => {
      const current = active();
      writeForm({
        ...current,
        niche: '', audience: '', contentStyle: '', includeKeywords: [], excludeKeywords: [],
        topN: 5, timeRange: '1m', rankingWeights: DEFAULT_WEIGHTS,
      });
      userEdited = true;
      setStatus(status, 'idle', '当前档案的创作画像已清空。');
      setEmpty('填写赛道和目标粉丝后再开始采集。');
      summary.hidden = true;
      source.textContent = '等待采集';
      resultCount.textContent = '等待采集';
      lastResult = null;
      try { await saveCurrentProfile(); } catch { setStatus(status, 'error', '画像已清空，但暂时无法保存。'); }
    });

    cancelButton.addEventListener('click', () => {
      if (!busy || !activeRequestId || !channel) return;
      channel.postMessage({ type: 'panel-cancel', reqId: activeRequestId });
      setStatus(status, 'loading', '正在停止本次采集并清理临时文件…');
      cancelButton.disabled = true;
    });

    form.addEventListener('input', () => {
      userEdited = true;
      if (persistTimer !== null) root.clearTimeout(persistTimer);
      persistTimer = root.setTimeout(() => {
        void saveCurrentProfile().catch(() => {});
      }, 500);
    });

    if (channel) {
      channel.addEventListener('message', (event) => {
        const message = event.data;
        if (message && message.type === 'profile-updated' && message.state) {
          state = normalizeProfileState(message.state);
          renderProfiles();
          writeForm(active());
          refreshCrawlerStatus();
        }
        if (message && message.type === 'collector-progress' && message.reqId === activeRequestId) {
          setStatus(status, 'loading', message.message || '本机采集正在运行…');
        }
        if (message && message.type === 'agent-result' && message.result && Array.isArray(message.result.items)) {
          renderResult(message.result);
          setStatus(status, 'success', 'Agent 已完成热点整理与档案匹配。');
        }
      });
    }

    if (typeof root.addEventListener === 'function') {
      root.addEventListener('pagehide', () => {
        if (busy && activeRequestId && channel) channel.postMessage({ type: 'panel-cancel', reqId: activeRequestId });
      });
    }

    setStatus(status, 'loading', '正在读取已保存的博主档案…');
    root.fetch('/kv')
      .then(async (response) => {
        if (!response.ok) throw new Error('读取失败');
        return response.json();
      })
      .then(async (stored) => {
        if (userEdited) return;
        const needsMigration = !stored || stored.schemaVersion !== PROFILE_STATE_VERSION || !Array.isArray(stored.profiles);
        state = normalizeProfileState(stored, root);
        renderProfiles();
        writeForm(active());
        refreshCrawlerStatus();
        if (needsMigration) {
          try { await saveState(); } catch { /* The visible profile remains editable. */ }
        }
        setStatus(status, state.crawlerRoot
          ? '档案已就绪；可以在面板采集，或在 Cindy 中输入“热点 抖音”。'
          : '请选择本机采集环境，再填写赛道和目标粉丝。');
        if (!active().niche || !active().audience) setEmpty('选择采集环境并填写博主档案后，结果会显示在这里。');
      })
      .catch(() => {
        if (userEdited) return;
        state = normalizeProfileState({}, root);
        renderProfiles();
        writeForm(active());
        refreshCrawlerStatus();
        setStatus(status, 'idle', '没有读取到已保存档案；可新建档案并填写赛道与目标粉丝。');
        setEmpty('选择采集环境并填写博主档案后，结果会显示在这里。');
      });
  }

  return {
    escapeHtml,
    safeExternalUrl,
    formatMetric,
    platformLabel,
    renderItem,
    renderResults,
    sourceLabel,
    parseKeywordInput,
    normalizeProfileState,
    createProfile,
    mount,
  };
});
