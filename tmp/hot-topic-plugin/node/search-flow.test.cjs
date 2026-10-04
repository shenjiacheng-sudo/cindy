'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { runPhases, createDecisionMonitor, patchFlow } = require('./search-flow.cjs');
const { patchSearchLimit, parseSearchJsonl } = require('./crawler-adapter.cjs');
const { openSession } = require('./browser-session.cjs');
const worker = require('./worker.cjs');
const collector = require('./crawler-adapter.cjs');

function fakeSession(events, headless = true) {
  return { headless, async setHeadless(value) {
    events.push(value ? 'background' : 'visible'); return fakeSession(events, value);
  }, async close() { events.push('close'); } };
}

test('logged-in searches stay background; expired login shows once then closes before collection', async () => {
  const events = [];
  const signal = new AbortController().signal;
  await runPhases({ loginGraceMs: 0, session: fakeSession(events), signal, run: async (phase) => { events.push(phase); return 'complete'; } });
  assert.deepEqual(events, ['collect']);
  events.length = 0;
  const statuses = ['login-required', 'logged-in', 'complete'];
  await runPhases({ loginGraceMs: 0, session: fakeSession(events), signal, run: async (phase, session) => {
    events.push(phase); assert.equal(session.headless, phase !== 'login'); return statuses.shift();
  } });
  assert.deepEqual(events, ['collect', 'visible', 'login', 'background', 'collect']);
});

test('empty collection retries at most twice without reopening login', async () => {
  const events = [];
  const signal = new AbortController().signal;
  let attempts = 0;
  await runPhases({ loginGraceMs: 0, session: fakeSession(events), signal, run: async (phase) => {
    events.push(phase);
    attempts += 1;
    return attempts < 3 ? 'retry-collect' : 'complete';
  } });
  assert.equal(attempts, 3);
  assert.deepEqual(events, ['collect', 'collect', 'collect']);
});

test('retry status does not exceed two additional collection attempts', async () => {
  const events = [];
  const signal = new AbortController().signal;
  await runPhases({ loginGraceMs: 0, session: fakeSession(events), signal, run: async (phase) => {
    events.push(phase);
    return 'retry-collect';
  } });
  assert.equal(events.length, 3);
  assert.deepEqual(events, ['collect', 'collect', 'collect']);
});

test('login failures and cancellation close the only visible window; failed reuse never loops login', async () => {
  for (const mode of ['failed', 'cancelled', 'expired']) {
    const events = [], controller = new AbortController();
    let calls = 0;
    await assert.rejects(runPhases({ loginGraceMs: 0, session: fakeSession(events), signal: controller.signal,
      run: async (phase) => {
        calls++;
        if (phase === 'collect') return 'login-required';
        if (mode === 'cancelled') { controller.abort(); throw new Error('cancelled'); }
        return mode === 'failed' ? 'complete' : 'logged-in';
      },
    }));
    assert.equal(events.filter(x => x === 'visible').length, 1);
    if (mode !== 'expired') assert.equal(events.at(-1), 'close');
    assert.equal(calls, mode === 'expired' ? 3 : 2);
  }
});

test('browser mode changes serialize Chrome and preserve the same native profile and lock', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-mode-test-'));
  let live = false;
  const launches = [];
  const deps = {
    ownsBrowser: () => live,
    readEndpoint: () => ({ port: 12345, wsUrl: 'ws://127.0.0.1:12345/devtools/browser/mock' }),
    stopBrowser: async () => { assert.equal(live, true); live = false; },
    spawn: (_exe, args) => {
      assert.equal(live, false); live = true; launches.push(args);
      return Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null, signalCode: null, unref() {}, kill() { live = false; } });
    },
  };
  const options = { baseDir, scope: '/fake/test', chromePath: '/fake/chrome', platform: 'douyin', signal: new AbortController().signal, deps };
  try {
    let session = await openSession(options);
    const profile = launches[0].find(x => x.startsWith('--user-data-dir=')).split('=')[1];
    fs.writeFileSync(path.join(profile, 'fake-native-state'), 'not-a-cookie');
    session = await session.setHeadless(false);
    assert.equal(session.headless, false);
    await assert.rejects(openSession(options), { code: 'COLLECTOR_BUSY' });
    session = await session.setHeadless(true);
    assert.equal(session.headless, true);
    assert.equal(fs.readFileSync(path.join(profile, 'fake-native-state'), 'utf8'), 'not-a-cookie');
    assert.deepEqual(launches.map(args => args.includes('--headless=new')), [true, false, true]);
    assert.equal(new Set(launches.map(args => args.find(x => x.startsWith('--user-data-dir=')))).size, 1);
    session.release();
    const next = await openSession(options); assert.equal(next.reused, true); next.release();
    assert.equal(launches.length, 3);
  } finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
});

