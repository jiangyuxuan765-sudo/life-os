import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSync, SupabaseClient, authRedirectUrl, cloudSnapshot, takeAuthCallback } from '../cloud.js';
import { mountCloudUI } from '../cloud-ui.js';
import * as store from '../store.js';

const CONFIG = { configured: true, url: 'https://magic.supabase.co', key: 'sb_publishable_test', project: 'magic.supabase.co' };
const APP = 'https://person.github.io/life-os/cloud.js';
const A = { id: 'verified-a', email: 'a@example.com' };
const B = { id: 'verified-b', email: 'b@example.com' };
const tokenHash = (overrides = {}) => `#${new URLSearchParams({ access_token: 'candidate-access', refresh_token: 'candidate-refresh', expires_in: '3600', expires_at: String(Math.floor(Date.now() / 1000) + 3600), token_type: 'bearer', type: 'magiclink', ...overrides })}`;
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const session = user => ({ user, access_token: `${user.id}-access`, refresh_token: `${user.id}-refresh`, expires_at: Math.floor(Date.now() / 1000) + 3600 });

function browser(hash = tokenHash(), href = 'https://person.github.io/life-os/') {
  const location = new URL(href); location.hash = hash;
  const replacements = [];
  const history = { state: { preserved: true }, replaceState(state, unused, next) { replacements.push(next); location.href = new URL(next, location).href; this.state = state; } };
  return { location, history, appUrl: APP, replacements };
}

function setup(t, { hash = tokenHash(), savedSession = null, rejectUser = false, rejectRemember = false, holdUser = false } = {}) {
  const environment = browser(hash);
  const values = new Map(), events = [], requests = [];
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (rejectRemember && key.includes('.session.')) throw new Error('Storage full'); events.push(key); values.set(key, String(value)); }, removeItem: key => values.delete(key) };
  globalThis.localStorage = storage;
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  globalThis.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const listeners = new Map();
  globalThis.addEventListener = (type, callback) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); };
  globalThis.removeEventListener = (type, callback) => listeners.get(type)?.delete(callback);
  store.setStorageScope();
  const guest = store.createEmptyState();
  guest.notes.push({ id: 'private-guest', title: 'Keep this', body: 'Local unsynced writing', date: '2026-10-13', tag: '随手记' });
  store.loadState(); store.saveState(guest);
  let state = guest;
  const userEntered = deferred(), userReleased = deferred();
  const client = new SupabaseClient(CONFIG, { storage, fetcher: async (url, options) => {
    requests.push({ url, ...options });
    assert.equal(environment.location.hash, '#decision', 'tokens must leave the URL before any request');
    if (url.endsWith('/user')) {
      userEntered.resolve(); if (holdUser) await userReleased.promise;
      return rejectUser ? response({ message: 'Invalid token' }, 401) : response(A);
    }
    if (url.includes('/life_os_workspaces?')) return response([{ state: cloudSnapshot(store.createEmptyState()), revision: 1 }]);
    if (url.includes('/save_life_os_workspace')) return response({ state: JSON.parse(options.body).p_state, revision: 2, applied: true });
    if (url.includes('/logout')) return response({});
    throw new Error('Unexpected endpoint');
  } });
  if (savedSession) { values.set(client.sessionKey, JSON.stringify(savedSession)); client.session = savedSession; }
  const notifications = [], replaced = [];
  const sync = new CloudSync({ config: CONFIG, client, storage, ...environment, getState: () => state, replaceState: next => { replaced.push(next); state = next; }, notify: (...args) => notifications.push(args) });
  t.after(() => { userReleased.resolve(); sync.destroy(); store.setStorageScope(); });
  return { ...environment, storage, client, sync, requests, events, notifications, replaced, userEntered, userReleased, get state() { return state; }, dispatch(type, event) { for (const callback of listeners.get(type) || []) callback(event); } };
}

test('email redirect preserves the repository path and strips navigation/query values', () => {
  assert.equal(authRedirectUrl(new URL('https://person.github.io/life-os/?preview=1#execute')), 'https://person.github.io/life-os/');
  assert.equal(authRedirectUrl(new URL('https://person.github.io/life-os/index.html#record')), 'https://person.github.io/life-os/index.html');
  assert.throws(() => authRedirectUrl(new URL('http://localhost:4173/')), /HTTPS/);
});

test('OTP mail request uses the official redirect_to query parameter and no token bearer', async () => {
  let captured;
  const client = new SupabaseClient(CONFIG, { storage: { getItem: () => null }, fetcher: async (url, options) => { captured = { url, ...options }; return response({}); } });
  await client.sendCode('a@example.com', authRedirectUrl(new URL('https://person.github.io/life-os/#week')));
  const endpoint = new URL(captured.url);
  assert.equal(endpoint.pathname, '/auth/v1/otp');
  assert.equal(endpoint.searchParams.get('redirect_to'), 'https://person.github.io/life-os/');
  assert.deepEqual(JSON.parse(captured.body), { email: 'a@example.com', create_user: true });
  assert.equal(captured.headers.Authorization, undefined);
});

