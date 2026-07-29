#!/usr/bin/env python3
"""
BIGBANG 香港站票务监控 v2 —— 只用 Python 标准库，无需 pip install。

监控 4 个源（全部纯 HTTP，不需要浏览器）：
  1. YG 官方巡演页：HONG KONG 那一行 COMING SOON -> GET TICKETS
  2. b.stage /tag/SURVEY  ：新 SURVEY 出现 + 登记窗口起止时间（服务端渲染的 JSON）
  3. b.stage /tag/NOTICE  ：新公告出现
  4. b.stage sitemap.xml  ：拿到可点击的 /surveys/<id> 真实链接

通知方式（按可用性自动选）：
  A. GitHub Issue —— 在本仓库开 issue 并 @你，GitHub 自动把邮件发到你的账号邮箱。
     跑在 GitHub Actions 里就自动可用，不需要任何邮箱配置。
  B. SMTP 邮件 —— 如果配了 SMTP_* 环境变量，额外再发一封。

用法：
  python3 watch.py            # 检查一次
  python3 watch.py --dry-run  # 只检查，不发通知、不写状态
  python3 watch.py --test     # 发一条测试通知，验证链路
"""

import json
import os
import re
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from email.header import Header
from email.mime.text import MIMEText

# ---------------------------------------------------------------- 配置

YG_URL = os.environ.get(
    "YG_URL", "https://artist.ygfamily.com/ARTISTS/BIGBANG/concert/worldtour/index.html")
BSTAGE = "https://bigbang.bstage.in"
TAG_URLS = {"SURVEY": f"{BSTAGE}/tag/SURVEY", "NOTICE": f"{BSTAGE}/tag/NOTICE"}
SITEMAP_URL = os.environ.get("SITEMAP_URL", f"{BSTAGE}/sitemap.xml")

CITY = os.environ.get("WATCH_CITY", "HONG KONG").upper()
HOT = [w.strip().upper() for w in os.environ.get(
    "WATCH_KEYWORDS", "HONG KONG,HONGKONG,KAI TAK,HK").split(",") if w.strip()]

STATE_FILE = os.environ.get("STATE_FILE", "state.json")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
CST = timezone(timedelta(hours=8))

TODO = """--- 收到这封邮件后立刻做 ---
1. 打开 https://bigbang.bstage.in/tag/SURVEY 完成 [HONG KONG] SURVEY 登记
   （窗口通常只有 3-5 天，不登记 = 会员码作废，进不了优先购）
2. 记下会员优先购 / 公开发售的日期时间，马上设手机闹钟
3. 注册香港票务平台账号，做完手机+邮箱验证，绑好 Visa/Master 并小额试刷
4. 查取票方式：如果要当天中午前取实体票，深圳往返行程要相应调整
5. 准备好所有人的港澳通行证号（实名制，买票后改不了名）"""


def now_cst():
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S CST")


def to_cst(iso):
    """'2026-08-02T17:00:00Z' -> '2026-08-03 01:00 CST（周一）'"""
    if not iso:
        return ""
    m = re.match(r"(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})", iso)
    if not m:
        return iso
    try:
        d = datetime.strptime(f"{m.group(1)}T{m.group(2)}+0000", "%Y-%m-%dT%H:%M:%S%z")
        d = d.astimezone(CST)
        wd = "一二三四五六日"[d.weekday()]
        return d.strftime("%Y-%m-%d %H:%M") + f" CST（周{wd}）"
    except ValueError:
        return iso


# ---------------------------------------------------------------- HTTP

def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Accept-Language": "en,zh-CN;q=0.9"})
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:            # noqa: BLE001
            last = e
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"取 {url} 失败: {last}")


def strip_tags(s):
    s = re.sub(r"<[^>]+>", " ", s)
    for a, b in (("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"),
                 ("&nbsp;", " "), ("&quot;", '"'), ("&#39;", "'")):
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


# ---------------------------------------------------------------- 源 1：YG 官网

def check_yg():
    html = get(YG_URL)
    block = next((b for b in re.split(r'<div class="row">', html)
                  if re.search(r'class="item1"\s*>\s*' + re.escape(CITY), b, re.I)), None)
    if block is None:
        return {"found": False}
    block = block.split('<div class="row"')[0]
    ticket = re.search(r'href="([^"]+)"[^>]*class="btn-buy"', block)
    info = re.search(r'href="([^"]+)"[^>]*class="btn-info"', block)
    when = re.search(r'class="item4"\s*>([^<]*)<', block)
    return {
        "found": True,
        "coming_soon": bool(re.search(r"COMING\s+SOON", block, re.I)),
        "get_tickets": bool(re.search(r"GET\s+TICKETS", block, re.I)),
        "ticket_url": ticket.group(1) if ticket else "",
        "info_url": info.group(1) if info else "",
        "when": strip_tags(when.group(1)) if when else "",
        "row_text": strip_tags(block),
    }


# ---------------------------------------------------------------- 源 2/3：b.stage tag 页

