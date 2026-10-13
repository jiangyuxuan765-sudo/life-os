/**
 * Pure three-way merge for Life OS snapshots.
 *
 * `base` MUST be the last snapshot acknowledged by both this client and the
 * server, rather than the current local snapshot. It may be null for a first
 * connection. Validate snapshots with store.js before merging and validate the
 * returned state before saving it. This module checks identities/JSON shape,
 * but deliberately does not maintain a second copy of the application schema.
 *
 * On conflicting field edits, remote wins that field; unrelated local edits
 * still survive. Every conflict contains independent, complete entity copies
 * suitable for durable recovery/export. Persist those copies before accepting
 * the merged state. No IDs are generated and input objects are never mutated.
 */

const COLLECTIONS = Object.freeze({
  tasks: 'id',
  decisions: 'id',
  goals: 'id',
  notes: 'id',
  metrics: 'date',
});
const ABSENT = Symbol('absent');
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function equal(a, b) {
  if (a === b) return true;
  if (a === ABSENT || b === ABSENT || a === null || b === null) return false;
  if (typeof a !== typeof b || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length && aKeys.every(key => own(b, key) && equal(a[key], b[key]));
}

// Object.fromEntries also safely preserves an own "__proto__" JSON property.
function copy(value) {
  if (value === ABSENT) return ABSENT;
  if (Array.isArray(value)) return value.map(copy);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)]));
  return value;
}

