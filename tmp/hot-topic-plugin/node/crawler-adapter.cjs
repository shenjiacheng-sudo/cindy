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
const SUPPORTED_PLATFORMS = new Set(['douyin', 'kuaishou']);
const ACTIVE_CHILDREN = new Set();
const ACTIVE_RUNS = new Set();
const SAFE_JSON_FIELDS = [
  'aweme_id', 'video_id', 'title', 'desc', 'text', 'nickname', 'author',
  'aweme_url', 'video_url', 'liked_count', 'collected_count', 'comment_count',
  'publish_time', 'create_time',
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

  return { root, pythonPath, chromePath };
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

function runChild(command, args, options, signal, onSpawn, timeoutMs = MAX_RUNTIME_MS) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stopping = false;
    let timedOut = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
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
      child.once('exit', (code, signalName) => {
        ACTIVE_CHILDREN.delete(child);
        if (settled || stopping) return;
        if (code === 0) finish(null, { code, signal: signalName });
        else finish(collectorError(timedOut ? 'COLLECTOR_TIMEOUT' : 'COLLECTOR_EXITED', '本机采集未正常完成；请检查独立浏览器登录页面后重试。'));
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
      else if (entry.isFile() && /^search_contents_.*\.jsonl$/i.test(entry.name)) files.push(fullPath);
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
    for (const line of text.split(/\r?\n/)) {
      if (rows.length >= rowLimit) return rows;
      if (!line.trim()) continue;
      try {
        const row = safeJsonRecord(JSON.parse(line), platform);
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

async function collectMediaCrawler({ crawlerRoot, profile, platform, maxItems = 500, signal, onProgress, shouldStop = () => false } = {}) {
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
    try {
      session = await browserSession.openSession({ chromePath: environment.chromePath, platform: safePlatform, signal });
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
      LANG: process.env.LANG || 'en_US.UTF-8',
    };
    const controlRoot = path.join(tempRoot, 'control');
    fs.mkdirSync(controlRoot, { mode: 0o700 });
    const statusFile = path.join(controlRoot, 'status');
    monitor = createDecisionMonitor({ controlRoot, shouldStop,
      readVideos: () => parseSearchJsonl(outputRoot, safePlatform, maxItems) });
    try {
      await runPhases({ session, signal, onSession: (current) => { session = current; },
        run: async (phase, current) => {
          fs.rmSync(statusFile, { force: true });
          if (Date.now() >= deadline) throw collectorError('COLLECTOR_TIMEOUT', '本次搜索已达到时间上限。');
          await runChild(environment.pythonPath, args, {
            cwd: sourceRoot,
            env: { ...env, CINDY_SEARCH_PHASE: phase, CINDY_SEARCH_STATUS: statusFile,
              CINDY_SEARCH_CONTROL: controlRoot, CINDY_BROWSER_WS: current.wsUrl,
              CINDY_BROWSER_PORT: String(current.port) },
            stdio: 'ignore', windowsHide: true, detached: true,
          }, signal, (child) => { activeRun.child = child; }, deadline - Date.now());
          return fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8') : 'complete';
        },
      });
    } catch (error) {
      if (error.code !== 'COLLECTOR_TIMEOUT' && error.code !== 'COLLECTOR_EXITED') throw error;
      endReason = error.code === 'COLLECTOR_TIMEOUT' ? 'time-limit' : 'collector-error';
    }
    if (monitor.error) throw monitor.error;
    if (signal.aborted) throw collectorError('COLLECTOR_CANCELLED', '本次采集已取消。');
    if (onProgress) onProgress('正在整理本次搜索结果…');
    const videos = findSearchFiles(outputRoot).length ? parseSearchJsonl(outputRoot, safePlatform, maxItems) : [];
    if (monitor.stopped) endReason = 'target-reached';
    else if (videos.length >= maxItems) endReason = 'candidate-limit';
    completed = true;
    return { videos, platform: safePlatform, fetchedAt: new Date().toISOString(), queryKeywords: keywords, endReason };
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
  buildCrawlerArgs,
  patchIsolatedSource,
  archiveHead,
  safeJsonRecord,
  parseSearchJsonl,
  collectMediaCrawler,
  abortAll,
};
