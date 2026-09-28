const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('../oa-attendance-reminder.user.js');
const source = fs.readFileSync(require.resolve('../oa-attendance-reminder.user.js'), 'utf8');
const SETTINGS_KEY = 'oa-attendance-v1:settings';
const POSITION_KEY = 'oa-attendance-v1:widgetPosition';
// 保留域名和字段均为虚构测试数据；实际部署地址只从用户本地配置读取。
const EXAMPLE_SETTINGS = {
  recordUrl: 'http://oa.example/oa.html/attendance/record',
  oaOrigins: ['http://oa.example', 'http://alt-oa.example'],
  oaPath: '/oa.html',
  applyPath: '/oa.html/apply/list',
  loginOrigins: ['https://sso.example', 'https://sso-alt.example'],
  vueRoot: 'OA_APP',
  componentName: 'attendanceRecord',
  loginButtonSelector: '#fm1 #btnSubmit',
  hour: 9,
  minute: 0,
};
const exampleConfig = core.validateSettings(EXAMPLE_SETTINGS);
const NOW = '2026-09-26T01:00:00Z';
const dates = ['2026-09-23', '2026-09-24', '2026-09-25'];
const rows = () => dates.map((date) => ({ date, shiftName: '工', statusName: '正常', isSelf: true }));

test('北京时间 09:00 边界、错过后补查、成功去重、失败退避', () => {
  assert.equal(core.isDue(new Date('2026-09-26T00:59:59Z'), null), false);
  assert.equal(core.isDue(new Date(NOW), null), true);
  assert.equal(core.isDue(new Date('2026-09-26T08:00:00Z'), '2026-09-25'), true);
  assert.equal(core.isDue(new Date(NOW), '2026-09-26'), false);
  assert.equal(core.isDue(new Date(NOW), null, Date.parse(NOW) + 1000), false);
});

test('前三个完整自然日，跨月、跨年、闰年和中国午夜', () => {
  assert.deepEqual(core.targetDates(new Date(NOW)), dates);
  assert.deepEqual(core.targetDates(new Date('2026-01-01T01:00:00Z')), ['2025-12-29', '2025-12-30', '2025-12-31']);
  assert.deepEqual(core.targetDates(new Date('2024-03-01T01:00:00Z')), ['2024-02-27', '2024-02-28', '2024-02-29']);
  assert.deepEqual(core.targetDates(new Date('2026-09-30T16:01:00Z')), ['2026-09-28', '2026-09-29', '2026-09-30']);
});

test('仅工且非正常提醒；清除空白，不能把不正常匹配成正常', () => {
  const data = rows();
  data[0].shiftName = '休'; data[0].statusName = '异常';
  data[1].shiftName = ' 工 '; data[1].statusName = ' 不正常 ';
  data[2].statusName = '正常';
  assert.deepEqual(core.inspectRecords(data, 3, dates), [
    { date: dates[1], shift: '工', status: '不正常', memo: '—' },
  ]);
});

test('完整且全正常才返回无异常', () => {
  assert.deepEqual(core.inspectRecords(rows(), '3', dates), []);
});

test('空表、旧表、少一天、分页、重复日期和空字段不能视为正常', () => {
  assert.throws(() => core.inspectRecords([], 0, dates), /缺少/);
  assert.throws(() => core.inspectRecords(rows(), -1, dates), /有效结果/);
  assert.throws(() => core.inspectRecords(rows().slice(0, 2), 3, dates), /分页/);
  assert.throws(() => core.inspectRecords(rows().slice(0, 2), 2, dates), /缺少/);
  const bad = rows(); bad[0].date = dates[1];
  assert.throws(() => core.inspectRecords(bad, 3, dates), /重复/);
  bad[0].date = '2026-09-26';
  assert.throws(() => core.inspectRecords(bad, 3, dates), /范围/);
  bad[0] = { ...rows()[0], statusName: '' };
  assert.throws(() => core.inspectRecords(bad, 3, dates), /为空/);
  bad[0] = { ...rows()[0], shiftName: '' };
  assert.throws(() => core.inspectRecords(bad, 3, dates), /为空/);
});

test('管理员查询中混入其他用户时拒绝检查', () => {
  const data = rows(); data[1].isSelf = false;
  assert.throws(() => core.inspectRecords(data, 3, dates), /当前登录用户/);
});

test('只辅助可信 SSO 返回 OA 的登录，不接受相似域名或其他系统', () => {
  const url = (service, host = 'sso.example') => `https://${host}/login?service=${encodeURIComponent(service)}`;
  assert.equal(core.isOALogin(url('http://oa.example/oa.html/attendance/record'), exampleConfig), true);
  assert.equal(core.isOALogin(url('http://alt-oa.example/oa.html', 'sso-alt.example'), exampleConfig), true);
  for (const service of ['https://oa.example.evil.test/oa.html', 'http://oa.example/other', 'javascript:alert(1)', 'http://oa.example/oa.html-fake']) {
    assert.equal(core.isOALogin(url(service), exampleConfig), false);
  }
  assert.equal(core.isOALogin('https://sso.example/login', exampleConfig), false);
});

// 运行真实 userscript 的浏览器最小模型：原生 OA 查询为桩，虚拟时钟覆盖导航和竞争。
class Node {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.textContent = ''; this.listeners = {};
    this.attributes = new Map(); this.className = ''; this.dataset = {}; this.hidden = false; this.disabled = false;
    this.pointerCaptures = new Set();
    this.style = {
      setProperty(name, value) { this[name] = String(value); },
      getPropertyValue(name) { return this[name] ?? ''; },
      removeProperty(name) { const value = this[name]; delete this[name]; return value ?? ''; },
    };
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter((name) => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        if (add) this.classList.add(name); else this.classList.remove(name);
        return add;
      },
    };
  }
  append(node) { this.children.push(node); node.parentNode = this; }
  appendChild(node) { this.append(node); return node; }
  attachShadow() { this.shadow = new Node('shadow'); this.shadow.host = this; return this.shadow; }
  addEventListener(name, fn) {
    const previous = this.listeners[name];
    this.listeners[name] = (event) => {
      previous?.(event);
      if (!event?.immediatePropagationStopped) fn.call(this, event);
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  remove() {}
  focus() {}
  emit(type, init = {}) {
    const event = {
      type, target: this, currentTarget: this, defaultPrevented: false,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: 0, clientY: 0, detail: 1, altKey: false, shiftKey: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      stopImmediatePropagation() { this.immediatePropagationStopped = true; },
      ...init,
    };
    this.listeners[type]?.(event);
    return event;
  }
  click(init = {}) { if (!this.disabled && !this.hidden) return this.emit('click', init); }
  setPointerCapture(id) { this.pointerCaptures.add(id); }
  releasePointerCapture(id) { this.pointerCaptures.delete(id); }
  hasPointerCapture(id) { return this.pointerCaptures.has(id); }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)) || Boolean(this.shadow?.contains(node)); }
  getBoundingClientRect() {
    const position = this.classList.contains('orb') ? this.parentNode : this;
    const left = Number.parseFloat(position.style.left) || 0;
    const top = Number.parseFloat(position.style.top) || 0;
    return { x: left, y: top, left, top, right: left + 56, bottom: top + 56, width: 56, height: 56 };
  }
  getClientRects() { return [{}]; }
}

