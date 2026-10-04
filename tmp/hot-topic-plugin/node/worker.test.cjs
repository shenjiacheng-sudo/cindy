'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const worker = require('./worker.cjs');
const collector = require('./crawler-adapter.cjs');
const panel = require('../panel.js');

const pluginDir = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'ghost.json'), 'utf8'));

test('Ghost v3 manifest and every declared asset are present', () => {
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.kind, 'chip');
  assert.equal(manifest.id, 'hot-topic-plugin');
  assert.equal(manifest.command, '热点');
  assert.equal('slots' in manifest, false);
  assert.equal(manifest.panel.position, 'left');
  assert.deepEqual(manifest.tools.map((tool) => tool.name).sort(), ['load_hot_topic_fixture', 'rank_hot_topics']);
  for (const file of [
    manifest.entry,
    manifest.panel.html,
    'panel.css',
    'panel.js',
    manifest.node.entry,
    'node/crawler-adapter.cjs',
    ...manifest.manual.items.map((item) => `${item.dir}/MANUAL.md`),
    'data/douyin-snapshot.json',
  ]) {
    assert.equal(fs.statSync(path.join(pluginDir, file)).isFile(), true, `${file} must exist`);
  }
  assert.equal('network' in manifest, false);
  assert.equal('fs' in manifest, false);
  assert.equal('secrets' in manifest, false);
  assert.equal(manifest.pick, true);
  assert.match(fs.readFileSync(path.join(pluginDir, 'index.html'), 'utf8'), /id="status"[\s\S]*aria-live="polite"/);
  assert.match(fs.readFileSync(path.join(pluginDir, 'index.html'), 'utf8'), /id="empty-state"/);
});

