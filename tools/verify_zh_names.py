"""Verify Chinese player names against Chinese Wikipedia, then merge them in.

    python tools/verify_zh_names.py raw

tools/fetch_zh_names.py only finds the people whose article title is their ID.
The other well-known name route is the opposite one: take a name a Chinese
reader already uses (宋义进 for Rookie, 金赫奎 for Deft) and ask Chinese
Wikipedia whether that page is about a 《英雄聯盟》 player. A page that exists and
is about the game confirms the name and its owner; a page that is missing or
about something else drops it. Nothing is written on a guess.

Writes/merges raw/ZhNames.json, the file tools/build-data.mjs reads.
"""
import json, os, re, sys, time, urllib.error, urllib.parse, urllib.request

RAW = sys.argv[1] if len(sys.argv) > 1 else "raw"
API = "https://zh.wikipedia.org/w/api.php"
GAME = ("英雄聯盟", "英雄联盟", "電子競技", "电子竞技")

# (选手 ID, 中文名) —— 中文社区通行的写法；脚本只负责核对，不负责发明
PROPOSALS = [
    ("Bengi", "裴性雄"), ("Wolf", "李在完"), ("Bang", "裴俊植"), ("Duke", "李浩成"),
    ("Huni", "许承勋"), ("Peanut", "韩王浩"), ("Smeb", "宋坰浩"), ("Kuro", "李叙行"),
    ("Pray", "金钟仁"), ("GorillA", "姜范贤"), ("Score", "高东彬"), ("Mata", "赵世衡"),
    ("Deft", "金赫奎"), ("Pawn", "许元硕"), ("Rookie", "宋义进"), ("Khan", "金东河"),
    ("Cuzz", "文宇灿"), ("Bdd", "郭普成"), ("CuVee", "李圣真"), ("Crown", "李民浩"),
    ("Ambition", "姜璨用"), ("Ruler", "朴载赫"), ("CoreJJ", "曹容仁"), ("Chovy", "郑志勋"),
    ("Doran", "崔玄准"), ("Pyosik", "洪畅贤"), ("Viper", "朴到贤"), ("Tarzan", "李承勇"),
    ("Lehends", "孙施尤"), ("ShowMaker", "许秀"), ("Canyon", "金建敷"), ("Nuguri", "张夏权"),
    ("Ghost", "张容准"), ("BeryL", "赵乾熙"), ("Kingen", "黄星勋"), ("Zeka", "金建佑"),
    ("Gumayusi", "李民衡"), ("Keria", "柳岷析"), ("Zeus", "崔佑齐"), ("Oner", "文炫俊"),
    ("Teddy", "朴辰成"), ("Clid", "太敏奎"), ("Scout", "李汭燦"), ("Kanavi", "徐进赫"),
    ("Impact", "郑彦英"), ("Piglet", "蔡浚植"), ("Marin", "张敬禹"), ("Easyhoon", "李知勋"),
    ("Looper", "张亨禹"), ("Dandy", "崔仁揆"), ("Imp", "具丞彬"), ("Heart", "李官炯"),
    ("Blank", "姜善久"), ("Spirit", "李多允"), ("Fly", "宋容准"), ("Kellin", "金亨圭"),
]


def fetch(title):
    url = API + "?" + urllib.parse.urlencode({
        "action": "query", "titles": title, "prop": "extracts", "exintro": 1, "explaintext": 1,
        "exchars": 700, "redirects": 1, "format": "json", "formatversion": 2})
    req = urllib.request.Request(url, headers={"User-Agent": "lol-almanac-build/1.0 (offline data build)"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


players = {p["ID"] for p in json.load(open(os.path.join(RAW, "Players.json"), encoding="utf-8"))}
todo = [(i, n) for i, n in PROPOSALS if i in players]
print("verifying", len(todo), "names", flush=True)

ok, rejected = {}, []
for pid, name in todo:
    data = None
    for attempt in range(5):
        try:
            data = fetch(name)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(8 * (attempt + 1))
                continue
            break
        except Exception:
            time.sleep(3 * (attempt + 1))
    page = (data or {}).get("query", {}).get("pages", [{}])
    text = (page[0].get("extract") or "") if page else ""
    if text and any(k in text for k in GAME):
        ok[pid] = name
        print(f"  ok   {pid} {name}", flush=True)
    else:
        rejected.append(pid)
    time.sleep(1.2)

out = os.path.join(RAW, "ZhNames.json")
data = json.load(open(out, encoding="utf-8")) if os.path.exists(out) else {"source": "zh.wikipedia.org", "names": {}}
data["names"].update(ok)
json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print(f"confirmed {len(ok)}, rejected {len(rejected)} {rejected}", flush=True)
print("total names in", out, len(data["names"]), flush=True)
