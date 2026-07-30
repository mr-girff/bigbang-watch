/**
 * 三语言：简体 / 繁体（香港用词，不是台湾用词）/ 英文。
 * 繁体刻意用「門票 / 開售 / 優先購 / 場館 / 預售 / 撲票」，不用台湾的「售票 / 搶票」写法。
 */

export const LANGS = ["zh-hans", "zh-hant", "en"];
export const DEFAULT_LANG = "zh-hant"; // 面向香港受众

export const T = {
  "zh-hans": {
    dir: "简体中文",
    title: "BIGBANG 香港站开票提醒",
    tagline: "官网一有动静，5 分钟内通知你",
    sub_hk: "香港站 · 啟德体育园",
    st_coming: "门票尚未开售",
    st_onsale: "已开售",
    st_survey: "V.I.P 优先购问卷进行中",
    watching: "已持续监控",
    interval: "检查间隔",
    lastcheck: "最近检查",
    h_sub: "订阅提醒",
    sub_hint: "填一个就够。不注册、不设密码、随时一键退订。",
    ph_email: "邮箱（推荐，全平台都收得到）",
    ph_tg: "Telegram：先私聊 bot 发 /start，把回复的数字填这里",
    ph_wechat: "微信号或手机号（内地用户，人工拉群）",
    btn_sub: "订阅",
    ok_pending: "已发确认邮件，请点开里面的链接完成订阅（查一下促销/垃圾箱）。",
    ok_done: "订阅成功。香港站一有动静就通知你。",
    h_tour: "全巡演状态",
    h_intel: "情报：优先购问卷是按批次放的",
    h_faq: "常见问题",
    h_log: "更新日志",
    col_city: "城市",
    col_venue: "场馆",
    col_date: "日期",
    col_status: "状态",
    col_survey: "优先购问卷",
    yes: "已开",
    no: "未开",
    tz_note: "官网只给韩国时间（KST），下面同时标了香港时间（HKT）和倒计时。",
    disclaimer:
      "非官方粉丝工具，与 YG Entertainment / b.stage 无任何关联。数据来源：YG Family 官网、BIGBANG b.stage 公开页面。",
    unsub_ok: "已退订，不会再收到任何提醒。",
    unsub_bad: "链接无效或已失效。",
    verify_ok: "确认完成，订阅已生效。",
    verify_bad: "确认链接无效或已过期。",
  },
  "zh-hant": {
    dir: "繁體中文",
    title: "BIGBANG 香港場開售提醒",
    tagline: "官網一有動靜，5 分鐘內通知你",
    sub_hk: "香港場 · 啟德體育園",
    st_coming: "門票尚未開售",
    st_onsale: "已開售",
    st_survey: "V.I.P 優先購問卷進行中",
    watching: "已持續監控",
    interval: "檢查間隔",
    lastcheck: "最近檢查",
    h_sub: "訂閱提醒",
    sub_hint: "填一個就夠。毋須註冊、毋須密碼、隨時一鍵取消。",
    ph_email: "電郵（推薦，所有平台都收得到）",
    ph_tg: "Telegram：先私訊 bot 發 /start，把回覆的數字填這裡",
    ph_wechat: "微信號或手機號（內地用戶，人手拉群）",
    btn_sub: "訂閱",
    ok_pending: "已發確認電郵，請開啟裡面的連結完成訂閱（記得查一下推廣/垃圾郵件）。",
    ok_done: "訂閱成功。香港場一有動靜就通知你。",
    h_tour: "全巡演狀態",
    h_intel: "情報：優先購問卷是分批放出的",
    h_faq: "常見問題",
    h_log: "更新記錄",
    col_city: "城市",
    col_venue: "場館",
    col_date: "日期",
    col_status: "狀態",
    col_survey: "優先購問卷",
    yes: "已開",
    no: "未開",
    tz_note: "官網只給韓國時間（KST），下面同時標了香港時間（HKT）同倒數。",
    disclaimer:
      "非官方粉絲工具，與 YG Entertainment / b.stage 並無任何關聯。資料來源：YG Family 官網、BIGBANG b.stage 公開頁面。",
    unsub_ok: "已取消訂閱，不會再收到任何提醒。",
    unsub_bad: "連結無效或已失效。",
    verify_ok: "確認完成，訂閱已生效。",
    verify_bad: "確認連結無效或已過期。",
  },
  en: {
    dir: "English",
    title: "BIGBANG Hong Kong — Ticket Alert",
    tagline: "We watch the official pages. You get told within 5 minutes.",
    sub_hk: "Hong Kong · Kai Tak Stadium",
    st_coming: "Tickets not on sale yet",
    st_onsale: "On sale",
    st_survey: "V.I.P presale survey open",
    watching: "Watching for",
    interval: "Check interval",
    lastcheck: "Last check",
    h_sub: "Get alerted",
    sub_hint: "One field is enough. No account, no password, one-click unsubscribe.",
    ph_email: "Email (recommended, works everywhere)",
    ph_tg: "Telegram: DM the bot /start, paste the number it replies",
    ph_wechat: "WeChat ID or phone (mainland users)",
    btn_sub: "Subscribe",
    ok_pending: "Confirmation email sent — click the link inside to finish (check Promotions/Spam).",
    ok_done: "You're in. We'll ping you the moment Hong Kong moves.",
    h_tour: "Full tour status",
    h_intel: "Intel: presale surveys drop in batches",
    h_faq: "FAQ",
    h_log: "Changelog",
    col_city: "City",
    col_venue: "Venue",
    col_date: "Date",
    col_status: "Status",
    col_survey: "Presale survey",
    yes: "open",
    no: "—",
    tz_note: "The official site only shows KST. We show HKT and a countdown too.",
    disclaimer:
      "Unofficial fan tool. Not affiliated with YG Entertainment or b.stage. Sources: YG Family official site, BIGBANG b.stage public pages.",
    unsub_ok: "Unsubscribed. You won't hear from us again.",
    unsub_bad: "This link is invalid or expired.",
    verify_ok: "Confirmed. Your subscription is active.",
    verify_bad: "This confirmation link is invalid or expired.",
  },
};

