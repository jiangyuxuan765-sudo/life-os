import { IS_DEMO, STORAGE_KEY, todayISO, addDays, weekDates, uid, loadState, saveState } from './store.js';
import { CloudSync } from './cloud.js';
import { mountCloudUI } from './cloud-ui.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="M7 17 17 7M7 7h10v10"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>', back: '<path d="m15 5-7 7 7 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>', check: '<path d="m5 12 4 4L19 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  flag: '<path d="M5 21V4m0 0c5-5 9 5 14 0v10c-5 5-9-5-14 0"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15l-1 5Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v6m4-6v6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="m8 4 12 8-12 8V4Z"/>',
  reset: '<path d="M3 10a9 9 0 1 1 1 7M3 4v6h6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.6 13A9 9 0 0 1 11 3.4 9 9 0 1 0 20.6 13Z"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  decision: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10M6 12h10"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.spark}</svg>`;
const pages = { decision: '决策', monitor: '监控', week: '周计划', execute: '执行', record: '记录' };
const state = loadState();
for (const key of ['tasks', 'decisions', 'metrics', 'goals', 'notes']) if (!Array.isArray(state[key])) state[key] = [];
state.timer = { duration: 1500, remaining: 1500, running: false, endsAt: null, taskId: null, ...state.timer };
let page = 'decision';
let decisionFilter = 'all';
let taskFilter = 'pending';
let noteTag = '全部';
let noteQuery = '';
let metricTab = 'energy';
let weekAnchor = todayISO();
let selectedDay = todayISO();
let toastTimeout;
let undoTask = null;
let undoItem = null;
let lastFocused;
const dialog = $('#editor-dialog');
const view = $('#view');
let cloudSync;
let workspaceScope = STORAGE_KEY;
const editorBaselines = new WeakMap();
const editorCollections = { goal: 'goals', decision: 'decisions', resolve: 'decisions', task: 'tasks', note: 'notes', metrics: 'metrics' };
// Entity key order may change after cloud merges; compare values, not insertion order.
function entitySnapshot(value) {
  const ordered = entry => Array.isArray(entry) ? entry.map(ordered) : entry && typeof entry === 'object' ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, ordered(entry[key])])) : entry;
  return JSON.stringify(ordered(value ?? null));
}

function persist() {
  try {
    const result = saveState(state);
    if (result === false || (result && result.ok === false)) throw new Error('Storage unavailable');
    cloudSync?.schedulePush();
    return true;
  } catch (error) {
    toast(error.code === 'STORAGE_CONFLICT' ? error.message : '浏览器无法保存数据。本次修改仍在页面中，请检查存储权限，刷新后可能丢失。', 'error', 9000);
    return false;
  }
}
function toast(message, type = 'success', delay = 4200, action = '') {
  const container = $('#toast');
  if (!container) return;
  clearTimeout(toastTimeout);
  container.innerHTML = `<span>${icon(type === 'error' ? 'flag' : 'check')}${escape(message)}</span>${action}`;
  container.className = `toast-container visible ${type}`;
  toastTimeout = setTimeout(() => { container.className = 'toast-container'; container.innerHTML = ''; }, delay);
}
function commit(message) { const saved = persist(); render(); if (saved && message) toast(message); }
const dateObject = date => new Date(`${date}T12:00:00`);
const dateText = (date, options = { month: 'numeric', day: 'numeric' }) => date ? dateObject(date).toLocaleDateString('zh-CN', options) : '未设置';
const weekDay = date => dateObject(date).toLocaleDateString('zh-CN', { weekday: 'long' });
const compactDate = date => date ? `${dateObject(date).getMonth() + 1}.${String(dateObject(date).getDate()).padStart(2, '0')}` : '—';
const countLabel = value => String(value).padStart(2, '0');
const tasksFor = date => state.tasks.filter(task => task.date === date).sort((a, b) => Number(a.done) - Number(b.done) || (a.time || '23:59').localeCompare(b.time || '23:59'));
const currentWeekTasks = () => state.tasks.filter(task => weekDates(todayISO()).includes(task.date));
const percentage = tasks => tasks.length ? Math.round(tasks.filter(t => t.done).length / tasks.length * 100) : 0;
const statusText = status => ({ pending: '待思考', decided: '已决定', paused: '已搁置' }[status] || '待思考');
const metricNames = { energy: '能量', sleep: '睡眠', exercise: '运动', focus: '专注' };
const metricUnits = { energy: '分', sleep: '小时', exercise: '分钟', focus: '分钟' };

