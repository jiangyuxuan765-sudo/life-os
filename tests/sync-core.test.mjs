import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates, hasUserContentChanges } from '../sync-core.js';

const clone = value => structuredClone(value);
const task = (id, title = `Task ${id}`) => ({ id, title, date: '2026-10-13', time: '09:00', duration: 25, category: '成长', priority: 'normal', done: false });
const note = (id, body = 'Original note') => ({ id, title: `Note ${id}`, body, date: '2026-10-13', tag: '随手记' });
const initial = () => ({
  version: 1,
  tasks: [task('a'), task('b')],
  decisions: [{ id: 'choice', title: 'Choose', context: 'Original', category: '成长', impact: '高', deadline: '', options: ['A', 'B'], status: 'pending', choice: '', reason: '' }],
  goals: [{ id: 'goal', title: 'A meaningful week', week: '2026-10-12', done: false }],
  notes: [note('note')],
  metrics: [{ date: '2026-10-13', energy: 7, sleep: 8, exercise: 30, focus: 50 }],
  timer: { taskId: 'a', remaining: 1500, duration: 1500, running: false, endsAt: null },
  settings: { seeded: true, theme: 'dark' },
});

test('unchanged snapshots are cloned without conflicts or input mutation', () => {
  const base = initial();
  const local = clone(base);
  const remote = clone(base);
  const result = mergeStates(base, local, remote);
  assert.deepEqual(result.state, base);
  assert.deepEqual(result.conflicts, []);
  result.state.tasks[0].title = 'Changed output';
  result.state.decisions[0].options.push('C');
  assert.equal(local.tasks[0].title, 'Task a');
  assert.deepEqual(remote.decisions[0].options, ['A', 'B']);
});

test('independent offline additions from both devices survive in every collection', () => {
  const base = initial();
  const local = clone(base);
  const remote = clone(base);
  for (const collection of ['tasks', 'decisions', 'goals', 'notes']) {
    local[collection].push({ ...clone(base[collection][0]), id: `${collection}-local` });
    remote[collection].push({ ...clone(base[collection][0]), id: `${collection}-remote` });
  }
  local.metrics.push({ ...base.metrics[0], date: '2026-10-14' });
  remote.metrics.push({ ...base.metrics[0], date: '2026-10-15' });
  const result = mergeStates(base, local, remote);
  for (const collection of ['tasks', 'decisions', 'goals', 'notes']) {
    assert.ok(result.state[collection].some(item => item.id === `${collection}-local`));
    assert.ok(result.state[collection].some(item => item.id === `${collection}-remote`));
  }
  assert.equal(result.state.metrics.length, 3);
  assert.deepEqual(result.conflicts, []);
});

test('edits to different fields merge and identical simultaneous edits are not conflicts', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.tasks[0].title = 'Local title';
  remote.tasks[0].done = true;
  local.tasks[1].priority = remote.tasks[1].priority = 'high';
  local.metrics[0].energy = 9;
  remote.metrics[0].focus = 75;
  local.settings.theme = 'light';
  remote.settings.weekStart = 'monday';
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.equal(state.tasks[0].title, 'Local title');
  assert.equal(state.tasks[0].done, true);
  assert.equal(state.tasks[1].priority, 'high');
  assert.equal(state.metrics[0].energy, 9);
  assert.equal(state.metrics[0].focus, 75);
  assert.deepEqual(state.settings, { seeded: true, theme: 'light', weekStart: 'monday' });
  assert.deepEqual(conflicts, []);
});

test('local deletion propagates across an unchanged offline remote copy', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.tasks = local.tasks.filter(item => item.id !== 'a');
  remote.tasks[1].title = 'An unrelated remote edit';
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].title, 'An unrelated remote edit');
  assert.deepEqual(conflicts, []);
});

test('remote deletion is not resurrected by a stale unchanged local copy', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  remote.notes = [];
  local.tasks[0].done = true;
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.deepEqual(state.notes, []);
  assert.equal(state.tasks[0].done, true);
  assert.deepEqual(conflicts, []);
});

test('both devices deleting an entity leave it deleted without conflict', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.goals = remote.goals = [];
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.deepEqual(state.goals, []);
  assert.deepEqual(conflicts, []);
});

test('delete versus edit preserves the edited entity and records both versions in either direction', () => {
  for (const deletedSide of ['local', 'remote']) {
    const base = initial(), local = clone(base), remote = clone(base);
    const deleted = deletedSide === 'local' ? local : remote;
    const edited = deletedSide === 'local' ? remote : local;
    deleted.notes = [];
    edited.notes[0].body = `Work written while ${deletedSide} was deleting`;
    const { state, conflicts } = mergeStates(base, local, remote);
    assert.equal(state.notes[0].body, edited.notes[0].body);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].kind, 'delete-vs-edit');
    assert.equal(conflicts[0][deletedSide], null);
    assert.deepEqual(conflicts[0].base, base.notes[0]);
  }
});

test('conflicting field changes favor remote but preserve complete local data and independent local edits', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.notes[0].body = 'Long offline writing that must be recoverable';
  local.notes[0].title = 'Local-only title';
  remote.notes[0].body = 'Remote writing';
  const result = mergeStates(base, local, remote);
  assert.equal(result.state.notes[0].body, 'Remote writing');
  assert.equal(result.state.notes[0].title, 'Local-only title');
  assert.deepEqual(result.conflicts, [{ collection: 'notes', id: 'note', kind: 'field-conflict', fields: ['body'], base: base.notes[0], local: local.notes[0], remote: remote.notes[0] }]);
  result.conflicts[0].local.body = 'Altered export';
  assert.equal(local.notes[0].body, 'Long offline writing that must be recoverable');
  assert.equal(result.state.notes.length, 1, 'no nondeterministic duplicate entities are generated');
});