class Clock {
  constructor(now = NOW) { this.now = Date.parse(now); this.jobs = new Map(); this.id = 0; }
  schedule(fn, ms, repeat = false) { const id = ++this.id; this.jobs.set(id, { fn, at: this.now + ms, ms, repeat }); return id; }
  async flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  async advance(ms) {
    await this.flush();
    const end = this.now + ms;
    for (;;) {
      const next = [...this.jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      const [id, job] = next; this.now = job.at;
      if (job.repeat) job.at += job.ms; else this.jobs.delete(id);
      job.fn(); await this.flush();
    }
    this.now = end; await this.flush();
  }
}

function harness({ clock = new Clock(), store = new Map(), href = 'http://oa.example/oa.html/attendance/record', permission, query, data = rows(), openTab, online = true, privatePage = false, script = source, tabState = {}, readyState = 'complete', settings = EXAMPLE_SETTINGS, promptResponses = [], querySelectorError = null, viewport = { width: 1280, height: 800 } } = {}) {
  if (settings !== null && !store.has(SETTINGS_KEY)) store.set(SETTINGS_KEY, structuredClone(settings));
  const stats = { queries: 0, logins: 0, navigation: [], opened: [], alerts: [], replaced: [], prompts: [] };
  const document = new Node('document'); document.body = new Node('body'); document.readyState = readyState;
  document.documentElement = new Node('html');
  document.documentElement.clientWidth = viewport.width; document.documentElement.clientHeight = viewport.height;
  document.createElement = (tag) => new Node(tag);
  const login = new Node('button'); login.click = () => stats.logins++;
  document.querySelector = (selector) => {
    assert.equal(selector, store.get(SETTINGS_KEY)?.loginButtonSelector ?? '#fm1 #btnSubmit', '仅查询配置中的登录按钮，不读取账号密码字段');
    if (querySelectorError) throw querySelectorError;
    return login;
  };
  let url = new URL(href);
  const location = {
    get href() { return url.href; }, get pathname() { return url.pathname; },
    assign(path) { url = new URL(path, url); stats.navigation.push(url.href); },
    replace(path) { this.assign(path); },
  };
  const record = {
    $options: { name: 'attendanceRecord', methods: {
      async permission() { if (permission) await permission.call(this); else this.query.userIds = [42]; },
      async getAttendance() {
        stats.queries++; stats.query = JSON.parse(JSON.stringify(this.query));
        if (query) return query.call(this);
        this.attendanceData = data; this.total = data.length; this.loading = false;
      },
    } },
    initQuery: { beginTime: '2026-09-01', endTime: '2026-09-30', page: 1, pageSize: 31, userIds: [], shiftType: [], status: [] },
    query: { page: 2, shiftType: [7], beginTime: '2026-08-01' }, loading: false,
    attendanceData: [{ date: 'old' }], total: 57,
  };
  const window = new Node('window'); window.self = window; window.top = window;
  window.innerWidth = viewport.width; window.innerHeight = viewport.height;
  window.history = {
    state: { original: 'preserved' },
    replaceState(state, _, href) { this.state = state; url = new URL(href, url); stats.replaced.push(url.href); },
  };
  window.alert = (message) => stats.alerts.push(message);
  window.prompt = (message, defaultValue) => {
    stats.prompts.push({ message, defaultValue });
    return promptResponses.length ? promptResponses.shift() : null;
  };
  window.OA_APP = { $children: [record] };
  const navigator = { onLine: online };
  const menus = new Map();
  const sandbox = {
    window, document, location, unsafeWindow: window, navigator, URL, console,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } },
    setTimeout: (fn, ms) => clock.schedule(fn, ms), clearTimeout: (id) => clock.jobs.delete(id),
    setInterval: (fn, ms) => clock.schedule(fn, ms, true), clearInterval: (id) => clock.jobs.delete(id),
    GM_getValue: (key, fallback) => store.has(key) ? structuredClone(store.get(key)) : fallback,
    GM_setValue: (key, value) => store.set(key, structuredClone(value)), GM_deleteValue: (key) => store.delete(key),
    GM_registerMenuCommand: (name, fn) => { menus.set(name, fn); },
    GM_getTab: (callback) => callback(structuredClone(tabState)),
    GM_saveTab: (value) => Object.assign(tabState, structuredClone(value)),
    GM_openInTab: (url, options) => {
      stats.opened.push({ url, options: structuredClone(options) });
      return openTab ? openTab(url, options) : { closed: false };
    },
  };
  if (privatePage) {
    Object.defineProperty(sandbox, 'unsafeWindow', { get() { throw new Error('禁止读取其他网站 JS 对象'); } });
    for (const field of ['textContent', 'innerText', 'innerHTML']) {
      Object.defineProperty(document.body, field, { get() { throw new Error('禁止读取其他网站正文'); } });
    }
    document.querySelector = () => { throw new Error('禁止读取其他网站表单'); };
    document.querySelectorAll = document.querySelector;
  }
  vm.runInNewContext(script, sandbox);
  function all(node = document.body) { return [node, ...node.children.flatMap((child) => all(child)), ...(node.shadow ? all(node.shadow) : [])]; }
  const byClass = (name) => all().find((node) => node.classList.contains(name));
  return { clock, store, stats, document, window, record, location, navigator, tabState, menus,
    manual: () => { assert.ok(menus.has('立即检查最近三天考勤')); return menus.get('立即检查最近三天考勤')(); },
    configure: () => { assert.ok(menus.has('配置 OA（仅保存在本机）')); return menus.get('配置 OA（仅保存在本机）')(); },
    orb: () => byClass('orb'), check: () => byClass('check'), panel: () => byClass('panel'),
    popover: () => byClass('popover'), settingsButton: () => byClass('settings'), reset: () => byClass('reset'),
    position: () => ({ x: Number.parseFloat(byClass('panel').style.left), y: Number.parseFloat(byClass('panel').style.top) }),
    resize: (width, height) => {
      window.innerWidth = width; window.innerHeight = height;
      document.documentElement.clientWidth = width; document.documentElement.clientHeight = height;
      window.emit('resize');
    },
    buttons: () => all().filter((n) => n.tagName === 'button'),
    dialogs: () => all().filter((n) => n.tagName === 'dialog' && n.open), text: () => all().map((n) => n.textContent).join('\n') };
}

