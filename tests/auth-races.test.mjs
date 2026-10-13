import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSync, SupabaseClient, cloudSnapshot } from '../cloud.js';
import * as store from '../store.js';

const CONFIG = { configured: true, url: 'https://auth-races.supabase.co', key: 'sb_publishable_test', project: 'auth-races.supabase.co' };
const USERS = {
  a: { id: 'auth-account-a', email: 'a@example.com' },
  b: { id: 'auth-account-b', email: 'b@example.com' },
};
const clone = value => structuredClone(value);
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const sessionFor = name => ({
  user: USERS[name], access_token: `${name}-user.jwt.token`,
  refresh_token: `${name}-refresh-token`, expires_at: Math.floor(Date.now() / 1000) + 3600,
});
const privateTask = name => ({
  id: `${name}-private-task`, title: `${name.toUpperCase()} PRIVATE CONTENT`,
  date: '2026-10-13', time: '', duration: 25,
  category: '个人', priority: 'normal', done: false,
});
const response = (payload, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => payload === null ? '' : JSON.stringify(payload),
});

function harness(t) {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  globalThis.localStorage = storage;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const eventListeners = new Map();
  globalThis.addEventListener = (type, listener) => {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type).add(listener);
  };
  globalThis.removeEventListener = (type, listener) => eventListeners.get(type)?.delete(listener);
  store.setStorageScope();
  let state = store.loadState();
  const refreshEntered = deferred();
  const refreshRelease = deferred();
  let blockRefresh = false;
  const userEntered = deferred();
  const userRelease = deferred();
  let blockUser = false;
  const requests = [];
  const writes = [];
  const rows = {
    a: { state: cloudSnapshot(store.createEmptyState()), revision: 1, updated_at: null },
    b: { state: cloudSnapshot(store.createEmptyState()), revision: 1, updated_at: null },
  };
  const client = new SupabaseClient(CONFIG, { storage, fetcher: async (url, options) => {
    requests.push({ url, ...options });
    if (url.includes('/token?')) {
      if (blockRefresh) { refreshEntered.resolve(); await refreshRelease.promise; }
      return response(sessionFor('a'));
    }
    const name = options.headers.Authorization === 'Bearer b-user.jwt.token' ? 'b' : 'a';
    if (url.endsWith('/user')) {
      if (blockUser) { userEntered.resolve(); await userRelease.promise; }
      return response(USERS[name]);
    }
    if (url.includes('/life_os_workspaces?')) {
      // Model actual RLS: the JWT and requested user filter must both match.
      const filter = new URL(url).searchParams.get('user_id');
      return response(filter === `eq.${USERS[name].id}` ? [clone(rows[name])] : []);
    }
    if (url.includes('/save_life_os_workspace')) {
      const body = JSON.parse(options.body);
      writes.push({ user: name, body: clone(body) });
      if (body.p_expected_revision !== rows[name].revision) return response({ ...clone(rows[name]), applied: false });
      rows[name] = { state: clone(body.p_state), revision: rows[name].revision + 1, updated_at: '2026-10-13T09:00:00Z' };
      return response({ ...clone(rows[name]), applied: true });
    }
    if (url.includes('/logout')) return response(null, 204);
    throw new Error(`Unexpected mock endpoint: ${url}`);
  } });
  client.remember(sessionFor('a'));
  const sync = new CloudSync({ config: CONFIG, client, storage, getState: () => state, replaceState: next => { state = next; } });
  t.after(() => { refreshRelease.resolve(); userRelease.resolve(); sync.destroy(); store.setStorageScope(); });
  return {
    storage, client, sync, requests, writes, rows,
    get state() { return state; },
    holdRefresh() { blockRefresh = true; client.session.expires_at = 1; return refreshEntered.promise; },
    releaseRefresh() { refreshRelease.resolve(); },
    holdCurrentUser() { blockUser = true; return userEntered.promise; },
    releaseCurrentUser() { userRelease.resolve(); },
    switchViaStorage(name, dispatchRegisteredListeners = false) {
      const next = name ? sessionFor(name) : null;
      if (next) storage.setItem(client.sessionKey, JSON.stringify(next));
      else storage.removeItem(client.sessionKey);
      const event = { key: client.sessionKey, newValue: next ? JSON.stringify(next) : null };
      if (dispatchRegisteredListeners) for (const listener of eventListeners.get('storage') || []) listener(event);
      else sync.storageHandler(event);
    },
    seedPrivateCache(name) {
      const snapshot = store.createEmptyState(); snapshot.tasks.push(privateTask(name));
      const key = `${store.GUEST_STORAGE_KEY}.account.${encodeURIComponent(CONFIG.project)}.${encodeURIComponent(USERS[name].id)}`;
      storage.setItem(key, JSON.stringify(snapshot));
    },
  };
}

