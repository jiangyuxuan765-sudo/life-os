export const GUEST_STORAGE_KEY = 'life-os.workspace.v1';
export let STORAGE_KEY = GUEST_STORAGE_KEY;
export function createEmptyState() {
  return { version: 1, tasks: [], decisions: [], metrics: [], goals: [], notes: [], timer: { taskId: '', remaining: 1500, duration: 1500, running: false, endsAt: null }, settings: { seeded: false } };
}
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function todayISO() { return iso(new Date()); }
export function addDays(date, n) {
  const d = date instanceof Date ? new Date(date) : new Date(`${date}T12:00:00`);
  if (!Number.isFinite(d.getTime())) throw new Error('日期格式无效');
  d.setDate(d.getDate() + n);
  return iso(d);
}
export function weekDates(anchor = todayISO()) {
  const d = new Date(`${anchor}T12:00:00`);
  const monday = addDays(anchor, -((d.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}
export function uid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function initialState() {
  const today = todayISO();
  const week = weekDates(today)[0];
  return {
    version: 1,
    tasks: [
      { id: 'task-morning', title: '晨间阅读 · 给自己半小时', date: today, time: '08:00', duration: 30, category: '成长', priority: 'normal', done: true },
      { id: 'task-portfolio', title: '完成个人作品集的首页架构', date: today, time: '14:00', duration: 90, category: '成长', priority: 'high', done: false },
      { id: 'task-run', title: '到户外走走，完成 30 分钟慢跑', date: today, time: '18:30', duration: 30, category: '健康', priority: 'normal', done: false },
      { id: 'task-review', title: '整理上周项目复盘', date: addDays(today, -1), time: '10:00', duration: 45, category: '工作', priority: 'normal', done: true },
      { id: 'task-proposal', title: '写下新项目的三个方向', date: addDays(today, 1), time: '10:00', duration: 60, category: '工作', priority: 'high', done: false },
      { id: 'task-learn', title: '学习设计课程第二章', date: addDays(today, 2), time: '20:00', duration: 45, category: '成长', priority: 'normal', done: false },
      { id: 'task-home', title: '整理书桌，清空收件箱', date: addDays(today, 3), time: '16:00', duration: 30, category: '生活', priority: 'normal', done: false },
      { id: 'task-plan', title: '周末留一个下午给家人', date: addDays(week, 5), time: '14:00', duration: 120, category: '生活', priority: 'normal', done: false }
    ],
    decisions: [
      { id: 'decision-direction', title: '下一阶段，把精力放在哪里？', context: '工作之外的时间有限。希望选一个能持续投入、也能获得长期回报的方向。', category: '成长', deadline: addDays(today, 2), impact: '高', status: 'pending', options: ['打磨个人作品集', '系统学习一项新技能', '持续写作与分享'], choice: '', reason: '' },
      { id: 'decision-event', title: '要不要参加周末的线下活动？', context: '认识新的朋友，也需要保留休息的时间。先看清这次参加的真正目的。', category: '生活', deadline: addDays(today, 3), impact: '中', status: 'pending', options: ['参加半天', '这次不参加，留给休息'], choice: '', reason: '' },
      { id: 'decision-budget', title: '如何分配这个季度的学习预算？', context: '在课程、书籍和实践项目之间，优先考虑能立刻开始应用的投入。', category: '成长', deadline: addDays(today, 7), impact: '高', status: 'pending', options: ['优先购买系统课程', '书籍与实践项目各一半', '先使用现有资源'], choice: '', reason: '' },
      { id: 'decision-routine', title: '把早晨最清醒的时间留给自己', context: '减少起床后刷手机的时间，建立能长期坚持的晨间节奏。', category: '健康', deadline: addDays(today, -1), impact: '中', status: 'decided', options: ['早起半小时阅读', '晨间运动', '自由安排'], choice: '早起半小时阅读', reason: '从容易坚持的小习惯开始，每周复盘一次。' }
    ],
    metrics: Array.from({ length: 7 }, (_, i) => ({ date: addDays(today, i - 6), energy: [6, 7, 5, 8, 6, 7, 8][i], sleep: [7, 7.5, 6.5, 8, 7, 7.5, 7.8][i], exercise: [20, 30, 0, 45, 0, 30, 30][i], focus: [60, 120, 45, 150, 90, 120, 135][i] })),
    goals: [
      { id: 'goal-portfolio', title: '做出作品集的第一版', week, done: false },
      { id: 'goal-health', title: '让运动成为本周的固定安排', week, done: false },
      { id: 'goal-review', title: '完成一次认真、诚实的周复盘', week, done: false }
    ],
    notes: [
      { id: 'note-rhythm', title: '把复杂的事，拆成眼前的一小步。', body: '先写结构，再补内容，最后留出修改时间。开始行动之后，焦虑就少了一点。\n\n明天继续：专注一个小时，完成首页的第一稿。', tag: '每日复盘', date: addDays(today, -1), createdAt: `${addDays(today, -1)}T21:30:00` },
      { id: 'note-space', title: '留白也是计划的一部分', body: '不需要把每一个时段填满。给思绪一点漫游的空间，给生活一点意外的余地。', tag: '灵感', date: addDays(today, -2), createdAt: `${addDays(today, -2)}T15:20:00` },
      { id: 'note-small', title: '今天值得记住的小事', body: '下班路上的晚风很好。买了一束花，做了一顿简单的晚饭。\n把这些普通的时刻也认真记下来。', tag: '随手记', date: addDays(today, -3), createdAt: `${addDays(today, -3)}T20:10:00` }
    ],
    timer: { taskId: '', remaining: 1500, duration: 1500, running: false, endsAt: null },
    settings: { seeded: true }
  };
}
const isDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00`));
const numberWithin = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text = value => typeof value === 'string';
export function validState(s) {
  if (!s || s.version !== 1 || !['tasks', 'decisions', 'metrics', 'goals', 'notes'].every(k => Array.isArray(s[k]))) return false;
  if (!s.tasks.every(t => t && text(t.id) && text(t.title) && isDate(t.date) && text(t.time) && numberWithin(t.duration, 1, 1440) && text(t.category) && ['high', 'normal'].includes(t.priority) && typeof t.done === 'boolean')) return false;
  if (!s.decisions.every(d => d && text(d.id) && text(d.title) && text(d.context) && ['pending', 'decided', 'paused'].includes(d.status) && ['高', '中', '低'].includes(d.impact) && (d.deadline === '' || isDate(d.deadline)) && Array.isArray(d.options) && d.options.every(text) && text(d.choice) && text(d.reason))) return false;
  if (!s.metrics.every(m => m && isDate(m.date) && (m.energy === null || numberWithin(m.energy, 1, 10)) && (m.sleep === null || numberWithin(m.sleep, 0, 24)) && (m.exercise === null || numberWithin(m.exercise, 0, 1440)) && numberWithin(m.focus, 0, 1440))) return false;
  if (!s.goals.every(g => g && text(g.id) && text(g.title) && isDate(g.week) && typeof g.done === 'boolean')) return false;
  if (!s.notes.every(n => n && text(n.id) && text(n.title) && text(n.body) && text(n.tag) && isDate(n.date))) return false;
  if (s.timer && (!numberWithin(s.timer.duration, 1, 86400) || !numberWithin(s.timer.remaining, 0, 86400) || typeof s.timer.running !== 'boolean' || (s.timer.endsAt !== null && !numberWithin(s.timer.endsAt, 0, Number.MAX_SAFE_INTEGER)))) return false;
  return true;
}
let requiresRecovery = false;
let lastReadRaw = null;
export function setStorageScope(userId = '', project = '') {
  STORAGE_KEY = userId ? `${GUEST_STORAGE_KEY}.account.${encodeURIComponent(project)}.${encodeURIComponent(userId)}` : GUEST_STORAGE_KEY;
  requiresRecovery = false;
  lastReadRaw = null;
}
export function readGuestState() {
  const raw = localStorage.getItem(GUEST_STORAGE_KEY);
  if (!raw) return null;
  const state = JSON.parse(raw);
  if (!validState(state)) throw new Error('本机内容格式不完整，请先导出备份。');
  return state;
}
export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    lastReadRaw = raw;
    if (!raw) return STORAGE_KEY === GUEST_STORAGE_KEY ? initialState() : createEmptyState();
    const state = JSON.parse(raw);
    if (!validState(state)) throw new Error('本地数据格式不完整');
    state.timer ||= { taskId: '', remaining: 1500, duration: 1500, running: false, endsAt: null };
    state.settings ||= {};
    return state;
  } catch (cause) {
    requiresRecovery = true;
    const state = STORAGE_KEY === GUEST_STORAGE_KEY ? initialState() : createEmptyState();
    Object.defineProperty(state, 'error', { value: new Error('暂时无法读取已有数据。已载入示例；原数据将在首次保存前备份。', { cause }), enumerable: false });
    return state;
  }
}
export function saveState(state) {
  if (!validState(state)) throw new Error('数据格式不完整，未保存；请检查输入后重试。');
  try {
    const currentRaw = localStorage.getItem(STORAGE_KEY);
    if (currentRaw !== lastReadRaw) {
      const conflict = new Error('另一窗口刚刚更新了数据，本次修改尚未保存。请刷新后重试。');
      conflict.code = 'STORAGE_CONFLICT';
      throw conflict;
    }
    if (requiresRecovery) {
      const previous = localStorage.getItem(STORAGE_KEY);
      if (previous) localStorage.setItem(`${STORAGE_KEY}.recovery.${Date.now()}`, previous);
      requiresRecovery = false;
    }
    const serialized = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, serialized);
    lastReadRaw = serialized;
  } catch (cause) {
    if (cause.code === 'STORAGE_CONFLICT') throw cause;
    throw new Error('当前浏览器无法保存数据，请检查存储空间或隐私设置。', { cause });
  }
}
