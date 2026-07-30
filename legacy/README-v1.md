> **这是 v1 的说明，留档用。**
>
> v1（`watch.py` + `channels.py` + `worker/worker.js` + GitHub Actions cron）此刻**仍在运行**，
> 文件都还在仓库根目录，一个字没动。
> v2 部署验收通过后，再按 `DEPLOY.md` 第 7 步停掉它 —— 顺序反了会出现监控真空。
> 当前方案看根目录的 `README.md`。

---

# BIGBANG 香港站票务监控（v1）

每 15 分钟自动检查，一有动静就在本仓库开 Issue 并 @你 —— GitHub 会把邮件发到 `yuezemaoyi@gmail.com`。
**跑在 GitHub 服务器上，你电脑不用开机，不需要配置任何邮箱。**

已部署完成，正在运行。你不需要再做任何操作。

---

## 监控什么

| 源 | 监控点 | 告警 |
|---|---|---|
| **YG 官方巡演页** | `HONG KONG` 行的 `COMING SOON` → `GET TICKETS`；开演时间从 `11.13.(FRI) - 15.(SUN)` 变成具体钟点 | 🔴 附购票链接、详情页、各场开演时间 |
| **b.stage `/tag/SURVEY`** | 出现标题含 `HONG KONG` / `KAI TAK` 的 SURVEY；或该 SURVEY 从「未开放」变「开放中」 | 🔴 附**登记窗口起止时间（已转北京时间+星期）** |
| **b.stage `/tag/NOTICE`** | 出现含香港的票务公告 | 🔴 |
| **b.stage `sitemap.xml`** | 新页面出现 | 🟡 附可点击的 `/surveys/<id>` 链接 |

其他城市的 SURVEY 出现时只发 🟡（让你知道脚本活着，也能提前看到别站的时间规律）。

### 为什么能不用浏览器就抓到 b.stage

b.stage 是 Next.js 前端应用，普通 `curl` 抓首页拿不到内容。但：

- `/tag/SURVEY` 是**服务端渲染**的，全部条目就在 HTML 的 `__NEXT_DATA__` JSON 里
- 那份 JSON 里有 `title`、`inProgress`、`progressStartAt`、`progressEndAt` —— 所以能直接告诉你**登记窗口几点开到几点、现在是否开放**
- `sitemap.xml` 是纯 XML，能补上可点击的真实链接

所以整套只用 Python 标准库，塞进免费的 GitHub Actions 里跑。

---

## 提醒怎么送到邮箱

两条**互相独立**的通道，不依赖任何 SMTP 配置：

1. **GitHub Issue + @提及** —— Actions 用内置 `GITHUB_TOKEN` 开 issue 并 @你。@提及一定会产生通知，仓库也已显式设为 Watching。
2. **workflow 失败通知** —— 检测到 🔴 时脚本会故意让 job 变红（`FAIL_ON_CRITICAL=1`），GitHub 另发一封「workflow failed」邮件。因为有去重，同一件事只会红一次。

已验证：Issue #1（测试）、Issue #2（基线）均成功创建。

### 可选：额外再发一封自己的 SMTP 邮件

不需要，但如果你以后想加，在 Settings → Secrets and variables → Actions 里加：
`SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `MAIL_TO`。
Gmail 需先开两步验证再生成「应用专用密码」（16 位），不能用登录密码。

---

## 你会收到什么

```
标题：🔴 BIGBANG HONG KONG 有动静了（2 条重要）

🔴 [CRITICAL] b.stage 新 SURVEY（命中 HONG KONG！）
[HONG KONG] BIGBANG V.I.P MEMBERSHIP PRESALE SURVEY FOR ... IN HONG KONG
登记窗口: 2026-08-06 10:00 CST（周四）  ->  2026-08-10 01:00 CST（周一）
现在是否开放: ✅ 开放中
https://bigbang.bstage.in/tag/SURVEY

🔴 [CRITICAL] HONG KONG 票务开了！COMING SOON 消失了
购票链接: https://premier.hkticketing.com/...
场次时间: 2026.11.13.(FRI) 8:00PM / 11.14.(SAT) 6:00PM / 11.15.(SUN) 6:00PM

