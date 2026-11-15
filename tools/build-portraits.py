"""Download player headshots and pack the top N into one sprite.

    python tools/build-portraits.py raw ui/icons build [count]

Three steps, all at build time (the plugin cannot fetch at runtime):

  1. raw/PlayerImages.json (tools/fetch_honors.py) lists wiki file names per
     player; the profile headshot is the one with IsProfileImage=1.
  2. the MediaWiki imageinfo API turns those names into Fandom CDN URLs, 40 at a
     time, and the images are cached under <raw>/portraits/.
  3. the chosen players are cropped square, scaled to PORTRAIT_SIZE and written as
     one lossy WebP sprite — a photo sprite is several times smaller as WebP than
     as a PNG palette.

The budget: 4 MiB for the whole plugin. The team-logo and champion sprites
already take ~100 KB, so the number of portraits is a size decision, not a data
decision — `count` (default 240) is capped by whatever the bundle can afford.
Writes <out>/players.webp and <meta>/portraits.json ({"cols","rows","size",
"count","order": [page name per slot]}).
"""
import hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request

from PIL import Image

RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
OUT = sys.argv[2] if len(sys.argv) > 2 else "ui/icons"
META = sys.argv[3] if len(sys.argv) > 3 else "build"
LIMIT = int(sys.argv[4]) if len(sys.argv) > 4 else int(os.environ.get("PORTRAITS", "240"))
SIZE = int(os.environ.get("PORTRAIT_SIZE", "48"))
COLS = int(os.environ.get("PORTRAIT_COLS", "20"))
QUALITY = int(os.environ.get("PORTRAIT_QUALITY", "62"))
THUMB = int(os.environ.get("PORTRAIT_THUMB", "240"))  # 缩略图边长，够 56px 图块用
API = "https://lol.fandom.com/api.php"
PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
UA = "LolAlmanacBuild/1.1 (https://github.com/liveldy/Nous-Plugin-LoL-Almanac) python-urllib"
CACHE = os.path.join(RAW, "portraits")
DELAY = 0.4

if PROXY:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
else:  # pragma: no cover
    opener = urllib.request.build_opener()

os.makedirs(CACHE, exist_ok=True)