function button(label, action, style = 'secondary', extra = '', glyph = '') {
  return `<button class="button ${style}" type="button" data-action="${action}" ${extra}>${glyph ? icon(glyph) : ''}${label}</button>`;
}
function iconButton(label, action, extra = '', glyph = 'arrow') {
  return `<button class="icon-button" type="button" data-action="${action}" aria-label="${escape(label)}" title="${escape(label)}" ${extra}>${icon(glyph)}</button>`;
}
function heading(eyebrow, title, subtitle, action, label, stats = '') {
  return `<header class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="page-actions">${action ? button(label, action, 'primary', '', 'plus') : ''}</div></header>${stats}`;
}
function filters(items, current, action) {
  return `<div class="filters" role="group" aria-label="筛选">${items.map(([value, label]) => `<button class="filter ${current === value ? 'active' : ''}" data-action="${action}" data-value="${escape(value)}" aria-pressed="${current === value}">${escape(label)}</button>`).join('')}</div>`;
}
function empty(title, message, action, label) {
  return `<div class="empty-state">${icon('spark')}<h3>${escape(title)}</h3><p>${escape(message)}</p>${action ? button(label, action, 'secondary', '', 'plus') : ''}</div>`;
}
function sectionHeading(title, count = '', actions = '') {
  return `<div class="section-heading"><div><h2>${title}</h2>${count !== '' ? `<span class="count">${count}</span>` : ''}</div><div class="section-actions">${actions}</div></div>`;
}
function visibleGoals() {
  const week = weekDates(page === 'week' ? weekAnchor : todayISO())[0];
  return state.goals.filter(goal => !goal.week || goal.week === week);
}
function goalList() {
  const goals = visibleGoals();
  return `<div class="goal-list">${goals.length ? goals.map(goal => `<div class="goal-row ${goal.done ? 'is-done' : ''}"><button class="task-check" type="button" role="checkbox" aria-checked="${!!goal.done}" aria-label="${escape(goal.done ? '取消完成' : '完成')}：${escape(goal.title)}" data-action="toggle-goal" data-id="${escape(goal.id)}">${goal.done ? icon('check') : ''}</button><button class="goal-title" data-action="edit-goal" data-id="${escape(goal.id)}">${escape(goal.title)}</button></div>`).join('') : '<p class="muted-text">给这一周一个清晰的方向。</p>'}</div>`;
}
function taskRow(task, compact = false) {
  return `<div class="task-row ${task.done ? 'is-done' : ''}" data-task-id="${escape(task.id)}"><button class="task-check" type="button" role="checkbox" aria-checked="${!!task.done}" aria-label="${escape(task.done ? '取消完成' : '完成')}：${escape(task.title)}" data-action="toggle-task" data-id="${escape(task.id)}">${task.done ? icon('check') : ''}</button><div class="task-content"><button class="task-title" data-action="edit-task" data-id="${escape(task.id)}">${escape(task.title)}</button><div class="task-meta"><span>${escape(task.category || '个人')}</span>${!compact ? `<span>${task.date === todayISO() ? '今天' : dateText(task.date)}${task.time ? ` · ${escape(task.time)}` : ''}</span>` : ''}${task.duration ? `<span>${escape(task.duration)} 分钟</span>` : ''}</div></div><div class="task-actions">${task.priority === 'high' && !task.done ? '<span class="priority-dot" title="高优先级"></span>' : ''}${compact ? `<span class="task-time">${escape(task.time || '')}</span>` : `${!task.done ? iconButton('专注于此任务', 'focus-task', `data-id="${escape(task.id)}"`, 'play') : ''}${iconButton('编辑任务', 'edit-task', `data-id="${escape(task.id)}"`, 'edit')}${iconButton('删除任务', 'delete-task', `data-id="${escape(task.id)}"`, 'trash')}`}</div></div>`;
}
function contextGoals() {
  const goals = visibleGoals();
  const done = goals.filter(goal => goal.done).length;
  const progress = goals.length ? Math.round(done / goals.length * 100) : 0;
  return `<section class="context-card light"><div class="context-title"><span class="round-icon">${icon('flag')}</span><h2>本周方向</h2>${iconButton('添加本周方向', 'new-goal', '', 'plus')}</div><p class="context-subtitle">做得少一点，做得重要一点。</p>${goalList()}<div class="context-divider"></div><div class="progress-caption"><span>方向达成</span><strong>${done}<span> / ${goals.length}</span></strong></div><div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div><div class="context-footnote">${progress === 100 && goals.length ? '这周的每一步，都算数。' : '每完成一步，都更接近想要的生活。'}</div></section>`;
}
function contextToday() {
  const todayTasks = tasksFor(todayISO());
  return `<section class="context-card dark"><div class="context-title"><h2>今天的安排</h2><span class="count">${todayTasks.length}</span>${iconButton('查看今天的任务', 'go-execute')}</div><div class="task-list compact">${todayTasks.length ? todayTasks.slice(0, 3).map(task => taskRow(task, true)).join('') : '<p class="muted-text">今天还没有安排，留一点时间给自己。</p>'}</div>${button('安排一个小行动', 'new-task', 'ghost', '', 'plus')}</section>`;
}
function contextNote() {
  const note = [...state.notes].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''))[0];
  return `<section class="context-card reflection-card"><div class="context-title"><p class="eyebrow">A MOMENT TO REFLECT</p>${icon('note')}</div>${note ? `<p class="reflection-quote">“${escape(note.title)}”</p><p class="reflection-excerpt">${escape(note.body || note.content || '').slice(0, 100)}</p><button class="text-link" data-action="edit-note" data-id="${escape(note.id)}">${dateText(note.date)} · ${escape(note.tag || '随想')}${icon('arrow')}</button>` : `<p class="reflection-quote">让每一段经历，<br>都留下回声。</p>${button('写下第一条记录', 'new-note', 'ghost', '', 'arrow')}`}</section>`;
}
function decisionCard(item) {
  const glyph = { 工作: 'folder', 成长: 'spark', 生活: 'sun', 健康: 'activity', 关系: 'note' }[item.category] || 'decision';
  const status = item.status || 'pending';
  return `<article class="card decision-card ${status === 'decided' ? 'resolved' : ''}" data-item-id="${escape(item.id)}"><div class="card-head"><span class="category-icon ${escape(item.category === '成长' ? 'purple' : item.category === '生活' ? 'orange' : '')}">${icon(glyph)}</span><span class="badge ${status === 'pending' ? 'orange' : status === 'decided' ? 'lime' : 'muted'}"><i></i>${statusText(status)}</span>${iconButton('打开决策', 'edit-decision', `data-id="${escape(item.id)}"`)}</div><div class="decision-body"><p class="card-category">${escape(item.category || '个人')} · ${escape(item.impact || '中')}影响</p><h3><button class="plain-title" data-action="edit-decision" data-id="${escape(item.id)}">${escape(item.title)}</button></h3><p>${escape(status === 'decided' && item.choice ? `已选择：${item.choice}` : item.context || '把问题写清楚，答案就近了一步。')}</p></div><div class="card-footer"><span>${icon('calendar')}${item.deadline ? `${dateText(item.deadline)}前` : '不设截止时间'}</span><button class="text-link" data-action="resolve-decision" data-id="${escape(item.id)}">${status === 'decided' ? '查看理由' : `${item.options?.length || 0} 个选项`}${icon('arrow')}</button></div></article>`;
}
function focusFeature() {
  const task = tasksFor(todayISO()).find(t => !t.done && t.priority === 'high') || tasksFor(todayISO()).find(t => !t.done) || state.tasks.find(t => !t.done);
  const completed = tasksFor(todayISO()).filter(t => t.done).length;
  return `<section class="card focus-card"><div class="card-head"><span class="eyebrow">ONE THING AT A TIME</span><span class="badge">${icon('target')}今日焦点</span></div><div class="focus-feature-content"><div><p class="focus-kicker">让今天，有一点不一样。</p><h2>${task ? escape(task.title) : '为真正重要的事，留出时间。'}</h2><div class="focus-meta">${icon('clock')}<span>${task ? `${task.duration || 25} 分钟 · ${escape(task.category || '个人')}${task.time ? ` · ${escape(task.time)}` : ''}` : '从一个 25 分钟的专注开始'}</span></div></div><div class="focus-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><span>${icon('spark')}</span></div></div><div class="focus-footer"><span>${completed ? `今天已完成 ${completed} 个小行动` : '给注意力一个明确的去处'}</span>${button('开始专注', task ? 'focus-task' : 'go-execute', 'dark', task ? `data-id="${escape(task.id)}"` : '', 'arrow')}</div></section>`;
}
function renderDecision() {
  const pending = state.decisions.filter(d => d.status === 'pending' || !d.status).length;
  const decided = state.decisions.filter(d => d.status === 'decided').length;
  const items = state.decisions.filter(d => decisionFilter === 'all' || (d.status || 'pending') === decisionFilter);
  return `${heading('01 / DECISION ROOM', '想清楚，<span>再向前。</span>', '把重要的选择摆在眼前，把注意力还给自己。', 'new-decision', '新建决策', `<div class="stats-strip"><div class="stat"><strong>${countLabel(pending)}</strong><span>待思考的决策<i class="small-dot orange"></i></span></div><div class="stat"><strong>${countLabel(decided)}</strong><span>已明确的方向<i class="small-dot lime"></i></span></div><div class="stat"><strong>${percentage(currentWeekTasks())}<small>%</small></strong><span>本周行动完成度</span></div><div class="stats-note">${icon('spark')}清晰，是最好的起点。</div></div>`)}<div class="workspace-grid"><div class="main-column">${sectionHeading('我的决策台', `${state.decisions.length} 项`, iconButton('新建决策', 'new-decision', '', 'plus'))}${filters([['pending', '待思考'], ['all', '全部'], ['decided', '已决定'], ['paused', '已搁置']], decisionFilter, 'decision-filter')}<div class="decision-grid">${items.length ? items.map(decisionCard).join('') : empty('这里很清晰', decisionFilter === 'pending' ? '暂时没有待思考的决策，安心向前。' : '这个分类下还没有决策。', 'new-decision', '记录一个决策')}</div>${sectionHeading('下一步，就从这里开始', '', '<span class="section-caption">少一点分心 · 多一点投入</span>')}${focusFeature()}</div><aside class="context-column">${contextGoals()}${contextToday()}${contextNote()}</aside></div>`;
}
function renderMonitor() {
  const today = state.metrics.find(item => item.date === todayISO());
  const dates = Array.from({ length: 7 }, (_, i) => addDays(todayISO(), i - 6));
  const samples = dates.map(date => state.metrics.find(item => item.date === date));
  const available = samples.filter(entry => entry && typeof entry[metricTab] === 'number');
  const average = available.length ? available.reduce((sum, entry) => sum + Number(entry[metricTab] || 0), 0) / available.length : 0;
  const values = samples.map(entry => entry && typeof entry[metricTab] === 'number' ? entry[metricTab] : null);
  const max = Math.max(metricTab === 'energy' ? 10 : metricTab === 'sleep' ? 9 : metricTab === 'exercise' ? 60 : 120, ...values.filter(v => v !== null));
  const metricIcons = { energy: 'sun', sleep: 'moon', exercise: 'activity', focus: 'target' };
  const metricTargets = { energy: '给自己一个真实的评分', sleep: '建议留出 7–9 小时', exercise: '哪怕散步，也是一种运动', focus: '积累安静投入的时间' };
  return `${heading('02 / PERSONAL PULSE', '看见状态，<span>找回节奏。</span>', '不必每天满格，先诚实地记录自己的状态。', 'log-metrics', today ? '更新今日状态' : '记录今日状态')}<div class="metric-grid">${Object.keys(metricNames).map(key => `<article class="card metric-card ${key === 'energy' ? 'highlight' : ''}"><div class="card-head"><span class="metric-icon">${icon(metricIcons[key])}</span><span class="card-category">今日${metricNames[key]}</span>${iconButton(`记录${metricNames[key]}`, 'log-metrics', '', 'edit')}</div><div class="metric-number">${today && today[key] !== null && today[key] !== undefined ? escape(today[key]) : '—'}<span>${metricUnits[key]}</span></div><p>${metricTargets[key]}</p></article>`).join('')}</div><div class="workspace-grid"><div class="main-column">${sectionHeading('过去 7 天', '', `<span class="section-caption">${compactDate(dates[0])} — ${compactDate(dates[6])}</span>`)}<section class="card chart-card">${filters(Object.entries(metricNames).map(([key, value]) => [key, value]), metricTab, 'metric-tab')}<div class="chart-summary"><div><span>平均${metricNames[metricTab]}</span><strong>${available.length ? average.toFixed(1).replace(/\.0$/, '') : '—'}<small>${metricUnits[metricTab]}</small></strong></div><span class="badge muted">已记录 ${available.length} / 7 天</span></div><div class="bar-chart" role="img" aria-label="过去7天${metricNames[metricTab]}趋势">${dates.map((date, i) => `<div class="bar-item ${date === todayISO() ? 'is-today' : ''}"><div class="bar-value">${values[i] === null ? '—' : values[i]}</div><div class="bar-slot"><div class="bar ${values[i] === null ? 'missing' : ''}" style="height:${values[i] === null ? 2 : Math.max(3, values[i] / max * 100)}%"></div></div><span class="bar-label">${date === todayISO() ? '今天' : ['日', '一', '二', '三', '四', '五', '六'][dateObject(date).getDay()]}</span><small>${compactDate(date)}</small></div>`).join('')}</div><div class="chart-footnote">${icon('activity')}趋势用来理解自己，不用来评判自己。未记录的日期显示为「—」。</div></section>${sectionHeading('每日记录', `${state.metrics.length} 天`)}<div class="card metric-history"><div class="history-row history-header"><span>日期</span><span>能量</span><span>睡眠</span><span>运动</span><span>专注</span></div>${[...state.metrics].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7).map(entry => `<button class="history-row" data-action="log-metrics" data-date="${escape(entry.date)}"><span>${entry.date === todayISO() ? '今天' : dateText(entry.date)}</span><span>${escape(entry.energy ?? '—')}<small> / 10</small></span><span>${escape(entry.sleep ?? '—')}<small> h</small></span><span>${escape(entry.exercise ?? '—')}<small> min</small></span><span>${escape(entry.focus)}<small> min</small></span></button>`).join('') || empty('从今天开始了解自己', '记录一次状态，就能看见自己的变化。', 'log-metrics', '记录今日状态')}</div></div><aside class="context-column"><section class="context-card light energy-context"><div class="context-title"><span class="round-icon">${icon('sun')}</span><h2>今天，感觉如何？</h2></div><div class="energy-orb" aria-hidden="true">${icon(today?.energy >= 7 ? 'sun' : 'moon')}</div><h3>${!today || today.energy === null ? '给自己一分钟' : today.energy >= 8 ? '能量在线，好好利用' : today.energy >= 5 ? '按自己的节奏前进' : '慢一点，也没有关系'}</h3><p>每天的小记录，会慢慢拼出属于你的生活节奏。</p>${button(today ? '更新今日状态' : '做一次状态记录', 'log-metrics', 'dark', '', 'plus')}</section>${contextGoals()}</aside></div>`;
}
function renderWeek() {
  const dates = weekDates(weekAnchor);
  if (!dates.includes(selectedDay)) selectedDay = dates[0];
  const weekTasks = state.tasks.filter(task => dates.includes(task.date));
  const selectedTasks = tasksFor(selectedDay);
  return `${heading('03 / WEEKLY RHYTHM', '给一周，<span>留好节奏。</span>', '先安排重要的事，也记得为生活留一些空白。', 'new-task', '添加计划')}<div class="week-toolbar"><div class="week-navigation">${iconButton('上一周', 'previous-week', '', 'back')}<h2>${dateText(dates[0])} — ${dateText(dates[6])}</h2>${iconButton('下一周', 'next-week', '', 'chevron')}</div><div class="week-summary"><span>${weekTasks.filter(t => t.done).length} / ${weekTasks.length} 项完成</span>${button('回到本周', 'current-week', 'secondary')}</div></div><div class="week-board">${dates.map(date => { const dayTasks = tasksFor(date); return `<section class="day-column ${date === todayISO() ? 'is-today' : ''} ${date === selectedDay ? 'is-selected' : ''}"><button class="day-header" data-action="select-day" data-date="${date}" aria-pressed="${date === selectedDay}"><span>${weekDay(date).replace('星期', '周')}${date === todayISO() ? '<i>今天</i>' : ''}</span><strong>${dateObject(date).getDate()}</strong><small>${dayTasks.length ? `${dayTasks.length} 个安排` : '留一点空白'}</small></button><div class="calendar-tasks">${dayTasks.map(task => `<button class="calendar-task ${task.done ? 'is-done' : ''} ${task.priority === 'high' ? 'important' : ''}" data-action="edit-task" data-id="${escape(task.id)}"><span>${task.done ? icon('check') : icon('clock')}${escape(task.time || '时间灵活')}</span><strong>${escape(task.title)}</strong><small>${escape(task.category || '个人')}</small></button>`).join('')}</div><button class="day-add" data-action="new-task" data-date="${date}" aria-label="为${dateText(date)}添加计划">${icon('plus')}<span>添加</span></button></section>`; }).join('')}</div><div class="workspace-grid week-details"><div class="main-column">${sectionHeading(`${selectedDay === todayISO() ? '今天' : dateText(selectedDay)}的计划`, `${selectedTasks.length} 项`, button('添加计划', 'new-task', 'ghost', `data-date="${selectedDay}"`, 'plus'))}<section class="card task-list">${selectedTasks.length ? selectedTasks.map(task => taskRow(task)).join('') : empty('留白，也是计划的一部分', '给这一天安排一个值得完成的小行动。', 'new-task', '添加计划')}</section></div><aside class="context-column">${contextGoals()}<div class="context-card dark"><div class="context-title"><h2>本周小结</h2>${icon('activity')}</div><div class="weekly-completion"><strong>${percentage(weekTasks)}<small>%</small></strong><span>行动完成度</span></div><div class="progress-track"><div class="progress-fill" style="width:${percentage(weekTasks)}%"></div></div><p class="context-footnote">计划可以调整，方向始终在你手中。</p></div></aside></div>`;
}
function timerRemaining() {
  if (!state.timer.running) return Math.max(0, Number(state.timer.remaining) || 0);
  return Math.max(0, Math.ceil((Number(state.timer.endsAt) - Date.now()) / 1000));
}
function timerText() {
  const remaining = timerRemaining();
  return `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
}
function renderTimer() {
  const task = state.tasks.find(t => t.id === state.timer.taskId);
  return `<section class="context-card light timer-card"><div class="context-title"><span class="round-icon">${icon('target')}</span><h2>专注此刻</h2></div><p class="context-subtitle">一次，只做一件事。</p><div class="timer-dial ${state.timer.running ? 'is-running' : ''}"><span class="timer-marker"></span><div class="focus-clock" id="focus-clock" role="timer" aria-label="专注剩余时间">${timerText()}</div><span class="timer-state" id="timer-state">${state.timer.running ? '专注进行中' : timerRemaining() < state.timer.duration ? '已暂停，随时继续' : '准备好，进入心流'}</span></div><div class="timer-task-label">当前专注</div><p class="timer-task">${task ? escape(task.title) : '一个不被打扰的 25 分钟'}</p><div class="timer-controls">${button(state.timer.running ? '暂停专注' : timerRemaining() < state.timer.duration && timerRemaining() > 0 ? '继续专注' : '开始专注', 'toggle-timer', 'dark', '', state.timer.running ? 'pause' : 'play')}${iconButton('重置为25分钟', 'reset-timer', '', 'reset')}</div><p class="context-footnote">完成一轮后，给自己 5 分钟的休息。</p></section>`;
}
function renderExecute() {
  const visible = state.tasks.filter(task => taskFilter === 'all' || (taskFilter === 'done' ? task.done : !task.done)).sort((a, b) => Number(a.done) - Number(b.done) || (a.date || '9999').localeCompare(b.date || '9999') || (a.time || '').localeCompare(b.time || ''));
  const todayTasks = tasksFor(todayISO());
  const finished = state.tasks.filter(t => t.done).length;
  return `${heading('04 / FOCUS & FLOW', '少想一步，<span>开始行动。</span>', '把大目标拆成小行动，让进展真实发生。', 'new-task', '新建任务', `<div class="stats-strip"><div class="stat"><strong>${countLabel(todayTasks.filter(t => !t.done).length)}</strong><span>今日待完成<i class="small-dot orange"></i></span></div><div class="stat"><strong>${countLabel(finished)}</strong><span>累计已完成<i class="small-dot lime"></i></span></div><div class="stat"><strong>${percentage(todayTasks)}<small>%</small></strong><span>今日完成度</span></div><div class="stats-note">${icon('target')}行动本身，就是答案。</div></div>`)}<div class="workspace-grid"><div class="main-column">${sectionHeading('行动清单', `${state.tasks.length} 项`)}${filters([['pending', '待完成'], ['all', '全部任务'], ['done', '已完成']], taskFilter, 'task-filter')}<section class="card execution-list"><div class="task-list">${visible.length ? visible.map(task => taskRow(task)).join('') : empty(taskFilter === 'done' ? '完成的每一步，都会留在这里' : '手头的事情都清楚了', taskFilter === 'done' ? '开始一个小行动，积累你的第一步。' : '添加一个小任务，然后安心开始。', 'new-task', '新建任务')}</div><form class="inline-add" id="inline-task-form"><span>${icon('plus')}</span><input name="title" placeholder="写下一个小行动，按 Enter 添加…" aria-label="快速添加任务" maxlength="120" required><button class="icon-button" type="submit" aria-label="添加任务">${icon('arrow')}</button></form></section><div class="gentle-reminder">${icon('spark')}<div><strong>你不需要一次完成所有事。</strong><p>选择当下最重要的一件，给它一段完整的注意力。</p></div></div></div><aside class="context-column">${renderTimer()}${contextGoals()}</aside></div>`;
}
function renderRecord() {
  const tags = ['全部', ...new Set(state.notes.map(note => note.tag || '随想'))];
  const query = noteQuery.trim().toLowerCase();
  const notes = [...state.notes].filter(note => (noteTag === '全部' || (note.tag || '随想') === noteTag) && (!query || `${note.title} ${note.body || note.content || ''} ${note.tag}`.toLowerCase().includes(query))).sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
  return `${heading('05 / REFLECTIONS & NOTES', '留下一点，<span>让经历有迹可循。</span>', '记录想法、复盘一天，也收藏那些微小的发现。', 'new-note', '写一条记录')}<div class="workspace-grid"><div class="main-column">${sectionHeading('我的记录', `${state.notes.length} 篇`)}<div class="records-toolbar">${filters(tags.map(tag => [tag, tag]), noteTag, 'note-tag')}<label class="search-field">${icon('search')}<input id="note-search" placeholder="搜索记录…" aria-label="搜索记录" value="${escape(noteQuery)}"></label></div><div class="note-grid">${notes.length ? notes.map(note => `<article class="card note-card" data-item-id="${escape(note.id)}"><div class="card-head"><span class="badge ${note.tag === '灵感' ? 'lime' : 'muted'}">${icon(note.tag === '灵感' ? 'spark' : 'note')}${escape(note.tag || '随想')}</span>${iconButton('编辑记录', 'edit-note', `data-id="${escape(note.id)}"`)}</div><h3><button class="plain-title" data-action="edit-note" data-id="${escape(note.id)}">${escape(note.title)}</button></h3><p class="note-body">${escape(note.body || note.content || '')}</p><div class="card-footer"><span>${dateText(note.date, { year: 'numeric', month: 'long', day: 'numeric' })}</span><span>${(note.body || note.content || '').length} 字</span></div></article>`).join('') : empty('暂时没有找到记录', query ? '试试其他关键词，或写下一条新的想法。' : '值得被记住的，不一定是大事。', 'new-note', '写一条记录')}</div></div><aside class="context-column"><section class="context-card light writing-prompt"><div class="context-title"><span class="round-icon">${icon('note')}</span><h2>留给自己的问题</h2></div><span class="quote-mark" aria-hidden="true">“</span><h3>今天，哪一件小事<br>让你觉得值得？</h3><p>不用写得完整，也不必字字有用。只要真实，就有意义。</p>${button('从这个问题开始', 'prompt-note', 'dark', '', 'edit')}</section><section class="context-card dark"><div class="context-title"><h2>记录的力量</h2>${icon('spark')}</div><div class="record-count"><strong>${countLabel(state.notes.length)}</strong><span>段被好好保存的时光</span></div><p class="context-footnote">有些答案，藏在你已经写下的文字里。</p></section>${contextToday()}</aside></div>`;
}

function renderShell() {
  $$('[data-page]').forEach(link => { const active = link.dataset.page === page; link.classList.toggle('active', active); if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current'); });
  if ($('#today-label')) $('#today-label').textContent = `${dateText(todayISO(), { month: 'long', day: 'numeric' })} ${weekDay(todayISO())}`;
  if ($('#page-tag')) $('#page-tag').textContent = `${pages[page]}${IS_DEMO ? '演示' : '工作区'}`;
  if ($('#nav-pending')) $('#nav-pending').textContent = countLabel(state.decisions.filter(d => !d.status || d.status === 'pending').length);
  if ($('#sidebar-progress')) $('#sidebar-progress').textContent = `本周行动 · ${percentage(currentWeekTasks())}% 已完成`;
  document.documentElement.style.setProperty('--progress', `${percentage(currentWeekTasks())}%`);
  const sidebarBar = $('#sidebar-progress-bar');
  if (sidebarBar) sidebarBar.style.width = `${percentage(currentWeekTasks())}%`;
  if ($('#schedule')) {
    const todayTasks = tasksFor(todayISO()).sort((a, b) => (a.time || '23:59').localeCompare(b.time || '23:59')).slice(0, 3);
    $('#schedule').innerHTML = todayTasks.length ? todayTasks.map((task, i) => `<button class="schedule-item ${task.done ? 'complete' : ''} ${i === 0 && !task.done ? 'current' : ''}" data-action="edit-task" data-id="${escape(task.id)}"><span class="schedule-dot">${task.done ? icon('check') : icon(i === 0 ? 'target' : 'clock')}</span><span class="schedule-task-name">${escape(task.title)}</span><time>${escape(task.time || '灵活')}</time></button>`).join('') : `<button class="schedule-empty" data-action="new-task">今天的节奏，由你安排 ${icon('plus')}</button>`;
  }
}
function render() {
  const renderers = { decision: renderDecision, monitor: renderMonitor, week: renderWeek, execute: renderExecute, record: renderRecord };
  view.innerHTML = renderers[page]();
  renderShell();
}
function navigate(destination) {
  if (!pages[destination]) destination = 'decision';
  if (location.hash !== `#${destination}`) location.hash = destination;
  else { page = destination; render(); }
}
function route() {
  if (dialog.open) closeDialog();
  page = Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : 'decision';
  document.title = `${pages[page]} · Life OS${IS_DEMO ? ' · 交互演示' : ''}`;
  $('#quick-add')?.setAttribute('aria-label', `在${pages[page]}中新建`);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function openDialog(title, subtitle, body, footer, kind = '', id = '') {
  lastFocused = document.activeElement;
  $('#dialog-content').innerHTML = `<form ${kind ? `data-kind="${kind}" data-id="${escape(id)}"` : ''}><div class="modal-header"><div><p class="eyebrow">LIFE OS / YOUR SPACE</p><h2 id="dialog-title">${title}</h2><p>${subtitle}</p></div>${iconButton('关闭对话框', 'close-dialog', '', 'close')}</div><div class="modal-body">${body}<p class="form-error" role="alert" hidden></p></div><div class="modal-footer">${footer || `${button('取消', 'close-dialog', 'secondary')}<button class="button primary" type="submit">保存${icon('check')}</button>`}</div></form>`;
  const form = $('form', $('#dialog-content'));
  const collection = editorCollections[kind];
  if (form && collection) {
    editorBaselines.set(form, {
      scope: STORAGE_KEY, kind, id: id || '', collection,
      entity: entitySnapshot(state[collection].find(item => item.id === id)),
      // A metric's editable date is its identity. Snapshot each potential target
      // so changing the date cannot overwrite an entry updated after opening.
      dates: kind === 'metrics' ? new Map(state.metrics.map(item => [item.date, entitySnapshot(item)])) : null,
    });
  }
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $('input:not([type="hidden"]), textarea, select', dialog)?.focus());
}
function closeDialog() { dialog.close(); if (lastFocused?.isConnected) lastFocused.focus(); }
function inputField(label, name, value = '', options = '') { return `<label class="field"><span>${label}</span><input class="input" name="${name}" value="${escape(value)}" ${options}></label>`; }
function textareaField(label, name, value = '', options = '') { return `<label class="field"><span>${label}</span><textarea class="textarea" name="${name}" ${options}>${escape(value)}</textarea></label>`; }
function selectField(label, name, values, current) { return `<label class="field"><span>${label}</span><select class="select" name="${name}">${values.map(item => { const [value, text] = Array.isArray(item) ? item : [item, item]; return `<option value="${escape(value)}" ${value === current ? 'selected' : ''}>${escape(text)}</option>`; }).join('')}</select></label>`; }
function error(form, message) { const el = $('.form-error', form); el.hidden = false; el.textContent = message; }
function editorCanSave(form, data) {
  const baseline = editorBaselines.get(form);
  if (!baseline) { error(form, '这个编辑窗口已失效。请先复制草稿，再关闭并重新打开。'); return false; }
  if (baseline.scope !== STORAGE_KEY) { error(form, '工作区已切换。请先复制草稿，再到正确的工作区重新打开。'); return false; }
  if (!baseline.id && baseline.kind !== 'metrics') return true;
  const current = baseline.kind === 'metrics' ? state.metrics.find(item => item.date === data.date) : state[baseline.collection].find(item => item.id === baseline.id);
  const previous = baseline.kind === 'metrics' ? baseline.dates.get(data.date) ?? entitySnapshot(null) : baseline.entity;
  if (entitySnapshot(current) === previous) return true;
  error(form, current ? '这条内容已在其他地方更新。你的草稿仍保留在这里；请先复制草稿，再关闭并重新打开最新内容，避免覆盖更新。' : '这条内容已在其他地方移除。你的草稿仍保留在这里；请先复制草稿，再关闭并新建。');
  return false;
}
function editDecision(id) {
  const item = state.decisions.find(d => d.id === id);
  openDialog(item ? '把这个选择想清楚' : '记下一个重要的选择', '先把问题写下来，再给自己一点思考的空间。', `${inputField('要做什么决定？', 'title', item?.title, 'required maxlength="100" placeholder="例如：下一阶段，该专注哪项能力？"')}${textareaField('背景与考量', 'context', item?.context, 'rows="3" maxlength="1200" placeholder="为什么要做这个决定？什么对你最重要？"')}<div class="field-row">${selectField('所属领域', 'category', ['工作', '成长', '生活', '健康', '关系', '个人'], item?.category || '成长')}${selectField('影响程度', 'impact', ['高', '中', '低'], item?.impact || '中')}</div>${inputField('希望何时做出决定', 'deadline', item ? item.deadline : addDays(todayISO(), 3), 'type="date"')}${textareaField('备选方案（每行一个）', 'options', (item?.options || []).join('\n'), 'rows="3" maxlength="1000" placeholder="方案 A\n方案 B\n也可以暂时不做改变"')}`, item ? `<div class="modal-secondary-actions">${iconButton('删除决策', 'delete-item', `data-kind="decisions" data-id="${escape(id)}"`, 'trash')}${button(item.status === 'paused' ? '恢复思考' : '暂时搁置', 'pause-decision', 'ghost', `data-id="${escape(id)}"`, item.status === 'paused' ? 'play' : 'pause')}${button(item.status === 'decided' ? '查看选择' : '做出选择', 'resolve-decision', 'secondary', `data-id="${escape(id)}"`, 'decision')}</div><button class="button primary" type="submit">保存修改${icon('check')}</button>` : '', 'decision', id);
}
function resolveDecision(id) {
  const item = state.decisions.find(d => d.id === id);
  if (!item) return;
  openDialog('让选择，有据可依', escape(item.title), `${item.options?.length ? `<fieldset class="choice-fieldset"><legend>你倾向于哪一个方案？</legend>${item.options.map((option, i) => `<label class="choice-option"><input type="radio" name="choice" value="${escape(option)}" ${item.choice === option ? 'checked' : ''} required><span><small>方案 ${String(i + 1).padStart(2, '0')}</small>${escape(option)}</span></label>`).join('')}</fieldset>` : inputField('你的选择', 'choice', item.choice, 'required maxlength="200" placeholder="写下你的决定"')}${textareaField('选择的理由', 'reason', item.reason, 'rows="4" required maxlength="1600" placeholder="记录你看重什么、接受什么，以及接下来的一小步。"')}`, `${button('返回编辑', 'edit-decision', 'secondary', `data-id="${escape(id)}"`)}<button class="button primary" type="submit">${item.status === 'decided' ? '更新选择' : '确认这个选择'}${icon('check')}</button>`, 'resolve', id);
}
function editTask(id, date) {
  const task = state.tasks.find(t => t.id === id);
  openDialog(task ? '调整这个小行动' : '给行动一个具体的名字', '清楚地写下下一步，就已经开始了。', `${inputField('要完成什么？', 'title', task?.title, 'required maxlength="120" placeholder="例如：完成作品集首页的内容架构"')}<div class="field-row">${inputField('计划日期', 'date', task?.date || date || (page === 'week' ? selectedDay : todayISO()), 'type="date" required')}${inputField('开始时间', 'time', task?.time || '', 'type="time"')}</div><div class="field-row">${selectField('所属领域', 'category', ['工作', '成长', '生活', '健康', '关系', '个人'], task?.category || '个人')}${selectField('优先级', 'priority', [['high', '优先处理'], ['normal', '按计划推进']], task?.priority || 'normal')}</div>${inputField('预计用时（分钟）', 'duration', task?.duration || 25, 'type="number" min="5" max="600" step="5" required')}`, '', 'task', id);
}
function logMetrics(date = todayISO()) {
  const entry = state.metrics.find(m => m.date === date);
  openDialog('和自己的状态打个照面', '没有标准答案，记录你此刻真实的感受。', `${inputField('记录日期', 'date', date, `type="date" required max="${todayISO()}"`)}<div class="field-row">${inputField('能量评分（1–10）', 'energy', entry?.energy ?? 7, 'type="number" min="1" max="10" step="1" required')}${inputField('睡眠时长（小时）', 'sleep', entry?.sleep ?? 7.5, 'type="number" min="0" max="24" step="0.1" required')}</div><div class="field-row">${inputField('运动时长（分钟）', 'exercise', entry?.exercise ?? 0, 'type="number" min="0" max="1440" step="1" required')}${inputField('专注时长（分钟）', 'focus', entry?.focus ?? 0, 'type="number" min="0" max="1440" step="1" required')}</div><p class="form-note">同一天的状态会更新为这次填写的内容。完成专注计时后，时长也会自动累积到今天。</p>`, '', 'metrics', date);
}
function editNote(id, prompt = false) {
  const note = state.notes.find(n => n.id === id);
  openDialog(note ? '重读，也可以重新整理' : '为这一刻，留下一点文字', '想法不用完整，重要的是把它留下来。', `${inputField('标题', 'title', note?.title || (prompt ? '今天，一件让我觉得值得的小事' : ''), 'required maxlength="100" placeholder="这一刻，你想记住什么？"')}<div class="field-row">${inputField('记录日期', 'date', note?.date || todayISO(), 'type="date" required')}${selectField('记录类型', 'tag', ['每日复盘', '灵感', '随手记'], note?.tag || (prompt ? '每日复盘' : '随手记'))}</div>${textareaField('写给自己', 'body', note?.body || note?.content || '', 'rows="8" required maxlength="12000" placeholder="从一个念头、一件小事，或一个问题开始…"')}`, note ? `${button('删除记录', 'delete-item', 'ghost', `data-kind="notes" data-id="${escape(id)}"`, 'trash')}<button class="button primary" type="submit">保存修改${icon('check')}</button>` : '', 'note', id);
}
function globalSearch() {
  openDialog('找到你在意的事', '同时搜索决策、任务和记录。', `<label class="search-field global-search-field">${icon('search')}<input id="search-all-input" placeholder="输入关键词…" aria-label="搜索所有内容" autocomplete="off"></label><div id="search-results" class="search-results"><p class="search-hint">输入关键词，让想法和行动重新连接。</p></div>`, button('关闭', 'close-dialog', 'secondary'));
}
function renderSearch(query) {
  const keyword = query.trim().toLowerCase();
  const results = $('#search-results');
  if (!keyword) { results.innerHTML = '<p class="search-hint">输入关键词，让想法和行动重新连接。</p>'; return; }
  const items = [
    ...state.decisions.map(d => ({ type: '决策', page: 'decision', id: d.id, title: d.title, body: `${d.context || ''} ${d.choice || ''} ${d.reason || ''}`, icon: 'decision' })),
    ...state.tasks.map(t => ({ type: '任务', page: 'execute', id: t.id, title: t.title, body: `${t.category || ''} ${t.date || ''}`, icon: 'check' })),
    ...state.notes.map(n => ({ type: '记录', page: 'record', id: n.id, title: n.title, body: `${n.body || n.content || ''} ${n.tag || ''}`, icon: 'note' })),
  ].filter(item => `${item.title} ${item.body}`.toLowerCase().includes(keyword));
  results.innerHTML = items.length ? `<p class="search-hint">找到 ${items.length} 条相关内容</p>${items.slice(0, 30).map(item => `<button class="search-result" data-action="open-search-result" data-page="${item.page}" data-id="${escape(item.id)}"><span class="search-result-icon">${icon(item.icon)}</span><span><small>${item.type}</small><strong>${escape(item.title)}</strong><p>${escape(item.body.slice(0, 80))}</p></span>${icon('arrow')}</button>`).join('')}` : '<div class="empty-state"><h3>没有找到相关内容</h3><p>换一个短一点的关键词试试。</p></div>';
}

