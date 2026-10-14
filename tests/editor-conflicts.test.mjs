import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createEmptyState, validState, todayISO, addDays, weekDates } from '../store.js';

// Execute the real application event handlers. Only browser surfaces and the
// cloud transport are replaced; edit/open/submit/undo code is not reimplemented.
const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const clone = value => structuredClone(value);
const initial = () => ({
  ...createEmptyState(),
  tasks: [{ id: 'task', title: 'Original task', date: todayISO(), time: '', duration: 25, category: '成长', priority: 'normal', done: false }],
  notes: [{ id: 'note', title: 'Original note', body: 'Original body', date: todayISO(), tag: '随手记' }],
  decisions: [{ id: 'decision', title: 'Original decision', context: 'Original context', category: '成长', impact: '高', deadline: '', options: ['A', 'B'], choice: '', reason: '', status: 'pending' }],
  goals: [{ id: 'goal', title: 'Original goal', week: weekDates(todayISO())[0], done: false }],
  metrics: [{ date: todayISO(), energy: 7, sleep: 8, exercise: 20, focus: 25 }],
});

function harness({ demo = false, hash = '#decision' } = {}) {
  const nodes = new Map(), handlers = new Map(), windowHandlers = new Map(), saved = [];
  const calls = { cloud: 0, cloudUI: 0, reload: 0 };
  let cloud, serial = 0;
  class Element {
    constructor() { this.dataset = {}; this.style = { setProperty() {} }; this.classList = { toggle() {} }; this.children = new Map(); this.open = false; this.isConnected = true; this.textContent = ''; this._html = ''; }
    set innerHTML(value) {
      this._html = value;
      if (this === nodes.get('#dialog-content')) {
        if (this.form) this.form.isConnected = false;
        const match = value.match(/<form\b([^>]*)>/);
        this.form = match ? new Element() : null;
        if (this.form) { this.form.dataset = { kind: match[1].match(/data-kind="([^"]*)"/)?.[1], id: match[1].match(/data-id="([^"]*)"/)?.[1] || '' }; this.form.values = {}; }
      }
    }
    get innerHTML() { return this._html; }
    querySelector(selector) { if (selector === 'form') return this.form; if (!this.children.has(selector)) this.children.set(selector, new Element()); return this.children.get(selector); }
    querySelectorAll() { return []; }
    addEventListener() {} setAttribute() {} removeAttribute() {} focus() {} scrollIntoView() {}
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const element = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const context = {
    console, URL, URLSearchParams, Date, Map, WeakMap, Set,
    IS_DEMO: demo, STORAGE_KEY: 'life-os.workspace.v1', todayISO, addDays, weekDates, uid: () => `new-${++serial}`,
    loadState: initial,
    saveState: state => { assert.equal(validState(state), true); saved.push(clone(state)); },
    CloudSync: class { constructor(options) { calls.cloud++; cloud = options; } schedulePush() {} async start() {} },
    mountCloudUI() { calls.cloudUI++; },
    document: { querySelector: element, querySelectorAll: () => [], documentElement: new Element(), activeElement: new Element(), addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); } },
    window: { addEventListener(type, fn) { windowHandlers.set(type, fn); }, scrollTo() {} },
    location: { hash, search: demo ? '?demo=1' : '', reload() { calls.reload++; } },
    localStorage: { getItem() { throw new Error('App must leave storage access to store.js'); }, setItem() { throw new Error('App must leave storage access to store.js'); } },
    fetch() { throw new Error('App must not issue requests in demo mode'); },
    requestAnimationFrame: fn => fn(), setInterval: () => 1, setTimeout: () => 1, clearTimeout() {},
    FormData: class { constructor(form) { this.data = form.values; } [Symbol.iterator]() { return Object.entries(this.data)[Symbol.iterator](); } get(key) { return this.data[key]; } },
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(source, sandbox, { filename: 'app.js' });
  return {
    saved, nodes, context, calls, windowHandlers,
    get state() { return vm.runInContext('state', sandbox); },
    get form() { return element('#dialog-content').form; },
    get dialog() { return element('#editor-dialog'); },
    click(action, extra = {}, form = null) { const trigger = { dataset: { action, ...extra }, tagName: 'BUTTON', closest: selector => selector === 'form' ? form : null }; for (const handler of handlers.get('click') || []) handler({ target: { closest: () => trigger }, preventDefault() {} }); },
    submit(values, form = this.form) { form.values = values; for (const handler of handlers.get('submit') || []) handler({ target: form, preventDefault() {} }); },
    remote(change) { const next = clone(cloud.getState()); change(next); cloud.replaceState(next); },
    error(form = this.form) { return form.querySelector('.form-error').textContent; },
  };
}

