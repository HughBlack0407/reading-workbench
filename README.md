# 读书笔记工作台

> 当前状态（2026-11-05）：[公开网页](https://hughblack0407.github.io/reading-workbench/) 已启用。书架、划线、统计和笔记以密文存储，打开网页后输入本机设定的口令解锁；电脑端编辑笔记还需在“设置”中配置仅授权本仓库的写回令牌。

一个零构建的静态网页，用来查看微信读书同步过来的书架、划线、想法与阅读统计，并撰写自己的读书笔记。电脑端可编辑，手机端只读查看。页面托管在 GitHub Pages，数据以密文形式存放在同一个 GitHub 仓库。

## 它怎么工作

```
本机脚本 → 微信读书官方网关 → 本机加密 → git push → GitHub 仓库（只有密文）
                                                    ↓
                              浏览器页面 ← GitHub contents API ← 口令本地解密
```

参考的发布方式是「本地生成静态文件 → `git push` → GitHub Pages 自动部署」。与纯只读展示页的差别在于：这里额外用 GitHub contents API 做读写，并把所有内容在入库前加密。

- 页面：`index.html` / `app.js` / `style.css` / `crypto-web.js`，原生 HTML、CSS、JS，无框架、无 CDN、无构建。
- 数据：`data/sync/*.enc` 由本机脚本写入且只读；`data/notes/notes.enc` 由页面写入。两者永不互相覆盖。
- 加密：PBKDF2-HMAC-SHA256 600,000 迭代（OWASP 推荐值）派生 AES-GCM-256 密钥，每次加密使用新的 12 字节 IV、128 位认证标签（NIST SP 800-38D / MDN `AesGcmParams`）。密文格式为自包含 JSON，含版本、salt、IV 与附加认证数据。
- 写回：`PUT /repos/{owner}/{repo}/contents/{path}` 必带 `sha`，409 冲突不自动重试、不静默覆盖。

## 首次部署

前置条件：

1. 一个 **public** GitHub 仓库，`main` 分支根目录开启 Pages（Settings → Pages → Deploy from a branch → main / root）。GitHub Free 的 Pages 只支持 public 仓库，且 Pages 站点始终公开可见。
2. 本机有 `WEREAD_API_KEY`（微信读书官方 Agent Skill 的 `wrk-` Key），Node.js 22 及以上。
3. 本机 git 已配置 `user.name` / `user.email`，且具备该仓库的推送凭据。
4. 一枚 **fine-grained PAT**：仅授权这一个仓库，权限 `Contents: Read and write`，设置有效期。只在电脑端浏览器里填入，不写入仓库。
5. 自定一个至少 12 字符的加密口令，并自行保管。

命令顺序：

本目录就是待推送的仓库。先在 GitHub 建好空 public 仓库，然后：

```bash
cd reading-workbench
git init -b main
git remote add origin https://github.com/<owner>/<repo>.git
git config user.name "<你的名字>"
git config user.email "<你的邮箱>"

git add index.html app.js style.css crypto-web.js scripts/ README.md .gitignore .nojekyll
git commit -m "init: workbench app shell"
git push -u origin main

node scripts/init_vault.mjs           # 交互输入两次口令，生成 vault.meta.json 和空笔记库
git add vault.meta.json data/notes/notes.enc
git commit -m "init: vault"
git push

node scripts/sync_weread.mjs --push  # 输入同一口令，拉取数据、加密、自行提交并推送
```

同步脚本只会 `git add -- data/sync`，不会触碰 `data/notes/`。首次推送后在仓库 Settings → Pages 选择 `main / (root)` 开启 Pages。

打开 `https://<owner>.github.io/<repo>/`：

- 打开本仓库 Pages 时只需输入口令解锁。若改用其他地址部署，可在页面上手动填写仓库所有者、仓库名和分支。解锁后默认是**只读模式**，手机端保持这样即可。
- 电脑端如要编辑：设置 → 写回令牌 → 填入 fine-grained PAT → 保存并切换为可编辑。令牌会用口令加密后只存在这台设备的浏览器里。

Pages 在 push 后最多需要 10 分钟生效（GitHub 官方文档）。页面读数据走 `api.github.com`，不受这个延迟影响；只有改了页面文件本身才需要等部署。

## 日常使用

```bash
node scripts/sync_weread.mjs --push     # 更新书架、划线、统计
node scripts/sync_weread.mjs --dry-run  # 只验证接口与统计口径，不写任何文件
node scripts/selftest_crypto.mjs        # Node 与浏览器加密实现的互操作回归测试
node scripts/selftest_data.mjs --dir .  # 校验已生成的密文与统计口径
```

同步脚本默认只对最近 8 本书取进度、对最近 10 本有笔记的书取划线与想法，请求间隔 300 毫秒，避免高频触发风控。可用 `--max-books`、`--max-note-books`、`--throttle-ms` 调整。

写笔记：电脑端「我的笔记」→ 新建或编辑 → 保存（或 `Ctrl/Cmd+S`）。每次保存向仓库提交一次变更。未保存的内容会加密暂存在本机浏览器，刷新后可恢复。

手机只读：不填 PAT 即可，页面自动隐藏所有编辑入口。遇到 API 限流（未认证 60 次/小时，认证 5000 次/小时，见 GitHub REST 限流文档）时会自动回退到 Pages 同域读取密文，此时数据可能滞后一次部署，界面会标注。

## 数据口径

页面上的每个统计数字都标注了原始接口与字段，口径不混用、不互相推算。以下定义来自本机安装的微信读书官方 skill 文档（`~/.workbuddy/skills/weread-skills/`）：

| 指标 | 定义 | 来源 |
|---|---|---|
| 阅读时长 | `/readdata/detail` 的 `totalReadTime`，单位秒 | `readdata.md` L26 |
| 按日明细 | `/readdata/detail` 的 `readTimes` 分桶，仅作明细，**不替代** `totalReadTime` | `readdata.md` L23、L98 |
| 笔记数 | `reviewCount + noteCount + bookmarkCount` | `notes.md` L5、L274 |
| `noteCount` | 划线/高亮原文条数，**不是**单本书总笔记数 | `notes.md` L39 |
| 书架条目 | `books.length + albums.length + (mp 非空 ? 1 : 0)` | `shelf.md` L61 |
| 阅读进度 | `/book/getprogress` 的 `book.progress`，0–100 整数，1 表示 1%，仅 100 代表读完 | `book.md` L78 |
| 分页 | `/user/notebooks` 用 `count` + `lastSort` 游标，参数平铺 body 顶层，禁止 `params` 嵌套或 `offset`/`limit` | `notes.md` L44–L50、`SKILL.md` L58–L76 |

所有 Unix 时间戳在页面上转为 `YYYY-MM-DD` 展示，阅读时长由秒转为「X 小时 Y 分钟」。

同步脚本每次请求都带 `skill_version`（当前 `1.0.5`）。若网关回包出现 `upgrade_info`，脚本会立即暂停并提示按官方指引升级，之后需更新 `scripts/config.mjs` 的 `SKILL_VERSION` 再重跑（依据 `SKILL.md` L86）。

## 安全边界

**这套方案保护的是内容机密性，不是访问权限。**

- 页面与仓库公开。任何人都能打开页面、下载全部密文，并看到文件名、提交时间、文件大小和 commit message。没有口令则读不到内容。
- 「解锁」是本地解密，没有服务端账号、会话或鉴权。口令不上传、不落盘、不由任何脚本代存；忘记口令无法恢复。
- 写回令牌必然暴露在浏览器运行时。已通过「只在电脑端配置、单仓库权限、短有效期、用口令加密后存储」降低风险，但拿到已解锁设备的人、恶意浏览器扩展或页面脚本注入仍可能读到内存中的密钥与令牌。
- 密文可被下载用于离线暴力破解，强口令与 600,000 迭代是唯一防线。
- 明文导出备份包含全部已解密内容，请离线保管。

一句话：这是「把公开仓库当加密网盘」，不是「私有应用」。

## 文件说明

| 路径 | 说明 |
|---|---|
| `vault.meta.json` | 明文。版本、KDF 参数、salt、口令校验块。不含口令或密钥，需提交 |
| `data/sync/*.enc` | 密文。书架、划线想法、统计、同步元信息。仅由 `sync_weread.mjs` 写入 |
| `data/sync/manifest.json` | 明文索引。固定文件名和同步时间，不含书名及统计数量 |
| `data/notes/notes.enc` | 密文。全部用户笔记聚合成单文件，仅由页面写入 |
| `scripts/crypto.mjs` | Node 侧加密实现 |
| `crypto-web.js` | 浏览器侧 Web Crypto 实现，与 Node 侧字节级兼容 |
| `scripts/init_vault.mjs` | 一次性初始化，生成 vault 与空笔记库 |
| `scripts/sync_weread.mjs` | 微信读书数据同步 |
| `scripts/config.mjs` | 非密常量（网关地址、skill 版本、口径说明） |

`notes.enc` 单文件须小于 1MB（GitHub contents API 的全功能上限，见官方 contents 文档）；接近 800KB 时页面会提示先导出备份再拆分。

## 故障排查

| 现象 | 处理 |
|---|---|
| 页面提示未找到 `vault.meta.json` | 先运行 `node scripts/init_vault.mjs` 并提交该文件 |
| 口令无法解密 | 口令与初始化时不一致；重新输入。数据不可通过其他方式恢复 |
| 401 / 403 | 令牌失效或权限不足，检查 fine-grained PAT 的 `Contents: Read and write` |
| 429 | 触发限流，按页面提示的配额重置时间等待，或配置只读令牌 |
| 409 冲突 | 云端内容已在别处更新，点「重新加载」后再编辑；不会自动覆盖 |
| 同步提示升级 skill | 按 `upgrade_info.message` 升级官方 skill，更新 `SKILL_VERSION` 后重跑 |
| 手机看到的是旧数据 | 可能走了同域兜底路径；等待 Pages 部署完成或稍后刷新 |

## 首版明确不做

自定义 GitHub Actions / 无人值守定时同步（那会迫使加密口令交给 GitHub）；云 BaaS、服务端、Serverless 代理、OAuth 登录；CDN、第三方 JS、框架、构建工具；完整 GFM、表格、代码高亮、图片附件；服务端检索与密文索引；多用户、分享、评论、协同编辑；恢复密钥、口令找回；击键自动保存、自动合并冲突；永久免输口令；微信读书写回。