test('真实调度跨过 9 点只查询一次，清理筛选但不改变用户原表', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:59:00Z') });
  await h.clock.advance(59000); assert.equal(h.stats.queries, 0);
  await h.clock.advance(2000); assert.equal(h.stats.queries, 1);
  assert.equal(h.store.get('oa-attendance-v1:completedDay'), '2026-09-26');
  assert.equal(h.stats.query.beginTime, dates[0]); assert.equal(h.stats.query.endTime, dates[2]);
  assert.deepEqual(h.stats.query.userIds, [42]); assert.deepEqual(h.stats.query.attendanceStatus, []);
  assert.equal(h.record.query.page, 2); assert.equal(h.record.total, 57);
  await h.clock.advance(60000); assert.equal(h.stats.queries, 1);
});

test('异常弹窗列出日期与状态，页面数据中的 HTML 保持普通文本', async () => {
  const data = rows(); data[1].statusName = '异常'; data[1].systemMemo = '<img src=x onerror=alert(1)>';
  const h = harness({ data }); await h.clock.advance(1000);
  assert.equal(h.dialogs().length, 1);
  assert.match(h.text(), /2026-09-24/); assert.match(h.text(), /<img src=x onerror=alert\(1\)>/);
  assert.match(h.text(), /去申请补考勤/);
  assert.ok(h.store.has('oa-attendance-v1:completedDay'));
  for (const value of h.store.values()) assert.ok(!JSON.stringify(value).includes('img src'));
});

test('查询失败不使用旧记录，不标完成，自动退避后重试', async () => {
  const h = harness({ query() { this.loading = false; } });
  await h.clock.advance(2500);
  assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
  assert.match(h.text(), /检查未完成/); assert.equal(h.dialogs().length, 1);
  await h.clock.advance(60000); assert.equal(h.stats.queries, 1);
  await h.clock.advance(900000); assert.equal(h.stats.queries, 2);
  assert.equal(h.dialogs().length, 1);
});

test('两个 OA 标签页并发只有一个查询和弹窗', async () => {
  const clock = new Clock(); const store = new Map(); const data = rows(); data[0].statusName = '异常';
  const a = harness({ clock, store, data }); const b = harness({ clock, store, data });
  await clock.advance(1000);
  assert.equal(a.stats.queries + b.stats.queries, 1);
  assert.equal(a.dialogs().length + b.dialogs().length, 1);
});

test('权限查询超时后晚到的结果不得发起考勤查询', async () => {
  let resolve;
  const h = harness({ permission() { return new Promise((done) => { resolve = () => { this.query.userIds = [42]; done(); }; }); } });
  await h.clock.advance(63000); assert.match(h.text(), /超过 60 秒/);
  resolve(); await h.clock.advance(1000);
  assert.equal(h.stats.queries, 0); assert.equal(h.record.query.page, 2);
  assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
});

test('检查期间离开记录页，不继续查询或跳回', async () => {
  let resolve;
  const h = harness({ permission() { return new Promise((done) => { resolve = () => { this.query.userIds = [42]; done(); }; }); } });
  await h.clock.advance(1000); h.location.assign('/oa.html/apply/list'); resolve();
  await h.clock.advance(17000);
  assert.equal(h.stats.queries, 0); assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
  assert.equal(h.location.pathname, '/oa.html/apply/list');
});

test('09:00 前手动检查不占用当天定时检查', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:58:00Z') });
  h.manual(); await h.clock.advance(1000);
  assert.equal(h.stats.queries, 1); assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
  await h.clock.advance(121000); assert.equal(h.stats.queries, 2);
});

const loginURL = 'https://sso.example/login?service=http%3A%2F%2Foa.example%2Foa.html%2Fattendance%2Frecord';

test('08:59 已在 SSO，9 点后辅助登录一次且无凭据读取', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:59:00Z'), href: loginURL });
  await h.clock.advance(59000); assert.equal(h.stats.logins, 0);
  await h.clock.advance(6000); assert.equal(h.stats.logins, 1);
  assert.equal(h.check().hidden, true);
  assert.equal(h.orb().hidden, false);
  await h.clock.advance(3600000); assert.equal(h.stats.logins, 1);
});

test('两个 SSO 标签页同时恢复只点击一次', async () => {
  const clock = new Clock(); const store = new Map();
  const a = harness({ clock, store, href: loginURL }); const b = harness({ clock, store, href: loginURL });
  await clock.advance(5000); assert.equal(a.stats.logins + b.stats.logins, 1);
});

test('登录成功返回 OA 首页可恢复原检查；普通主页不自动跳转', async () => {
  const tabState = { oaAttendanceTabId: 'login-tab', oaAttendancePending: { day: '2026-09-26', at: Date.parse(NOW), manual: false, returnToRecord: true, tabId: 'login-tab' } };
  const h = harness({ href: 'http://oa.example/oa.html/home', tabState });
  assert.equal(h.location.pathname, '/oa.html/attendance/record');
  const plain = harness({ href: 'http://oa.example/oa.html/home' });
  await plain.clock.advance(60000); assert.equal(plain.stats.navigation.length, 0);
});

test('登录恢复后立即清除网络重试退避，继续查询', async () => {
  const store = new Map([
    ['oa-attendance-v1:retryAt', Date.parse(NOW) + 900000],
  ]);
  const tabState = { oaAttendanceTabId: 'login-tab', oaAttendancePending: { day: '2026-09-26', at: Date.parse(NOW), manual: false, returnToRecord: true, tabId: 'login-tab' } };
  const h = harness({ store, tabState }); await h.clock.advance(1000);
  assert.equal(h.stats.queries, 1);
  assert.equal(store.get('oa-attendance-v1:completedDay'), '2026-09-26');
});

test('普通网页跨过 9 点自动新开 OA，不读取其他网站内容', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:59:00Z'), href: 'https://example.com/private?secret=not-stored', privatePage: true });
  await h.clock.advance(59000); assert.equal(h.stats.opened.length, 0);
  await h.clock.advance(3000); assert.equal(h.stats.opened.length, 1);
  assert.deepEqual(h.stats.opened[0], { url: 'http://oa.example/oa.html/attendance/record', options: { active: true, insert: true } });
  assert.equal(h.stats.queries, 0); assert.equal(h.stats.navigation.length, 0);
  assert.ok(!JSON.stringify([...h.store]).includes('not-stored'));
});

test('多个普通网页 9 点后同时启动，只打开一张 OA', async () => {
  const clock = new Clock(); const store = new Map();
  const tabs = ['https://a.example/', 'http://b.example/', 'https://c.example/'].map((href) => harness({ clock, store, href }));
  await clock.advance(30000);
  assert.equal(tabs.reduce((count, tab) => count + tab.stats.opened.length, 0), 1);
  assert.equal(store.has('oa-attendance-v1:completedDay'), false);
});

test('已有活跃打卡记录页时复用；普通 OA 页面则新开且不导航原页面', async () => {
  const clock = new Clock(); const store = new Map();
  const web = harness({ clock, store, href: 'https://example.com/' });
  const record = harness({ clock, store });
  await clock.advance(3000);
  assert.equal(record.stats.queries, 1); assert.equal(web.stats.opened.length, 0);
  const form = harness({ href: 'http://oa.example/oa.html/apply/list' });
  await form.clock.advance(3000);
  assert.equal(form.stats.navigation.length, 0); assert.equal(form.stats.opened.length, 1);
});

