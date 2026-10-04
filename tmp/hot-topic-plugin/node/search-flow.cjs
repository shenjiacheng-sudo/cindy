'use strict';
const fs = require('node:fs');
const path = require('node:path');

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
  source = 'import search_control as cindy_control\n' + source;
  source = once(source, '            self.context_page = await self.browser_context.new_page()', [
    '            pages = self.browser_context.pages',
    '            self.context_page = pages[0] if pages else await self.browser_context.new_page()',
    '            for extra_page in pages[1:]:',
    '                await extra_page.close()',
  ].join('\n'));
  const login = '                login_obj = ' + (dy ? 'DouYinLogin(' : 'KuaishouLogin(');
  source = once(source, login, [
    '                if cindy_control.phase() != "login":',
    '                    cindy_control.status("login-required")',
    '                    await self.context_page.goto("about:blank")',
    '                    return',
    login,
  ].join('\n'));
  source = once(source, '            crawler_type_var.set(config.CRAWLER_TYPE)', [
    '            if cindy_control.phase() == "login":',
    '                cindy_control.status("logged-in")',
    '                await self.context_page.goto("about:blank")',
    '                return',
    '            crawler_type_var.set(config.CRAWLER_TYPE)',
  ].join('\n'));
  const store = dy
    ? '                    await douyin_store.update_douyin_aweme(aweme_item=aweme_info)'
    : '                    await kuaishou_store.update_kuaishou_video(video_item=video_detail)';
  source = once(source, store, store + '\n                    if await cindy_control.checkpoint():\n                        return');
  source = once(source, '                await self.search()', [
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

async function runPhases({ session, run, signal, onSession = () => {} }) {
  let active = session;
  try {
    let status = await run('collect', active);
    if (status !== 'login-required') return;
    if (signal.aborted) throw Object.assign(new Error('本次采集已取消。'), { code: 'COLLECTOR_CANCELLED' });
    active = await active.setHeadless(false);
    onSession(active);
    status = await run('login', active);
    // Close the visible window even if login fails. Never loop repeated QR prompts.
    if (status !== 'logged-in') throw Object.assign(new Error('扫码登录未完成，请重试。'), { code: 'LOGIN_INCOMPLETE' });
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