--- 收到这封邮件后立刻做 ---
1. 打开 https://bigbang.bstage.in/tag/SURVEY 完成 [HONG KONG] SURVEY 登记
   （窗口通常只有 3-5 天，不登记 = 会员码作废，进不了优先购）
2. 记下会员优先购 / 公开发售的日期时间，马上设手机闹钟
3. 注册香港票务平台账号，做完手机+邮箱验证，绑好 Visa/Master 并小额试刷
4. 查取票方式：如果要当天中午前取实体票，深圳往返行程要相应调整
5. 准备好所有人的港澳通行证号（实名制，买票后改不了名）
```

---

## 手动操作

仓库 → **Actions** → 左侧 `BIGBANG HK watch` → **Run workflow**：

| mode | 作用 |
|---|---|
| 留空 | 正常检查一次 |
| `test` | 发一条测试提醒，验证邮件链路 |
| `reset` | 清空基线重新开始（会重新发一次"已启动"提醒） |

---

## 本地跑（可选）

```bash
python3 watch.py --dry-run   # 只检查，不发通知不写状态
python3 watch.py             # 正常跑
```
只用标准库，Python 3.8+ 即可，不用 `pip install`。

---

## 已知限制

1. **GitHub cron 是尽力而为**，高峰可能延迟 5–20 分钟。对"公告出现"（窗口 3–5 天）完全够用；但**抢票那一刻不要靠它**，拿到日期后自己设手机闹钟。
2. **邮件可能进 Gmail 的「促销」或垃圾箱**。去把 `notifications@github.com` 加到通讯录/白名单。
3. **超 60 天无提交，GitHub 会自动停掉 schedule** —— 脚本每天提交一次 `last-check.txt` 心跳规避。
4. **网页结构变了会失效** —— 抓不到 `HONG KONG` 那一行或 `__NEXT_DATA__` 时会发「⚠️ 抓取异常」提醒，不会默默死掉。

---

## 脚本管不了的事，去日历上设死

| 日期 | 事项 |
|---|---|
| **2026-08-25** | ⚠️ **6th V.I.P 会员报名 8/31 截止**，最后确认已入会 |
| 2026-08-28 | 曼谷站会员优先购（香港的备选方案，票价更低） |
| 2026-08-30 | 曼谷站公开发售 |
| 2026-09-01 起 | 香港站优先购/公售高发期 |

再加一层零成本冗余：`google.com/alerts` 建 `BIGBANG 香港 門票`、`BIGBANG 啟德 開售`，频率选「有结果时」。港媒常在官宣后几分钟出稿，有时比 YG 官网更新还早。

---

## 多用户订阅（v3）

`channels.py` 是多通道分发器。**配了环境变量的通道才启用，没配的自动跳过**，
任一通道失败不影响其他通道。

### 通道与所需配置

| 通道 | 配置位置 | 变量 | 一对多 |
|---|---|---|---|
| ntfy 主题 | Variables | `NTFY_TOPIC` | ✅ 用户零注册 |
| 微信 PushPlus | Secrets + Variables | `PUSHPLUS_TOKEN` `PUSHPLUS_GROUP` | ✅ 群组推送 |
| Telegram | Secrets + Variables | `TG_BOT_TOKEN` `TG_CHAT_ID` | ✅ 频道 |
| GitHub Issue | 内置 | 无需配置 | ❌ 仅自己 |
| 邮件 Resend | Secrets + Variables | `RESEND_KEY` `MAIL_FROM` | ⚠️ 需自有域名 |
| 邮件 SMTP | Secrets | `SMTP_HOST/PORT/USER/PASS` | ❌ 只适合发自己 |

设置路径：仓库 → Settings → Secrets and variables → Actions
（密钥放 **Secrets**，非敏感值放 **Variables**）

### 最省事的开法（2 分钟，零成本）

只加一个 **Variable**：`NTFY_TOPIC` = 一个别人猜不到的名字，例如 `bigbang-hk-x7q2`。
然后让任何人在 ntfy App 或 `https://ntfy.sh/<你的topic>` 订阅该主题即可。
无需注册、无需域名、系统级推送、秒级到达。

