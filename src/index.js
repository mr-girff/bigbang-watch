/**
 * BIGBANG 香港站开票监控 · Worker v2
 *
 * 和 v1 的区别（这是这一版存在的理由）：
 *   1. scheduled() —— 抓取搬进 Worker，用 Cloudflare Cron Trigger。
 *      实测 GitHub Actions 的「每 15 分钟」cron 在这个仓库上真实间隔是 65–90 分钟
 *      （7 次 schedule 事件全部被延迟/丢弃），拿它当心跳是不行的。
 *      GitHub Actions 降级为独立冗余：只在 CF 静默时兜底。
 *   2. 双向确认（double opt-in），否则任何人能把别人邮箱填进来。
 *   3. 邮件双通道（CF Email Service → Resend 自动切换）+ 逐条送达日志。
 *   4. Telegram 通道（香港主通道，iOS 原生、免费、一人一 chat_id）。
 *   5. 三语言分路径站点 + 19 城状态看板 + 问卷批次情报。
 *
 * 路由
 *   GET  /                       → 按 Accept-Language / CF-IPCountry 302
 *   GET  /{zh-hans,zh-hant,en}/  → 站点
 *   GET  /api/status             → 当前快照（公开 JSON，也给 GitHub 备份链路做心跳探测）
 *   GET  /api/stats              → 订阅人数
 *   POST /api/subscribe          → 订阅（email 走确认信；telegram/wechat 立即生效）
 *   GET  /v/<token>              → 确认订阅
 *   GET  /u/<token>              → 一键退订
 *   POST /tg/<TG_WEBHOOK_SECRET> → Telegram bot webhook（/start 自动登记 chat_id）
 *   GET  /api/subscribers        → ADMIN_KEY：导出 json|csv|emails
 *   GET  /api/deliveries         → ADMIN_KEY：送达日志（退款举证用）
 *   POST /api/run                → ADMIN_KEY：手动跑一次检查（?force=1 无视去重）
 *   POST /api/test               → ADMIN_KEY：给自己发一条模拟告警，验证全链路
 *
 * 绑定见 wrangler.toml
 */

import { collect } from "./sources.js";
import { diff, pushWorthy } from "./detect.js";
import { sendEmail, sendTelegram, sendPushPlus, sendNtfy, sendOps } from "./notify.js";
import { LANGS, DEFAULT_LANG, pickLang, renderAlert, t } from "./i18n.js";
import { renderPage, simplePage } from "./site.js";

const WATCH_CITY = "HONG KONG";
const EMAIL_RE = /^[^@\s,;]{1,64}@[^@\s,;]{1,255}\.[A-Za-z]{2,}$/;
const WECHAT_RE = /^[A-Za-z][-_A-Za-z0-9]{5,19}$|^1[3-9]\d{9}$/;

const J = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json;charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" },
  });
