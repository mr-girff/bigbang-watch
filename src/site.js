/**
 * 站点渲染。三语言分路径（/zh-hans/ /zh-hant/ /en/），Worker 侧出 HTML，
 * 这样 Google 能收录三份 —— 粉丝搜「BIGBANG 香港 門票」才有机会命中。
 *
 * 视觉全部自建：黑底 + 冷白 + 一处高饱和强调色 + 等宽字倒计时。
 * 不搬官方海报 / 艺人照 / logo，不热链官网图片（既侵权又会 403）。
 */

import { t, LANGS, tz3, rel, dur } from "./i18n.js";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const CSS = `
*{box-sizing:border-box}
:root{--bg:#08080a;--card:#111114;--line:#232329;--fg:#f2f3f5;--dim:#8b8b93;--acc:#ffe14d;--hot:#ff4d5e;--ok:#3ddc97}
html,body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang HK","Noto Sans CJK HK","Microsoft JhengHei",sans-serif}
a{color:var(--acc)}
.wrap{max-width:880px;margin:0 auto;padding:0 20px 80px}
header{padding:28px 0 8px;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.brand{font-weight:700;letter-spacing:.04em;font-size:15px}
.brand small{display:block;color:var(--dim);font-weight:400;letter-spacing:0}
.langs{display:flex;gap:2px;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:3px}
.langs a{padding:5px 12px;border-radius:999px;font-size:13px;color:var(--dim);text-decoration:none}
.langs a[aria-current]{background:var(--acc);color:#000;font-weight:600}
h1{font-size:clamp(26px,5vw,40px);line-height:1.2;margin:18px 0 6px;letter-spacing:-.01em}
.lede{color:var(--dim);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin:14px 0}
.hero{border-color:#3a3a2a;background:linear-gradient(180deg,#16150e,#111114)}
.pill{display:inline-block;font-size:12px;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--dim)}
.pill.hot{background:#2a1216;border-color:#5a2028;color:#ff8b96}
.pill.on{background:#0f2a1e;border-color:#1d5540;color:var(--ok)}
.big{font:600 clamp(20px,4vw,30px)/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;margin:10px 0 4px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:14px;color:var(--dim);margin-top:12px}
.kv b{color:var(--fg);font-weight:500}
h2{font-size:18px;margin:34px 0 10px;letter-spacing:.01em}
form{display:grid;gap:10px}
input,button,select{font:inherit}
input{width:100%;padding:13px 14px;border-radius:10px;border:1px solid var(--line);background:#0c0c0f;color:var(--fg)}
input:focus{outline:none;border-color:var(--acc)}
button.go{padding:13px;border:0;border-radius:10px;background:var(--acc);color:#000;font-weight:700;cursor:pointer}
button.go:disabled{opacity:.5;cursor:default}
.tabs{display:flex;gap:6px;margin-bottom:4px;flex-wrap:wrap}
.tabs button{padding:7px 13px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;font-size:14px}
.tabs button[aria-pressed=true]{background:#1d1d22;color:var(--fg);border-color:#3a3a44}
.hint{font-size:13px;color:var(--dim)}
.msg{font-size:14px;padding:11px 13px;border-radius:10px;display:none}
.msg.ok{display:block;background:#0f2a1e;color:var(--ok)}
.msg.err{display:block;background:#2a1216;color:#ff8b96}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
tr.me td{background:#16150e}
tr.me td:first-child{font-weight:700}
.mono{font-family:ui-monospace,Menlo,monospace}
details{border-top:1px solid var(--line);padding:12px 0}
details summary{cursor:pointer;font-weight:500}
details p{color:var(--dim);margin:8px 0 0;font-size:14px}
footer{margin-top:44px;padding-top:18px;border-top:1px solid var(--line);color:#6b6b73;font-size:12.5px}
@media(max-width:560px){td.hide,th.hide{display:none}}
`;

function langSwitch(lang, path) {
  return `<nav class=langs>${LANGS.map(
    (l) =>
      `<a href="/${l}${path}"${l === lang ? " aria-current=page" : ""} rel=nofollow>${
        { "zh-hans": "简", "zh-hant": "繁", en: "EN" }[l]
      }</a>`
  ).join("")}</nav>`;
}

