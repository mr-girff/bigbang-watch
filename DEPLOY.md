# 部署：15 分钟，全部命令可直接复制

代码已经写完并在本机跑通了 **44 项端到端检查**（真实抓取 YG 官网 + b.stage，模拟开票告警，三语言页面，订阅/确认/退订，鉴权）。
本机没有你的 Cloudflare / GitHub 凭据，所以最后这一步必须你执行。

复现测试（不需要任何账号）：

```bash
curl -fsSL https://deno.land/install.sh | sh      # 或 brew install deno
deno run --allow-net --allow-read test/local.mjs
```

---

## 第 0 步 · 先跑最小可用版（0 成本，5 分钟，只用 Telegram）

**先不要买域名、不要开 Workers Paid。** 香港问卷可能这几天就开，先把「不漏报」这条命保住。

```bash
npm i -g wrangler          # 或全程用 npx wrangler
wrangler login             # 浏览器授权，不需要给我任何 token
```

### 1. KV：**用 v1 那个 SUBS，不要新建**

现网已经有 2 个真实订阅者存在 v1 的 SUBS namespace 里。新建一个 namespace 不会报错，
只会让这些人和所有退订 token 留在旧库里 —— 表现是「一切正常但开票时没人收到」。

```bash
wrangler kv namespace list        # 找到 title 里带 SUBS 的那条，抄它的 id
```

把 id 填进 `wrangler.toml` 的 `PUT_YOUR_KV_NAMESPACE_ID_HERE`。填完自查一句：

```bash
wrangler kv key list --namespace-id <id> | grep '"s:' | head    # 应该能看到 s: 开头的订阅者
```

只有 `wrangler kv namespace list` 里确实找不到时才 `wrangler kv namespace create SUBS`。

### 2. 建 Telegram bot（2 分钟，免费，香港主通道）

1. Telegram 里搜 `@BotFather` → `/newbot` → 起名 → 拿到 token
2. 私聊你自己的新 bot，发 `/start`
3. 拿你自己的 chat id：`curl "https://api.telegram.org/bot<TOKEN>/getUpdates"`，取 `message.chat.id`

### 3. 写机密

```bash
wrangler secret put ADMIN_KEY          # 自己编一串，例如 openssl rand -hex 16
wrangler secret put TG_BOT_TOKEN       # 上面 BotFather 给的
wrangler secret put TG_WEBHOOK_SECRET  # 自己编一串
wrangler secret put OPS_TG_CHAT        # 你自己的 chat id
```

`wrangler.toml` 里 `CF_ACCOUNT_ID` 填你的账号 ID（Cloudflare 控制台右下角，或 `wrangler whoami`）。

### 4. 部署

```bash
wrangler deploy
```

### 5. 挂 Telegram webhook（让粉丝发 /start 就自动订阅，零操作）

```bash
ORIGIN=https://bigbang-hk.<你的子域>.workers.dev
curl "https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=$ORIGIN/tg/<TG_WEBHOOK_SECRET>"
```

### 6. 验收（这一步别跳，必须看到手机响）

```bash
curl -X POST -H "authorization: Bearer <ADMIN_KEY>" $ORIGIN/api/run      # 首次：建基线
curl -X POST -H "authorization: Bearer <ADMIN_KEY>" $ORIGIN/api/test     # 发一条模拟告警
curl $ORIGIN/api/status | head -c 400
```

`/api/test` 会把一条「[测试] HONG KONG 优先购问卷已开放」走**完整广播链路**发给所有已确认订阅者。
**看手机，不是看日志。** 收到了才算这套东西存在。

等 5–10 分钟后再看一次 `/api/status`，`stale_minutes` 应该 ≤ 5 —— 这说明 CF cron 真的在跑。

再核一遍订阅者有没有跟过来（`legacy` 是从 v1 迁过来的条数，现在应该 ≥ 1）：

```bash
curl $ORIGIN/api/stats     # 期望 count ≥ 2、legacy ≥ 1；如果 count=0，八成是 KV id 填错了
```

### 7. 只有上面全部通过，才停掉 v1

**顺序不能反。** v1 的 Actions cron 目前是唯一真正在守香港场的东西（虽然间隔 63–90 分钟），
在 v2 验收通过之前删掉它，就是把监控清零。

```bash
gh workflow disable "BIGBANG HK watch" -R mr-girff/bigbang-watch
```

