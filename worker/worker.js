/**
 * BIGBANG 香港站开票提醒 · 订阅中转
 *
 * 路由
 *   GET  /                     订阅页
 *   GET  /api/stats            公开：订阅人数
 *   POST /api/subscribe        公开：提交订阅（邮箱 / 微信 / ntfy）
 *   GET  /u/<token>            公开：一键退订
 *   GET  /api/subscribers      需 ADMIN_KEY：导出名单（json | csv | emails）
 *   POST /api/broadcast        需 ADMIN_KEY：转发到 ntfy 广播
 *
 * 绑定
 *   KV   SUBS
 *   var  NTFY_TOPIC, NTFY_SERVER, PUSHPLUS_QR, PUSHPLUS_GROUP
 *   sec  ADMIN_KEY
 */

const EMAIL_RE = /^[^@\s,;]{1,64}@[^@\s,;]{1,255}\.[A-Za-z]{2,}$/;
const WECHAT_RE = /^[A-Za-z][-_A-Za-z0-9]{5,19}$|^1[3-9]\d{9}$/;

const J = (o, s = 200, extra = {}) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...extra,
    },
  });

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const tokenOf = () => crypto.randomUUID().replace(/-/g, "");

/**
 * 简易限流：同 IP 每 10 分钟最多 20 次写入。
 * 刻意放宽——中国移动网络大量用户共享 NAT 出口 IP，卡太紧会把真实粉丝挡在门外。
 * 重复提交是幂等的（同一身份写同一个 key），所以宽松的代价很小。
 */
async function limited(env, ip) {
  const k = `rl:${await sha(ip)}`;
  const n = parseInt((await env.SUBS.get(k)) || "0", 10);
  if (n >= 20) return true;
  await env.SUBS.put(k, String(n + 1), { expirationTtl: 600 });
  return false;
}

function admin(req, env) {
  const h = req.headers.get("authorization") || "";
  const q = new URL(req.url).searchParams.get("key") || "";
  const given = h.replace(/^Bearer\s+/i, "") || q;
  return env.ADMIN_KEY && given && given === env.ADMIN_KEY;
}

