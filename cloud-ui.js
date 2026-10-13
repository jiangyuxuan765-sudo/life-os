const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const phaseLabels = { unconfigured: '云同步待配置', 'signed-out': '登录以同步', connecting: '正在连接', syncing: '同步中', pending: '等待同步', synced: '已同步', offline: '离线 · 本机已保存', expired: '登录已过期', error: '同步待重试', conflict: '有冲突备份' };
const symbol = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 17H5a4 4 0 0 1-.5-8A7 7 0 0 1 18 8a4.5 4.5 0 0 1 1 9h-1M8 16l4-4 4 4m-4-4v9"/></svg>';
function download(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export function mountCloudUI({ sync, getState, notify }) {
  const dialog = document.createElement('dialog');
  dialog.id = 'account-dialog'; dialog.setAttribute('aria-labelledby', 'account-title');
  document.body.appendChild(dialog);
  const top = document.querySelector('.saved-indicator');
  const accountButton = document.createElement('button'); accountButton.type = 'button'; accountButton.id = 'cloud-status'; accountButton.className = 'sync-status';
  top.replaceWith(accountButton);
  const profile = document.querySelector('.profile'); profile.setAttribute('role', 'button'); profile.setAttribute('tabindex', '0'); profile.setAttribute('aria-label', '账号与同步');
  let email = ''; let step = 'email'; let lastFocus; let busy = false; let displayedInfo = null;
  const close = () => { dialog.close(); lastFocus?.focus?.(); };
  function status() {
    const info = sync.info();
    accountButton.innerHTML = `${symbol}<span>${phaseLabels[info.phase] || '同步'}</span><i></i>`;
    accountButton.dataset.phase = info.phase;
    accountButton.setAttribute('aria-label', `账号与同步：${phaseLabels[info.phase]}`);
    const subtitle = profile.querySelector('small');
    if (subtitle) subtitle.textContent = info.user?.email || '本机空间 · 登录可同步';
  }
  function draw() {
    const info = sync.info();
    displayedInfo = info;
    const exportButton = '<button class="button secondary" type="button" data-cloud="export">导出本机备份</button>';
    let body = '';
    if (!info.configured) {
      body = `<div class="cloud-intro">${symbol}<h3>同一个账号，同一份生活。</h3><p>电脑和手机打开同一网址，登录同一邮箱，即可共享五个板块的数据。</p></div><div class="cloud-callout"><strong>云端还未开通</strong><p>网页已准备好登录和同步功能，网站管理员需先完成数据库与部署配置。现在的内容仍保存在这台设备。</p></div><p class="cloud-help">已有的记录可先导出，网站上线后再导入同一账号。</p><div class="account-buttons">${exportButton}<button type="button" class="button ghost" data-cloud="import-file">导入备份文件</button></div>`;
    } else if (!info.user || info.phase === 'expired') {
      const sent = step === 'sent';
      const code = step === 'code';
      body = `<div class="cloud-intro"><h3>${info.phase === 'expired' ? '重新登录，继续同步' : '把生活空间带到每台设备'}</h3><p>输入邮箱，我们会发送一封登录邮件。点击邮件中的链接即可登录。</p></div>${info.message ? `<p class="cloud-callout">${esc(info.message)}</p>` : ''}<form id="cloud-login-form"><label class="field"><span>邮箱</span><input class="input" name="email" type="email" autocomplete="email" required maxlength="254" value="${esc(email || info.user?.email || '')}" placeholder="you@example.com" ${step !== 'email' ? 'readonly' : ''}></label>${sent ? '<div class="cloud-callout"><strong>请打开登录邮件</strong><p>在要使用 Life OS 的设备上，点击邮件中的登录链接。返回本网站后会自动登录。</p></div><p class="cloud-help">未收到可检查垃圾邮件，或稍后重新发送。邮件链接有时效，请使用最新的一封。</p>' : ''}${code ? '<label class="field"><span>邮件中的数字验证码</span><input class="input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" minlength="6" maxlength="10" required placeholder="输入邮件中的验证码"></label><p class="cloud-help">仅当邮件提供数字验证码时使用；如果邮件只有登录按钮，请直接点击邮件链接。</p>' : ''}<div class="account-buttons"><button class="button primary" type="submit">${code ? '验证并登录' : sent ? '重新发送登录邮件' : '发送登录邮件'}</button>${step !== 'email' ? '<button class="button ghost" type="button" data-cloud="change-email">更换邮箱</button>' : ''}</div></form>${sent ? '<button class="button ghost" type="button" data-cloud="use-code">使用邮件里的数字验证码</button>' : code ? '<button class="button ghost" type="button" data-cloud="use-link">改用邮件登录链接</button>' : ''}<p class="cloud-help">电脑和手机使用同一个邮箱。首次登录会建立个人账号，本机旧内容可在登录后主动导入。</p><div class="account-buttons">${exportButton}<button type="button" class="button ghost" data-cloud="import-file">导入备份文件</button></div>`;
    } else {
      const last = info.lastSync ? new Date(info.lastSync).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未完成首次同步';
      body = `<div class="account-identity"><span class="account-avatar">${esc(info.user.email?.[0]?.toUpperCase() || 'L')}</span><div><strong>${esc(info.user.email)}</strong><small>个人云端空间</small></div></div><div class="cloud-summary"><span>${phaseLabels[info.phase]}</span><small>最近同步：${esc(last)}</small></div><p class="cloud-help">电脑与手机登录同一邮箱后，修改会自动上传；另一端通常在 15 秒内或返回页面时更新。</p>${info.message ? `<p class="cloud-callout">${esc(info.message)}</p>` : ''}${info.conflicts ? `<div class="cloud-callout"><strong>保留了 ${info.conflicts} 份冲突备份</strong><p>同一字段在多端同时修改时采用云端值，本机版本已保存供你检查。删除与编辑同时发生时优先保留编辑。</p><button class="button secondary" data-cloud="conflicts">导出冲突备份</button></div>` : ''}<div class="account-buttons"><button class="button primary" type="button" data-cloud="sync">立即同步</button>${exportButton}</div><div class="account-section"><h3>把已有内容带过来</h3><p>导入会合并内容；相同条目发生冲突时保留备份。原本机空间不会被删除。</p><div class="account-buttons"><button class="button secondary" data-cloud="import-local">导入这个网址的本机内容</button><button class="button ghost" data-cloud="import-file">导入备份文件</button></div></div><div class="account-section"><h3>在手机上打开</h3><p class="site-address">${esc(location.origin + location.pathname)}</p><p>${['localhost','127.0.0.1'].includes(location.hostname) ? '当前是电脑本地预览。发布到 GitHub Pages 后，手机才能从互联网打开。' : '在手机浏览器打开以上地址，使用相同邮箱登录。'}</p></div><button class="button ghost" data-cloud="logout">退出当前账号</button>`;
    }
    dialog.innerHTML = `<div class="modal-header"><div><p class="eyebrow">LIFE OS / EVERYWHERE</p><h2 id="account-title">账号与同步</h2></div><button class="icon-button" type="button" data-cloud="close" aria-label="关闭账号窗口">×</button></div><div class="modal-body account-body">${body}<p id="cloud-error" class="form-error" role="alert" hidden></p><p id="cloud-notice" class="cloud-notice" role="status" hidden></p><input id="backup-file" type="file" accept="application/json,.json" hidden></div>`;
  }
  function open() { lastFocus = document.activeElement; draw(); if (!dialog.open) dialog.showModal(); }
  function error(message) { const element = dialog.querySelector('#cloud-error'); if (element) { element.hidden = false; element.textContent = message; } }
  async function run(action) {
    if (busy) return;
    busy = true;
    dialog.querySelectorAll('button').forEach(button => { if (button.dataset.cloud !== 'close') button.disabled = true; });
    try { await action(); } catch (cause) { error(cause.message || '操作未完成，请重试。'); }
    finally { busy = false; dialog.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  }
  accountButton.addEventListener('click', open);
  profile.addEventListener('click', open);
  profile.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  dialog.addEventListener('click', event => {
    const button = event.target.closest('[data-cloud]'); if (!button) return;
    const action = button.dataset.cloud;
    if (action === 'close') { close(); return; }
    if (action === 'change-email') { step = 'email'; draw(); return; }
    if (action === 'use-code') { step = 'code'; draw(); return; }
    if (action === 'use-link') { step = 'sent'; draw(); return; }
    if (action === 'export') { download(getState(), `life-os-backup-${new Date().toISOString().slice(0,10)}.json`); notify('备份已导出，可在另一台设备登录后导入'); return; }
    if (action === 'conflicts') { download({ type: 'life-os-conflicts', conflicts: sync.readConflicts() }, 'life-os-conflicts.json'); return; }
    if (action === 'import-file') { dialog.querySelector('#backup-file').click(); return; }
    run(async () => {
      if (action === 'sync') { await sync.sync(); draw(); }
      if (action === 'import-local') { await sync.importGuest(); await sync.sync(); draw(); notify('本机内容已合并，请查看同步状态'); }
      if (action === 'logout') { await sync.signOut(); email = ''; step = 'email'; draw(); }
    });
  });
  dialog.addEventListener('submit', event => {
    if (event.target.id !== 'cloud-login-form') return;
    event.preventDefault(); const data = new FormData(event.target); email = String(data.get('email')).trim();
    run(async () => {
      if (step !== 'code') { await sync.sendCode(email); step = 'sent'; draw(); const notice = dialog.querySelector('#cloud-notice'); notice.hidden = false; notice.textContent = '登录邮件已发送，请点击邮件中的链接。'; }
      else { await sync.verifyCode(email, String(data.get('code'))); draw(); }
    });
  });
  dialog.addEventListener('change', event => {
    if (event.target.id !== 'backup-file') return;
    const file = event.target.files[0]; if (!file) return;
    run(async () => {
      if (file.size > 2 * 1024 * 1024) throw new Error('备份超过 2 MB，请先精简内容。');
      let snapshot; try { snapshot = JSON.parse(await file.text()); } catch { throw new Error('这不是有效的 Life OS JSON 备份。'); }
      await sync.importState(snapshot); if (sync.user) await sync.sync(); draw(); notify('备份已合并，请检查列表和同步状态');
    });
  });
  sync.onStatus(info => {
    status();
    if (!dialog.open || busy) return;
    if (displayedInfo?.user?.id !== info.user?.id || displayedInfo?.conflicts !== info.conflicts || (displayedInfo?.phase === 'expired') !== (info.phase === 'expired')) {
      if (displayedInfo?.user?.id !== info.user?.id) { email = ''; step = 'email'; }
      draw();
      return;
    }
    const summary = dialog.querySelector('.cloud-summary');
    if (summary) {
      summary.querySelector('span').textContent = phaseLabels[info.phase];
      summary.querySelector('small').textContent = `最近同步：${info.lastSync ? new Date(info.lastSync).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未完成首次同步'}`;
    }
    const problem = dialog.querySelector('#cloud-error');
    if (problem && ['error', 'offline'].includes(info.phase) && info.message) { problem.hidden = false; problem.textContent = info.message; }
    else if (problem && info.phase === 'synced') { problem.hidden = true; problem.textContent = ''; }
  });
  return { open };
}
