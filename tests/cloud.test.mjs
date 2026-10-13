import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSync, SupabaseClient, cloudSnapshot, connectionSettings } from '../cloud.js';
import * as store from '../store.js';
import { hasUserContentChanges } from '../sync-core.js';

const CONFIG = { configured: true, url: 'https://project.supabase.co', key: 'sb_publishable_test', project: 'project.supabase.co' };
const USER = { id: 'account-a', email: 'person@example.com' };
const clone = value => structuredClone(value);
const task = (id, title = id) => ({ id, title, date: '2026-10-13', time: '09:00', duration: 25, category: '成长', priority: 'normal', done: false });
const blank = () => store.createEmptyState();
const contentEqual = (actual, expected) => assert.equal(hasUserContentChanges(cloudSnapshot(expected), cloudSnapshot(actual)), false);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

class MemoryStorage {
  constructor() { this.values = new Map(); this.events = []; this.failKey = null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) {
    if (this.failKey && key.includes(this.failKey)) throw new Error('Quota exceeded');
    this.events.push({ kind: 'storage-write', key, value: String(value) });
    this.values.set(key, String(value));
  }
  removeItem(key) { this.values.delete(key); }
}

class FakeClient {
  constructor(state = null, revision = 0) {
    this.row = { state: state ? cloudSnapshot(state) : null, revision, updated_at: null };
    this.session = { user: USER };
    this.reads = 0; this.writes = []; this.readError = null; this.writeError = null;
    this.beforeWrite = null; this.beforeRead = null; this.logoutCount = 0;
  }
  async currentUser() { return USER; }
  async readWorkspace() { this.reads++; if (this.readError) throw this.readError; if (this.beforeRead) await this.beforeRead(); return clone(this.row); }
  async writeWorkspace(state, revision) {
    this.writes.push({ state: clone(state), revision });
    if (this.beforeWrite) await this.beforeWrite(state, revision);
    if (this.writeError) throw this.writeError;
    if (revision !== this.row.revision) return { ...clone(this.row), applied: false };
    this.row = { state: clone(state), revision: revision + 1, updated_at: '2026-10-13T09:00:00Z' };
    return { ...clone(this.row), applied: true };
  }
  async logout() { this.logoutCount++; this.session = null; }
}

function setup(t, { remote = null, revision = 0, local = null, base = null, guest = null } = {}) {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  store.setStorageScope();
  if (guest) storage.setItem(store.GUEST_STORAGE_KEY, JSON.stringify(guest));
  let state = store.loadState();
  const client = new FakeClient(remote, revision);
  const notifications = [];
  const replacements = [];
  if (local) {
    store.setStorageScope(USER.id, CONFIG.project);
    storage.setItem(store.STORAGE_KEY, JSON.stringify(local));
    store.setStorageScope();
  }
  const metaKey = `life-os.cloud.sync.v1.${CONFIG.project}.${USER.id}`;
  if (base) storage.setItem(metaKey, JSON.stringify({ revision, base: cloudSnapshot(base), lastSync: null }));
  const sync = new CloudSync({ config: CONFIG, client, storage, getState: () => state, replaceState: next => { state = next; replacements.push(clone(next)); }, notify: (...args) => notifications.push(args) });
  t.after(() => { sync.destroy(); store.setStorageScope(); });
  return {
    storage, client, sync, notifications, replacements, metaKey,
    get state() { return state; },
    activate(user = USER) { sync.activate(user); },
    edit(change, schedule = true) { change(state); store.saveState(state); if (schedule) { sync.schedulePush(); clearTimeout(sync.debounce); } },
  };
}