def check_tag(url):
    """b.stage 的 /tag/XXX 是服务端渲染的 Next.js 页，条目藏在 __NEXT_DATA__ 里。"""
    html = get(url)
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise RuntimeError(f"{url} 里没有 __NEXT_DATA__，页面结构可能改了")
    items = json.loads(m.group(1))["props"]["pageProps"]["data"]["items"]
    return [{
        "id": it.get("id", ""),
        "title": strip_tags(it.get("title", "")),
        "in_progress": it.get("inProgress"),
        "start": it.get("progressStartAt", ""),
        "end": it.get("progressEndAt", ""),
    } for it in items]


def check_sitemap():
    """拿可点击的真实 /surveys/<id> 链接。"""
    locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", get(SITEMAP_URL))
    return sorted(p.replace(BSTAGE, "") for p in locs
                  if "/surveys/" in p or "/contents/" in p)


# ---------------------------------------------------------------- 状态

def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(st):
    st["updated_at"] = now_cst()
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, indent=2, sort_keys=True)


# ---------------------------------------------------------------- 通知 A：GitHub Issue

def gh_issue(title, body):
    tok = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not (tok and repo):
        return False
    who = os.environ.get("NOTIFY_USER", repo.split("/")[0])
    payload = json.dumps({
        "title": title[:250],
        "body": f"@{who}\n\n```\n{body}\n```\n",
    }).encode()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/issues", data=payload,
        headers={"Authorization": f"Bearer {tok}",
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "bigbang-watch",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print(f"已开 GitHub Issue #{json.load(r)['number']}（GitHub 会把邮件发到你账号邮箱）")
        return True
    except Exception as e:                # noqa: BLE001
        print(f"!! 开 Issue 失败: {e}")
        return False


# ---------------------------------------------------------------- 通知 B：SMTP

def smtp_mail(subject, body):
    host, user = os.environ.get("SMTP_HOST", ""), os.environ.get("SMTP_USER", "")
    pw = os.environ.get("SMTP_PASS", "")
    to = [x.strip() for x in os.environ.get("MAIL_TO", user).split(",") if x.strip()]
    if not (host and user and pw and to):
        return False
    port = int(os.environ.get("SMTP_PORT", "465"))
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"], msg["From"], msg["To"] = Header(subject, "utf-8"), user, ", ".join(to)
    try:
        ctx = ssl.create_default_context()
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) as s:
                s.login(user, pw)
                s.sendmail(user, to, msg.as_string())
        else:
            with smtplib.SMTP(host, port, timeout=30) as s:
                s.starttls(context=ctx)
                s.login(user, pw)
                s.sendmail(user, to, msg.as_string())
        print(f"SMTP 邮件已发 -> {', '.join(to)}")
        return True
    except Exception as e:                # noqa: BLE001
        print(f"!! SMTP 发送失败: {e}")
        return False


def notify(subject, body):
    a = gh_issue(subject, body)
    b = smtp_mail(subject, body)
    if not (a or b):
        print("!! 没有任何可用通知渠道，内容如下：\n" + body)
    return a or b


# ---------------------------------------------------------------- 主流程

