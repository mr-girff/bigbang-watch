# BIGBANG HK 开票监控 v2

香港站（啟德體育園，2026.11.13–15）门票动态监控。Cloudflare Worker 单体，三语言站点，多通道推送。

```
src/sources.js   抓取 + 解析 3 个源（YG 巡演页 / b.stage SURVEY / b.stage NOTICE）
src/detect.js    变化检测、严重度分级、fingerprint 去重
src/notify.js    邮件双通道（CF Email → Resend）、Telegram、PushPlus、ntfy、送达日志
src/i18n.js      简体 / 繁体（香港用词）/ 英文；时间三写 HKT+KST+倒计时
src/site.js      三语言站点（分路径，可被搜索引擎收录三份）
src/index.js     路由 + scheduled()（Cloudflare Cron Trigger）
test/local.mjs   端到端自测，不需要任何账号
DEPLOY.md        部署步骤
```

部署看 `DEPLOY.md`。自测：`deno run --allow-net --allow-read test/local.mjs`（44 项，现网数据全绿）。

---

## 当前状态（读之前先看这段）

| | 状态 |
|---|---|
| v2 代码 | 已进仓库，44 项自测全绿 |
| v2 是否在跑 | **没有。** 需要你执行一次 `wrangler deploy`（要你的 CF 凭据，我没有） |
| v1（`watch.py` + Actions cron） | **仍在跑，故意留着。** v2 没上线之前删掉它 = 监控真空 |

切换顺序不能反：**先 `wrangler deploy` 并验收通过，再停 v1。** 步骤见 `DEPLOY.md` 最后一节。

v1 的文件保持原位（`watch.py` / `channels.py` / `state.json` / `worker/worker.js` / 那个 workflow），
一个字没动 —— 唯一在守香港场的东西不能因为整理目录而停掉。v1 的说明搬到 `legacy/README-v1.md`。

---

## 一、为什么有 v2：GitHub Actions 的定时器不可用

不是配置问题，是实测数据。同一个仓库，workflow 写的是每 15 分钟：

| schedule 事件时间 (UTC) | 距上次 |
|---|---|
| 19:05 | — |
| 20:16 | 71 min |
| 21:25 | 69 min |
| 22:28 | 63 min |
| 23:31 | 63 min |
| 01:01 | 90 min |

**真实间隔 63–90 分钟，应有的 5/6 次触发被丢弃。** GitHub 对免费仓库的 cron 是低优先级、可丢弃的。
香港优先购问卷的窗口只开 4–5 天，用 70 分钟粒度的心跳去守它是不成立的。

v2 把抓取搬进 Worker，用 Cloudflare Cron Trigger（分钟级、准点）。GitHub 降级为独立探针：
只负责「从 CF 之外的网络确认 Worker 还活着」，静默就强制触发 + 开 Issue。

---

## 二、解析规则（2026-07-30 用真实页面逐条验证）

### 1. YG 巡演页 `artist.ygfamily.com/.../worldtour/index.html`

服务端渲染纯 HTML，无需 JS。每城一个 `<div class="row">`：

```html
<div class="item1">HONG KONG</div>          <!-- 城市 -->
<div class="item2">KAI TAK STADIUM</div>    <!-- 场馆 -->
<div class="item4">2026.11.13.(FRI) - 15.(SUN)</div>
<div class="buyticket"><button3> COMING SOON </button3></div>
```

**坑**：单一售票商是 `.buyticket`；多入口（分场次、或 DOMESTIC+GLOBAL 两个购票商）会变成
`<div class="t2">` 并带 `<small>09.04.(FRI)</small>` 标签。第一版按 `.buyticket` 写死，
GOYANG 和 OAKLAND 就被误判成 UNKNOWN。香港是 3 天连演，开票时几乎必然是 `t2` 形态 ——
所以解析器不认 class，直接扫 `.right` 里所有 `a.btn-buy`。19 个城市全部解析正确。

### 2. b.stage `/tag/SURVEY`、`/tag/NOTICE`

也是 SSR HTML（没有 `__NEXT_DATA__`，别去找）：`<a href="/surveys/<24位hex>">[CITY] TITLE</a>`。

### 3. b.stage `/surveys/<id>` —— 精确窗口

详情页内嵌 JSON 里有：

```json
"progressStatus":"IN_PROGRESS","progressStartAt":"2026-07-29T02:00:00Z","progressEndAt":"2026-08-02T17:00:00Z"
```

