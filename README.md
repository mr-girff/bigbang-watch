# BIGBANG 香港站票务监控 · 部署说明

15 分钟检查一次，一有动静就发邮件到你邮箱。跑在 GitHub 的服务器上，**你电脑不用开机**，全程免费。

## 它到底在监控什么

| 源 | 监控点 | 触发的告警 |
|---|---|---|
| YG 官方巡演页（服务端渲染，纯 HTTP 可读） | `HONG KONG` 那一行的 `COMING SOON` → `GET TICKETS`；开演时间从 `11.13.(FRI) - 15.(SUN)` 变成具体钟点 | 🔴 附上购票链接、详情页、各场开演时间 |
| b.stage `sitemap.xml`（纯 XML） | 新的 `/surveys/<id>` 或 `/contents/<id>` 出现，再去抓那一页的 `<title>` 拿到城市名 | 标题含 HONG KONG / KAI TAK → 🔴；其他城市 → 🟡 |

为什么不直接爬 b.stage 页面：它是 Next.js 前端渲染，`curl` 拿不到内容。但它的 **sitemap.xml 是纯 XML**，而每个 survey 页的 **`<title>` 是服务端渲染的** —— 所以走 sitemap → 逐个读 title 这条路，不需要浏览器，也就能塞进 GitHub Actions 里免费跑。

**为什么盯 YG 官网就够**：实测 Bangkok（11/7）和 Sydney（10/31）都是「YG 页面更新」和「b.stage SURVEY 开放」同一天发生。两个源互为备份。

---

## 部署（大约 10 分钟）

### 第 1 步：拿邮箱授权码

以 QQ 邮箱为例（网易 163 同理）：

1. 登录 QQ 邮箱网页版 → 设置 → 账户
2. 找到「IMAP/SMTP 服务」→ 开启
3. 按提示发短信验证 → 拿到一串 **16 位授权码**

⚠️ 授权码 ≠ QQ 登录密码。SMTP 只认授权码。

| 邮箱 | SMTP_HOST | SMTP_PORT |
|---|---|---|
| QQ 邮箱 | `smtp.qq.com` | `465` |
| 163 邮箱 | `smtp.163.com` | `465` |
| Gmail | `smtp.gmail.com` | `465`（需开两步验证后生成「应用专用密码」） |
| Outlook | `smtp-mail.outlook.com` | `587` |

### 第 2 步：建仓库

**建成 Public（公开）仓库。** 公开仓库的 Actions 时长无限免费；私有仓库每月只有 2000 分钟，每 15 分钟跑一次会超。
state.json 里没有任何隐私，SMTP 密码存在 Secrets 里（加密，公开仓库也看不到）。

仓库里放两个文件：

```
watch.py                              <- 直接用
.github/workflows/bigbang-watch.yml   <- 把 workflow-bigbang-watch.yml 改名放到这个路径
```

### 第 3 步：填 Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret，加 5 个：

| Name | Value |
|---|---|
| `SMTP_HOST` | `smtp.qq.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | 你的邮箱地址，例 `12345@qq.com` |
| `SMTP_PASS` | 第 1 步拿到的 16 位授权码 |
| `MAIL_TO` | 收件邮箱，多个用英文逗号分隔 |

### 第 4 步：开 Actions 并验证

1. 仓库 → Actions 标签 → 如提示则点 `I understand my workflows, enable them`
2. 左侧选 `BIGBANG HK watch` → `Run workflow`，**mode 填 `test`** → 跑一次
3. **检查邮箱是否收到「[测试] BIGBANG 监控脚本正常」** —— 收到才算配好，顺便去垃圾箱确认一下并把发件人加白名单
4. 再 `Run workflow` 一次，mode 留空 → 会建立基线并发一封「已启动」邮件
5. 之后就自动跑，**只在有变化时才发邮件**

---

## 你会收到什么样的邮件

```
主题：🔴 BIGBANG HONG KONG 有动静了（1 条重要）

检查时间：2026-08-06 10:15:03 CST
监控城市：HONG KONG

🔴 [CRITICAL] HONG KONG 票务开了！COMING SOON 消失了
购票链接: https://premier.hkticketing.com/bigbang
详情页:   https://bigbang.bstage.in/contents/xxxxxxxx
场次时间: 2026.11.13.(FRI) 8:00PM / 11.14.(SAT) 6:00PM / 11.15.(SUN) 6:00PM

