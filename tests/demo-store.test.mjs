import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
async function freshStore() { return import(`../store.js?demo-test=${++instance}`); }

test('demo loads fresh examples and supports changes without touching either browser storage', async t => {
  const original = new Map(['location', 'localStorage', 'sessionStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  globalThis.location = { search: '?demo=1', hash: '#record' };
  for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, key, { configurable: true, get() { assert.fail(`demo accessed ${key}`); } });
  }
  const store = await freshStore();
  assert.equal(store.IS_DEMO, true);
  const originalKey = store.STORAGE_KEY;
  const state = store.loadState();
  assert.equal(store.validState(state), true);
  for (const name of ['tasks', 'decisions', 'metrics', 'goals', 'notes']) assert.ok(state[name].length > 0);
  const expected = structuredClone(state);
  state.tasks[0].done = !state.tasks[0].done;
  state.decisions[0].choice = state.decisions[0].options[0];
  state.decisions[0].status = 'decided';
  state.metrics[0].energy = 10;
  state.goals[0].done = true;
  state.notes[0].body = 'temporary demonstration only';
  state.timer.running = true;
  state.timer.endsAt = Date.now() + 1500000;
  assert.doesNotThrow(() => store.saveState(state));
  assert.equal(state.notes[0].body, 'temporary demonstration only');
  assert.equal(store.readGuestState(), null);
  store.setStorageScope('real-account', 'real-project');
  assert.equal(store.STORAGE_KEY, originalKey);
  assert.deepEqual(store.loadState(), expected);
  const refreshed = await freshStore();
  assert.deepEqual(refreshed.loadState(), expected);
  state.metrics[0].energy = 99;
  assert.throws(() => store.saveState(state), /数据格式不完整/);
});

test('only an explicit demo=1 enables demo and normal mode retains existing data', async t => {
  const originalLocation = globalThis.location;
  const originalStorage = globalThis.localStorage;
  t.after(() => {
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
  });
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  for (const search of ['', '?demo=0', '?demo=true', '?other=1']) {
    globalThis.location = { search };
    const store = await freshStore();
    assert.equal(store.IS_DEMO, false);
    const state = store.loadState();
    state.notes[0].body = `private content ${search}`;
    store.saveState(state);
    assert.equal(store.loadState().notes[0].body, `private content ${search}`);
  }
  const privateSnapshot = [...values];
  globalThis.location = { search: '?demo=1' };
  const demo = await freshStore();
  const demoState = demo.loadState();
  assert.ok(!demoState.notes.some(note => note.body.includes('private content')));
  demoState.notes[0].body = 'demo content';
  demo.saveState(demoState);
  assert.deepEqual([...values], privateSnapshot);
});