/** 巡演状态表 */
function tourTable(lang, snap) {
  const rows = (snap?.tour || [])
    .map((r) => {
      const me = /HONG\s*KONG/i.test(r.city);
      // 有些问卷标题没有 [CITY] 前缀（例如 GOYANG 那条），所以按整个标题匹配城市名
      const sv = (snap.surveys || []).some((s) =>
        new RegExp(`\\b${r.city.replace(/[^A-Z ]/gi, "")}\\b`, "i").test(`${s.city} ${s.title}`)
      );
      const st =
        r.status === "ON_SALE"
          ? `<span class="pill on">${t(lang, "st_onsale")}</span>`
          : `<span class=pill>${t(lang, "st_coming")}</span>`;
      const link = r.ticketUrl || r.infoUrl;
      return `<tr${me ? " class=me" : ""}><td>${esc(r.city)}${
        link ? ` <a href="${esc(link)}" target=_blank rel="noopener nofollow">↗</a>` : ""
      }</td><td class=hide>${esc(r.venue)}</td><td class="mono">${esc(r.dates)}</td><td>${st}</td><td>${
        sv ? t(lang, "yes") : t(lang, "no")
      }</td></tr>`;
    })
    .join("");
  return `<table><thead><tr><th>${t(lang, "col_city")}</th><th class=hide>${t(
    lang,
    "col_venue"
  )}</th><th>${t(lang, "col_date")}</th><th>${t(lang, "col_status")}</th><th>${t(
    lang,
    "col_survey"
  )}</th></tr></thead><tbody>${rows || `<tr><td colspan=5 class=hint>—</td></tr>`}</tbody></table>`;
}

/** 批次情报：这是我们抓出来的独家数据，也是唯一能反推香港时间的依据 */
const BATCHES = [
  { at: "2026-06-16T14:00:00Z", cities: "OAKLAND / EAST RUTHERFORD / LONDON / PARIS", win: "5d" },
  { at: "2026-07-21T21:00:00Z", cities: "SYDNEY", win: "4d" },
  { at: "2026-07-29T02:00:00Z", cities: "TAIPEI / SINGAPORE / BANGKOK", win: "4d" },
];

function intel(lang) {
  const L = {
    "zh-hans": [
      "优先购问卷不是一城一开，是<b>整批一起放</b>。已观测到 3 批：",
      "香港（11.13–15）和河内（10.24）是仅剩的两个 COMING SOON。第 3 批覆盖到 11.07 的曼谷，香港只比它晚 6 天，<b>极可能在下一批</b>。",
      "每个窗口只开 <b>4–5 天</b>。错过就只能等公开发售。",
    ],
    "zh-hant": [
      "優先購問卷唔係一城一開，係<b>整批一齊放</b>。已觀測到 3 批：",
      "香港（11.13–15）同河內（10.24）係僅餘兩個 COMING SOON。第 3 批覆蓋到 11.07 嘅曼谷，香港只比佢遲 6 日，<b>極有可能落在下一批</b>。",
      "每個窗口只開 <b>4–5 日</b>。錯過就只可以等公開發售。",
    ],
    en: [
      "Presale surveys don't drop city-by-city — they drop in <b>batches</b>. Three observed so far:",
      "Hong Kong (Nov 13–15) and Hanoi (Oct 24) are the only two still COMING SOON. Batch 3 reached Bangkok on Nov 7 — Hong Kong is only 6 days later, so it is <b>very likely in the next batch</b>.",
      "Each window stays open only <b>4–5 days</b>. Miss it and you're down to general sale.",
    ],
  }[lang];
  return `<p class=hint>${L[0]}</p><table><thead><tr><th>#</th><th>${
    lang === "en" ? "Dropped (HKT/KST)" : lang === "zh-hant" ? "放出時間" : "放出时间"
  }</th><th>${lang === "en" ? "Cities" : lang === "zh-hant" ? "城市" : "城市"}</th><th>${
    lang === "en" ? "Window" : lang === "zh-hant" ? "窗口" : "窗口"
  }</th></tr></thead><tbody>${BATCHES.map(
    (b, i) =>
      `<tr><td>${i + 1}</td><td class=mono>${tz3(b.at)}</td><td>${b.cities}</td><td>${b.win}</td></tr>`
  ).join("")}</tbody></table><p class=hint style="margin-top:12px">${L[1]}</p><p class=hint>${L[2]}</p>`;
}

