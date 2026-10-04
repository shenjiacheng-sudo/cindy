const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const browserSession = require('./browser-session.cjs');
const { patchSearchFlow, runPhases, createDecisionMonitor } = require('./search-flow.cjs');

const MAX_KEYWORDS = 3;
const MAX_JSONL_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_RESULT_ROWS = 500;
const MAX_RUNTIME_MS = 12 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 90 * 1000;
const COLLECT_RETRY_LIMIT = 2;
const COLLECT_RETRY_MIN_MS = 1500;
const COLLECT_RETRY_MAX_MS = 4500;
const SUPPORTED_PLATFORMS = new Set(['douyin', 'kuaishou']);
const ACTIVE_CHILDREN = new Set();
const ACTIVE_RUNS = new Set();
const SAFE_JSON_FIELDS = [
  'aweme_id', 'video_id', 'title', 'desc', 'text', 'nickname', 'author',
  'aweme_url', 'video_url', 'liked_count', 'collected_count', 'comment_count',
  'publish_time', 'create_time', 'followers', 'follower_count', 'fans_count', 'author_follower_count', 'user_fans', 'author_info', 'user_info',
];

class CollectorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectorError';
    this.code = code;
  }
}

function collectorError(code, message) {
  return new CollectorError(code, message);
}

function platformCode(platform) {
  if (platform === 'douyin') return 'dy';
  if (platform === 'kuaishou') return 'ks';
  throw collectorError('UNSUPPORTED_PLATFORM', '本机试用版仅支持抖音或快手。');
}

function normalizeKeywords(profile) {
  const supplied = Array.isArray(profile && profile.includeKeywords)
    ? profile.includeKeywords
    : [];
  const raw = supplied.length ? supplied : String(profile && profile.niche || '').split(/[,，、\n]+/);
  const keywords = [...new Set(raw
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item && item.length <= 60 && !/[\r\n,，]/.test(item)))].slice(0, MAX_KEYWORDS);
  if (!keywords.length) throw collectorError('KEYWORDS_REQUIRED', '请填写 1–3 个关键词，或先填写赛道。');
  return keywords;
}

function validateGitTree(root) {
  const tree = spawnSync('git', ['-C', root, 'ls-tree', '-r', '-z', 'HEAD'], {
    timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (tree.error || tree.status !== 0 || !Buffer.isBuffer(tree.stdout)) {
    throw collectorError('COLLECTOR_TREE_INVALID', '无法确认 MediaCrawler 源码清单。');
  }
  const entries = tree.stdout.toString('utf8').split('\0').filter(Boolean);
  if (entries.length < 1 || entries.length > 5000) {
    throw collectorError('COLLECTOR_TREE_INVALID', 'MediaCrawler 源码文件数量不符合本机试用版限制。');
  }
  for (const entry of entries) {
    const separator = entry.indexOf('\t');
    if (separator < 0) throw collectorError('COLLECTOR_TREE_INVALID', 'MediaCrawler 源码清单格式无效。');
    const mode = entry.slice(0, separator).split(' ')[0];
    const relativePath = entry.slice(separator + 1);
    if (mode !== '100644' && mode !== '100755') {
      throw collectorError('COLLECTOR_TREE_UNSAFE', 'MediaCrawler 源码包含链接或特殊文件，已停止导出。');
    }
    if (/(^|\/)(browser_data|mediacrawler_data)(\/|$)|\.(jsonl|sqlite3?|db|pem|p12|pfx|key)$/i.test(relativePath)
      || /(^|\/)(cookies?|[^/]*cookie[^/]*|credentials?[^/]*|auth[^/]*|tokens?[^/]*)\.(json|txt|sqlite3?|db)$/i.test(relativePath)) {
      throw collectorError('COLLECTOR_TREE_UNSAFE', 'MediaCrawler 仓库 HEAD 包含本机数据或登录资料文件，已停止导出。');
    }
  }
}

function validateMediaCrawlerRoot(crawlerRoot) {
  if (typeof crawlerRoot !== 'string' || !crawlerRoot.trim()) {
    throw collectorError('COLLECTOR_NOT_CONFIGURED', '请先在插件面板选择本机 MediaCrawler 项目目录。');
  }
  if (process.platform !== 'darwin') {
    throw collectorError('UNSUPPORTED_SYSTEM', '当前本机体验版仅在 macOS 上验证。');
  }

  let root;
  try {
    root = fs.realpathSync(path.resolve(crawlerRoot));
    if (!fs.statSync(root).isDirectory()) throw new Error('not directory');
  } catch {
    throw collectorError('COLLECTOR_PATH_INVALID', '选择的目录不可访问；请重新选择 MediaCrawler 项目目录。');
  }

  const gitRoot = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (gitRoot.error || gitRoot.status !== 0 || !gitRoot.stdout) {
    throw collectorError('COLLECTOR_ROOT_INVALID', '所选目录不是可用的 MediaCrawler Git 仓库。');
  }
  try {
    if (fs.realpathSync(gitRoot.stdout.trim()) !== root) {
      throw collectorError('COLLECTOR_ROOT_INVALID', '请直接选择 MediaCrawler 仓库根目录。');
    }
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw collectorError('COLLECTOR_ROOT_INVALID', '请直接选择 MediaCrawler 仓库根目录。');
  }

  validateGitTree(root);
  if (!fs.existsSync(path.join(root, 'pyproject.toml')) || !fs.existsSync(path.join(root, 'LICENSE'))) {
    throw collectorError('COLLECTOR_ROOT_INVALID', '所选目录缺少 MediaCrawler 项目文件或许可证。');
  }
  const licenseText = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8').slice(0, 4096);
  if (!licenseText.includes('NON-COMMERCIAL LEARNING LICENSE')) {
    throw collectorError('LICENSE_MISMATCH', '所选采集器的许可证与本机个人学习试用范围不匹配。');
  }
  const compatibility = checkMediaCrawlerCompatibility(root);
  const pythonPath = path.join(root, '.venv', 'bin', 'python');
  if (!fs.existsSync(pythonPath) || !fs.statSync(pythonPath).isFile()) {
    throw collectorError('PYTHON_ENV_MISSING', '没有找到已有的 MediaCrawler Python 环境；本插件不会自动安装依赖。');
  }

  const chromeCandidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ];
  const chromePath = chromeCandidates.find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.statSync(candidate).isFile();
    } catch { return false; }
  });
  if (!chromePath) throw collectorError('BROWSER_MISSING', '没有找到已安装的 Chrome；插件不会自动下载浏览器。');

  return { root, pythonPath, chromePath, version: compatibility.version };
}