test('Node Runtime loads the declared entry through require and still starts its JSON-RPC loop', () => {
  const entryPath = path.join(__dirname, 'worker.cjs');
  const bootstrap = [
    "if (require.main) throw new Error('expected a require-loaded entry');",
    'globalThis.__CINDY_NODE__ = Object.freeze({});',
    "const { createRequire } = require('node:module');",
    `createRequire(${JSON.stringify(__filename)})(${JSON.stringify(entryPath)});`,
  ].join('\n');
  const response = spawnSync(process.execPath, ['-e', bootstrap], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'load_hot_topic_fixture' })}\n`,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(response.error, undefined, response.error?.message);
  assert.equal(response.status, 0, response.stderr);
  const rows = response.stdout.trim().split('\n').filter(Boolean);
  assert.equal(rows.length, 1);
  const rpc = JSON.parse(rows[0]);
  assert.equal(rpc.id, 1);
  assert.equal(rpc.result.source, 'bundled-demo');
  assert.equal(rpc.result.total, 5);
});

test('empty videos use the bundled static fixture with complete ranking results', () => {
  const result = worker.rankHotTopics({ timeRange: 'all',
    niche: '职场成长',
    audience: '刚工作的年轻白领，关注沟通和效率',
    contentStyle: '真实案例、步骤拆解',
    includeKeywords: ['职场', '效率', '干货'],
    topN: 3,
  });
  assert.equal(result.source, 'bundled-demo');
  assert.equal(result.sourceLabel, '随包静态示例（非实时）');
  assert.equal(result.candidateCount, 5);
  assert.equal(result.items.length, 3);
  for (const item of result.items) {
    assert.ok(item.author);
    assert.ok(item.videoUrl);
    assert.ok(Number.isFinite(item.likes));
    assert.ok(Number.isFinite(item.collects));
    assert.ok(Number.isFinite(item.comments));
    assert.ok(item.score >= 0 && item.score <= 100);
    assert.deepEqual(Object.keys(item.ideas), ['hook', 'format', 'angle']);
    assert.ok(item.ideas.hook.includes('可以尝试'));
  }
  assert.ok(result.items.every((item, index, rows) => index === 0 || rows[index - 1].score >= item.score));
});

test('legacy single profile migrates into one editable profile without losing settings', () => {
  const state = panel.normalizeProfileState({
    niche: '职场成长', audience: '年轻职场人', contentStyle: '真实案例',
    includeKeywords: ['沟通', '职场'], excludeKeywords: ['搬运'], topN: 7,
    rankingWeights: { engagement: 0.5, audienceMatch: 0.3, keywordRelevance: 0.2 },
  });
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.profiles.length, 1);
  assert.equal(state.activeProfileId, state.profiles[0].id);
  assert.equal(state.profiles[0].niche, '职场成长');
  assert.equal(state.profiles[0].contentStyle, '真实案例');
  assert.deepEqual(state.profiles[0].includeKeywords, ['沟通', '职场']);
  assert.deepEqual(state.profiles[0].excludeKeywords, ['搬运']);
  assert.equal(state.profiles[0].topN, 7);
  assert.deepEqual(state.profiles[0].rankingWeights, { engagement: 0.5, audienceMatch: 0.3, keywordRelevance: 0.2 });
});

test('profile state drops invalid platform and preserves selected crawler root', () => {
  const state = panel.normalizeProfileState({
    schemaVersion: 2,
    activeProfileId: 'creator-1',
    crawlerRoot: '/Users/example/MediaCrawler',
    profiles: [{ id: 'creator-1', name: '体验档案', platforms: ['douyin', 'xhs', 'kuaishou'], niche: '职场' }],
  });
  assert.equal(state.crawlerRoot, '/Users/example/MediaCrawler');
  assert.deepEqual(state.profiles[0].platforms, ['douyin', 'kuaishou']);
  assert.equal(state.activeProfileId, 'creator-1');
});

test('profile state keeps an intentionally empty platform selection and repairs duplicate ids', () => {
  const state = panel.normalizeProfileState({
    schemaVersion: 2,
    activeProfileId: 'same',
    profiles: [
      { id: 'same', name: '账号一', platforms: ['douyin'] },
      { id: 'same', name: '账号二', platforms: [] },
    ],
  });
  assert.equal(state.profiles[0].id, 'same');
  assert.notEqual(state.profiles[1].id, 'same');
  assert.deepEqual(state.profiles[1].platforms, []);
});

test('MediaCrawler Kuaishou aliases map to public display fields only', () => {
  const video = worker.normalizeVideo({
    platform: 'kuaishou',
    video_id: 'ks-1',
    title: '沟通示例',
    nickname: '作者甲',
    video_url: 'https://www.kuaishou.com/short-video/ks-1?from=search#detail',
    video_play_url: 'https://cdn.example/video?token=do-not-return',
    liked_count: '1.2万',
  }, 0, 'kuaishou');
  assert.equal(video.id, 'ks-1');
  assert.equal(video.platform, 'kuaishou');
  assert.equal(video.author, '作者甲');
  assert.equal(video.videoUrl, 'https://www.kuaishou.com/short-video/ks-1');
  assert.equal(video.likes, 12000);
  assert.equal(video.collects, null);
  assert.equal(video.comments, null);
  assert.equal('video_play_url' in video, false);
});

test('local collector builds a fixed search-only command and rejects unsafe keywords', () => {
  const args = collector.buildCrawlerArgs({
    platform: 'douyin',
    keywords: ['沟通', '职场'],
    outputDir: path.join(os.tmpdir(), 'hot-topic-test-output'),
    maxItems: 12,
  });
  assert.deepEqual(args.slice(0, 7), ['main.py', '--platform', 'dy', '--lt', 'qrcode', '--type', 'search']);
  assert.equal(args[args.indexOf('--keywords') + 1], '沟通,职场');
  assert.equal(args[args.indexOf('--get_comment') + 1], 'false');
  assert.equal(args[args.indexOf('--get_sub_comment') + 1], 'false');
  assert.equal(args[args.indexOf('--get_media') + 1], 'false');
  assert.equal(args[args.indexOf('--save_data_option') + 1], 'jsonl');
  assert.throws(() => collector.buildCrawlerArgs({
    platform: 'douyin', keywords: ['safe,bad'], outputDir: path.join(os.tmpdir(), 'x'),
  }), /逗号或换行/);
  assert.throws(() => collector.buildCrawlerArgs({
    platform: 'xhs', keywords: ['安全'], outputDir: path.join(os.tmpdir(), 'x'),
  }), /仅支持抖音或快手/);
});

test('isolated crawler copy disables existing-browser attachment and binds CDP to loopback', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-patch-test-'));
  try {
    const configDir = path.join(root, 'config');
    const toolsDir = path.join(root, 'tools');
    fs.mkdirSync(configDir);
    fs.mkdirSync(toolsDir);
    fs.writeFileSync(path.join(configDir, 'base_config.py'), 'CDP_CONNECT_EXISTING = True\nCUSTOM_BROWSER_PATH = ""\n');
    fs.writeFileSync(path.join(toolsDir, 'browser_launcher.py'), [
      'args = [',
      '            "--remote-debugging-address=0.0.0.0",',
      '            "--no-sandbox",',
      '        ]',
      '            self.browser_process = process',
      '            return process',
    ].join('\n'));
    collector.patchIsolatedSource(root, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    const config = fs.readFileSync(path.join(configDir, 'base_config.py'), 'utf8');
    const browser = fs.readFileSync(path.join(toolsDir, 'browser_launcher.py'), 'utf8');
    assert.match(config, /CDP_CONNECT_EXISTING = False/);
    assert.match(config, /CUSTOM_BROWSER_PATH = "\/Applications\/Google Chrome\.app/);
    assert.match(browser, /--remote-debugging-address=127\.0\.0\.1/);
    assert.equal(browser.includes('--no-sandbox'), false);
    assert.match(browser, /\.cindy-trial-browser-pid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isolated archive omits env templates and rejects symlinked source trees', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-git-tree-test-'));
  const repo = path.join(root, 'repo');
  const archive = path.join(root, 'archive');
  fs.mkdirSync(repo);
  fs.mkdirSync(archive);
  const git = (args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore'] });
    assert.equal(result.status, 0, `git ${args[0]} should succeed`);
  };
  try {
    git(['init', '-q']);
    git(['config', 'user.name', 'Cindy Test']);
    git(['config', 'user.email', 'cindy-test@example.invalid']);
    fs.writeFileSync(path.join(repo, 'main.py'), 'print("safe")\n');
    fs.writeFileSync(path.join(repo, '.env.example'), 'fake-placeholder=not-a-secret\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'initial']);
    collector.validateGitTree(repo);
    await collector.archiveHead(repo, archive, new AbortController().signal);
    assert.equal(fs.existsSync(path.join(archive, 'main.py')), true);
    assert.equal(fs.existsSync(path.join(archive, '.env.example')), false);

    fs.symlinkSync('/tmp/should-not-be-read', path.join(repo, 'unsafe-link'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'symlink']);
    assert.throws(() => collector.validateGitTree(repo), (error) => error.code === 'COLLECTOR_TREE_UNSAFE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local collector JSONL parser returns bounded public fields and ignores play URLs', () => {

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-jsonl-test-'));
  try {
    const out = path.join(root, 'dy', 'jsonl');
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(out, 'search_contents_test.jsonl'), [
      JSON.stringify({ aweme_id: 'dy-1', desc: '沟通案例', nickname: '作者乙', aweme_url: 'https://www.douyin.com/video/dy-1?share=1', liked_count: '88', video_play_url: 'https://cdn.example/private?token=fake' }),
      '{broken json line',
      JSON.stringify({ aweme_id: 'dy-2', desc: '补充案例', video_play_url: 'https://cdn.example/secret' }),
    ].join('\n'), { mode: 0o600 });
    const rows = collector.parseSearchJsonl(root, 'douyin');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].platform, 'douyin');
    assert.equal(rows[0].aweme_id, 'dy-1');
    assert.equal('video_play_url' in rows[0], false);
    assert.equal('video_play_url' in rows[1], false);
    assert.equal(collector.safeJsonRecord({ video_download_url: 'https://cdn.example/x' }, 'douyin').video_download_url, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local collector keyword selection is capped and falls back to the profile niche', () => {
  assert.deepEqual(collector.normalizeKeywords({ includeKeywords: ['沟通', '副业', '效率', '忽略'], niche: '其他' }), ['沟通', '副业', '效率']);
  assert.deepEqual(collector.normalizeKeywords({ includeKeywords: [], niche: '职场成长' }), ['职场成长']);
});

test('Agent collection returns live-source metadata instead of silently using the bundled fixture', async () => {
  const original = collector.collectMediaCrawler;
  collector.collectMediaCrawler = async ({ crawlerRoot, platform, profile, signal }) => {
    assert.equal(crawlerRoot, '/picked/MediaCrawler');
    assert.equal(platform, 'kuaishou');
    assert.equal(profile.niche, '职场成长');
    assert.equal(signal.aborted, false);
    return {
      videos: [{ video_id: 'ks-live', title: '职场沟通案例', nickname: '作者甲', video_url: 'https://www.kuaishou.com/short-video/ks-live', liked_count: 20000 }],
      platform: 'kuaishou',
      fetchedAt: '2026-10-01T00:00:00.000Z',
      queryKeywords: ['沟通'],
    };
  };
  try {
    const result = await worker.handleRequestAsync({
      method: 'rank_hot_topics',
      params: {
        timeRange: 'all',
        collect: true,
        requestId: 'agent-collect-test',
        crawlerRoot: '/picked/MediaCrawler',
        platform: 'kuaishou',
        niche: '职场成长',
        audience: '年轻职场人',
        includeKeywords: ['沟通', '职场'],
        topN: 3,
      },
    });
    assert.equal(result.source, 'local-mediacrawler-search');
    assert.equal(result.platform, 'kuaishou');
    assert.equal(result.candidateCount, 1);
    assert.equal(result.items[0].id, 'ks-live');
    assert.deepEqual(result.queryKeywords, ['沟通']);
    assert.equal(result.fetchedAt, '2026-10-01T00:00:00.000Z');
  } finally {
    collector.collectMediaCrawler = original;
  }
});

test('Agent collection cancellation aborts only its identified run', async () => {
  const original = collector.collectMediaCrawler;
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  collector.collectMediaCrawler = ({ signal }) => new Promise((resolve, reject) => {
    entered();
    signal.addEventListener('abort', () => reject(new collector.CollectorError('COLLECTOR_CANCELLED', 'cancelled')), { once: true });
  });
  try {
    const pending = worker.handleRequestAsync({
      method: 'rank_hot_topics',
      params: { collect: true, requestId: 'agent-cancel-test', crawlerRoot: '/picked', platform: 'douyin', niche: '职场' },
    });
    await started;
    await assert.rejects(worker.handleRequestAsync({
      method: 'rank_hot_topics',
      params: { collect: true, requestId: 'agent-other-test', crawlerRoot: '/picked', platform: 'douyin', niche: '职场' },
    }), (error) => error.code === 'COLLECTOR_BUSY');
    const cancelResult = await worker.handleRequestAsync({
      method: 'cancel_collection',
      params: { requestId: 'agent-cancel-test' },
    });
    assert.deepEqual(cancelResult, { cancelled: true });
    await assert.rejects(pending, (error) => error.code === 'COLLECTOR_CANCELLED');
  } finally {
    collector.collectMediaCrawler = original;
  }
});

test('MediaCrawler field aliases map without fabricating author, links, or missing metrics', () => {
  const video = worker.normalizeVideo({
    aweme_id: 123,
    desc: '沟通技巧',
    nickname: '作者甲',
    aweme_url: 'https://www.douyin.com/video/123',
    liked_count: '1.2万',
    collected_count: undefined,
    comment_count: 'not-a-number',
  }, 0);
  assert.equal(video.id, '123');
  assert.equal(video.platform, 'douyin');
  assert.equal(video.title, '沟通技巧');
  assert.equal(video.author, '作者甲');
  assert.equal(video.videoUrl, 'https://www.douyin.com/video/123');
  assert.equal(video.likes, 12000);
  assert.equal(video.collects, null);
  assert.equal(video.comments, null);

  const sparse = worker.normalizeVideo({ title: '没有统计数据' }, 1);
  assert.equal(sparse.author, null);
  assert.equal(sparse.platform, null);
  assert.equal(sparse.videoUrl, null);
  assert.equal(sparse.likes, null);
  assert.equal(sparse.collects, null);
  assert.equal(sparse.comments, null);
});

test('exclude keywords filter results and metrics are never estimated', () => {
  const result = worker.rankHotTopics({ timeRange: 'all',
    videos: [
      { id: 'a', title: '职场沟通效率', author: '甲', videoUrl: 'https://www.douyin.com/video/a', likes: 10000, collects: 20, comments: 3 },
      { id: 'b', title: '游戏沟通效率', author: '乙', videoUrl: 'https://www.douyin.com/video/b', likes: 20000, collects: 30, comments: 9 },
      { id: 'c', title: '职场沟通案例', likes: null, collects: null, comments: null },
    ],
    niche: '职场',
    audience: '职场白领关注沟通',
    includeKeywords: ['沟通', '职场'],
    excludeKeywords: ['游戏'],
  });
  assert.equal(result.source, 'caller');
  assert.equal(result.candidateCount, 3);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.items.some((item) => item.id === 'b'), false);
  assert.equal(result.items.some((item) => item.id === 'c'), false);
  assert.equal(result.filteredByReason.likes, 1);
  const sparse = worker.normalizeVideo({ title: '职场沟通案例', likes: null, collects: null, comments: null }, 0);
  assert.equal(sparse.author, null);
  assert.equal(sparse.videoUrl, null);
  assert.equal(sparse.likes, null);
  assert.equal(sparse.collects, null);
  assert.equal(sparse.comments, null);
});

test('ranking weights normalize safely and tie order uses collects then likes', () => {
  const result = worker.rankHotTopics({ timeRange: 'all',
    videos: [
      { id: 'likes-wins', title: '职场白领', likes: 30000, collects: 8 },
      { id: 'collects-wins', title: '职场白领', likes: 10000, collects: 9 },
      { id: 'last', title: '职场白领', likes: 20000, collects: 8 },
    ],
    niche: '职场',
    audience: '白领',
    includeKeywords: ['职场', '白领'],
    rankingWeights: { engagement: 0, audienceMatch: 1, keywordRelevance: 0 },
  });
  assert.equal(result.items[0].id, 'collects-wins');
  assert.equal(result.items[1].id, 'likes-wins');
  assert.equal(result.items[2].id, 'last');
  assert.deepEqual(result.rankingWeights, { engagement: 0, audienceMatch: 1, keywordRelevance: 0 });

  const fallback = worker.cleanWeights({ engagement: 0, audienceMatch: 0, keywordRelevance: 0 });
  assert.deepEqual(fallback, worker.DEFAULT_WEIGHTS);
  assert.ok(Object.values(worker.cleanWeights({ engagement: NaN, audienceMatch: -1 })).every(Number.isFinite));
});

test('all-filtered result, result cap, and malformed input are handled', () => {
  const empty = worker.rankHotTopics({ timeRange: 'all',
    videos: [{ title: '游戏新闻', likes: 10 }],
    niche: '教育',
    audience: '教师',
    excludeKeywords: ['游戏'],
    topN: 0,
  });
  assert.equal(empty.total, 0);
  assert.equal(empty.excludedCount, 1);
  assert.throws(() => worker.rankHotTopics({ timeRange: 'all', videos: 'not-an-array' }), /videos 必须是数组/);
  assert.throws(() => worker.rankHotTopics({ timeRange: 'all', videos: Array(5001).fill({ title: 'x' }) }), /最多分析 5000 条/);
  assert.throws(() => worker.normalizeVideo(null, 0), /必须是对象/);
});

test('panel rendering escapes untrusted text, rejects unsafe links, and labels unavailable fields', () => {
  assert.equal(panel.safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(panel.safeExternalUrl('https://user:pass@example.com/video'), null);
  assert.equal(panel.safeExternalUrl('https://www.douyin.com/video/1'), 'https://www.douyin.com/video/1');
  assert.equal(panel.formatMetric(null), '不可用');
  const html = panel.renderItem({
    title: '<script>alert(1)</script>',
    author: null,
    platform: 'douyin',
    likes: null,
    collects: 0,
    comments: null,
    videoUrl: 'javascript:alert(1)',
    score: 91,
    scoreBreakdown: { engagement: 70, audienceMatch: 100, keywordRelevance: 80 },
    ideas: { hook: '<img src=x onerror=alert(1)>', format: '形式建议', angle: '个人角度' },
  }, 0);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img src=x'), false);
  assert.match(html, /作者不可用/);
  assert.match(html, /不可用/);
  assert.match(html, /原视频链接不可用/);
  assert.equal(html.includes('href="javascript:'), false);
  assert.match(panel.sourceLabel('bundled-demo'), /非实时/);
});

test('main.js routes panel retries through one Node request and sends local collection to Agent tools', async () => {
  const channels = new Map();
  class TestBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      const peers = channels.get(name) || new Set();
      peers.add(this);
      channels.set(name, peers);
    }
    addEventListener(name, listener) {
      if (name === 'message') this.listeners.add(listener);
    }
    removeEventListener(name, listener) {
      if (name === 'message') this.listeners.delete(listener);
    }
    postMessage(data) {
      for (const peer of channels.get(this.name) || []) {
        if (peer === this) continue;
        queueMicrotask(() => {
          for (const listener of peer.listeners) listener({ data });
        });
      }
    }
  }

  const state = {
    schemaVersion: 2,
    activeProfileId: 'creator-1',
    crawlerRoot: '/picked/MediaCrawler',
    profiles: [{ id: 'creator-1', name: '职场号', platforms: ['douyin', 'kuaishou'], niche: '保存赛道', audience: '保存画像', contentStyle: '真实案例', includeKeywords: ['沟通', '职场'], excludeKeywords: [], topN: 5, rankingWeights: { engagement: 0.4, audienceMatch: 0.35, keywordRelevance: 0.25 } }],
  };
  const nodeCalls = [];
  const hostResults = [];
  const hostMessageHandlers = [];
  const fakeCindy = {
    node: {
      request: async (request) => {
        nodeCalls.push(JSON.parse(JSON.stringify(request)));
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { ok: true, result: { source: 'local-mediacrawler-search', platform: request.params.platform, candidateCount: 1, excludedCount: 0, total: 1, items: [] } };
      },
    },
    pick: async () => ({ ok: false, errorCode: 'CANCELLED' }),
    onHostMessage: (handler) => hostMessageHandlers.push(handler),
    send: async (message) => hostResults.push(message),
  };
  const sandbox = {
    cindy: fakeCindy,
    BroadcastChannel: TestBroadcastChannel,
    module: { exports: {} },
    fetch: async (url, options = {}) => {
      if (url !== '/kv') return { ok: false, json: async () => ({}) };
      if (options.method === 'PUT') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => state };
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  };
  vm.runInNewContext(fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8'), sandbox);
  const panelChannel = new TestBroadcastChannel('hot-topic-plugin');
  const panelResults = [];
  panelChannel.addEventListener('message', (event) => panelResults.push(event.data));
  const request = {
    type: 'panel-request',
    reqId: 'panel-test-1',
    method: 'rank_hot_topics',
    params: { audience: '本次画像', platform: 'douyin' },
  };
  panelChannel.postMessage(request);
  panelChannel.postMessage(request);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(nodeCalls.length, 1, 'retries with the same reqId must not repeat worker work');
  assert.equal(nodeCalls[0].params.niche, '保存赛道');
  assert.equal(nodeCalls[0].params.audience, '本次画像');
  assert.equal(nodeCalls[0].params.collect, true);
  assert.equal(nodeCalls[0].params.crawlerRoot, '/picked/MediaCrawler');
  assert.equal(nodeCalls[0].params.requestId, 'panel-test-1');
  assert.equal(nodeCalls[0].params.platform, 'douyin');
  assert.equal(nodeCalls[0].timeoutMs, 60000);
  assert.equal(nodeCalls[0].maxTotalMs, 900000);
  assert.ok(panelResults.some((message) => message.type === 'panel-result' && message.reqId === request.reqId && message.ok));

  panelChannel.postMessage(request);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(nodeCalls.length, 1, 'completed requests are replayed from the response cache');

  await hostMessageHandlers[0]({
    type: 'tool-call',
    tool: 'rank_hot_topics',
    callId: 'agent-call-1',
    args: { niche: '显式赛道', platform: 'kuaishou', crawlerRoot: '/attacker/path' },
  });
  assert.equal(nodeCalls.length, 2);
  assert.equal(nodeCalls[1].params.niche, '显式赛道');
  assert.equal(nodeCalls[1].params.audience, '保存画像');
  assert.equal(nodeCalls[1].params.collect, true);
  assert.equal(nodeCalls[1].params.platform, 'kuaishou');
  assert.equal(nodeCalls[1].params.crawlerRoot, '/picked/MediaCrawler');
  assert.equal(nodeCalls[1].callId, 'agent-call-1');
  assert.equal(nodeCalls[1].cancelWithCall, true);
  assert.ok(hostResults.some((message) => message.type === 'tool-result' && message.callId === 'agent-call-1' && message.ok));
});

test('main.js uses the system picker and persists only a user-selected collector directory', async () => {
  const channels = new Map();
  class TestBroadcastChannel {
    constructor(name) {
      this.name = name;
      this.listeners = new Set();
      const peers = channels.get(name) || new Set();
      peers.add(this);
      channels.set(name, peers);
    }
    addEventListener(name, listener) { if (name === 'message') this.listeners.add(listener); }
    removeEventListener(name, listener) { if (name === 'message') this.listeners.delete(listener); }
    postMessage(data) {
      for (const peer of channels.get(this.name) || []) {
        if (peer === this) continue;
        queueMicrotask(() => { for (const listener of peer.listeners) listener({ data }); });
      }
    }
  }
  let pickerCalls = 0;
  const saved = [];
  const hostMessageHandlers = [];
  const fakeCindy = {
    pick: async (options) => {
      pickerCalls += 1;
      assert.equal(options.mode, 'directory');
      assert.equal(options.title, '选择已有的 MediaCrawler 项目目录');
      return { ok: true, name: 'MediaCrawler', path: '/picked/MediaCrawler' };
    },
    node: { request: async () => ({ ok: true, result: {} }) },
    onHostMessage: (handler) => hostMessageHandlers.push(handler),
    send: async () => {},
  };
  const sandbox = {
    cindy: fakeCindy,
    BroadcastChannel: TestBroadcastChannel,
    module: { exports: {} },
    fetch: async (url, options = {}) => {
      if (url !== '/kv') return { ok: false, json: async () => ({}) };
      if (options.method === 'PUT') {
        saved.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ schemaVersion: 2, profiles: [{ id: 'profile-default', name: '我的创作档案', platforms: ['douyin', 'kuaishou'] }] }) };
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  };
  vm.runInNewContext(fs.readFileSync(path.join(pluginDir, 'main.js'), 'utf8'), sandbox);
  const panelChannel = new TestBroadcastChannel('hot-topic-plugin');
  const panelResults = [];
  panelChannel.addEventListener('message', (event) => panelResults.push(event.data));
  panelChannel.postMessage({ type: 'panel-request', reqId: 'pick-test-1', method: 'pick_media_crawler', params: {} });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(pickerCalls, 1, JSON.stringify(panelResults));
  assert.equal(saved.length, 1, JSON.stringify(panelResults));
  assert.equal(saved[0].crawlerRoot, '/picked/MediaCrawler');
  const result = panelResults.find((message) => message.type === 'panel-result' && message.reqId === 'pick-test-1');
  assert.equal(result.ok, true);
  assert.equal(result.result.state.crawlerRoot, '/picked/MediaCrawler');
});

test('worker stdio implements JSON-RPC ids, errors, and multiple requests', () => {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'worker.cjs')], {
    input: [
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'load_hot_topic_fixture', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 'bad-method', method: 'not_real', params: {} }),
    ].join('\n') + '\n',
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(replies.length, 2);
  assert.equal(replies[0].id, 7);
  assert.equal(replies[0].result.items.length, 5);
  assert.equal(replies[1].id, 'bad-method');
  assert.equal(replies[1].error.errorCode, 'METHOD_NOT_FOUND');
  assert.equal(replies[1].error.code, -32601);
});
