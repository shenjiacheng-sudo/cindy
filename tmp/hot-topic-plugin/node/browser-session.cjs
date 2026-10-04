'use strict';

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function privateDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw fail("BROWSER_STATE_INVALID", "专用浏览器目录异常，请停止并检查本机环境。");
  }
  fs.chmodSync(dir, 0o700);
}
function readState(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function ownsBrowser(state, profile, chromePath) {
  if (!state || state.chromePath !== chromePath || !processAlive(state.pid)) return false;
  const result = spawnSync("ps", ["-p", String(state.pid), "-o", "command="], {
    encoding: "utf8", timeout: 3000, maxBuffer: 16384, env: { PATH: "/usr/bin:/bin", LC_ALL: "en_US.UTF-8" },
  });
  if (result.status !== 0) throw fail("BROWSER_IDENTITY_UNAVAILABLE", "无法核对专用浏览器身份，请允许本机进程检查后重试。");
  const command = result.stdout.trim();
  return command.startsWith(`${chromePath} `) && command.includes(` --user-data-dir=${profile} `)
    && command.includes(" --remote-debugging-port=0 ");
}
function readEndpoint(profile) {
  try {
    const file = path.join(profile, "DevToolsActivePort");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return null;
    const [rawPort, route] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route)) return null;
    return { port, wsUrl: `ws://127.0.0.1:${port}${route}` };
  } catch { return null; }
}
function acquireLock(root) {
  const file = path.join(root, "search.lock");
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, String(process.pid));
    return () => { fs.closeSync(fd); try { fs.unlinkSync(file); } catch {} };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Never steal a lock from a live worker. Crash recovery uses an atomic rename.
    let owner;
    try { owner = Number(fs.readFileSync(file, "utf8")); } catch {}
    if (!Number.isInteger(owner) || owner < 2 || processAlive(owner)) {
      throw fail("COLLECTOR_BUSY", "这个平台已有搜索正在进行，请等待完成后再试。");
    }
    const stale = `${file}.stale`;
    try { fs.linkSync(file, stale); } catch { throw fail("COLLECTOR_BUSY", "浏览器搜索状态正在恢复，请稍后重试。"); }
    try { fs.unlinkSync(file); return acquireLock(root); } finally { fs.unlinkSync(stale); }
  }
}

// Chrome owns a private temporary session, independent of the Node worker.
// Chrome owns its native cookie storage. No cookie bytes enter plugin messages.
async function openSession({ chromePath, platform, signal, scope = __dirname, baseDir = os.tmpdir(), deps = {}, headless = true, lease }) {
  if (!["douyin", "kuaishou"].includes(platform)) throw fail("UNSUPPORTED_PLATFORM", "不支持的平台。");
  const key = crypto.createHash("sha256").update(path.resolve(scope)).digest("hex").slice(0, 24);
  const root = path.join(baseDir, `hot-topic-browser-${key}-${platform}`);
  privateDirectory(root);
  const unlock = lease || acquireLock(root);
  let released = false;
  const release = () => { if (!released) { released = true; unlock(); } };
  const profile = path.join(root, "profile");
  const stateFile = path.join(root, "browser.json");
  const owns = deps.ownsBrowser || ownsBrowser;
  const endpoint = deps.readEndpoint || readEndpoint;
  const decorate = (active, state, reused) => {
    const session = { ...active, reused, headless: state.headless === true, release };
    session.close = async () => {
      if (owns(state, profile, chromePath)) {
        if (deps.stopBrowser) await deps.stopBrowser(state);
        else {
          process.kill(state.pid, 'SIGTERM');
          for (let i = 0; i < 100 && processAlive(state.pid); i++) await delay(100);
          if (processAlive(state.pid)) throw fail('BROWSER_STOP_TIMEOUT', '专用浏览器未能关闭，已停止切换，避免打开多个窗口。');
        }
      } else if (processAlive(state.pid)) {
        throw fail('BROWSER_STATE_INVALID', '无法确认已有浏览器属于本插件，已停止操作。');
      }
      fs.rmSync(stateFile, { force: true });
    };
    session.setHeadless = async (next) => {
      if (session.headless === next) return session;
      await session.close();
      const updated = await openSession({ chromePath, platform, signal, scope, baseDir, deps, headless: next, lease: release });
      return updated;
    };
    return session;
  };
  let child;
  try {
    const state = readState(stateFile);
    if (fs.existsSync(stateFile) && (!state || !Number.isInteger(state.pid) || state.pid < 2 || typeof state.wsUrl !== 'string')) {
      throw fail('BROWSER_STATE_INVALID', '专用浏览器记录损坏，请停止搜索并修复记录，避免覆盖仍在使用的登录资料。');
    }
    if (state && owns(state, profile, chromePath)) {
      const active = endpoint(profile);
      if (!active || active.wsUrl !== state.wsUrl) throw fail("BROWSER_STATE_INVALID", "专用浏览器连接信息已变化，请关闭该搜索窗口后重试。");
      const session = decorate(active, state, true);
      if (session.headless !== headless) return await session.setHeadless(headless);
      return session;
    }
    if (state && processAlive(state.pid)) throw fail("BROWSER_STATE_INVALID", "无法确认已有窗口属于本插件，请关闭专用搜索窗口后重试。");
    if (signal.aborted) throw fail("COLLECTOR_CANCELLED", "本次搜索已取消。");
    // Chrome retains its native login profile; never export cookies.
    privateDirectory(profile);
    fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
    child = (deps.spawn || spawn)(chromePath, [
      `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      "--no-first-run", "--no-default-browser-check", "--restore-last-session",
      ...(headless ? ['--headless=new'] : []), "about:blank",
    ], { stdio: "ignore", detached: true });
    let startError = false;
    child.once("error", () => { startError = true; });
    child.unref();
    for (let i = 0; i < 120; i += 1) {
      if (signal.aborted) throw fail("COLLECTOR_CANCELLED", "本次搜索已取消。");
      if (startError || child.exitCode !== null || child.signalCode !== null) throw fail("BROWSER_START_FAILED", "专用浏览器启动失败，请检查 Chrome。");
      const active = endpoint(profile);
      if (active) {
        const temporaryState = `${stateFile}.${crypto.randomUUID()}`;
        const state = { pid: child.pid, chromePath, wsUrl: active.wsUrl, headless };
        fs.writeFileSync(temporaryState, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporaryState, stateFile);
        return decorate(active, state, false);
      }
      await (deps.delay || delay)(250);
    }
    throw fail("BROWSER_START_TIMEOUT", "专用浏览器启动超时，请稍后重试。");
  } catch (error) {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    release();
    throw error;
  }
}

module.exports = { openSession, ownsBrowser, readEndpoint, acquireLock };