test('demo never constructs cloud UI, handles auth, or subscribes to personal storage', () => {
  const hash = '#access_token=must-not-consume&refresh_token=must-not-consume';
  const h = harness({ demo: true, hash });
  assert.equal(h.calls.cloud, 0);
  assert.equal(h.calls.cloudUI, 0);
  assert.equal(h.windowHandlers.has('storage'), false);
  assert.equal(h.context.location.hash, hash, 'demo does not consume an auth callback');
  assert.match(h.nodes.get('.saved-indicator').innerHTML, /交互演示 · 刷新即重置/);
  assert.match(h.nodes.get('.saved-indicator').innerHTML, /data-action="reset-demo"/);
  assert.match(h.nodes.get('.profile').innerHTML, /示例内容 · 仅供体验/);
  assert.doesNotMatch(h.nodes.get('.profile').innerHTML, /data-cloud|登录|导入|导出/);
  assert.match(h.context.document.title, /交互演示/);
});

test('demo retains five-page navigation and temporary create, complete, metrics, and timer actions', () => {
  const h = harness({ demo: true });
  for (const page of ['decision', 'monitor', 'week', 'execute', 'record']) {
    h.context.location.hash = `#${page}`; h.windowHandlers.get('hashchange')();
    assert.match(h.context.document.title, /交互演示/);
    assert.ok(h.nodes.get('#view').innerHTML.length > 1000);
    assert.match(h.nodes.get('#page-tag').textContent, /演示/);
  }
  h.click('new-decision');
  h.submit({ title: 'Demo decision', context: 'Temporary', category: '成长', impact: '中', deadline: '', options: 'A\nB' });
  h.click('new-task');
  h.submit({ title: 'Demo task', date: todayISO(), time: '', duration: '25', category: '个人', priority: 'normal' });
  const taskId = h.state.tasks.find(task => task.title === 'Demo task').id;
  h.click('toggle-task', { id: taskId });
  h.click('new-goal'); h.submit({ title: 'Demo goal' });
  h.click('log-metrics', { date: todayISO() });
  h.submit({ date: todayISO(), energy: '8', sleep: '8', exercise: '30', focus: '50' });
  h.click('new-note');
  h.submit({ title: 'Demo note', body: 'Temporary draft', date: todayISO(), tag: '随手记' });
  h.click('toggle-timer');
  assert.equal(h.state.timer.running, true);
  h.click('toggle-timer'); assert.equal(h.state.timer.running, false);
  assert.equal(h.state.tasks.find(task => task.id === taskId).done, true);
  assert.ok(h.state.decisions.some(item => item.title === 'Demo decision'));
  assert.ok(h.state.goals.some(item => item.title === 'Demo goal'));
  assert.equal(h.state.metrics[0].focus, 50);
  assert.ok(h.state.notes.some(item => item.title === 'Demo note'));
  assert.equal(h.calls.cloud, 0);
  assert.equal(h.calls.cloudUI, 0);
});

test('reset demo reloads without dropping its query and a fresh page starts from unchanged examples', () => {
  const h = harness({ demo: true });
  h.click('toggle-task', { id: 'task' }); h.click('toggle-timer');
  h.click('reset-demo');
  assert.equal(h.calls.reload, 1);
  assert.equal(h.context.location.search, '?demo=1');
  const reloaded = harness({ demo: true });
  assert.equal(reloaded.state.tasks[0].done, false);
  assert.equal(reloaded.state.timer.running, false);
  assert.equal(reloaded.state.timer.remaining, 1500);
  assert.equal(reloaded.calls.cloud, 0);
});

test('personal mode still initializes cloud controls and listens for saved workspace updates', () => {
  const h = harness();
  assert.equal(h.calls.cloud, 1);
  assert.equal(h.calls.cloudUI, 1);
  assert.equal(h.windowHandlers.has('storage'), true);
  assert.doesNotMatch(h.context.document.title, /演示/);
  h.click('reset-demo'); assert.equal(h.calls.reload, 0);
});