function toggleTimer() {
  if (state.timer.running) {
    state.timer.remaining = timerRemaining();
    state.timer.running = false;
    state.timer.endsAt = null;
    commit('已暂停，给自己一点呼吸的时间');
  } else {
    if (state.timer.remaining <= 0) state.timer.remaining = state.timer.duration;
    state.timer.running = true;
    state.timer.endsAt = Date.now() + state.timer.remaining * 1000;
    commit('专注已开始，安心投入这一件事');
  }
}
function timerTick() {
  if (!state.timer.running) return;
  const remaining = timerRemaining();
  const clock = $('#focus-clock');
  if (clock) clock.textContent = timerText();
  if (remaining > 0) return;
  const completedAt = state.timer.endsAt ? new Date(Number(state.timer.endsAt)) : new Date();
  const completedDate = `${completedAt.getFullYear()}-${String(completedAt.getMonth() + 1).padStart(2, '0')}-${String(completedAt.getDate()).padStart(2, '0')}`;
  const duration = Number(state.timer.duration) || 1500;
  state.timer.running = false;
  state.timer.endsAt = null;
  state.timer.remaining = duration;
  const date = completedDate;
  let metric = state.metrics.find(item => item.date === date);
  if (!metric) { metric = { date, energy: null, sleep: null, exercise: null, focus: 0 }; state.metrics.push(metric); }
  metric.focus = Math.min(1440, Number(metric.focus || 0) + Math.round(duration / 60));
  commit(`完成了一轮专注！时长已计入${date === todayISO() ? '今日' : dateText(date)}监控，休息 5 分钟吧。`);
}

