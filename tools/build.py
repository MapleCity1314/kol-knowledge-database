"""由 upstream/ 构建静态站点到 site/。

产物：
  site/index.html            首页（名录）
  site/<slug>/index.html     每位交易员一页，数据内联，单文件即可打开
  site/catalog.json          名录与统计（供后续 AI / 其他工具使用）

图片：若 upstream/<slug>/images 已镜像（tools/sync.py --images），页面用本地相对路径；
否则直接引用 GitHub 原图。两种情况下加载失败都会回退到 GitHub。

用法：python3 tools/build.py [--only slug ...]
"""
from __future__ import annotations

import argparse
import collections
import html
import json
import os
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UP = ROOT / "upstream"
SITE = ROOT / "site"
TPL = ROOT / "templates"
REMOTE = "https://raw.githubusercontent.com/suoha888/Trader-Archives/main/{slug}/"
UPSTREAM_SITE = "https://suoha888.github.io/Trader-Archives/"

TWEET_FIELDS = (
    "id", "date", "volumeId", "volumeName", "topicId", "topicCode", "topicTitle",
    "roleOrder", "roleLabel", "qualityTier", "qualityScore", "shortNote",
    "favoriteCount", "retweetCount", "viewCount", "local_images", "tweetUrl", "text",
)


# ---------------------------------------------------------------- 解析上游 HTML
def text_of(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


def first(pattern: str, s: str, default: str = "") -> str:
    m = re.search(pattern, s, re.S)
    return text_of(m.group(1)) if m else default


def parse_cards(root_html: str) -> list[dict]:
    """首页名录卡片：顺序、分类标签、名字、handle 行、书名、标签、简介、头像。"""
    parts = re.split(r'<div class="kol-card">', root_html)[1:]
    cards = []
    for p in parts:
        slug = re.search(r'<a href="([\w.-]+)/" class="btn btn-primary"', p)
        if not slug:
            continue  # 「持续收录」占位卡
        handle_line = first(r'class="kol-handle">(.*?)</div>', p)
        cards.append({
            "slug": slug.group(1),
            "ribbon": first(r'class="kol-card-ribbon">(.*?)</div>', p).lstrip("🔥 ").strip(),
            "name": first(r'class="kol-name">(.*?)</span>', p),
            "handleLine": handle_line,
            "book": first(r'class="kol-book-title">(.*?)</h3>', p),
            "tags": [text_of(t) for t in re.findall(r'class="kol-tag">(.*?)</span>', p)],
            "summary": first(r'class="kol-summary">(.*?)</p>', p),
            "avatar": (re.search(r'<img src="([^"]+)"[^>]*class="kol-avatar"', p) or [None, ""])[1],
        })
    return cards


def parse_monographs(root_html: str) -> list[dict]:
    out = []
    for p in re.split(r'<div class="monograph-card">', root_html)[1:]:
        p = p.split("</section>")[0]
        read = re.search(r'<a href="([\w.-]+/)" class="btn btn-primary"', p)
        pdf = re.search(r'<a href="([^"]+\.pdf)"', p)
        out.append({
            "author": first(r'class="kol-name">(.*?)</span>', p),
            "note": first(r'class="kol-handle">(.*?)</div>', p),
            "title": first(r'class="kol-book-title">(.*?)</h3>', p),
            "summary": first(r'class="kol-summary">(.*?)</p>', p),
            "read": UPSTREAM_SITE + read.group(1) if read else "",
            "pdf": "https://github.com/suoha888/Trader-Archives/blob/main/" + pdf.group(1) if pdf else "",
        })
    return out


def parse_topic_leads(kol_html: str) -> dict[str, str]:
    """小节导语只存在于上游页面里。按 topic-card 切段，每段内找导语，避免串到下一节。"""
    leads = {}
    for seg in kol_html.split('<article class="topic-card')[1:]:
        tid = re.match(r'[^"]*" id="(t-\d+)"', seg)
        lead = re.search(r'<p class="topic-lead[^"]*">(.*?)</p>', seg.split('<div class="tweets-stack')[0], re.S)
        if tid and lead:
            leads[tid.group(1)] = text_of(lead.group(1))
    return leads


# ---------------------------------------------------------------- 数据整理
def load(path: Path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def fmt_followers(n: int) -> str:
    return f"{n / 1e4:.1f}万 关注者" if n >= 1e4 else f"{n:,} 关注者"


def appendix_for(slug: str, d: Path) -> list[dict]:
    out = []
    wb = load(d / f"{slug}_weibo.json")
    if wb:
        out.append({
            "id": "weibo", "title": "早期微博时间轴", "short": "早期微博",
            "desc": "跨平台去重后的微博独占原创，按阶段分组；默认每段先显示精选，展开后按时间排列。",
            "items": [{
                "id": x["id"], "date": x.get("date", ""), "text": x.get("text", ""),
                "shortNote": x.get("shortNote", ""), "qualityTier": x.get("qualityTier"),
                "qualityScore": x.get("dryScore", 0), "local_images": x.get("local_images", []),
                "tweetUrl": x.get("sourceUrl", ""), "sourceLabel": x.get("sourceLabel", "来源"),
                "group": x.get("stageLabel", ""),
            } for x in wb],
        })
    early = load(d / f"{slug}_early_archive.json")
    if early:
        out.append({
            "id": "early", "title": "早期英文档案", "short": "早期英文",
            "desc": "早期英文推文时间轴，按年份分组；默认每年先显示评分最高的几条。",
            "items": [{
                "id": x["id"], "date": x.get("date", ""), "text": x.get("text", ""),
                "qualityScore": x.get("qualityScore", 0), "favoriteCount": x.get("favoriteCount"),
                "retweetCount": x.get("retweetCount"), "viewCount": x.get("viewCount"),
                "local_images": x.get("local_images", []), "tweetUrl": x.get("tweetUrl", ""),
                "group": x.get("year") or x.get("date", "")[:4],
            } for x in early],
        })
    return out


def build_kol(card: dict, no: int, sync: dict) -> tuple[dict, dict, dict]:
    slug = card["slug"]
    base = UP / slug
    d = base / "data"
    tweets = load(d / f"{slug}_tweets.json")
    if not tweets:
        raise SystemExit(f"{slug}: 缺少 tweets.json，先运行 tools/sync.py")
    user = load(d / f"{slug}_user_info.json") or load(d / "user_info.json") or {}
    models = load(d / f"{slug}_mental_models.json", [])
    articles = load(d / f"{slug}_articles_full.json", [])
    leads = parse_topic_leads((base / "index.html").read_text(encoding="utf-8")) if (base / "index.html").exists() else {}

    slim = [{k: t.get(k) for k in TWEET_FIELDS} for t in tweets]
    for t in slim:
        t["id"] = str(t["id"])
        t["local_images"] = t["local_images"] or []

    handle = (re.search(r"@(\w+)", card["handleLine"]) or [None, user.get("screenName", slug)])[1]
    followers = fmt_followers(user["followersCount"]) if user.get("followersCount") else \
        (card["handleLine"].split("·", 1)[1].strip() if "·" in card["handleLine"] else "")
    mirrored = (base / "images").exists() and sum(1 for _ in (base / "images").iterdir()) > 3
    avatar_rel = card["avatar"][len(slug) + 1:] if card["avatar"].startswith(slug + "/") else ""

    meta = {
        "slug": slug, "no": no, "name": card["name"] or user.get("name", slug), "handle": handle,
        "followers": followers, "ribbon": card["ribbon"], "dek": card["book"], "lede": card["summary"],
        "tags": card["tags"], "avatar": avatar_rel,
        "imgBase": f"../../upstream/{slug}/" if mirrored else REMOTE.format(slug=slug),
        "remoteBase": REMOTE.format(slug=slug), "syncedAt": sync.get("syncedAt", "")[:10],
    }
    data = {"tweets": slim, "models": models, "articles": articles, "leads": leads,
            "appendix": appendix_for(slug, d)}

    monthly = collections.Counter(t["date"][:7] for t in slim if t.get("date"))
    months = sorted(monthly)
    series = []
    if months:
        y, m = map(int, months[0].split("-"))
        while f"{y:04d}-{m:02d}" <= months[-1]:
            key = f"{y:04d}-{m:02d}"
            series.append([key, monthly.get(key, 0)])
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    topics = {t["topicId"] for t in slim}
    summary = {
        "slug": slug, "no": no, "name": meta["name"], "handle": handle, "followers": followers,
        "ribbon": card["ribbon"], "book": card["book"], "summary": card["summary"], "tags": card["tags"],
        "avatar": avatar_rel,
        "avatarLocal": f"{slug}/avatar{Path(avatar_rel).suffix or '.jpg'}" if avatar_rel else "",
        "avatarRemote": REMOTE.format(slug=slug) + avatar_rel if avatar_rel else "",
        "tweets": len(slim), "featured": sum(t["qualityTier"] in ("S", "A") for t in slim),
        "vols": len({t["volumeId"] for t in slim}), "topics": len(topics),
        "articles": len(articles), "models": len(models),
        "appendix": {a["id"]: len(a["items"]) for a in data["appendix"]},
        "images": sum(len(t["local_images"]) for t in slim),
        "monthly": series,
    }
    return meta, data, summary


def chat_endpoint() -> str:
    """AI 助手网关地址：环境变量 CHAT_ENDPOINT 优先，其次是仓库里的 site.config.json。"""
    if os.environ.get("CHAT_ENDPOINT") is not None:
        return os.environ["CHAT_ENDPOINT"].strip()
    cfg = load(ROOT / "site.config.json", {})
    return str(cfg.get("chatEndpoint") or "").strip()


def js(obj) -> str:
    # 内联进 <script>：防止数据中的 "</script>" 提前闭合
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*")
    args = ap.parse_args()

    root_html = (UP / "index.html").read_text(encoding="utf-8")
    sync = load(UP / "_sync.json", {})
    cards = parse_cards(root_html)
    if not cards:
        sys.exit("未能从 upstream/index.html 解析出名录卡片")
    base_css = (TPL / "base.css").read_text(encoding="utf-8")
    kol_tpl = ((TPL / "kol.html").read_text(encoding="utf-8")
               .replace("/*@@BASE_CSS@@*/", base_css)
               .replace("/*@@CHAT_CSS@@*/", (TPL / "chat.css").read_text(encoding="utf-8"))
               .replace("/*@@CHAT_JS@@*/", (TPL / "chat.js").read_text(encoding="utf-8")))
    chat = chat_endpoint()
    print(f"AI 助手网关：{chat or '未配置（页面不显示问答按钮）'}")
    portal_tpl = (TPL / "portal.html").read_text(encoding="utf-8").replace("/*@@BASE_CSS@@*/", base_css)

    SITE.mkdir(exist_ok=True)
    built, summaries = [], []
    for no, card in enumerate(cards, 1):
        meta, data, summary = build_kol(card, no, sync)
        summaries.append(summary)
        built.append((meta, data))

    for i, (meta, data) in enumerate(built):
        if args.only and meta["slug"] not in args.only:
            continue
        meta["prev"] = {"slug": built[i - 1][0]["slug"], "name": built[i - 1][0]["name"]} if i > 0 else None
        meta["next"] = {"slug": built[i + 1][0]["slug"], "name": built[i + 1][0]["name"]} if i + 1 < len(built) else None
        out_dir = SITE / meta["slug"]
        out_dir.mkdir(parents=True, exist_ok=True)
        page = (kol_tpl
                .replace("@@TITLE@@", html.escape(f"{meta['name']} · KOL 知识库"))
                .replace("@@DESC@@", html.escape(meta["dek"] or meta["lede"][:120]))
                .replace("/*@@META@@*/null", js({**meta, "chat": chat}))
                .replace("/*@@DATA@@*/null", js(data)))
        (out_dir / "index.html").write_text(page, encoding="utf-8")
        # 首页卡片用的头像拷到站点内
        src = UP / meta["slug"] / meta["avatar"] if meta["avatar"] else None
        if src and src.exists():
            shutil.copyfile(src, out_dir / f"avatar{src.suffix}")
        size = (out_dir / "index.html").stat().st_size / 1e6
        print(f"  {meta['slug']:16} {len(data['tweets']):5} 推 · {len(data['articles']):3} 长文 · "
              f"{len(data['leads']):2} 节导语 · {size:4.1f} MB")

    catalog = {
        "commit": sync.get("commit", ""), "syncedAt": sync.get("syncedAt", "")[:10],
        "totals": {k: sum(s[k] for s in summaries) for k in ("tweets", "featured", "articles", "models", "images")},
        "kols": summaries, "monographs": parse_monographs(root_html),
    }
    (SITE / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    (SITE / "index.html").write_text(portal_tpl.replace("/*@@CATALOG@@*/null", js(catalog)), encoding="utf-8")
    print(f"首页：{len(summaries)} 位 · {catalog['totals']}")


if __name__ == "__main__":
    main()