test('first empty cloud account creates an empty workspace without uploading guest examples', async t => {
  const guest = blank(); guest.tasks.push(task('private-guest')); guest.timer.running = true; guest.timer.endsAt = Date.now() + 10000;
  const h = setup(t, { guest });
  h.activate();
  assert.deepEqual(h.state.tasks, []);
  assert.equal(h.state.timer.running, false);
  await h.sync.sync();
  assert.equal(h.client.writes.length, 1);
  assert.deepEqual(h.client.row.state.tasks, []);
  assert.equal(Object.hasOwn(h.client.row.state, 'timer'), false);
  assert.equal(h.sync.info().phase, 'synced');
  assert.equal(h.sync.pending, false);
  assert.equal(JSON.parse(h.storage.getItem(store.GUEST_STORAGE_KEY)).tasks[0].id, 'private-guest');
});

test('first login to existing cloud brings cloud content only, with a fresh device timer', async t => {
  const remote = blank(); remote.tasks.push(task('cloud-only'));
  const guest = blank(); guest.tasks.push(task('guest-only'));
  const h = setup(t, { remote, revision: 2, guest }); h.activate();
  await h.sync.sync();
  assert.deepEqual(h.state.tasks.map(item => item.id), ['cloud-only']);
  assert.equal(h.client.writes.length, 0);
  assert.equal(h.state.timer.remaining, 1500);
  assert.equal(h.sync.meta.revision, 2);
});

test('guest content joins an account only after explicit import and does not bring its timer', async t => {
  const guest = blank(); guest.tasks.push(task('explicit-guest')); guest.timer.running = true; guest.timer.endsAt = Date.now() + 100000;
  const remote = blank(); remote.tasks.push(task('account-content'));
  const h = setup(t, { guest, remote, revision: 1 }); h.activate(); await h.sync.sync();
  assert.deepEqual(h.state.tasks.map(item => item.id), ['account-content']);
  await h.sync.importGuest(); clearTimeout(h.sync.debounce); await h.sync.sync();
  assert.deepEqual(new Set(h.state.tasks.map(item => item.id)), new Set(['account-content', 'explicit-guest']));
  assert.equal(h.state.timer.running, false);
  assert.equal(JSON.parse(h.storage.getItem(store.GUEST_STORAGE_KEY)).timer.running, true);
  assert.equal(Object.hasOwn(h.client.row.state, 'timer'), false);
});

test('different task additions on offline local and remote devices both survive', async t => {
  const base = blank(); base.tasks.push(task('shared'));
  const local = clone(base); local.tasks.push(task('offline-local'));
  const remote = clone(base); remote.tasks.push(task('new-remote'));
  const h = setup(t, { local, base, remote, revision: 4 }); h.activate();
  assert.equal(h.sync.pending, true);
  await h.sync.sync();
  assert.deepEqual(new Set(h.state.tasks.map(item => item.id)), new Set(['shared', 'offline-local', 'new-remote']));
  contentEqual(h.state, h.client.row.state);
  assert.equal(h.sync.pending, false);
});

test('remote entity deletions propagate without resurrection from stale local snapshots', async t => {
  const base = blank(); base.tasks.push(task('removed'), task('retained'));
  const local = clone(base); local.tasks[1].title = 'Local independent change';
  const remote = clone(base); remote.tasks.shift();
  const h = setup(t, { local, base, remote, revision: 3 }); h.activate(); await h.sync.sync();
  assert.deepEqual(h.state.tasks.map(item => item.id), ['retained']);
  assert.equal(h.state.tasks[0].title, 'Local independent change');
  assert.equal(h.client.row.state.tasks.length, 1);
});

test('conflicting content is durably backed up before any cloud write or local replacement', async t => {
  const base = blank(); base.tasks.push(task('shared', 'Original'));
  const local = clone(base); local.tasks[0].title = 'Offline writing'; local.tasks[0].done = true;
  const remote = clone(base); remote.tasks[0].title = 'Remote writing';
  const h = setup(t, { base, local, remote, revision: 5 }); h.activate();
  h.client.beforeWrite = async () => {
    const conflicts = JSON.parse(h.storage.getItem(`${h.metaKey}.conflicts`));
    assert.equal(conflicts[0].local.title, 'Offline writing');
    assert.equal(conflicts[0].remote.title, 'Remote writing');
    assert.equal(h.state.tasks[0].title, 'Offline writing');
  };
  await h.sync.sync();
  assert.equal(h.state.tasks[0].title, 'Remote writing');
  assert.equal(h.state.tasks[0].done, true);
  assert.equal(h.sync.info().phase, 'conflict');
  assert.ok(h.sync.readConflicts().length >= 1);
});

