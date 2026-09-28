// ==UserScript==
// @name         OA 最近三天补卡提醒
// @namespace    https://github.com/yzbf-lin/oa-attendance-reminder
// @version      1.3.0
// @homepageURL  https://github.com/yzbf-lin/oa-attendance-reminder
// @updateURL    https://raw.githubusercontent.com/yzbf-lin/oa-attendance-reminder/main/oa-attendance-reminder.meta.js
// @downloadURL  https://raw.githubusercontent.com/yzbf-lin/oa-attendance-reminder/main/oa-attendance-reminder.user.js
// @description  普通网页显示考勤检查入口，点击新开 OA 检查前三天；每天北京时间 09:00 自动检查，仅本地运行，不保存凭据。
// @match        http://*/*
// @match        https://*/*
// @run-at       document-start
// @noframes
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_getTab
// @grant        GM_saveTab
// ==/UserScript==

;(function oaAttendanceReminder() {
  'use strict';

  const SCRIPT_VERSION = '1.3.0';
  // 站点适配只从本机 GM 存储加载，公开源码不携带实际部署地址。
  let settings = null;
  let settingsError = '';
  let configDirty = false;
  let RECORD_PATH = '';
  let RECORD_URL = '';
  const MANUAL_HASH = '#oa-attendance-check';
  let APPLY_PATH = '';
  // 时间设置保存在本机，更新脚本不会覆盖。
  let CHECK_TIME = { hour: 9, minute: 0 };
  let CHECK_LABEL = '09:00';
  const PREFIX = 'oa-attendance-v1:';
  const RETRY_MS = 15 * 60 * 1000;
  const LOCK_MS = 3 * 60 * 1000;
  const PENDING_MS = 20 * 60 * 1000;
  const normalize = (value) => String(value ?? '').trim();

  function beijingTime(now = new Date()) {
    const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    return { day: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
  }

  function targetDates(now = new Date()) {
    const today = Date.parse(`${beijingTime(now).day}T00:00:00Z`);
    return [3, 2, 1].map((offset) => new Date(today - offset * 86400000).toISOString().slice(0, 10));
  }

  function isDue(now, completedDay, retryAt = 0) {
    const { day, hour, minute } = beijingTime(now);
    return hour * 60 + minute >= CHECK_TIME.hour * 60 + CHECK_TIME.minute
      && completedDay !== day && now.getTime() >= retryAt;
  }

  function validateSettings(value) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象。');
    const keys = ['recordUrl', 'oaOrigins', 'oaPath', 'applyPath', 'loginOrigins',
      'vueRoot', 'componentName', 'loginButtonSelector', 'hour', 'minute'];
    if (Object.keys(value).some((key) => !keys.includes(key))) {
      throw new Error('配置包含不支持的字段；请勿添加账号、密码、Cookie 或 Token。');
    }
    const webURL = (text) => {
      if (typeof text !== 'string') throw new Error('请填写完整的 HTTP/HTTPS 地址。');
      let url;
      try { url = new URL(text); } catch { throw new Error('请填写完整的 HTTP/HTTPS 地址。'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[?#]/.test(text)) {
        throw new Error('地址必须使用 HTTP/HTTPS，且不能包含凭据、查询参数或片段。');
      }
      return url;
    };
    const record = webURL(value.recordUrl);
    const origins = (list) => {
      if (!Array.isArray(list) || list.length > 10) throw new Error('来源地址需要填写数组，最多 10 项。');
      return [...new Set(list.map((item) => {
        const url = webURL(item);
        if (url.pathname !== '/') throw new Error('来源地址只能包含协议、域名与端口。');
        return url.origin;
      }))];
    };
    const path = (text) => {
      if (typeof text !== 'string' || !text.startsWith('/') || text.startsWith('//') || text.includes('\\')) {
        throw new Error('页面路径必须以单个 / 开头，不能包含域名。');
      }
      const url = webURL(new URL(text, record.origin).href);
      if (url.origin !== record.origin) throw new Error('页面路径不能指向其他来源。');
      return url.pathname.replace(/\/$/, '') || '/';
    };
    const oaPath = path(value.oaPath);
    const withinOA = (pathname) => oaPath === '/' || pathname === oaPath || pathname.startsWith(oaPath + '/');
    const applyPath = path(value.applyPath);
    if (!withinOA(record.pathname) || !withinOA(applyPath)) throw new Error('记录页和申请页必须位于配置的 OA 路径内。');
    const vueRoot = normalize(value.vueRoot);
    if (!/^[A-Za-z_$][\w$]*$/.test(vueRoot) || ['__proto__', 'prototype', 'constructor'].includes(vueRoot)) {
      throw new Error('页面根对象名称无效。');
    }
    const componentName = normalize(value.componentName);
    const loginButtonSelector = normalize(value.loginButtonSelector);
    if (!componentName || componentName.length > 100 || !loginButtonSelector || loginButtonSelector.length > 200) {
      throw new Error('请填写页面组件名称和登录按钮选择器。');
    }
    const hour = value.hour ?? 9;
    const minute = value.minute ?? 0;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error('时间需要填写有效的小时（0～23）和分钟（0～59）。');
    }
    return {
      recordUrl: record.href, oaOrigins: [...new Set([record.origin, ...origins(value.oaOrigins ?? [])])],
      oaPath, applyPath, loginOrigins: origins(value.loginOrigins ?? []),
      vueRoot, componentName, loginButtonSelector, hour, minute,
    };
  }

  function isOA(url, config = settings) {
    return Boolean(config && config.oaOrigins.includes(url.origin)
      && (config.oaPath === '/' || url.pathname === config.oaPath || url.pathname.startsWith(config.oaPath + '/')));
  }

  function isOALogin(href, config = settings) {
    try {
      const url = new URL(href);
      if (!config || !config.loginOrigins.includes(url.origin)
          || !/^\/login(?:;|\/|$)/.test(url.pathname)) return false;
      // 仅匹配回到已配置 OA 的 service，不辅助其他系统登录。
      return isOA(new URL(url.searchParams.get('service')), config);
    } catch { return false; }
  }

  function inspectRecords(rows, total, dates) {
    if (!Array.isArray(rows) || !Number.isInteger(Number(total)) || Number(total) < 0) {
      throw new Error('OA 未返回有效结果，请确认网络和登录状态后重试。');
    }
    if (Number(total) !== rows.length) {
      throw new Error('查询结果仍有分页或数据未加载完整，本次检查未完成。');
    }
    const seen = new Set();
    const result = [];
    for (const row of rows) {
      const date = normalize(row.date);
      if (!dates.includes(date) || seen.has(date)) {
        throw new Error('查询结果日期超出范围或重复，本次检查未完成。');
      }
      // 页面原生“补考勤单据”按钮也使用 isSelf 判断当前用户。
      if (![true, 1, '1'].includes(row.isSelf)) {
        throw new Error('无法确认结果全部属于当前登录用户，本次检查未完成。');
      }
      const shift = normalize(row.shiftName);
      const status = normalize(row.statusName);
      if (!shift || !status) throw new Error(`${date} 的排班或考勤状态为空，请稍后重试。`);
      seen.add(date);
      if (shift === '工' && status !== '正常') {
        result.push({ date, shift, status, memo: normalize(row.systemMemo) || '—' });
      }
    }
    const missing = dates.filter((date) => !seen.has(date));
    if (missing.length) throw new Error(`缺少 ${missing.join('、')} 的考勤记录，暂时无法完成检查。`);
    return result;
  }

  // Node 内置测试入口；在浏览器/油猴环境中不暴露数据或调试接口。
  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = { beijingTime, targetDates, isDue, isOA, isOALogin, inspectRecords, validateSettings };
    return;
  }

  if (window.top !== window.self) return;
  if (!['http:', 'https:'].includes(new URL(location.href).protocol)) return;
  const get = (key, fallback = null) => GM_getValue(PREFIX + key, fallback);
  const set = (key, value) => GM_setValue(PREFIX + key, value);
  const del = (key) => GM_deleteValue(PREFIX + key);
  try {
    settings = validateSettings(get('settings'));
    if (settings) {
      RECORD_URL = settings.recordUrl;
      RECORD_PATH = new URL(RECORD_URL).pathname.replace(/\/$/, '') || '/';
      APPLY_PATH = settings.applyPath;
      CHECK_TIME = { hour: settings.hour, minute: settings.minute };
      CHECK_LABEL = `${String(CHECK_TIME.hour).padStart(2, '0')}:${String(CHECK_TIME.minute).padStart(2, '0')}`;
    }
  } catch (error) { settingsError = error.message; }

  // 普通网站只挂载自己的入口和计时，不读取网页正文、表单或页面 JavaScript 对象。
  const page = isOA(new URL(location.href)) ? unsafeWindow : null;
  const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let running = false;
  let lastStatus = '';
  let ui;
  let modal;
  let manualRequested = false;
  let loginRunning = false;
  let opening = false;
  let tabId;
  let tabData;
  let lockSequence = 0;

  function publishPresence() {
    set('presence', { owner, until: Date.now() + LOCK_MS });
    const launch = get('launch');
    if (launch?.day === beijingTime().day && !launch.confirmed) {
      set('launch', { ...launch, confirmed: true });
    }
  }

  function clearPresence() {
    if (get('presence')?.owner === owner) del('presence');
  }

  function shouldOpen() {
    if (!due() || navigator.onLine === false || get('presence')?.until > Date.now()) return false;
    const launch = get('launch');
    if (launch?.day !== beijingTime().day) return true;
    // 已加载 OA/SSO 后当天不再自动重开。没加载成功则间隔 15 分钟，最多尝试三次。
    return !launch.confirmed && launch.attempts < 3 && Date.now() - launch.at >= RETRY_MS;
  }

  async function openRecordPage(manual = false) {
    if (!settings || configDirty || opening || (!manual && !shouldOpen())) return;
    opening = true;
    if (document.body) showUI(true);
    let lockToken;
    try {
      // 给同时恢复的 OA 标签页机会发布在线状态，避免浏览器启动时多开。
      if (!manual) await sleep(1000);
      else await sleep(300); // 按钮短暂禁用，合并同一次双击。
      if (!manual && (onRecordPage() || isOALogin(location.href))) return;
      // 手动入口始终新开；查询仍在 OA 页内排队，已有检查不会吞掉这次点击。
      if (!manual) {
        lockToken = await acquireLock();
        if (!lockToken) return;
      }
      if (!manual && (onRecordPage() || isOALogin(location.href) || !shouldOpen())) return;
      const day = beijingTime().day;
      const previous = get('launch');
      // 设定时间前的手动开页不能占用当天定时开页机会。
      if (!manual || isDue(new Date(), null)) {
        set('launch', {
          day, at: Date.now(), confirmed: false,
          attempts: previous?.day === day ? previous.attempts + 1 : 1,
        });
      }
      // 先记录尝试，让新页面一启动就能确认；失败不会被误记为考勤检查成功。
      // fragment 只交给新标签消费，不让已有 OA 页接走手动检查意图。
      if (!GM_openInTab(RECORD_URL + (manual ? MANUAL_HASH : ''), { active: true, insert: true })) {
        throw new Error('浏览器未返回 OA 标签页。');
      }
    } catch {
      console.warn('[OA 补卡提醒] 无法打开 OA，请检查油猴站点权限或手动打开打卡记录页。');
      if (manual) window.alert('无法自动打开 OA，请检查油猴权限或手动打开打卡记录页。');
    } finally {
      if (lockToken) releaseLock(lockToken);
      opening = false;
      if (document.body && !onRecordPage() && !isOALogin(location.href)) showUI(true);
    }
  }

  function pending() {
    const value = tabData?.oaAttendancePending;
    if (!value || value.day !== beijingTime().day || Date.now() - value.at >= PENDING_MS) return null;
    // SSO 的返回导航仅由登录所在标签消费，不能带走其他正在填写的 OA 页面。
    return value.tabId === tabId ? value : null;
  }

  function rememberPending(manual = false, returnToRecord = false) {
    tabData.oaAttendancePending = { day: beijingTime().day, at: Date.now(), manual, returnToRecord, tabId };
    GM_saveTab(tabData);
  }

  function forgetPending() {
    tabData.oaAttendancePending = null;
    GM_saveTab(tabData);
  }

  function onRecordPage() {
    return isOA(new URL(location.href)) && (location.pathname.replace(/\/$/, '') || '/') === RECORD_PATH;
  }

  function due() {
    return isDue(new Date(), get('completedDay'), get('retryAt', 0));
  }

  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (parent) parent.append(node);
    return node;
  }

  function button(text, action, parent) {
    const node = element('button', text, parent);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function createUI() {
    if (ui) return ui;
    const host = element('div', undefined, document.body);
    host.id = 'oa-local-attendance-reminder';
    host.setAttribute('data-version', SCRIPT_VERSION);
    // Shadow DOM 隔离宿主网页样式，所有业务文本只用 textContent。
    const root = host.attachShadow({ mode: 'open' });
    element('style', `
      :host { all: initial; font: 14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#243047; }
      * { box-sizing:border-box; } button,a { font:inherit; }
      [hidden] { display:none !important; }
      .panel { position:fixed; right:20px; bottom:20px; z-index:2147483000; width:286px;
        padding:14px 16px; border:1px solid #cfd9e5; border-radius:12px; background:#fff;
        box-shadow:0 8px 30px #17243c20; }
      .panel.launcher { width:auto; max-width:calc(100vw - 40px); padding:0; border:0; background:transparent; }
      .launcher button { padding:10px 16px; border-radius:24px; background:#2459aa; border-color:#2459aa; color:#fff; }
      .launcher button:hover { background:#1b4584; }
      strong { display:block; font-size:15px; } p { margin:8px 0; }
      .status { font-size:12px; color:#526279; white-space:pre-line; overflow-wrap:anywhere; }
      button,a { cursor:pointer; border:1px solid #c9d3e1; border-radius:7px; background:#fff;
        color:#244666; padding:6px 12px; text-decoration:none; display:inline-block; }
      button:hover,a:hover { background:#eff5fc; } button:disabled { opacity:.5; cursor:wait; }
      button:focus-visible,a:focus-visible { outline:3px solid #7bb7ff; outline-offset:2px; }
      dialog { color:#243047; font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
        width:min(660px,92vw); max-height:85vh; overflow:auto; padding:24px;
        border:1px solid #cfd9e5; border-radius:14px; box-shadow:0 24px 90px #0004; }
      dialog::backdrop { background:#13203966; } h2 { margin:0 0 12px; font-size:21px; }
      table { width:100%; border-collapse:collapse; margin:16px 0; }
      th,td { text-align:left; border-bottom:1px solid #e0e6ef; padding:9px 6px; overflow-wrap:anywhere; }
      th:first-child,td:first-child { white-space:nowrap; } th { color:#526279; font-weight:500; }
      .actions { display:flex; justify-content:flex-end; gap:10px; margin-top:20px; }
      .primary { background:#2459aa; border-color:#2459aa; color:#fff; }
      .primary:hover { background:#1b4584; }
    `, root);
    const panel = element('section', undefined, root);
    panel.className = 'panel';
    const heading = element('strong', `OA 补卡提醒 · v${SCRIPT_VERSION}`, panel);
    const status = element('p', `北京时间 ${CHECK_LABEL} · 检查前三个自然日`, panel);
    status.className = 'status';
    status.setAttribute('role', 'status');
    const check = button('立即检查', () => requestCheck(), panel);
    ui = { root, panel, heading, status, check };
    return ui;
  }

  function showUI(launcher = false) {
    const view = createUI();
    view.panel.hidden = false;
    view.panel.className = launcher ? 'panel launcher' : 'panel';
    view.heading.hidden = launcher;
    view.status.hidden = launcher;
    view.check.hidden = !launcher && isOALogin(location.href);
    view.check.disabled = configDirty || (launcher ? opening : running);
    view.check.textContent = configDirty ? '设置已保存，请刷新网页' : !settings ? '配置 OA 考勤'
      : launcher ? (opening ? '正在打开 OA…' : 'OA 考勤检查') : '立即检查';
    view.check.title = `${launcher ? '在新标签页打开 OA，立即检查最近三天考勤' : '立即检查最近三天考勤'} · v${SCRIPT_VERSION}`;
    return view;
  }

  function status(text) {
    lastStatus = text;
    if (!document.body) return;
    const view = showUI();
    view.status.textContent = text;
    view.check.disabled = running;
  }

  function showDialog(title, description, rows = [], apply = false) {
    const view = createUI();
    if (modal) { modal.close(); modal.remove(); }
    const dialog = element('dialog', undefined, view.root);
    modal = dialog;
    const heading = element('h2', title, dialog);
    heading.id = 'oa-reminder-heading';
    dialog.setAttribute('aria-labelledby', heading.id);
    element('p', description, dialog);
    if (rows.length) {
      const table = element('table', undefined, dialog);
      const head = element('tr', undefined, element('thead', undefined, table));
      ['日期', '排班', '考勤状态', '异常说明'].forEach((text) => element('th', text, head));
      const body = element('tbody', undefined, table);
      rows.forEach((row) => {
        const tr = element('tr', undefined, body);
        [row.date, row.shift, row.status, row.memo].forEach((text) => element('td', text, tr));
      });
    }
    const actions = element('div', undefined, dialog);
    actions.className = 'actions';
    const close = button('知道了', () => dialog.close(), actions);
    if (apply) {
      const link = element('a', '去申请补考勤', actions);
      link.href = APPLY_PATH;
      link.className = 'primary';
      // 保留当前检查页；只打开 OA 已有申请入口，不提交申请。
      link.target = '_blank';
      link.rel = 'noopener';
    }
    dialog.showModal();
    close.focus({ preventScroll: true });
  }

  function findRecordVM() {
    const root = page[settings.vueRoot];
    if (!root) return null;
    const stack = [root];
    const visited = new Set();
    while (stack.length) {
      const vm = stack.pop();
      if (!vm || visited.has(vm)) continue;
      visited.add(vm);
      if (vm.$options?.name === settings.componentName && !vm._isDestroyed && !vm._inactive) return vm;
      stack.push(...(vm.$children || []));
    }
    return null;
  }

  async function waitFor(read, timeout = 45000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!onRecordPage()) throw new Error('已离开打卡记录页，本次检查已停止。');
      const value = read();
      if (value) return value;
      await sleep(250);
    }
    throw new Error('等待 OA 页面超时，请检查网络、登录状态，或刷新页面后重试。');
  }

  async function acquireLock() {
    const lock = get('lock');
    if (lock && lock.until > Date.now()) return null;
    const token = `${owner}:${++lockSequence}`;
    set('lock', { owner, token, until: Date.now() + LOCK_MS });
    // GM 存储跨 www / 裸域 / SSO 共享；竞争标签页在读取赢家前让出一次执行权。
    await sleep(300);
    return get('lock')?.token === token ? token : null;
  }

  function releaseLock(token) {
    const lock = get('lock');
    if (lock?.owner === owner && (!token || lock.token === token)) del('lock');
  }

  function ensureActive(control) {
    if (control.cancelled || !onRecordPage() || get('lock')?.token !== control.token) {
      throw new Error('检查已停止，请返回打卡记录页后重新检查。');
    }
  }

  async function queryRecords(vm, dates, control) {
    const methods = vm.$options?.methods;
    if (typeof methods?.permission !== 'function' || typeof methods?.getAttendance !== 'function'
        || !vm.initQuery || !vm.query) {
      throw new Error('OA 页面结构已变化，脚本需要适配；本次检查未完成。');
    }
    await waitFor(() => !vm.loading);
    ensureActive(control);
    // 使用已核实的原生方法及独立 this，只查询本人，不改变用户正在看的筛选条件。
    // 不访问 Cookie、Token 或登录字段；鉴权与网络请求仍由 OA 自己处理。
    const queryContext = { query: JSON.parse(JSON.stringify(vm.initQuery)), attendanceData: [], total: -1 };
    await methods.permission.call(queryContext);
    ensureActive(control);
    if (queryContext.query.userIds?.length !== 1 || !queryContext.query.userIds[0]) {
      throw new Error('无法获取当前登录用户，请重新登录后检查。');
    }
    Object.assign(queryContext.query, {
      beginTime: dates[0], endTime: dates[2], page: 1, pageSize: 31,
      shiftType: [], attendanceStatus: [], company: [], deptIds: [], status: [],
    });
    // 原生方法失败会保留旧数据；独立上下文中的 total=-1 可识别这种失败。
    await methods.getAttendance.call(queryContext);
    ensureActive(control);
    if (queryContext.loading) throw new Error('OA 查询尚未完成，请稍后重试。');
    return inspectRecords(queryContext.attendanceData, queryContext.total, dates);
  }

  async function runCheck(manual) {
    if (running || !onRecordPage()) return;
    if (!manual && !due()) return;
    running = true;
    let heartbeat;
    let deadlineTimer;
    const control = { cancelled: false, token: null };
    try {
      control.token = await acquireLock();
      if (!control.token) {
        status('另一张 OA 标签页正在检查，请稍候。');
        return;
      }
      // 等待锁期间可能已有另一页检查完成。
      if (!manual && !due()) return;
      heartbeat = setInterval(() => {
        if (get('lock')?.token === control.token) {
          set('lock', { owner, token: control.token, until: Date.now() + LOCK_MS });
        }
      }, 30000);
      rememberPending(manual);
      const startedDay = beijingTime().day;
      const dates = targetDates();
      status(`正在检查 ${dates[0]} 至 ${dates[2]}…`);
      const operation = (async () => {
        const vm = await waitFor(findRecordVM);
        ensureActive(control);
        return queryRecords(vm, dates, control);
      })();
      const anomalies = await Promise.race([
        operation,
        new Promise((_, reject) => {
          deadlineTimer = setTimeout(() => {
            control.cancelled = true;
            reject(new Error('查询超过 60 秒，请检查网络或重新登录后重试。'));
          }, 60000);
        }),
      ]);
      if (get('lock')?.token !== control.token) throw new Error('检查已由另一张标签页接管，请在该页面查看结果。');
      if (beijingTime().day !== startedDay) throw new Error('检查时跨过了零点，请重新检查。');
      if (anomalies.length) {
        showDialog('考勤异常，请及时补卡',
          `${dates[0]} 至 ${dates[2]} 有 ${anomalies.length} 天排班为“工”，但考勤状态不是“正常”。请核对原因，属于漏打卡的及时申请补卡。`,
          anomalies, true);
      } else if (manual) {
        showDialog('检查完成', `${dates[0]} 至 ${dates[2]} 未发现“工”且考勤状态非“正常”的记录。`);
      }
      // 到设定时间前的手动检查不占用当天定时检查。
      if (isDue(new Date(), null)) set('completedDay', startedDay);
      del('retryAt');
      forgetPending();
      del('failureNoticeDay');
      status(`${dates[0]} 至 ${dates[2]}\n${anomalies.length ? `发现 ${anomalies.length} 天考勤异常，请核对补卡。` : '检查完成，未发现工日考勤异常。'}`);
    } catch (error) {
      control.cancelled = true;
      set('retryAt', Date.now() + RETRY_MS);
      // OA 的 401 提示会在 1 秒后跳转 SSO；先给原生跳转机会，保留续查意图。
      await sleep(1500);
      forgetPending();
      const message = error instanceof Error ? error.message : 'OA 查询失败，请稍后重试。';
      status(`检查未完成：${message}\n15 分钟后重试，也可手动检查。`);
      const day = beijingTime().day;
      if (onRecordPage() && (manual || get('failureNoticeDay') !== day)) {
        showDialog('考勤检查未完成', message);
        set('failureNoticeDay', day);
      }
    } finally {
      control.cancelled = true;
      clearInterval(heartbeat);
      clearTimeout(deadlineTimer);
      if (control.token) releaseLock(control.token);
      running = false;
      if (ui) ui.check.disabled = false;
    }
  }

  function configure() {
    if (running || opening || loginRunning) {
      window.alert('请等待当前操作结束后再修改配置。');
      return;
    }
    const template = { recordUrl: '', oaOrigins: [], oaPath: '', applyPath: '', loginOrigins: [],
      vueRoot: '', componentName: '', loginButtonSelector: '', hour: 9, minute: 0 };
    const text = window.prompt('粘贴本地 OA 配置 JSON。配置只保存在本机，不上传；请勿填写账号或密码。',
      JSON.stringify(get('settings') || template, null, 2));
    if (text === null) return;
    try {
      const next = validateSettings(JSON.parse(text));
      if (!next) throw new Error('配置不能为空。');
      set('settings', next);
      // 清除旧配置的调度状态，仍不触碰其他标签正在进行的查询锁。
      ['completedDay', 'retryAt', 'presence', 'launch', 'loginAttemptDay', 'failureNoticeDay'].forEach(del);
      forgetPending();
      configDirty = true;
      window.alert('配置已保存在本机。请刷新已打开的网页后使用；自动更新不会覆盖配置。');
      if (document.body) showUI(true);
    } catch (error) {
      window.alert(`配置未保存：${error instanceof Error ? error.message : '配置无效。'}`);
    }
  }

  function requestCheck() {
    if (configDirty) { window.alert('配置已保存，请刷新当前网页后再检查。'); return; }
    if (!settings) {
      if (settingsError) window.alert(`当前配置无效：${settingsError}`);
      configure();
      return;
    }
    if (!onRecordPage()) {
      void openRecordPage(true);
    } else {
      manualRequested = true;
      tick();
    }
  }

  async function assistLogin() {
    if (loginRunning || !isOALogin(location.href)) return;
    const resume = pending();
    if (!resume && !due()) return;
    rememberPending(Boolean(resume?.manual), true);
    if (get('loginAttemptDay') === beijingTime().day) {
      status('自动登录已尝试过一次。请手动完成登录，返回打卡记录页后继续检查。');
      ui.check.hidden = true;
      return;
    }
    loginRunning = true;
    let lockToken;
    status('OA 登录已过期，准备点击现有登录按钮。');
    ui.check.hidden = true;
    try {
      // 给浏览器自身的自动填充留时间。脚本从不读取、填写或保存输入框值。
      await sleep(3000);
      let login;
      try { login = document.querySelector(settings.loginButtonSelector); }
      catch {
        status('登录按钮配置无效，请通过油猴菜单修正配置后刷新。');
        return;
      }
      if (!login || login.disabled || !login.getClientRects().length) {
        status('请手动完成 OA 登录；登录后将继续检查。');
        return;
      }
      lockToken = await acquireLock();
      if (!lockToken) return;
      if (get('loginAttemptDay') === beijingTime().day) return;
      set('loginAttemptDay', beijingTime().day);
      rememberPending(Boolean(resume?.manual), true);
      login.click();
      status('已点击登录。若未跳转，请手动登录；脚本不会重复点击或处理验证码。');
    } finally {
      if (lockToken) releaseLock(lockToken);
      loginRunning = false;
    }
  }

  function tick() {
    if (!isOA(new URL(location.href))) return;
    const resume = pending();
    if (!onRecordPage()) {
      if (ui) ui.panel.hidden = true;
      // OA SPA 初始化完成后再恢复，避免干扰 SSO ticket 换取会话的过程。
      if (resume?.returnToRecord && page[settings.vueRoot] && !running) location.replace(RECORD_PATH);
      return;
    }
    showUI();
    if (running) return;
    if (resume?.returnToRecord) {
      del('retryAt');
      rememberPending(Boolean(resume.manual));
    }
    if (!lastStatus) status(get('completedDay') === beijingTime().day
      ? '今天已完成检查。需要重新查询可点击“立即检查”。'
      : `北京时间每天 ${CHECK_LABEL} 检查前三个自然日。`);
    const manual = manualRequested || Boolean(resume?.manual);
    manualRequested = false;
    void runCheck(manual);
  }

  function pulse() {
    if (!settings || configDirty) { showUI(true); return; }
    if (onRecordPage()) {
      publishPresence();
      tick();
    } else if (isOALogin(location.href)) {
      publishPresence();
      void assistLogin();
    } else {
      clearPresence();
      // 普通 OA 页仍可承接刚完成的登录；其余页面通过新标签打开，不打断当前页面。
      tick();
      if (isOA(new URL(location.href)) && pending()?.returnToRecord) return;
      showUI(true);
      void openRecordPage();
    }
  }

  function start() {
    pulse();
    setInterval(pulse, 15000);
    window.addEventListener('focus', pulse);
    window.addEventListener('online', pulse);
    window.addEventListener('pageshow', pulse);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pulse(); });
  }
  console.info(`[OA 补卡提醒 v${SCRIPT_VERSION}] 脚本已执行，正在初始化。`);
  GM_getTab((tab) => {
    // 油猴的标签存储能随同一标签跨 OA / SSO 导航保留，不保存 URL 或凭据。
    if (!tab.oaAttendanceTabId) {
      tab.oaAttendanceTabId = owner;
      GM_saveTab(tab);
    }
    tabData = tab;
    tabId = tab.oaAttendanceTabId;
    const entryURL = new URL(location.href);
    if (entryURL.hash === MANUAL_HASH && (isOA(entryURL) || isOALogin(location.href))) {
      // 在 OA 可能跳往 SSO 之前保存到当前标签；消费后去掉标记，刷新不会再触发。
      rememberPending(true, !onRecordPage());
      entryURL.hash = '';
      window.history.replaceState(window.history.state, '', entryURL.href);
    }
    if (onRecordPage() || isOALogin(location.href)) {
      publishPresence();
      if (onRecordPage() && due() && !pending()) rememberPending();
    }
    GM_registerMenuCommand('立即检查最近三天考勤', requestCheck);
    GM_registerMenuCommand('配置 OA（仅保存在本机）', configure);
    // 导航到 SSO 时保留短期 presence；租约到期后自动失效，不影响其他标签页。
    window.addEventListener('pagehide', () => releaseLock());
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  });
})();
