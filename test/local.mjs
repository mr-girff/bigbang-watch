/**
 * 本地端到端自测。不需要 Cloudflare 账号，不需要 wrangler。
 *
 *   deno run --allow-net --allow-read test/local.mjs
 *
 * 跑三条路径：
 *   1. 首次运行 → 只建基线，不轰炸（应输出 baselineOnly:true, pushed:0）
 *   2. 无变化再跑一次 → alerts:0
 *   3. 篡改基线（把香港改成「已开售」的前一态、删掉一个公告）→ 必须报出 CRITICAL
 * 以及 fetch 路由：/api/status、三语言页面、订阅 + 确认 + 退订。
 */

import worker, { runCheck } from "../src/index.js";

/* ---- 内存版 KV，接口和 Workers KV 一致（够跑本文件用到的部分） ---- */
const kv = new Map();
const SUBS = {
  async get(k, type) {
    const v = kv.get(k);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  },
  async put(k, v) {
    kv.set(k, v);
  },
  async delete(k) {
    kv.delete(k);
  },
  async list({ prefix = "", limit = 1000 } = {}) {
    return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })), list_complete: true };
  },
};

const env = {
  SUBS,
  ADMIN_KEY: "test",
  SITE_ORIGIN: "http://localhost:8787",
  NTFY_TOPIC: "",          // 留空 = 本地测试不真发外部请求
  CRON_LABEL: "5 min",
  WATCH_SINCE: "2026-07-29T16:00:00Z",
};
const ctx = { waitUntil: (p) => p.catch?.(() => {}) };

const line = (s) => console.log(`\n=== ${s} ${"=".repeat(Math.max(0, 58 - s.length))}`);
let fails = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

/* ---------------------------------------------------------------- 1 基线 */
line("1. 首次运行：只建基线");
let r = await runCheck(env, { trigger: "test" });
console.log("   watch:", JSON.stringify(r.watch, null, 0).slice(0, 220));
ok(r.ok, "collect + parse 成功", r.error || "");
ok(r.baselineOnly === true, "首次运行标记为 baselineOnly");
ok(r.pushed === 0, "首次运行不推送");
ok((r.errors || []).length === 0, "无解析错误", JSON.stringify(r.errors));
ok((await SUBS.get("snap:latest", "json"))?.tour?.length >= 15, "快照里有 15+ 个城市");

/* ---------------------------------------------------------------- 2 无变化 */
line("2. 立刻再跑一次：应该没有任何告警");
r = await runCheck(env, { trigger: "test" });
ok(r.alerts === 0, "无变化 → alerts = 0", `alerts=${r.alerts}`);

/* ---------------------------------------------------------------- 3 模拟开票 */
line("3. 篡改基线，模拟「香港问卷开放 + 官网挂出购票链接 + 新公告」");
const base = await SUBS.get("snap:latest", "json");
const tampered = structuredClone(base);
// 把香港退回成「没有问卷、没有购票链接」的更早状态，再删掉最新一条公告
tampered.watch.surveys = [];
tampered.windows = {};
tampered.watch.tourStatus = "COMING_SOON";
tampered.watch.ticketUrl = "";
tampered.notices = tampered.notices.slice(1);
// 再往「当前快照」里注入一个假的香港问卷，走一遍真实 diff
const { diff } = await import("../src/detect.js");
const fake = structuredClone(base);
fake.at = new Date().toISOString();
fake.watch.surveys = [
  { id: "ffffffffffffffffffffffff", path: "/surveys/ffffffffffffffffffffffff", title: "[HONG KONG] BIGBANG V.I.P MEMBERSHIP PRESALE SURVEY", city: "HONG KONG" },
];
fake.surveys = [...fake.surveys, fake.watch.surveys[0]];
fake.windows = {
  ffffffffffffffffffffffff: {
    progress: "IN_PROGRESS",
    startAt: "2026-08-04T02:00:00Z",
    endAt: "2026-08-08T17:00:00Z",
    title: "[HONG KONG] ...",
    url: "https://bigbang.bstage.in/surveys/ffffffffffffffffffffffff",
  },
};
fake.watch.tourStatus = "ON_SALE";
fake.watch.ticketUrl = "https://www.cityline.com/example";

const { alerts } = diff(tampered, fake, "HONG KONG");
for (const a of alerts) console.log(`   [${a.sev.toUpperCase()}] ${a.title} :: ${a.detail.slice(0, 90)}`);
ok(alerts.some((a) => a.kind === "survey_open" && a.sev === "critical"), "问卷开放 → CRITICAL");
ok(alerts.some((a) => a.kind === "onsale" && a.sev === "critical"), "官网挂出购票链接 → CRITICAL");
ok(alerts.some((a) => a.kind === "notice"), "新公告被检出");

line("3b. 去重：同样的变化再 diff 一次，指纹相同");
const again = diff(tampered, fake, "HONG KONG").alerts;
ok(
  JSON.stringify(again.map((a) => a.fp)) === JSON.stringify(alerts.map((a) => a.fp)),
  "fingerprint 稳定（同一件事不会重复推送）"
);

/* ---------------------------------------------------------------- 4 路由 */
line("4. HTTP 路由");
const call = (path, init) => worker.fetch(new Request("http://localhost:8787" + path, init), env, ctx);

let res = await call("/api/status");
const st = await res.json();
ok(res.status === 200 && st.watch, "/api/status 200");
ok(st.tour.length >= 15, "/api/status 带全巡演状态", `${st.tour.length} 城`);

