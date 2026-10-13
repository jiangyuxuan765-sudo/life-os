# 部署 Life OS：GitHub Pages + Supabase

本仓库已准备静态托管与跨设备同步所需的代码和数据库脚本。**准备好代码不等于已经部署，也不代表现有数据已经云同步。** 需要完成下面的账户、项目、数据库、站点配置，并通过两台设备验证后，才能确认同步可用。

GitHub Pages 提供网页地址；Supabase 提供邮箱验证码登录和个人数据存储。决策、监控、周计划、任务与记录使用同一账号同步；专注计时器在当前设备运行，不同步计时状态。离线操作仍保存在当前浏览器，联网登录后的同步结果以页面状态为准。

## 1. 准备账户和仓库

1. 使用你自己的 GitHub 和 Supabase 账户登录。账户注册、邮箱验证、服务条款和可能的付费确认需要你本人完成，助手不能代为注册。
2. 在 GitHub 创建或选定一个仓库，上传本项目，保留 `.github/workflows/deploy.yml`，默认分支使用 `main`。若使用其他分支，修改工作流的 `push.branches`。
3. 在 Supabase 创建项目并等待数据库就绪。记录项目的 **Project URL** 和 **Publishable key**；通常可在项目的 Connect 或 Settings → API Keys 中找到。

GitHub 连接器是否已连接、仓库是否已创建、是否已推送代码，需要分别确认；本文件的存在不表示上述操作已经完成。GitHub Pages 能否使用私有仓库取决于账户方案，公开仓库是直接的选择。网页文件可公开访问，个人数据仍通过登录和数据库权限隔离。

## 2. 创建 Supabase 数据表与权限

在 Supabase → SQL Editor 新建查询，粘贴并执行仓库内的 `supabase/schema.sql`。脚本可重复执行，并会创建：

- `public.life_os_workspaces`：每个用户一份 JSON 文档，包含版本号和服务端更新时间。
- RLS 读取策略：登录用户只能读取 `auth.uid()` 对应的一行。
- `public.save_life_os_workspace`：带版本比较的保存函数；客户端没有直接修改或删除表的权限。
- 2 MiB 文档上限及基本数据结构检查。

确认 SQL Editor 执行成功，Table Editor 中出现 `life_os_workspaces`，且启用了 RLS。不需要开启 Realtime；客户端采用约 15 秒轮询，并在页面重新获得焦点时检查更新。

**不要关闭 RLS，也不要向浏览器提供 `service_role`、`sb_secret_...`、数据库密码或任何服务端密钥。** 发布到网页的仅为 Publishable key；旧版项目也可使用角色为 `anon` 的公开密钥。公开密钥不是用户的登录身份，数据访问仍需要用户 JWT 和 RLS。

## 3. 配置邮箱验证码登录

在 Supabase Authentication 中启用 Email 登录。页面使用邮箱验证码（OTP）流程：发送验证码，然后输入邮件中的数字验证码完成验证。

**必须修改邮件模板。** Supabase 默认 Magic Link 模板常使用 `{{ .ConfirmationURL }}` 链接；本页面需要直接显示 `{{ .Token }}`。在 Authentication → Email Templates 的 **Magic Link** 模板中，将正文改为类似：

```html
<h2>登录你的 Life OS</h2>
<p>本次登录验证码：</p>
<p style="font-size:28px;letter-spacing:6px"><strong>{{ .Token }}</strong></p>
<p>请回到 Life OS 输入验证码。如果不是你发起的请求，可忽略此邮件。</p>
```

若项目对首次注册使用 **Confirm signup** 模板，也在该模板中显示 `{{ .Token }}`，并实际测试一个首次登录的邮箱。页面接受 6–10 位数字验证码，具体长度和有效期由项目的 Email OTP 设置决定。要允许新的个人账号首次登录，请保持相应的允许注册设置开启。

如果 Supabase 内置邮件服务限制收件地址、配额或发送频率，按项目提示配置自己的 SMTP。测试时检查垃圾邮件，并等待冷却时间后重发。不要在应用中填 SMTP 密码；邮件服务配置留在 Supabase 项目内。

## 4. 配置站点地址和允许列表

假设 GitHub 用户名为 `your-name`、仓库名为 `life-os`，项目页通常为：

```text
https://your-name.github.io/life-os/
```

在 Supabase Authentication → URL Configuration 中：

- **Site URL** 设置为正式 Pages 地址，包含仓库路径和尾部 `/`。
- **Redirect URLs / Allow list** 添加同一个完整正式地址。
- 本地调试时按需添加 `http://127.0.0.1:4173/` 和 `http://localhost:4173/`。
- 使用自定义域名时，将正式 Site URL 与允许列表更新为该 HTTPS 地址。

OTP 数字验证码不依赖点击跳转链接，但正确的认证站点配置仍用于邮件和认证上下文。五个页面通过 `#decision` 等 hash 导航，同一个正式站点地址即可，不需要为每个工作页部署独立路径。

## 5. 配置 GitHub Pages 发布

打开 GitHub 仓库 Settings → Secrets and variables → Actions → **Variables**，新增两个 **Repository variables**：

