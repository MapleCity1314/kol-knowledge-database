"""从上游 suoha888/Trader-Archives 增量同步数据到 upstream/。

只拉建站需要的文件：
  - 根 index.html（交易员名录卡片文案）
  - 每位交易员的 index.html（小节导语）、data/*.json（不含 featured / ultra_raw / image_map 冗余文件）、头像
  - 加 --images 时再镜像该交易员 images/ 下全部配图（全站约 900 MB）；不加则页面直接从 GitHub 加载图片

增量：用 GitHub tree API 拿到每个文件的 git blob sha，与本地文件的 blob sha 比较，相同则跳过。
同步记录写在 upstream/_sync.json。

用法：
  python3 tools/sync.py                 # 同步全部交易员（不含配图）
  python3 tools/sync.py --images        # 同时镜像配图
  python3 tools/sync.py --only 0xmagnolia cj
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = "suoha888/Trader-Archives"
BRANCH = "main"
RAW = f"https://raw.githubusercontent.com/{REPO}/{{sha}}/{{path}}"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "upstream"
UA = {"User-Agent": "kol-knowledge-database-sync"}

SKIP_DATA = re.compile(r"_(featured|tweets_ultra_raw|image_map)\.json$")
IMG_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp")


def get_json(url: str):
    req = urllib.request.Request(url, headers={**UA, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def blob_sha(path: Path) -> str | None:
    if not path.exists():
        return None
    data = path.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def download(item: dict, commit: str) -> tuple[str, str]:
    dest = OUT / item["path"]
    if blob_sha(dest) == item["sha"]:
        return item["path"], "same"
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = RAW.format(sha=commit, path=urllib.request.quote(item["path"]))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                data = r.read()
            break
        except Exception as e:  # noqa: BLE001 - 网络错误统一重试
            if attempt == 2:
                return item["path"], f"error: {e}"
            time.sleep(2 * (attempt + 1))
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)
    return item["path"], "new" if item.get("_existed") is False else "updated"


def kol_slugs_from_root(root_html: str) -> list[str]:
    """名录卡片里的「在线阅读」链接顺序 = 站点展示顺序。"""
    seen: list[str] = []
    for slug in re.findall(r'<a href="([\w.-]+)/" class="btn btn-primary"', root_html):
        if slug not in seen:
            seen.append(slug)
    return seen


def avatar_paths(root_html: str) -> set[str]:
    return set(re.findall(r'<img src="([^"]+)"[^>]*class="kol-avatar"', root_html))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", action="store_true", help="同时镜像配图（体积大）")
    ap.add_argument("--only", nargs="*", help="只同步这些 slug")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    commit = get_json(f"https://api.github.com/repos/{REPO}/commits/{BRANCH}")["sha"]
    tree = get_json(f"https://api.github.com/repos/{REPO}/git/trees/{commit}?recursive=1")
    if tree.get("truncated"):
        sys.exit("tree 被截断，需要改成按目录分批拉取")
    blobs = {x["path"]: x for x in tree["tree"] if x["type"] == "blob"}

    # 先同步根 index.html，用它确定交易员名单和头像路径
    _, st = download(blobs["index.html"], commit)
    root_html = (OUT / "index.html").read_text(encoding="utf-8")
    slugs = kol_slugs_from_root(root_html)
    if args.only:
        slugs = [s for s in slugs if s in set(args.only)]
    avatars = avatar_paths(root_html)

    wanted: list[dict] = []
    for slug in slugs:
        for path, item in blobs.items():
            if not path.startswith(slug + "/"):
                continue
            rel = path[len(slug) + 1:]
            keep = (
                rel == "index.html"
                or (rel.startswith("data/") and rel.count("/") == 1 and rel.endswith(".json") and not SKIP_DATA.search(rel))
                or path in avatars
                or (args.images and rel.startswith("images/") and rel.lower().endswith(IMG_EXT)
                    and not rel.endswith("suoha_avatar.jpg"))
            )
            if keep:
                wanted.append({**item, "_existed": (OUT / path).exists()})

    print(f"上游 {REPO}@{commit[:7]} · {len(slugs)} 位交易员 · 待检查 {len(wanted)} 个文件")
    stats = {"same": 0, "new": 0, "updated": 0, "error": 0}
    errors = []
    with ThreadPoolExecutor(args.workers) as ex:
        for i, (path, st) in enumerate(ex.map(lambda it: download(it, commit), wanted), 1):
            key = "error" if st.startswith("error") else st
            stats[key] += 1
            if key == "error":
                errors.append(f"{path}: {st}")
            if i % 200 == 0:
                print(f"  …{i}/{len(wanted)}")

    record = {
        "repo": REPO, "commit": commit, "syncedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "slugs": slugs, "images": args.images, "stats": stats, "errors": errors,
    }
    (OUT / "_sync.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print("完成：", stats)
    for e in errors:
        print("  失败", e)
    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