test('valid implicit callback clears secrets synchronously and ignores URL user claims', () => {
  const b = browser(tokenHash({ user: JSON.stringify(B), email: B.email, user_id: B.id }));
  const result = takeAuthCallback(b);
  assert.equal(b.location.hash, '#decision');
  assert.equal(b.replacements.length, 1);
  assert.deepEqual(b.history.state, { preserved: true });
  assert.equal(result.access_token, 'candidate-access');
  assert.equal(result.refresh_token, 'candidate-refresh');
  assert.equal(Object.hasOwn(result, 'user'), false);
  assert.equal(Object.hasOwn(result, 'email'), false);
});

test('ordinary navigation hashes remain unchanged and are not treated as login', () => {
  const b = browser('#record');
  assert.equal(takeAuthCallback(b), null);
  assert.equal(b.location.hash, '#record');
  assert.deepEqual(b.replacements, []);
});

test('malformed, expired, and error callbacks are scrubbed before rejection', () => {
  for (const hash of ['#access_token=only', tokenHash({ expires_at: '1' }), tokenHash({ expires_in: 'NaN' }), tokenHash({ token_type: 'other' }), '#error=access_denied&error_description=Do+not+display+raw+details']) {
    const b = browser(hash);
    assert.throws(() => takeAuthCallback(b));
    assert.equal(b.location.hash, '#decision');
    assert.equal(b.replacements.length, 1);
  }
});

test('callbacks are accepted only on the HTTPS application origin and directory', () => {
  for (const href of ['http://person.github.io/life-os/', 'https://unrelated.example/life-os/', 'https://person.github.io/other-project/']) {
    const b = browser(tokenHash(), href);
    assert.throws(() => takeAuthCallback(b), /正式网站/);
    assert.equal(b.location.hash, '#decision');
  }
  assert.ok(takeAuthCallback(browser(tokenHash(), 'https://person.github.io/life-os/index.html')));
});

test('a callback cannot be consumed if browser history cannot remove the credentials', () => {
  const b = browser(); b.history.replaceState = () => { throw new Error('History blocked'); };
  assert.throws(() => takeAuthCallback(b), /History blocked/);
});

test('magic-link verification happens before session persistence, workspace activation, and sync', async t => {
  const h = setup(t, { hash: tokenHash({ user_id: B.id, email: B.email }), holdUser: true });
  const starting = h.sync.start(); await h.userEntered.promise;
  assert.equal(h.location.hash, '#decision');
  assert.equal(h.client.session, null);
  assert.equal(h.storage.getItem(h.client.sessionKey), null);
  assert.equal(h.replaced.length, 0);
  assert.equal(h.state.notes[0].id, 'private-guest');
  assert.equal(h.requests[0].headers.Authorization, 'Bearer candidate-access');
  h.userReleased.resolve(); await starting;
  assert.equal(h.client.session.user.id, A.id);
  assert.equal(h.sync.user.id, A.id);
  assert.equal(h.sync.info().phase, 'synced');
  assert.deepEqual(h.state.notes, []);
  assert.ok(store.STORAGE_KEY.endsWith(`.${A.id}`));
  assert.equal(JSON.parse(h.storage.getItem(store.GUEST_STORAGE_KEY)).notes[0].id, 'private-guest');
  assert.ok(h.requests.slice(1).every(request => request.headers.Authorization === 'Bearer candidate-access'));
  assert.equal(h.requests.filter(request => request.url.endsWith('/user')).length, 1);
});

test('failed magic-link verification preserves prior session and workspace without any writes', async t => {
  const old = session(B); const h = setup(t, { savedSession: old, rejectUser: true });
  await h.sync.start();
  assert.equal(h.location.hash, '#decision');
  assert.equal(h.client.session, old);
  assert.equal(JSON.parse(h.storage.getItem(h.client.sessionKey)).user.id, B.id);
  assert.equal(h.sync.user, null);
  assert.equal(h.state.notes[0].id, 'private-guest');
  assert.equal(h.replaced.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.sync.info().phase, 'error');
  assert.ok(h.notifications.every(args => !args.join(' ').includes('candidate-access')));
});

test('callback error from the auth service is cleared without sending a verification request', async t => {
  const h = setup(t, { hash: '#error=access_denied&error_code=otp_expired&error_description=Expired' });
  await h.sync.start();
  assert.equal(h.requests.length, 0);
  assert.equal(h.replaced.length, 0);
  assert.equal(h.location.hash, '#decision');
  assert.equal(h.sync.info().phase, 'error');
});

test('failure to persist a verified callback does not mutate the previous in-memory session', async t => {
  const old = session(B); const h = setup(t, { savedSession: old, rejectRemember: true });
  await h.sync.start();
  assert.equal(h.client.session, old);
  assert.equal(h.replaced.length, 0);
  assert.equal(h.state.notes[0].id, 'private-guest');
  assert.equal(h.requests.length, 1);
  assert.equal(h.sync.info().phase, 'error');
});

