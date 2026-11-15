"""Download the artwork the plugin ships: champion icons and club logos.

    python tools/build-icons.py raw ui/icons build

Two sources, both fetched at build time because the host iframe cannot reach the
network at runtime (`connect-src 'none'`):

  champions  Data Dragon `zh_CN/champion.json` — official Chinese names and icons
  teams      Leaguepedia wiki files, "<Team>logo std.png" and friends, resolved
             through the MediaWiki imageinfo API (Special:FilePath answers 403 to
             a non-browser user agent, and the CDN URL it redirects to is what
             we actually download)

Each family is composed into ONE sprite sheet (a PNG grid) so the bundle carries
~180 icons in ~60 KB instead of 180 files: the plugin budget is 4 MiB.

Writes <out>/champions.png|teams.png and <meta>/icons.json + <meta>/champions.json,
which tools/build-data.mjs folds into the dataset (slot + name per entity).
Downloads are cached under <raw>/icons/ so a re-run only fetches what is new.
"""
import hashlib, json, os, sys, time, urllib.error, urllib.parse, urllib.request
from PIL import Image

RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
OUT = sys.argv[2] if len(sys.argv) > 2 else "ui/icons"
META = sys.argv[3] if len(sys.argv) > 3 else "build"
DD = "https://ddragon.leagueoflegends.com"
API = "https://lol.fandom.com/api.php"
PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
TEAM_LIMIT = int(os.environ.get("TEAM_ICONS", "260"))
CHAMP_SIZE, TEAM_SIZE = 22, 32
UA = "LolAlmanacBuild/1.1 (https://github.com/liveldy/Nous-Plugin-LoL-Almanac) python-urllib"
CACHE = os.path.join(RAW, "icons")
DELAY = 0.4  # seconds between API calls; leaguepedia rate-limits aggressively

if PROXY:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": PROXY, "https": PROXY}))
else:  # pragma: no cover
    opener = urllib.request.build_opener()

os.makedirs(CACHE, exist_ok=True)


def fetch(url, tries=4, slow=0):
    """GET one URL, backing off on 429 and on the API's own ratelimited error."""
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with opener.open(req, timeout=60) as r:
                return r.read(), r.headers.get("content-type", "")
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return None, ""
            if e.code == 429:
                time.sleep(45 * (i + 1))
                continue
            time.sleep(3 * (i + 1))
        except Exception:
            time.sleep(3 * (i + 1))
    return None, ""


def api(params):
    """One cargoquery/api call, retrying while the wiki asks us to slow down."""
    url = API + "?" + urllib.parse.urlencode(params)
    for i in range(5):
        body, _ = fetch(url)
        if not body:
            time.sleep(10 * (i + 1))
            continue
        try:
            data = json.loads(body)
        except Exception:
            time.sleep(10 * (i + 1))
            continue
        err = data.get("error") if isinstance(data, dict) else None
        if err and ("ratelimited" in json.dumps(err) or "MWException" in json.dumps(err)):
            print("    api busy, sleeping", 30 * (i + 1), flush=True)
            time.sleep(30 * (i + 1))
            continue
        return data
    return None


def download_image(url, key, suffix=".img"):
    """Fetch (or reuse) one image on disk; returns a Pillow image or None."""
    path = os.path.join(CACHE, key + suffix)
    if os.path.exists(path) and os.path.getsize(path) > 0:
        try:
            return Image.open(path).convert("RGBA")
        except Exception:
            os.remove(path)
    body, _ = fetch(url)
    if not body:
        return None
    with open(path, "wb") as f:
        f.write(body)
    try:
        return Image.open(path).convert("RGBA")
    except Exception:
        os.remove(path)
        return None