这是整个项目最值钱的字段：**能拿到问卷的精确开关时间**，不用等页面文案。
官网只给 KST，我们换算成 HKT 并做倒计时 —— 这是产品对粉丝的实际价值。

---

## 三、抓出来的情报：问卷是按批次放的，不是一城一开

| 批次 | 放出时间 (HKT / KST) | 城市 | 窗口长度 |
|---|---|---|---|
| 1 | 2026-06-16 22:00 / 23:00 | OAKLAND、EAST RUTHERFORD、LONDON、PARIS | 5 天 |
| 2 | 2026-07-22 05:00 / 06:00 | SYDNEY | 4 天 |
| 3 | 2026-07-29 10:00 / 11:00 | TAIPEI、SINGAPORE、BANGKOK | 4 天 |

批次间隔 35 天 → 8 天，没有固定周期。但方向很清楚：

- 全 19 城里只剩 **HANOI（10.24）和 HONG KONG（11.13–15）** 还是 `COMING SOON`
- 第 3 批已经覆盖到 11.07 的曼谷，**香港只比它晚 6 天，极可能落在下一批**
- 每个窗口只开 **4–5 天**

所以「多语言 / 好看 / 收费」全都排在「心跳可靠」之后。

---

## 四、告警分级

| 级别 | 触发 | 动作 |
|---|---|---|
| CRITICAL | 香港问卷出现 / 状态转 IN_PROGRESS / 官网挂出购票链接 / 香港票务公告发布 | 推所有订阅者，按各自语言 |
| HIGH | 问卷时间被改、官网链接更新、香港整行从巡演表消失 | 推所有订阅者 |
| INFO | 其它城市新问卷（判断批次节奏用）、非香港公告 | 只进看板 + 通知运维 |
| ERROR | 抓取超时、HTTP 非 200、解析结果异常 | 只通知运维 |

`ERROR` 单独存在，是因为**静默漏报比误报危险得多**：b.stage 改版后如果解析器安静地返回空数组，
系统会以为「香港还没动静」。所以解析失败本身就是告警。

每条告警有稳定 fingerprint，写 KV 去重，同一件事只发一次。首次运行只建基线，不会把 19 城的历史公告一次性轰给用户。

---

## 五、从 v1 迁移：三个会「静默丢用户」的坑

现网 v1 Worker `/api/stats` 报的是 `{"count":2,"email":2,"wechat":1}` —— 有真实订阅者。
v2 换掉整个 Worker，以下三处如果不处理，用户不会看到任何报错，只是开票时**一封都收不到**：

| 坑 | 后果 | 处理 |
|---|---|---|
| v1 记录没有 `status` 字段，只有 `unsub` 布尔 | v2 到处用 `status === "active"` 过滤 → 老订阅者被整体过滤掉 | `normalize()` 在读取时补 `status`（`unsub:true` → `unsub`，否则 `active`），并打 `legacy` 标记 |
| KV namespace 建了新的 | 订阅者、退订 token、去重指纹全部留在旧 namespace 里 | `wrangler.toml` 必须填 **v1 那个 SUBS 的 id**，别 create 新的 |
| `NTFY_TOPIC` 改了名 | v1 订阅页已经把 topic 名字发给用户，他们 App 里订的是旧名字，改名即失联 | 锁定成现网的 `bigbang-hk-75afdc` |

订阅 id 用的还是 v1 的 `sha256(email).slice(0,24)`，所以老用户在 v2 页面重新提交同一个邮箱
会命中同一条记录，不会重复、也不会被降级成「待确认」。v1 发出去的 `/u/<token>` 退订链接继续有效。

双向确认**不追溯**老用户：那 2 个人是自己在 v1 页面提交的，而现在还没有可靠发信通道，
追溯要求他们再点一次确认信等于直接把他们踢出名单。新订阅一律走确认。

上面每一条都有对应测试（`test/local.mjs` 第 5b 节，9 项），不是靠读代码保证的。

---

## 六、合规

- 邮箱订阅**双向确认**（否则任何人能把别人邮箱填进来）
- 每封邮件带 `List-Unsubscribe` + 一键退订链接，退订即时生效
- 每次投递写送达日志（`d:` 前缀，90 天），这是「5 分钟必达否则退款」这条承诺的技术前提
- 抓取 5 分钟一次、带可联系的 User-Agent、只取公开页面
- 页面只用事实数据（城市/场馆/日期/状态/窗口），不搬官方海报、艺人照、logo，页脚有免责声明
