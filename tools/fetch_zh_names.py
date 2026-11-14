"""Look up Chinese names for the players whose Chinese name is in wide use.

    python tools/fetch_zh_names.py raw

Leaguepedia carries a Chinese name only for players whose own record is written
in Chinese characters (~2,300 of 20,879). Korean, European and American players
keep their in-game ID there; the Chinese name Chinese-speaking fans use comes
from the person's article on Chinese Wikipedia (`本名李相赫`), and only people
with such an article have one.

So the script asks zh.wikipedia about the players a Chinese reader is likely to
look up, one title at a time, keeps only pages about 《英雄聯盟》, reads the name
out of the lead (本名…, or a Chinese-character title), and writes
raw/ZhNames.json as {"names": {"Faker": "李相赫"}}. A page that is not about the
game contributes nothing, so an ID like "Rookie" (a Red Velvet album) or "369"
(an album) never yields a wrong name.
"""
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
API = "https://zh.wikipedia.org/w/api.php"
GAME = ("英雄聯盟", "英雄联盟", "職業電子競技", "职业电子竞技", "電子競技選手", "电子竞技选手")
NAME_RE = re.compile(r"^[\u4e00-\u9fff·]{2,6}$")
BENMING_RE = re.compile(r"本名[：: ]?([\u4e00-\u9fff·]{2,6})")

# 会有人去中文维基查的选手，按 ID 列；没有条目的 ID 什么也不产出
LOOKUP = """
Faker Bengi Wolf Bang Duke Impact Piglet PoohManDu Marin Easyhoon Blank Huni Reignover
Peanut Smeb Kuro Pray GorillA Score Spirit Mata Imp Deft Pawn Dandy Looper Heart Rookie
TheShy Khan Cuzz Bdd CuVee Crown Ambition Ruler CoreJJ Haru Chovy Doran Pyosik Viper
Tarzan Lehends ShowMaker Canyon Nuguri Ghost BeryL Kingen Zeka Gumayusi Keria Zeus Oner
Teddy Clid Effort Life Leaper Canyon kkOma Zeus Viper Scout Doinb GimGoon Kanavi TheShy
Rookie Karsa SwordArt Maple Westdoor Betty Hanabi FoFo Doggo Karsa Lilv Kongyue Gemini
""".split()

# 只查选手表里真实存在的 ID
players = {p["ID"] for p in json.load(open(os.path.join(RAW, "Players.json"), encoding="utf-8"))}
targets, seen = [], set()
for tid in LOOKUP:
    if tid in players and tid not in seen:
        seen.add(tid)
        targets.append(tid)
print("looking up", len(targets), "players", flush=True)


def fetch(title):
    url = API + "?" + urllib.parse.urlencode({
        "action": "query", "titles": title, "prop": "extracts", "exintro": 1, "explaintext": 1,
        "exchars": 700, "redirects": 1, "format": "json", "formatversion": 2})
    req = urllib.request.Request(url, headers={"User-Agent": "lol-almanac-build/1.0 (offline data build)"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


names, skipped = {}, 0
for tid in targets:
    data = None
    for attempt in range(5):
        try:
            data = fetch(tid)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(8 * (attempt + 1))
                continue
            break
        except Exception:
            time.sleep(3 * (attempt + 1))
    if not data:
        print("  skip", tid, flush=True)
        continue
    pages = data.get("query", {}).get("pages", [])
    page = pages[0] if pages else {}
    text = page.get("extract") or ""
    title = page.get("title") or ""
    if not text or not any(k in text for k in GAME):
        skipped += 1
        time.sleep(1.2)
        continue
    hit = BENMING_RE.search(text)
    name = hit.group(1) if hit else (title if NAME_RE.match(title) else "")
    if not name:
        skipped += 1
        time.sleep(1.2)
        continue
    names[tid] = name
    print(f"  {tid} -> {name}", flush=True)
    time.sleep(1.2)

out = os.path.join(RAW, "ZhNames.json")
old = {}
if os.path.exists(out):
    old = json.load(open(out, encoding="utf-8")).get("names", {})
old.update(names)
json.dump({"source": "zh.wikipedia.org", "names": old},
          open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print("wrote", out, len(old), "names (this run", len(names), "), skipped", skipped, flush=True)