res = await call("/");
ok(res.status === 302 && /\/(zh-hant|zh-hans|en)\/$/.test(res.headers.get("location")), "/ 302 到语言路径", res.headers.get("location"));

for (const l of ["zh-hans", "zh-hant", "en"]) {
  res = await call(`/${l}/`);
  const html = await res.text();
  ok(res.status === 200 && html.includes(`lang="${l}"`) && html.length > 4000, `/${l}/ 渲染`, `${html.length}B`);
  ok(html.includes("KAI TAK") || html.includes("啟德"), `/${l}/ 含香港场信息`);
  ok(!/undefined|NaN|\[object/.test(html), `/${l}/ 无 undefined/NaN 渗漏`);
}

res = await call("/sitemap.xml");
ok(res.status === 200 && (await res.text()).includes("zh-hant"), "/sitemap.xml");

line("5. 订阅 → 确认 → 退订");
res = await call("/api/subscribe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "fan@example.com", lang: "zh-hant" }),
});
const sub = await res.json();
ok(sub.ok && sub.pending === true, "邮箱订阅进入 pending（双向确认生效）", JSON.stringify(sub).slice(0, 90));

let stats = await (await call("/api/stats")).json();
ok(stats.count === 0 && stats.pending === 1, "未确认前不计入活跃名单", JSON.stringify(stats));

const rec = await SUBS.get([...kv.keys()].find((k) => k.startsWith("s:")), "json");
res = await call(`/v/${rec.verify_token}`);
ok(res.status === 200 && (await res.text()).includes("確認完成"), "确认链接生效（繁体文案）");
stats = await (await call("/api/stats")).json();
ok(stats.count === 1, "确认后计入活跃名单");

res = await call("/api/subscribe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ telegram: "123456789", lang: "en" }),
});
ok((await res.json()).pending === false, "Telegram 订阅立即生效（无需确认）");

res = await call("/api/subscribe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "not-an-email" }),
});
ok(res.status === 400, "垃圾邮箱被拒");

res = await call(`/u/${rec.unsub_token}`);
ok(res.status === 200 && (await res.text()).includes("取消訂閱"), "一键退订");
stats = await (await call("/api/stats")).json();
ok(stats.count === 1, "退订后活跃数下降", JSON.stringify(stats));

/* -------------------------------------------------- 5b v1 老订阅者不能丢 */
line("5b. v1 记录迁移：老订阅者必须还在名单里");
// 这是 v1 真实写进 KV 的形状：没有 status、没有 lang，只有 unsub 布尔
const V1_ACTIVE = { email: "v1fan@example.com", wechat: "", note: "香港站", city: "HK", unsub_token: "v1tok", created: "2026-07-29T00:00:00Z", updated: "2026-07-29T00:00:00Z", country: "HK", unsub: false };
const V1_UNSUB = { email: "v1gone@example.com", unsub_token: "v1gonetok", created: "2026-07-29T00:00:00Z", country: "HK", unsub: true };
// key 必须按 v1 的规则算：sha256(email) 取前 24 位。v2 用的是同一套规则，
// 所以老用户重新提交会命中同一条记录而不是新建一条 —— 这一点必须由测试钉住。
const v1key = async (email) => {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  return "s:" + [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 24);
};
const KA = await v1key(V1_ACTIVE.email);
await SUBS.put(KA, JSON.stringify(V1_ACTIVE));
await SUBS.put(await v1key(V1_UNSUB.email), JSON.stringify(V1_UNSUB));
await SUBS.put("t:v1tok", KA);

stats = await (await call("/api/stats")).json();
ok(stats.legacy === 1, "v1 老订阅者被算作活跃（不会静默漏报）", JSON.stringify(stats));
ok(stats.email === 1, "v1 邮箱进入邮件投递名单");

const { normalize } = await import("../src/index.js");
ok(normalize(V1_UNSUB).status === "unsub", "v1 已退订的记录不会被复活");
ok(normalize(V1_ACTIVE).lang === "zh-hans", "v1 记录默认简体（v1 站点只有简体）");

// 老用户在 v2 页面重新提交同一个邮箱：不能被降级成 pending
res = await call("/api/subscribe", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: V1_ACTIVE.email, lang: "zh-hant" }),
});
const re = await res.json();
const v1rec = await SUBS.get(KA, "json");
ok(re.pending === false, "v1 老用户重新提交不会被降级成待确认");
ok(v1rec.status === "active" && v1rec.note === "香港站", "老记录字段保留（note/city 不丢）");
ok(v1rec.unsub === undefined, "v1 的 unsub 布尔已清掉，以 status 为准");

// 老用户点 v1 发出去的退订链接，必须依然有效
res = await call("/u/v1tok");
ok(res.status === 200, "v1 退订链接在 v2 仍然有效");
ok((await SUBS.get(KA, "json")).status === "unsub", "退订已生效");

line("6. 管理接口鉴权");
ok((await call("/api/subscribers")).status === 401, "无 key → 401");
ok((await call("/api/subscribers?key=test")).status === 200, "带 key → 200");
ok((await call("/api/subscribers?key=test&format=csv")).status === 200, "CSV 导出");
ok((await call("/api/run", { method: "POST" })).status === 401, "/api/run 需要鉴权");

console.log(`\n${fails === 0 ? "ALL PASS" : fails + " FAILED"}\n`);
if (fails) Deno.exit(1);
