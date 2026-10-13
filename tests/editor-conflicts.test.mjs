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

function harness() {
  const nodes = new Map(), handlers = new Map(), saved = [];
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
    STORAGE_KEY: 'life-os.workspace.v1', todayISO, addDays, weekDates, uid: () => `new-${++serial}`,
    loadState: initial,
    saveState: state => { assert.equal(validState(state), true); saved.push(clone(state)); },
    CloudSync: class { constructor(options) { cloud = options; } schedulePush() {} async start() {} },
    mountCloudUI() {},
    document: { querySelector: element, querySelectorAll: () => [], documentElement: new Element(), activeElement: new Element(), addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); } },
    window: { addEventListener() {}, scrollTo() {} },
    location: { hash: '#decision' },
    requestAnimationFrame: fn => fn(), setInterval: () => 1, setTimeout: () => 1, clearTimeout() {},
    FormData: class { constructor(form) { this.data = form.values; } [Symbol.iterator]() { return Object.entries(this.data)[Symbol.iterator](); } get(key) { return this.data[key]; } },
  };
  vm.runInNewContext(source, context, { filename: 'app.js' });
  return {
    saved, nodes, context,
    get state() { return cloud.getState(); },
    get form() { return element('#dialog-content').form; },
    get dialog() { return element('#editor-dialog'); },
    click(action, extra = {}, form = null) { const trigger = { dataset: { action, ...extra }, tagName: 'BUTTON', closest: selector => selector === 'form' ? form : null }; for (const handler of handlers.get('click') || []) handler({ target: { closest: () => trigger }, preventDefault() {} }); },
    submit(values, form = this.form) { form.values = values; for (const handler of handlers.get('submit') || []) handler({ target: form, preventDefault() {} }); },
    remote(change) { const next = clone(cloud.getState()); change(next); cloud.replaceState(next); },
    error(form = this.form) { return form.querySelector('.form-error').textContent; },
  };
}

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
