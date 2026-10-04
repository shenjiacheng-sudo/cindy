'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

function once(source, before, after) {
  if (source.split(before).length !== 2) {
    throw Object.assign(new Error('采集器版本与后台搜索适配不匹配，已停止。'), { code: 'SOURCE_PATCH_UNSUPPORTED' });
  }
  return source.replace(before, after);
}

function patchFlow(source, platform) {
  const dy = platform === 'douyin';
  const size = dy ? 'dy_limit_count' : 'ks_limit_count';
  source = once(source, '(page - start_page) * ' + size + ' < config.CRAWLER_MAX_NOTES_COUNT:',
    '(page - start_page) * ' + size + ' < (config.CRAWLER_MAX_NOTES_COUNT + len(config.KEYWORDS.split(",")) - 1) // len(config.KEYWORDS.split(",")):');
  source = 'import search_control as cindy_control\nimport json as cindy_json\nfrom pathlib import Path as cindy_Path\nimport os as cindy_os\n' + source;
  source = once(source, '            self.context_page = await self.browser_context.new_page()', [
    '            pages = self.browser_context.pages',
    '            self.context_page = pages[0] if pages else await self.browser_context.new_page()',
    '            for extra_page in pages[1:]:',
    '                await extra_page.close()',
    '            self.context_page.set_default_navigation_timeout(90000)',
    '            try:',
    '                cindy_cookies = await self.browser_context.cookies()',
    '                cindy_names = {str(item.get("name", "")).lower() for item in cindy_cookies if isinstance(item, dict)}',
    '                cindy_likely = bool(cindy_names & {"sessionid", "sessionid_ss", "sid_guard", "passport_csrf_token", "passport_csrf_token_default"})',
    '                cindy_probe = {"cookieCount": len(cindy_cookies), "hasLikelyLoginCookie": cindy_likely}',
    '                cindy_Path(__import__("os").environ["CINDY_LOGIN_DIAGNOSTIC"]).write_text(cindy_json.dumps(cindy_probe), encoding="utf-8")',
    '            except Exception as cindy_error:',
    '                cindy_Path(__import__("os").environ["CINDY_LOGIN_DIAGNOSTIC"]).write_text(cindy_json.dumps({"probeError": type(cindy_error).__name__}), encoding="utf-8")',
  ].join('\n'));
  const login = '                login_obj = ' + (dy ? 'DouYinLogin(' : 'KuaishouLogin(');
  source = once(source, login, [
    '                if cindy_control.phase() != "login":',
    '                    cindy_control.status("login-required")',
    '                    await self.context_page.goto("about:blank")',
    '                    return',
    '                if cindy_os.environ.get("CINDY_FRESH_ACCOUNT") == "true":',
    '                    cindy_control.status("logged-in")',
    '                    return',
    login,
  ].join('\n'));
  source = once(source, '            crawler_type_var.set(config.CRAWLER_TYPE)', [
    '            if cindy_control.phase() == "login":',
    '                cindy_control.status("logged-in")',
    '                return',
    '            crawler_type_var.set(config.CRAWLER_TYPE)',
  ].join('\n'));
  const store = dy
    ? '                    await douyin_store.update_douyin_aweme(aweme_item=aweme_info)'
    : '                    await kuaishou_store.update_kuaishou_video(video_item=video_detail)';
  source = once(source, store, store + '\n                    if await cindy_control.checkpoint():\n                        return');
  source = once(source, '                await self.search()', [
    '                if cindy_os.environ.get("CINDY_WEB_PROBE") == "true":',
    '                    cindy_web_events = []',
    '                    def cindy_web_request(request):',
    '                        try:',
    '                            from urllib.parse import parse_qs as cindy_parse_qs, urlsplit as cindy_urlsplit',
    '                            cindy_url = cindy_urlsplit(request.url)',
    '                            cindy_query = sorted(cindy_parse_qs(cindy_url.query, keep_blank_values=True).keys())',
    '                            cindy_body_keys = []',
    '                            try:',
    '                                cindy_body = request.post_data_json',
    '                                if isinstance(cindy_body, dict): cindy_body_keys = sorted(str(key)[:40] for key in cindy_body.keys())[:40]',
    '                            except Exception: pass',
    '                            if "/aweme/" in cindy_url.path.lower():',
    '                                cindy_web_events.append({"kind": "request", "method": request.method, "path": cindy_url.path[:160], "queryKeys": cindy_query[:40], "bodyKeys": cindy_body_keys})',
    '                        except Exception: pass',
    '                    def cindy_web_response(response):',
    '                        try:',
    '                            from urllib.parse import urlsplit as cindy_urlsplit',
    '                            cindy_url = cindy_urlsplit(response.url)',
    '                            if "/aweme/" in cindy_url.path.lower():',
    '                                cindy_web_events.append({"kind": "response", "status": response.status, "path": cindy_url.path[:160]})',
    '                        except Exception: pass',
    '                    try:',
    '                        self.context_page.on("request", cindy_web_request)',
    '                        self.context_page.on("response", cindy_web_response)',
    '                        from urllib.parse import quote as cindy_quote',
    '                        cindy_keyword = config.KEYWORDS.split(",")[0].strip()',
    '                        await self.context_page.goto("https://www.douyin.com/search/" + cindy_quote(cindy_keyword), wait_until="domcontentloaded", timeout=90000)',
    '                        await self.context_page.wait_for_timeout(5000)',
    '                        cindy_Path(cindy_os.environ["CINDY_WEB_DIAGNOSTIC"]).write_text(cindy_json.dumps(cindy_web_events[:200], ensure_ascii=False), encoding="utf-8")',
    '                    except Exception as cindy_web_error:',
    '                        cindy_Path(cindy_os.environ["CINDY_WEB_DIAGNOSTIC"]).write_text(cindy_json.dumps({"error": type(cindy_web_error).__name__, "events": cindy_web_events[:200]}, ensure_ascii=False), encoding="utf-8")',
    '                    finally:',
    '                        try: self.context_page.remove_listener("request", cindy_web_request)',
    '                        except Exception: pass',
    '                        try: self.context_page.remove_listener("response", cindy_web_response)',
    '                        except Exception: pass',
    '                        try: await self.context_page.goto(self.index_url, wait_until="domcontentloaded", timeout=90000)',
    '                        except Exception: pass',
    '                try:',
    '                    await self.search()',
    '                finally:',
    '                    await self.context_page.goto("about:blank")',
  ].join('\n'));
  return source;
}

