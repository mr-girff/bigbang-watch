#!/usr/bin/env python3
"""
多通道推送分发器。只用 Python 标准库。

设计原则：一对多广播 > 一对一邮件。
所有通道都是「配了环境变量就启用，没配就自动跳过」，互不影响。
任一通道失败不影响其他通道。

通道                环境变量                              说明
------------------  ------------------------------------  --------------------------------
ntfy 主题（推荐）    NTFY_TOPIC                            一对多，用户零注册，系统级推送
微信（中国用户主力） PUSHPLUS_TOKEN [+ PUSHPLUS_GROUP]     群组推送=一对多
Telegram 频道       TG_BOT_TOKEN + TG_CHAT_ID             海外用户
GitHub Issue        GITHUB_TOKEN + GITHUB_REPOSITORY      你自己的存档 + 邮件兜底
邮件(Resend)        RESEND_KEY + MAIL_FROM                需自有域名，送达才有保障
邮件(SMTP)          SMTP_HOST/PORT/USER/PASS              个人邮箱，只适合发给自己
订阅者名单           SUBSCRIBERS_FILE / SUBSCRIBERS_CSV_URL  邮件收件人来源
"""

import csv
import io
import json
import os
import re
import smtplib
import ssl
import urllib.parse
import urllib.request
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr

TIMEOUT = 25


def _post(url, data, headers=None, method="POST"):
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"User-Agent": "bigbang-watch", **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.status, r.read().decode("utf-8", "replace")


