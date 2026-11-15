"""Fetch player honours and portrait file names.

    python tools/fetch_honors.py raw                # all three tables
    python tools/fetch_honors.py raw Standings      # just one

Three Cargo tables, all keyed by the tournament overview page we already ship in
`tourn`, so the builder can join them without any extra map:

  Standings     TournamentResults where Place_Number<=4 — final standings: who
                won, who came second, who made top four. Joined with a player's
                tournament appearances (`tp`) this is the team half of a player's
                honours.
  Awards        IndividualAchievements — season awards (MVP, All-Pro Team, Best
                Rookie, Best Coach …), one row per award per tournament.
  PlayerImages  PlayerImages — the wiki file name of a player's headshot; several
                per player, `IsProfileImage` marks the profile ones.

Partitioning: deep OFFSET paging on Leaguepedia times out, and partitioning the
tournament tables by first letter puts every page starting with a year into one
enormous bucket. So standings are sliced by year, and the other two tables — the
ones keyed by person — by the first letter of the player column, with every
finished slice written to disk so a run can be resumed.

Credentials: LEAGUEPEDIA_BOT_USER / LEAGUEPEDIA_BOT_PASSWORD (see fetch.py).
"""
import json, os, sys, time

from mwcleric import FandomClient
from mwcleric.auth_credentials import AuthCredentials

OUT = sys.argv[1] if len(sys.argv) > 1 else "raw"
WANT = (sys.argv[2] if len(sys.argv) > 2 else "Standings,Awards,PlayerImages").split(",")

SPECS = {
    "Standings": dict(
        table="TournamentResults",
        fields="OverviewPage,Place,Place_Number,Team,Date",
        # 只收前四名。IsAchievement 不能用来筛：世界赛、MSI 这些最重要的赛事该字段是空的，
        # 用它筛只剩 936 个赛事，连 2024 全球总决赛都没有。
        base_where="Place_Number<=4",
        order="Date,OverviewPage",
        slices=[("y%d" % y, "Date >= '%d-01-01' AND Date < '%d-01-01'" % (y, y + 1))
                for y in range(2008, 2029)] + [("none", "Date IS NULL")],
    ),
    "Awards": dict(
        table="IndividualAchievements",
        fields="Player,Link,Team,Display,Place_Number,AchievementType,OverviewPage",
        base_where="",
        order="Player",
        slices=[],
    ),
    "PlayerImages": dict(
        table="PlayerImages",
        fields="FileName,Link,ImageType,IsProfileImage,SortDate",
        base_where="",
        order="Link",
        slices=[],
    ),
}

LETTERS = ["", "0", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
           "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "{"]
for key in ("Awards", "PlayerImages"):
    column = "Player" if key == "Awards" else "Link"
    SPECS[key]["slices"] = [
        ("l%02d" % i, ("%s < '%s'" % (column, LETTERS[i + 1])) if LETTERS[i] == ""
         else ("%s >= '%s' AND %s < '%s'" % (column, LETTERS[i], column, LETTERS[i + 1])))
        for i in range(len(LETTERS) - 1)
    ]

user = os.environ.get("LEAGUEPEDIA_BOT_USER")
password = os.environ.get("LEAGUEPEDIA_BOT_PASSWORD")
creds = AuthCredentials(username=user, password=password) if user and password else None
site = FandomClient(wiki="lol", credentials=creds)
os.makedirs(OUT, exist_ok=True)


def page(**kwargs):
    """One cargoquery page, backing off while the wiki rate-limits us."""
    for attempt in range(7):
        try:
            return site.client.api("cargoquery", format="json", limit=500, **kwargs)
        except Exception as e:
            wait = 8 * (attempt + 1)
            print("    retry", attempt, repr(e)[:110], "sleep", wait, flush=True)
            time.sleep(wait)
    raise SystemExit("cargoquery keeps failing")


for name in WANT:
    spec = SPECS[name]
    part_dir = os.path.join(OUT, name + "-parts")
    os.makedirs(part_dir, exist_ok=True)
    started, grand = time.time(), 0
    for tag, clause in spec["slices"]:
        where = clause
        if spec["base_where"]:
            where = "(%s) AND (%s)" % (clause, spec["base_where"])
        path = os.path.join(part_dir, tag + ".json")
        if os.path.exists(path):
            grand += len(json.load(open(path, encoding="utf-8")))
            continue
        rows, offset = [], 0
        while True:
            resp = page(tables=spec["table"], fields=spec["fields"], where=where,
                        order_by=spec["order"], offset=offset)
            batch = [it["title"] for it in resp.get("cargoquery", [])]
            rows.extend(batch)
            if len(batch) < 500:
                break
            offset += len(batch)
            time.sleep(1.2)
        json.dump(rows, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        grand += len(rows)
        print("  ", name, tag, len(rows), "total", grand, flush=True)
        time.sleep(1.2)
    merged = []
    for tag, _ in spec["slices"]:
        merged.extend(json.load(open(os.path.join(part_dir, tag + ".json"), encoding="utf-8")))
    path = os.path.join(OUT, name + ".json")
    json.dump(merged, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print("%s: %d rows, %.2f MB, %.0fs" % (
        name, len(merged), os.path.getsize(path) / 1048576, time.time() - started), flush=True)