const cases = [
  { name: 'notes', action: 'edit-note', id: 'note', collection: 'notes', change: item => { item.body = 'Remote note body'; }, values: { title: 'Local changed title', body: 'Original body', date: todayISO(), tag: '随手记' } },
  { name: 'tasks', action: 'edit-task', id: 'task', collection: 'tasks', change: item => { item.done = true; }, values: { title: 'Local changed task', date: todayISO(), time: '', duration: '25', category: '成长', priority: 'normal' } },
  { name: 'decisions', action: 'edit-decision', id: 'decision', collection: 'decisions', change: item => { item.context = 'Remote decision context'; }, values: { title: 'Local changed decision', context: 'Original context', category: '成长', impact: '高', deadline: '', options: 'A\nB' } },
  { name: 'decision resolution', action: 'resolve-decision', id: 'decision', collection: 'decisions', change: item => { item.options = ['C', 'D']; }, values: { choice: 'A', reason: 'Local draft reason' } },
  { name: 'goals', action: 'edit-goal', id: 'goal', collection: 'goals', change: item => { item.done = true; }, values: { title: 'Local draft goal' } },
  { name: 'metrics', action: 'log-metrics', id: todayISO(), collection: 'metrics', change: item => { item.focus = 50; }, values: { date: todayISO(), energy: '8', sleep: '8', exercise: '20', focus: '25' } },
];

for (const example of cases) test(`stale ${example.name} form keeps its draft and cannot overwrite a synchronized entity`, () => {
  const h = harness(); h.click(example.action, example.collection === 'metrics' ? { date: example.id } : { id: example.id });
  const form = h.form;
  h.remote(state => example.change(state[example.collection][0]));
  const before = clone(h.state);
  h.submit(clone(example.values));
  assert.deepEqual(clone(h.state), before);
  assert.equal(h.saved.length, 0);
  assert.equal(h.form, form);
  assert.equal(h.dialog.open, true);
  assert.deepEqual(form.values, example.values);
  assert.match(h.error(), /草稿仍保留/);
  h.submit(clone(example.values));
  assert.equal(h.saved.length, 0, 'repeated submit must not silently rebase the old draft');
});

test('a form for an entity deleted remotely stays open and does not recreate it', () => {
  const h = harness(); h.click('edit-note', { id: 'note' });
  h.remote(state => { state.notes = []; });
  h.submit(clone(cases[0].values));
  assert.equal(h.state.notes.length, 0);
  assert.equal(h.saved.length, 0);
  assert.equal(h.dialog.open, true);
  assert.match(h.error(), /移除/);
});

test('a stale pause button cannot reverse a decision status already changed remotely', () => {
  const h = harness(); h.click('edit-decision', { id: 'decision' });
  const form = h.form; form.values = { title: 'Unsaved decision draft' };
  h.remote(state => { state.decisions[0].status = 'paused'; });
  h.click('pause-decision', { id: 'decision' }, form);
  assert.equal(h.state.decisions[0].status, 'paused');
  assert.equal(h.saved.length, 0);
  assert.equal(h.dialog.open, true);
  assert.equal(form.values.title, 'Unsaved decision draft');
  assert.match(h.error(), /草稿仍保留/);
});

test('pause and resume still work from a fresh decision editor', () => {
  const h = harness(); h.click('edit-decision', { id: 'decision' });
  h.click('pause-decision', { id: 'decision' }, h.form);
  assert.equal(h.state.decisions[0].status, 'paused');
  assert.equal(h.saved.length, 1);
  h.click('edit-decision', { id: 'decision' });
  h.click('pause-decision', { id: 'decision' }, h.form);
  assert.equal(h.state.decisions[0].status, 'pending');
  assert.equal(h.saved.length, 2);
});

test('unrelated remote changes and property order changes do not block a valid edit', () => {
  const h = harness(); h.click('edit-note', { id: 'note' });
  h.remote(state => { state.tasks[0].title = 'Unrelated update'; state.notes[0] = Object.fromEntries(Object.entries(state.notes[0]).reverse()); });
  h.submit(clone(cases[0].values));
  assert.equal(h.saved.length, 1);
  assert.equal(h.state.notes[0].title, 'Local changed title');
  assert.equal(h.state.tasks[0].title, 'Unrelated update');
  assert.equal(h.dialog.open, false);
});

