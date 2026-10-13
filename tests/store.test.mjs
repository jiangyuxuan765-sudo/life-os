import test from 'node:test';
import assert from 'node:assert/strict';

function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
let instance = 0;
async function freshStore() { return import(`../store.js?test=${++instance}`); }

test('date calculations preserve full weeks over month/year boundaries', async () => {
  const store = await freshStore();
  assert.deepEqual(store.weekDates('2026-01-01'), ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  assert.equal(store.addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(store.addDays('2026-10-13', -7), '2026-10-06');
});

test('edited data round-trips without reseeding; timer-only metrics preserve missing values', async () => {
  globalThis.localStorage = storage();
  const store = await freshStore();
  const state = store.loadState();
  state.tasks[0].title = '保留 <b>原文</b> & 中文';
  state.decisions[0].deadline = '';
  state.metrics.push({ date: '2020-01-01', energy: null, sleep: null, exercise: null, focus: 25 });
  store.saveState(state);
  const restored = store.loadState();
  assert.equal(restored.tasks[0].title, '保留 <b>原文</b> & 中文');
  assert.equal(restored.decisions[0].deadline, '');
  assert.equal(restored.metrics.at(-1).energy, null);
  assert.equal(restored.metrics.at(-1).focus, 25);
  assert.equal(restored.tasks.length, state.tasks.length);
});

test('stale windows cannot overwrite a newer saved state', async () => {
  globalThis.localStorage = storage();
  const a = await freshStore();
  const b = await freshStore();
  const stateA = a.loadState();
  const stateB = b.loadState();
  stateA.notes.push({ id: 'new-in-a', title: '窗口A的新记录', body: '保留这条', tag: '随手记', date: a.todayISO() });
  a.saveState(stateA);
  stateB.tasks[0].done = !stateB.tasks[0].done;
  assert.throws(() => b.saveState(stateB), error => error.code === 'STORAGE_CONFLICT');
  assert.ok(a.loadState().notes.some(note => note.id === 'new-in-a'));
  const refreshedB = b.loadState();
  refreshedB.tasks[0].done = !refreshedB.tasks[0].done;
  b.saveState(refreshedB);
  assert.ok(b.loadState().notes.some(note => note.id === 'new-in-a'));
});

test('corrupted saved data is preserved and backed up before recovery', async () => {
  globalThis.localStorage = storage();
  const store = await freshStore();
  localStorage.setItem(store.STORAGE_KEY, '{broken-but-not-deleted');
  const recovered = store.loadState();
  assert.ok(recovered.error);
  assert.equal(localStorage.getItem(store.STORAGE_KEY), '{broken-but-not-deleted');
  store.saveState(recovered);
  const backup = [...localStorage.values].find(([key]) => key.startsWith(`${store.STORAGE_KEY}.recovery.`));
  assert.equal(backup[1], '{broken-but-not-deleted');
  assert.equal(store.loadState().version, 1);
});

test('storage failure is explicit and never replaces a valid saved snapshot', async () => {
  globalThis.localStorage = storage();
  const store = await freshStore();
  const state = store.loadState();
  store.saveState(state);
  const before = localStorage.getItem(store.STORAGE_KEY);
  state.metrics[0].energy = 99;
  assert.throws(() => store.saveState(state), /数据格式不完整/);
  assert.equal(localStorage.getItem(store.STORAGE_KEY), before);
  state.metrics[0].energy = 7;
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.throws(() => store.saveState(state), /无法保存数据/);
  assert.equal(localStorage.getItem(store.STORAGE_KEY), before);
});