function checkMediaCrawlerCompatibility(root) {
  let manifest;
  try { manifest = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'); }
  catch { throw collectorError('COLLECTOR_VERSION_UNSUPPORTED', '无法读取 MediaCrawler 的 pyproject.toml，无法确认兼容版本。'); }
  const versionMatch = manifest.match(/^version\s*=\s*["']([^"']+)["']/m);
  const version = versionMatch ? versionMatch[1].slice(0, 80) : 'unknown';
  const missing = [];
  for (const platform of ['douyin', 'kuaishou']) {
    const file = path.join(root, 'media_platform', platform, 'core.py');
    let source = '';
    try { source = fs.readFileSync(file, 'utf8'); } catch { missing.push(platform + '/core.py'); continue; }
    if (!source.includes('config.CRAWLER_MAX_NOTES_COUNT')) missing.push(platform + ':CRAWLER_MAX_NOTES_COUNT');
    if (!source.includes('await self.search()')) missing.push(platform + ':search');
  }
  if (missing.length) {
    throw collectorError(
      'COLLECTOR_VERSION_UNSUPPORTED',
      'MediaCrawler 版本 ' + version + ' 与当前适配不兼容；缺少 ' + missing.join('、') + '。请使用已验证的 MediaCrawler 版本。',
    );
  }
  return { version };
}

function buildCrawlerArgs({ platform, keywords, outputDir, maxItems = 10 }) {
  const safePlatform = platformCode(platform);
  if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > MAX_KEYWORDS) {
    throw collectorError('KEYWORDS_INVALID', '每次采集需要 1–3 个关键词。');
  }
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) {
    throw collectorError('OUTPUT_PATH_INVALID', '本次临时输出目录无效。');
  }
  const count = Number.isInteger(maxItems) ? Math.max(1, Math.min(MAX_RESULT_ROWS, maxItems)) : 10;
  if (keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim() || keyword.length > 60 || /[\r\n,，]/.test(keyword))) {
    throw collectorError('KEYWORDS_INVALID', '每个关键词最多 60 个字符，且不能包含逗号或换行。');
  }
  return [
    'main.py',
    '--platform', safePlatform,
    '--lt', 'qrcode',
    '--type', 'search',
    '--keywords', keywords.join(','),
    '--get_comment', 'false',
    '--get_sub_comment', 'false',
    '--get_media', 'false',
    '--headless', 'true',
    '--save_data_option', 'jsonl',
    '--save_data_path', outputDir,
    '--crawler_max_notes_count', String(count),
    '--max_concurrency_num', '1',
    '--enable_ip_proxy', 'false',
  ];
}

function replaceExactly(source, pattern, replacement, label) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) {
    throw collectorError('SOURCE_PATCH_UNSUPPORTED', `本机采集器版本与试用适配不匹配（${label}）；请停止并重新核对版本。`);
  }
  return source.replace(pattern, replacement);
}

function patchSearchLimit(source, platform) {
  const isDouyin = platform === 'douyin';
  const pageSize = isDouyin ? 'dy_limit_count' : 'ks_limit_count';
  source = replaceExactly(source,
    new RegExp('        if config\\.CRAWLER_MAX_NOTES_COUNT < ' + pageSize + ':\\n            config\\.CRAWLER_MAX_NOTES_COUNT = ' + pageSize + '\\n', 'g'),
    '', 'remove minimum page-size override');
  source = replaceExactly(source, /        start_page = config\.START_PAGE[^\n]*\n/g,
    '        start_page = config.START_PAGE\n        collected_ids = set()\n', 'global search budget');
  source = replaceExactly(source, /        for keyword in config\.KEYWORDS\.split\(","\):\n/g,
    '        for keyword in config.KEYWORDS.split(","):\n            if len(collected_ids) >= config.CRAWLER_MAX_NOTES_COUNT:\n                return\n', 'keyword budget');
  source = replaceExactly(source,
    isDouyin
      ? /            while \(page - start_page \+ 1\) \* dy_limit_count <= config\.CRAWLER_MAX_NOTES_COUNT:\n/g
      : /            while \(\s*page - start_page \+ 1\s*\) \* ks_limit_count <= config\.CRAWLER_MAX_NOTES_COUNT:\n/g,
    '            while len(collected_ids) < config.CRAWLER_MAX_NOTES_COUNT and (page - start_page) * ' + pageSize + ' < config.CRAWLER_MAX_NOTES_COUNT:\n', 'page budget');
  const marker = isDouyin
    ? '                    aweme_list.append(aweme_info.get("aweme_id", ""))'
    : '                    video_id_list.append(video_detail.get("photo", {}).get("id"))';
  const idExpression = isDouyin ? 'aweme_info.get("aweme_id")' : 'video_detail.get("photo", {}).get("id")';
  const budget = [
    '                    if len(collected_ids) >= config.CRAWLER_MAX_NOTES_COUNT:',
    '                        return',
    '                    video_id = ' + idExpression,
    '                    if video_id is None or str(video_id) == "" or str(video_id) in collected_ids:',
    '                        continue',
    '                    collected_ids.add(str(video_id))',
    marker,
  ].join('\n');
  if (source.split(marker).length !== 2) throw collectorError('SOURCE_PATCH_UNSUPPORTED', '采集器版本与数量限制适配不匹配，请停止并核对版本。');
  return source.replace(marker, budget);
}

function patchSearchLimits(sourceRoot) {
  for (const platform of ['douyin', 'kuaishou']) {
    const file = path.join(sourceRoot, 'media_platform', platform, 'core.py');
    const source = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, patchSearchLimit(source, platform), { mode: 0o600 });
  }
}