test('failure to save conflict backup aborts replacement and upload, preserving local work', async t => {
  const base = blank(); base.tasks.push(task('shared', 'Original'));
  const local = clone(base); local.tasks[0].title = 'Keep local';
  const remote = clone(base); remote.tasks[0].title = 'Remote text';
  const h = setup(t, { base, local, remote, revision: 2 }); h.activate();
  h.storage.failKey = '.conflicts';
  await h.sync.sync();
  assert.equal(h.state.tasks[0].title, 'Keep local');
  assert.equal(h.client.writes.length, 0);
  assert.equal(h.sync.pending, true);
  assert.equal(h.sync.info().phase, 'error');
  assert.equal(JSON.parse(h.storage.getItem(store.STORAGE_KEY)).tasks[0].title, 'Keep local');
});

test('network write failure leaves a saved pending edit and retries successfully', async t => {
  const base = blank(); const h = setup(t, { base, local: base, remote: base, revision: 1 }); h.activate();
  h.edit(state => state.tasks.push(task('offline')));
  h.client.writeError = new Error('Network disconnected');
  await h.sync.sync();
  assert.equal(h.sync.pending, true);
  assert.equal(h.sync.info().phase, 'error');
  assert.equal(h.state.tasks[0].id, 'offline');
  assert.equal(JSON.parse(h.storage.getItem(store.STORAGE_KEY)).tasks[0].id, 'offline');
  assert.equal(h.sync.meta.revision, 1);
  h.client.writeError = null;
  await h.sync.sync();
  assert.equal(h.sync.pending, false);
  assert.equal(h.client.row.state.tasks[0].id, 'offline');
});

test('offline status does not issue requests or discard local pending changes', async t => {
  const base = blank(); const h = setup(t, { base, local: base, remote: base, revision: 1 }); h.activate();
  h.edit(state => state.tasks.push(task('offline')));
  navigator.onLine = false;
  await h.sync.sync();
  assert.equal(h.client.reads, 0);
  assert.equal(h.sync.pending, true);
  assert.equal(h.sync.info().phase, 'offline');
});

test('edits made while a write is in flight are merged and sent in a subsequent write', async t => {
  const base = blank(); const h = setup(t, { base, local: base, remote: base, revision: 1 }); h.activate();
  h.edit(state => state.tasks.push(task('first')));
  const entered = deferred(), release = deferred();
  h.client.beforeWrite = async () => { if (h.client.writes.length === 1) { entered.resolve(); await release.promise; } };
  const syncing = h.sync.sync();
  await entered.promise;
  h.edit(state => { state.tasks.push(task('second')); state.tasks[0].title = 'Edited while uploading'; });
  release.resolve(); await syncing;
  assert.equal(h.client.writes.length, 2);
  assert.deepEqual(new Set(h.client.row.state.tasks.map(item => item.id)), new Set(['first', 'second']));
  assert.equal(h.client.row.state.tasks.find(item => item.id === 'first').title, 'Edited while uploading');
  contentEqual(h.state, h.client.row.state);
  assert.equal(h.sync.pending, false);
});

test('CAS rejection rereads the returned revision and merges a concurrent remote writer', async t => {
  const base = blank(); const local = clone(base); local.tasks.push(task('local'));
  const h = setup(t, { base, local, remote: base, revision: 1 }); h.activate();
  h.client.beforeWrite = async () => { if (h.client.writes.length === 1) { h.client.row.state.tasks.push(task('racing-remote')); h.client.row.revision++; } };
  await h.sync.sync();
  assert.equal(h.client.writes.length, 2);
  assert.deepEqual(new Set(h.state.tasks.map(item => item.id)), new Set(['local', 'racing-remote']));
  assert.equal(h.sync.meta.revision, 3);
});