def _get(url, headers=None):
    req = urllib.request.Request(
        url, headers={"User-Agent": "bigbang-watch", **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "replace")


# ------------------------------------------------------------- 一对多广播

def ntfy(title, body, urgent):
    """ntfy.sh 主题推送。任何人订阅同一个 topic 就能收到，无需注册。"""
    topic = os.environ.get("NTFY_TOPIC", "")
    if not topic:
        return None
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    # 标题和 tags 必须是 ASCII header，中文标题放到正文首行
    headers = {
        "Title": "BIGBANG HK ticket alert",
        "Priority": "urgent" if urgent else "default",
        "Tags": "rotating_light" if urgent else "bell",
        "Content-Type": "text/plain; charset=utf-8",
    }
    click = os.environ.get("NTFY_CLICK", "https://bigbang.bstage.in/tag/SURVEY")
    if click:
        headers["Click"] = click
    st, _ = _post(f"{server}/{urllib.parse.quote(topic)}",
                  f"{title}\n\n{body}".encode(), headers)
    return st == 200


def pushplus(title, body, urgent):
    """PushPlus：推送到微信。填了 PUSHPLUS_GROUP 就是群组推送（一对多）。"""
    tok = os.environ.get("PUSHPLUS_TOKEN", "")
    if not tok:
        return None
    payload = {"token": tok, "title": title[:100],
               "content": body, "template": "txt"}
    grp = os.environ.get("PUSHPLUS_GROUP", "")
    if grp:
        payload["topic"] = grp          # 群组编码 -> 推给该群组所有关注者
    st, txt = _post("http://www.pushplus.plus/send",
                    json.dumps(payload).encode(),
                    {"Content-Type": "application/json"})
    ok = st == 200 and '"code":200' in txt.replace(" ", "")
    if not ok:
        print(f"   pushplus 返回: {txt[:200]}")
    return ok


def telegram(title, body, urgent):
    tok, chat = os.environ.get("TG_BOT_TOKEN", ""), os.environ.get("TG_CHAT_ID", "")
    if not (tok and chat):
        return None
    text = f"{'🔴 ' if urgent else ''}{title}\n\n{body}"[:4000]
    st, _ = _post(f"https://api.telegram.org/bot{tok}/sendMessage",
                  urllib.parse.urlencode({
                      "chat_id": chat, "text": text,
                      "disable_web_page_preview": "true"}).encode(),
                  {"Content-Type": "application/x-www-form-urlencoded"})
    return st == 200


def github_issue(title, body):
    tok, repo = os.environ.get("GITHUB_TOKEN", ""), os.environ.get("GITHUB_REPOSITORY", "")
    if not (tok and repo):
        return None
    who = os.environ.get("NOTIFY_USER", repo.split("/")[0])
    st, txt = _post(
        f"https://api.github.com/repos/{repo}/issues",
        json.dumps({"title": title[:250], "body": f"@{who}\n\n```\n{body}\n```\n"}).encode(),
        {"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json",
         "Content-Type": "application/json"})
    if st in (200, 201):
        print(f"   GitHub Issue #{json.loads(txt)['number']}")
        return True
    return False


# ------------------------------------------------------------- 邮件订阅者

EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[A-Za-z]{2,}$")


def subscribers():
    """
    收件人来源（合并去重）：
      1. MAIL_TO                   逗号分隔，一般是你自己
      2. SUBSCRIBERS_FILE          仓库里的纯文本，一行一个邮箱，# 开头为注释
      3. SUBSCRIBERS_CSV_URL       Google 表单结果表「发布为 CSV」的链接
    """
    out = []
    for x in os.environ.get("MAIL_TO", "").split(","):
        if EMAIL_RE.match(x.strip()):
            out.append(x.strip())

    path = os.environ.get("SUBSCRIBERS_FILE", "subscribers.txt")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.split("#")[0].strip()
                if EMAIL_RE.match(line):
                    out.append(line)

    # Cloudflare Worker 订阅中转：/api/subscribers?format=emails（需 Bearer）
    wurl = os.environ.get("SUBSCRIBERS_URL", "")
    if wurl:
        try:
            sep = "&" if "?" in wurl else "?"
            hdr = {}
            key = os.environ.get("SUBSCRIBERS_KEY", "")
            if key:
                hdr["Authorization"] = f"Bearer {key}"
            txt = _get(f"{wurl}{sep}format=emails", hdr)
            got = [l.strip() for l in txt.splitlines() if EMAIL_RE.match(l.strip())]
            out += got
            print(f"   Worker 名单: {len(got)} 个邮箱")
        except Exception as e:                        # noqa: BLE001
            print(f"   Worker 名单拉取失败: {e}")

    url = os.environ.get("SUBSCRIBERS_CSV_URL", "")
    if url:
        try:
            for row in csv.reader(io.StringIO(_get(url))):
                for cell in row:
                    cell = cell.strip()
                    if EMAIL_RE.match(cell):
                        out.append(cell)
        except Exception as e:                        # noqa: BLE001
            print(f"   订阅名单 CSV 拉取失败: {e}")

    seen, uniq = set(), []
    for e in out:
        k = e.lower()
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    return uniq


def _footer():
    u = os.environ.get("UNSUB_URL", "")
    return ("\n\n----------\n你收到这封邮件是因为订阅了 BIGBANG 香港站票务提醒。"
            + (f"\n退订：{u}" if u else "\n退订：直接回复本邮件写 unsubscribe。"))


def resend(title, body, to_list):
    """Resend API 群发。需要在 Resend 里验证过自有域名，否则只能发给自己。"""
    key, frm = os.environ.get("RESEND_KEY", ""), os.environ.get("MAIL_FROM", "")
    if not (key and frm and to_list):
        return None
    ok = 0
    for i in range(0, len(to_list), 50):          # Resend 单次 to 上限 50
        batch = to_list[i:i + 50]
        try:
            st, txt = _post("https://api.resend.com/emails",
                            json.dumps({"from": frm, "to": batch,
                                        "subject": title,
                                        "text": body + _footer()}).encode(),
                            {"Authorization": f"Bearer {key}",
                             "Content-Type": "application/json"})
            if st in (200, 201):
                ok += len(batch)
            else:
                print(f"   resend 批次失败 {st}: {txt[:160]}")
        except Exception as e:                    # noqa: BLE001
            print(f"   resend 异常: {e}")
    print(f"   Resend 已发 {ok}/{len(to_list)}")
    return ok > 0


def smtp(title, body, to_list):
    host, user = os.environ.get("SMTP_HOST", ""), os.environ.get("SMTP_USER", "")
    pw = os.environ.get("SMTP_PASS", "")
    if not (host and user and pw and to_list):
        return None
    port = int(os.environ.get("SMTP_PORT", "465"))
    ctx = ssl.create_default_context()
    ok = 0
    try:
        s = (smtplib.SMTP_SSL(host, port, context=ctx, timeout=30) if port == 465
             else smtplib.SMTP(host, port, timeout=30))
        if port != 465:
            s.starttls(context=ctx)
        s.login(user, pw)
        for addr in to_list:                      # 逐封发，避免暴露其他订阅者邮箱
            m = MIMEText(body + _footer(), "plain", "utf-8")
            m["Subject"] = Header(title, "utf-8")
            m["From"] = formataddr(("BIGBANG HK 提醒", user))
            m["To"] = addr
            try:
                s.sendmail(user, [addr], m.as_string())
                ok += 1
            except Exception as e:                # noqa: BLE001
                print(f"   发给 {addr} 失败: {e}")
        s.quit()
    except Exception as e:                        # noqa: BLE001
        print(f"   SMTP 连接失败: {e}")
    print(f"   SMTP 已发 {ok}/{len(to_list)}")
    return ok > 0


# ------------------------------------------------------------- 统一入口

def broadcast(title, body, urgent=False):
    """向所有已配置的通道推送。返回成功的通道名列表。"""
    ok, skipped = [], []
    jobs = [("ntfy", lambda: ntfy(title, body, urgent)),
            ("微信/PushPlus", lambda: pushplus(title, body, urgent)),
            ("Telegram", lambda: telegram(title, body, urgent)),
            ("GitHub Issue", lambda: github_issue(title, body))]

    subs = subscribers()
    if subs:
        jobs += [("邮件/Resend", lambda: resend(title, body, subs)),
                 ("邮件/SMTP", lambda: smtp(title, body, subs))]

    for name, fn in jobs:
        try:
            r = fn()
        except Exception as e:                    # noqa: BLE001
            print(f"!! 通道 {name} 异常: {e}")
            r = False
        if r is None:
            skipped.append(name)
        elif r:
            ok.append(name)
            print(f"✓ {name}")
        else:
            print(f"✗ {name} 发送失败")

    if subs:
        print(f"   邮件订阅者 {len(subs)} 人")
    if skipped:
        print(f"   未配置(跳过): {', '.join(skipped)}")
    if not ok:
        print("!! 没有任何通道成功，内容如下：\n" + body)
    return ok


if __name__ == "__main__":
    broadcast("[测试] BIGBANG HK 提醒通道自检",
              "这是一条测试推送。收到说明该通道可用。", urgent=False)