def main():
    dry = "--dry-run" in sys.argv

    if "--test" in sys.argv:
        ok = notify(f"[测试] BIGBANG {CITY} 监控链路正常",
                    f"这是一条测试通知。\n时间：{now_cst()}\n监控城市：{CITY}\n"
                    f"你收到这封邮件，说明提醒链路是通的。\n\n{TODO}")
        sys.exit(0 if ok else 1)

    st = load_state()
    first = not st.get("yg") and not st.get("tags")
    sent_keys = set(st.get("sent", []))
    alerts, errors = [], []          # alerts: (level, key, title, detail)

    # ---- 源 1
    try:
        yg = check_yg()
        old = st.get("yg") or {}
        if not yg["found"]:
            errors.append(f"YG 页面里找不到 {CITY} 这一行 —— 页面结构可能改了，去人工看一眼。")
        else:
            if old and not first:
                if old.get("coming_soon") and not yg["coming_soon"]:
                    alerts.append(("CRITICAL", "yg-open",
                                   f"{CITY} 票务开了！COMING SOON 消失了",
                                   f"购票链接: {yg['ticket_url'] or '(暂无)'}\n"
                                   f"详情页:   {yg['info_url'] or '(暂无)'}\n"
                                   f"场次时间: {yg['when']}"))
                elif yg["get_tickets"] and not old.get("get_tickets"):
                    alerts.append(("CRITICAL", "yg-btn",
                                   f"{CITY} 出现 GET TICKETS 按钮",
                                   f"购票链接: {yg['ticket_url']}"))
                elif yg["row_text"] != old.get("row_text"):
                    alerts.append(("WARN", "yg-row-" + str(abs(hash(yg["row_text"])))[:8],
                                   f"{CITY} 那一行内容变了（可能补上了开演时间）",
                                   f"旧: {old.get('row_text','')}\n新: {yg['row_text']}"))
            st["yg"] = yg
    except Exception as e:                # noqa: BLE001
        errors.append(f"源1 YG官网: {e}")

    # ---- 源 4（先拿链接，给下面的告警用）
    paths = []
    try:
        paths = check_sitemap()
        old = st.get("sitemap") or []
        if old and not first:
            for p in [x for x in paths if x not in set(old)]:
                alerts.append(("INFO", "sm" + p, "b.stage 新页面（sitemap）", BSTAGE + p))
        st["sitemap"] = paths
    except Exception as e:                # noqa: BLE001
        errors.append(f"源4 sitemap: {e}")
    survey_links = [BSTAGE + p for p in paths if "/surveys/" in p]

    # ---- 源 2/3
    tags_state = st.get("tags") or {}
    for tag, url in TAG_URLS.items():
        try:
            items = check_tag(url)
            old_ids = {i["id"] for i in tags_state.get(tag, [])}
            old_by_id = {i["id"]: i for i in tags_state.get(tag, [])}
            for it in items:
                hot = any(k in it["title"].upper() for k in HOT)
                win = ""
                if it["start"] or it["end"]:
                    win = (f"登记窗口: {to_cst(it['start'])}  ->  {to_cst(it['end'])}\n"
                           f"现在是否开放: {'✅ 开放中' if it['in_progress'] else '❌ 未开放/已结束'}\n")
                if it["id"] not in old_ids and not first:
                    lvl = "CRITICAL" if hot else "INFO"
                    alerts.append((lvl, f"{tag}-new-{it['id']}",
                                   f"b.stage 新 {tag}" + (f"（命中 {CITY}！）" if hot else ""),
                                   f"{it['title']}\n{win}{url}"))
                elif hot and it["id"] in old_by_id:
                    prev = old_by_id[it["id"]]
                    if prev.get("in_progress") is False and it["in_progress"] is True:
                        alerts.append(("CRITICAL", f"{tag}-open-{it['id']}",
                                       f"{CITY} 的 {tag} 现在开放登记了！",
                                       f"{it['title']}\n{win}{url}"))
            tags_state[tag] = items
        except Exception as e:            # noqa: BLE001
            errors.append(f"源 {tag}: {e}")
    st["tags"] = tags_state

    # ---- 去重
    alerts = [a for a in alerts if a[1] not in sent_keys]
    critical = [a for a in alerts if a[0] == "CRITICAL"]

    lines = [f"检查时间：{now_cst()}", f"监控城市：{CITY}", ""]

    if first:
        yg = st.get("yg", {})
        sv = tags_state.get("SURVEY", [])
        lines += [
            "监控已启动，基线已记录。之后只在有变化时才提醒。", "",
            f"当前 {CITY} 状态：" + ("COMING SOON（还没开票）" if yg.get("coming_soon")
                                    else yg.get("row_text", "?")),
            f"当前 b.stage：{len(sv)} 个 SURVEY、{len(tags_state.get('NOTICE', []))} 个公告", "",
            "现有 SURVEY 列表（没有 HONG KONG，符合预期）：",
        ] + [f"  {'✅开放中' if i['in_progress'] else '  已结束'}  {i['title'][:72]}" for i in sv]
        lines += ["", "会在这些情况提醒你：",
                  f"  · YG 官网 {CITY} 从 COMING SOON 变成 GET TICKETS",
                  f"  · b.stage 出现标题含 {CITY} 的 SURVEY 或公告（附登记窗口起止时间）",
                  f"  · {CITY} 的 SURVEY 从「未开放」变成「开放中」",
                  "", "⚠️ 别忘了：6th V.I.P 会员报名 2026-08-31 截止，这条脚本管不了，去日历上设死。"]
        subject = f"✅ BIGBANG {CITY} 监控已启动"
    elif alerts:
        for lvl, _k, title, detail in sorted(alerts, key=lambda a: a[0] != "CRITICAL"):
            lines += [{"CRITICAL": "🔴", "WARN": "🟠", "INFO": "🟡"}[lvl] + f" [{lvl}] {title}",
                      detail, ""]
        if critical and survey_links:
            lines += ["可点击的 SURVEY 链接："] + [f"  {u}" for u in survey_links[:12]] + [""]
        lines += [TODO, "", YG_URL, f"{BSTAGE}/tag/SURVEY", f"{BSTAGE}/tag/NOTICE"]
        subject = (f"🔴 BIGBANG {CITY} 有动静了（{len(critical)} 条重要）" if critical
                   else f"🟡 BIGBANG {CITY} 有小变化")
    else:
        lines.append("无变化。")
        subject = ""

    if errors:
        lines += ["", "--- 抓取异常 ---"] + errors
        subject = subject or "⚠️ BIGBANG 监控抓取异常"

    body = "\n".join(lines)
    print(body)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("```\n" + body + "\n```\n")

    if dry:
        return
    if subject:
        notify(subject, body)
    st["sent"] = sorted(sent_keys | {a[1] for a in alerts})[-500:]
    save_state(st)

    # 第二条独立的邮件通道：让 job 变红，GitHub 会另外发一封 workflow failed 邮件。
    # 因为上面 sent 已去重，同一件事只会红一次。
    if critical and os.environ.get("FAIL_ON_CRITICAL") == "1":
        print("\n[故意让本次 job 失败，用 GitHub 的失败通知邮件当第二条提醒通道]")
        sys.exit(1)


if __name__ == "__main__":
    main()