function assertJson(value, path, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!isRecord(value) && !Array.isArray(value)) throw new TypeError(`${path} must contain JSON values only`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must be a plain JSON object`);
  if (ancestors.has(value)) throw new TypeError(`${path} must not be cyclic`);
  ancestors.add(value);
  for (const [key, entry] of Object.entries(value)) assertJson(entry, `${path}.${key}`, ancestors);
  ancestors.delete(value);
}

function indexCollection(items, key, path) {
  if (!Array.isArray(items)) throw new TypeError(`${path} must be an array`);
  const indexed = new Map();
  for (const item of items) {
    if (!isRecord(item) || typeof item[key] !== 'string' || !item[key]) throw new TypeError(`${path} entities need a nonempty ${key}`);
    if (indexed.has(item[key])) throw new TypeError(`${path} has duplicate ${key}: ${item[key]}`);
    indexed.set(item[key], item);
  }
  return indexed;
}

function inspectState(state, name, allowNull = false) {
  if (allowNull && state == null) return null;
  if (!isRecord(state)) throw new TypeError(`${name} must be a state object`);
  assertJson(state, name);
  const indexes = {};
  for (const [collection, key] of Object.entries(COLLECTIONS)) indexes[collection] = indexCollection(state[collection], key, `${name}.${collection}`);
  if (own(state, 'settings') && !isRecord(state.settings)) throw new TypeError(`${name}.settings must be an object`);
  if (own(state, 'timer') && !isRecord(state.timer)) throw new TypeError(`${name}.timer must be an object`);
  return indexes;
}

function recoveryValue(value) { return value === ABSENT ? null : copy(value); }

function conflict(context, kind, base, local, remote, fields = []) {
  context.conflicts.push({
    collection: context.collection,
    id: context.id,
    kind,
    fields: [...fields],
    base: recoveryValue(base),
    local: recoveryValue(local),
    remote: recoveryValue(remote),
  });
}

function mergeFields(base, local, remote, context) {
  const original = base === ABSENT ? {} : base;
  const keys = new Set([...Object.keys(remote), ...Object.keys(local), ...Object.keys(original)]);
  const output = [];
  const collisions = [];
  for (const key of keys) {
    const b = own(original, key) ? original[key] : ABSENT;
    const l = own(local, key) ? local[key] : ABSENT;
    const r = own(remote, key) ? remote[key] : ABSENT;
    let value;
    if (equal(l, r)) value = l;
    else if (equal(l, b)) value = r;
    else if (equal(r, b)) value = l;
    else { value = r; collisions.push(key); }
    if (value !== ABSENT) output.push([key, copy(value)]);
  }
  if (collisions.length) conflict(context, base === ABSENT ? 'concurrent-add' : 'field-conflict', base, local, remote, collisions);
  return Object.fromEntries(output);
}

function mergeEntity(base, local, remote, context, atomic = false) {
  if (equal(local, remote)) return copy(local);
  if (equal(local, base)) return copy(remote);
  if (equal(remote, base)) return copy(local);

  // At this point both sides changed relative to the common baseline. Preserve
  // content if one device deleted while the other device edited the entity.
  if (local === ABSENT || remote === ABSENT) {
    conflict(context, 'delete-vs-edit', base, local, remote);
    return copy(local === ABSENT ? remote : local);
  }

  if (atomic) {
    conflict(context, 'atomic-conflict', base, local, remote);
    return copy(remote);
  }
  return mergeFields(base, local, remote, context);
}

/**
 * @returns {{state: Object, conflicts: Array<{
 *   collection: string, id: string, kind: string, fields: string[],
 *   base: Object|null, local: Object|null, remote: Object|null
 * }>}}
 *
 * Collection order is deterministic: remote order first, then local-only
 * entities in local order. Reordering collections is not a content edit.
 * Nested arrays/objects are atomic fields, not recursively text-merged.
 * No conflict copies are added to the user's collections automatically.
 */
export function mergeStates(base, local, remote) {
  const baseIndexes = inspectState(base, 'base', true);
  const localIndexes = inspectState(local, 'local');
  const remoteIndexes = inspectState(remote, 'remote');
  const conflicts = [];
  const state = {};

  for (const collection of Object.keys(COLLECTIONS)) {
    const b = baseIndexes?.[collection] || new Map();
    const l = localIndexes[collection];
    const r = remoteIndexes[collection];
    const identities = new Set([...r.keys(), ...l.keys(), ...b.keys()]);
    const merged = [];
    for (const id of identities) {
      const entity = mergeEntity(b.get(id) ?? ABSENT, l.get(id) ?? ABSENT, r.get(id) ?? ABSENT, { collection, id, conflicts });
      if (entity !== ABSENT) merged.push(entity);
    }
    state[collection] = merged;
  }

  // Timer fields are coupled: mixing endsAt from one device with running or
  // remaining from another can double-count or resurrect a finished session.
  for (const key of ['timer', 'settings']) {
    const merged = mergeEntity(
      base && own(base, key) ? base[key] : ABSENT,
      own(local, key) ? local[key] : ABSENT,
      own(remote, key) ? remote[key] : ABSENT,
      { collection: key, id: key, conflicts },
      key === 'timer',
    );
    if (merged !== ABSENT) state[key] = merged;
  }

  // Preserve version and future top-level metadata instead of silently dropping
  // unfamiliar fields. Metadata arrays use the same atomic-field policy.
  const metadata = snapshot => Object.fromEntries(Object.entries(snapshot || {}).filter(([key]) => !own(COLLECTIONS, key) && key !== 'timer' && key !== 'settings'));
  const mergedMetadata = mergeFields(base ? metadata(base) : ABSENT, metadata(local), metadata(remote), { collection: 'state', id: 'state', conflicts });
  for (const [key, value] of Object.entries(mergedMetadata)) Object.defineProperty(state, key, { value, enumerable: true, writable: true, configurable: true });
  return { state, conflicts };
}

/** Compare persisted content, ignoring entity order but including timer/settings. */
export function hasUserContentChanges(base, next) {
  const nextIndexes = inspectState(next, 'next');
  if (base == null) return true;
  const baseIndexes = inspectState(base, 'base');
  for (const collection of Object.keys(COLLECTIONS)) {
    const previous = baseIndexes[collection];
    const current = nextIndexes[collection];
    if (previous.size !== current.size) return true;
    for (const [id, entity] of previous) if (!current.has(id) || !equal(entity, current.get(id))) return true;
  }
  const metadata = snapshot => Object.fromEntries(Object.entries(snapshot).filter(([key]) => !own(COLLECTIONS, key)));
  return !equal(metadata(base), metadata(next));
}