document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  if (trigger.closest('form') && trigger.tagName === 'BUTTON') event.preventDefault();
  const action = trigger.dataset.action;
  const id = trigger.dataset.id;
  switch (action) {
    case 'reset-demo': if (IS_DEMO) location.reload(); break;
    case 'new-goal': openDialog('这一周，什么最重要？', '选一个清晰的方向，留出真正推进的空间。', inputField('本周方向', 'title', '', 'required maxlength="100" placeholder="例如：完成作品集的第一版"'), '', 'goal'); break;
    case 'edit-goal': {
      const goal = state.goals.find(item => item.id === id);
      if (goal) openDialog('调整本周方向', '目标可以改变，重要的是保持清楚。', inputField('本周方向', 'title', goal.title, 'required maxlength="100"'), `${button('删除方向', 'delete-item', 'ghost', `data-kind="goals" data-id="${escape(id)}"`, 'trash')}<button class="button primary" type="submit">保存修改</button>`, 'goal', id);
      break;
    }
    case 'delete-item': {
      const kind = trigger.dataset.kind;
      if (!['notes', 'decisions', 'goals'].includes(kind)) break;
      const item = state[kind].find(entry => entry.id === id);
      if (item) openDialog('移除这条内容？', '删除后可通过提示中的「撤销」恢复。', `<p class="delete-preview">${escape(item.title)}</p>`, `${button('保留内容', 'close-dialog', 'secondary')}${button('确认删除', 'confirm-delete-item', 'danger', `data-kind="${kind}" data-id="${escape(id)}"`, 'trash')}`);
      break;
    }
    case 'confirm-delete-item': {
      const kind = trigger.dataset.kind;
      if (!['notes', 'decisions', 'goals'].includes(kind)) break;
      const index = state[kind].findIndex(entry => entry.id === id);
      if (index >= 0) {
        undoItem = { kind, index, item: state[kind][index] };
        state[kind].splice(index, 1);
        closeDialog();
        const saved = persist();
        render();
        if (saved) toast('内容已移除', 'success', 7000, '<button class="toast-action" data-action="undo-item">撤销</button>');
      }
      break;
    }
    case 'undo-item': if (undoItem) {
      const saved = undoItem; undoItem = null;
      if (state[saved.kind].some(item => item.id === saved.item.id)) toast('这条内容已恢复，已保留最新版本');
      else { state[saved.kind].splice(saved.index, 0, saved.item); commit('内容已恢复'); }
    } break;
    case 'new-decision': editDecision(); break;
    case 'edit-decision': editDecision(id); break;
    case 'resolve-decision': resolveDecision(id); break;
    case 'pause-decision': {
      const form = trigger.closest('form');
      if (form && !editorCanSave(form, {})) break;
      const item = state.decisions.find(d => d.id === id);
      if (item) { item.status = item.status === 'paused' ? 'pending' : 'paused'; closeDialog(); commit(item.status === 'paused' ? '已暂时搁置，留待合适的时候' : '已恢复到待思考'); }
      break;
    }
    case 'decision-filter': decisionFilter = trigger.dataset.value; render(); break;
    case 'new-task': editTask(null, trigger.dataset.date); break;
    case 'edit-task': editTask(id); break;
    case 'toggle-task': { const task = state.tasks.find(t => t.id === id); if (task) { task.done = !task.done; commit(task.done ? '又完成了一小步' : '已恢复为待完成'); } break; }
    case 'delete-task': { const task = state.tasks.find(t => t.id === id); if (task) openDialog('移除这个任务？', '删除后可以通过提示中的「撤销」恢复。', `<p class="delete-preview">${escape(task.title)}</p>`, `${button('保留任务', 'close-dialog', 'secondary')}${button('确认删除', 'confirm-delete-task', 'danger', `data-id="${escape(id)}"`, 'trash')}`); break; }
    case 'confirm-delete-task': { const index = state.tasks.findIndex(t => t.id === id); if (index >= 0) { undoTask = { task: state.tasks[index], index }; state.tasks.splice(index, 1); if (state.timer.taskId === id) state.timer.taskId = null; closeDialog(); const saved = persist(); render(); if (saved) toast('任务已移除', 'success', 7000, '<button class="toast-action" data-action="undo-task">撤销</button>'); } break; }
    case 'undo-task': if (undoTask) {
      const saved = undoTask; undoTask = null;
      if (state.tasks.some(task => task.id === saved.task.id)) toast('这个任务已恢复，已保留最新版本');
      else { state.tasks.splice(saved.index, 0, saved.task); commit('任务已恢复'); }
    } break;
    case 'task-filter': taskFilter = trigger.dataset.value; render(); break;
    case 'toggle-goal': { const goal = state.goals.find(g => g.id === id); if (goal) { goal.done = !goal.done; commit(goal.done ? '本周的方向，又近了一步' : '已更新本周方向'); } break; }
    case 'log-metrics': logMetrics(trigger.dataset.date || todayISO()); break;
    case 'metric-tab': metricTab = trigger.dataset.value; render(); break;
    case 'previous-week': weekAnchor = addDays(weekAnchor, -7); selectedDay = weekDates(weekAnchor)[0]; render(); break;
    case 'next-week': weekAnchor = addDays(weekAnchor, 7); selectedDay = weekDates(weekAnchor)[0]; render(); break;
    case 'current-week': weekAnchor = todayISO(); selectedDay = todayISO(); render(); break;
    case 'select-day': selectedDay = trigger.dataset.date; render(); break;
    case 'new-note': editNote(); break;
    case 'edit-note': editNote(id); break;
    case 'prompt-note': editNote(null, true); break;
    case 'note-tag': noteTag = trigger.dataset.value; render(); break;
    case 'go-week': navigate('week'); break;
    case 'go-execute': navigate('execute'); break;
    case 'close-dialog': closeDialog(); break;
    case 'focus-task': {
      const task = state.tasks.find(t => t.id === id);
      if (!task) break;
      if (state.timer.running && state.timer.taskId && state.timer.taskId !== id) { toast('当前专注仍在进行，请先暂停，再切换任务。', 'error'); navigate('execute'); break; }
      if (!state.timer.running && state.timer.taskId !== id) state.timer.remaining = state.timer.duration;
      state.timer.taskId = id;
      persist();
      navigate('execute');
      if (!state.timer.running) { state.timer.running = true; state.timer.endsAt = Date.now() + (state.timer.remaining || state.timer.duration) * 1000; commit('已开始专注这一件事'); }
      break;
    }
    case 'toggle-timer': toggleTimer(); break;
    case 'reset-timer': state.timer.running = false; state.timer.remaining = state.timer.duration; state.timer.endsAt = null; commit('已重置为 25 分钟'); break;
    case 'open-search-result': {
      const destination = trigger.dataset.page;
      closeDialog();
      if (destination === 'decision') decisionFilter = 'all';
      if (destination === 'execute') taskFilter = 'all';
      if (destination === 'record') { noteTag = '全部'; noteQuery = ''; }
      navigate(destination);
      if (destination === 'decision') editDecision(id);
      else if (destination === 'execute') editTask(id);
      else editNote(id);
      break;
    }
  }
});