export const t = (lang, k) => (T[lang] || T[DEFAULT_LANG])[k] ?? (T[DEFAULT_LANG][k] || k);

/** Accept-Language → 我们支持的三种之一。香港优先给繁体。 */
export function pickLang(req) {
  const c = (req.headers.get("cookie") || "").match(/(?:^|;\s*)lang=([\w-]+)/);
  if (c && LANGS.includes(c[1])) return c[1];
  const al = (req.headers.get("accept-language") || "").toLowerCase();
  const country = (req.headers.get("cf-ipcountry") || "").toUpperCase();
  if (/zh-hant|zh-tw|zh-hk|zh-mo/.test(al)) return "zh-hant";
  if (/zh-hans|zh-cn|zh-sg|^zh\b|,zh\b/.test(al)) return country === "HK" || country === "MO" ? "zh-hant" : "zh-hans";
  if (/^zh/.test(al)) return "zh-hant";
  if (country === "HK" || country === "MO" || country === "TW") return "zh-hant";
  if (country === "CN") return "zh-hans";
  return "en";
}

/* ------------------------------------------------------- 时间：三写 */
const P2 = (n) => String(n).padStart(2, "0");

/** UTC ISO → 「2026-08-04 10:00 HKT / 11:00 KST」 */
export function tz3(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const f = (off) => {
    const x = new Date(d.getTime() + off * 3600e3);
    return `${x.getUTCFullYear()}-${P2(x.getUTCMonth() + 1)}-${P2(x.getUTCDate())} ${P2(x.getUTCHours())}:${P2(x.getUTCMinutes())}`;
  };
  return `${f(8)} HKT / ${f(9)} KST`;
}

/** 相对时间，三语言 */
export function rel(iso, lang = DEFAULT_LANG, from = Date.now()) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - from;
  const past = ms < 0;
  const s = Math.abs(ms) / 1000;
  const d = Math.floor(s / 86400),
    h = Math.floor((s % 86400) / 3600),
    m = Math.floor((s % 3600) / 60);
  if (lang === "en") {
    const p = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
    return past ? `${p} ago` : `in ${p}`;
  }
  const p = d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分`;
  const q = lang === "zh-hant" ? p.replace("小时", "小時") : p;
  return past ? `${q}前` : (lang === "zh-hant" ? `還剩 ${q}` : `还剩 ${q}`);
}

/** 纯时长（不带「前」「还剩」），用于「已持续监控 X」 */
export function dur(iso, lang = DEFAULT_LANG, from = Date.now()) {
  const s = Math.abs(from - new Date(iso).getTime()) / 1000;
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (lang === "en") return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  const u = lang === "zh-hant" ? ["天", "小時", "分"] : ["天", "小时", "分"];
  return d ? `${d} ${u[0]} ${h} ${u[1]}` : h ? `${h} ${u[1]} ${m} ${u[2]}` : `${m} ${u[2]}`;
}

/* ------------------------------------------------------- 告警文案（按订阅者语言发） */
export function renderAlert(a, lang = DEFAULT_LANG, origin = "") {
  const head =
    a.sev === "critical" ? (lang === "en" ? "🚨 ACTION NEEDED" : "🚨 要立即行動") : lang === "en" ? "🔔 Update" : "🔔 有更新";
  const win = a.detail && /→/.test(a.detail) ? a.detail : "";
  const lines = [
    `${head}｜${a.title}`,
    a.detail ? a.detail : "",
    win ? (lang === "en" ? `(times above are UTC)` : `（上面是 UTC 时间）`) : "",
    a.url ? a.url : "",
    origin ? origin : "",
  ].filter(Boolean);
  return { subject: `${a.sev === "critical" ? "[ACTION] " : ""}${a.title}`, text: lines.join("\n") };
}
