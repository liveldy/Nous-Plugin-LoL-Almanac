#!/usr/bin/env node
/**
 * Builds the compact, dictionary-encoded dataset the plugin ships.
 * MIT. Input: raw Leaguepedia Cargo JSON in <raw>/ (see tools/fetch.py).
 * Output: <out>/dataset.json  (+ a size report on stderr)
 *
 * Encoding per column (chosen by fill rate / cardinality):
 *   dict  -> ints indexing DS  (0 = empty)
 *   raw   -> strings
 *   date  -> ints: days since 1980-01-01, +1; 0 = empty
 *   num   -> ints
 *   bool  -> folded into the player flag bitmask (see FLAGS)
 * Per-player tables are sorted by player and their player column delta-encoded,
 * which is what makes the whole thing fit in the plugin size limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const raw = path.resolve(process.argv[2] || 'raw');
const out = path.resolve(process.argv[3] || 'ui/data');

const read = (name) => JSON.parse(fs.readFileSync(path.join(raw, name + '.json'), 'utf8'));
const has = (name) => fs.existsSync(path.join(raw, name + '.json'));

/* ---------- primitives ---------- */
const BASE_YEAR = 1980;
const BASE_MS = Date.UTC(BASE_YEAR, 0, 1);
const DAY = 86400000;
const dateEnc = (v) => {
  if (!v) return 0;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (!m) return 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!Number.isFinite(t)) return 0;
  return Math.round((t - BASE_MS) / DAY) + 1;
};
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const stripProto = (v) => String(v || '').replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
// 少数自由文本字段里带着维基标记（'''粗体'''、<br>、[[File:…]]、&#8288;），显示前先清掉
const cleanText = (v) => String(v || '')
  .replace(/\[\[File:[^\]]*\]\]/gi, '')
  .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
  .replace(/<br\s*\/?>/gi, ' · ')
  .replace(/'''?/g, '')
  .replace(/&#?\w+;/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const CLEAN = new Set(['SoloqueueIds', 'ContractText']);

const DS = [''];
const dsIndex = new Map([['', 0]]);
const si = (v) => {
  if (v === undefined || v === null) return 0;
  const s = String(v);
  if (!s) return 0;
  let i = dsIndex.get(s);
  if (i === undefined) { i = DS.length; DS.push(s); dsIndex.set(s, i); }
  return i;
};
const teams = [''];
const teamIndex = new Map([['', 0]]);
const ti = (v) => {
  const s = String(v || '').trim();
  if (!s) return 0;
  let i = teamIndex.get(s);
  if (i === undefined) { i = teams.length; teams.push(s); teamIndex.set(s, i); }
  return i;
};

/* ---------- players ---------- */
const rawPlayers = read('Players');
const nP = rawPlayers.length;

// 界面是中文：Leaguepedia 的取值（国家、赛区、位置）按 tools/zh-terms.json 换掉，
// 表里没有的值原样保留。逗号分隔的多重国籍逐项翻译后用「、」连接。
const TERMS = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'zh-terms.json'), 'utf8'));
const localize = (map, v) => {
  const parts = String(v || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => (map[s] !== undefined ? map[s] : s));
  return parts.join('、');
};
const TERM_FIELD = {
  Country: 'country', Nationality: 'country', NationalityPrimary: 'country',
  Residency: 'residency', ResidencyFormer: 'residency', Role: 'role', RoleLast: 'role',
  NameAlphabet: 'alphabet',
};
// 中文名：记录本身用汉字写的，就是选手的中文名；其余来自 tools/fetch_zh_names.py 抓的维基条目
const ZH = has('ZhNames') ? (read('ZhNames').names || {}) : {};
const isCJK = (s) => /[\u4e00-\u9fa5]/.test(String(s || ''));
// 界面是简体，维基条目偶尔给的是繁体写法
const T2S = { 鄭: '郑', 勳: '勋', 軒: '轩', 燦: '灿', 録: '录' };
const toSimp = (s) => String(s || '').replace(/[鄭勳軒燦録]/g, (c) => T2S[c]);

const FLAGS = ['IsRetired', 'ToWildrift', 'ToValorant', 'ToTFT', 'ToLegendsOfRuneterra', 'To2XKO',
  'IsPersonality', 'IsSubstitute', 'IsLowercase', 'IsAutoTeam', 'IsLowContent'];
const SCALARS = {
  ID: 'raw', OverviewPage: 'raw', Name: 'raw', NativeName: 'raw', NameAlphabet: 'dict',
  Country: 'dict', Nationality: 'dict', NationalityPrimary: 'dict', Age: 'num', Birthdate: 'date',
  Deathdate: 'date', Residency: 'dict', ResidencyFormer: 'dict', Team: 'team', Team2: 'team',
  Role: 'dict', Contract: 'date', ContractText: 'dict', FavChamps: 'raw', SoloqueueIds: 'raw',
  TeamLast: 'team', RoleLast: 'dict', NameZh: 'dict',
};
const URL_FIELDS = new Set(['Askfm', 'Bluesky', 'Discord', 'Facebook', 'Instagram', 'Lolpros', 'DEEPLOL', 'DPMLOL',
  'Reddit', 'Snapchat', 'Stream', 'KICK', 'Tiktok', 'Twitter', 'Threads', 'LinkedIn', 'Vk', 'Website', 'Weibo', 'Youtube']);
for (const f of URL_FIELDS) SCALARS[f] = 'raw';

const cols = {};
for (const f of Object.keys(SCALARS)) cols[f] = new Array(nP);
const flags = new Array(nP).fill(0);

const playerIdxByPage = new Map();
rawPlayers.forEach((p, i) => playerIdxByPage.set(p.OverviewPage, i));
const idIndex = new Map();
rawPlayers.forEach((p, i) => { if (!idIndex.has(p.ID)) idIndex.set(p.ID, i); });
const lowerIndex = new Map();
rawPlayers.forEach((p, i) => {
  const a = p.OverviewPage.toLowerCase();
  if (!lowerIndex.has(a)) lowerIndex.set(a, i);
  const b = p.ID.toLowerCase();
  if (!lowerIndex.has(b)) lowerIndex.set(b, i);
});
const rawRedirects = has('PlayerRedirects') ? read('PlayerRedirects') : [];
const aliasMap = new Map();
for (const r of rawRedirects) {
  const page = playerIdxByPage.get(r.OverviewPage);
  if (page === undefined || !r.ID || r.ID === rawPlayers[page].ID) continue;
  if (aliasMap.has(r.ID)) continue;
  aliasMap.set(r.ID, page);
}
const unresolved = new Set();
function resolvePlayer(name) {
  if (!name) return -1;
  let i = playerIdxByPage.get(name);
  if (i !== undefined) return i;
  i = idIndex.get(name);
  if (i !== undefined) return i;
  i = aliasMap.get(name);
  if (i !== undefined) return i;
  i = lowerIndex.get(name.toLowerCase());
  if (i !== undefined) return i;
  const cut = name.indexOf(' (');
  if (cut > 0) {
    const base = name.slice(0, cut);
    i = playerIdxByPage.get(base);
    if (i !== undefined) return i;
    i = lowerIndex.get(base.toLowerCase());
    if (i !== undefined) return i;
  }
  unresolved.add(name);
  return -1;
}

rawPlayers.forEach((p, i) => {
  for (const [f, kind] of Object.entries(SCALARS)) {
    let v = CLEAN.has(f) ? cleanText(p[f]) : p[f];
    if (TERM_FIELD[f]) v = localize(TERMS[TERM_FIELD[f]], v);
    if (f === 'NameZh') v = toSimp(isCJK(p.NativeName) ? cleanText(p.NativeName) : (ZH[p.ID] || ''));
    if (kind === 'raw') cols[f][i] = URL_FIELDS.has(f) ? stripProto(v) : (v || '');
    else if (kind === 'dict') cols[f][i] = si(v);
    else if (kind === 'team') cols[f][i] = ti(v);
    else if (kind === 'date') cols[f][i] = dateEnc(v);
    else cols[f][i] = num(v);
  }
  // 资料页多数等于 ID：为 0 时由页面回退到 ID，省掉近两万个重复字符串
  if (p.OverviewPage === p.ID) cols.OverviewPage[i] = 0;
  let mask = 0;
  FLAGS.forEach((f, bit) => { if (p[f] === '1') mask |= 1 << bit; });
  flags[i] = mask;
});
cols.fl = flags;

/* ---------- sorted per-player tables, delta-encoded player column ---------- */
function makeTable(rows, compare, build) {
  rows.sort(compare);
  const t = build(rows);
  // first entry absolute, then deltas
  const dp = new Array(t.p.length);
  let prev = 0;
  for (let i = 0; i < t.p.length; i++) { dp[i] = t.p[i] - prev; prev = t.p[i]; }
  t.pd = dp;
  delete t.p;
  t.n = dp.length;
  return t;
}

/* tenures */
let tenures = { pd: [], t: [], j: [], l: [], ce: [], nx: [], cur: [], n: 0 };
if (has('Tenures')) {
  const rows = [];
  for (const r of read('Tenures')) {
    const p = resolvePlayer(r.Player);
    if (p < 0) continue;
    rows.push({
      p, t: ti(r.Team), j: dateEnc(r.DateJoin), l: dateEnc(r.DateLeave),
      ce: r.ContractEnd ? si(r.ContractEnd) : 0,
      nx: (r.NextIsRetired === '1' ? 1 : 0) | (r.NextIsWildrift === '1' ? 2 : 0) | (r.NextIsDeceased === '4' ? 4 : 0),
      cur: r.IsCurrent === '1' ? 1 : 0,
    });
  }
  tenures = makeTable(rows, (a, b) => a.p - b.p || a.j - b.j, (list) => ({
    p: list.map((r) => r.p), t: list.map((r) => r.t), j: list.map((r) => r.j), l: list.map((r) => r.l),
    ce: list.map((r) => r.ce), nx: list.map((r) => r.nx), cur: list.map((r) => r.cur),
  }));
}

/* contracts */
let contracts = { pd: [], t: [], e: [], rm: [], n: 0 };
if (has('Contracts')) {
  const rows = [];
  for (const r of read('Contracts')) {
    const p = resolvePlayer(r.Player);
    if (p < 0) continue;
    rows.push({ p, t: ti(r.Team), e: dateEnc(r.ContractEnd), rm: r.IsRemoval === '1' ? 1 : 0 });
  }
  contracts = makeTable(rows, (a, b) => a.p - b.p || a.e - b.e, (list) => ({
    p: list.map((r) => r.p), t: list.map((r) => r.t), e: list.map((r) => r.e), rm: list.map((r) => r.rm),
  }));
}

/* tournaments */
const tournNames = [''];
const tournIndex = new Map([['', 0]]);
const tourn = { name: [], league: [], region: [], date: [], level: [], prize: [], cur: [], qual: [], play: [], off: [], split: [], n: 0 };
const tournId = (page) => {
  const s = String(page || '').trim();
  if (!s) return 0;
  let i = tournIndex.get(s);
  if (i === undefined) { i = tournNames.length; tournNames.push(s); tournIndex.set(s, i); }
  return i;
};
if (has('Tournaments')) {
  for (const r of read('Tournaments')) {
    const id = tournId(r.OverviewPage);
    tourn.name[id] = r.Name || r.OverviewPage;
    tourn.league[id] = si(r.League);
    tourn.region[id] = si(r.Region);
    tourn.date[id] = dateEnc(r.DateStart || r.Date || r.DateStartFuzzy);
    tourn.level[id] = si(r.TournamentLevel);
    tourn.prize[id] = num(String(r.Prizepool || '').replace(/[^\d]/g, ''));
    tourn.cur[id] = si(r.Currency);
    tourn.qual[id] = r.IsQualifier === '1' ? 1 : 0;
    tourn.play[id] = r.IsPlayoffs === '1' ? 1 : 0;
    tourn.off[id] = r.IsOfficial === '1' ? 1 : 0;
    tourn.split[id] = si(r.Split);
  }
  tourn.n = tournNames.length;
  for (let i = 1; i < tourn.n; i++) {
    tourn.name[i] ||= tournNames[i];
    tourn.league[i] ||= 0;
  }
}

/* tournament appearances — 资格赛不收录；战队只在与履历推导值不同时才存 */
let tp = { pd: [], t: [], team: [], n: 0 };
if (has('TournamentPlayers')) {
  // 履历按选手建立区间，用来推导赛事期间所属战队
  const byPlayer = new Map();
  {
    let acc = 0;
    for (let k = 0; k < tenures.pd.length; k++) {
      acc += tenures.pd[k];
      let list = byPlayer.get(acc);
      if (!list) { list = []; byPlayer.set(acc, list); }
      list.push([tenures.j[k] || 0, tenures.l[k] || 99999999, tenures.t[k]]);
    }
  }
  const teamAt = (p, date) => {
    const list = byPlayer.get(p);
    if (!list || !date) return 0;
    let hit = 0;
    for (const [j, l, t] of list) if (j && j <= date && (l === 0 || l >= date)) hit = t;
    return hit;
  };

  const seen = new Set();
  const rows = [];
  const drop = { qualifier: 0, unresolved: 0, repeat: 0 };
  for (const r of read('TournamentPlayers')) {
    const t = tournIndex.get(String(r.OverviewPage || '').trim());
    if (!t || tourn.qual[t] === 1) { drop.qualifier++; continue; }
    const p = resolvePlayer(r.Player || r.Link);
    if (p < 0) { drop.unresolved++; continue; }
    const key = p + '|' + t;
    if (seen.has(key)) { drop.repeat++; continue; }
    seen.add(key);
    const derived = teamAt(p, tourn.date[t]);
    const name = String(r.Team || '').trim();
    rows.push({ p, t, team: derived && name && name !== teams[derived] ? ti(name) : 0 });
  }
  tp = makeTable(rows, (a, b) => a.p - b.p || a.t - b.t, (list) => ({
    p: list.map((r) => r.p), t: list.map((r) => r.t), team: list.map((r) => r.team),
  }));
  tp.drop = drop;
}

/* career stats — 合计之外存场均，数字更小，压缩后更省 */
let stats = null;
if (has('CareerStats')) {
  // 同一选手可能有多条聚合行（战绩页里的旧 ID、重名重定向都会解析到同一档案），
  // 只保留出场最多的一条：它就是这名选手的生涯总计，其余是零散的别名记录。
  const best = new Map();
  for (const r of read('CareerStats')) {
    const p = resolvePlayer(r.Link);
    if (p < 0) continue;
    const g = num(r.G);
    if (!g) continue;
    const prev = best.get(p);
    if (!prev || g > num(prev.G)) best.set(p, r);
  }
  const rows = [];
  for (const [p, r] of best) {
    const g = num(r.G);
    const per = (v) => Math.round(num(v) / g);
    rows.push({
      p, g, w: num(r.W), k: num(r.K), d: num(r.D), a: num(r.A), pk: num(r.PK),
      gold: per(r.GOLD), cs: Math.round(num(r.CS) / g * 10), vs: Math.round(num(r.VS) / g * 10),
      dmg: per(r.DMG),
      first: dateEnc(r.F), last: dateEnc(r.L),
    });
  }
  rows.sort((a, b) => a.p - b.p);
  stats = {
    p: rows.map((r) => r.p), g: rows.map((r) => r.g), w: rows.map((r) => r.w), k: rows.map((r) => r.k),
    d: rows.map((r) => r.d), a: rows.map((r) => r.a), pk: rows.map((r) => r.pk),
    gold: rows.map((r) => r.gold), cs: rows.map((r) => r.cs), vs: rows.map((r) => r.vs),
    dmg: rows.map((r) => r.dmg),
    first: rows.map((r) => r.first), last: rows.map((r) => r.last), n: rows.length,
  };
}

/* champion pool (top 8 per player) */
let champs = null;
if (has('ChampionPool')) {
  const byPlayer = new Map();
  for (const r of read('ChampionPool')) {
    const p = resolvePlayer(r.Link);
    if (p < 0) continue;
    let list = byPlayer.get(p);
    if (!list) { list = []; byPlayer.set(p, list); }
    list.push({ c: si(r.Champion), g: num(r.G), w: num(r.W) });
  }
  const players = [...byPlayer.keys()].sort((a, b) => a - b);
  const o = { p: [], c: [], g: [], w: [], n: 0 };
  for (const p of players) {
    const list = byPlayer.get(p).sort((x, y) => y.g - x.g).slice(0, 8);
    for (const row of list) { o.p.push(p); o.c.push(row.c); o.g.push(row.g); o.w.push(row.w); }
  }
  o.n = o.p.length;
  champs = o;
}

/* aliases */
const aliasRows = [...aliasMap.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
const aliases = { p: aliasRows.map(([, p]) => p), names: aliasRows.map(([n]) => n), n: aliasRows.length };

const dataset = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: 'Leaguepedia Cargo API (lol.fandom.com)',
  zhNamesSource: 'zh.wikipedia.org + 选手档案里的汉字本名',
  counts: {
    players: nP, tenures: tenures.n, contracts: contracts.n, tournaments: tournNames.length - 1,
    appearances: tp.n, stats: stats ? stats.n : 0, champions: champs ? champs.n : 0, aliases: aliases.n,
    zhNames: cols.NameZh.filter((v) => v).length,
  },
  base: BASE_YEAR,
  flags: FLAGS,
  S: DS,
  teams,
  tournNames,
  fields: SCALARS,
  columns: cols,
  tenures, contracts, tourn, tp, stats, champs, aliases,
};

fs.mkdirSync(out, { recursive: true });
const file = path.join(out, 'dataset.json');
fs.writeFileSync(file, JSON.stringify(dataset));
const bytes = fs.statSync(file).size;
const gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
console.log(JSON.stringify({
  file, counts: dataset.counts,
  raw: (bytes / 1048576).toFixed(2) + ' MB',
  gzip: (gz.length / 1048576).toFixed(2) + ' MB',
  base64: (gz.toString('base64').length / 1048576).toFixed(2) + ' MB',
  dropped: tp.drop || null,
  unresolvedNames: unresolved.size,
  strings: DS.length, teams: teams.length - 1, tournaments: tournNames.length - 1,
}, null, 1));