function patchIsolatedSource(sourceRoot, chromePath, session) {
  const configPath = path.join(sourceRoot, 'config', 'base_config.py');
  const browserPath = path.join(sourceRoot, 'tools', 'browser_launcher.py');
  let config = fs.readFileSync(configPath, 'utf8');
  const connectExisting = config.match(/^CDP_CONNECT_EXISTING\s*=\s*(True|False)\s*$/gm) || [];
  if (connectExisting.length !== 1) {
    throw collectorError('SOURCE_PATCH_UNSUPPORTED', '本机采集器的浏览器连接配置无法安全确认。');
  }
  if (connectExisting[0].includes('True')) {
    config = replaceExactly(config, /^CDP_CONNECT_EXISTING\s*=\s*True\s*$/m, 'CDP_CONNECT_EXISTING = False', 'browser isolation');
  }
  const escapedChromePath = chromePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const customBrowser = config.match(/^CUSTOM_BROWSER_PATH\s*=\s*".*"\s*$/gm) || [];
  if (customBrowser.length !== 1) {
    throw collectorError('SOURCE_PATCH_UNSUPPORTED', '本机采集器的浏览器路径配置无法安全确认。');
  }
  config = replaceExactly(config, /^CUSTOM_BROWSER_PATH\s*=\s*".*"\s*$/m, `CUSTOM_BROWSER_PATH = "${escapedChromePath}"`, 'browser path');
  fs.writeFileSync(configPath, config, { mode: 0o600 });

  let browser = fs.readFileSync(browserPath, 'utf8');
  browser = replaceExactly(browser, /--remote-debugging-address=0\.0\.0\.0/g, '--remote-debugging-address=127.0.0.1', 'local CDP binding');
  const sandboxLines = browser.split('\n').filter((line) => line.includes('"--no-sandbox"'));
  if (sandboxLines.length !== 1) {
    throw collectorError('SOURCE_PATCH_UNSUPPORTED', '无法确认浏览器沙箱参数，已停止启动。');
  }
  browser = browser.replace(/^.*"--no-sandbox".*\n/m, '');
  const trackedSpawnLine = [
    '            self.browser_process = process',
    '            if user_data_dir:',
    '                with open(os.path.join(user_data_dir, ".cindy-trial-browser-pid"), "w", encoding="utf-8") as pid_file:',
    '                    pid_file.write(str(process.pid))',
    '            return process',
  ].join('\n');
  browser = replaceExactly(browser, /            self\.browser_process = process\n            return process/, trackedSpawnLine, 'isolated browser cleanup');
  fs.writeFileSync(browserPath, browser, { mode: 0o600 });
  if (session) {
    const managerPath = path.join(sourceRoot, "tools", "cdp_browser.py");
    let manager = fs.readFileSync(managerPath, "utf8");
    config = replaceExactly(config, /^CDP_CONNECT_EXISTING\s*=\s*False\s*$/m, "CDP_CONNECT_EXISTING = True", "dedicated browser connection");
    config = replaceExactly(config, /^CDP_DEBUG_PORT\s*=\s*\d+\s*$/m, `CDP_DEBUG_PORT = ${session.port}`, "dedicated browser port");
    config = replaceExactly(config, /^ENABLE_CDP_MODE\s*=\s*(?:True|False)\s*$/m, "ENABLE_CDP_MODE = True", "CDP mode");
    manager = replaceExactly(manager, /    async def _connect_via_cdp\(self, playwright: Playwright\):\n/, [
      "    async def _connect_via_cdp(self, playwright: Playwright):",
      "        if config.CDP_CONNECT_EXISTING:",
      `            self.browser = await playwright.chromium.connect_over_cdp(${JSON.stringify(session.wsUrl)}, timeout=config.BROWSER_LAUNCH_TIMEOUT * 1000)`,
      "            return", "",
    ].join("\n"), "owned CDP endpoint");
    manager = replaceExactly(manager, /    async def cleanup\(self, force: bool = False\):\n/, [
      "    async def cleanup(self, force: bool = False):",
      "        if config.CDP_CONNECT_EXISTING:",
      "            self.browser_context = None",
      "            self.browser = None",
      "            return", "",
    ].join("\n"), "keep dedicated browser open");
    config += '\nimport os as _cindy_os\nCDP_DEBUG_PORT = int(_cindy_os.environ.get("CINDY_BROWSER_PORT", CDP_DEBUG_PORT))\n';
    manager = manager.replace(JSON.stringify(session.wsUrl), '__import__("os").environ.get("CINDY_BROWSER_WS", ' + JSON.stringify(session.wsUrl) + ')');
    fs.writeFileSync(configPath, config, { mode: 0o600 });
    fs.writeFileSync(managerPath, manager, { mode: 0o600 });
  }
}

function childIsRunning(child) {
  return Boolean(child && child.exitCode === null && child.signalCode === null);
}

function retryDelayMs() {
  return COLLECT_RETRY_MIN_MS + Math.floor(Math.random() * (COLLECT_RETRY_MAX_MS - COLLECT_RETRY_MIN_MS + 1));
}

function safeProcessMessage(value, priorityLines = []) {
  const sanitize = (input) => String(input || '')
    .replace(/https?:\/\/[^\s]+/gi, '[url]')
    .replace(/\/Users\/[^\s]+/g, '[path]')
    .replace(/\b(?:cookie|token|authorization|password|secret|session)\b[^\n]*/gi, '[redacted]')
    .replace(/(?:^|\s)(?:--?w*(?:cookie|token|password|secret)[^\s=]*)(?:=|\s+)\S+/gi, ' [redacted]');
  const sanitized = sanitize(value);
  const lines = sanitized.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const important = [...priorityLines, ...lines.filter((line) =>
    /CINDY_(?:HTTP|PAGE)_DIAG|Traceback|\b(?:Error|Exception)\b|is empty,None|aweme_list/i.test(line))]
    .map((line) => sanitize(line).trim()).filter(Boolean);
  const uniqueImportant = [...new Set(important)];
  const remainder = lines.filter((line) => !uniqueImportant.includes(line));
  // Keep compact API diagnostics first so later crawler chatter cannot evict status_msg.
  return [...uniqueImportant, ...remainder].join('\n').slice(0, 6000);
}