async function listAll(env) {
  const out = [];
  let cursor;
  do {
    const r = await env.SUBS.list({ prefix: "s:", cursor, limit: 1000 });
    for (const k of r.keys) out.push(k.name);
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  const recs = await Promise.all(
    out.map(async (k) => {
      try {
        return JSON.parse((await env.SUBS.get(k)) || "null");
      } catch {
        return null;
      }
    })
  );
  return recs.filter((r) => r && !r.unsub);
}

export default {
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

    // ---------------------------------------------------------- 公开统计
    if (p === "/api/stats") {
      const all = await listAll(env);
      return J({
        count: all.length,
        email: all.filter((x) => x.email).length,
        wechat: all.filter((x) => x.wechat).length,
        topic: env.NTFY_TOPIC || "",
      });
    }

    // ---------------------------------------------------------- 订阅
    if (p === "/api/subscribe" && req.method === "POST") {
      if (await limited(env, ip)) return J({ ok: false, error: "请求过于频繁，稍后再试" }, 429);

      let b;
      try {
        b = await req.json();
      } catch {
        return J({ ok: false, error: "请求格式错误" }, 400);
      }

      const email = String(b.email || "").trim().toLowerCase();
      const wechat = String(b.wechat || "").trim();
      const note = String(b.note || "").slice(0, 200);
      const city = String(b.city || "").slice(0, 40);

      if (!email && !wechat)
        return J({ ok: false, error: "请至少填写邮箱或微信号" }, 400);
      if (email && !EMAIL_RE.test(email))
        return J({ ok: false, error: "邮箱格式不正确" }, 400);
      if (wechat && !WECHAT_RE.test(wechat))
        return J({ ok: false, error: "微信号格式不正确（6-20 位字母数字，或手机号）" }, 400);

      const id = await sha(email || "wx:" + wechat);
      const key = `s:${id.slice(0, 24)}`;
      const prev = JSON.parse((await env.SUBS.get(key)) || "null");

      const rec = {
        email: email || prev?.email || "",
        wechat: wechat || prev?.wechat || "",
        note: note || prev?.note || "",
        city: city || prev?.city || "",
        unsub_token: prev?.unsub_token || tokenOf(),
        created: prev?.created || new Date().toISOString(),
        updated: new Date().toISOString(),
        country: req.headers.get("cf-ipcountry") || "",
        unsub: false,
      };
      await env.SUBS.put(key, JSON.stringify(rec));
      await env.SUBS.put(`t:${rec.unsub_token}`, key);

      // 通知自己有新订阅。用 waitUntil 完全脱离响应链路：
      // ntfy 挂了、超时了、被限流了，都不能影响用户看到「订阅成功」。
      if (env.NTFY_TOPIC && ctx && typeof ctx.waitUntil === "function") {
        const srv = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
        ctx.waitUntil(
          fetch(`${srv}/${env.NTFY_TOPIC}-admin`, {
            method: "POST",
            headers: { Title: "new subscriber", Priority: "min", Tags: "bust_in_silhouette" },
            body: `新订阅\n邮箱: ${rec.email || "-"}\n微信: ${rec.wechat || "-"}\n地区: ${rec.country}`,
          }).catch(() => {})
        );
      }

      return J({
        ok: true,
        repeat: !!prev,
        topic: env.NTFY_TOPIC || "",
        server: env.NTFY_SERVER || "https://ntfy.sh",
        unsub: `${url.origin}/u/${rec.unsub_token}`,
      });
    }

    // ---------------------------------------------------------- 退订
    if (p.startsWith("/u/")) {
      const t = p.slice(3);
      const key = await env.SUBS.get(`t:${t}`);
      let msg = "链接无效或已失效。";
      if (key) {
        const rec = JSON.parse((await env.SUBS.get(key)) || "null");
        if (rec) {
          rec.unsub = true;
          rec.updated = new Date().toISOString();
          await env.SUBS.put(key, JSON.stringify(rec));
          msg = "已退订，不会再收到任何提醒。";
        }
      }
      return new Response(
        `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>退订</title><body style="background:#0b0b0d;color:#f2f3f5;font:16px/1.7 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center">
<div><p style="font-size:20px">${msg}</p><p><a href="/" style="color:#ffe14d">返回订阅页</a></p></div>`,
        { headers: { "content-type": "text/html;charset=utf-8" } }
      );
    }

    // ---------------------------------------------------------- 导出名单
    if (p === "/api/subscribers") {
      if (!admin(req, env)) return J({ ok: false, error: "unauthorized" }, 401);
      const all = await listAll(env);
      const fmt = url.searchParams.get("format") || "json";
      if (fmt === "emails") {
        const s = all.map((x) => x.email).filter(Boolean).join("\n");
        return new Response(s + "\n", {
          headers: { "content-type": "text/plain;charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (fmt === "csv") {
        const esc = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
        const head = "email,wechat,city,note,country,created,updated,unsub_token";
        const rows = all.map((x) =>
          [x.email, x.wechat, x.city, x.note, x.country, x.created, x.updated, x.unsub_token]
            .map(esc)
            .join(",")
        );
        return new Response([head, ...rows].join("\n") + "\n", {
          headers: {
            "content-type": "text/csv;charset=utf-8",
            "content-disposition": 'attachment; filename="bigbang-subscribers.csv"',
            "cache-control": "no-store",
          },
        });
      }
      return J({ count: all.length, subscribers: all });
    }

    // ---------------------------------------------------------- 广播中转
    if (p === "/api/broadcast" && req.method === "POST") {
      if (!admin(req, env)) return J({ ok: false, error: "unauthorized" }, 401);
      const b = await req.json().catch(() => ({}));
      if (!env.NTFY_TOPIC) return J({ ok: false, error: "NTFY_TOPIC 未配置" }, 500);
      const srv = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
      const r = await fetch(`${srv}/${env.NTFY_TOPIC}`, {
        method: "POST",
        headers: {
          Title: "BIGBANG HK ticket alert",
          Priority: b.urgent ? "urgent" : "default",
          Tags: b.urgent ? "rotating_light" : "bell",
        },
        body: String(b.message || "").slice(0, 4000),
      });
      return J({ ok: r.ok, status: r.status, subscribers: (await listAll(env)).length });
    }

    // ---------------------------------------------------------- 前端
    if (p === "/")
      return new Response(page(env), {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "public,max-age=60" },
      });

    return J({ ok: false, error: "not found" }, 404);
  },
};

// ============================================================== 页面

function page(env) {
  const topic = env.NTFY_TOPIC || "";
  const srv = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  const ppQR = env.PUSHPLUS_QR || "";
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BIGBANG 香港站开票提醒 · 免费订阅</title>
<meta name="description" content="BIGBANG 2026 香港启德站 SURVEY 登记 / 会员优先购 / 公开发售，一有动静立刻推送到你手机。免费，不代购。">
<meta property="og:title" content="BIGBANG 香港站开票提醒">
<meta property="og:description" content="启德 11/13-15。开票窗口只有 5 天，错过就没有优先购资格。免费订阅推送。">
<style>
:root{--bg:#0b0b0d;--card:#15161a;--line:#26282f;--fg:#f2f3f5;--dim:#9aa0ab;--y:#ffe14d;--r:#ff4d5e;--b:#4a7dff;--g:#2ecc71}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:620px;margin:0 auto;padding:26px 18px 70px}
h1{font-size:27px;line-height:1.28;margin:0 0 6px;letter-spacing:-.4px}
h1 b{color:var(--y)}
.sub{color:var(--dim);font-size:13.5px;margin-bottom:20px}
.live{display:inline-flex;align-items:center;gap:6px;background:#1a1113;border:1px solid #3a2226;color:#ff8a94;font-size:12px;padding:4px 10px;border-radius:20px;margin-bottom:14px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--r);animation:b 1.4s infinite}
@keyframes b{0%,100%{opacity:1}50%{opacity:.25}}
.alert{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--r);border-radius:8px;padding:14px 16px;margin-bottom:24px;font-size:14px}
.alert b{color:var(--r)}
h2{font-size:15px;margin:26px 0 10px;color:var(--dim);font-weight:500;text-transform:uppercase;letter-spacing:.6px}
.tabs{display:flex;gap:6px;margin-bottom:14px}
.tab{flex:1;text-align:center;padding:10px 4px;background:var(--card);border:1px solid var(--line);border-radius:8px;font-size:13.5px;cursor:pointer;transition:.15s;user-select:none}
.tab.on{background:var(--y);color:#000;border-color:var(--y);font-weight:700}
.pane{display:none}.pane.on{display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
label{display:block;font-size:13px;color:var(--dim);margin:0 0 6px}
input,select{width:100%;background:#0a0a0c;border:1px solid var(--line);border-radius:8px;color:var(--fg);padding:12px;font-size:15px;font-family:inherit;margin-bottom:12px}
input:focus,select:focus{outline:0;border-color:var(--y)}
button{width:100%;background:var(--y);color:#000;border:0;border-radius:8px;padding:13px;font-size:15.5px;font-weight:700;cursor:pointer;font-family:inherit}
button:disabled{opacity:.5;cursor:default}
.hint{font-size:12.5px;color:#6b7280;margin:8px 0 0;line-height:1.6}
a.link{color:var(--y)}
.btn2{display:block;text-align:center;background:#2a2d36;color:var(--fg);text-decoration:none;padding:11px;border-radius:8px;margin-top:8px;font-size:14px;font-weight:600}
code{background:#000;border:1px solid var(--line);border-radius:4px;padding:3px 7px;font-size:13px;color:var(--y);word-break:break-all;display:inline-block}
.ok{background:#0f1a12;border:1px solid #1f3a26;border-left:3px solid var(--g);border-radius:8px;padding:16px;font-size:14px;display:none}
.ok.on{display:block}
.ok b{color:var(--g)}
.err{color:var(--r);font-size:13px;margin-top:8px;display:none}
.err.on{display:block}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border-bottom:1px solid var(--line);padding:8px 4px;text-align:left;vertical-align:top}
th{color:var(--dim);font-weight:500}
.cnt{color:var(--dim);font-size:12.5px;text-align:center;margin-top:12px}
.cnt b{color:var(--y)}
footer{margin-top:36px;color:#5a616b;font-size:11.5px;text-align:center;line-height:1.9}
footer a{color:#5a616b}
.qr{width:170px;height:170px;border-radius:8px;display:block;margin:10px auto;background:#fff}
</style></head><body><div class="wrap">

<div class="live"><span class="dot"></span>监控中 · 每 15 分钟检查官方</div>
<h1>BIGBANG 香港站<br><b>开票即时提醒</b></h1>
<div class="sub">2026.11.13–15 · 启德主场馆 · XX : COSMOS 20 周年世界巡演</div>

<div class="alert">
官方票务仍是 <b>COMING SOON</b>。<br><br>
已开票各站的规律：会员优先购登记（SURVEY）<b>只开放 5 天</b>，
错过就永久失去优先购资格，只能挤公开发售。<br><br>
按曼谷／台北／新加坡的时间反推，香港的登记<b>最早可能 8 月初出现</b>。
</div>

<h2>选一种接收方式</h2>
<div class="tabs">
  <div class="tab on" data-t="wx">微信</div>
  <div class="tab" data-t="ntfy">手机推送</div>
  <div class="tab" data-t="mail">邮箱</div>
</div>

<!-- 微信 -->
<div class="pane on" id="p-wx"><div class="card">
  ${
    ppQR
      ? `<p class="hint" style="margin-top:0">扫码关注后即可收到微信推送，无需装任何 App。</p>
         <img class="qr" src="${ppQR}" alt="微信推送二维码">`
      : `<p class="hint" style="margin-top:0">微信推送通道正在配置中。先用「手机推送」，那条现在就能用。</p>`
  }
  <label>微信号（选填，方便开票时联系你）</label>
  <input id="wx" placeholder="微信号或手机号" autocomplete="off">
  <label>你在哪座城市（选填，用于估算过关时间）</label>
  <input id="wxcity" placeholder="例如 深圳" autocomplete="off">
  <button data-go="wx">登记微信</button>
  <p class="hint">说句实话：微信官方不允许凭微信号给陌生人发消息。真正能推到微信的只有「关注服务号」这一条，所以上面的二维码才是关键，微信号只是让我在开票时能找到你。</p>
</div></div>

<!-- ntfy -->
<div class="pane" id="p-ntfy"><div class="card">
  <p class="hint" style="margin-top:0">系统级推送，秒级到达，不会像邮件被丢进垃圾箱。免注册。</p>
  <p><code>${topic || "（未配置）"}</code></p>
  <a class="btn2" href="${srv}/${topic}" target="_blank" rel="noopener">① 网页版直接订阅（最快）</a>
  <a class="btn2" href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">iOS 装 ntfy App</a>
  <a class="btn2" href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Android 装 ntfy App</a>
  <p class="hint">装 App 后点右下角 ➕，主题名填上面那串，完成。<br>网页版关掉标签页就收不到了，长期盯建议装 App。</p>
</div></div>

<!-- 邮箱 -->
<div class="pane" id="p-mail"><div class="card">
  <label>邮箱</label>
  <input id="mail" type="email" placeholder="you@example.com" autocomplete="email" inputmode="email">
  <label>微信号（选填）</label>
  <input id="mailwx" placeholder="方便开票时联系你" autocomplete="off">
  <button data-go="mail">订阅邮件提醒</button>
  <p class="hint">邮件是这里到达率最差的方式（Gmail 常丢进「促销」栏）。订阅后请到 Gmail 设置 → 收件箱 → 类型选「默认」→ 取消勾选「促销」和「社交」。<br>更稳的做法是同时开上面的手机推送。</p>
</div></div>

<div class="err" id="err"></div>

<div class="ok" id="ok">
  <b>✓ 登记成功。</b>
  <p style="margin:10px 0 0">现在立刻把推送打开，别只靠邮件：</p>
  <a class="btn2" href="${srv}/${topic}" target="_blank" rel="noopener">开启手机推送（10 秒）</a>
  <p class="hint" id="unsub"></p>
</div>

<div class="cnt" id="cnt"></div>

<h2>会在什么时候提醒你</h2>
<div class="card"><table>
<tr><th>触发</th><th>推送内容</th></tr>
<tr><td>🔴 出现 [HONG KONG] SURVEY</td><td>登记窗口起止时间（北京时间＋星期）、是否开放中、直达链接</td></tr>
<tr><td>🔴 官网 COMING SOON → GET TICKETS</td><td>购票链接、三场各自钟点</td></tr>
<tr><td>🔴 香港票务公告发布</td><td>公告链接</td></tr>
<tr><td>🟡 其他城市有动静</td><td>让你提前看出各站的时间规律</td></tr>
</table></div>

<h2>提醒工具管不了的两件事</h2>
<div class="alert" style="border-left-color:var(--y)">
<b style="color:var(--y)">2026-08-31</b>　BIGBANG OFFICIAL 6th V.I.P 会员报名截止（₩25,000）。<br>
香港会员优先购预计 8 月底–9 月中，<b style="color:var(--y)">8/31 之后入会就永远进不了优先购</b>。<br><br>
<b style="color:var(--y)">2026-08-30</b>　曼谷站公开发售，最低约 HK$700，是香港抢不到时的备选。
</div>

<h2>搶到票之前先备好</h2>
<div class="card">
<p class="hint" style="margin-top:0">1. 港澳通行证 + 签注（深圳户籍或居住证可办「一签多行」）<br>
2. Visa／Mastercard 并<b>小额试刷过</b>——境外票务平台银联常被拒付<br>
3. 所有同行者的<b>港澳通行证号</b>，大概率全场实名制，买后改不了名<br>
4. 票务平台账号提前注册、手机与邮箱验证做完，别等开卖当天</p>
</div>

<footer>
本站非官方，信息以 YG Entertainment 及主办方公告为准。<br>
不販售门票，不代购，不收费。邮箱仅用于发送本次开票提醒，可一键退订。<br>
<a href="https://github.com/mr-girff/bigbang-watch" target="_blank" rel="noopener">开源代码</a> ·
<a href="https://artist.ygfamily.com/ARTISTS/BIGBANG/concert/worldtour/index.html" target="_blank" rel="noopener">官方巡演页</a>
</footer>
</div>

<script>
var $=function(s){return document.querySelector(s)};
document.querySelectorAll(".tab").forEach(function(t){
  t.onclick=function(){
    document.querySelectorAll(".tab").forEach(function(x){x.classList.remove("on")});
    document.querySelectorAll(".pane").forEach(function(x){x.classList.remove("on")});
    t.classList.add("on"); $("#p-"+t.dataset.t).classList.add("on");
  };
});
fetch("/api/stats").then(function(r){return r.json()}).then(function(d){
  if(d.count>0) $("#cnt").innerHTML="已有 <b>"+d.count+"</b> 人在等这场";
}).catch(function(){});

function go(kind,btn){
  var body={};
  if(kind==="mail"){ body.email=$("#mail").value.trim(); body.wechat=$("#mailwx").value.trim(); }
  else { body.wechat=$("#wx").value.trim(); body.city=$("#wxcity").value.trim(); }
  $("#err").classList.remove("on");
  btn.disabled=true; var old=btn.textContent; btn.textContent="提交中…";
  fetch("/api/subscribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})
  .then(function(r){return r.json()}).then(function(d){
    btn.disabled=false; btn.textContent=old;
    if(!d.ok){ $("#err").textContent=d.error||"提交失败"; $("#err").classList.add("on"); return; }
    $("#ok").classList.add("on");
    if(d.unsub) $("#unsub").innerHTML='随时退订：<a class="link" href="'+d.unsub+'">点这里</a>（这个链接只属于你，建议存一下）';
    $("#ok").scrollIntoView({behavior:"smooth",block:"center"});
  }).catch(function(){
    btn.disabled=false; btn.textContent=old;
    $("#err").textContent="网络错误，请重试"; $("#err").classList.add("on");
  });
}
document.querySelectorAll("[data-go]").forEach(function(b){
  b.onclick=function(){go(b.dataset.go,b)};
});
</script></body></html>`;
}
