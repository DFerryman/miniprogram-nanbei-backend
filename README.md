# 南北摄影 · 内容管理后台

南北摄影工作室小程序（[DFerryman/miniprogram-nanbei](https://github.com/DFerryman/miniprogram-nanbei)）的网页管理后台，部署在 **Cloudflare Workers** 上。它直接读写小程序所用的微信云开发（CloudBase）环境：

- **作品**：浏览当前环境的全部作品；新建作品并上传图片、视频；编辑标题、说明、拍摄日期、地点、系列、标签、排序权重和发布状态；调整媒体顺序、指定封面；删除作品，可同时清理云存储文件。
- **系列**：新建、编辑、删除作品系列（小程序「作品」页顶部的筛选栏）。
- **关于我们**：编辑工作室名称、标语、封面、介绍、附加板块、地址、营业时间、地图坐标和联系方式（电话、微信、企业微信、小红书、抖音、微博、邮箱、链接，可上传二维码）。
- **小程序预览**：编辑页右侧用 375pt 宽的手机框复刻小程序页面：作品瀑布流、作品相册（单列 / 双列）、发现页全屏浏览、关于页（含联系方式弹出面板）。尺寸、字号和排序规则都取自小程序源码，修改实时生效，保存前就能看到效果。

后台的数据结构与小程序仓库的 `docs/data-model.md` 一致，不需要修改小程序或云函数。

## 工作原理

```text
浏览器（React 单页应用）
  │  连接配置保存在本浏览器，随请求头 X-CloudBase-Config 发送
  ▼
Cloudflare Worker（/api/*，worker/index.ts）
  │  校验输入 → 生成数据库语句 → 调用微信服务端 API
  ▼
微信云开发 HTTP API（api.weixin.qq.com/tcb/*）
  ├─ 云数据库：portfolios / series / studio
  └─ 云存储：portfolios/<作品ID>/…、studio/profile/…
```

- 静态页面由 Workers Static Assets 提供，`/api/*` 由 Worker 处理。
- **Worker 不保存任何配置或数据**。环境 ID、AppID、AppSecret 都在设置页填写，存在浏览器中。勾选「记住」时存入 localStorage，否则只存 sessionStorage，关闭标签页即清除。可以保存多个环境并随时切换。
- 小程序的 `stats`（点赞 / 收藏 / 分享计数）由 `user` 云函数维护，后台更新作品时不写这个字段，避免覆盖并发产生的计数。

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
- 保存时会自动删除本次上传后又移除、没有被保存的文件，以及作品中被移除的文件（可取消勾选）。

## 使用前准备

1. 小程序已开通云开发，并已按小程序仓库的 `docs/data-model.md` 创建 `portfolios`、`series`、`studio`、`users`、`likes` 集合。设置页「测试连接」会列出缺少的集合。
2. 在微信公众平台「开发管理 → 开发设置」获取 **AppSecret**。
3. **IP 白名单**：调用 `stable_token` 时，若小程序后台开启了「IP 白名单」，请求必须来自白名单中的 IP。Cloudflare Workers 的出口 IP 不固定，所以需要：
   - 关闭 IP 白名单；或
   - 在固定 IP 的服务器上部署一个转发服务（原样转发 `/cgi-bin/*` 与 `/tcb/*` 到 `https://api.weixin.qq.com`），并在设置页把「接口地址」填为该服务地址。
4. 首次打开后台会进入设置页，填写接口地址、环境 ID、AppID、AppSecret，测试连接成功后进入后台。右上角可随时切换或修改环境。

## 开发

```bash
npm install
npm run build         # 类型检查 + 构建前端到 dist/
npm test              # Worker 单元测试（语句生成、输入校验）
```

本地联调（不连接真实环境）：

```bash
cp .dev.vars.example .dev.vars                      # 允许 http://127.0.0.1 接口地址
npm run mock -- ../miniprogram-nanbei/database/seed # 模拟微信云开发 API，可导入小程序仓库的示例数据
npm run build && npx wrangler dev                   # http://127.0.0.1:8787
# 设置页接口地址填 http://127.0.0.1:8790，AppID 与 AppSecret 填任意格式正确的值
```

`scripts/mock-wechat.mjs` 在沙箱中按 JS 语法执行 Worker 生成的数据库语句，并用内存保存上传的文件，可以检查完整的读写与上传流程。修改前端时可以另开终端运行 `npm run dev`（Vite 热更新，`/api` 代理到 8787 端口）。

## 部署到 Cloudflare Workers

```bash
npx wrangler login
npm run deploy        # 构建并发布，配置见 wrangler.jsonc
```

可选的 Worker 设置（都不写进仓库）：

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `ADMIN_TOKEN` | Secret（`npx wrangler secret put ADMIN_TOKEN`） | 设置后，所有 `/api` 请求都要带相同的访问口令（在设置页填写）。**强烈建议设置**，否则任何知道网址的人都可以把这个 Worker 当作转发服务使用（但仍需要自己的 AppSecret） |
| `ALLOWED_API_HOSTS` | 变量 | 限制可转发的接口主机名，逗号分隔，例如 `api.weixin.qq.com`。未设置时允许任意 https 地址 |

也建议使用 Cloudflare Access 等方式，把后台域名限制为工作室成员访问。

## 目录结构

```text
├── worker/
│   ├── index.ts          # 路由、配置校验、业务接口
│   ├── wechat.ts         # 微信云开发 HTTP API 客户端（凭证缓存、数据库、存储）
│   ├── query.ts          # 数据库语句生成（安全转义）
│   └── query.test.ts
├── shared/
│   ├── types.ts          # 与小程序数据模型一致的类型
│   └── normalize.ts      # 输入校验与文档整理（Worker 与前端共用）
├── src/
│   ├── App.tsx           # 顶栏与路由
│   ├── pages/            # 设置、作品列表、作品编辑、系列、关于我们
│   ├── preview/          # 小程序页面复刻（手机框、瀑布流、相册、发现、关于）
│   └── lib/              # 配置存储、API 调用、上传与媒体处理
├── public/icons/         # 来自小程序仓库的线性图标
└── scripts/mock-wechat.mjs
```

## 已知限制

- 预览中的页面是网页复刻，与真机可能有细微差异（如字体渲染、安全区高度）。
- 后台不读取 `content` 云函数中的 `THUMB_QUERY` / `VIEW_QUERY` 环境变量，预览始终显示原图或上传时生成的缩略图。
- 多人同时编辑同一作品时，后保存的会覆盖先保存的（互动计数除外）。