function runChild(command, args, options, signal, onSpawn, timeoutMs = MAX_RUNTIME_MS) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stopping = false;
    let timedOut = false;
    let stderr = '';
    let stderrScanBuffer = '';
    const priorityStderrLines = [];
    const paginationDiagnostics = [];
    let stdout = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (error && paginationDiagnostics.length && !error.paginationDiagnostics) {
        error.paginationDiagnostics = paginationDiagnostics.slice(0, 100);
      }
      if (error) reject(error);
      else resolve(value);
    };
    const scanStderrLine = (line) => {
      if (line.startsWith('CINDY_PAGE_DIAG ')) {
        try {
          const parsed = JSON.parse(line.slice('CINDY_PAGE_DIAG '.length));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && paginationDiagnostics.length < 100) {
            const record = {
              phase: options.env && options.env.CINDY_SEARCH_PHASE === 'login' ? 'login' : 'collect',
              keywordIndex: Number.isInteger(parsed.keywordIndex) && parsed.keywordIndex >= 1 && parsed.keywordIndex <= MAX_KEYWORDS ? parsed.keywordIndex : null,
              requestCursor: typeof parsed.requestCursor === 'string' ? parsed.requestCursor.slice(0, 80) : null,
              responseCursor: typeof parsed.responseCursor === 'string' ? parsed.responseCursor.slice(0, 80) : null,
              hasMore: typeof parsed.hasMore === 'boolean' ? parsed.hasMore : null,
              apiCode: typeof parsed.apiCode === 'string' ? parsed.apiCode.slice(0, 40) : null,
              dataCount: Number.isInteger(parsed.dataCount) && parsed.dataCount >= 0 ? Math.min(parsed.dataCount, 100000) : null,
              httpStatus: Number.isInteger(parsed.httpStatus) ? parsed.httpStatus : (parsed.httpStatus === 'exception' ? 'exception' : null),
              transport: ['httpx', 'aiohttp'].includes(parsed.transport) ? parsed.transport : null,
              path: typeof parsed.path === 'string' ? parsed.path.slice(0, 160) : null,
              queryKeys: Array.isArray(parsed.queryKeys) ? parsed.queryKeys.filter((v) => typeof v === 'string').slice(0, 40) : [],
              bodyKeys: Array.isArray(parsed.bodyKeys) ? parsed.bodyKeys.filter((v) => typeof v === 'string').slice(0, 40) : [],
            };
            if (typeof parsed.keyword === 'string') record.keyword = parsed.keyword.slice(0, 60);
            if (typeof parsed.responseError === 'string') record.responseError = parsed.responseError.slice(0, 80);
            paginationDiagnostics.push(record);
          }
        } catch { /* Ignore malformed metadata; never retain raw request or response data. */ }
      }
      if (/CINDY_HTTP_DIAG|CINDY_PAGE_DIAG|Traceback|\b(?:Error|Exception)\b|is empty,None|aweme_list/i.test(line)) {
        priorityStderrLines.push(line);
        if (priorityStderrLines.length > 130) priorityStderrLines.shift();
      }
    };
    const stop = async (reason) => {
      if (stopping || settled) return;
      stopping = true;
      if (childIsRunning(child) && !child.killed) {
        child.kill('SIGINT');
        await Promise.race([
          new Promise((done) => child.once('exit', done)),
          delay(6000),
        ]);
      }
      if (childIsRunning(child)) {
        if (options.detached && child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        } else child.kill('SIGTERM');
        await Promise.race([
          new Promise((done) => child.once('exit', done)),
          delay(1500),
        ]);
      }
      if (childIsRunning(child)) {
        if (options.detached && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
      }
      finish(reason);
    };
    const onAbort = () => { void stop(collectorError('COLLECTOR_CANCELLED', '本次采集已取消，正在清理临时文件。')); };
    const timeout = setTimeout(() => {
      timedOut = true;
      void stop(collectorError('COLLECTOR_TIMEOUT', '本次采集超过 12 分钟，已停止并清理临时文件。'));
    }, timeoutMs);

    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      child = spawn(command, args, options);
      ACTIVE_CHILDREN.add(child);
      if (typeof onSpawn === 'function') onSpawn(child);
      child.once('error', () => {
        ACTIVE_CHILDREN.delete(child);
        finish(collectorError('COLLECTOR_START_FAILED', '无法启动本机采集环境；请检查 Python 环境与权限。'));
      });
      if (child.stderr) child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        stderr = (stderr + text).slice(-12000);
        stderrScanBuffer += text;
        const completeLines = stderrScanBuffer.split(/\r?\n/);
        stderrScanBuffer = completeLines.pop() || '';
        for (const line of completeLines) scanStderrLine(line);
      });
      if (child.stdout) child.stdout.on('data', (chunk) => {
        stdout = (stdout + chunk.toString('utf8')).slice(-2400);
      });
      child.once('exit', (code, signalName) => {
        ACTIVE_CHILDREN.delete(child);
        if (settled || stopping) return;
        if (stderrScanBuffer) scanStderrLine(stderrScanBuffer);
        if (code === 0) finish(null, {
          code,
          signal: signalName,
          stdout: safeProcessMessage(stdout),
          stderr: safeProcessMessage(stderr, [...priorityStderrLines, stderrScanBuffer]),
          paginationDiagnostics,
        });
        else finish(collectorError(
          timedOut ? 'COLLECTOR_TIMEOUT' : 'COLLECTOR_EXITED',
          safeProcessMessage(stderr, [...priorityStderrLines, stderrScanBuffer]) || '本机采集未正常完成；请检查独立浏览器登录页面后重试。',
        ));
      });
    } catch {
      finish(collectorError('COLLECTOR_START_FAILED', '无法启动本机采集环境；请检查 Python 环境与权限。'));
    }
  });
}