test('已完成当天检查不再开页；手动菜单绕过去重和退避', async () => {
  const store = new Map([
    ['oa-attendance-v1:completedDay', '2026-09-26'],
    ['oa-attendance-v1:retryAt', Date.parse(NOW) + 900000],
  ]);
  const h = harness({ store, href: 'https://example.com/' });
  await h.clock.advance(3000); assert.equal(h.stats.opened.length, 0);
  h.manual(); await h.clock.advance(1000); assert.equal(h.stats.opened.length, 1);
  const opened = harness({ clock: h.clock, store, href: h.stats.opened[0].url });
  await h.clock.advance(1000);
  assert.equal(opened.stats.queries, 1);
  assert.equal(opened.dialogs().length, 1);
});

test('离线时不消费打开次数，联网事件恢复开页', async () => {
  const h = harness({ href: 'https://example.com/', online: false });
  await h.clock.advance(30000);
  assert.equal(h.stats.opened.length, 0); assert.equal(h.store.has('oa-attendance-v1:launch'), false);
  h.navigator.onLine = true; h.window.listeners.online();
  await h.clock.advance(3000); assert.equal(h.stats.opened.length, 1);
});

test('打开 API 抛错或未返回句柄，不标考勤完成，有限退避重试', async () => {
  for (const openTab of [() => { throw new Error('blocked'); }, () => null]) {
    const h = harness({ href: 'https://example.com/', openTab });
    await h.clock.advance(3000);
    assert.equal(h.stats.opened.length, 1); assert.equal(h.store.get('oa-attendance-v1:launch').confirmed, false);
    await h.clock.advance(60000); assert.equal(h.stats.opened.length, 1);
    await h.clock.advance(3000000); assert.equal(h.stats.opened.length, 3);
    assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
  }
});

test('开了标签但 OA 没加载也会有限重试，不能误标成功', async () => {
  const h = harness({ href: 'https://example.com/' });
  await h.clock.advance(3000); assert.equal(h.stats.opened.length, 1);
  await h.clock.advance(3000000); assert.equal(h.stats.opened.length, 3);
  assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
});

test('OA/SSO 确认已加载后，当天关闭也不反复自动重开', async () => {
  const clock = new Clock(); const store = new Map();
  const web = harness({ clock, store, href: 'https://example.com/' });
  await clock.advance(3000); assert.equal(web.stats.opened.length, 1);
  // 仅执行 SSO 启动确认，再把它新增的计时器移除，模拟随后关闭标签页。
  const originalJobs = new Set(clock.jobs.keys());
  harness({ clock, store, href: loginURL });
  for (const id of clock.jobs.keys()) if (!originalJobs.has(id)) clock.jobs.delete(id);
  assert.equal(store.get('oa-attendance-v1:launch').confirmed, true);
  await clock.advance(3600000); assert.equal(web.stats.opened.length, 1);
});

test('OA 的 SSO 登录过渡可阻止重复打开，无关 SSO 不读取登录表单', async () => {
  const clock = new Clock(); const store = new Map();
  const login = harness({ clock, store, href: loginURL });
  const web = harness({ clock, store, href: 'https://example.com/' });
  await clock.advance(5000); assert.equal(login.stats.logins, 1); assert.equal(web.stats.opened.length, 0);
  const other = harness({ href: 'https://sso.example/login?service=https%3A%2F%2Fother.example%2F', privatePage: true });
  await other.clock.advance(5000); assert.equal(other.stats.logins, 0); assert.equal(other.stats.opened.length, 1);
});

test('过期 presence 不永久阻止自动开页，跨日可重新启动', async () => {
  const store = new Map([
    ['oa-attendance-v1:presence', { owner: 'closed-tab', until: Date.parse(NOW) - 1 }],
    ['oa-attendance-v1:launch', { day: '2026-09-25', confirmed: true, at: Date.parse(NOW) - 86400000, attempts: 1 }],
    ['oa-attendance-v1:completedDay', '2026-09-25'],
  ]);
  const h = harness({ store, href: 'https://example.com/' }); await h.clock.advance(3000);
  assert.equal(h.stats.opened.length, 1); assert.equal(store.get('oa-attendance-v1:launch').day, '2026-09-26');
});

test('时间配置支持分钟，09:30 前手动检查不占用定时检查', async () => {
  const settings = { ...EXAMPLE_SETTINGS, minute: 30 };
  const clock = new Clock('2026-09-26T01:29:00Z');
  const h = harness({ settings, clock });
  h.manual(); await clock.advance(1000); assert.equal(h.stats.queries, 1);
  assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
  await clock.advance(61000); assert.equal(h.stats.queries, 2);
  const web = harness({ settings, clock: new Clock('2026-09-26T01:29:00Z'), href: 'https://example.com/' });
  await web.clock.advance(59000); assert.equal(web.stats.opened.length, 0);
  await web.clock.advance(3000); assert.equal(web.stats.opened.length, 1);
});

test('浏览器内部页面不运行调度，也不注册菜单', async () => {
  const h = harness({ href: 'chrome://newtab/' }); await h.clock.advance(60000);
  assert.equal(h.stats.opened.length, 0); assert.equal(h.stats.queries, 0); assert.equal(h.clock.jobs.size, 0);
  assert.equal(h.document.body.children.length, 0);
});

test('HTTP/HTTPS 其他域名显示悬浮入口，点击新开 OA 且不读取原网页内容', async () => {
  for (const href of ['https://example.com/private?secret=not-stored', 'http://another.example/']) {
    const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href, privatePage: true });
    const check = h.orb();
    assert.ok(check); assert.equal(check.hidden, false);
    assert.equal(check.textContent, 'OA');
    check.click(); check.click();
    assert.equal(check.getAttribute('aria-disabled'), 'true');
    assert.equal(check.disabled, false);
    assert.equal(h.check().disabled, true);
    await h.clock.advance(1000);
    assert.deepEqual(h.stats.opened, [{
      url: 'http://oa.example/oa.html/attendance/record#oa-attendance-check',
      options: { active: true, insert: true },
    }]);
    assert.equal(check.getAttribute('aria-disabled'), 'false');
    assert.equal(h.location.href, href); assert.equal(h.stats.navigation.length, 0);
    assert.equal(h.stats.queries, 0); assert.equal(h.dialogs().length, 0);
    assert.ok(!JSON.stringify([...h.store]).includes('not-stored'));
  }
});

