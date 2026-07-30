/**
 * 变化检测。原则：
 *  1. 只对「关注城市 + 全局关键变化」报警，不做逐字 diff（否则官网改个错别字就吵一次）。
 *  2. 每条告警有稳定 fingerprint，KV 去重；同一件事永远只发一次。
 *  3. 解析失败也是告警（P2）——静默漏报比误报危险得多。
 */

import { cityMatch } from "./sources.js";

export const SEV = { CRITICAL: "critical", HIGH: "high", INFO: "info", ERROR: "error" };

/** @returns {{alerts:Array, baseline:object}} */
export function diff(prev, snap, watchCity = "HONG KONG") {
  const alerts = [];
  const add = (sev, kind, title, detail, fp, url = "") =>
    alerts.push({ sev, kind, title, detail, fp, url, at: snap.at });

  const w = snap.watch || {};
  const p = prev?.watch || null;

  // ---------- 1. 关注城市的 V.I.P 优先购问卷出现（这就是用户真正等的那一刻）
  const prevIds = new Set((p?.surveys || []).map((s) => s.id));
  for (const s of w.surveys || []) {
    if (!prevIds.has(s.id)) {
      const win = snap.windows?.[s.id];
      add(
        SEV.CRITICAL,
        "survey_open",
        `${watchCity} V.I.P 优先购问卷已开放`,
        win
          ? `窗口 ${win.startAt} → ${win.endAt} (UTC)　状态 ${win.progress}`
          : s.title,
        `survey:${s.id}`,
        `https://bigbang.bstage.in${s.path}`
      );
    }
  }

  // ---------- 2. 问卷状态翻转（BEFORE→IN_PROGRESS，或即将关闭）
  for (const [id, win] of Object.entries(snap.windows || {})) {
    const before = prev?.windows?.[id];
    if (before && before.progress !== win.progress) {
      add(
        win.progress === "IN_PROGRESS" ? SEV.CRITICAL : SEV.HIGH,
        "survey_status",
        `${watchCity} 问卷状态变化：${before.progress} → ${win.progress}`,
        `${win.startAt} → ${win.endAt} (UTC)`,
        `svstat:${id}:${win.progress}`,
        win.url
      );
    }
    if (before && (before.startAt !== win.startAt || before.endAt !== win.endAt)) {
      add(
        SEV.HIGH,
        "survey_window",
        `${watchCity} 问卷时间被改了`,
        `旧 ${before.startAt}→${before.endAt}　新 ${win.startAt}→${win.endAt}`,
        `svwin:${id}:${win.startAt}:${win.endAt}`,
        win.url
      );
    }
  }

  // ---------- 3. 官方巡演页：关注城市从 COMING SOON 变成可买票
  if (p && p.tourStatus !== w.tourStatus) {
    add(
      w.tourStatus === "ON_SALE" ? SEV.CRITICAL : SEV.HIGH,
      "onsale",
      w.tourStatus === "ON_SALE"
        ? `${watchCity} 官网已挂出购票链接`
        : `${watchCity} 官网状态变化：${p.tourStatus} → ${w.tourStatus}`,
      `${w.venue} ${w.dates}`.trim(),
      `tour:${watchCity}:${w.tourStatus}`,
      w.ticketUrl || w.infoUrl
    );
  }
  // 购票链接本身变了（换售票商 / 加场次）也要知道
  const pu = (p?.ticketUrl || "") + "|" + (p?.infoUrl || "");
  const cu = (w.ticketUrl || "") + "|" + (w.infoUrl || "");
  if (p && pu !== cu && cu !== "|") {
    add(SEV.HIGH, "links", `${watchCity} 官网链接更新`, cu, `links:${watchCity}:${cu}`, w.ticketUrl || w.infoUrl);
  }

  // ---------- 4. NOTICE 里出现关注城市的票务公告（通常比问卷早半天到一天）
  const prevN = new Set((prev?.notices || []).map((n) => n.id));
  for (const n of snap.notices || []) {
    if (prevN.has(n.id)) continue;
    const hk = cityMatch(n.title, watchCity);
    add(
      hk ? SEV.CRITICAL : SEV.INFO,
      "notice",
      hk ? `${watchCity} 票务公告发布` : `新公告：${n.title.slice(0, 70)}`,
      n.title,
      `notice:${n.id}`,
      `https://bigbang.bstage.in${n.path}`
    );
  }

  // ---------- 5. 其它城市新问卷 = 新一批放出。香港没在里面也值得知道（判断节奏）
  const prevAll = new Set((prev?.surveys || []).map((s) => s.id));
  const newOther = (snap.surveys || []).filter(
    (s) => !prevAll.has(s.id) && !cityMatch(s.title, watchCity)
  );
  if (newOther.length && prev) {
    add(
      SEV.INFO,
      "batch",
      `新一批优先购问卷放出（${newOther.length} 个城市）`,
      newOther.map((s) => s.city || s.title.slice(0, 40)).join("、") +
        `　—— ${watchCity} 不在这批里`,
      `batch:${newOther.map((s) => s.id).sort().join(",").slice(0, 80)}`
    );
  }

  // ---------- 6. 抓取/解析失败
  for (const e of snap.errors || []) {
    add(SEV.ERROR, "scrape_error", "抓取或解析失败", e, `err:${e}:${snap.at.slice(0, 13)}`);
  }
  // 页面还在但关注城市整行消失 = 结构变了或演出被取消，两种都必须人工看
  if (w.tourStatus === "NOT_LISTED" && (snap.tour || []).length > 0) {
    add(SEV.HIGH, "missing", `${watchCity} 在官网巡演表里消失了`, `共解析到 ${snap.tour.length} 个城市`, `missing:${snap.at.slice(0, 13)}`);
  }

  return { alerts, baseline: snap };
}

/** 是否需要立刻推给用户（INFO 只进看板和日报，不半夜叫人） */
export const pushWorthy = (a) => a.sev === SEV.CRITICAL || a.sev === SEV.HIGH;