test('another tab login supersedes a delayed callback rather than being overwritten', async t => {
  const h = setup(t, { holdUser: true });
  const starting = h.sync.start(); await h.userEntered.promise;
  const other = session(B);
  h.storage.setItem(h.client.sessionKey, JSON.stringify(other));
  h.dispatch('storage', { key: h.client.sessionKey, newValue: JSON.stringify(other) });
  assert.equal(h.sync.user.id, B.id);
  h.userReleased.resolve(); await starting; await h.sync.sync();
  assert.equal(h.client.session.user.id, B.id);
  assert.equal(h.sync.user.id, B.id);
  assert.equal(JSON.parse(h.storage.getItem(h.client.sessionKey)).user.id, B.id);
});

test('callback verification cannot restore a session after a cross-tab sign-out', async t => {
  const h = setup(t, { savedSession: session(B), holdUser: true });
  const starting = h.sync.start(); await h.userEntered.promise;
  h.storage.removeItem(h.client.sessionKey);
  h.dispatch('storage', { key: h.client.sessionKey, newValue: null });
  h.userReleased.resolve(); await starting;
  assert.equal(h.client.session, null);
  assert.equal(h.sync.user, null);
  assert.equal(h.storage.getItem(h.client.sessionKey), null);
  assert.equal(store.STORAGE_KEY, store.GUEST_STORAGE_KEY);
});

test('cross-tab sign-out cancels a pending link even before its first session is established', async t => {
  const h = setup(t, { holdUser: true });
  const starting = h.sync.start(); await h.userEntered.promise;
  h.dispatch('storage', { key: h.client.sessionKey, newValue: null });
  h.userReleased.resolve(); await starting;
  assert.equal(h.client.session, null);
  assert.equal(h.sync.user, null);
  assert.equal(h.storage.getItem(h.client.sessionKey), null);
  assert.equal(h.replaced.length, 0);
});

test('sign-out cannot clear a newer account activated while logout was in flight', async t => {
  const h = setup(t);
  await h.sync.start();
  const entered = deferred(), release = deferred();
  h.client.logout = async () => { entered.resolve(); await release.promise; };
  const signingOut = h.sync.signOut(); await entered.promise;
  const other = session(B);
  h.storage.setItem(h.client.sessionKey, JSON.stringify(other));
  h.dispatch('storage', { key: h.client.sessionKey, newValue: JSON.stringify(other) });
  release.resolve(); await signingOut;
  assert.equal(h.sync.user.id, B.id);
  assert.equal(h.client.session.user.id, B.id);
  assert.ok(store.STORAGE_KEY.endsWith(`.${B.id}`));
});

test('UI defaults to a login email link and offers numeric OTP only as an explicit alternative', async t => {
  const oldDocument = globalThis.document, oldFormData = globalThis.FormData;
  class Element {
    constructor() { this.innerHTML = ''; this.dataset = {}; this.listeners = {}; this.children = new Map(); this.open = false; }
    setAttribute() {} replaceWith() {} appendChild() {} focus() {}
    addEventListener(type, callback) { this.listeners[type] = callback; }
    querySelector(selector) { if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
    querySelectorAll() { return []; }
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const created = [], nodes = new Map();
  globalThis.document = { body: new Element(), activeElement: new Element(), createElement: () => { const node = new Element(); created.push(node); return node; }, querySelector: selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); } };
  globalThis.FormData = class { constructor(form) { this.values = form.values; } get(key) { return this.values[key]; } };
  t.after(() => { globalThis.document = oldDocument; globalThis.FormData = oldFormData; });
  const calls = [], info = { phase: 'signed-out', configured: true, user: null };
  const sync = { info: () => info, onStatus: callback => callback(info), sendCode: async email => calls.push(['email', email]), verifyCode: async (email, code) => calls.push(['code', email, code]) };
  const ui = mountCloudUI({ sync, getState: () => store.createEmptyState(), notify() {} }); ui.open();
  const dialog = created[0];
  assert.match(dialog.innerHTML, /发送登录邮件/);
  assert.doesNotMatch(dialog.innerHTML, /name="code"/);
  const submit = values => dialog.listeners.submit({ target: { id: 'cloud-login-form', values }, preventDefault() {} });
  submit({ email: 'a@example.com' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['email', 'a@example.com']]);
  assert.match(dialog.innerHTML, /点击邮件中的登录链接/);
  assert.match(dialog.innerHTML, /data-cloud="use-code"/);
  assert.doesNotMatch(dialog.innerHTML, /name="code"/);
  dialog.listeners.click({ target: { closest: () => ({ dataset: { cloud: 'use-code' } }) } });
  assert.match(dialog.innerHTML, /name="code"/);
  submit({ email: 'a@example.com', code: '123456' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[1], ['code', 'a@example.com', '123456']);
});