test('手动入口只在新标签检查；9 点前或当天已完成时，旧 OA/SSO 页不能抢走触发', async () => {
  for (const completed of [false, true]) {
    const clock = new Clock(completed ? NOW : '2026-09-26T00:00:00Z');
    const store = new Map(completed ? [['oa-attendance-v1:completedDay', '2026-09-26']] : []);
    const oldRecord = harness({ clock, store });
    const oldLogin = harness({ clock, store, href: loginURL });
    const web = harness({ clock, store, href: 'https://example.com/' });
    web.orb().click(); await clock.advance(1000);
    oldRecord.window.listeners.focus(); oldLogin.window.listeners.focus();
    await clock.advance(1000);
    assert.equal(oldRecord.stats.queries, 0); assert.equal(oldLogin.stats.logins, 0);
    const opened = harness({ clock, store, href: web.stats.opened[0].url });
    await clock.advance(1000);
    assert.equal(opened.stats.queries, 1); assert.equal(opened.dialogs().length, 1);
    assert.equal(oldRecord.stats.queries, 0); assert.equal(oldRecord.dialogs().length, 0);
    assert.equal(store.has('oa-attendance-v1:pending'), false);
  }
});

test('已有 OA 查询持锁也能新开，新标签保留手动意图并在解锁后检查', async () => {
  const clock = new Clock('2026-09-26T00:00:00Z'); const store = new Map();
  let resolve;
  const old = harness({ clock, store, permission() {
    return new Promise((done) => { resolve = () => { this.query.userIds = [42]; done(); }; });
  } });
  old.manual(); await clock.advance(1000);
  const web = harness({ clock, store, href: 'https://example.com/' });
  web.orb().click(); await clock.advance(1000);
  assert.equal(web.stats.opened.length, 1);
  const opened = harness({ clock, store, href: web.stats.opened[0].url });
  await clock.advance(1000);
  assert.equal(opened.stats.queries, 0); assert.equal(opened.tabState.oaAttendancePending.manual, true);
  resolve(); await clock.advance(16000);
  assert.equal(old.stats.queries, 1); assert.equal(opened.stats.queries, 1);
  assert.equal(opened.dialogs().length, 1); assert.equal(opened.tabState.oaAttendancePending, null);
});

test('入口开页失败会提示且恢复按钮，可以再次点击', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href: 'https://example.com/', openTab: () => null });
  const check = h.orb();
  check.click(); await h.clock.advance(1000);
  assert.equal(h.stats.alerts.length, 1); assert.equal(check.getAttribute('aria-disabled'), 'false');
  assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
  check.click(); await h.clock.advance(1000);
  assert.equal(h.stats.opened.length, 2);
});

test('手动标记在 DOM 加载前绑定标签并清除，保留查询参数和 history.state', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'),
    href: 'http://oa.example/oa.html/attendance/record?view=mine#oa-attendance-check', readyState: 'loading' });
  assert.equal(h.tabState.oaAttendancePending.manual, true);
  assert.equal(h.location.href, 'http://oa.example/oa.html/attendance/record?view=mine');
  assert.deepEqual(h.window.history.state, { original: 'preserved' });
  assert.equal(h.stats.queries, 0); assert.equal(h.document.body.children.length, 0);
  h.document.listeners.DOMContentLoaded(); await h.clock.advance(1000);
  assert.equal(h.stats.queries, 1);
  const refreshed = harness({ clock: h.clock, store: h.store, href: h.location.href, tabState: h.tabState });
  await h.clock.advance(1000);
  assert.equal(refreshed.stats.queries, 0);
});

test('新标签手动意图跨 OA/SSO 登录恢复，不导航其他 OA 表单', async () => {
  const clock = new Clock('2026-09-26T00:00:00Z'); const store = new Map();
  for (const entryHref of ['http://oa.example/oa.html/attendance/record', loginURL]) {
    const entry = harness({ clock, store, href: entryHref + '#oa-attendance-check', readyState: 'loading' });
    assert.equal(entry.tabState.oaAttendancePending.manual, true);
    const login = harness({ clock, store, href: loginURL, tabState: entry.tabState });
    await clock.advance(4000);
    assert.equal(login.tabState.oaAttendancePending.returnToRecord, true);
    const form = harness({ clock, store, href: 'http://oa.example/oa.html/apply/list' });
    assert.equal(form.stats.navigation.length, 0);
    const returned = harness({ clock, store, href: 'http://oa.example/oa.html/home', tabState: login.tabState });
    assert.equal(returned.location.pathname, '/oa.html/attendance/record');
    returned.window.listeners.focus(); await clock.advance(1000);
    assert.equal(returned.stats.queries, 1); assert.equal(returned.dialogs().length, 1);
  }
});

test('无关网页和非 OA 登录不消费手动标记，也不接受旧共享触发状态', async () => {
  for (const href of ['https://example.com/#oa-attendance-check',
    'https://sso.example/login?service=https%3A%2F%2Fother.example%2F#oa-attendance-check']) {
    const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href, privatePage: true });
    await h.clock.advance(5000);
    assert.equal(h.location.href, href); assert.equal(h.stats.replaced.length, 0);
    assert.equal(h.tabState.oaAttendancePending, undefined); assert.equal(h.stats.logins, 0);
  }
  const clock = new Clock('2026-09-26T00:00:00Z');
  const store = new Map([['oa-attendance-v1:pending', { day: '2026-09-26', at: clock.now, manual: true, tabId: null }]]);
  const old = harness({ clock, store }); await clock.advance(5000);
  assert.equal(old.stats.queries, 0);
});

test('9 点前从其他域名手动检查并关闭 OA，不占用 9 点自动开页', async () => {
  const clock = new Clock('2026-09-26T00:00:00Z'); const store = new Map();
  const web = harness({ clock, store, href: 'https://example.com/' });
  web.orb().click(); await clock.advance(1000);
  const webJobs = new Set(clock.jobs.keys());
  const opened = harness({ clock, store, href: web.stats.opened[0].url });
  await clock.advance(1000); assert.equal(opened.stats.queries, 1);
  for (const id of clock.jobs.keys()) if (!webJobs.has(id)) clock.jobs.delete(id);
  assert.equal(store.has('oa-attendance-v1:launch'), false);
  assert.equal(store.has('oa-attendance-v1:completedDay'), false);
  await clock.advance(3600000);
  assert.equal(web.stats.opened.length, 2);
  assert.equal(web.stats.opened[1].url, 'http://oa.example/oa.html/attendance/record');
});

test('另一个标签恢复 OA 登录时，不会带走正在填写的申请页', async () => {
  const clock = new Clock(); const store = new Map();
  const form = harness({ clock, store, href: 'http://oa.example/oa.html/apply/list' });
  const login = harness({ clock, store, href: loginURL });
  await clock.advance(17000);
  assert.equal(login.stats.logins, 1);
  assert.equal(form.stats.navigation.length, 0);
  assert.equal(form.location.pathname, '/oa.html/apply/list');
  // 实际登录标签使用同一个 GM tabState，回到 OA 首页才能消费返回标记。
  const returned = harness({ clock, store, href: 'http://oa.example/oa.html/home', tabState: login.tabState });
  assert.equal(returned.location.pathname, '/oa.html/attendance/record');
});

