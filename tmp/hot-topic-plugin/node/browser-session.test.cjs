'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { openSession, readEndpoint, acquireLock } = require('./browser-session.cjs');
const worker = require('./worker.cjs');
const collector = require('./crawler-adapter.cjs');

test('eligibility is mandatory regardless of weights, counts actual likes and ignores author keywords', () => {
  const config = { niche: '校园剧情', audience: '年轻人', includeKeywords: ['反转', '同桌'], topN: 50,
    rankingWeights: { engagement: 1, audienceMatch: 0, keywordRelevance: 0 } };
  const result = worker.rankHotTopics({ timeRange: 'all', ...config, videos: [
    { id: 'pass', title: '教室里的同桌反转', likes: '1万', collects: null },
    { id: 'low', title: '教室里的同桌反转', likes: 9999 },
    { id: 'missing', title: '教室里的同桌反转' },
    { id: 'irrelevant', title: '反转美食挑战', author: '同桌校园', likes: 1000000 },
    { id: 'single', title: '校园同桌日常', likes: 100000 },
  ] });
  assert.deepEqual(result.items.map(x => x.id), ['pass']);
  assert.equal(result.items[0].collects, null);
  assert.equal(result.filteredCount, 4);
  assert.deepEqual(result.filteredByReason, { likes: 2, niche: 1, keywords: 2 });
  assert.deepEqual(result.items[0].qualification.keywordHits, ['反转', '同桌']);
  assert.equal(worker.rankHotTopics({ timeRange: 'all', ...config, videos: [{ title: '美食', likes: 9000000 }] }).total, 0);
  assert.equal(worker.qualifyVideo({ title: '校园同桌', text: '', likes: 10000 }, { ...config, includeKeywords: ['同桌', '同桌'] }).passed, false);
});

test('consecutive searches reuse one owned browser across session handles and serialize requests', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-session-test-'));
  let launches = 0;
  const deps = {
    ownsBrowser: () => true,
    readEndpoint: () => ({ port: 43210, wsUrl: 'ws://127.0.0.1:43210/devtools/browser/test' }),
    spawn: (_command, args) => {
      launches++;
      assert.ok(args.includes('--remote-debugging-port=0'));
      assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
      assert.ok(!args.includes('--no-sandbox'));
      const child = new EventEmitter();
      return Object.assign(child, { pid: process.pid, exitCode: null, signalCode: null, unref() {}, kill() {} });
    },
  };
  const options = { baseDir, scope: '/fake/plugin', chromePath: '/fake/chrome', platform: 'douyin', signal: new AbortController().signal, deps };
  try {
    const first = await openSession(options);
    assert.equal(first.reused, false);
    await assert.rejects(openSession(options), { code: 'COLLECTOR_BUSY' });
    first.release();
    const second = await openSession(options);
    assert.equal(second.reused, true);
    second.release();
    assert.equal(launches, 1);
    await assert.rejects(openSession({ ...options, deps: { ...deps, ownsBrowser: () => false } }), { code: 'BROWSER_STATE_INVALID' });
    assert.equal(launches, 1);
    await assert.rejects(openSession({ ...options, deps: { ...deps, readEndpoint: () => ({ port: 43211, wsUrl: 'ws://127.0.0.1:43211/devtools/browser/other' }) } }), { code: 'BROWSER_STATE_INVALID' });
    const sessionRoot = path.join(baseDir, fs.readdirSync(baseDir)[0]);
    const stateFile = path.join(sessionRoot, 'browser.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, pid: 2147483647 }));
    const reopened = await openSession({ ...options, deps: { ...deps, ownsBrowser: () => false } });
    assert.equal(reopened.reused, false);
    reopened.release();
    assert.equal(launches, 2);
    fs.writeFileSync(stateFile, 'bad json');
    await assert.rejects(openSession(options), { code: 'BROWSER_STATE_INVALID' });
    assert.equal(launches, 2);
  } finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
});

test('invalid debug endpoint and symlink are rejected; cancelled startup releases lock', async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-session-errors-'));
  try {
    fs.writeFileSync(path.join(baseDir, 'DevToolsActivePort'), '9222\nws://outside.example');
    assert.equal(readEndpoint(baseDir), null);
    fs.writeFileSync(path.join(baseDir, 'DevToolsActivePort'), '43210\n/devtools/browser/test');
    assert.equal(readEndpoint(baseDir).port, 43210);
    fs.renameSync(path.join(baseDir, 'DevToolsActivePort'), path.join(baseDir, 'port-data'));
    fs.symlinkSync(path.join(baseDir, 'port-data'), path.join(baseDir, 'DevToolsActivePort'));
    assert.equal(readEndpoint(baseDir), null);
    const release = acquireLock(baseDir);
    assert.throws(() => acquireLock(baseDir), { code: 'COLLECTOR_BUSY' });
    release();
    const controller = new AbortController(); controller.abort();
    const args = { baseDir, platform: 'douyin', chromePath: '/fake/chrome', signal: controller.signal };
    await assert.rejects(openSession(args), { code: 'COLLECTOR_CANCELLED' });
    await assert.rejects(openSession(args), { code: 'COLLECTOR_CANCELLED' });
  } finally { fs.rmSync(baseDir, { recursive: true, force: true }); }
});

test('source adaptation connects the owned endpoint and preserves browser on cleanup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-source-test-'));
  try {
    fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'config/base_config.py'), 'CDP_CONNECT_EXISTING = False\nCDP_DEBUG_PORT = 9222\nENABLE_CDP_MODE = True\nCUSTOM_BROWSER_PATH = ""\n');
    fs.writeFileSync(path.join(root, 'tools/browser_launcher.py'), '"--remote-debugging-address=0.0.0.0"\n"--no-sandbox"\n            self.browser_process = process\n            return process\n');
    fs.writeFileSync(path.join(root, 'tools/cdp_browser.py'), '    async def _connect_via_cdp(self, playwright: Playwright):\n        pass\n    async def cleanup(self, force: bool = False):\n        await self.browser_context.close()\n');
    collector.patchIsolatedSource(root, '/fake/chrome', { port: 43210, wsUrl: 'ws://127.0.0.1:43210/devtools/browser/test' });
    const config = fs.readFileSync(path.join(root, 'config/base_config.py'), 'utf8');
    const manager = fs.readFileSync(path.join(root, 'tools/cdp_browser.py'), 'utf8');
    assert.match(config, /CDP_CONNECT_EXISTING = True/);
    assert.match(config, /CDP_DEBUG_PORT = 43210/);
    assert.match(manager, /connect_over_cdp\(__import__\("os"\).environ.get\("CINDY_BROWSER_WS", "ws:\/\/127.0.0.1:43210\/devtools\/browser\/test"\)/);
    assert.match(manager, /self.browser = None\n            return\n/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