test('a new note can be saved while existing notes are updated remotely', () => {
  const h = harness(); h.click('new-note');
  h.remote(state => { state.notes[0].body = 'New remote body'; });
  h.submit({ title: 'New local note', body: 'My draft', date: todayISO(), tag: '随手记' });
  assert.equal(h.saved.length, 1);
  assert.equal(h.state.notes.length, 2);
  assert.equal(h.state.notes.find(note => note.id === 'note').body, 'New remote body');
});

test('metrics compare the submitted date and protect a target created while the form was open', () => {
  const h = harness(); const date = addDays(todayISO(), -1);
  h.click('log-metrics', { date });
  h.remote(state => { state.metrics.push({ date, energy: 9, sleep: 8, exercise: 30, focus: 75 }); });
  h.submit({ ...cases[5].values, date });
  assert.equal(h.state.metrics.find(item => item.date === date).focus, 75);
  assert.equal(h.saved.length, 0);
  assert.match(h.error(), /草稿仍保留/);
});

test('changing the metrics date cannot overwrite a remotely changed destination', () => {
  const h = harness(); const destination = addDays(todayISO(), -1);
  h.remote(state => { state.metrics.push({ date: destination, energy: 6, sleep: 7, exercise: 0, focus: 25 }); });
  h.click('log-metrics', { date: todayISO() });
  h.remote(state => { state.metrics.find(item => item.date === destination).focus = 100; });
  h.submit({ ...cases[5].values, date: destination });
  assert.equal(h.state.metrics.find(item => item.date === destination).focus, 100);
  assert.equal(h.saved.length, 0);
});

test('a new metric for an untouched date is allowed after unrelated updates', () => {
  const h = harness(); const date = addDays(todayISO(), -1);
  h.click('log-metrics', { date });
  h.remote(state => { state.metrics[0].focus = 60; });
  h.submit({ ...cases[5].values, date });
  assert.equal(h.saved.length, 1);
  assert.equal(h.state.metrics.find(item => item.date === date).focus, 25);
  assert.equal(h.state.metrics.find(item => item.date === todayISO()).focus, 60);
});

test('reopening after copying a conflicted draft establishes a fresh editable baseline', () => {
  const h = harness(); h.click('edit-note', { id: 'note' });
  h.remote(state => { state.notes[0].body = 'Latest remote body'; });
  h.submit(clone(cases[0].values)); assert.equal(h.saved.length, 0);
  h.click('close-dialog'); h.click('edit-note', { id: 'note' });
  h.submit({ ...cases[0].values, body: 'Latest remote body plus copied draft' });
  assert.equal(h.saved.length, 1);
  assert.equal(h.state.notes[0].body, 'Latest remote body plus copied draft');
});

test('scope changes still clear the editor and prevent an old detached form writing into the new account', () => {
  const h = harness(); h.click('edit-note', { id: 'note' }); const oldForm = h.form;
  h.context.STORAGE_KEY = 'life-os.workspace.v1.account.new';
  h.remote(state => { state.notes = []; });
  assert.equal(h.nodes.get('#dialog-content').innerHTML, '');
  assert.equal(h.dialog.open, false);
  h.submit(clone(cases[0].values), oldForm);
  assert.equal(h.saved.length, 0);
  assert.equal(h.state.notes.length, 0);
});

for (const collection of ['tasks', 'notes', 'decisions', 'goals']) test(`undo of a synchronized ${collection} restoration preserves the latest item without duplicate IDs`, () => {
  const h = harness(); const original = clone(h.state[collection][0]);
  const isTask = collection === 'tasks';
  h.click(isTask ? 'confirm-delete-task' : 'confirm-delete-item', { id: original.id, kind: collection });
  assert.equal(h.state[collection].length, 0);
  h.remote(state => { state[collection].push({ ...original, title: 'Restored remote edit' }); });
  const saves = h.saved.length;
  h.click(isTask ? 'undo-task' : 'undo-item');
  assert.equal(h.state[collection].length, 1);
  assert.equal(h.state[collection][0].title, 'Restored remote edit');
  assert.equal(h.saved.length, saves, 'already restored entity needs no stale persistence write');
  h.click(isTask ? 'undo-task' : 'undo-item');
  assert.equal(h.state[collection].length, 1, 'undo state is consumed');
});