const FAQ = {
  "zh-hant": [
    ["一定要 V.I.P 會員先買到票？", "唔一定。已開售嘅 4 站都係「會員優先購 → 信用卡/旅遊平台優先購 → 公開發售」三段。冇會員都仲有兩段機會，只係好位少啲。"],
    ["電郵會唔會落推廣分頁？", "我哋用自己域名發事務性電郵：單一收件人、無追蹤像素、無圖、帶 List-Unsubscribe。一般會入主收件匣。真係要穩，加 Telegram 通道。"],
    ["iPhone 收唔收到？", "電郵同 Telegram 一定收到。Web Push 要 iOS 16.4+ 而且要先「加到主畫面」，所以香港用戶我哋主推 Telegram。"],
    ["你哋幾密查一次？", "每 5 分鐘。臨近開售會加密到 1 分鐘。另有一條獨立備份鏈路，主鏈路靜默就會叫我。"],
  ],
  "zh-hans": [
    ["一定要 V.I.P 会员才买得到票吗？", "不一定。已开售的 4 站都是「会员优先购 → 信用卡/旅游平台优先购 → 公开发售」三段。没会员还有两段机会，只是好位少一些。"],
    ["邮件会不会进促销标签页？", "我们用自己域名发事务性邮件：单收件人、零追踪像素、无图片、带 List-Unsubscribe。通常会进主收件箱。要更稳就加 Telegram。"],
    ["iPhone 收得到吗？", "邮件和 Telegram 一定收得到。Web Push 需要 iOS 16.4+ 且要先「加到主屏幕」，所以我们主推 Telegram。"],
    ["多久查一次？", "每 5 分钟。临近开票会加密到 1 分钟。另有一条独立备份链路，主链路静默会报警。"],
  ],
  en: [
    ["Do I need V.I.P membership to get tickets?", "No. All four cities already on sale ran three phases: member presale → card/travel-platform presale → general sale. Without membership you still get two shots, just worse seats."],
    ["Will the email land in Promotions?", "We send transactional mail from our own domain: single recipient, no tracking pixel, no images, List-Unsubscribe header. It normally lands in Primary. Add Telegram if you want certainty."],
    ["Does it work on iPhone?", "Email and Telegram always do. Web Push needs iOS 16.4+ and 'Add to Home Screen', which is why we lead with Telegram."],
    ["How often do you check?", "Every 5 minutes, dropping to 1 minute near a sale. A second independent path alerts us if the main one goes quiet."],
  ],
};