def fetch(url, tries=4):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with opener.open(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None
            if e.code == 429:
                time.sleep(45 * (i + 1))
                continue
            time.sleep(3 * (i + 1))
        except Exception:
            time.sleep(3 * (i + 1))
    return None


def api(params):
    url = API + "?" + urllib.parse.urlencode(params)
    for i in range(5):
        body = fetch(url)
        if not body:
            time.sleep(10 * (i + 1))
            continue
        try:
            data = json.loads(body)
        except Exception:
            time.sleep(10 * (i + 1))
            continue
        err = json.dumps(data.get("error", ""))
        if err and ("ratelimited" in err or "MWException" in err):
            print("    api busy, sleeping", 30 * (i + 1), flush=True)
            time.sleep(30 * (i + 1))
            continue
        return data
    return None


def download(url):
    key = hashlib.md5(url.encode()).hexdigest()[:16]
    path = os.path.join(CACHE, key + ".img")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        try:
            return Image.open(path).convert("RGB")
        except Exception:
            os.remove(path)
    body = fetch(url)
    if not body:
        return None
    open(path, "wb").write(body)
    try:
        return Image.open(path).convert("RGB")
    except Exception:
        os.remove(path)
        return None


# ── 1. one headshot per player, plus the ranking we choose from ───────────────
players = json.load(open(os.path.join(RAW, "PlayerImages.json"), encoding="utf-8"))
best = {}
for row in players:
    link = (row.get("Link") or "").strip()
    name = (row.get("FileName") or "").strip()
    if not link or not name:
        continue
    head = (row.get("ImageType") or "").lower() == "headshot"
    profile = str(row.get("IsProfileImage") or "") in ("1", "true", "True")
    date = row.get("SortDate") or ""
    rank = (1 if profile else 0, 1 if head else 0, date)
    prev = best.get(link)
    if prev is None or rank > prev[0]:
        best[link] = (rank, name)
print("players with a headshot file:", len(best), flush=True)

# 出场最多的先上 —— 4 MiB 只够放一小撮，就挑用户最可能点开的那批
games = {}
for row in json.load(open(os.path.join(RAW, "CareerStats.json"), encoding="utf-8")):
    link = (row.get("Link") or "").strip()
    try:
        g = int(row.get("G") or 0)
    except Exception:
        g = 0
    if link and g > games.get(link, 0):
        games[link] = g
ranked = sorted(best, key=lambda link: (-games.get(link, 0), link))
chosen = [link for link in ranked if games.get(link, 0) > 0][:LIMIT]
print("candidates by career games:", len(chosen), flush=True)

# ── 2. file name -> CDN url, 40 titles per request ────────────────────────────
urls = {}
for i in range(0, len(chosen), 40):
    batch = chosen[i:i + 40]
    titles = "|".join("File:" + best[link][1] for link in batch)
    # 只要缩略图：肖像最后缩到 56px，原图动辄几百 KB，走 iiurlwidth 一次只要几十 KB
    data = api({"action": "query", "format": "json", "prop": "imageinfo",
                "iiprop": "url", "iilimit": "1", "iiurlwidth": str(THUMB),
                "redirects": "1", "titles": titles})
    if not data:
        continue
    norm = {n["to"]: n["from"] for n in data.get("query", {}).get("normalized", [])}
    by_title = {}
    for page in data.get("query", {}).get("pages", {}).values():
        title = page.get("title", "")
        name = title[len("File:"):] if title.startswith("File:") else title
        info = (page.get("imageinfo") or [{}])[0]
        by_title[norm.get(name, name)] = info.get("thumburl") or info.get("url", "")
    # 标题可能被规范化（下划线、首字母大写），所以按「规范化后的文件名」回查一遍
    for link in batch:
        wanted = best[link][1]
        url = by_title.get(wanted)
        if url is None:
            norm_name = wanted.replace("_", " ")
            url = by_title.get(norm_name) or by_title.get(norm_name[:1].upper() + norm_name[1:])
        if url:
            urls[link] = url
    print("  resolve", min(i + 40, len(chosen)), "/", len(chosen), "hits", len(urls), flush=True)
    time.sleep(DELAY)

# ── 3. sprite ────────────────────────────────────────────────────────────────
tiles, order = [], []
for link in chosen:
    url = urls.get(link)
    if not url:
        continue
    im = download(url)
    if im is None:
        continue
    w, h = im.size
    side = min(w, h)
    im = im.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
    tiles.append(im.resize((SIZE, SIZE), Image.LANCZOS))
    order.append(link)
print("portraits", len(tiles), flush=True)

if tiles:
    rows = (len(tiles) + COLS - 1) // COLS
    canvas = Image.new("RGB", (COLS * SIZE, rows * SIZE), (24, 24, 26))
    for i, im in enumerate(tiles):
        canvas.paste(im, ((i % COLS) * SIZE, (i // COLS) * SIZE))
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "players.webp")
    canvas.save(path, "WEBP", quality=QUALITY, method=6)
    report = {"cols": COLS, "rows": rows, "size": SIZE, "count": len(tiles),
              "bytes": os.path.getsize(path), "order": order}
    print(json.dumps({k: v for k, v in report.items() if k != "order"}), flush=True)
else:  # pragma: no cover
    report = {"cols": 0, "rows": 0, "size": SIZE, "count": 0, "bytes": 0, "order": []}
    print("no portraits", flush=True)

os.makedirs(META, exist_ok=True)
json.dump(report, open(os.path.join(META, "portraits.json"), "w", encoding="utf-8"), ensure_ascii=False)