document.addEventListener('submit', event => {
  const form = event.target;
  if (form.id === 'inline-task-form') {
    event.preventDefault();
    const title = new FormData(form).get('title').trim();
    if (!title) return;
    state.tasks.push({ id: uid(), title, date: todayISO(), time: '', category: '个人', priority: 'normal', duration: 25, done: false });
    commit('小行动已加入今日清单');
    return;
  }
  const kind = form.dataset.kind;
  if (!kind) { event.preventDefault(); return; }
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  for (const key of Object.keys(data)) if (typeof data[key] === 'string') data[key] = data[key].trim();
  const id = form.dataset.id;
  if (editorCollections[kind] && !editorCanSave(form, data)) return;
  const collection = { goal: 'goals', decision: 'decisions', resolve: 'decisions', task: 'tasks', note: 'notes' }[kind];
  if (id && collection && !state[collection].some(item => item.id === id)) { error(form, '这条内容已在另一个窗口被移除。可以复制文字，然后关闭并新建。'); return; }
  if (['decision', 'task', 'note', 'goal'].includes(kind) && !data.title) { error(form, '请先写下一个清晰的标题。'); return; }
  if (kind === 'goal') { const original = state.goals.find(goal => goal.id === id); if (original) original.title = data.title; else state.goals.push({ id: uid(), title: data.title, done: false, week: weekDates(page === 'week' ? weekAnchor : todayISO())[0] }); }
  if (kind === 'decision') {
    const original = state.decisions.find(item => item.id === id);
    const record = { ...original, id: id || uid(), title: data.title, context: data.context, category: data.category, impact: data.impact, deadline: data.deadline, options: data.options.split('\n').map(item => item.trim()).filter(Boolean).slice(0, 12), status: original?.status || 'pending', choice: original?.choice || '', reason: original?.reason || '' };
    if (original) Object.assign(original, record); else state.decisions.unshift(record);
  }
  if (kind === 'resolve') {
    if (!data.choice || !data.reason) { error(form, '请选择一个方案，并写下选择的理由。'); return; }
    const item = state.decisions.find(d => d.id === id);
    if (item) Object.assign(item, { choice: data.choice, reason: data.reason, status: 'decided' });
  }
  if (kind === 'task') {
    const duration = Number(data.duration);
    if (!data.date || !Number.isFinite(duration) || duration < 5 || duration > 600) { error(form, '请填写有效日期，以及 5–600 分钟的预计用时。'); return; }
    const original = state.tasks.find(item => item.id === id);
    const record = { ...original, id: id || uid(), title: data.title, date: data.date, time: data.time, category: data.category, priority: data.priority, duration, done: original?.done || false };
    if (original) Object.assign(original, record); else state.tasks.push(record);
  }
  if (kind === 'metrics') {
    if (!data.date || data.date > todayISO()) { error(form, '请选择今天或过去的日期。'); return; }
    const record = { date: data.date };
    const maxima = { energy: 10, sleep: 24, exercise: 1440, focus: 1440 };
    for (const key of Object.keys(maxima)) { record[key] = Number(data[key]); if (!Number.isFinite(record[key]) || record[key] < (key === 'energy' ? 1 : 0) || record[key] > maxima[key]) { error(form, `请填写有效的${metricNames[key]}数值。`); return; } }
    const original = state.metrics.find(item => item.date === data.date);
    if (original) Object.assign(original, record); else state.metrics.push(record);
  }
  if (kind === 'note') {
    if (!data.body) { error(form, '再留下一点文字，记录就完整了。'); return; }
    const original = state.notes.find(item => item.id === id);
    const record = { ...original, id: id || uid(), title: data.title, body: data.body, date: data.date, tag: data.tag, createdAt: original?.createdAt || new Date().toISOString() };
    if (original) Object.assign(original, record); else state.notes.unshift(record);
  }
  closeDialog();
  commit(({ goal: '已记下本周方向，一步一步来', decision: '决策已保存，给自己一点思考的空间', resolve: '方向已明确，向前走一步吧', task: '行动计划已保存', metrics: '状态已记录，更了解自己一点', note: '这一刻，已经好好留下' })[kind]);
});
document.addEventListener('input', event => {
  if (event.target.id === 'search-all-input') renderSearch(event.target.value);
  if (event.target.id === 'note-search' && !event.isComposing) updateNoteSearch(event.target);
});
function updateNoteSearch(source) {
  const position = source.selectionStart;
  noteQuery = source.value;
  render();
  const input = $('#note-search');
  input.focus();
  input.setSelectionRange(position, position);
}
document.addEventListener('compositionend', event => {
  if (event.target.id === 'note-search') updateNoteSearch(event.target);
});
dialog.addEventListener('click', event => { if (event.target === dialog) { const bounds = dialog.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDialog(); } });
$('#global-search')?.addEventListener('click', globalSearch);
$('#quick-add')?.addEventListener('click', () => ({ decision: () => editDecision(), monitor: () => logMetrics(), week: () => editTask(null, selectedDay), execute: () => editTask(), record: () => editNote() })[page]());
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); globalSearch(); }
});
document.querySelector('.skip-link')?.addEventListener('click', event => { event.preventDefault(); view.focus(); view.scrollIntoView({ block: 'start' }); });
window.addEventListener('hashchange', route);
if (!IS_DEMO) window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY) return;
  const newest = loadState();
  if (newest.error) { toast(newest.error.message, 'error', 9000); return; }
  Object.assign(state, newest);
  render();
  cloudSync?.schedulePush();
});
setInterval(timerTick, 1000);
route();
timerTick();
if (IS_DEMO) {
  const indicator = $('.saved-indicator');
  if (indicator) {
    indicator.className = 'demo-toolbar';
    indicator.innerHTML = `<span class="demo-label"><span class="tiny-dot"></span>交互演示 · 刷新即重置</span><button class="demo-reset" type="button" data-action="reset-demo" aria-label="重置演示，恢复全部示例内容">${icon('reset')}重置演示</button>`;
  }
  const profile = $('.profile');
  if (profile) {
    profile.className = 'profile demo-profile';
    profile.removeAttribute('role'); profile.removeAttribute('tabindex');
    profile.setAttribute('aria-label', '演示空间，所有操作仅用于当前体验');
    profile.innerHTML = `<div class="profile-avatar">${icon('spark')}</div><div>自由试一试<small>示例内容 · 仅供体验</small></div>`;
  }
  const workspace = $('.workspace-switch');
  if (workspace) workspace.innerHTML = '<span class="workspace-monogram">D</span><div>Life OS 演示空间<small>INTERACTIVE DEMO</small></div><span class="online-indicator" title="临时体验空间"></span>';
} else {
cloudSync = new CloudSync({
  getState: () => state,
  replaceState: next => {
    if (workspaceScope !== STORAGE_KEY) {
      workspaceScope = STORAGE_KEY;
      undoTask = null; undoItem = null;
      clearTimeout(toastTimeout);
      $('#toast').className = 'toast-container'; $('#toast').innerHTML = '';
      dialog.close(); $('#dialog-content').innerHTML = ''; lastFocused = null;
      decisionFilter = 'all'; taskFilter = 'pending'; noteTag = '全部'; noteQuery = '';
    }
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next); render();
  },
  notify: toast,
});
mountCloudUI({ sync: cloudSync, getState: () => state, notify: toast });
cloudSync.start().catch(error => toast(error.message, 'error'));
}
if (state.error) toast(state.error.message, 'error', 9000);
