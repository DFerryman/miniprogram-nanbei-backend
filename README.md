# 摄影工作室 · 内容管理后台

摄影工作室小程序（[配套小程序仓库](https://github.com/DFerryman/miniprogram-nanbei)）的网页管理后台，部署在 **Cloudflare Workers** 上。它直接读写小程序所用的微信云开发（CloudBase）环境：

- **作品**：浏览当前环境的全部作品；新建作品并上传图片、视频；编辑标题、说明、拍摄日期、地点、系列、标签、排序权重和发布状态；调整媒体顺序、指定封面；删除作品，可同时清理云存储文件。
- **系列**：新建、编辑、删除作品系列（小程序「作品」页顶部的筛选栏）。
- **关于我们**：编辑工作室名称、标语、封面、介绍、附加板块、地址、营业时间、地图坐标和联系方式（电话、微信、企业微信、小红书、抖音、微博、邮箱、链接，可上传二维码）。
- **小程序预览**：编辑页右侧用 375pt 宽的手机框复刻小程序页面：作品瀑布流、作品相册（单列 / 双列）、发现页全屏浏览、关于页（含联系方式弹出面板）。尺寸、字号和排序规则都取自小程序源码，修改实时生效，保存前就能看到效果。

后台的数据结构与小程序仓库的 `docs/data-model.md` 一致，不需要修改小程序或云函数。

## 工作原理

```text
浏览器（React 单页应用）
  │  邮箱申请 → 管理员邮件审批 → 邮箱验证码登录（HttpOnly Cookie）
  ▼
Cloudflare Worker（/api/*，worker/index.ts）
  │  D1 校验会话与授权 → 读取服务端环境变量 → 调用微信服务端 API
  │  D1 同时保存协作辅助数据：在线状态、修改记录、待删除文件（与内容不在同一事务）
  ▼
微信云开发 HTTP API（api.weixin.qq.com/tcb/*）
  ├─ 云数据库：portfolios / series / studio
  └─ 云存储：portfolios/<作品ID>/…、studio/profile/…
```

- 静态页面由 Workers Static Assets 提供，`/api/*` 由 Worker 处理。
- **连接配置保存在 Cloudflare**：AppID 与环境 ID 使用 Worker 环境变量，AppSecret 使用 Secret。浏览器不再输入、保存或发送云开发凭据；首次加载会清除旧版本保存的配置。
- **邮箱授权**：用户填写邮箱申请权限，管理员收到带 Approve / Reject 按钮的邮件。按钮先打开确认页，确认后才改变权限，防止邮件扫描器误授权。批准后，同一邮箱可获取 6 位登录码。管理员邮箱可直接获取登录码。
- **认证数据保存在独立 D1 数据库**：包括授权状态、审批链接哈希、验证码 HMAC、会话哈希及限流记录。登录凭据使用 Secure、HttpOnly Cookie，所有业务接口都在服务端检查授权。
- 小程序的 `stats`（点赞 / 收藏 / 分享计数）由 `user` 云函数维护，后台更新作品时不写这个字段，避免覆盖并发产生的计数。计数更新也不会改变下文的版本号，因此不会让后台编辑产生误报冲突。

## 多人同时编辑

多个邮箱（或共用一个邮箱的多人、同一人的多个窗口）可以同时登录和编辑。设计取舍如下。

**数据保护：版本号 + 条件写入（不使用编辑锁）。** `portfolios`、`series`、`studio` 文档带有 `rev` 版本号（旧数据没有该字段，视为 0，新写入从 1 开始）。保存、删除都要带上页面加载时的版本号，Worker 用一条语句完成检查和写入：

```text
db.collection("portfolios").where({_id:"p1", rev:3}).update({data:{…, rev:4}})
```

云数据库对单个文档的条件更新是原子的，两个基于同一版本的保存只有一个能匹配到文档；另一个得到 `409 CONFLICT`，响应中附带最新文档。缺少版本号的请求（例如部署前打开、未刷新的旧页面）一律拒绝，不会再整篇覆盖。

没有采用“一人编辑、其他人只读”的锁：锁只能放在 D1，而内容在微信云数据库，两者没有共同事务，锁过期、断线重连后的旧请求仍要靠版本号拦截，锁本身并不增加数据安全；同时会带来接管、续期、共用账号无法区分是谁等问题。版本号已能保证不覆盖，再配合下面的在线状态提示，避免多数“白做一遍”。

**冲突时不丢失输入。** 保存冲突后弹出字段级合并界面：以打开页面时的版本为基准，只有一方改过的字段自动合并，双方都改过的逐项选择保留哪一份；合并结果填回表单，确认后再保存。也可以“稍后处理”或放弃自己的修改。若作品 / 系列在编辑期间被删除，表单保留，可以用相同 ID 重新创建。

**在线状态。** 每个窗口每 15 秒（后台窗口 30 秒）发送心跳，登记正在查看的页面和状态：查看中、正在编辑（有未保存修改且 2 分钟内有输入）、有未保存修改（之后无输入）。顶栏显示在线账号与窗口数，展开可看每个窗口在哪个作品 / 系列 / 关于我们，以及“已登录但没有打开页面”的账号；75 秒无心跳显示为“连接中断”，3 分钟后不再显示。退出登录、会话过期或邮箱撤权后立即不再显示。编辑页和作品 / 系列列表会标出其他窗口正在查看或编辑的条目。统计单位是窗口和登录会话：同一邮箱的另一个窗口显示为“此浏览器的另一个窗口”或“同一账号在另一处登录”，不会推断是哪个人。

**及时看到别人的修改。** 保存成功后 Worker 在 D1 中记一条修改记录（不写入内容数据库，避免把后台邮箱暴露给小程序）。其他窗口随心跳取回：列表自动刷新；打开的编辑页若没有修改，直接载入最新内容，有修改则提示“查看最新内容并合并”。

**断线、过期与崩溃。** 保存失败（断网、冲突、文件缺失）时表单原样保留。登录过期时不卸载页面，而是在上方弹出登录框，重新登录后继续保存。有未保存修改时表单会备份到本机 `localStorage`，窗口被关闭或浏览器崩溃后重新打开可恢复；若期间云端已有新版本，恢复时同样进入合并流程。

**媒体文件延迟删除。** 保存或删除时不再立即删除云存储文件，而是把本次真正移除的文件（由服务端基于被覆盖的那个版本计算）放入 D1 回收列表，24 小时后（从未保存进内容的上传为 1 小时）由定时任务处理：先“认领”到期文件，再完整扫描 `portfolios`、`series`、`studio` 中的所有引用，仍被引用的文件放过，其余才删除。保存时若引用了回收列表中的文件，会先把它取回；若已被认领或已删除，保存被拒绝（`MISSING_FILES`），页面可一键从表单中移除这些文件。认领发生在扫描之前，所以“保存引用文件”与“删除文件”无论如何交错，都不会留下指向已删除文件的内容。

**系列删除。** 删除系列同样检查版本号，随后把所属作品的 `seriesId` 置空并把这些作品的版本号加 1，正在编辑这些作品的页面保存时会得到冲突而不是悄悄写回已删除的系列。保存作品时会检查所选系列仍存在，写入后再复查一次，覆盖“检查通过后系列恰好被删除”的情况。

## 云开发接口调研

需求是在网站上管理云开发中的数据和文件。可选方案对比如下：

| 方案 | 鉴权 | 数据库 | 文件上传 | 在 Workers 上的可行性 |
| --- | --- | --- | --- | --- |
| **微信服务端 API · 云开发**（`api.weixin.qq.com/tcb/*`，**本项目采用**） | AppID + AppSecret 换取 `access_token`（`cgi-bin/stable_token`） | `databasequery` / `databaseadd` / `databaseupdate` / `databasedelete` / `databasecount` | `uploadfile` 返回 COS 上传地址和签名，再以表单 POST 上传；`batchdownloadfile` 换临时链接；`batchdeletefile` 删除 | ✅ 纯 HTTPS + JSON，无需 SDK。是小程序云开发官方提供的服务端接口，与小程序使用的环境完全对应 |
| CloudBase HTTP API（`{envId}.api.tcloudbasegateway.com/v1/...`） | 控制台创建的 API Key（Bearer） | 提供文档型数据库、MySQL 等 REST 接口 | `/v1/storages/get-objects-upload-info` 等 | ⚠️ 新版接口，可用性取决于环境套餐和控制台是否开放 API Key；数据库路径需以官方 OpenAPI 文档为准。可作为后续选项 |
| `@cloudbase/node-sdk` / `wx-server-sdk` | 腾讯云 SecretId/SecretKey，或运行在云函数内 | SDK 方法 | SDK 方法 | ❌ 依赖 Node 运行时，在 Workers 中运行不稳定 |
| 新增一个管理用云函数，经 `tcb/invokecloudfunction` 调用 | 同第一种 | 云函数内用 SDK | 仍需 `uploadfile` | 可行，但要修改并部署小程序仓库的云函数 |
| 腾讯云 API 3.0（`tcb.tencentcloudapi.com`） | SecretId/SecretKey 签名 | 只有导入导出（`DatabaseMigrateImport` 等）等管理类接口，没有文档读写 | 无 | ❌ 不适合日常内容管理 |

本项目使用的接口如下（均为 `POST`，`access_token` 放在查询参数中，请求体都带 `env`）：

| 接口 | 用途 |
| --- | --- |
| `/cgi-bin/stable_token` | 换取稳定版调用凭证。有效期内重复获取返回同一凭证，不会使其他服务的凭证失效。Worker 实例内会缓存凭证 |
| `/tcb/databasequery`、`/tcb/databasecount` | 读取作品、系列、工作室信息；测试连接时统计各集合数量 |
| `/tcb/databaseadd`、`/tcb/databaseupdate`、`/tcb/databasedelete` | 新建、更新、删除文档。对象和数组字段用 `db.command.set()` 整体替换，日期用 `new Date(...)` 写入数据库日期类型 |
| `/tcb/uploadfile` | 获取上传地址与签名，再向返回的 COS 地址发送 `multipart/form-data`（`key`、`Signature`、`x-cos-security-token`、`x-cos-meta-fileid`、`file`），得到 `cloud://` 文件 ID |
| `/tcb/batchdownloadfile` | 把 `cloud://` 文件 ID 换成临时 https 链接，供后台预览 |
| `/tcb/batchdeletefile` | 删除作品或替换图片时清理文件。只允许删除当前环境中 `portfolios/`、`series/`、`studio/` 目录下的文件 |

数据库语句是字符串，例如 `db.collection("portfolios").where({...}).get()`。Worker 用 `worker/query.ts` 生成这些语句，所有用户输入都经过 JSON 转义，前端无法注入任意语句。另外，Worker 只开放与本后台业务相关的接口，不提供通用的数据库查询。

### 上传

- 选择文件后，浏览器先读取图片或视频的宽高（小程序瀑布流需要）和视频时长，再生成：
  - 图片：720px 宽的缩略图（`thumb`，供瀑布流使用）和平均色（封面占位底色 `cover.color`）；
  - 视频：首帧封面图（`poster`）。之后也可以单独更换封面帧。
- 文件按数据模型文档建议的目录存放：`portfolios/<作品ID>/<随机名>.<扩展名>`、`studio/profile/<随机名>.<扩展名>`。
- 两种上传方式可在设置页切换：
  - **经 Worker 中转**（默认）：不需要额外配置。受 Workers 请求体上限限制（免费版和 Pro 版 100 MB），单个文件不宜超过约 95 MB；
  - **浏览器直传云存储**：Worker 只负责签名，文件从浏览器直接上传到 COS，没有大小限制。需要在云开发控制台把后台域名加入安全域名 / 存储 CORS 白名单。
- 保存时会清理本次上传后又移除、没有被保存的文件，以及作品中被移除的文件（可取消勾选）。清理是延迟的，见「多人同时编辑」中的「媒体文件延迟删除」。

## 使用前准备

1. 小程序已开通云开发，并已按小程序仓库的 `docs/data-model.md` 创建 `portfolios`、`series`、`studio`、`users`、`likes` 集合。设置页「测试连接」会列出缺少的集合。
2. 在微信公众平台「开发管理 → 开发设置」获取 **AppSecret**。
3. **IP 白名单**：调用 `stable_token` 时，若小程序后台开启了「IP 白名单」，请求必须来自白名单中的 IP。Cloudflare Workers 的出口 IP 不固定，所以需要：
   - 关闭 IP 白名单；或
   - 在固定 IP 的服务器上部署一个转发服务（原样转发 `/cgi-bin/*` 与 `/tcb/*` 到 `https://api.weixin.qq.com`），并由部署者设置 Worker 的 `WECHAT_API_BASE` 与 `ALLOWED_API_HOSTS`。
4. 由部署者在 Cloudflare 配置下述变量与 Secret。用户打开后台只需使用已授权邮箱登录；登录后「设置」可测试连接和选择上传方式。

## 开发

```bash
npm install
npm run build         # 类型检查 + 构建前端到 dist/
npm test              # Worker 测试（认证、语句生成、输入校验、并发与故障场景）
npm run test:approval-browser # 使用本机 Chromium 验证真实审批表单与 CSRF Cookie
```

浏览器审批回归测试默认使用 `/usr/bin/chromium`，可用 `CHROMIUM_PATH` 指定其他 Chromium 可执行文件。测试只使用本地数据库和模拟邮箱，不会发送真实邮件。

本地联调（不连接真实微信环境）：

```bash
cp .dev.vars.example .dev.vars
npm run mock -- ../miniprogram-nanbei/database/seed
npx wrangler d1 migrations apply AUTH_DB --local
npm run dev:worker  # http://localhost:8787
# 手动触发一次文件清理任务：npx wrangler dev --test-scheduled 后访问 /__scheduled
```

使用 Vite 时，将 `.dev.vars` 中 `APP_ORIGIN` 设为实际浏览器地址（例如 `http://localhost:5173`），同时启动 Worker 时加 `--local-upstream localhost:5173 --upstream-protocol http`，以覆盖自定义域名的本地请求地址重写。代理会保留 Host 和 Origin。本地邮件绑定不会投递真实邮件。不要为方便调试加入认证绕过；认证自动化测试会使用真实 SQLite 执行与 D1 相同的 SQL，并捕获模拟邮件验证完整流程。修改前端可运行 `npm run dev`，Vite 的 `/api` 代理到 8787 端口。审批链接和 Secure Cookie 的完整浏览器联调应使用 HTTPS、与 `APP_ORIGIN` 相同的站点。

## 部署到 Cloudflare Workers

项目部署于 <https://photodesk.win>，Worker 名称为 `nanbei-admin`，位于 Cloudflare 账户 **Sanchai**（2026-10-26 从旧账户迁移，D1 `nanbei-admin-auth` 位于 APAC）。若登录的 Cloudflare 账号可访问多个账户，部署前请设置 `CLOUDFLARE_ACCOUNT_ID` 为 Sanchai 的账户 ID，避免部署到其他账户（定时清理任务只能在一个账户中运行，见 `wrangler.jsonc`）。

```bash
# 配置你自己的小程序 AppSecret（交互输入，不要写进仓库）：
npx wrangler secret put WECHAT_APP_SECRET
# 初次安装时生成至少 32 字符的随机 AUTH_SECRET，并通过交互输入：
npx wrangler secret put AUTH_SECRET
npx wrangler d1 migrations apply AUTH_DB --remote   # 升级时同样需要执行，以创建协作相关的表
npm run deploy
```

本次配置的普通变量已写入 `wrangler.jsonc`，部署时同步到 Cloudflare：

| 名称 | 配置值 / 用途 |
| --- | --- |
| `WECHAT_APP_ID` | `wx7f54ff074d26489f` |
| `CLOUDBASE_ENV_ID` | `cloud1-d4gbua7848fbcecf0` |
| `WECHAT_API_BASE` | `https://api.weixin.qq.com`，可改为固定 IP 转发服务 |
| `ALLOWED_API_HOSTS` | `api.weixin.qq.com`；使用转发服务时同步更改白名单 |
| `ADMIN_EMAIL` | `sanchai20@163.com`，审批邮件收件人；此邮箱可直接获取登录码 |
| `EMAIL_FROM` | `no-reply@auth.photodesk.win` |
| `APP_ORIGIN` | `https://photodesk.win`，审批链接与请求来源的可信站点 |

必须使用 **Secret** 的字段：

| 名称 | 用途 |
| --- | --- |
| `WECHAT_APP_SECRET` | 由部署者自行在 Cloudflare「Workers & Pages → nanbei-admin → Settings → Variables and Secrets → Add → Secret」填写小程序 AppSecret |
| `AUTH_SECRET` | 随机密钥，用于验证码 HMAC；不要使用 AppSecret 充当此密钥 |

定时任务：`wrangler.jsonc` 的 `triggers.crons` 每 30 分钟运行一次文件清理。

资源绑定：`AUTH_DB` 指向独立的 `nanbei-admin-auth` D1 数据库（也保存在线状态、修改记录和待删除文件）；`EMAIL` 是 Cloudflare Email Service 的 `send_email` 绑定。发信域名 `auth.photodesk.win` 需已开通 Email Sending，SPF、DKIM、DMARC 状态需正常。向任意已授权邮箱发送验证码需要账号具备 Email Sending 权限及额度。发信域名配置见 [Cloudflare 官方文档](https://developers.cloudflare.com/email-service/get-started/send-emails/)。

### 如何授权

1. 对方打开网站，选择「申请访问权限」，填写邮箱并提交。
2. 你在 `sanchai20@163.com` 收到申请邮件。点击 **Approve** 或 **Reject**，在打开的页面确认。仅查看邮件或打开链接不会改变权限。
3. 批准后，对方使用相同邮箱点击发送登录码，查收并填写 6 位码即可登录。未批准或被拒绝的邮箱不会收到登录码。
4. 退出会使当前会话失效。每次业务请求仍会检查邮箱是否保持批准状态。

如需撤销已批准邮箱，可在 Cloudflare D1 控制台对 `nanbei-admin-auth` 执行下列 SQL（替换邮箱，并保持小写）：

```sql
UPDATE auth_users SET status = 'rejected' WHERE email = 'member@example.com';
DELETE FROM auth_sessions WHERE email = 'member@example.com';
```

撤权后现有会话无法继续调用后台接口。旧的 `ADMIN_TOKEN` 与浏览器配置请求头不再提供访问权限。

## 目录结构

```text
├── worker/
│   ├── index.ts          # 路由、会话校验、业务接口
│   ├── config.ts         # 读取服务端云开发配置
│   ├── auth.ts           # 邮箱申请、审批、验证码与会话
│   ├── collab-store.ts   # 在线状态、修改记录、文件回收列表（D1）
│   ├── collab.test.ts    # 并发保存、删除、媒体清理、在线状态等场景测试
│   ├── env.d.ts          # Wrangler 生成的绑定类型
│   ├── wechat.ts         # 微信云开发 HTTP API 客户端（凭证缓存、数据库、存储）
│   ├── query.ts          # 数据库语句生成（安全转义）
│   └── query.test.ts
├── shared/
│   ├── types.ts          # 与小程序数据模型一致的类型
│   ├── normalize.ts      # 输入校验与文档整理（Worker 与前端共用）
│   └── merge.ts          # 冲突时的字段级三方合并
├── src/
│   ├── App.tsx           # 登录状态、顶栏与路由
│   ├── pages/            # 邮箱登录、设置、作品列表、作品编辑、系列、关于我们
│   ├── preview/          # 小程序页面复刻（手机框、瀑布流、相册、发现、关于）
│   └── lib/              # 上传偏好、API 调用、上传与媒体处理
├── migrations/           # D1 认证数据库迁移
├── public/icons/         # 来自小程序仓库的线性图标
└── scripts/mock-wechat.mjs
```

## 已知限制

- 预览中的页面是网页复刻，与真机可能有细微差异（如字体渲染、安全区高度）。
- 后台不读取 `content` 云函数中的 `THUMB_QUERY` / `VIEW_QUERY` 环境变量，预览始终显示原图或上传时生成的缩略图。
- 冲突合并按字段进行：例如双方都修改了「图片与视频」，需要整体选择一份（之后可在表单中继续调整），不做列表内逐项合并；也不提供多人实时协同输入。
- 版本号条件写入（`where({_id, rev}).update()`、`db.command.exists`、`db.command.inc`）已在本地模拟服务中按真实语法测试；首次部署后建议在测试环境中用两个窗口验证一次冲突提示。
- 引用扫描只覆盖 `portfolios`、`series`、`studio`。如果小程序在其他集合（例如收藏记录）中保存了图片地址的副本，删除作品文件后这些副本同样会失效（与以前一致）。
