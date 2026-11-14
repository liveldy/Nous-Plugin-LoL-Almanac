"""Aggregate per-player career totals from ScoreboardPlayers with Cargo GROUP BY.

    python tools/fetch_stats.py raw CareerStats

`ScoreboardPlayers` holds one row per player per game — millions of rows, far
beyond a 4 MiB bundle. Aggregating server-side turns it into one row per player.

PlayerWin is the *text* "Yes"/"No" here, not 1/0: SUM(PlayerWin) silently
returns 0 for every player, while SUM(PlayerWin="Yes") gives the win count.

Files written (only the ones named on the command line):
  CareerStats.json  — games, wins, kills/deaths/assists, pentakills, gold, CS,
                      vision score, damage, first and last game
  ChampionPool.json — games and wins per champion (not shipped: the bundle
                      budget is already spent, see README)
  PlayerRoles.json  — games per in-game role per player (same, not shipped)

Credentials: LEAGUEPEDIA_BOT_USER / LEAGUEPEDIA_BOT_PASSWORD (see fetch.py).
"""
import json, os, sys, time

from mwcleric import FandomClient
from mwcleric.auth_credentials import AuthCredentials

OUT = sys.argv[1] if len(sys.argv) > 1 else "raw"
SPECS = {
    "CareerStats": dict(
        tables="ScoreboardPlayers",
        fields='Link,COUNT(*)=G,SUM(PlayerWin="Yes")=W,SUM(Kills)=K,SUM(Deaths)=D,SUM(Assists)=A,'
               "SUM(Pentakills)=PK,SUM(Gold)=GOLD,SUM(CS)=CS,SUM(VisionScore)=VS,"
               "SUM(DamageToChampions)=DMG,MIN(DateTime_UTC)=F,MAX(DateTime_UTC)=L",
        group_by="Link",
    ),
    "ChampionPool": dict(
        tables="ScoreboardPlayers",
        fields='Link,Champion,COUNT(*)=G,SUM(PlayerWin="Yes")=W',
        group_by="Link,Champion",
    ),
    "PlayerRoles": dict(
        tables="ScoreboardPlayers",
        fields="Link,IngameRole,COUNT(*)=G",
        group_by="Link,IngameRole",
    ),
}

user = os.environ.get("LEAGUEPEDIA_BOT_USER")
password = os.environ.get("LEAGUEPEDIA_BOT_PASSWORD")
creds = AuthCredentials(username=user, password=password) if user and password else None
site = FandomClient(wiki="lol", credentials=creds)
os.makedirs(OUT, exist_ok=True)

for name in sys.argv[2].split(","):
    spec = SPECS[name]
    path = os.path.join(OUT, name + ".json")
    if os.path.exists(path):
        print(name, "exists, skip")
        continue
    rows, offset, started = [], 0, time.time()
    while True:
        for attempt in range(6):
            try:
                resp = site.api("cargoquery", limit=500, offset=offset, format="json", **spec)
                break
            except Exception as e:
                print("  retry", attempt, repr(e)[:120], flush=True)
                time.sleep(6 * (attempt + 1))
        else:
            raise SystemExit("failed " + name)
        batch = [it["title"] for it in resp.get("cargoquery", [])]
        rows.extend(batch)
        if len(batch) < 500:
            break
        offset += len(batch)
        if offset % 10000 == 0:
            print(" ", name, offset, f"{time.time() - started:.0f}s", flush=True)
    json.dump(rows, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"{name}: {len(rows)} rows, {os.path.getsize(path) / 1048576:.2f} MB, "
          f"{time.time() - started:.0f}s", flush=True)