test('an old token refresh cannot replace account B credentials or upload B content to account A', async t => {
  const h = harness(t);
  await h.sync.start();
  const refreshEntered = h.holdRefresh();
  const oldSync = h.sync.sync();
  await refreshEntered;
  h.seedPrivateCache('b');
  h.switchViaStorage('b');
  assert.equal(h.sync.user.id, USERS.b.id);
  assert.equal(h.state.tasks[0].id, 'b-private-task');
  h.releaseRefresh();
  await oldSync;
  assert.equal(h.client.session.user.id, USERS.b.id, 'late account A refresh must not replace the newer account B session');
  assert.equal(JSON.parse(h.storage.getItem(h.client.sessionKey)).user.id, USERS.b.id);
  await h.sync.sync();
  assert.ok(h.rows.b.state.tasks.some(task => task.id === 'b-private-task'));
  assert.ok(h.writes.every(write => write.user !== 'a' || !write.body.p_state.tasks.some(task => task.id === 'b-private-task')));
  assert.deepEqual(h.rows.a.state.tasks, []);
});

test('an old token refresh cannot restore a session after a cross-tab sign-out', async t => {
  const h = harness(t);
  await h.sync.start();
  const refreshEntered = h.holdRefresh();
  const oldSync = h.sync.sync();
  await refreshEntered;
  h.switchViaStorage(null);
  assert.equal(h.sync.user, null);
  h.releaseRefresh();
  await oldSync;
  assert.equal(h.client.session, null, 'late refresh must not sign the browser back in');
  assert.equal(h.storage.getItem(h.client.sessionKey), null);
  assert.equal(h.sync.user, null);
  assert.equal(store.STORAGE_KEY, store.GUEST_STORAGE_KEY);
  assert.equal(h.writes.length, 0);
});

test('workspace read does not issue an account A query using account B JWT after a refresh race', async t => {
  const h = harness(t);
  const refreshEntered = h.holdRefresh();
  const reading = h.client.readWorkspace(USERS.a.id);
  await refreshEntered;
  h.client.remember(sessionFor('b'));
  h.releaseRefresh();
  await assert.rejects(reading);
  assert.equal(h.client.session.user.id, USERS.b.id);
  assert.equal(h.requests.filter(request => request.url.includes('/life_os_workspaces?')).length, 0);
});

test('workspace write does not send account A payload under account B JWT after a refresh race', async t => {
  const h = harness(t);
  const snapshot = cloudSnapshot(store.createEmptyState()); snapshot.tasks.push(privateTask('a'));
  const refreshEntered = h.holdRefresh();
  const writing = h.client.writeWorkspace(snapshot, 1, USERS.a.id);
  await refreshEntered;
  h.client.remember(sessionFor('b'));
  h.releaseRefresh();
  await assert.rejects(writing);
  assert.equal(h.client.session.user.id, USERS.b.id);
  assert.equal(h.writes.length, 0);
});

test('startup listens for account B before a delayed account A identity response returns', async t => {
  const h = harness(t);
  h.seedPrivateCache('a');
  h.seedPrivateCache('b');
  const userEntered = h.holdCurrentUser();
  const starting = h.sync.start();
  await userEntered;
  assert.equal(h.sync.user.id, USERS.a.id);
  h.switchViaStorage('b', true);
  assert.equal(h.sync.user.id, USERS.b.id, 'storage events must be handled while the first identity request is in flight');
  h.releaseCurrentUser();
  await starting;
  await h.sync.sync();
  assert.equal(h.sync.user.id, USERS.b.id);
  assert.equal(h.client.session.user.id, USERS.b.id);
  assert.equal(JSON.parse(h.storage.getItem(h.client.sessionKey)).user.id, USERS.b.id);
  assert.ok(h.state.tasks.some(task => task.id === 'b-private-task'));
  assert.ok(h.state.tasks.every(task => task.id !== 'a-private-task'));
  assert.ok(h.writes.every(write => !write.body.p_state.tasks.some(task => task.id === 'a-private-task')));
});