async function archiveHead(sourceRoot, targetRoot, signal) {
  const result = await new Promise((resolve, reject) => {
    const git = spawn('git', [
      '-C', sourceRoot, 'archive', '--format=tar', 'HEAD', '--', '.',
      ':(exclude).env*', ':(exclude)**/.env*',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    const tar = spawn('tar', ['-xf', '-', '-C', targetRoot], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    ACTIVE_CHILDREN.add(git);
    ACTIVE_CHILDREN.add(tar);
    let gitCode = null;
    let tarCode = null;
    let archiveBytes = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(collectorError('SOURCE_ARCHIVE_TIMEOUT', '准备本机采集副本超时，已停止。')), 60000);
    const finish = (error) => {
      if (settled) return;
      if (error) {
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        git.kill('SIGKILL');
        tar.kill('SIGKILL');
        reject(error);
        return;
      }
      if (gitCode !== null && tarCode !== null) {
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        if (gitCode === 0 && tarCode === 0) resolve();
        else reject(collectorError('SOURCE_ARCHIVE_FAILED', '无法准备本次隔离的采集器副本。'));
      }
    };
    const onAbort = () => finish(collectorError('COLLECTOR_CANCELLED', '本次采集已取消。'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    git.once('error', () => { ACTIVE_CHILDREN.delete(git); finish(collectorError('SOURCE_ARCHIVE_FAILED', '无法准备本次隔离的采集器副本。')); });
    tar.once('error', () => { ACTIVE_CHILDREN.delete(tar); finish(collectorError('SOURCE_ARCHIVE_FAILED', '无法准备本次隔离的采集器副本。')); });
    git.once('exit', (code) => { ACTIVE_CHILDREN.delete(git); gitCode = code; finish(); });
    tar.once('exit', (code) => { ACTIVE_CHILDREN.delete(tar); tarCode = code; finish(); });
    git.stdout.on('data', (chunk) => {
      archiveBytes += chunk.length;
      if (archiveBytes > MAX_SOURCE_ARCHIVE_BYTES) {
        finish(collectorError('SOURCE_ARCHIVE_TOO_LARGE', 'MediaCrawler 源码副本超过本机试用版大小限制。'));
      }
    });
    git.stdout.pipe(tar.stdin);
  });
  return result;
}

function findSearchFiles(root) {
  const files = [];
  const queue = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < 1000) {
    const current = queue.shift();
    visited += 1;
    let entries;
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 8) queue.push({ dir: fullPath, depth: current.depth + 1 });
      else if (entry.isFile() && /\.(jsonl|json)$/i.test(entry.name)) files.push(fullPath);
    }
  }
  return files.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

function safeJsonRecord(value, platform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = { platform };
  for (const field of SAFE_JSON_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
    const entry = value[field];
    if (typeof entry === 'string') result[field] = entry.slice(0, field === 'desc' || field === 'text' ? 6000 : 2048);
    else if (typeof entry === 'number' && Number.isFinite(entry)) result[field] = entry;
  }
  for (const containerKey of ['author', 'author_info', 'user', 'user_info']) {
    const container = value[containerKey];
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const field of ['followers', 'follower_count', 'fans_count', 'author_follower_count', 'user_fans']) {
      if (result[field] !== undefined || container[field] === undefined) continue;
      const entry = container[field];
      if ((typeof entry === 'string' && entry.length <= 2048) || (typeof entry === 'number' && Number.isFinite(entry))) result[field] = entry;
    }
  }
  result.platform = platform;
  return result;
}

function parseSearchJsonl(outputRoot, platform, maxItems = 10) {
  const files = findSearchFiles(outputRoot);
  if (!files.length) throw collectorError('COLLECTOR_NO_DATA', '采集完成但没有找到关键词搜索结果。');
  const rows = [];
  const seen = new Set();
  const rowLimit = Number.isInteger(maxItems) ? Math.max(1, Math.min(MAX_RESULT_ROWS, maxItems)) : 10;
  let totalBytes = 0;
  for (const file of files) {
    let size;
    try { size = fs.statSync(file).size; } catch { continue; }
    totalBytes += size;
    if (totalBytes > MAX_JSONL_BYTES) throw collectorError('COLLECTOR_OUTPUT_TOO_LARGE', '采集结果超过本机试用版大小限制，已停止读取。');
    const text = fs.readFileSync(file, 'utf8');
    let records;
    try {
      const trimmed = text.trim();
      const parsed = /\.json$/i.test(file) || trimmed.startsWith('[') || trimmed.startsWith('{')
        ? JSON.parse(trimmed)
        : null;
      records = parsed === null ? text.split(/\r?\n/) : (Array.isArray(parsed) ? parsed : [parsed]);
    } catch {
      records = text.split(/\r?\n/);
    }
    for (const entry of records) {
      if (rows.length >= rowLimit) return rows;
      if (entry === null || entry === undefined || (typeof entry === 'string' && !entry.trim())) continue;
      try {
        const row = safeJsonRecord(typeof entry === 'string' ? JSON.parse(entry) : entry, platform);
        if (row) {
          const id = platform === 'douyin' ? row.aweme_id : row.video_id;
          const key = id === undefined || id === null || id === '' ? null : String(id);
          if (key && seen.has(key)) continue;
          if (key) seen.add(key);
          rows.push(row);
        }
      } catch {
        // Malformed lines are ignored; raw source data is never returned.
      }
    }
  }
  return rows;
}

function summarizeEmptyResponses(paginationDiagnostics) {
  const rows = Array.isArray(paginationDiagnostics) ? paginationDiagnostics : [];
  const empty = rows.filter((row) => row && row.dataCount === 0 && row.hasMore === false);
  return {
    count: empty.length,
    keywords: [...new Set(empty.map((row) => typeof row.keyword === 'string' ? row.keyword : '').filter(Boolean))].slice(0, 10),
    paths: [...new Set(empty.map((row) => typeof row.path === 'string' ? row.path : '').filter(Boolean))].slice(0, 10),
    allPagesEmpty: rows.length > 0 && rows.every((row) => row && row.dataCount === 0),
  };
}

function browserPidFiles(sourceRoot) {
  const files = [];
  const queue = [{ dir: path.join(sourceRoot, 'browser_data'), depth: 0 }];
  while (queue.length && files.length < 32) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 4) queue.push({ dir: fullPath, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name === '.cindy-trial-browser-pid') files.push(fullPath);
    }
  }
  return files;
}

function browserProcessGroups(sourceRoot) {
  const groups = new Set();
  for (const file of browserPidFiles(sourceRoot)) {
    try {
      const pid = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 1 && pid !== process.pid) groups.add(pid);
    } catch { /* Incomplete pid files are ignored. */ }
  }
  return groups;
}

function killBrowserForSourceSync(sourceRoot, signal = 'SIGKILL') {
  for (const group of browserProcessGroups(sourceRoot)) {
    try { process.kill(-group, signal); } catch { /* Browser group already exited. */ }
  }
}

async function stopBrowserForSource(sourceRoot) {
  const groups = browserProcessGroups(sourceRoot);
  for (const group of groups) {
    try { process.kill(-group, 'SIGTERM'); } catch { /* Browser group already exited. */ }
  }
  if (groups.size) await delay(300);
  for (const group of groups) {
    try { process.kill(-group, 'SIGKILL'); } catch { /* Browser group already exited. */ }
  }
}