（或网页版：仓库 → Actions → 左边 "BIGBANG HK watch" → 右上 `···` → Disable workflow。）

先 disable 而不是删文件：万一 v2 有问题，一条命令就能把 v1 开回来
（`gh workflow enable "BIGBANG HK watch"`）。等 v2 稳跑一周再删。

---

## 第 1 步 · 自有域名 + 邮件（等第 0 步验收通过再做）

### 域名

Cloudflare Registrar 买（成本价，DNS 零配置）。买完把 `wrangler.toml` 的 `SITE_ORIGIN` 改成 `https://你的域名`，
然后 Workers → bigbang-hk → Settings → Domains & Routes → Add custom domain。

### 邮件主通道：Cloudflare Email Service

- 需要 **Workers Paid US$5/月**。Free 计划只能发给你自己账号内已验证的地址，发不了粉丝。
- 控制台 onboard 发信域名（DKIM/SPF 由 CF 托管），然后建一个 API Token，权限只勾 **Email Sending: Send**。

```bash
wrangler secret put CF_EMAIL_TOKEN
```

`wrangler.toml` 里 `MAIL_FROM` 改成 `alert@你的域名`。

### 邮件备通道：Resend（免费 3000/月）

同一个域名再配一组 DKIM 记录，拿 API Key：

```bash
wrangler secret put RESEND_KEY
```

主通道失败会自动落到备通道，两条都记进送达日志。想反过来主用 Resend，把 `MAIL_PRIMARY` 改成 `"resend"`。

### 备份心跳（GitHub）

把 `.github/workflows/backup-heartbeat.yml` 放进仓库，然后：

- 仓库 → Settings → Variables → `WORKER_ORIGIN` = 你的站点地址
- 仓库 → Settings → Secrets → `ADMIN_KEY` = 上面那个

它每 30 分钟从 GitHub 的网络探测一次 Worker，CF 静默 >20 分钟就强制触发，>45 分钟开 Issue。
**注意它自己也会被 GitHub 延迟**（实测 65–90 分钟），所以它只能当兜底，不能当主监控。

---

## 开票临近时（重要）

把 `wrangler.toml` 的 `crons = ["*/5 * * * *"]` 改成 `["* * * * *"]`（每分钟），`CRON_LABEL` 改成 `"1 min"`，重新 `wrangler deploy`。
一天 1440 次触发，仍在免费额度（10 万请求/日）内。

---

## 管理接口

| 用途 | 命令 |
|---|---|
| 当前快照（公开） | `curl $ORIGIN/api/status` |
| 订阅统计（公开） | `curl $ORIGIN/api/stats` |
| 历史告警（公开） | `curl $ORIGIN/api/alerts` |
| 导出名单 | `curl "$ORIGIN/api/subscribers?key=<K>&format=csv" -o subs.csv` |
| 送达日志（退款举证） | `curl "$ORIGIN/api/deliveries?key=<K>"` |
| 手动检查 | `curl -X POST -H "authorization: Bearer <K>" $ORIGIN/api/run` |
| 无视去重重发 | `curl -X POST -H "authorization: Bearer <K>" "$ORIGIN/api/run?force=1"` |
| 端到端自测 | `curl -X POST -H "authorization: Bearer <K>" $ORIGIN/api/test` |

---

## 我没做、以及为什么

| 项 | 状态 | 原因 |
|---|---|---|
| KV → D1 迁移 | 没做 | 现有订阅者在 KV 里、v1 代码在用。几百人量级 KV 完全够。香港窗口可能剩几天，这时候做数据迁移是拿核心承诺换整洁。等窗口过了再迁。 |
| Web Push / PWA | 没做 | iOS 必须先「加到主屏幕」，香港 iPhone 占比高，转化率会很差。Telegram 覆盖同一批人且零门槛，先把它做好。 |
| PushPlus 微信 | 代码写了，没配 | 需要你的 PushPlus token。填了 `sub.pushplus` 就会自动走。 |
| 支付 | 没做 | 按上一版结论：先免费保不漏报。而且 Stripe 香港基本要 BR 证书，要收钱先用 Ko-fi / Gumroad。 |
| 官方海报 / 艺人图 | 故意不用 | 侵权且会 403。页面只用「事实数据」（城市/场馆/日期/状态/窗口），事实不受版权保护，页脚有免责声明。 |