const HTML = (b, maxAge = 60) =>
  new Response(b, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": `public,max-age=${maxAge}` } });

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const tok = () => crypto.randomUUID().replace(/-/g, "");
const admin = (req, env) => {
  const g = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || new URL(req.url).searchParams.get("key") || "";
  return !!env.ADMIN_KEY && g === env.ADMIN_KEY;
};

async function limited(env, ip) {
  const k = `rl:${await sha(ip)}`;
  const n = parseInt((await env.SUBS.get(k)) || "0", 10);
  if (n >= 20) return true;
  await env.SUBS.put(k, String(n + 1), { expirationTtl: 600 });
  return false;
}

/**
 * v1 → v2 记录归一化。
 *
 * v1 的订阅记录里没有 `status`，只有一个 `unsub` 布尔，也没有 `lang`（v1 站点只有简体）。
 * 如果不归一化，下面所有 `status === "active"` 的过滤会把 v1 遗留的订阅者**静默丢掉** ——
 * 他们还在名单里、页面还在数他们，但开票时一封都收不到。静默漏报是这套系统最不能出的错。
 *
 * 老记录按「已生效」处理：当初是本人在 v1 订阅页自己提交的。
 * 双向确认只对 v2 之后的新订阅生效，不追溯要求老用户再点一次确认信
 * （现在还没有可靠的发信通道，追溯确认等于直接把他们踢掉）。
 */
export function normalize(r) {
  if (!r) return null;
  const out = { ...r };
  if (!out.status) {
    out.status = out.unsub === true ? "unsub" : "active";
    out.legacy = true;
    if (!out.lang) out.lang = "zh-hans";
  }
  if (!LANGS.includes(out.lang)) out.lang = DEFAULT_LANG;
  return out;
}

const getSub = async (env, key) => normalize(await env.SUBS.get(key, "json").catch(() => null));

async function listSubs(env) {
  const keys = [];
  let cursor;
  do {
    const r = await env.SUBS.list({ prefix: "s:", cursor, limit: 1000 });
    keys.push(...r.keys.map((k) => k.name));
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  const recs = await Promise.all(keys.map((k) => env.SUBS.get(k, "json").catch(() => null)));
  return recs.filter(Boolean).map(normalize);
}

const getSnap = (env, k = "snap:latest") => env.SUBS.get(k, "json");

/* =============================================================== 定时检查 */

export async function runCheck(env, { force = false, trigger = "cron" } = {}) {
  const prev = await getSnap(env);
  let snap;
  try {
    snap = await collect(WATCH_CITY);
  } catch (e) {
    await sendOps(env, "collect() 整体失败", e.message);
    return { ok: false, error: e.message };
  }

  const { alerts } = diff(prev, snap, WATCH_CITY);

  // 首次运行只建基线，不把 19 个城市的历史公告一次性轰给用户
  const baselineOnly = !prev;
  await env.SUBS.put("snap:latest", JSON.stringify(snap));
  await env.SUBS.put("hb:cf", new Date().toISOString(), { expirationTtl: 7 * 86400 });

  const sent = [];
  if (!baselineOnly) {
    for (const a of alerts) {
      const fpk = `fp:${await sha(a.fp)}`;
      if (!force && (await env.SUBS.get(fpk))) continue; // 同一件事只发一次
      await env.SUBS.put(fpk, a.at, { expirationTtl: 120 * 86400 });
      await env.SUBS.put(`a:${a.at}:${(await sha(a.fp)).slice(0, 8)}`, JSON.stringify(a), {
        expirationTtl: 365 * 86400,
      });
      if (a.sev === "error") {
        await sendOps(env, a.title, a.detail);
        continue;
      }
      if (pushWorthy(a)) sent.push(await broadcast(env, a));
      else await sendOps(env, `[info] ${a.title}`, a.detail);
    }
  }

  return {
    ok: true,
    trigger,
    baselineOnly,
    at: snap.at,
    watch: snap.watch,
    alerts: alerts.length,
    pushed: sent.length,
    errors: snap.errors,
    delivered: sent,
  };
}

/** 一条告警 → 所有已确认订阅者，按各自语言渲染 */
async function broadcast(env, a) {
  const subs = (await listSubs(env)).filter((s) => s.status === "active");
  const origin = env.SITE_ORIGIN || "";
  const jobs = [];

  for (const s of subs) {
    const lang = LANGS.includes(s.lang) ? s.lang : DEFAULT_LANG;
    const { subject, text } = renderAlert(a, lang, origin ? `${origin}/${lang}/` : "");
    if (s.email) {
      const unsub = origin ? `${origin}/u/${s.unsub_token}` : "";
      const html = `<div style="font:15px/1.6 system-ui,sans-serif"><p>${text
        .split("\n")
        .map((l) => (/^https?:/.test(l) ? `<a href="${l}">${l}</a>` : l))
        .join("<br>")}</p>${unsub ? `<p style="font-size:12px;color:#888"><a href="${unsub}">unsubscribe</a></p>` : ""}</div>`;
      jobs.push(sendEmail(env, s.email, subject, text + (unsub ? `\n\nunsubscribe: ${unsub}` : ""), html, unsub));
    }
    if (s.telegram) jobs.push(sendTelegram(env, s.telegram, text.replace(/&/g, "&amp;").replace(/</g, "&lt;")));
    if (s.pushplus) jobs.push(sendPushPlus(env, s.pushplus, subject, text));
  }
  // 免费层公共广播
  jobs.push(sendNtfy(env, a.title, a.detail + (a.url ? `\n${a.url}` : ""), a.sev === "critical"));

  const res = await Promise.allSettled(jobs);
  const ok = res.filter((r) => r.status === "fulfilled" && r.value?.ok).length;
  await sendOps(env, `已广播：${a.title}`, `目标 ${jobs.length}，成功 ${ok}`);
  return { alert: a.fp, targets: jobs.length, ok };
}

/* =============================================================== HTTP */

export default {
  scheduled(_event, env, ctx) {
    // waitUntil 而不是 await：cron 处理器不能因为某个通道慢就整体超时
    ctx.waitUntil(runCheck(env, { trigger: "cron" }));
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";

    if (req.method === "OPTIONS")
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
        },
      });

    /* ---------------- 公开快照：也是 GitHub 备份链路的心跳探测口 */
    if (p === "/api/status") {
      const snap = await getSnap(env);
      const hb = await env.SUBS.get("hb:cf");
      return J({
        ok: true,
        watch: snap?.watch || null,
        windows: snap?.windows || {},
        tour: (snap?.tour || []).map((r) => ({ city: r.city, dates: r.dates, status: r.status })),
        surveys: (snap?.surveys || []).map((s) => s.city || s.title.slice(0, 40)),
        errors: snap?.errors || [],
        snapshot_at: snap?.at || null,
        last_cron: hb,
        stale_minutes: hb ? Math.round((Date.now() - new Date(hb)) / 60000) : null,
      });
    }

    if (p === "/api/stats") {
      const all = await listSubs(env);
      const act = all.filter((s) => s.status === "active");
      return J({
        count: act.length,
        pending: all.filter((s) => s.status === "pending").length,
        email: act.filter((s) => s.email).length,
        telegram: act.filter((s) => s.telegram).length,
        wechat: act.filter((s) => s.wechat || s.pushplus).length,
        legacy: act.filter((s) => s.legacy).length, // v1 迁移过来的，方便核对没丢人
      });
    }

    /* ---------------- 订阅（含双向确认） */
    if (p === "/api/subscribe" && req.method === "POST") {
      if (await limited(env, ip)) return J({ ok: false, error: "太频繁了，稍后再试 / too many requests" }, 429);
      const b = await req.json().catch(() => null);
      if (!b) return J({ ok: false, error: "bad request" }, 400);

      const email = String(b.email || "").trim().toLowerCase();
      const telegram = String(b.telegram || "").trim();
      const wechat = String(b.wechat || "").trim();
      const lang = LANGS.includes(b.lang) ? b.lang : DEFAULT_LANG;

      if (!email && !telegram && !wechat) return J({ ok: false, error: "empty" }, 400);
      if (email && !EMAIL_RE.test(email)) return J({ ok: false, error: "邮箱格式不正确 / invalid email" }, 400);
      if (telegram && !/^-?\d{5,20}$/.test(telegram))
        return J({ ok: false, error: "Telegram chat id 应该是一串数字 / must be digits" }, 400);
      if (wechat && !WECHAT_RE.test(wechat)) return J({ ok: false, error: "微信号格式不正确 / invalid WeChat id" }, 400);

      const id = (await sha(email || (telegram ? "tg:" + telegram : "wx:" + wechat))).slice(0, 24);
      const key = `s:${id}`;
      const prev = await getSub(env, key); // 归一化：v1 老订阅者不会被当成「未确认」而降级

      // 邮件必须双向确认；Telegram / 微信本身已证明是本人操作，直接生效
      const needVerify = !!email && prev?.status !== "active";
      const rec = {
        ...(prev || {}), // 保住 v1 的 note / city 等字段
        email: email || prev?.email || "",
        telegram: telegram || prev?.telegram || "",
        wechat: wechat || prev?.wechat || "",
        pushplus: prev?.pushplus || "",
        lang,
        country: req.headers.get("cf-ipcountry") || "",
        status: needVerify ? "pending" : "active",
        verify_token: prev?.verify_token || tok(),
        unsub_token: prev?.unsub_token || tok(),
        created: prev?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
        unsub: undefined, // v1 的布尔字段，从此以 status 为准（JSON.stringify 会丢掉 undefined）
      };
      await env.SUBS.put(key, JSON.stringify(rec));
      await env.SUBS.put(`t:${rec.unsub_token}`, key);
      if (needVerify) await env.SUBS.put(`v:${rec.verify_token}`, key, { expirationTtl: 7 * 86400 });

      if (needVerify) {
        const origin = env.SITE_ORIGIN || url.origin;
        const link = `${origin}/v/${rec.verify_token}`;
        const subj =
          lang === "en" ? "Confirm your BIGBANG HK alert" : lang === "zh-hant" ? "確認訂閱 BIGBANG 香港場提醒" : "确认订阅 BIGBANG 香港站提醒";
        const body =
          (lang === "en"
            ? "Click to confirm. If you didn't request this, ignore this email — nothing was subscribed.\n\n"
            : lang === "zh-hant"
            ? "點擊確認訂閱。如果唔係你申請嘅，直接忽略即可，唔會有任何訂閱生效。\n\n"
            : "点击确认订阅。如果不是你申请的，直接忽略即可，不会有任何订阅生效。\n\n") + link;
        ctx.waitUntil(
          sendEmail(env, email, subj, body, `<p>${body.split("\n\n")[0]}</p><p><a href="${link}">${link}</a></p>`, `${origin}/u/${rec.unsub_token}`)
        );
      }
      ctx.waitUntil(
        sendOps(env, "新订阅", `${rec.email || rec.telegram || rec.wechat} · ${rec.country} · ${rec.lang} · ${rec.status}`)
      );

      return J({ ok: true, pending: needVerify, repeat: !!prev, unsub: `${url.origin}/u/${rec.unsub_token}` });
    }

    /* ---------------- 确认 / 退订 */
    if (p.startsWith("/v/") || p.startsWith("/u/")) {
      const verify = p.startsWith("/v/");
      const token = p.slice(3);
      const key = await env.SUBS.get(`${verify ? "v" : "t"}:${token}`);
      let lang = DEFAULT_LANG,
        msg = t(lang, verify ? "verify_bad" : "unsub_bad");
      if (key) {
        const rec = await getSub(env, key);
        if (rec) {
          lang = LANGS.includes(rec.lang) ? rec.lang : DEFAULT_LANG;
          rec.status = verify ? "active" : "unsub";
          rec.updated = new Date().toISOString();
          await env.SUBS.put(key, JSON.stringify(rec));
          if (verify) await env.SUBS.delete(`v:${token}`);
          msg = t(lang, verify ? "verify_ok" : "unsub_ok");
        }
      }
      return HTML(simplePage(msg, lang), 0);
    }

    /* ---------------- Telegram webhook：/start 自动登记 chat_id，用户零操作 */
    if (p === `/tg/${env.TG_WEBHOOK_SECRET || "__off__"}` && req.method === "POST") {
      const u = await req.json().catch(() => ({}));
      const m = u.message || u.channel_post;
      const chat = m?.chat?.id;
      if (chat) {
        const txt = String(m.text || "");
        const key = `s:${(await sha("tg:" + chat)).slice(0, 24)}`;
        if (/^\/stop|^\/unsub/.test(txt)) {
          const rec = (await getSub(env, key)) || {};
          rec.status = "unsub";
          await env.SUBS.put(key, JSON.stringify(rec));
          await sendTelegram(env, chat, "已取消訂閱。想再開就再發 /start。");
        } else {
          const prev = await getSub(env, key);
          const lc = String(m.from?.language_code || "").toLowerCase();
          const rec = {
            ...(prev || {}),
            telegram: String(chat),
            lang: prev?.lang || (lc.startsWith("zh") ? (lc.includes("hk") || lc.includes("tw") ? "zh-hant" : "zh-hans") : "en"),
            status: "active",
            unsub_token: prev?.unsub_token || tok(),
            created: prev?.created || new Date().toISOString(),
            updated: new Date().toISOString(),
          };
          await env.SUBS.put(key, JSON.stringify(rec));
          await env.SUBS.put(`t:${rec.unsub_token}`, key);
          const snap = await getSnap(env);
          await sendTelegram(
            env,
            chat,
            `✅ 已登記。香港場一有動靜就即時通知你。\n\n現況：${snap?.watch?.tourStatus === "ON_SALE" ? "已開售" : "門票尚未開售"}` +
              `\n${snap?.watch?.venue || "KAI TAK STADIUM"} ${snap?.watch?.dates || ""}\n\n你的 chat id：<code>${chat}</code>\n取消訂閱：/stop`
          );
        }
      }
      return J({ ok: true });
    }

    /* ---------------- 管理 */
    if (p === "/api/subscribers") {
      if (!admin(req, env)) return J({ ok: false, error: "unauthorized" }, 401);
      const all = await listSubs(env);
      const fmt = url.searchParams.get("format") || "json";
      if (fmt === "emails")
        return new Response(all.filter((x) => x.status === "active" && x.email).map((x) => x.email).join("\n") + "\n", {
          headers: { "content-type": "text/plain;charset=utf-8" },
        });
      if (fmt === "csv") {
        const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const cols = ["email", "telegram", "wechat", "lang", "country", "status", "legacy", "created", "updated", "unsub_token"];
        return new Response([cols.join(","), ...all.map((r) => cols.map((c) => q(r[c])).join(","))].join("\n") + "\n", {
          headers: { "content-type": "text/csv;charset=utf-8", "content-disposition": 'attachment; filename="subscribers.csv"' },
        });
      }
      return J({ count: all.length, subscribers: all });
    }

    if (p === "/api/deliveries") {
      if (!admin(req, env)) return J({ ok: false, error: "unauthorized" }, 401);
      const r = await env.SUBS.list({ prefix: "d:", limit: 1000 });
      const rows = await Promise.all(r.keys.map((k) => env.SUBS.get(k.name, "json").catch(() => null)));
      const list = rows.filter(Boolean);
      return J({
        count: list.length,
        ok: list.filter((x) => x.ok).length,
        failed: list.filter((x) => !x.ok),
        recent: list.slice(-100),
      });
    }

    if (p === "/api/alerts") {
      const r = await env.SUBS.list({ prefix: "a:", limit: 200 });
      const rows = await Promise.all(r.keys.map((k) => env.SUBS.get(k.name, "json").catch(() => null)));
      return J({ alerts: rows.filter(Boolean).reverse() });
    }

    if (p === "/api/run" && req.method === "POST") {
      if (!admin(req, env)) return J({ ok: false, error: "unauthorized" }, 401);
      return J(await runCheck(env, { force: url.searchParams.get("force") === "1", trigger: "manual" }));
    }

    // 端到端自测：不改真实快照，只把一条模拟 CRITICAL 走完整个广播链路
    if (p === "/api/test" && req.method === "POST") {
      if (!admin(req, env)) return J({ ok: false, error: "unauthorized" }, 401);
      const a = {
        sev: "critical",
        kind: "survey_open",
        title: "[测试] HONG KONG V.I.P 优先购问卷已开放",
        detail: "窗口 2026-08-04T02:00:00Z → 2026-08-08T17:00:00Z (UTC)　状态 IN_PROGRESS",
        fp: `test:${Date.now()}`,
        url: "https://bigbang.bstage.in/tag/SURVEY",
        at: new Date().toISOString(),
      };
      return J(await broadcast(env, a));
    }

    /* ---------------- 站点 */
    const seg = p.split("/")[1];
    if (LANGS.includes(seg)) {
      const [snap, stats] = await Promise.all([
        getSnap(env),
        listSubs(env).then((a) => ({ count: a.filter((s) => s.status === "active").length })),
      ]);
      return HTML(renderPage(env, seg, snap, stats), 60);
    }
    if (p === "/") {
      const lang = pickLang(req);
      return new Response(null, {
        status: 302,
        headers: { location: `/${lang}/`, "set-cookie": `lang=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`, vary: "Accept-Language" },
      });
    }
    if (p === "/robots.txt")
      return new Response(`User-agent: *\nAllow: /\nSitemap: ${env.SITE_ORIGIN || url.origin}/sitemap.xml\n`, {
        headers: { "content-type": "text/plain" },
      });
    if (p === "/sitemap.xml") {
      const o = env.SITE_ORIGIN || url.origin;
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${LANGS.map(
          (l) => `<url><loc>${o}/${l}/</loc><changefreq>hourly</changefreq><priority>${l === "zh-hant" ? "1.0" : "0.8"}</priority></url>`
        ).join("")}</urlset>`,
        { headers: { "content-type": "application/xml" } }
      );
    }

    return J({ ok: false, error: "not found" }, 404);
  },
};