function abortAll() {
  for (const run of ACTIVE_RUNS) killBrowserForSourceSync(run.sourceRoot, 'SIGKILL');
  for (const child of ACTIVE_CHILDREN) {
    const run = [...ACTIVE_RUNS].find((entry) => entry.child === child);
    if (run && child.pid && childIsRunning(child)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    } else {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
  for (const run of ACTIVE_RUNS) {
    try { fs.rmSync(run.tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch { /* Best effort during process shutdown. */ }
  }
}

function installSearchResponseDiagnostics(sourceRoot) {
  const script = [
    '"""Safe temporary diagnostics for Douyin search response metadata."""',
    'import json as _json',
    'import hashlib as _hashlib',
    'import os as _os',
    'import re as _re',
    'import sys as _sys',
    'from urllib.parse import parse_qs as _parse_qs, urlsplit as _urlsplit',
    '_keywords = _json.loads(_os.environ.get("CINDY_SEARCH_KEYWORDS", "[]"))',
    'def _cursor(_value):',
    '    if _value is None: return None',
    '    if isinstance(_value, bool): return str(int(_value))',
    '    if isinstance(_value, (int, float)) and _value == int(_value): return str(int(_value))[:80]',
    '    _text = str(_value).strip()',
    '    if not _text: return None',
    '    if _re.fullmatch(r"-?\\d{1,20}", _text): return _text',
    '    return "sha256:" + _hashlib.sha256(_text.encode("utf-8", "replace")).hexdigest()[:12]',
    'def _request_meta(_url, _request=None, _request_body=None):',
    '    _values = {}',
    '    try:',
    '        for _key, _items in _parse_qs(_urlsplit(str(_url)).query, keep_blank_values=True).items():',
    '            if _items: _values[_key] = _items[-1]',
    '    except Exception: pass',
    '    if _request is not None:',
    '        try: _request_body = _request.content',
    '        except Exception: pass',
    '    if isinstance(_request_body, (bytes, bytearray)): _request_body = bytes(_request_body).decode("utf-8", "replace")',
    '    if isinstance(_request_body, str):',
    '        try: _request_body = _json.loads(_request_body)',
    '        except Exception: _request_body = None',
    '    if isinstance(_request_body, dict):',
    '        for _key, _value in _request_body.items():',
    '            if isinstance(_value, (str, int, float, bool)) and _key not in _values: _values[_key] = _value',
    '    _keyword = next((_values.get(_key) for _key in ("keyword", "search_keyword", "searchKeyword", "q") if isinstance(_values.get(_key), str) and _values.get(_key).strip()), None)',
    '    _cursor_value = next((_values.get(_key) for _key in ("cursor", "max_cursor", "search_cursor", "offset") if _values.get(_key) is not None), None)',
    '    return _keyword, _cursor(_cursor_value)',
    'def _emit(_transport, _url, _status, _headers, _body=None, _error=None, _request=None, _request_body=None):',
    '    try:',
    '        _host = getattr(_url, "host", "") or ""',
    '        _path = getattr(_url, "path", "") or ""',
    '        if "douyin" not in _host.lower() and "aweme" not in _path.lower(): return',
    '        if "search" not in _path.lower(): return',
    '        _info = {"transport": _transport, "host": _host[:100], "path": _path[:160], "httpStatus": _status, "contentType": str(_headers.get("content-type", ""))[:80]}',
    '        if _error: _info["responseError"] = _error[:80]',
    '        _keyword, _request_cursor = _request_meta(_url, _request, _request_body)',
    '        _keyword_index = next((i + 1 for i, _item in enumerate(_keywords[:3]) if isinstance(_item, str) and _item.strip().casefold() == str(_keyword or "").strip().casefold()), None)',
    '        if _keyword_index is None and len(_keywords) == 1: _keyword_index = 1',
    '        _page = {"transport": _transport, "keywordIndex": _keyword_index, "requestCursor": _request_cursor, "responseCursor": None, "hasMore": None, "apiCode": None, "dataCount": None, "httpStatus": _status if isinstance(_status, int) else "exception", "path": _path[:160], "queryKeys": sorted(_parse_qs(_urlsplit(str(_url)).query, keep_blank_values=True).keys())[:40], "bodyKeys": []}',
    '        if _keyword_index and len(_keywords) >= _keyword_index: _page["keyword"] = str(_keywords[_keyword_index - 1])[:60]',
    '        if _error: _page["responseError"] = _error[:80]',
    '        if _body is not None:',
    '            try:',
    '                _obj = _json.loads(_body.decode("utf-8", "replace"))',
    '                if isinstance(_obj, dict):',
    '                    _info["topLevelKeys"] = sorted(str(_k)[:40] for _k in _obj.keys())[:20]',
    '                    for _key in ("status_code", "statusCode", "code", "error_code"):',
    '                        if isinstance(_obj.get(_key), (int, float, str)): _info["apiCode"] = str(_obj[_key])[:60]; break',
    '                    if _info.get("apiCode") is not None: _page["apiCode"] = _info["apiCode"][:40]',
    '                    for _key in ("status_msg", "message", "msg"):',
    '                        if isinstance(_obj.get(_key), str):',
    '                            _message = _obj[_key][:160].replace("\\n", " ")',
    '                            _info["apiMessage"] = _message',
    '                            if _info.get("apiCode") == "2483" and "请先登录" in _message and _os.environ.get("CINDY_SEARCH_PHASE") == "collect":',
    '                                _status_file = _os.environ.get("CINDY_SEARCH_STATUS")',
    '                                if _status_file:',
    '                                    with open(_status_file, "w", encoding="utf-8") as _status_stream: _status_stream.write("login-required")',
    '                            break',
    '                    _data = _obj.get("data")',
    '                    _info["dataType"] = type(_data).__name__',
    '                    _items = _data if isinstance(_data, list) else next((_data.get(_key) for _key in ("data", "items", "aweme_list", "list") if isinstance(_data, dict) and isinstance(_data.get(_key), list)), None)',
    '                    if isinstance(_items, list): _info["dataCount"] = len(_items); _page["dataCount"] = len(_items)',
    '                    elif isinstance(_data, dict): _info["dataKeys"] = sorted(str(_k)[:40] for _k in _data.keys())[:20]',
    '                    _cursor_source = _obj if isinstance(_obj, dict) else {}',
    '                    _nested = _data if isinstance(_data, dict) else {}',
    '                    _raw_cursor = next((_source.get(_key) for _source in (_cursor_source, _nested) for _key in ("cursor", "max_cursor", "search_cursor", "next_cursor", "nextCursor") if _source.get(_key) is not None), None)',
    '                    _page["responseCursor"] = _cursor(_raw_cursor)',
    '                    _raw_more = next((_source.get(_key) for _source in (_cursor_source, _nested) for _key in ("has_more", "hasMore", "has_next", "hasNext") if _source.get(_key) is not None), None)',
    '                    if isinstance(_raw_more, bool): _page["hasMore"] = _raw_more',
    '                    elif isinstance(_raw_more, (int, float)): _page["hasMore"] = bool(_raw_more)',
    '                    elif isinstance(_raw_more, str) and _raw_more.strip().lower() in ("0", "1", "true", "false"): _page["hasMore"] = _raw_more.strip().lower() in ("1", "true")',
    '                else: _info["jsonType"] = type(_obj).__name__',
    '            except Exception: _info["bodyKind"] = "non-json"',
    '        print("CINDY_HTTP_DIAG " + _json.dumps(_info, ensure_ascii=False), file=_sys.stderr, flush=True)',
    '        print("CINDY_PAGE_DIAG " + _json.dumps(_page, ensure_ascii=False), file=_sys.stderr, flush=True)',
    '    except Exception: pass',
    'try:',
    '    import httpx as _httpx',
    '    _httpx_send = _httpx.AsyncClient.send',
    '    async def _diag_httpx_send(self, request, *args, **kwargs):',
    '        try:',
    '            _response = await _httpx_send(self, request, *args, **kwargs)',
    '            _body = await _response.aread()',
    '            _emit("httpx", _response.request.url, _response.status_code, _response.headers, _body, _request=request)',
    '            return _response',
    '        except Exception as _exc:',
    '            _emit("httpx", request.url, "exception", {}, _error=type(_exc).__name__, _request=request)',
    '            raise',
    '    _httpx.AsyncClient.send = _diag_httpx_send',
    'except Exception: pass',
    'try:',
    '    import aiohttp as _aiohttp',
    '    _aiohttp_request = _aiohttp.ClientSession._request',
    '    async def _diag_aiohttp_request(self, method, str_or_url, *args, **kwargs):',
    '        try:',
    '            _response = await _aiohttp_request(self, method, str_or_url, *args, **kwargs)',
    '            _url = getattr(_response, "url", str_or_url)',
    '            _body = await _response.read()',
    '            _emit("aiohttp", _url, _response.status, _response.headers, _body, _request_body=kwargs.get("json", kwargs.get("data")))',
    '            return _response',
    '        except Exception as _exc:',
    '            _emit("aiohttp", str_or_url, "exception", {}, _error=type(_exc).__name__, _request_body=kwargs.get("json", kwargs.get("data")))',
    '            raise',
    '    _aiohttp.ClientSession._request = _diag_aiohttp_request',
    'except Exception: pass',
  ].join('\n');
  fs.writeFileSync(path.join(sourceRoot, 'sitecustomize.py'), script, { mode: 0o600 });
}

async function collectMediaCrawler({ crawlerRoot, profile, platform, maxItems = 500, signal, onProgress, shouldStop = () => false, freshAccount = false } = {}) {
  const safePlatform = SUPPORTED_PLATFORMS.has(platform) ? platform : null;
  if (!safePlatform) throw collectorError('UNSUPPORTED_PLATFORM', '本机试用版仅支持抖音或快手。');
  if (!signal || typeof signal.addEventListener !== 'function') {
    throw collectorError('COLLECTOR_SIGNAL_REQUIRED', '本次采集缺少安全取消控制。');
  }
  const keywords = normalizeKeywords(profile || {});
  const environment = validateMediaCrawlerRoot(crawlerRoot);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-topic-plugin-trial-'));
  const sourceRoot = path.join(tempRoot, 'source');
  const outputRoot = path.join(tempRoot, 'output');
  fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  const activeRun = { tempRoot, sourceRoot, child: null };
  ACTIVE_RUNS.add(activeRun);
  let completed = false;
  let session;
  let monitor;
  const phaseDiagnostics = [];
  const phaseAttempts = new Map();
  let endReason = 'search-ended';
  const deadline = Date.now() + MAX_RUNTIME_MS;

  try {
    fs.mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
    if (signal.aborted) throw collectorError('COLLECTOR_CANCELLED', '本次采集已取消。');
    if (onProgress) onProgress('正在准备隔离的采集副本…');
    await archiveHead(environment.root, sourceRoot, signal);
    patchSearchLimits(sourceRoot);
    patchSearchFlow(sourceRoot);
    installSearchResponseDiagnostics(sourceRoot);
    try {
      session = await browserSession.openSession({
        chromePath: environment.chromePath,
        platform: safePlatform,
        signal,
        headless: !freshAccount,
        scope: freshAccount ? `${__dirname}:fresh-account` : __dirname,
      });
    } catch (error) {
      throw collectorError(error.code || "BROWSER_START_FAILED", error.code ? error.message : "专用浏览器启动失败，请检查 Chrome。");
    }
    patchIsolatedSource(sourceRoot, environment.chromePath, session);
    if (onProgress) onProgress('正在后台搜索并筛选合格视频；需要登录时才会显示扫码窗口…');
    const args = buildCrawlerArgs({
      platform: safePlatform,
      keywords,
      outputDir: outputRoot,
      maxItems,
    });
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: os.homedir(),
      TMPDIR: os.tmpdir(),
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
      PYTHONPATH: sourceRoot,
      CINDY_SEARCH_KEYWORDS: JSON.stringify(keywords),
      LANG: process.env.LANG || 'en_US.UTF-8',
    };
    const controlRoot = path.join(tempRoot, 'control');
    fs.mkdirSync(controlRoot, { mode: 0o700 });
    const statusFile = path.join(controlRoot, 'status');
    const loginDiagnosticFile = path.join(controlRoot, 'login-probe.json');
    const webDiagnosticFile = path.join(controlRoot, 'web-probe.json');
    monitor = createDecisionMonitor({ controlRoot, shouldStop,
      readVideos: () => parseSearchJsonl(outputRoot, safePlatform, maxItems) });
    try {
      await runPhases({ session, signal, onSession: (current) => { session = current; },
        run: async (phase, current) => {
          const attempt = (phaseAttempts.get(phase) || 0) + 1;
          phaseAttempts.set(phase, attempt);
          if (phase === 'collect' && attempt > 1) {
            await delay(retryDelayMs(), undefined, { signal });
            fs.rmSync(outputRoot, { recursive: true, force: true });
            fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
          }
          fs.rmSync(statusFile, { force: true });
          if (Date.now() >= deadline) throw collectorError('COLLECTOR_TIMEOUT', '本次搜索已达到时间上限。');
          let processResult;
          try {
            processResult = await runChild(environment.pythonPath, args, {
              cwd: sourceRoot,
              env: { ...env, CINDY_SEARCH_PHASE: phase, CINDY_SEARCH_STATUS: statusFile,
                CINDY_SEARCH_CONTROL: controlRoot, CINDY_BROWSER_WS: current.wsUrl,
                CINDY_BROWSER_PORT: String(current.port), CINDY_LOGIN_DIAGNOSTIC: loginDiagnosticFile,
                CINDY_FRESH_ACCOUNT: freshAccount ? 'true' : 'false', CINDY_WEB_PROBE: freshAccount ? 'true' : 'false',
                CINDY_WEB_DIAGNOSTIC: webDiagnosticFile },
              stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: true,
            }, signal, (child) => { activeRun.child = child; }, Math.min(
              deadline - Date.now(),
              phase === 'login' ? LOGIN_TIMEOUT_MS : MAX_RUNTIME_MS,
            ));
          } catch (error) {
            if (Array.isArray(error.paginationDiagnostics)) phaseDiagnostics.push({ phase, paginationDiagnostics: error.paginationDiagnostics });
            throw error;
          }
          const phaseStatus = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8').trim() : 'missing';
          let loginDiagnostics = null;
          if (fs.existsSync(loginDiagnosticFile)) {
            try {
              const probe = JSON.parse(fs.readFileSync(loginDiagnosticFile, 'utf8'));
              if (probe && typeof probe === 'object' && !Array.isArray(probe)) {
                loginDiagnostics = {
                  cookieCount: Number.isInteger(probe.cookieCount) && probe.cookieCount >= 0 ? Math.min(probe.cookieCount, 1000) : null,
                  hasLikelyLoginCookie: typeof probe.hasLikelyLoginCookie === 'boolean' ? probe.hasLikelyLoginCookie : null,
                  probeError: typeof probe.probeError === 'string' ? probe.probeError.slice(0, 80) : null,
                };
              }
            } catch { loginDiagnostics = { cookieCount: null, hasLikelyLoginCookie: null, probeError: 'invalid-probe' }; }
          }
          let webDiagnostics = null;
          if (fs.existsSync(webDiagnosticFile)) {
            try {
              const probe = JSON.parse(fs.readFileSync(webDiagnosticFile, 'utf8'));
              if (Array.isArray(probe)) webDiagnostics = probe.slice(0, 200);
              else if (probe && typeof probe === 'object') webDiagnostics = {
                error: typeof probe.error === 'string' ? probe.error.slice(0, 80) : null,
                events: Array.isArray(probe.events) ? probe.events.slice(0, 200) : [],
              };
            } catch { webDiagnostics = { error: 'invalid-probe', events: [] }; }
          }
          phaseDiagnostics.push({ phase, attempt, ...processResult, phaseStatus, loginDiagnostics, webDiagnostics });
          if (phaseStatus !== 'missing') return phaseStatus;
          if (phase === 'collect' && attempt <= COLLECT_RETRY_LIMIT) {
            let hasVideos = false;
            try {
              const files = findSearchFiles(outputRoot);
              hasVideos = files.length > 0 && parseSearchJsonl(outputRoot, safePlatform, maxItems).length > 0;
            } catch { hasVideos = false; }
            if (!hasVideos) return 'retry-collect';
          }
          return phase === 'login' ? 'login-failed' : 'complete';
        },
      });
    } catch (error) {
      if (error && ['LOGIN_INCOMPLETE', 'LOGIN_NOT_RETAINED'].includes(error.code)) {
        throw collectorError(error.code, error.message);
      }
      if (error.code !== 'COLLECTOR_TIMEOUT') throw error;
      endReason = 'time-limit';
    }
    if (monitor.error) throw monitor.error;
    if (signal.aborted) throw collectorError('COLLECTOR_CANCELLED', '本次采集已取消。');
    if (onProgress) onProgress('正在整理本次搜索结果…');
    const outputFiles = findSearchFiles(outputRoot);
    const dataRoot = path.join(sourceRoot, 'data');
    const dataFiles = outputFiles.length ? [] : findSearchFiles(dataRoot);
    const resultRoot = outputFiles.length ? outputRoot : dataRoot;
    const resultFiles = outputFiles.length ? outputFiles : dataFiles;
    const videos = resultFiles.length ? parseSearchJsonl(resultRoot, safePlatform, maxItems) : [];
    const paginationDiagnostics = phaseDiagnostics
      .flatMap((entry) => Array.isArray(entry.paginationDiagnostics) ? entry.paginationDiagnostics : [])
      .slice(0, 100);
    const emptyResponseDiagnostics = summarizeEmptyResponses(paginationDiagnostics);
    if (!videos.length && emptyResponseDiagnostics.count > 0) {
      const error = collectorError(
        'COLLECTOR_ENDPOINT_INCOMPATIBLE',
        '搜索接口返回空响应，未将其当作正常无结果；请更新 MediaCrawler 的抖音请求适配。'
          + (emptyResponseDiagnostics.paths.length ? ' 当前接口：' + emptyResponseDiagnostics.paths.join(', ') + '。' : ''),
      );
      error.paginationDiagnostics = paginationDiagnostics;
      error.emptyResponseDiagnostics = emptyResponseDiagnostics;
      throw error;
    }
    if (!videos.length && !resultFiles.length) {
      throw collectorError('COLLECTOR_NO_DATA', '采集进程结束但没有写出可解析结果；请检查 MediaCrawler 版本和登录状态。');
    }
    const collectionNote = resultFiles.length
      ? null
      : '采集进程结束，但 output/ 和 data/ 都没有搜索结果文件；逐页网络诊断仍已保留。';
    if (monitor.stopped) endReason = 'target-reached';
    else if (videos.length >= maxItems) endReason = 'candidate-limit';
    completed = true;
    const loginDiagnostics = phaseDiagnostics
      .map((entry) => entry.loginDiagnostics)
      .filter(Boolean)
      .at(-1) || null;
    const webDiagnostics = phaseDiagnostics
      .map((entry) => entry.webDiagnostics)
      .filter(Boolean)
      .at(-1) || null;
    return {
      videos,
      platform: safePlatform,
      collectorVersion: environment.version,
      fetchedAt: new Date().toISOString(),
      queryKeywords: keywords,
      endReason: resultFiles.length ? endReason : 'no-output-files',
      collectionNote,
      paginationDiagnostics,
      emptyResponseDiagnostics,
      loginDiagnostics,
      webDiagnostics,
    };
  } finally {
    if (monitor) monitor.close();
    await stopBrowserForSource(sourceRoot);
    if (session) session.release();
    ACTIVE_RUNS.delete(activeRun);
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* Best-effort cleanup of this unique temporary directory. */ }
    if (!completed && signal.aborted && onProgress) onProgress('正在清理本次采集文件；专用浏览器保留供后续使用…');
  }
}

module.exports = {
  patchSearchLimit,
  patchSearchLimits,
  CollectorError,
  platformCode,
  normalizeKeywords,
  validateGitTree,
  validateMediaCrawlerRoot,
  checkMediaCrawlerCompatibility,
  buildCrawlerArgs,
  patchIsolatedSource,
  installSearchResponseDiagnostics,
  archiveHead,
  safeJsonRecord,
  parseSearchJsonl,
  summarizeEmptyResponses,
  collectMediaCrawler,
  abortAll,
};
