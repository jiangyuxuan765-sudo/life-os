import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './cloud-config.js';
import { createEmptyState, loadState, saveState, setStorageScope, readGuestState, validState } from './store.js';
import { mergeStates, hasUserContentChanges } from './sync-core.js';

const clone = value => JSON.parse(JSON.stringify(value));
export function cloudSnapshot(state) {
  const next = clone(state);
  // Timers run on one device. Only the resulting focus minutes join the shared workspace.
  delete next.timer;
  return next;
}
const same = (a, b) => !hasUserContentChanges(a, b);

/** Supabase's redirect_to query parameter must retain the GitHub Pages repo path. */
export function authRedirectUrl(location = globalThis.location) {
  if (!location) return undefined;
  const url = new URL(location.href || `${location.origin}${location.pathname}`);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请在正式 HTTPS 网址上发送登录邮件。');
  return `${url.origin}${url.pathname}`;
}

/** Remove callback secrets synchronously, before validating or making requests. */
export function takeAuthCallback({ location = globalThis.location, history = globalThis.history, appUrl = import.meta.url, now = Date.now() } = {}) {
  if (!location?.hash) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  if (!['access_token', 'refresh_token', 'error', 'error_code', 'error_description'].some(key => params.has(key))) return null;
  // replaceState is deliberately required. If the URL cannot be cleaned, do not
  // send or persist its credentials. The full secret fragment is never logged.
  if (!history?.replaceState) throw new Error('无法安全处理登录链接，请在正式网站重新发送登录邮件。');
  history.replaceState(history.state ?? null, '', `${location.pathname}${location.search || ''}#decision`);
  const page = new URL(location.href || `${location.origin}${location.pathname}`);
  const application = new URL('.', appUrl);
  const pageMatches = page.origin === application.origin && [application.pathname, `${application.pathname}index.html`].includes(page.pathname);
  if (page.protocol !== 'https:' || !pageMatches) throw new Error('请在正式网站打开登录邮件中的链接。');
  if (params.has('error') || params.has('error_code') || params.has('error_description')) throw new Error('登录链接已失效或无法验证，请重新发送登录邮件。');
  if (params.has('type') && !['magiclink', 'signup', 'email'].includes(params.get('type'))) throw new Error('这个链接不是邮箱登录链接，请重新发送登录邮件。');
  const access_token = params.get('access_token');
  const refresh_token = params.get('refresh_token');
  const token_type = params.get('token_type') || 'bearer';
  const expires_in = Number(params.get('expires_in'));
  const expires_at = params.has('expires_at') ? Number(params.get('expires_at')) : Math.floor(now / 1000) + expires_in;
  if (!access_token || !refresh_token || /\s/.test(access_token + refresh_token) || access_token.length > 16000 || refresh_token.length > 16000 || token_type.toLowerCase() !== 'bearer' || !Number.isSafeInteger(expires_at) || expires_at * 1000 <= now || !Number.isFinite(expires_in) || expires_in <= 0) {
    throw new Error('登录链接不完整或已过期，请重新发送登录邮件。');
  }
  return { access_token, refresh_token, expires_at, expires_in, token_type: 'bearer' };
}

export function connectionSettings(url = SUPABASE_URL, key = SUPABASE_PUBLISHABLE_KEY) {
  if (!url || !key) return { configured: false };
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('云端地址必须是 HTTPS 项目根地址。');
  let publicKey = key.startsWith('sb_publishable_');
  if (key.split('.').length === 3) {
    try { publicKey = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'anon'; } catch { publicKey = false; }
  }
  if (!publicKey) throw new Error('请配置 Supabase publishable / anon 公钥，不可使用服务端密钥。');
  return { configured: true, url: parsed.origin, key, project: parsed.host };
}