--- 现在就去做 ---
1. 打开 b.stage 完成 [HONG KONG] SURVEY 登记（窗口只有 3-5 天）
2. 记下会员优先购 / 公开发售的日期时间，设闹钟
3. 注册香港票务平台账号，做完手机+邮箱验证，绑好 Visa/Master 并试刷
4. 查取票方式：如需当天中午前取实体票，行程要相应调整
```

---

## 本地跑（可选）

```bash
export SMTP_HOST=smtp.qq.com SMTP_PORT=465 \
       SMTP_USER=you@qq.com SMTP_PASS=授权码 MAIL_TO=you@qq.com

python3 watch.py --test      # 测邮件
python3 watch.py --dry-run   # 只检查不发信、不写状态
python3 watch.py             # 正常跑一次
```

只用标准库，无需 `pip install`。Python 3.8+ 即可。

配成 cron 每 15 分钟（需要电脑常开）：

```
*/15 * * * * cd /path/to/bigbang-watch && /usr/bin/python3 watch.py >> watch.log 2>&1
```

---

## 已知限制（说清楚，别产生错误预期）

1. **GitHub 的 cron 是尽力而为**，高峰期可能延迟 5–20 分钟。对"公告出现"这件事完全够用（窗口 3–5 天）；但**抢票那一刻不要靠它**，拿到日期后自己设手机闹钟。
2. **邮件可能进垃圾箱**。第 4 步测试时务必把发件人加白名单。
3. **超过 60 天仓库无提交，GitHub 会自动停掉 schedule**。脚本每天会提交一次 `last-check.txt` 心跳来避免这个问题。
4. **网页结构改了会失效**。脚本抓不到 `HONG KONG` 那一行时会发「⚠️ 抓取异常」邮件，不会默默死掉。
5. 没配 SMTP 但检测到重要变化时，脚本会**故意让 job 失败**，这样 GitHub 会给你发一封 workflow 失败通知邮件当兜底。

---

## 冗余：再加两道保险（都不用写代码）

监控这种事，单点必然会漏。建议叠三层：

### ① Google Alerts（2 分钟，零成本）

去 `google.com/alerts`，建这几条，「传送至」选你的邮箱、频率选「有结果时」：

```
BIGBANG 香港 門票
BIGBANG 啟德 開售
"BIGBANG" "Kai Tak"
```

香港媒体（HK01、星島）通常在官宣后几分钟内出稿，有时比 YG 官网更新还早。

### ② ChatGPT Tasks / Grok 定时任务（当第三层，别当主力）

**为什么不推荐当主力**：
- 只能到「每天」这个粒度
- 它没有状态记忆，无法可靠地判断「和昨天比变了没有」，会重复提醒或漏报
- b.stage 是 JS 页面，它的浏览工具经常读不到内容
- 送达在 App 内，邮件送达不保证

**但作为第三层是有用的。** 直接粘这段进 ChatGPT 的「任务/Tasks」（设每天 10:00）：

```
每天检查这个页面：
https://artist.ygfamily.com/ARTISTS/BIGBANG/concert/worldtour/index.html

找到 HONG KONG / KAI TAK STADIUM 那一行，告诉我它显示的是
"COMING SOON" 还是 "GET TICKETS"。

如果是 GET TICKETS，或者出现了具体开演钟点（不再是 11.13.(FRI) - 15.(SUN)
这种日期区间），就用醒目标题告诉我"香港站开票了"，并列出：
购票链接、各场开演时间、以及 b.stage 上有没有 [HONG KONG] 的 SURVEY 或公告。

如果还是 COMING SOON，只回一句"11/13-15 香港站仍未开票"。
```

### ③ 日历硬提醒

不管监控有没有响，在手机日历上直接建这几条：

| 日期 | 事项 |
|---|---|
| **2026-08-25** | ⚠️ 6th V.I.P 会员报名 8/31 截止，最后确认已入会 |
| 2026-08-05 起每天 | 看一眼 b.stage 有没有 [HONG KONG] |
| 2026-08-28 | 曼谷站会员优先购（香港的备选方案） |
| 2026-08-30 | 曼谷站公开发售 |
| 2026-09-01 起每天 | 香港站优先购/公售高发期，重点盯 |

监控脚本是省事用的，**8/31 这个死线不能靠脚本，靠日历**。