function patchSearchFlow(root) {
  fs.copyFileSync(path.join(__dirname, 'search-control.py'), path.join(root, 'search_control.py'));
  for (const platform of ['douyin', 'kuaishou']) {
    const file = path.join(root, 'media_platform', platform, 'core.py');
    fs.writeFileSync(file, patchFlow(fs.readFileSync(file, 'utf8'), platform));
    const loginFile = path.join(root, 'media_platform', platform, 'login.py');
    let login = fs.readFileSync(loginFile, 'utf8');
    login = once(login, '        asyncio.get_running_loop().run_in_executor(executor=None, func=partial_show_qrcode)', '        # QR remains in the single visible login page.');
    fs.writeFileSync(loginFile, login);
  }
}

async function runPhases({ session, run, signal, onSession = () => {}, loginGraceMs = 60_000 }) {
  let active = session;
  try {
    let status = await run('collect', active);
    let retries = 0;
    while (status === 'retry-collect' && retries < 2) {
      retries += 1;
      status = await run('collect', active);
    }
    if (status !== 'login-required') return;
    if (signal.aborted) throw Object.assign(new Error('本次采集已取消。'), { code: 'COLLECTOR_CANCELLED' });
    active = await active.setHeadless(false);
    onSession(active);
    status = await run('login', active);
    // Close the visible window even if login fails. Never loop repeated QR prompts.
    if (status !== 'logged-in') throw Object.assign(new Error('扫码登录未完成，请重试。'), { code: 'LOGIN_INCOMPLETE' });
    // MediaCrawler's QR helper can return before the user scans. Keep the QR page
    // visible long enough for manual login before restarting the browser headless.
    await delay(loginGraceMs, undefined, { signal });
    active = await active.setHeadless(true);
    onSession(active);
    status = await run('collect', active);
    if (status === 'login-required') throw Object.assign(new Error('登录状态未能在后台复用，请重试；本次不再重复弹窗。'), { code: 'LOGIN_NOT_RETAINED' });
  } finally {
    if (!active.headless) await active.close();
  }
}

function createDecisionMonitor({ controlRoot, readVideos, shouldStop }) {
  let last = '';
  let stopped = false;
  let error;
  const poll = () => {
    const ready = path.join(controlRoot, 'ready');
    if (!fs.existsSync(ready)) return;
    const sequence = fs.readFileSync(ready, 'utf8');
    if (!/^\d+$/.test(sequence) || sequence === last) return;
    try { stopped = stopped || Boolean(shouldStop(readVideos())); }
    catch (caught) { error = caught; stopped = true; }
    const temporary = path.join(controlRoot, 'decision.tmp');
    fs.writeFileSync(temporary, sequence + (stopped ? ':stop' : ':continue'), { mode: 0o600 });
    fs.renameSync(temporary, path.join(controlRoot, 'decision'));
    last = sequence;
  };
  const timer = setInterval(() => { try { poll(); } catch (caught) { error = caught; } }, 100);
  return { poll, get stopped() { return stopped; }, get error() { return error; }, close() { clearInterval(timer); } };
}

module.exports = { patchFlow, patchSearchFlow, runPhases, createDecisionMonitor };
