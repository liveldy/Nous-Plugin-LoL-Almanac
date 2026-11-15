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

// 数字列一律存成定宽二进制再 base64：同样两百万个整数，十进制文本约 9 MB，u16 二进制只要 4 MB，
// gzip 之后差距同样明显 —— 省下来的预算留给队标、选手肖像和英雄图标。
const packInts = (arr) => {
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  const w = max < 256 ? 'u8' : max < 65536 ? 'u16' : 'u32';
  const Type = w === 'u8' ? Uint8Array : w === 'u16' ? Uint16Array : Uint32Array;
  const typed = new Type(arr.length);
  for (let i = 0; i < arr.length; i++) typed[i] = arr[i] || 0;
  return { w, d: Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64') };
};
// 把对象里的每个数字列就地换成 {w,d}；字符串列（战队名、赛事名、曾用名、ID 等 raw 列）原样保留
const packColumns = (obj, skip = []) => {
  for (const k of Object.keys(obj)) {
    if (skip.includes(k)) continue;
    const arr = obj[k];
    if (!Array.isArray(arr)) continue;
    if (arr.some((v) => typeof v === 'string')) continue;
    obj[k] = packInts(arr);
  }
  return obj;
};
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
const CLEAN = new Set(['ContractText']);

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

/* ---------- artwork metadata (tools/build-icons.py) ---------- */
// 宿主 iframe 里 connect-src 是 'none'，图片只能在构建时下载好、作为 data URL 打进包里。
// build-icons.py 把图标拼成两张精灵图，这里只记下每张图的网格参数，以及「队名 / 英雄名 → 槽位」。
const ICON_DIR = path.resolve(process.env.ICONS_DIR || 'build');
const readIcon = (f) => {
  const p = path.join(ICON_DIR, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};
const iconMeta = readIcon('icons.json');
const champMeta = (readIcon('champions.json') || []).filter((c) => c.slot >= 0).sort((a, b) => a.slot - b.slot);
const normChamp = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Leaguepedia 的写法与 Data Dragon 的键偶尔对不上
const CHAMP_ALIAS = { wukong: 'MonkeyKing', renataglasc: 'Renata', nunuwillump: 'Nunu' };
const champSlotByName = new Map(champMeta.map((c) => [normChamp(c.key), c.slot]));
const champSlot = (name) => {
  const n = normChamp(name);
  const slot = champSlotByName.get(CHAMP_ALIAS[n] !== undefined ? normChamp(CHAMP_ALIAS[n]) : n);
  return slot === undefined ? -1 : slot;
};
const champZh = champMeta.map((c) => c.zh);
const champEn = champMeta.map((c) => c.key);
const champTitle = champMeta.map((c) => c.title || '');

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
const tterm = (map, v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  return TERMS[map] && TERMS[map][s] !== undefined ? TERMS[map][s] : s;
};
// 赛事名：先去掉 <s> 删除线标记，再按词组替换（长的先替换，按词边界匹配），最后去掉中文之间的空格
const PHRASES = (TERMS.event || []).slice().sort((a, b) => b[0].length - a[0].length)
  .map(([from, to]) => [
    new RegExp('(?<![A-Za-z])' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])', 'gi'), to,
  ]);
const localizeEvent = (v) => {
  let s = String(v || '').replace(/<\/?s>/gi, '').trim();
  s = s.replace(/\bSeason (\d+)\b/gi, '第 $1 赛季').replace(/\bSplit (\d+)\b/gi, '第 $1 赛段')
    .replace(/\bRounds? (\d+)([-–]\d+)?\b/gi, (m, a, b) => '第 ' + a + (b || '') + ' 轮')
    .replace(/\bRound ([IVX]+)\b/g, '第 $1 轮');
  for (const [rx, to] of PHRASES) s = s.replace(rx, to);
  // 逐词替换会拼出「锦标赛秋季赛赛季」这种重复，收一下尾
  return s.replace(/赛赛季|赛赛/g, '赛')
    .replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1').replace(/\s{2,}/g, ' ').trim();
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
  Role: 'dict', Contract: 'date', ContractText: 'dict',
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

/* ---------- 招牌英雄：CSR 表，槽位指向英雄精灵图 ---------- */
// 原字段是「Riven,Fiora,Jayce」这样的字符串，6,832 名选手各存一遍很占体积；
// 换成「每人数量 + 连续的槽位下标」两张小表，界面上就能直接画出图标与中文名。
const favCount = new Array(nP).fill(0);
const favSlots = [];
const favMissing = new Set();
rawPlayers.forEach((p, i) => {
  const names = String(p.FavChamps || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const name of names) {
    const slot = champSlot(name);
    if (slot < 0) { favMissing.add(name); continue; }
    favSlots.push(slot + 1);
    favCount[i]++;
  }
});
const fav = { c: packInts(favCount), s: packInts(favSlots), n: favSlots.length };

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
let tenures = { pd: [], t: [], j: [], l: [], cur: [], n: 0 };
if (has('Tenures')) {
  const rows = [];
  for (const r of read('Tenures')) {
    const p = resolvePlayer(r.Player);
    if (p < 0) continue;
    rows.push({
      p, t: ti(r.Team), j: dateEnc(r.DateJoin), l: dateEnc(r.DateLeave),
      cur: r.IsCurrent === '1' ? 1 : 0,
    });
  }
  tenures = makeTable(rows, (a, b) => a.p - b.p || a.j - b.j, (list) => ({
    p: list.map((r) => r.p), t: list.map((r) => r.t), j: list.map((r) => r.j), l: list.map((r) => r.l),
    cur: list.map((r) => r.cur),
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
const tourn = { name: [], league: [], region: [], date: [], qual: [], n: 0 };
const major = new Set();  // 主流联赛 / 国际赛事：只有它们的名次进荣誉表
const rawLeague = [];     // 原始 League 取值，只用来判断「是不是主流联赛」
const playoffIds = new Set();  // IsPlayoffs=1 的赛事：真正的淘汰赛阶段，名次才有分量
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
    // 赛事名与联赛名走中文：俱乐部名保持原文，赛事名按词组替换，联赛名查表
    tourn.name[id] = localizeEvent(r.Name || r.OverviewPage);
    tourn.league[id] = si(tterm('league', r.League));
    tourn.region[id] = si(tterm('region', r.Region));
    tourn.date[id] = dateEnc(r.DateStart || r.Date || r.DateStartFuzzy);
    tourn.qual[id] = r.IsQualifier === '1' ? 1 : 0;
    rawLeague[id] = String(r.League || '').trim();
    if (r.IsPlayoffs === '1') playoffIds.add(id);
  }
  tourn.n = tournNames.length;
  for (let i = 1; i < tourn.n; i++) {
    tourn.name[i] ||= tournNames[i];
    tourn.league[i] ||= 0;
  }
}

/* 阶段页归一：edition 页面「2024 Season World Championship」底下挂着「/Main Event」「/Play-In」
   这些阶段页，名次表记在edition 页上、参赛记录常常记在阶段页上。荣誉对齐前把阶段页折回edition 页，
   否则 2023 年以后的全球总决赛冠军一个都对不上（tp 里全是「/Main Event」）。 */
const PHASE_PAGE = /^(main event|play-?in( stage)?|group stage|knockout stage|swiss stage|bracket)$/i;
const canon = new Uint32Array(tournNames.length);
for (let i = 1; i < tournNames.length; i++) {
  let page = tournNames[i];
  let id = i;
  for (;;) {
    const cut = page.lastIndexOf('/');
    if (cut < 0 || !PHASE_PAGE.test(page.slice(cut + 1))) break;
    const pid = tournIndex.get(page.slice(0, cut));
    if (!pid) break;
    page = page.slice(0, cut);
    id = pid;
  }
  canon[i] = id;
}
// 荣誉只收「有公认中文名的联赛」（zh-terms 的 league 表）与国际赛事的名次：
// 全部赛事的名次有 13 万条、要 300 KB 压缩体积，而且大半是边缘赛区、常规赛与线上赛
for (let i = 1; i < tournNames.length; i++) if (TERMS.league[rawLeague[i]]) major.add(canon[i]);

/* tournament appearances — 资格赛不收录；战队只在与履历推导值不同时才存 */
let tp = { pd: [], t: [], team: [], n: 0 };
let tpRows = [];
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
    // `names` 只在这一步用来和名次表对齐，打包前删掉
    rows.push({
      p, t, team: derived && name && name !== teams[derived] ? ti(name) : 0,
      names: [derived ? teams[derived] : '', name].filter(Boolean),
    });
  }
  tpRows = rows;
  tp = makeTable(rows, (a, b) => a.p - b.p || a.t - b.t, (list) => ({
    p: list.map((r) => r.p), t: list.map((r) => r.t), team: list.map((r) => r.team),
  }));
  tp.drop = drop;
}

/* 荣誉 —— 两张 Cargo 表，都以赛事页面为键，和上面的 (选手, 赛事, 战队) 行直接对齐
   Standings  TournamentResults 的前四名：谁夺冠、谁亚军、谁进四强
   Awards     IndividualAchievements 的赛季奖项：MVP、最佳阵容、最佳新秀……
   「谁是冠军」是战队成绩，只有选手在该赛事的登记战队与名次行一致时才算到他头上；
   战队名两边可能写法不同（登记页写 T1、名次行写 T1），所以按名字对，不按履历推导。 */
let honors = { title: null, award: null, awardNames: [] };
{
  // 只有「主流联赛的淘汰赛」与「国际赛事」的名次算荣誉：常规赛第 3 名、资格赛、线上赛
  // 都不是奖杯，而且全部收进来要 13 万条、300 KB 压缩体积
  const INTL = new Set(['World Championship', 'Mid-Season Invitational', 'Rift Rivals', 'All-Star']);
  const isIntl = (id) => INTL.has(rawLeague[id]);
  const worthy = (id) => major.has(canon[id]) === false ? false
    : (isIntl(canon[id]) || isIntl(id) || playoffIds.has(canon[id]) || playoffIds.has(id));

  const place = new Map();  // "<赛事下标>|<战队名>" -> 最好名次（1..4）
  let skipped = 0;
  if (has('Standings')) {
    for (const r of read('Standings')) {
      const raw = tournIndex.get(String(r.OverviewPage || '').trim());
      if (!raw || tourn.qual[raw] === 1) continue;
      const t = canon[raw];
      if (!worthy(raw)) { skipped++; continue; }
      const n = num(r['Place Number']);
      const team = String(r.Team || '').trim();
      if (!n || n > 4 || !team) continue;
      const key = t + '|' + team;
      const prev = place.get(key);
      if (prev === undefined || n < prev) place.set(key, n);
    }
  }
  // tp 的行记在阶段页上，对齐前同样折回 edition 页；同一届赛事只留一行
  const titleRows = [];
  const seenTitle = new Set();
  for (const row of tpRows) {
    const t = canon[row.t];
    let best = 0;
    for (const name of row.names) {
      const n = place.get(t + '|' + name);
      if (n && (!best || n < best)) best = n;
    }
    if (!best) continue;
    const key = row.p + '|' + t;
    if (seenTitle.has(key)) continue;
    seenTitle.add(key);
    titleRows.push({ p: row.p, t, dt: tourn.date[t] || 0, pl: best });
  }

  // 奖项：Display 按 zh-terms.json 的 award 表换中文，表外的保持原文（构建结束会打印）
  const awardNames = [];
  const awardIdx = new Map();
  const ai = (label) => {
    let i = awardIdx.get(label);
    if (i === undefined) { i = awardNames.length; awardNames.push(label); awardIdx.set(label, i); }
    return i;
  };
  const awardRows = [];
  const awardMissing = new Map();
  if (has('Awards')) {
    const seen = new Set();
    for (const r of read('Awards')) {
      const raw = tournIndex.get(String(r.OverviewPage || '').trim()) || 0;
      if (raw && tourn.qual[raw] === 1) continue;
      const t = raw ? canon[raw] : 0;
      const p = resolvePlayer(r.Link || r.Player);
      if (p < 0) continue;
      const en = String(r.Display || '').trim();
      if (!en) continue;
      let zh = TERMS.award[en];
      if (!zh) {
        zh = en;  // 词表外的奖项：原文照录，先记下来
        awardMissing.set(en, (awardMissing.get(en) || 0) + 1);
      }
      const a = ai(zh);
      const key = p + '|' + t + '|' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      awardRows.push({ p, t, dt: tourn.date[t] || 0, a });
    }
  }

  const byPlayer = (a, b) => a.p - b.p || b.dt - a.dt || a.t - b.t;
  if (titleRows.length) {
    honors.title = makeTable(titleRows, byPlayer, (list) => ({
      p: list.map((r) => r.p), t: list.map((r) => r.t), pl: list.map((r) => r.pl),
    }));
  }
  if (awardRows.length) {
    honors.award = makeTable(awardRows, byPlayer, (list) => ({
      p: list.map((r) => r.p), t: list.map((r) => r.t), a: list.map((r) => r.a),
    }));
  }
  honors.awardNames = awardNames;
  honors.awardMissing = [...awardMissing.entries()];
  honors.skipped = skipped;
}
for (const r of tpRows) delete r.names;  // 对齐用的临时字段，不进数据包

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

/* 选手肖像 —— 精灵图由 tools/build-portraits.py 拼好，这里只把「选手页面名 → 图块槽位」记成一列 */
let portraits = null;
{
  const meta = readIcon('portraits.json');
  if (meta && meta.count && Array.isArray(meta.order)) {
    const slot = new Array(nP).fill(0);
    let used = 0;
    meta.order.forEach((page, i) => {
      const p = resolvePlayer(page);
      if (p < 0 || slot[p]) return;
      slot[p] = i + 1;
      used++;
    });
    portraits = { slot, cols: meta.cols, size: meta.size, count: meta.count, used };
  }
}

/* aliases */
const aliasRows = [...aliasMap.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
const aliases = { p: aliasRows.map(([, p]) => p), names: aliasRows.map(([n]) => n), n: aliasRows.length };

const dataset = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: 'Leaguepedia Cargo API (lol.fandom.com)',
  zhNamesSource: 'zh.wikipedia.org + 选手档案里的汉字本名',
  iconsSource: 'Data Dragon (ddragon.leagueoflegends.com) + Leaguepedia wiki files',
  counts: {
    players: nP, tenures: tenures.n, contracts: contracts.n, tournaments: tourn.n,
    appearances: tp.n, stats: stats ? stats.n : 0, champions: champs ? champs.n : 0, aliases: aliases.n,
    zhNames: cols.NameZh.filter((v) => v).length,
    favouriteChampions: fav.n, championshipIcons: champZh.length,
    teamLogos: teams.reduce((acc, name, i) => acc + (i && iconMeta && iconMeta.teamSlots[name] !== undefined ? 1 : 0), 0),
    titles: honors.title ? honors.title.n : 0,
    awards: honors.award ? honors.award.n : 0,
    portraits: portraits ? portraits.used : 0,
  },
  base: BASE_YEAR,
  flags: FLAGS,
  S: DS,
  teams,
  fields: SCALARS,
  columns: packColumns(cols),
  tenures: packColumns(tenures),
  contracts: packColumns(contracts),
  tourn: packColumns(tourn, ['name']),
  tp: packColumns(tp),
  stats: stats ? packColumns(stats) : null,
  champs: champs ? packColumns(champs) : null,
  fav,
  aliases: packColumns(aliases, ['names']),
  // 荣誉：赛事名次（1 冠军 / 2 亚军 / 3-4 四强）与赛季奖项，都按选手索引
  honors: {
    title: honors.title ? packColumns(honors.title) : null,
    award: honors.award ? packColumns(honors.award) : null,
    awardNames: honors.awardNames,
  },
  // 肖像：每人一个槽位（0 = 没有），与下面 icons.player 的网格参数配合定位
  portraits: portraits ? {
    slot: packInts(portraits.slot), cols: portraits.cols, size: portraits.size, count: portraits.count,
  } : null,
  // 精灵图参数 + 槽位表：界面据此给队标、英雄图标和肖像定位，不需要再传任何图片文件名
  icons: {
    champ: iconMeta && iconMeta.champions
      ? { cols: iconMeta.champions.cols, size: iconMeta.champions.size, count: iconMeta.champions.count } : null,
    team: iconMeta && iconMeta.teams
      ? { cols: iconMeta.teams.cols, size: iconMeta.teams.size, count: iconMeta.teams.count } : null,
    player: portraits ? { cols: portraits.cols, size: portraits.size, count: portraits.count } : null,
  },
  champZh, champEn, champTitle,
  // 队名 → 队标槽位（0 = 该队没有图标）
  logo: packInts(teams.map((name) => {
    const slot = name && iconMeta && iconMeta.teamSlots ? iconMeta.teamSlots[name] : undefined;
    return slot === undefined ? 0 : slot + 1;
  })),
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
  awardMissing: honors.awardMissing || [],
  unresolvedNames: unresolved.size,
  favMissing: [...favMissing],
  strings: DS.length, teams: teams.length - 1, tournaments: tourn.n,
  awardNames: honors.awardNames.length,
}, null, 1));