for (const platform of ['douyin', 'kuaishou']) {
  test(platform + ' continues across keywords and stops at 10 qualifying unique videos after rejecting first candidates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-target-test-'));
    const dy = platform === 'douyin';
    const size = dy ? 'dy_limit_count' : 'ks_limit_count';
    const item = dy ? 'aweme_info' : 'video_detail';
    const store = dy ? 'douyin_store.update_douyin_aweme(aweme_item=aweme_info)' : 'kuaishou_store.update_kuaishou_video(video_item=video_detail)';
    const marker = dy ? 'aweme_list.append(aweme_info.get("aweme_id", ""))' : 'video_id_list.append(video_detail.get("photo", {}).get("id"))';
    const source = [
      'class C:',
      '    async def start(self):',
      '        if True:',
      '            self.context_page = await self.browser_context.new_page()',
      '            if False:',
      '                login_obj = ' + (dy ? 'DouYinLogin(' : 'KuaishouLogin('),
      '                )',
      '            crawler_type_var.set(config.CRAWLER_TYPE)',
      '            if True:',
      '                await self.search()',
      '    async def search(self):',
      '        ' + size + ' = 10',
      '        if config.CRAWLER_MAX_NOTES_COUNT < ' + size + ':',
      '            config.CRAWLER_MAX_NOTES_COUNT = ' + size,
      '        start_page = config.START_PAGE',
      '        for keyword in config.KEYWORDS.split(","):',
      '            page = 1',
      '            aweme_list = []; video_id_list = []',
      '            while (page - start_page + 1) * ' + size + ' <= config.CRAWLER_MAX_NOTES_COUNT:',
      '                for ' + item + ' in rows(keyword, page):',
      '                    ' + marker,
      '                    await ' + store,
      '                page += 1',
    ].join('\n');
    const profile = { platform, niche: '校园剧情', includeKeywords: ['同桌', '反转'], timeRange: 'all', topN: 10 };
    const readVideos = () => parseSearchJsonl(root, platform, 500);
    const monitor = createDecisionMonitor({ controlRoot: root, readVideos,
      shouldStop: videos => worker.rankHotTopics({ ...profile, videos }).total === 10 });
    try {
      fs.copyFileSync(path.join(__dirname, 'search-control.py'), path.join(root, 'search_control.py'));
      const runner = [
        'import asyncio, json, os',
        'from types import SimpleNamespace',
        patchFlow(patchSearchLimit(source, platform), platform),
        'config = SimpleNamespace(START_PAGE=1, CRAWLER_MAX_NOTES_COUNT=60, KEYWORDS="a,b,c")',
        'def rows(keyword, page):',
        '    result = []',
        '    for i in range(10):',
        '        identifier = keyword + str(page) + str(i)',
        '        if keyword == "b" and i == 0: identifier = "a10"',
        '        row = {"aweme_id": identifier, "video_id": identifier, "photo": {"id": identifier}, "title": "校园同桌反转", "liked_count": 100 if keyword == "a" else 10000}',
        '        result.extend([row, row])',
        '    return result',
        'async def save(**kwargs):',
        '    row = next(iter(kwargs.values()))',
        '    with open("search_contents_test.jsonl", "a") as f: f.write(json.dumps(row) + chr(10))',
        'douyin_store = SimpleNamespace(update_douyin_aweme=save)',
        'kuaishou_store = SimpleNamespace(update_kuaishou_video=save)',
        'asyncio.run(C().search())',
      ].join('\n');
      fs.writeFileSync(path.join(root, 'test.py'), runner);
      const child = spawn('python3', ['-B', 'test.py'], { cwd: root, env: { ...process.env, CINDY_SEARCH_CONTROL: root }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = ''; child.stderr.on('data', b => { stderr += b; });
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(code, 0, stderr);
      assert.equal(monitor.error, undefined);
      const result = worker.rankHotTopics({ ...profile, videos: readVideos() });
      assert.equal(result.total, 10);
      assert.equal(result.candidateCount, 30);
      assert.equal(new Set(result.items.map(x => x.id)).size, 10);
      assert.equal(result.items.every(x => x.likes >= 10000), true);
      assert.equal(monitor.stopped, true);
    } finally { monitor.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('worker targets qualifying results rather than candidate count and explicitly reports shortfall', async () => {
  const original = collector.collectMediaCrawler;
  const params = { collect: true, platform: 'douyin', niche: '校园剧情', includeKeywords: ['同桌', '反转'], topN: 10, timeRange: 'all' };
  const good = Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: '校园同桌反转', likes: 10000 }));
  try {
    collector.collectMediaCrawler = async ({ maxItems, shouldStop }) => {
      assert.equal(maxItems, 500);
      assert.equal(shouldStop(good.slice(0, 9)), false);
      assert.equal(shouldStop([...good.slice(0, 9), good[0]]), false);
      assert.equal(shouldStop(good.map(x => ({ ...x, likes: 9999 }))), false);
      assert.equal(shouldStop(good), true);
      return { videos: good, platform: 'douyin', endReason: 'target-reached' };
    };
    const complete = await worker.handleRequestAsync({ method: 'rank_hot_topics', params });
    assert.equal(complete.total, 10); assert.equal(complete.shortfall, 0);
    for (const reason of ['search-ended', 'candidate-limit', 'time-limit', 'collector-error']) {
      collector.collectMediaCrawler = async () => ({ videos: good.slice(0, 3), platform: 'douyin', endReason: reason });
      const partial = await worker.handleRequestAsync({ method: 'rank_hot_topics', params });
      assert.equal(partial.total, 3); assert.equal(partial.shortfall, 7);
      assert.equal(partial.collectionEndReason, reason); assert.match(partial.completionMessage, /还差 7 条/);
    }
  } finally { collector.collectMediaCrawler = original; }
});

test('login phase without a successful status is treated as a timeout/failure', async () => {
  const events = [];
  await assert.rejects(runPhases({ loginGraceMs: 0,
    session: fakeSession(events),
    signal: new AbortController().signal,
    run: async (phase) => {
      events.push(phase);
      if (phase === 'collect') return 'login-required';
      return 'login-failed';
    },
  }), { code: 'LOGIN_INCOMPLETE' });
  assert.deepEqual(events, ['collect', 'visible', 'login', 'close']);
  assert.equal(events.includes('background'), false);
});