test('sign-out restores only guest content; another account starts empty; timers stay scoped', async t => {
  const guest = blank(); guest.tasks.push(task('guest')); guest.timer.remaining = 400;
  const account = blank(); account.tasks.push(task('account')); account.timer.running = true; account.timer.endsAt = Date.now() + 100000; account.timer.remaining = 100;
  const h = setup(t, { guest, local: account, remote: account, base: account, revision: 1 }); h.activate();
  assert.equal(h.state.timer.running, true);
  await h.sync.signOut();
  assert.equal(h.sync.user, null);
  assert.deepEqual(h.state.tasks.map(item => item.id), ['guest']);
  assert.equal(h.state.timer.remaining, 400);
  assert.equal(h.state.timer.running, false);
  h.activate({ id: 'account-b', email: 'other@example.com' });
  assert.deepEqual(h.state.tasks, []);
  assert.equal(h.state.timer.remaining, 1500);
  assert.equal(h.sync.pending, false);
});

test('unsynced offline changes prevent sign-out so they cannot silently disappear', async t => {
  const base = blank(); const h = setup(t, { base, local: base, remote: base, revision: 1 }); h.activate();
  h.edit(state => state.tasks.push(task('pending')));
  navigator.onLine = false;
  await assert.rejects(h.sync.signOut(), /未同步/);
  assert.equal(h.sync.user.id, USER.id);
  assert.equal(h.state.tasks[0].id, 'pending');
  assert.equal(h.client.logoutCount, 0);
});

test('device timers never upload and remote timer fields cannot overwrite a local session', async t => {
  const base = blank(); const local = clone(base); local.timer.running = true; local.timer.endsAt = Date.now() + 100000; local.timer.remaining = 100;
  const remote = clone(base); remote.tasks.push(task('remote')); remote.timer.running = true; remote.timer.taskId = 'wrong-device';
  const h = setup(t, { base, local, remote, revision: 1 });
  // A legacy remote row may still contain a timer; cloudSnapshot must strip it.
  h.client.row.state.timer = remote.timer;
  h.activate(); assert.equal(h.sync.pending, false);
  await h.sync.sync();
  assert.deepEqual(h.state.timer, local.timer);
  assert.equal(Object.hasOwn(h.sync.meta.base, 'timer'), false);
  h.edit(state => { state.tasks.push(task('local')); state.timer.remaining = 80; });
  await h.sync.sync();
  assert.ok(h.client.writes.every(write => !Object.hasOwn(write.state, 'timer')));
  assert.equal(h.state.timer.remaining, 80);
});

test('timer-only local changes do not mark the shared workspace as pending', async t => {
  const base = blank(); const h = setup(t, { base, local: base, remote: base, revision: 1 }); h.activate();
  h.edit(state => { state.timer.running = true; state.timer.endsAt = Date.now() + 1500000; });
  assert.equal(h.sync.pending, false);
  await h.sync.sync();
  assert.equal(h.client.writes.length, 0);
  assert.equal(h.state.timer.running, true);
});

test('semantically identical key order does not cause repeated uploads or pending status', async t => {
  const base = blank(); base.tasks.push(task('a'));
  const remote = Object.fromEntries(Object.entries(cloudSnapshot(base)).reverse());
  remote.tasks = remote.tasks.map(item => Object.fromEntries(Object.entries(item).reverse()));
  const h = setup(t, { base, local: base, remote, revision: 8 }); h.activate(); await h.sync.sync();
  assert.equal(h.sync.pending, false);
  assert.equal(h.client.writes.length, 0);
  assert.equal(h.sync.info().phase, 'synced');
});