test('same-date metric conflict is recovered explicitly without duplicate dates or automatic addition', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.metrics[0].focus = 75;
  remote.metrics[0].focus = 100;
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.equal(state.metrics.length, 1);
  assert.equal(state.metrics[0].focus, 100);
  assert.equal(conflicts[0].collection, 'metrics');
  assert.equal(conflicts[0].id, '2026-10-13');
  assert.equal(conflicts[0].local.focus, 75);
});

test('timer is atomic even when edits appear to touch independent fields', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.timer = { ...base.timer, running: true, endsAt: 1700000000000 };
  remote.timer.remaining = 800;
  remote.timer.taskId = 'b';
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.deepEqual(state.timer, remote.timer);
  assert.equal(state.timer.running, false);
  assert.equal(state.timer.endsAt, null);
  assert.equal(conflicts[0].kind, 'atomic-conflict');
  assert.deepEqual(conflicts[0].local, local.timer);
});

test('one-sided timer and settings changes survive normally', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.timer.running = true;
  local.timer.endsAt = 1700000000000;
  remote.settings.seeded = false;
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.deepEqual(state.timer, local.timer);
  assert.equal(state.settings.seeded, false);
  assert.deepEqual(conflicts, []);
});

test('null baseline conservatively merges first-connection content rather than assuming deletions', () => {
  const local = initial(), remote = initial();
  local.notes = [note('offline', 'Offline note')];
  remote.notes = [note('cloud', 'Cloud note')];
  const { state, conflicts } = mergeStates(null, local, remote);
  assert.deepEqual(state.notes.map(item => item.id), ['cloud', 'offline']);
  assert.deepEqual(conflicts, []);
});

test('simultaneous same-ID additions with different content preserve a conflict recovery record', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.notes.push(note('collision', 'Local creation'));
  remote.notes.push(note('collision', 'Remote creation'));
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.equal(state.notes.find(item => item.id === 'collision').body, 'Remote creation');
  assert.equal(conflicts[0].kind, 'concurrent-add');
  assert.equal(conflicts[0].base, null);
  assert.equal(conflicts[0].local.body, 'Local creation');
});

test('field removal is distinct from an explicit null value', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  base.settings.preference = local.settings.preference = remote.settings.preference = 'old';
  delete local.settings.preference;
  remote.settings.preference = null;
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.equal(state.settings.preference, null);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].fields, ['preference']);
  assert.equal(Object.hasOwn(conflicts[0].local, 'preference'), false);
});

test('arrays inside entities are atomic fields and their conflicting content is recoverable', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.decisions[0].options.push('Local option');
  remote.decisions[0].options.push('Remote option');
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.deepEqual(state.decisions[0].options, ['A', 'B', 'Remote option']);
  assert.deepEqual(conflicts[0].local.options, ['A', 'B', 'Local option']);
});

test('content comparison ignores entity ordering but catches timer, deletion, and field edits', () => {
  const base = initial(), next = clone(base);
  next.tasks.reverse();
  assert.equal(hasUserContentChanges(base, next), false);
  next.tasks[0].done = true;
  assert.equal(hasUserContentChanges(base, next), true);
  assert.equal(hasUserContentChanges(null, base), true);
  const timer = clone(base); timer.timer.remaining = 100;
  assert.equal(hasUserContentChanges(base, timer), true);
  const deleted = clone(base); deleted.notes = [];
  assert.equal(hasUserContentChanges(base, deleted), true);
});

test('merged output is stable when used as the next shared baseline', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.tasks[0].title = 'Offline edit';
  remote.tasks[0].done = true;
  remote.tasks.push(task('new'));
  const once = mergeStates(base, local, remote);
  const again = mergeStates(once.state, clone(once.state), clone(once.state));
  assert.deepEqual(again, { state: once.state, conflicts: [] });
  assert.equal(hasUserContentChanges(once.state, again.state), false);
});

test('unknown top-level metadata is preserved with explicit collision recovery', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  base.completedTimerIds = [];
  local.completedTimerIds = ['local-session'];
  remote.completedTimerIds = ['remote-session'];
  const { state, conflicts } = mergeStates(base, local, remote);
  assert.deepEqual(state.completedTimerIds, ['remote-session']);
  assert.equal(conflicts[0].collection, 'state');
  assert.deepEqual(conflicts[0].local.completedTimerIds, ['local-session']);
});

test('duplicate identities and non-JSON values fail closed instead of silently losing entities', () => {
  const base = initial(), duplicate = clone(base);
  duplicate.tasks.push(task('a', 'Different content under duplicate ID'));
  assert.throws(() => mergeStates(base, duplicate, base), /duplicate id/);
  const missing = clone(base); delete missing.tasks[0].id;
  assert.throws(() => mergeStates(base, missing, base), /nonempty id/);
  const invalid = clone(base); invalid.metrics[0].energy = NaN;
  assert.throws(() => mergeStates(base, invalid, base), /JSON values/);
  const cyclic = clone(base); cyclic.settings.self = cyclic.settings;
  assert.throws(() => mergeStates(base, cyclic, base), /cyclic/);
});

test('JSON keys such as __proto__ are copied as data, without prototype mutation', () => {
  const base = initial(), local = clone(base), remote = clone(base);
  local.settings = JSON.parse('{"seeded":true,"theme":"dark","__proto__":{"polluted":true}}');
  const { state } = mergeStates(base, local, remote);
  assert.equal(Object.getPrototypeOf(state.settings), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(state.settings, '__proto__').value, { polluted: true });
  assert.equal({}.polluted, undefined);
});