| 名称 | 值 |
| --- | --- |
| `SUPABASE_URL` | `https://你的项目标识.supabase.co`，或项目提供的 HTTPS API 地址 |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase Publishable key；旧版公开 `anon` key 也可使用 |

这些值最终会成为公开的 `cloud-config.js`，因此使用 Variables 即可；不要在此填写 Secret key 或 `service_role`。工作流会拒绝识别出的服务端密钥，避免将其发布。

接着在 Settings → Pages → Build and deployment，将 **Source** 设为 **GitHub Actions**。推送到 `main`，或到 Actions → **Deploy Life OS to GitHub Pages** → **Run workflow** 手动执行。

工作流使用 Python 将白名单文件复制到 `out/`，根据上述变量生成：

```js
export const SUPABASE_URL = "https://你的项目标识.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "你的公开发布密钥";
```

工作流在打包前运行全部自动化测试，打包后检查 JavaScript 语法，只上传并发布以下八个文件：

```text
index.html
styles.css
app.js
store.js
cloud.js
cloud-ui.js
sync-core.js
cloud-config.js
```

SQL、测试、QA 产物、`.git` 和文档不会进入 Pages 发布目录。GitHub 仓库本身若是公开的，仓库内已提交的文件仍可公开查看；发布白名单只控制网页站点产物。

首次运行缺少 Pages 配置、仓库变量或源文件时，工作流会失败并说明原因，不会静默发布一个不具备同步配置的版本。成功后，在工作流的 `github-pages` 环境或 Settings → Pages 中取得实际站点地址，再核对 Supabase URL 配置。

## 6. 用两台设备验收

1. 电脑打开正式 Pages 地址，发送验证码并登录；新账号从空工作区开始。需要迁移时，在账号窗口主动导入本机内容或 JSON 备份。
2. 新增一条带有明确测试名称的记录，等待页面显示已同步。
3. 手机打开**同一正式地址**，用**同一邮箱**登录，确认记录出现。
4. 手机修改记录，回到电脑页面，等待一次轮询或重新聚焦，确认修改同步。
5. 两台设备分别修改不同任务，确认都能保留；若出现同一字段冲突，确认云端值被采用且本机版本可从账号窗口导出备份，再核对并恢复需要的内容。
6. 断网新增一个任务，再联网，确认上传成功；刷新后仍能看到该任务。
7. 用另一个测试账号登录，确认看不到第一个账号的个人数据。

本地开发地址和 Pages 地址属于不同浏览器存储来源。本地地址已有的内容不会因为站点发布自动出现在正式域名；需要在原环境使用已配置的同一 Supabase 项目登录并同步，或通过应用实际提供的数据迁移方式转移。不要清除旧站点数据，直到已在新站点验证内容完整。

上述验证全部完成前，应描述为“同步功能和部署文件已准备，仍待部署/验证”，不要描述为“已开启跨设备云同步”。

## 同步接口契约

首次读取可调用 Supabase Data API 的普通 SELECT：

```text
GET /rest/v1/life_os_workspaces?select=state,revision,updated_at&user_id=eq.<当前用户ID>
```

请求携带公开 `apikey` 和当前登录会话的 `Authorization: Bearer <access_token>`。无行时视为尚未创建工作区，初始期望版本为 `0`。读取其它用户 ID 会被 RLS 过滤，不会返回对方文档。

保存使用 RPC：

```text
POST /rest/v1/rpc/save_life_os_workspace
Content-Type: application/json

{
  "p_state": {
    "version": 1,
    "tasks": [],
    "decisions": [],
    "metrics": [],
    "goals": [],
    "notes": []
  },
  "p_expected_revision": 0
}
```

服务端只从登录 JWT 取得用户 ID，不接受由客户端指定工作区归属。响应结构固定：

```json
{
  "applied": true,
  "state": { "version": 1, "tasks": [], "decisions": [], "metrics": [], "goals": [], "notes": [] },
  "revision": 1,
  "updated_at": "服务端 ISO 时间"
}
```

- `p_expected_revision = 0`：仅当用户工作区不存在时插入；并发首次保存只能一个成功。
- `p_expected_revision > 0`：仅当服务端版本匹配才更新，成功后版本加一。
- 版本不匹配：`applied: false`，返回最新 `state/revision/updated_at`，不覆写。客户端结合本地修改与原基线处理冲突，再以最新版本重试。
- 期望非零版本但工作区不存在：`applied: false, state: null, revision: 0, updated_at: null`。
- 无登录身份、负版本、版本结构不符或 JSON 超过 2 MiB：返回错误，不修改数据。
- `state` 的 `version` 必须为数值 `1`；`tasks/decisions/metrics/goals/notes` 必须为数组。单个实体的业务字段由客户端验证，服务端限制文档结构与 UTF-8 JSON 正文大小。
- 计时器属于设备本地状态，客户端提交云文档时排除 `timer`，下载数据时不替换当前设备计时。

SQL Editor 的管理员会话通常没有用户 JWT，直接执行 RPC 可能收到 `Authentication required`；应通过已登录的网页/API 验证用户操作，不应为了测试移除身份检查。
