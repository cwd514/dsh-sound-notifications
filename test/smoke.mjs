/**
 * Sandbox smoke test for the dsh-sound-notifications client half.
 *
 * Loads client.js in a Node `vm` context with browser stubs and exercises the
 * real logic: declarations, event wiring, tone scheduling, the notification
 * gates, waterfall pass-through with auto-close, persistence, and rendering of
 * both settings rows. No browser and no network are involved.
 *
 * Run: node test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const FILE = fileURLToPath(new URL('../client.js', import.meta.url));
const code = readFileSync(FILE, 'utf8');
console.log(`client.js: ${FILE} (${code.split('\n').length} lines, ${Buffer.byteLength(code)} bytes)`);

const listeners = new Map();
const registrations = [];
const injections = [];
const notifications = [];
const store = new Map();
const errors = [];

// ---------------------------------------------------------------- browser stubs
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};

class FakeNotification {
  static permission = 'default';
  static requestPermission(cb) {
    FakeNotification.permission = 'granted';
    if (typeof cb === 'function') cb('granted');
    return Promise.resolve('granted');
  }
  constructor(title, options) {
    this.title = title;
    this.options = options || {};
    this.closed = false;
    notifications.push(this);
  }
  close() {
    this.closed = true;
  }
}

const paint = {
  beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {}, closePath() {},
  set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {}, set lineCap(_v) {},
};
const canvas = { width: 0, height: 0, getContext: () => paint, toDataURL: () => 'data:image/png;base64,STUB' };

const documentStub = {
  visibilityState: 'hidden',
  hasFocus: () => false,
  createElement: (tag) => (tag === 'canvas' ? canvas : { dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
};

const audio = {
  state: 'running',
  currentTime: 0,
  destination: {},
  createGain: () => ({
    gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {} },
    connect() {},
  }),
  createOscillator: () => ({
    type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {},
  }),
  resume: () => Promise.resolve(),
};

let loaded = null;
const windowStub = {
  isSecureContext: true,
  localStorage,
  document: documentStub,
  AudioContext: function AudioContext() { return audio; },
  Notification: FakeNotification,
  addEventListener() {},
  removeEventListener() {},
  focus() {},
  __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, entry: factory(requireStub) }; } },
};

const ReactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
};

function requireStub(name) {
  if (name === 'react') return ReactStub;
  throw new Error('unexpected require: ' + name);
}

const sandbox = {
  window: windowStub,
  document: documentStub,
  console: {
    error: (...args) => errors.push(args.map(String).join(' ')),
    warn: () => {},
    log: () => {},
  },
  Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Set, Map, Error, RegExp, Symbol,
  isFinite, parseInt, parseFloat,
};
vm.runInNewContext(code, sandbox, { filename: FILE });

assert.ok(loaded !== null, 'the module loader received the plugin');
assert.equal(loaded.id, '@local/dsh-sound');

// ------------------------------------------------------------------- plugin ctx
const ctx = {
  locale: {
    bind: () => (key) => key,
    register: () => () => {},
  },
  effect: (fn) => {
    const disposer = fn();
    return () => { if (typeof disposer === 'function') disposer(); };
  },
  remote: {
    $on: (event, listener) => {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
  },
  slots: {
    inject: (key, callback) => { injections.push({ key, dispose: callback() }); return () => {}; },
    register: (options, component) => { registrations.push({ options, component }); return () => {}; },
  },
};

loaded.entry.apply(ctx);
const api = windowStub.__dshSound;

const results = [];
const pending = [];
const check = (name, fn) => {
  const record = (error) => {
    results.push(error ? ['FAIL', `${name} — ${error.message}`] : ['ok', name]);
  };
  try {
    const value = fn();
    if (value !== null && typeof value === 'object' && typeof value.then === 'function') {
      pending.push(value.then(() => record(null), record));
      return;
    }
    record(null);
  } catch (error) {
    record(error);
  }
};

// 1. declarations
check('injects the three services it uses', () => assert.deepEqual([...loaded.entry.inject], ['slots', 'locale', 'remote']));
check('registers both settings rows, sound first', () => {
  assert.deepEqual(registrations.map((r) => r.options.id), ['dsh-sound', 'dsh-sound-notify']);
  assert.deepEqual(registrations.map((r) => r.options.order), [25, 26]);
  assert.ok(registrations.every((r) => r.options.name === 'settings.general.item'));
  assert.ok(registrations.every((r) => r.options.locale === 'dsh-sound'));
  assert.ok(registrations.every((r) => typeof r.component === 'function'));
  assert.equal(injections.length, 2);
  assert.ok(injections.every((i) => i.key === 'settings.general.item'));
});

// 2. event wiring
check('subscribes to exactly the eight events it uses', () => {
  const expected = [
    'api-session/status', 'api-session/error', 'approval/request', 'user-questions/request',
    'deepseek-account/session-expired', 'deepseek-account/model-sign-in-required',
    'goal/activation-changed', 'schedule/changed',
  ];
  for (const event of expected) assert.ok(listeners.has(event), 'missing listener: ' + event);
  assert.deepEqual([...listeners.keys()].sort(), [...expected].sort());
});
check('both rows render without throwing', () => {
  const soundTree = registrations[0].component({ t: (key) => key });
  const notifyTree = registrations[1].component({ t: (key) => key });
  assert.equal(typeof soundTree.type, 'string');
  assert.equal(typeof notifyTree.type, 'string');
  const flat = JSON.stringify(notifyTree, (key, value) => (typeof value === 'function' ? 'fn' : value));
  assert.ok(flat.includes('notify.permission.ask'), 'the ask-permission button is rendered by default');
});
check('the hook exposes both surfaces', () => {
  for (const key of ['play', 'settings', 'set', 'lastPlayed', 'state',
    'notify', 'notifySupported', 'notifyPermission', 'requestNotifyPermission',
    'notifySettings', 'setNotify', 'lastNotified', 'closeNotifications']) {
    assert.ok(key in api, 'missing hook member: ' + key);
  }
  assert.equal(api.version, '0.2.0');
  assert.equal(api.state().supported, true);
});

// 3. tones
check('a completion plays the done tone and logs it', () => {
  listeners.get('api-session/status')('session-1', false);
  const log = api.lastPlayed();
  assert.equal(log.length, 1);
  assert.equal(log[0].kind, 'done');
  assert.equal(log[0].scheduled, true);
});
check('an error plays the error tone', () => {
  listeners.get('api-session/error')('session-1', 'boom');
  assert.equal(api.lastPlayed().at(-1).kind, 'error');
});
check('sound settings persist through the store', () => {
  api.set({ volume: 20, events: { error: false } });
  const saved = JSON.parse(store.get('dsh.sound.v1'));
  assert.equal(saved.volume, 20);
  assert.equal(saved.events.error, false);
  assert.equal(saved.events.done, true);
  assert.equal(api.settings().volume, 20);
});

// 4. notification gates
check('notifications stay off by default and say why', () => {
  listeners.get('api-session/status')('session-1', false);
  const last = api.lastNotified().at(-1);
  assert.equal(last.kind, 'done');
  assert.equal(last.shown, false);
  assert.equal(last.reason, 'off');
  assert.equal(notifications.length, 0);
});
check('enabling notifications persists the switch', () => {
  api.setNotify({ enabled: true });
  assert.equal(JSON.parse(store.get('dsh.notify.v1')).enabled, true);
  assert.equal(FakeNotification.permission, 'default');
});
check('requesting permission resolves to the live state', async () => {
  assert.equal(await api.requestNotifyPermission(), 'granted');
  assert.equal(api.notifyPermission(), 'granted');
  assert.equal(api.notifySettings().enabled, true);
});
check('a hidden window shows the banner with the right options', () => {
  listeners.get('api-session/status')('session-1', false);
  const banner = notifications.at(-1);
  assert.ok(banner, 'a notification was constructed');
  assert.equal(banner.title, 'DSH · notify.kinds.done');
  assert.equal(banner.options.body, 'notify.body.done');
  assert.equal(banner.options.tag, 'dsh-sound:done');
  assert.equal(banner.options.icon, 'data:image/png;base64,STUB');
  assert.equal(banner.options.silent, false);
  assert.equal(banner.options.requireInteraction, false);
  assert.equal(api.lastNotified().at(-1).shown, true);
});
check('a focused visible window suppresses the banner', () => {
  const before = notifications.length;
  documentStub.visibilityState = 'visible';
  documentStub.hasFocus = () => true;
  listeners.get('api-session/status')('session-1', false);
  assert.equal(notifications.length, before);
  assert.equal(api.lastNotified().at(-1).reason, 'visible');
  // A hidden tab notifies even while the document still reports focus.
  documentStub.visibilityState = 'hidden';
  listeners.get('api-session/status')('session-1', false);
  assert.equal(notifications.length, before + 1);
  assert.equal(api.lastNotified().at(-1).shown, true);
  documentStub.hasFocus = () => false;
});
check('osSound off turns the banner silent and keeps the body', () => {
  api.setNotify({ osSound: false });
  api.notify('error', 'boom');
  const banner = notifications.at(-1);
  assert.equal(banner.options.silent, true);
  assert.equal(banner.options.body, 'boom');
});
check('approval is sticky and a bare console preview carries the test body', () => {
  api.notify('approval');
  const banner = notifications.at(-1);
  assert.equal(banner.options.requireInteraction, true);
  assert.equal(banner.title, 'DSH · notify.kinds.approval');
  assert.equal(banner.options.body, 'notify.body.test');
});

// 5. waterfalls
check('approval waterfall returns the chain promise and closes on answer', async () => {
  let resolveAnswer = null;
  const chain = new Promise((resolve) => { resolveAnswer = resolve; });
  let called = 0;
  const returned = listeners.get('approval/request')({ toolName: 'shell', displayReason: 'run ls' }, () => {
    called += 1;
    return chain;
  });
  assert.equal(called, 1, 'next() was called');
  assert.equal(returned, chain, 'the chain promise is handed back untouched');
  const banner = notifications.at(-1);
  assert.equal(banner.options.body, 'shell — run ls');
  assert.equal(banner.closed, false);
  resolveAnswer('approved');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(banner.closed, true, 'the banner closes when the answer arrives');
});
check('question waterfall passes through and uses the question text', async () => {
  let resolveAnswer = null;
  const chain = new Promise((resolve) => { resolveAnswer = resolve; });
  const returned = listeners.get('user-questions/request')({ questions: [{ question: 'Which file?' }] }, () => chain);
  assert.equal(returned, chain);
  assert.equal(notifications.at(-1).options.body, 'Which file?');
  resolveAnswer({});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(notifications.at(-1).closed, true);
});
check('a waterfall without next() still returns undefined', () => {
  assert.equal(listeners.get('approval/request')({}, undefined), undefined);
  assert.equal(listeners.get('user-questions/request')({}, undefined), undefined);
});

// 6. the remaining kinds
check('auth and goal events notify; schedule is off by default', () => {
  const before = notifications.length;
  listeners.get('deepseek-account/session-expired')();
  listeners.get('deepseek-account/model-sign-in-required')();
  listeners.get('goal/activation-changed')({ sessionId: 's', goal: { id: 'g', revision: 1, activation: 'armed' } });
  listeners.get('goal/activation-changed')({ sessionId: 's', goal: { id: 'g', revision: 2, activation: 'disarmed' } });
  listeners.get('goal/activation-changed')({ sessionId: 's' });
  listeners.get('schedule/changed')();
  assert.equal(notifications.length, before + 4, 'four banners: the goal clear is silent, schedule defaults off');
  assert.equal(api.notifySettings().events.schedule, false);
  assert.equal(api.lastNotified().at(-1).kind, 'schedule');
  assert.equal(api.lastNotified().at(-1).reason, 'kind-off');
});
check('turning the schedule kind on makes it fire', () => {
  api.setNotify({ events: { schedule: true } });
  const before = notifications.length;
  listeners.get('schedule/changed')();
  assert.equal(notifications.length, before + 1);
  assert.equal(notifications.at(-1).options.body, 'notify.body.schedule');
});
check('a disabled kind stays silent for real events too', () => {
  api.setNotify({ events: { done: false } });
  const before = notifications.length;
  listeners.get('api-session/status')('session-1', false);
  assert.equal(notifications.length, before);
  assert.equal(api.lastNotified().at(-1).reason, 'kind-off');
  api.setNotify({ events: { done: true } });
});
check('long error text is truncated', () => {
  listeners.get('api-session/error')('s', 'x'.repeat(400));
  const body = notifications.at(-1).options.body;
  assert.equal(body.length, 160);
  assert.ok(body.endsWith('…'));
});

// 7. teardown
check('the hook closes live banners when it is disposed', () => {
  const live = api.closeNotifications();
  assert.ok(live >= 0);
  assert.ok(notifications.every((n) => n.closed));
});

await Promise.all(pending);
for (const [status, name] of results) console.log(status.padEnd(4), name);
console.log('---');
console.log('console.error calls:', errors.length ? errors : 'none');
const failed = results.filter(([status]) => status === 'FAIL');
console.log(failed.length === 0
  ? `ALL ${results.length} CHECKS PASSED`
  : `${failed.length} OF ${results.length} CHECK(S) FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