export class SupabaseClient {
  constructor(config, { fetcher = globalThis.fetch, storage = globalThis.localStorage } = {}) {
    this.config = config; this.fetcher = fetcher; this.storage = storage;
    this.sessionKey = `life-os.cloud.session.v1.${config.project}`;
    try { this.session = JSON.parse(storage.getItem(this.sessionKey) || 'null'); } catch { this.session = null; }
    this.refreshing = null;
  }
  remember(session) {
    const next = session ? { ...session, expires_at: session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600) } : null;
    if (session) this.storage.setItem(this.sessionKey, JSON.stringify(next));
    else this.storage.removeItem(this.sessionKey);
    this.session = next;
  }
  async request(path, { method = 'GET', body, authenticated = false, refresh = true, expectedUserId = this.session?.user?.id, verificationToken } = {}) {
    if (authenticated && refresh) await this.ensureSession();
    if (authenticated && (!expectedUserId || this.session?.user?.id !== expectedUserId)) throw Object.assign(new Error('登录账号已改变，请重新同步。'), { status: 401 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = { apikey: this.config.key, 'Content-Type': 'application/json' };
      if (authenticated) headers.Authorization = `Bearer ${this.session.access_token}`;
      else if (verificationToken) headers.Authorization = `Bearer ${verificationToken}`;
      const response = await this.fetcher(`${this.config.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store' });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : null; } catch { throw new Error('云端返回了无法读取的响应，请稍后重试。'); }
      if (!response.ok) {
        const error = new Error(response.status === 429 ? '发送或登录过于频繁，请稍后再试。' : response.status === 401 ? '登录已过期，请重新登录。' : payload?.error_description || payload?.msg || payload?.message || '云端请求未完成，请稍后重试。');
        error.status = response.status;
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('连接云端超时。你的修改仍保留在本机。');
      throw error;
    } finally { clearTimeout(timeout); }
  }
  async sendCode(email, redirectTo = authRedirectUrl()) {
    const query = redirectTo ? `?${new URLSearchParams({ redirect_to: redirectTo })}` : '';
    return this.request(`/auth/v1/otp${query}`, { method: 'POST', body: { email, create_user: true } });
  }
  async verifyLinkSession(credentials) {
    // Never trust user/id/email fields or JWT claims from the fragment. Verify
    // against this project's auth endpoint without changing the current session.
    const user = await this.request('/auth/v1/user', { verificationToken: credentials.access_token });
    if (!user?.id || typeof user.id !== 'string') throw new Error('无法确认登录身份，请重新发送登录邮件。');
    return { ...credentials, user };
  }
  async verifyCode(email, token) {
    const session = await this.request('/auth/v1/verify', { method: 'POST', body: { email, token, type: 'email' } });
    if (!session?.access_token || !session?.user?.id) throw new Error('没有收到有效的登录凭证，请重新获取验证码。');
    this.remember(session);
    return session.user;
  }
  async ensureSession() {
    if (!this.session?.access_token || !this.session?.refresh_token) throw Object.assign(new Error('请先登录后同步。'), { status: 401 });
    if (this.session.expires_at * 1000 > Date.now() + 60000) return;
    if (!this.refreshing) {
      const original = this.session;
      this.refreshing = this.request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: original.refresh_token }, refresh: false }).then(session => {
        // A response from an old login must not restore it after another tab switches accounts.
        if (this.session !== original) throw Object.assign(new Error('登录状态已更新，请重新同步。'), { status: 401 });
        if (session?.user?.id !== original.user?.id) throw Object.assign(new Error('登录身份不匹配，请重新登录。'), { status: 401 });
        this.remember(session);
      }).catch(error => { if (error.status === 400 || error.status === 403) error.status = 401; throw error; }).finally(() => { this.refreshing = null; });
    }
    await this.refreshing;
  }
  async currentUser() { return this.request('/auth/v1/user', { authenticated: true }); }
  async readWorkspace(expectedUserId = this.session?.user?.id) {
    const rows = await this.request(`/rest/v1/life_os_workspaces?select=state,revision,updated_at&user_id=eq.${encodeURIComponent(expectedUserId)}&limit=1`, { authenticated: true, expectedUserId });
    if (!Array.isArray(rows)) throw new Error('云端数据结构不正确，请检查数据库安装。');
    return rows[0] || { state: null, revision: 0, updated_at: null };
  }
  async writeWorkspace(state, revision, expectedUserId = this.session?.user?.id) {
    return this.request('/rest/v1/rpc/save_life_os_workspace', { method: 'POST', body: { p_state: state, p_expected_revision: revision }, authenticated: true, expectedUserId });
  }
  async logout() {
    const session = this.session;
    try { await this.request('/auth/v1/logout?scope=local', { method: 'POST', authenticated: true }); }
    finally { if (this.session?.user?.id === session?.user?.id) this.remember(null); }
  }
}

export class CloudSync {
  constructor({ getState, replaceState, notify, storage = globalThis.localStorage, config, client, location = globalThis.location, history = globalThis.history, appUrl = import.meta.url } = {}) {
    this.getState = getState; this.replaceState = replaceState; this.notify = notify || (() => {}); this.storage = storage;
    this.browser = { location, history, appUrl };
    this.listeners = new Set(); this.user = null; this.meta = null; this.busy = null; this.pending = false; this.epoch = 0; this.debounce = null; this.poll = null;
    try { this.config = config || connectionSettings(); } catch (error) { this.config = { configured: false }; this.configError = error.message; }
    this.client = this.config.configured ? client || new SupabaseClient(this.config, { storage }) : null;
    this.status = { phase: this.config.configured ? 'signed-out' : 'unconfigured', message: this.configError || '', lastSync: null, conflicts: 0 };
  }
  onStatus(listener) { this.listeners.add(listener); listener(this.info()); return () => this.listeners.delete(listener); }
  info() { return { ...this.status, configured: this.config.configured, user: this.user, pending: this.pending }; }
  setStatus(phase, message = '') { this.status = { ...this.status, phase, message }; for (const listener of this.listeners) listener(this.info()); }
  async start() {
    if (!this.client) return;
    this.poll = setInterval(() => { if (this.user && document.visibilityState === 'visible') this.sync(); }, 15000);
    this.resumeHandler = () => { if (this.user) this.sync(); };
    globalThis.addEventListener('online', this.resumeHandler);
    globalThis.addEventListener('focus', this.resumeHandler);
    this.visibilityHandler = () => { if (document.visibilityState === 'visible') this.resumeHandler(); };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.storageHandler = event => {
      if (event.key === this.client.sessionKey) {
        let session = null;
        try { session = JSON.parse(event.newValue || 'null'); } catch { return; }
        this.client.session = session;
        // Also invalidate an incoming link while no account is active yet:
        // null -> null can still represent an explicit sign-out in another tab.
        this.epoch++;
        if (session?.user?.id === this.user?.id) return;
        clearTimeout(this.debounce);
        if (session?.user?.id) { this.activate(session.user); this.sync(); }
        else {
          this.user = null; this.meta = null; this.pending = false;
          this.status = { phase: 'signed-out', lastSync: null, conflicts: 0, message: '' };
          setStorageScope(); this.replaceState(loadState()); this.setStatus('signed-out');
        }
      }
      if (this.user && event.key === this.metaKey && event.newValue) {
        try {
          const newest = JSON.parse(event.newValue);
          if (Number.isSafeInteger(newest.revision) && (!newest.base || validState(newest.base))) {
            this.meta = newest;
            this.status.lastSync = newest.lastSync;
            this.schedulePush();
          }
        } catch { /* Preserve the last valid baseline. */ }
      }
    };
    globalThis.addEventListener('storage', this.storageHandler);
    // An incoming email link takes priority over a cached login. Invalid links
    // preserve the existing guest/account workspace and never start a sync.
    const callbackEpoch = this.epoch;
    const originalSession = this.client.session;
    try {
      const credentials = takeAuthCallback(this.browser);
      if (credentials) {
        this.setStatus('connecting', '正在验证登录链接…');
        const session = await this.client.verifyLinkSession(credentials);
        if (callbackEpoch !== this.epoch || this.client.session !== originalSession) return;
        this.client.remember(session);
        this.activate(session.user);
        await this.sync();
        this.notify('已通过邮件链接登录');
        return;
      }
    } catch {
      if (callbackEpoch === this.epoch) {
        this.setStatus('error', '登录链接未能完成验证。原有内容已保留，请重新发送登录邮件。');
        this.notify(this.status.message, 'error');
      }
      return;
    }
    const storedUser = this.client.session?.user;
    if (storedUser?.id) {
      // Restore only this account's offline workspace; never show another account's cache.
      this.activate(storedUser);
      const epoch = this.epoch;
      try {
        const verifiedUser = await this.client.currentUser();
        if (epoch !== this.epoch) return;
        if (!verifiedUser?.id) throw new Error('无法确认登录身份，请重新登录。');
        const session = { ...this.client.session, user: verifiedUser };
        if (this.client.remember) this.client.remember(session);
        else this.client.session = session;
        if (verifiedUser.id !== this.user.id) this.activate(verifiedUser);
        else this.user = verifiedUser;
        await this.sync();
      }
      catch (error) { if (epoch === this.epoch) this.handleError(error); }
    }
  }
  activate(user) {
    this.epoch++; this.user = user;
    this.metaKey = `life-os.cloud.sync.v1.${this.config.project}.${user.id}`;
    this.conflictKey = `${this.metaKey}.conflicts`;
    setStorageScope(user.id, this.config.project);
    const local = loadState();
    try { this.meta = JSON.parse(this.storage.getItem(this.metaKey) || 'null'); } catch { this.meta = null; }
    if (!this.meta || !Number.isSafeInteger(this.meta.revision) || (this.meta.base !== null && !validState(this.meta.base))) this.meta = { revision: 0, base: null, lastSync: null };
    this.status.lastSync = this.meta.lastSync;
    this.status.conflicts = this.readConflicts().length;
    this.pending = !same(cloudSnapshot(local), this.meta.base || cloudSnapshot(createEmptyState()));
    this.replaceState(local);
    if (local.error) this.notify(local.error.message, 'error');
    this.setStatus('connecting');
  }
  async sendCode(email) {
    if (!this.client) throw new Error('云端服务还未配置。');
    return this.client.sendCode(email.trim().toLowerCase(), authRedirectUrl(this.browser.location));
  }
  async verifyCode(email, code) {
    const user = await this.client.verifyCode(email.trim().toLowerCase(), code.trim());
    this.activate(user);
    await this.sync();
    return user;
  }
  schedulePush() {
    if (!this.user) return;
    this.pending = !same(cloudSnapshot(this.getState()), this.meta.base || cloudSnapshot(createEmptyState()));
    if (!this.pending) return;
    this.setStatus(navigator.onLine ? 'pending' : 'offline');
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.sync(), 700);
  }
  saveMeta() { this.storage.setItem(this.metaKey, JSON.stringify(this.meta)); }
  readConflicts() {
    if (!this.conflictKey) return [];
    try { const entries = JSON.parse(this.storage.getItem(this.conflictKey) || '[]'); return Array.isArray(entries) ? entries : []; } catch { return []; }
  }
  keepConflicts(conflicts) {
    if (!conflicts?.length) return;
    const previous = this.readConflicts();
    // Never discard prior conflict backups automatically.
    const next = [...previous, ...conflicts.map(entry => ({ ...entry, savedAt: new Date().toISOString() }))];
    this.storage.setItem(this.conflictKey, JSON.stringify(next));
    this.status.conflicts = next.length;
  }
  handleError(error) {
    if (error.status === 401) this.setStatus('expired', error.message);
    else this.setStatus(navigator.onLine ? 'error' : 'offline', error.message || '暂时无法同步，修改已保留在本机。');
  }
  async sync() {
    if (!this.user || !this.client) return;
    if (this.busy) return this.busy;
    const epoch = this.epoch;
    this.busy = this.performSync(epoch).catch(error => { if (epoch === this.epoch) this.handleError(error); }).finally(() => { this.busy = null; });
    return this.busy;
  }
  async performSync(epoch) {
    if (!navigator.onLine) { this.setStatus('offline'); return; }
    this.setStatus('syncing');
    const userId = this.user.id;
    let remote = await this.client.readWorkspace(userId);
    for (let attempt = 0; attempt < 4; attempt++) {
      if (epoch !== this.epoch) return;
      if (remote.state !== null && !validState(remote.state)) throw new Error('云端内容格式异常，已停止同步以保留本机数据。');
      const local = cloudSnapshot(this.getState());
      const base = this.meta.base || cloudSnapshot(createEmptyState());
      const target = remote.state === null ? { state: local, conflicts: [] } : mergeStates(base, local, cloudSnapshot(remote.state));
      if (!validState(target.state)) throw new Error('合并后的内容无法保存，原数据仍然保留。');
      // Back up every collision before choosing the cloud version or writing anything.
      this.keepConflicts(target.conflicts);
      let response = { ...remote, applied: true };
      if (remote.state === null || !same(target.state, cloudSnapshot(remote.state))) response = await this.client.writeWorkspace(cloudSnapshot(target.state), remote.revision, userId);
      if (epoch !== this.epoch) return;
      if (!response?.applied) { remote = response; continue; }
      const accepted = cloudSnapshot(response.state || target.state);
      if (!validState(accepted)) throw new Error('云端确认内容无效，已停止同步。');
      // Include edits made while the network request was in flight.
      const current = cloudSnapshot(this.getState());
      const final = mergeStates(local, current, accepted);
      this.keepConflicts(final.conflicts);
      const next = { ...final.state, timer: clone(this.getState().timer) };
      saveState(next);
      this.meta = { revision: response.revision, base: accepted, lastSync: new Date().toISOString() };
      this.saveMeta();
      this.replaceState(next);
      this.pending = !same(cloudSnapshot(next), accepted);
      this.status.lastSync = this.meta.lastSync;
      if (this.pending) { remote = { state: accepted, revision: response.revision }; continue; }
      this.setStatus(this.status.conflicts ? 'conflict' : 'synced');
      return;
    }
    this.pending = true;
    this.setStatus('pending', '其他设备仍在更新，将自动重试。');
  }
  async importState(imported) {
    if (!validState(imported)) throw new Error('这份备份格式不正确，原有数据没有改变。');
    const current = this.getState();
    const merged = mergeStates(cloudSnapshot(createEmptyState()), cloudSnapshot(imported), cloudSnapshot(current));
    if (this.user) this.keepConflicts(merged.conflicts);
    else if (merged.conflicts.length) this.storage.setItem(`life-os.import-recovery.${Date.now()}`, JSON.stringify(imported));
    const next = { ...merged.state, timer: current.timer };
    saveState(next); this.replaceState(next); this.schedulePush();
    return merged.conflicts.length;
  }
  async importGuest() {
    const guest = readGuestState();
    if (!guest) throw new Error('这个网址下没有可导入的本机内容。旧网址的内容可先导出为备份。');
    return this.importState(guest);
  }
  async signOut() {
    if (this.busy) await this.busy;
    if (this.pending) { await this.sync(); if (this.pending) throw new Error('仍有未同步的修改，请联网同步后退出，或先导出备份。'); }
    this.epoch++; clearTimeout(this.debounce);
    const epoch = this.epoch;
    try { await this.client.logout(); } catch { /* Local sign-out still clears the browser session. */ }
    if (epoch !== this.epoch) return;
    this.user = null; this.meta = null; this.pending = false; this.status = { phase: 'signed-out', lastSync: null, conflicts: 0, message: '' };
    setStorageScope(); this.replaceState(loadState()); this.setStatus('signed-out');
  }
  destroy() {
    clearInterval(this.poll); clearTimeout(this.debounce); this.epoch++;
    globalThis.removeEventListener('online', this.resumeHandler); globalThis.removeEventListener('focus', this.resumeHandler);
    globalThis.removeEventListener('storage', this.storageHandler);
    if (this.visibilityHandler) document.removeEventListener('visibilitychange', this.visibilityHandler);
  }
}
