"""Fetch full Leaguepedia Cargo tables with mwcleric, resumable, to JSON files.

    python tools/fetch.py raw Players,Tenures,Tournaments,Contracts,PlayerRedirects

Credentials come from the environment (Leaguepedia bot password, optional —
the API also answers anonymously, just with tighter rate limits):

    LEAGUEPEDIA_BOT_USER, LEAGUEPEDIA_BOT_PASSWORD

A table already present in <raw>/ is skipped, so the script can be re-run after
an interruption. `requests` honours HTTPS_PROXY, which is how this ran on a
network where lol.fandom.com needed a local proxy.
"""
import json, os, sys, time

from mwcleric import FandomClient
from mwcleric.auth_credentials import AuthCredentials

OUT = sys.argv[1] if len(sys.argv) > 1 else "raw"
TABLES = sys.argv[2].split(",") if len(sys.argv) > 2 else ["Players"]

# `Players` is listed field by field: Image / ImageURL are not usable in an
# offline bundle (the host CSP only allows data: images), so they stay out.
SPEC = {
    "Players": "ID,OverviewPage,Player,Name,NativeName,NameAlphabet,NameFull,Country,Nationality,"
               "NationalityPrimary,Age,Birthdate,Deathdate,ResidencyFormer,Team,Team2,CurrentTeams,"
               "TeamSystem,Team2System,Residency,Role,Contract,ContractText,FavChamps,SoloqueueIds,"
               "Askfm,Bluesky,Discord,Facebook,Instagram,Lolpros,DEEPLOL,DPMLOL,Reddit,Snapchat,Stream,"
               "KICK,Tiktok,Twitter,Threads,LinkedIn,Vk,Website,Weibo,Youtube,TeamLast,RoleLast,"
               "IsRetired,ToWildrift,ToValorant,ToTFT,ToLegendsOfRuneterra,To2XKO,IsPersonality,"
               "IsSubstitute,IsTrainee,IsLowercase,IsAutoTeam,IsLowContent",
    "Tenures": "*",
    "TournamentPlayers": "Player,Team,OverviewPage,Role,IsDistribution",
    "Tournaments": "*",
    "Contracts": "*",
    "PlayerRedirects": "*",
}


def client():
    user = os.environ.get("LEAGUEPEDIA_BOT_USER")
    password = os.environ.get("LEAGUEPEDIA_BOT_PASSWORD")
    creds = AuthCredentials(username=user, password=password) if user and password else None
    return FandomClient(wiki="lol", credentials=creds)


def expand(site, table):
    """'*' asks Cargo itself which columns the table has."""
    if SPEC.get(table) != "*":
        return SPEC.get(table)
    meta = site.api("cargofields", table=table, format="json")["cargofields"]
    return ",".join(meta.keys())


site = client()
os.makedirs(OUT, exist_ok=True)

for table in TABLES:
    fields = expand(site, table)
    path = os.path.join(OUT, table + ".json")
    if os.path.exists(path):
        print(table, "exists, skip")
        continue
    rows, offset, started = [], 0, time.time()
    while True:
        for attempt in range(5):
            try:
                resp = site.api("cargoquery", tables=table, fields=fields, limit=500,
                                offset=offset, format="json")
                break
            except Exception as e:
                print("  retry", attempt, repr(e)[:120])
                time.sleep(6 * (attempt + 1))
        else:
            raise SystemExit("failed " + table)
        batch = [it["title"] for it in resp.get("cargoquery", [])]
        rows.extend(batch)
        if len(batch) < 500:
            break
        offset += len(batch)
        if offset % 20000 == 0:
            print(" ", table, offset, f"{time.time() - started:.0f}s", flush=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    print(f"{table}: {len(rows)} rows, {os.path.getsize(path) / 1048576:.2f} MB, "
          f"{time.time() - started:.0f}s", flush=True)