def sheet(images, size, cols, path):
    """Lay the tiles out on a flat palette-ish sheet; a shared palette is what keeps it small."""
    rows = (len(images) + cols - 1) // cols
    canvas = Image.new("RGBA", (cols * size, rows * size), (0, 0, 0, 0))
    for i, im in enumerate(images):
        canvas.paste(im, ((i % cols) * size, (i // cols) * size))
    # 256 色调色板 + 透明：图标只有色块，肉眼几乎看不出差别，体积却只要三分之一。
    # 试过无损 WebP：带渐变的 alpha 原图要 170 KB，调色板 PNG 反而只有 55 KB。
    alpha = canvas.getchannel("A")
    flat = Image.new("RGB", canvas.size, (255, 255, 255))
    flat.paste(canvas, (0, 0), canvas)
    q = flat.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    q = q.convert("RGBA")
    q.putalpha(alpha.point(lambda a: 0 if a < 96 else 255))
    q = q.convert("P", palette=Image.Palette.ADAPTIVE, colors=255)
    q.save(path, optimize=True)
    return {"cols": cols, "rows": rows, "size": size,
            "count": len(images), "bytes": os.path.getsize(path)}


def pad_square(im, size):
    w, h = im.size
    side = max(w, h)
    if w != h:
        pad = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        pad.paste(im, ((side - w) // 2, (side - h) // 2))
        im = pad
    return im.resize((size, size), Image.LANCZOS)


report = {}
os.makedirs(OUT, exist_ok=True)

# ── champions ────────────────────────────────────────────────────────────────
body, _ = fetch(DD + "/api/versions.json")
ver = json.loads(body)[0]
body, _ = fetch(f"{DD}/cdn/{ver}/data/zh_CN/champion.json")
champ_raw = json.loads(body)["data"]
order = sorted(champ_raw.keys())
tiles, meta = [], []
for key in order:
    c = champ_raw[key]
    im = download_image(f"{DD}/cdn/{ver}/img/champion/{c['image']['full']}",
                        "champ-" + key, ".png")
    if im is None:
        meta.append({"key": key, "slot": -1})
        continue
    # ddragon 的 zh_CN 里 name/title 是反的：name=称号(盲僧)，title=中文名(李青)
    meta.append({"key": key, "slot": len(tiles), "zh": c["title"], "title": c["name"]})
    tiles.append(pad_square(im, CHAMP_SIZE))
print("champions", len(tiles), flush=True)
report["champions"] = sheet(tiles, CHAMP_SIZE, 16, os.path.join(OUT, "champions.png"))

# ── teams ────────────────────────────────────────────────────────────────────
# 选中哪些队伍：履历条数 + 现役选手数是排序依据 —— 老牌队伍行数多，近两年成立的队伍
# 只能靠现役名单进来。每块图标约 80 字节，所以名额由包体积预算决定。
teams = json.load(open(os.path.join(RAW, "Tenures.json"), encoding="utf-8"))
count = {}
for row in teams:
    name = (row.get("Team") or "").strip()
    if name:
        count[name] = count.get(name, 0) + 1
players = json.load(open(os.path.join(RAW, "Players.json"), encoding="utf-8"))
active = {}
for row in players:
    name = (row.get("Team") or "").strip()
    if name:
        active[name] = active.get(name, 0) + 1
score = lambda t: count.get(t, 0) + 9 * active.get(t, 0)
top_teams = sorted(set(count) | set(active), key=lambda t: (-score(t), -count.get(t, 0)))[:TEAM_LIMIT]

SUFFIXES = ("logo std.png", "logo.png", "logo_square.png", "logo square.png", "std.png")
URL_CACHE = os.path.join(CACHE, "team-urls.json")
urls = {}          # "<team>\x00<suffix>" -> cdn url
# 解析结果落盘：换图标尺寸、重跑时不用再问一次 API（REFRESH_URLS=1 可强制重解）
if os.path.exists(URL_CACHE) and not os.environ.get("REFRESH_URLS"):
    try:
        urls = json.load(open(URL_CACHE, encoding="utf-8"))
        print("  url cache", len(urls), "entries", flush=True)
    except Exception:
        urls = {}
for suffix in SUFFIXES:
    todo = [t for t in top_teams if t + "\x00" + suffix not in urls]
    for i in range(0, len(todo), 40):
        batch = todo[i:i + 40]
        titles = "|".join("File:" + t + suffix for t in batch)
        data = api({"action": "query", "format": "json", "prop": "imageinfo",
                    "iiprop": "url", "iilimit": "1", "redirects": "1", "titles": titles})
        if not data:
            continue
        pages = data.get("query", {}).get("pages", {})
        norm = {n["to"]: n["from"] for n in data.get("query", {}).get("normalized", [])}
        for page in pages.values():
            title = page.get("title", "")
            name = title[len("File:"):] if title.startswith("File:") else title
            name = norm.get(name, name)
            if not name.endswith(suffix):
                continue
            info = page.get("imageinfo")
            # 找不到的文件也记成空，省得下次再问
            urls[name[:-len(suffix)] + "\x00" + suffix] = info[0]["url"] if info else ""
        print("  resolve", suffix, i + len(batch), "/", len(todo), "hits", len(urls), flush=True)
        time.sleep(DELAY)
json.dump(urls, open(URL_CACHE, "w", encoding="utf-8"), ensure_ascii=False)

tiles, team_meta = [], {}
for name in top_teams:
    for suffix in SUFFIXES:
        url = urls.get(name + "\x00" + suffix)
        if not url:
            continue
        # 缓存按 URL 命名：换队标文件或换队伍都不会读到上一次的图
        im = download_image(url, "team-" + hashlib.md5(url.encode()).hexdigest()[:16])
        if im is None:
            continue
        team_meta[name] = len(tiles)
        tiles.append(pad_square(im, TEAM_SIZE))
        break
    if len(tiles) and len(tiles) % 100 == 0:
        print("  teams", len(tiles), flush=True)

print("teams", len(tiles), flush=True)
if tiles:
    report["teams"] = sheet(tiles, TEAM_SIZE, 20, os.path.join(OUT, "teams.png"))
    report["teamSlots"] = team_meta

report["version"] = ver
os.makedirs(META, exist_ok=True)
json.dump(report, open(os.path.join(META, "icons.json"), "w", encoding="utf-8"), ensure_ascii=False)
json.dump(meta, open(os.path.join(META, "champions.json"), "w", encoding="utf-8"), ensure_ascii=False)
for k, v in report.items():
    if isinstance(v, dict) and "bytes" in v:
        print(k, {kk: vv for kk, vv in v.items()}, flush=True)
