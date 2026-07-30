/**
 * 推送通道。设计规则：
 *  - 邮件双通道：主 Cloudflare Email Service，失败自动落 Resend。两条都用你自己的域名。
 *  - 每一次投递都写 KV（`d:` 前缀，90 天过期）。没有送达日志就没法向用户举证，
 *    也没法自己发现「某通道昨天挂了 3 小时」。这是「5 分钟必达否则退款」的技术前提。
 *  - 任何通道抛错都不能影响其它通道，也不能影响 cron 本身。
 *
 * CF Email 端点已按官方文档核对：
 *   POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send
 *   body: { to, from, subject, html, text }
 *   需要 Workers Paid（US$5/月）才能发给任意收件人；Free 计划只能发给自己账号内已验证地址。
 */

const now = () => Date.now();

async function logDelivery(env, rec) {
  try {
    const k = `d:${new Date().toISOString()}:${crypto.randomUUID().slice(0, 8)}`;
    await env.SUBS.put(k, JSON.stringify(rec), { expirationTtl: 90 * 86400 });
  } catch {
    /* 日志失败绝不能影响投递 */
  }
}

/* ------------------------------------------------------------------ 邮件 */

async function cfEmail(env, to, subject, text, html) {
  if (!env.CF_ACCOUNT_ID || !env.CF_EMAIL_TOKEN || !env.MAIL_FROM) throw new Error("cf-email not configured");
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/sending/send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CF_EMAIL_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to, from: env.MAIL_FROM, subject, text, html }),
    }
  );
  if (!r.ok) throw new Error(`cf ${r.status} ${(await r.text()).slice(0, 180)}`);
  return "cf-email";
}

async function resendEmail(env, to, subject, text, html, unsubUrl) {
  if (!env.RESEND_KEY || !env.MAIL_FROM) throw new Error("resend not configured");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: `${env.MAIL_FROM_NAME || "BIGBANG HK Watch"} <${env.MAIL_FROM}>`,
      to: [to],
      subject,
      text,
      html,
      // List-Unsubscribe 是进主收件箱的关键之一，也是 CAN-SPAM/GDPR 的硬要求
      headers: unsubUrl
        ? { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
        : undefined,
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status} ${(await r.text()).slice(0, 180)}`);
  return "resend";
}

/** 主→备自动切换。返回 {ok, provider, error, ms} */
export async function sendEmail(env, to, subject, text, html, unsubUrl) {
  const t0 = now();
  const order = env.MAIL_PRIMARY === "resend" ? [resendEmail, cfEmail] : [cfEmail, resendEmail];
  const errs = [];
  for (const fn of order) {
    try {
      const provider = await fn(env, to, subject, text, html, unsubUrl);
      const out = { ok: true, provider, ms: now() - t0 };
      await logDelivery(env, { ch: "email", to, subject, ...out });
      return out;
    } catch (e) {
      errs.push(e.message);
    }
  }
  const out = { ok: false, provider: "none", error: errs.join(" / "), ms: now() - t0 };
  await logDelivery(env, { ch: "email", to, subject, ...out });
  return out;
}

/* ------------------------------------------------------------------ Telegram
 * 香港/海外主通道：秒级、免费、iOS 原生 App，不依赖 PWA。
 * chat_id 是一人一凭据，不像 ntfy topic 那样能被转发白嫖。
 */
export async function sendTelegram(env, chatId, text) {
  const t0 = now();
  if (!env.TG_BOT_TOKEN) return { ok: false, error: "TG_BOT_TOKEN missing" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
    const ok = r.ok;
    const out = { ok, provider: "telegram", ms: now() - t0, error: ok ? undefined : (await r.text()).slice(0, 180) };
    await logDelivery(env, { ch: "telegram", to: String(chatId), ...out });
    return out;
  } catch (e) {
    const out = { ok: false, provider: "telegram", error: e.message, ms: now() - t0 };
    await logDelivery(env, { ch: "telegram", to: String(chatId), ...out });
    return out;
  }
}

/* ------------------------------------------------------------------ 微信（PushPlus） */
export async function sendPushPlus(env, token, title, content) {
  const t0 = now();
  try {
    const r = await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, title, content, template: "txt" }),
    });
    const j = await r.json().catch(() => ({}));
    const ok = r.ok && j.code === 200;
    const out = { ok, provider: "pushplus", ms: now() - t0, error: ok ? undefined : JSON.stringify(j).slice(0, 180) };
    await logDelivery(env, { ch: "wechat", to: String(token).slice(0, 8), ...out });
    return out;
  } catch (e) {
    return { ok: false, provider: "pushplus", error: e.message, ms: now() - t0 };
  }
}

/* ------------------------------------------------------------------ ntfy 广播
 * 只当免费层的公共频道用。topic 是公开 URL，任何人知道名字都能订阅，
 * 所以绝不能拿它做付费层的通道。
 */
export async function sendNtfy(env, title, body, urgent) {
  if (!env.NTFY_TOPIC) return { ok: false, error: "NTFY_TOPIC missing" };
  const srv = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
  try {
    const r = await fetch(`${srv}/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: title.replace(/[^\x20-\x7e]/g, "?").slice(0, 120),
        Priority: urgent ? "urgent" : "default",
        Tags: urgent ? "rotating_light" : "bell",
      },
      body,
    });
    return { ok: r.ok, provider: "ntfy" };
  } catch (e) {
    return { ok: false, provider: "ntfy", error: e.message };
  }
}

/** 只发给你自己（运维告警：解析失败、CF 静默、新订阅） */
export async function sendOps(env, title, body) {
  const jobs = [];
  if (env.OPS_TG_CHAT) jobs.push(sendTelegram(env, env.OPS_TG_CHAT, `⚙️ <b>${title}</b>\n${body}`));
  if (env.NTFY_TOPIC)
    jobs.push(
      fetch(`${(env.NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "")}/${env.NTFY_TOPIC}-admin`, {
        method: "POST",
        headers: { Title: "ops", Priority: "low" },
        body: `${title}\n${body}`,
      }).catch(() => {})
    );
  await Promise.allSettled(jobs);
}