test('多个 SSO 页的续查标记互不覆盖，实际登录标签仍能恢复记录页', async () => {
  const clock = new Clock(); const store = new Map();
  const a = harness({ clock, store, href: loginURL });
  const b = harness({ clock, store, href: loginURL });
  await clock.advance(17000);
  assert.equal(a.stats.logins + b.stats.logins, 1);
  const loggedIn = a.stats.logins ? a : b;
  const returned = harness({ clock, store, href: 'http://oa.example/oa.html/home', tabState: loggedIn.tabState });
  assert.equal(returned.location.pathname, '/oa.html/attendance/record');
});

test('OA 首页等待开页时切入记录页，旧 opener 不会释放进行中的检查锁', async () => {
  let resolve;
  const h = harness({ href: 'http://oa.example/oa.html/home', permission() {
    return new Promise((done) => { resolve = () => { this.query.userIds = [42]; done(); }; });
  } });
  await h.clock.advance(500);
  h.location.assign('/oa.html/attendance/record'); h.window.listeners.focus();
  await h.clock.advance(1000);
  assert.ok(h.store.get('oa-attendance-v1:lock')?.token);
  resolve(); await h.clock.advance(1000);
  assert.equal(h.stats.queries, 1);
  assert.equal(h.stats.opened.length, 0);
  assert.equal(h.store.get('oa-attendance-v1:completedDay'), '2026-09-26');
  assert.equal(h.store.has('oa-attendance-v1:retryAt'), false);
});


test('未配置时只提供本地配置入口，不打开 OA、不读取页面对象或登录表单', async () => {
  for (const href of ['https://example.com/', EXAMPLE_SETTINGS.recordUrl, loginURL]) {
    const h = harness({ href, settings: null, privatePage: true });
    await h.clock.advance(3600000);
    assert.equal(h.stats.opened.length, 0);
    assert.equal(h.stats.queries, 0);
    assert.equal(h.stats.logins, 0);
    assert.equal(h.store.has(SETTINGS_KEY), false);
    assert.equal(h.menus.has('配置 OA（仅保存在本机）'), true);
    assert.equal(h.stats.prompts.length, 0);
  }
});

test('配置拒绝含凭据、查询参数、片段和非 HTTP 协议的记录地址', () => {
  for (const recordUrl of [
    'http://user:secret@oa.example/oa.html/attendance/record',
    'http://user@oa.example/oa.html/attendance/record',
    'http://oa.example/oa.html/attendance/record?session=example',
    'http://oa.example/oa.html/attendance/record#section',
    'http://oa.example/oa.html/attendance/record?',
    'http://oa.example/oa.html/attendance/record#',
    'javascript:alert(1)',
    'file:///oa.html/attendance/record',
    'ftp://oa.example/oa.html/attendance/record',
  ]) {
    assert.throws(() => core.validateSettings({ ...EXAMPLE_SETTINGS, recordUrl }), recordUrl);
  }
});

test('配置拒绝非 origin 白名单、跨源申请入口和应用路径之外的记录地址', () => {
  for (const field of ['oaOrigins', 'loginOrigins']) {
    for (const origin of [
      'oa.example', '/oa.example', 'http://oa.example/path',
      'http://user:secret@oa.example', 'http://oa.example?session=example',
      'http://oa.example#section', 'ftp://oa.example',
    ]) {
      assert.throws(() => core.validateSettings({ ...EXAMPLE_SETTINGS, [field]: [origin] }), `${field}: ${origin}`);
    }
  }
  for (const applyPath of ['https://outside.example/apply', '//outside.example/apply']) {
    assert.throws(() => core.validateSettings({ ...EXAMPLE_SETTINGS, applyPath }), applyPath);
  }
  for (const recordUrl of [
    'http://oa.example/other/record', 'http://oa.example/oa.html-fake/record',
  ]) {
    assert.throws(() => core.validateSettings({ ...EXAMPLE_SETTINGS, recordUrl }), recordUrl);
  }
});

test('OA 识别按精确 origin 和应用路径匹配，不能扩大到子域、其他协议或端口', () => {
  const anotherConfig = core.validateSettings({ ...EXAMPLE_SETTINGS,
    recordUrl: 'http://other-oa.example/oa.html/attendance/record' });
  assert.ok(anotherConfig.oaOrigins.includes('http://other-oa.example'));
  assert.equal(core.isOA(new URL(anotherConfig.recordUrl), anotherConfig), true);
  assert.equal(core.isOA(new URL(anotherConfig.recordUrl), exampleConfig), false);
  for (const href of [
    'http://oa.example/oa.html', 'http://oa.example/oa.html/attendance/record',
    'http://oa.example:80/oa.html/home', 'http://alt-oa.example/oa.html/home',
  ]) {
    assert.equal(core.isOA(new URL(href), exampleConfig), true, href);
  }
  for (const href of [
    'https://oa.example/oa.html', 'http://oa.example:8080/oa.html',
    'http://sub.oa.example/oa.html', 'http://oa.example.evil.test/oa.html',
    'http://oa.example/oa.html-fake', 'http://oa.example/other',
  ]) {
    assert.equal(core.isOA(new URL(href), exampleConfig), false, href);
  }
  for (const origin of ['http://sso.example', 'https://sso.example:8443', 'https://sso.example.evil.test']) {
    const href = `${origin}/login?service=${encodeURIComponent(EXAMPLE_SETTINGS.recordUrl)}`;
    assert.equal(core.isOALogin(href, exampleConfig), false, href);
  }
});

test('脚本升级或重新加载保留既有本地配置，不写回示例设置', async () => {
  const saved = { ...EXAMPLE_SETTINGS, recordUrl: 'http://alt-oa.example/oa.html/attendance/record', hour: 10, minute: 45 };
  const store = new Map([[SETTINGS_KEY, structuredClone(saved)]]);
  const clock = new Clock();
  const first = harness({ clock, store, href: 'https://example.com/', privatePage: true });
  await clock.advance(3000);
  assert.deepEqual(store.get(SETTINGS_KEY), saved);
  assert.equal(first.stats.opened.length, 0);
  const updatedSource = source
    .replace(/(@version\s+)\S+/, (_, prefix) => `${prefix}9.9.9`)
    .replace(/(const SCRIPT_VERSION = ')[^']+/, (_, prefix) => `${prefix}9.9.9`);
  const refreshed = harness({ clock, store, href: 'https://example.com/', privatePage: true, script: updatedSource });
  await clock.advance(3000);
  assert.deepEqual(store.get(SETTINGS_KEY), saved);
  assert.equal(refreshed.stats.opened.length, 0);
});

