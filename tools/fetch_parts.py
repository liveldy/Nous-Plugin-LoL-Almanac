"""Fetch a large Cargo table in resumable first-letter partitions.

    python tools/fetch_parts.py raw TournamentPlayers

Deep OFFSET paging on a 440k-row table is slow and fragile; partitioning the
WHERE clause by the first character of the player name keeps every page small,
and each finished partition is written to disk so the run can be resumed.
Writes <raw>/<table>-parts/part-NN.json and then merges them into
<raw>/<table>.json.

Credentials: LEAGUEPEDIA_BOT_USER / LEAGUEPEDIA_BOT_PASSWORD (see fetch.py).
"""
import json, os, sys, time

from mwcleric import FandomClient
from mwcleric.auth_credentials import AuthCredentials

OUT = sys.argv[1] if len(sys.argv) > 1 else "raw"
TABLE = sys.argv[2] if len(sys.argv) > 2 else "TournamentPlayers"
FIELDS = sys.argv[3] if len(sys.argv) > 3 else "Player,Team,OverviewPage,Role,IsDistribution"

BOUNDS = ["", "0", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
          "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "{"]
COLUMN = "Player" if TABLE == "TournamentPlayers" else "Link"

user = os.environ.get("LEAGUEPEDIA_BOT_USER")
password = os.environ.get("LEAGUEPEDIA_BOT_PASSWORD")
creds = AuthCredentials(username=user, password=password) if user and password else None
site = FandomClient(wiki="lol", credentials=creds)

part_dir = os.path.join(OUT, TABLE + "-parts")
os.makedirs(part_dir, exist_ok=True)
grand = 0
for i in range(len(BOUNDS) - 1):
    lo, hi = BOUNDS[i], BOUNDS[i + 1]
    where = f"{COLUMN} < '{hi}'" if lo == "" else f"{COLUMN} >= '{lo}' AND {COLUMN} < '{hi}'"
    path = os.path.join(part_dir, f"part-{i:02d}.json")
    if os.path.exists(path):
        grand += len(json.load(open(path, encoding="utf-8")))
        print("skip", i, lo, flush=True)
        continue
    rows, offset, started = [], 0, time.time()
    while True:
        for attempt in range(6):
            try:
                resp = site.api("cargoquery", tables=TABLE, fields=FIELDS, where=where,
                                order_by=COLUMN, limit=500, offset=offset, format="json")
                break
            except Exception as e:
                print("  retry", i, attempt, repr(e)[:100], flush=True)
                time.sleep(5 * (attempt + 1))
        else:
            raise SystemExit("failed partition " + str(i))
        batch = [it["title"] for it in resp.get("cargoquery", [])]
        rows.extend(batch)
        if len(batch) < 500:
            break
        offset += len(batch)
        time.sleep(0.15)
    json.dump(rows, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    grand += len(rows)
    print(f"part {i:02d} {lo or '_'}..{hi}: {len(rows)} rows in {time.time() - started:.0f}s "
          f"(total {grand})", flush=True)

merged = []
for i in range(len(BOUNDS) - 1):
    merged.extend(json.load(open(os.path.join(part_dir, f"part-{i:02d}.json"), encoding="utf-8")))
json.dump(merged, open(os.path.join(OUT, TABLE + ".json"), "w", encoding="utf-8"), ensure_ascii=False)
print("merged", len(merged), "rows ->", TABLE + ".json", flush=True)