> 注意：ntfy 主题是公开的，知道名字的人都能订阅**也能发消息**。
> 用于「广播开票提醒」没问题，别放任何私密内容。

### 邮件订阅者名单

三个来源自动合并去重：

1. `MAIL_TO`（Variables，逗号分隔）—— 一般就是你自己
2. `subscribers.txt`（仓库里，一行一个邮箱，`#` 注释）
3. `SUBSCRIBERS_CSV_URL`（Variables）—— Google 表单结果表「发布到网络 → CSV」的链接

这样收集订阅**不需要任何后端**：Google 表单收邮箱 → 发布为 CSV → Actions 每次运行时拉取。

### 订阅落地页

`docs/index.html` 是静态订阅页。启用方法：
Settings → Pages → Source 选 `main` 分支 `/docs` 目录 → 保存。
几分钟后可访问 `https://<用户名>.github.io/bigbang-watch/`。

页面里 `FORM_URL` 变量填上 Google 表单链接后，邮箱订阅按钮才会启用；
留空时按钮自动置灰，引导用户用微信或 ntfy。

### 单独测试通道

```bash
NTFY_TOPIC=你的topic python3 channels.py
```

收到一条「通道自检」推送即为成功。

### 关于邮件的实话

个人 Gmail / QQ 邮箱**不要用来群发陌生人**：每天 500 封上限、必进垃圾箱、账号有封禁风险。
邮件要真的能送达，最低门槛是**自有域名 + SPF/DKIM/DMARC + 正规 ESP**（域名约 ¥70/年）。
即便全配好，进主收件箱的比例也只有 60–85%。
微信推送和 ntfy 是 ~99%，且是推送不是邮件——所以本项目把邮件当兜底，不当主通道。

---

## 订阅前端（Cloudflare Worker）

**订阅地址：https://bigbang-hk.yuezemaoyi.workers.dev/**

粉丝打开就能订阅，三种方式：手机推送（ntfy，现在就能用）、微信（需先配 PushPlus 二维码）、邮箱。
名单存在 Cloudflare KV，GitHub Actions 每次运行时自动拉取。

源码在 `worker/worker.js`，单文件无构建。

### 路由

| 路由 | 权限 | 用途 |
|---|---|---|
| `GET /` | 公开 | 订阅页 |
| `GET /api/stats` | 公开 | 订阅人数（页面社会证明用） |
| `POST /api/subscribe` | 公开 | 提交订阅，幂等，同 IP 20 次/10 分钟 |
| `GET /u/<token>` | 公开 | 一键退订 |
| `GET /api/subscribers` | 需 ADMIN_KEY | 导出名单 `?format=json\|csv\|emails` |
| `POST /api/broadcast` | 需 ADMIN_KEY | 转发到 ntfy 广播 |

### 拿自己的订阅名单

```bash
# CSV（含微信号、城市、地区、订阅时间）
curl -H "Authorization: Bearer <ADMIN_KEY>" \
  "https://bigbang-hk.yuezemaoyi.workers.dev/api/subscribers?format=csv" -o subs.csv
```

### 重新部署 Worker

```bash
npx wrangler deploy worker/worker.js --name bigbang-hk \
  --compatibility-date 2025-01-01 \
  --kv-namespace SUBS=<KV_ID>
```
或用 Cloudflare API 直接 PUT `/accounts/<acc>/workers/scripts/bigbang-hk`（本项目用的是这条）。

### 想开微信通道

1. 到 https://www.pushplus.plus 微信扫码登录，拿 token
2. 建一个「一对多群组」，拿群组编码，把群组二维码图片传到任意图床
3. Worker 加 plain_text 绑定 `PUSHPLUS_QR`=二维码图片地址
4. 仓库加 Secret `PUSHPLUS_TOKEN`、Variable `PUSHPLUS_GROUP`

配好后订阅页的「微信」会自动变成默认 tab。

### 关于微信号

微信官方**没有**任何接口允许凭微信号给陌生人发消息。页面上收集微信号只是联系资料，
真正能推到微信的只有「用户主动关注服务号」这一条路。别把微信号当投递通道。