test('有效配置只存油猴本地，提示刷新，当前页面暂停调度，刷新后才使用配置', async () => {
  const h = harness({ settings: null, href: 'https://example.com/', privatePage: true,
    promptResponses: [JSON.stringify(EXAMPLE_SETTINGS)] });
  await h.configure();
  await h.clock.advance(3600000);
  assert.deepEqual(core.validateSettings(h.store.get(SETTINGS_KEY)), exampleConfig);
  assert.equal(h.stats.prompts.length, 1);
  assert.ok(h.stats.alerts.some((message) => /刷新/.test(message)));
  assert.equal(h.stats.opened.length, 0);
  assert.equal(h.stats.queries, 0);
  assert.equal(h.stats.logins, 0);
  const refreshed = harness({ clock: h.clock, store: h.store, tabState: h.tabState,
    href: 'https://example.com/', privatePage: true });
  await h.clock.advance(3000);
  assert.equal(refreshed.stats.opened.length, 1);
  assert.equal(refreshed.stats.opened[0].url, EXAMPLE_SETTINGS.recordUrl);
  assert.equal(h.stats.opened.length, 0);
});

test('已有配置修改后旧页面不再按旧地址调度，新页面使用新地址', async () => {
  const settings = { ...EXAMPLE_SETTINGS, recordUrl: 'http://alt-oa.example/oa.html/attendance/record' };
  const clock = new Clock('2026-09-26T00:59:00Z');
  const h = harness({ clock, href: 'https://example.com/', privatePage: true,
    promptResponses: [JSON.stringify(settings)] });
  await h.configure();
  await clock.advance(62000);
  assert.equal(h.stats.opened.length, 0);
  assert.equal(h.store.get(SETTINGS_KEY).recordUrl, settings.recordUrl);
  const refreshed = harness({ clock, store: h.store, href: 'https://example.com/', privatePage: true });
  await clock.advance(3000);
  assert.equal(refreshed.stats.opened[0].url, settings.recordUrl);
  assert.equal(h.stats.opened.length, 0);
});

test('取消或提交无效配置不覆盖已有设置', async () => {
  for (const answer of [null, '{invalid json', JSON.stringify({ ...EXAMPLE_SETTINGS, recordUrl: 'javascript:alert(1)' })]) {
    const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href: 'https://example.com/',
      privatePage: true, promptResponses: [answer] });
    await h.configure();
    assert.deepEqual(h.store.get(SETTINGS_KEY), EXAMPLE_SETTINGS);
    assert.equal(h.stats.opened.length, 0);
    if (answer === null) assert.equal(h.stats.alerts.length, 0);
    else assert.ok(h.stats.alerts.length > 0);
  }
});


test('空配置保持未配置状态，拒绝未知字段以防持久保存凭据', () => {
  assert.equal(core.validateSettings(null), null);
  assert.equal(core.validateSettings(undefined), null);
  for (const field of ['username', 'password', 'cookie', 'token']) {
    assert.throws(() => core.validateSettings({ ...EXAMPLE_SETTINGS, [field]: 'placeholder' }), field);
  }
});

test('发布元数据与完整脚本头一致，版本和公开更新地址对应同一仓库', () => {
  const header = source.match(/^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==/m)?.[0];
  assert.ok(header);
  const meta = fs.readFileSync(require.resolve('../oa-attendance-reminder.meta.js'), 'utf8').trim();
  assert.equal(meta, header);
  const fields = Object.fromEntries([...header.matchAll(/^\/\/\s+@(namespace|version|homepageURL|updateURL|downloadURL)\s+(.+)$/gm)]
    .map((match) => [match[1], match[2]]));
  const scriptVersion = source.match(/const SCRIPT_VERSION = '([^']+)';/)?.[1];
  assert.match(scriptVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(fields.version, scriptVersion);
  const repository = new URL(fields.namespace);
  assert.equal(repository.protocol, 'https:');
  assert.equal(repository.hostname, 'github.com');
  assert.equal(fields.homepageURL, repository.href);
  const rawBase = `https://raw.githubusercontent.com${repository.pathname}/main/`;
  assert.equal(fields.updateURL, rawBase + 'oa-attendance-reminder.meta.js');
  assert.equal(fields.downloadURL, rawBase + 'oa-attendance-reminder.user.js');
});


test('OA 应用和记录页位于根路径时仍可在当前页手动检查', async () => {
  const settings = { ...EXAMPLE_SETTINGS, recordUrl: 'http://oa.example/', oaPath: '/', applyPath: '/apply' };
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), settings, href: settings.recordUrl });
  h.manual(); await h.clock.advance(1000);
  assert.equal(h.stats.queries, 1);
  assert.equal(h.dialogs().length, 1);
  assert.equal(h.stats.opened.length, 0);
  assert.equal(h.location.pathname, '/');
  assert.equal(h.store.has('oa-attendance-v1:completedDay'), false);
});

test('无效登录按钮 CSS 选择器给出可修正提示，不点击登录也不消费尝试次数', async () => {
  const settings = { ...EXAMPLE_SETTINGS, loginButtonSelector: '[' };
  const h = harness({ settings, href: loginURL, querySelectorError: new SyntaxError('Invalid CSS selector') });
  await h.clock.advance(5000);
  assert.match(h.text(), /登录按钮配置无效/);
  assert.match(h.text(), /油猴菜单/);
  assert.equal(h.stats.logins, 0);
  assert.equal(h.store.has('oa-attendance-v1:loginAttemptDay'), false);
  await h.clock.advance(30000);
  assert.equal(h.stats.logins, 0);
  assert.equal(h.stats.queries, 0);
});

function dragWidget(h, dx, dy, end = 'pointerup') {
  const start = h.position();
  const point = { clientX: start.x + 28, clientY: start.y + 28 };
  h.orb().emit('pointerdown', point);
  h.orb().emit('pointermove', { clientX: point.clientX + dx, clientY: point.clientY + dy });
  h.orb().emit(end, { clientX: point.clientX + dx, clientY: point.clientY + dy, buttons: 0 });
}

function tapWidget(h) {
  const position = h.position();
  const point = { clientX: position.x + 28, clientY: position.y + 28 };
  h.orb().emit('pointerdown', point);
  h.orb().emit('pointerup', { ...point, buttons: 0 });
  h.orb().click();
}

test('拖动普通网页入口不查询或开页，抑制拖动后的 click，下一次正常点击仍有效', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'),
    href: 'https://example.com/private?value=not-stored', privatePage: true });
  assert.deepEqual(h.position(), { x: 1204, y: 724 });
  dragWidget(h, -204, -224);
  assert.ok(Math.abs(h.position().x - 1000) < 1e-8);
  assert.ok(Math.abs(h.position().y - 500) < 1e-8);
  h.orb().click(); await h.clock.advance(1000);
  assert.equal(h.stats.opened.length, 0);
  assert.equal(h.stats.queries, 0);
  assert.equal(h.stats.logins, 0);
  const saved = h.store.get(POSITION_KEY);
  assert.deepEqual(Object.keys(saved).sort(), ['x', 'y']);
  assert.ok(saved.x > 0 && saved.x < 1 && saved.y > 0 && saved.y < 1);
  assert.ok(!JSON.stringify(saved).includes('not-stored'));
  assert.equal(h.orb().hasPointerCapture(1), false);
  tapWidget(h); await h.clock.advance(1000);
  assert.equal(h.stats.opened.length, 1);
  assert.match(h.stats.opened[0].url, /#oa-attendance-check$/);
});