test('invalid remote content fails closed while preserving the local cache', async t => {
  const base = blank(); base.tasks.push(task('safe'));
  const h = setup(t, { base, local: base, remote: base, revision: 1 }); h.activate();
  h.client.row.state.tasks[0].duration = -5;
  await h.sync.sync();
  assert.equal(h.sync.info().phase, 'error');
  assert.equal(h.client.writes.length, 0);
  assert.equal(h.state.tasks[0].duration, 25);
});

test('verified user identity replaces a mismatching cached session identity before synchronization', async t => {
  const cached = blank(); cached.tasks.push(task('private-account-a'));
  const h = setup(t, { local: cached });
  h.client.currentUser = async () => ({ id: 'verified-account-b', email: 'verified@example.com' });
  await h.sync.start();
  assert.equal(h.sync.user.id, 'verified-account-b');
  assert.deepEqual(h.state.tasks, [], 'cached account A content must never be uploaded under verified account B');
  assert.deepEqual(h.client.row.state.tasks, []);
  assert.ok(store.STORAGE_KEY.endsWith('.verified-account-b'));
});

test('publishable key is only an apikey header, while Authorization contains only the user JWT', async () => {
  const requests = []; const storage = new MemoryStorage();
  const response = payload => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });
  const session = { user: USER, access_token: 'user.jwt.token', refresh_token: 'refresh-value', expires_at: Math.floor(Date.now() / 1000) + 3600 };
  const client = new SupabaseClient(CONFIG, { storage, fetcher: async (url, options) => { requests.push({ url, ...options }); return response(url.endsWith('/verify') ? session : url.includes('/life_os_workspaces?') ? [] : {}); } });
  await client.sendCode('person@example.com');
  await client.verifyCode('person@example.com', '123456');
  await client.currentUser();
  await client.readWorkspace();
  await client.writeWorkspace(cloudSnapshot(blank()), 0);
  assert.ok(requests.every(request => request.headers.apikey === CONFIG.key));
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[1].headers.Authorization, undefined);
  assert.ok(requests.slice(2).every(request => request.headers.Authorization === 'Bearer user.jwt.token'));
  assert.ok(requests.every(request => !String(request.headers.Authorization).includes(CONFIG.key)));
  assert.ok(requests.every(request => !request.url.includes(CONFIG.key)));
  assert.ok(requests.every(request => request.cache === 'no-store'));
});

test('token refresh uses no key bearer, coalesces concurrent refreshes, and updates the JWT', async () => {
  const storage = new MemoryStorage(), requests = [];
  const client = new SupabaseClient(CONFIG, { storage, fetcher: async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, status: 200, text: async () => JSON.stringify(url.includes('/token?') ? { user: USER, access_token: 'new-user.jwt.token', refresh_token: 'new-refresh', expires_in: 3600 } : USER) };
  } });
  client.remember({ user: USER, access_token: 'expired-token', refresh_token: 'old-refresh', expires_at: 1 });
  await Promise.all([client.currentUser(), client.currentUser()]);
  const refreshes = requests.filter(request => request.url.includes('/token?'));
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].headers.Authorization, undefined);
  assert.ok(requests.filter(request => !request.url.includes('/token?')).every(request => request.headers.Authorization === 'Bearer new-user.jwt.token'));
});

test('connection configuration rejects private keys and malformed endpoints', () => {
  assert.equal(connectionSettings('', '').configured, false);
  assert.throws(() => connectionSettings(CONFIG.url, 'sb_secret_private'), /服务端密钥/);
  assert.throws(() => connectionSettings('http://project.supabase.co', CONFIG.key), /HTTPS/);
  assert.throws(() => connectionSettings(`${CONFIG.url}/rest/v1`, CONFIG.key), /HTTPS/);
  const jwt = role => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
  assert.equal(connectionSettings(CONFIG.url, jwt('anon')).configured, true);
  assert.throws(() => connectionSettings(CONFIG.url, jwt('service_role')), /服务端密钥/);
});
