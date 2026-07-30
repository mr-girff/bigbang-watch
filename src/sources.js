/**
 * 三个数据源的抓取 + 解析。全部纯 HTML / 正则，不需要浏览器。
 * 解析规则已用 2026-07-30 的真实页面逐条验证过（见 README 的「实测」一节）。
 *
 *   1. YG 官方巡演页   → 每城 城市/场馆/日期/售票状态/购票链接
 *   2. b.stage /tag/SURVEY → V.I.P 优先购问卷列表
 *   3. b.stage /surveys/<id> → progressStatus / progressStartAt / progressEndAt（精确窗口）
 *   4. b.stage /tag/NOTICE   → 官方公告（票务细则通常先在这里出）
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 " +
  "(+bigbang-hk watcher; 5min interval; contact via site footer)";

export const YG_URL =
  "https://artist.ygfamily.com/ARTISTS/BIGBANG/concert/worldtour/index.html";
export const BSTAGE = "https://bigbang.bstage.in";

const unesc = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, d) => String.fromCharCode(parseInt(d, 16)));

const txt = (s) => unesc(String(s || "").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

async function get(url, timeoutMs = 12000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: c.signal,
      headers: { "user-agent": UA, accept: "text/html,*/*", "accept-language": "en-US,en;q=0.9" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.text();
    if (body.length < 500) throw new Error(`body too small (${body.length})`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ YG 巡演页
 * 结构（已验证）：
 *   <div class="row">
 *     <div class="left">
 *       <div class="item1">HONG KONG</div>
 *       <div class="item2">KAI TAK STADIUM</div>
 *       <div class="more"><a href="...">+ MORE INFO</a></div>   ← 可能没有
 *     </div>
 *     <div class="right">
 *       <div class="item4">2026.11.13.(FRI) - 15.(SUN)</div>
 *       <div class="buyticket"> <button3> COMING SOON </button3> </div>
 *     </div>
 *   </div>
 *
 * 售票开了以后，单一售票商是 .buyticket，多个入口（分场次 / DOMESTIC+GLOBAL）
 * 会变成 <div class="t2"> 且带 <small>09.04.(FRI)</small> 标签。
 * 香港是 3 天连演，开票时几乎肯定是 t2 多链接形态 —— 所以这里不认死 class，
 * 直接扫整个 .right 里所有 btn-buy。
 */
export function parseYG(htmlText) {
  const rows = htmlText.split(/<div class="row">/i).slice(1);
  const out = [];
  for (const raw of rows) {
    const block = raw.split(/<div class="row">/i)[0];
    const city = txt((block.match(/class="item1"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
    if (!city) continue;
    const venue = txt((block.match(/class="item2"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
    const dates = txt((block.match(/class="item4"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
    const right = (block.match(/class="right"[\s\S]*$/i) || [block])[0];
    const infoUrl = (block.match(/class="more"[\s\S]*?href="([^"]+)"/i) || [])[1] || "";

    const tickets = [];
    const re = /<a\s[^>]*href="([^"]+)"[^>]*class="btn-buy"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(right))) {
      const small = txt((m[2].match(/<small>([\s\S]*?)<\/small>/i) || [])[1]);
      tickets.push({ url: m[1], label: small || "GET TICKETS" });
    }

    const onSale = tickets.length > 0;
    out.push({
      city,
      venue,
      dates,
      status: onSale
        ? "ON_SALE"
        : /COMING\s*SOON/i.test(txt(right))
        ? "COMING_SOON"
        : "UNKNOWN",
      tickets,
      ticketUrl: onSale ? tickets[0].url : "",
      infoUrl,
    });
  }
  if (out.length < 5) throw new Error(`YG parse suspicious: only ${out.length} rows`);
  return out;
}

/* -------------------------------------------------- b.stage 列表页（SURVEY / NOTICE）
 * 结构（已验证）：<a href="/surveys/<24hex>">[CITY] TITLE</a>  ／  /contents/<24hex>
 */
export function parseList(htmlText, kind) {
  const seg = kind === "survey" ? "surveys" : "contents";
  const re = new RegExp(`href="(/${seg}/([a-f0-9]{24}))"[^>]*>([^<]{5,300})<\\/a>`, "gi");
  const seen = new Map();
  let m;
  while ((m = re.exec(htmlText))) {
    const title = unesc(m[3]).replace(/\s+/g, " ").trim();
    if (!seen.has(m[2])) {
      const c = title.match(/^\[([A-Z][A-Z .'-]+)\]/);
      seen.set(m[2], { id: m[2], path: m[1], title, city: c ? c[1].trim() : "" });
    }
  }
  return [...seen.values()];
}

/* ---------------------------------------------- b.stage 问卷详情：精确窗口
 * 结构（已验证）：内嵌 JSON
 *   "progressStatus":"IN_PROGRESS","progressStartAt":"2026-07-29T02:00:00Z",
 *   "progressEndAt":"2026-08-02T17:00:00Z"
 */
export function parseWindow(htmlText) {
  const m = htmlText.match(
    /"progressStatus":"([A-Z_]+)","progressStartAt":"([^"]+)","progressEndAt":"([^"]+)"/
  );
  if (!m) return null;
  return { progress: m[1], startAt: m[2], endAt: m[3] };
}

/* ------------------------------------------------------------------ 汇总
 * 每个源独立 try/catch：一个挂掉不影响其它源，而且「解析失败」本身也要报警——
 * 静默漏报是这个产品最危险的失效模式。
 */
export async function collect(watchCity = "HONG KONG") {
  const snap = {
    at: new Date().toISOString(),
    errors: [],
    tour: [],
    surveys: [],
    notices: [],
    windows: {},
  };

  await Promise.all([
    (async () => {
      try {
        snap.tour = parseYG(await get(YG_URL));
      } catch (e) {
        snap.errors.push(`yg: ${e.message}`);
      }
    })(),
    (async () => {
      try {
        snap.surveys = parseList(await get(`${BSTAGE}/tag/SURVEY`), "survey");
      } catch (e) {
        snap.errors.push(`survey-list: ${e.message}`);
      }
    })(),
    (async () => {
      try {
        snap.notices = parseList(await get(`${BSTAGE}/tag/NOTICE`), "notice");
      } catch (e) {
        snap.errors.push(`notice-list: ${e.message}`);
      }
    })(),
  ]);

  // 只对「关注城市」拉详情页，省请求也省时间；命中即拿到精确开关窗时间。
  const hit = snap.surveys.filter((s) => cityMatch(s.title, watchCity));
  for (const s of hit.slice(0, 3)) {
    try {
      const w = parseWindow(await get(`${BSTAGE}${s.path}`));
      if (w) snap.windows[s.id] = { ...w, title: s.title, url: `${BSTAGE}${s.path}` };
    } catch (e) {
      snap.errors.push(`window ${s.id}: ${e.message}`);
    }
  }

  const c = snap.tour.find((r) => cityMatch(r.city, watchCity));
  snap.watch = {
    city: watchCity,
    tourStatus: c ? c.status : "NOT_LISTED",
    venue: c ? c.venue : "",
    dates: c ? c.dates : "",
    ticketUrl: c ? c.ticketUrl : "",
    infoUrl: c ? c.infoUrl : "",
    surveyOpen: hit.length > 0,
    surveys: hit,
  };
  return snap;
}

/** 香港的别名都要认：HONG KONG / HONGKONG / KAI TAK / 啟德 / 香港 */
export function cityMatch(s, city) {
  const t = String(s || "").toUpperCase();
  if (city.toUpperCase() === "HONG KONG")
    return /HONG\s*KONG|HONGKONG|KAI\s*TAK|啟德|启德|香港/.test(t);
  return t.includes(city.toUpperCase());
}