test('归一化位置跨网页恢复，复位按钮清除记忆并回到右下角', async () => {
  const store = new Map([[POSITION_KEY, { x: 0.25, y: 0.75 }]]);
  const clock = new Clock('2026-09-26T00:00:00Z');
  const first = harness({ clock, store, href: 'https://first.example/' });
  assert.deepEqual(first.position(), { x: 316, y: 548 });
  dragWidget(first, 120, -80);
  const saved = structuredClone(store.get(POSITION_KEY));
  const next = harness({ clock, store, href: 'https://second.example/', privatePage: true });
  assert.deepEqual(next.position(), first.position());
  assert.deepEqual(store.get(POSITION_KEY), saved);
  next.reset().click();
  assert.equal(store.has(POSITION_KEY), false);
  assert.deepEqual(next.position(), { x: 1204, y: 724 });
  await clock.advance(1000);
  assert.equal(next.stats.opened.length, 0);
});

test('拖动限制在视口内，resize 使用相对位置且极小视口不会产生 NaN', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href: 'https://example.com/' });
  dragWidget(h, -10000, -10000);
  assert.deepEqual(h.position(), { x: 20, y: 20 });
  assert.deepEqual(h.store.get(POSITION_KEY), { x: 0, y: 0 });
  dragWidget(h, 10000, 10000);
  assert.deepEqual(h.position(), { x: 1204, y: 724 });
  assert.deepEqual(h.store.get(POSITION_KEY), { x: 1, y: 1 });
  h.resize(320, 240); await h.clock.advance(50);
  assert.deepEqual(h.position(), { x: 244, y: 164 });
  h.resize(80, 72); await h.clock.advance(50);
  assert.deepEqual(h.position(), { x: 12, y: 8 });
  h.resize(1280, 800); await h.clock.advance(50);
  assert.deepEqual(h.position(), { x: 1204, y: 724 });
  assert.equal(h.stats.opened.length, 0);
});

test('pointercancel 和捕获丢失撤销拖动，不保存临时位置，也不触发检查', async () => {
  for (const end of ['pointercancel', 'lostpointercapture']) {
    const store = new Map([[POSITION_KEY, { x: 0.25, y: 0.75 }]]);
    const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), store, href: 'https://example.com/' });
    const original = h.position();
    dragWidget(h, 100, -100, end);
    await h.clock.advance(1000);
    assert.deepEqual(h.position(), original, end);
    assert.deepEqual(store.get(POSITION_KEY), { x: 0.25, y: 0.75 }, end);
    assert.equal(h.stats.opened.length, 0, end);
    assert.equal(h.stats.queries, 0, end);
    tapWidget(h); await h.clock.advance(1000);
    assert.equal(h.stats.opened.length, 1, end);
  }
});

test('小于拖动阈值的指针移动仍按普通点击处理，不写位置记忆', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href: 'https://example.com/' });
  dragWidget(h, -3, -4);
  h.orb().click(); await h.clock.advance(1000);
  assert.equal(h.stats.opened.length, 1);
  assert.equal(h.store.has(POSITION_KEY), false);
  assert.deepEqual(h.position(), { x: 1204, y: 724 });
});

test('正在查询时 orb 保持可拖动，点击不会重复查询，主按钮仍禁用', async () => {
  let resolve;
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), permission() {
    return new Promise((done) => { resolve = () => { this.query.userIds = [42]; done(); }; });
  } });
  h.manual(); await h.clock.advance(1000);
  assert.equal(h.orb().disabled, false);
  assert.equal(h.orb().getAttribute('aria-disabled'), 'true');
  assert.equal(h.check().disabled, true);
  dragWidget(h, -100, -100);
  assert.deepEqual(h.position(), { x: 1104, y: 624 });
  h.orb().click(); tapWidget(h);
  await h.clock.advance(1000);
  assert.equal(h.stats.opened.length, 0);
  assert.equal(h.stats.queries, 0);
  resolve(); await h.clock.advance(1000);
  assert.equal(h.stats.queries, 1);
  assert.equal(h.orb().getAttribute('aria-disabled'), 'false');
});

test('SSO 页面隐藏查询按钮但保留可拖动的 orb，不因拖动再开 OA 或重复登录', async () => {
  const h = harness({ href: loginURL });
  await h.clock.advance(4000);
  assert.equal(h.stats.logins, 1);
  assert.equal(h.check().hidden, true);
  assert.equal(h.orb().hidden, false);
  assert.equal(h.orb().disabled, false);
  dragWidget(h, -100, -100);
  h.orb().click(); await h.clock.advance(1000);
  assert.deepEqual(h.position(), { x: 1104, y: 624 });
  assert.equal(h.stats.opened.length, 0);
  assert.equal(h.stats.logins, 1);
});

test('Alt 方向键移动 10px，Shift 加速为 40px，普通方向键不改位置', () => {
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href: 'https://example.com/' });
  const moved = h.orb().emit('keydown', { key: 'ArrowLeft', altKey: true });
  assert.equal(moved.defaultPrevented, true);
  assert.deepEqual(h.position(), { x: 1194, y: 724 });
  h.orb().emit('keydown', { key: 'ArrowUp', altKey: true, shiftKey: true });
  assert.deepEqual(h.position(), { x: 1194, y: 684 });
  h.orb().emit('keydown', { key: 'ArrowRight' });
  assert.deepEqual(h.position(), { x: 1194, y: 684 });
  assert.ok(h.store.get(POSITION_KEY).x < 1);
  assert.equal(h.stats.opened.length, 0);
});

test('信息层的设置入口调用本地配置交互，不打开 OA', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href: 'https://example.com/', promptResponses: [null] });
  h.settingsButton().click(); await h.clock.advance(1000);
  assert.equal(h.stats.prompts.length, 1);
  assert.equal(h.stats.opened.length, 0);
  assert.deepEqual(h.store.get(SETTINGS_KEY), EXAMPLE_SETTINGS);
});

test('Escape 关闭信息卡并保持关闭，重新进入组件后可以再次展开', async () => {
  const h = harness({ clock: new Clock('2026-09-26T00:00:00Z'), href: 'https://example.com/' });
  h.panel().emit('pointerenter');
  assert.equal(h.panel().getAttribute('data-dismissed'), 'false');
  const dismissed = h.panel().emit('keydown', { key: 'Escape' });
  assert.equal(dismissed.defaultPrevented, true);
  assert.equal(h.panel().getAttribute('data-dismissed'), 'true');
  await h.clock.advance(1000);
  assert.equal(h.panel().getAttribute('data-dismissed'), 'true');
  h.panel().emit('pointerenter');
  assert.equal(h.panel().getAttribute('data-dismissed'), 'false');
  assert.equal(h.stats.opened.length, 0);
  assert.equal(h.stats.queries, 0);
});