export function renderPage(env, lang, snap, stats) {
  const S = snap?.watch || {};
  const hkSurvey = Object.values(snap?.windows || {})[0];
  const onSale = S.tourStatus === "ON_SALE";
  const status = hkSurvey?.progress === "IN_PROGRESS" ? t(lang, "st_survey") : onSale ? t(lang, "st_onsale") : t(lang, "st_coming");
  const since = env.WATCH_SINCE || "2026-07-29T16:00:00Z";
  const faq = FAQ[lang] || FAQ["zh-hant"];

  return `<!doctype html><html lang="${lang}"><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(t(lang, "title"))} · ${esc(S.dates || "2026.11.13-15")}</title>
<meta name=description content="${esc(t(lang, "tagline"))} — ${esc(t(lang, "sub_hk"))}">
<meta name=color-scheme content=dark>
${LANGS.map((l) => `<link rel=alternate hreflang="${l}" href="/${l}/">`).join("")}
<style>${CSS}</style>
<body><div class=wrap>
<header><div class=brand>BIGBANG · XX : COSMOS<small>${esc(t(lang, "sub_hk"))}</small></div>${langSwitch(lang, "/")}</header>

<h1>${esc(t(lang, "title"))}</h1>
<p class=lede>${esc(t(lang, "tagline"))}</p>

<div class="card hero">
  <span class="pill ${onSale ? "on" : "hot"}">${esc(status)}</span>
  <div class=big>${esc(S.dates || "2026.11.13.(FRI) - 15.(SUN)")}</div>
  <div class=hint>${esc(S.venue || "KAI TAK STADIUM")}</div>
  ${
    hkSurvey
      ? `<div class=kv><span>${lang === "en" ? "Survey opens" : lang === "zh-hant" ? "問卷開放" : "问卷开放"}</span><b class=mono>${esc(
          tz3(hkSurvey.startAt)
        )}</b><span>${lang === "en" ? "Closes" : lang === "zh-hant" ? "問卷關閉" : "问卷关闭"}</span><b class=mono>${esc(
          tz3(hkSurvey.endAt)
        )} · ${esc(rel(hkSurvey.endAt, lang))}</b></div>
         <p style="margin:12px 0 0"><a href="${esc(hkSurvey.url)}" target=_blank rel="noopener nofollow">→ ${
          lang === "en" ? "Open the official survey" : lang === "zh-hant" ? "去官方問卷" : "去官方问卷"
        }</a></p>`
      : `<div class=kv>
        <span>${esc(t(lang, "watching"))}</span><b>${esc(dur(since, lang))}</b>
        <span>${esc(t(lang, "interval"))}</span><b>${esc(env.CRON_LABEL || "5 min")}</b>
        <span>${esc(t(lang, "lastcheck"))}</span><b class=mono>${esc(tz3(snap?.at))}</b>
        </div><p class=hint style="margin:10px 0 0">${esc(t(lang, "tz_note"))}</p>`
  }
</div>

<h2>${esc(t(lang, "h_sub"))}</h2>
<div class=card>
  <div class=tabs id=tabs>
    <button data-c=email aria-pressed=true>Email</button>
    <button data-c=telegram>Telegram</button>
    <button data-c=wechat>${lang === "en" ? "WeChat" : lang === "zh-hant" ? "微信" : "微信"}</button>
  </div>
  <form id=f>
    <input id=v name=v autocomplete=email placeholder="${esc(t(lang, "ph_email"))}" required>
    <button class=go type=submit>${esc(t(lang, "btn_sub"))}</button>
    <p class=hint id=hint>${esc(t(lang, "sub_hint"))}</p>
    <div class=msg id=m></div>
  </form>
  <p class=hint>${
    stats?.count ? `${stats.count} ${lang === "en" ? "people watching" : lang === "zh-hant" ? "人已訂閱" : "人已订阅"}` : ""
  }</p>
</div>

<h2>${esc(t(lang, "h_intel"))}</h2>
<div class=card>${intel(lang)}</div>

<h2>${esc(t(lang, "h_tour"))}</h2>
<div class=card>${tourTable(lang, snap)}</div>

<h2>${esc(t(lang, "h_faq"))}</h2>
<div class=card style="padding-top:4px">${faq
    .map((q) => `<details><summary>${esc(q[0])}</summary><p>${esc(q[1])}</p></details>`)
    .join("")}</div>

<footer>${esc(t(lang, "disclaimer"))}<br>
${lang === "en" ? "Snapshot" : lang === "zh-hant" ? "快照時間" : "快照时间"}: <span class=mono>${esc(
    tz3(snap?.at)
  )}</span>${snap?.errors?.length ? ` · <span style="color:var(--hot)">parse warnings: ${snap.errors.length}</span>` : ""}
</footer>
</div>
<script>
var PH={email:${JSON.stringify(t(lang, "ph_email"))},telegram:${JSON.stringify(
    t(lang, "ph_tg")
  )},wechat:${JSON.stringify(t(lang, "ph_wechat"))}};
var ch='email',v=document.getElementById('v'),m=document.getElementById('m');
document.getElementById('tabs').addEventListener('click',function(e){
  var b=e.target.closest('button'); if(!b)return;
  ch=b.dataset.c; v.placeholder=PH[ch]; v.value='';
  [].forEach.call(this.querySelectorAll('button'),function(x){x.setAttribute('aria-pressed',x===b)});
});
document.getElementById('f').addEventListener('submit',async function(e){
  e.preventDefault(); var btn=this.querySelector('button.go'); btn.disabled=true; m.className='msg';
  try{
    var body={lang:${JSON.stringify(lang)}}; body[ch]=v.value.trim();
    var r=await fetch('/api/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    var j=await r.json();
    m.textContent=j.ok?(j.pending?${JSON.stringify(t(lang, "ok_pending"))}:${JSON.stringify(
    t(lang, "ok_done")
  )}):(j.error||'error');
    m.className='msg '+(j.ok?'ok':'err');
    if(j.ok)v.value='';
  }catch(err){m.textContent=String(err);m.className='msg err';}
  btn.disabled=false;
});
</script>`;
}

/** 极简结果页（确认 / 退订） */
export const simplePage = (msg, lang = "zh-hant") =>
  `<!doctype html><html lang="${lang}"><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${esc(msg)}</title><style>${CSS}</style><body><div class=wrap style="display:grid;place-items:center;min-height:80vh;text-align:center">
<div><p style="font-size:20px">${esc(msg)}</p><p><a href="/${lang}/">${
    lang === "en" ? "Back" : "返回"
  }</a></p></div></div>`;
