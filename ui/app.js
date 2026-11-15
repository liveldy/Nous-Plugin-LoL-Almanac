/* 英雄联盟职业选手图鉴 — 索引与档案. MIT. 数据快照见 data/dex.js */
(function () {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
  const list = $('#list'), listInner = $('#listInner'), dossier = $('#dossier');
  const qInput = $('#q'), boot = $('#boot'), bootLine = $('#bootLine'), bootBar = $('#bootBar');

  const host = window.NousPlugin || null;
  const supports = (m) => (host && host.supports ? host.supports(m) : false);

  /* ── boot ───────────────────────────────────────────── */
  const stage = (text, pct) => { bootLine.textContent = text; bootBar.style.width = pct + '%'; };

  /* ── decode ─────────────────────────────────────────── */
  function b64bytes(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'function') {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text();
    }
    throw new Error('当前运行环境不支持解压（需要 Chromium 80 及以上）');
  }

  // 数字列存的是 {w:'u8|u16|u32', d:base64}，这里就地还原成定型数组；字符串列（战队名、赛事名）不动。
  function expandColumns(D) {
    const dec = (col) => {
      const bin = b64bytes(col.d);
      if (col.w === 'u8') return bin;
      return col.w === 'u16' ? new Uint16Array(bin.buffer, 0, bin.length >> 1)
        : new Uint32Array(bin.buffer, 0, bin.length >> 2);
    };
    const walk = (obj, skip) => {
      if (!obj) return;
      for (const k of Object.keys(obj)) {
        if (skip && skip.includes(k)) continue;
        const v = obj[k];
        if (v && typeof v === 'object' && typeof v.d === 'string' && typeof v.w === 'string') obj[k] = dec(v);
      }
    };
    walk(D.columns);
    walk(D.tenures); walk(D.contracts); walk(D.tp); walk(D.stats); walk(D.aliases); walk(D.champs);
    walk(D.tourn, ['name']);
    walk(D.fav);
    if (D.logo && typeof D.logo.d === 'string') D.logo = dec(D.logo);
  }

  /* ── state ──────────────────────────────────────────── */
  let D, S, TEAMS, TOURNS, F;
  const state = {
    q: '', role: '', region: '', country: '', status: '', team: '', tourn: '',
    sort: 'name', view: [], sel: -1, detail: null, limit: {},
  };
  let P = null; // precomputed per-player arrays

  /* ── dates ──────────────────────────────────────────── */
  const DAY = 86400000;
  const BASE = Date.UTC(1980, 0, 1);
  function dateObj(n) { return n > 0 ? new Date(BASE + (n - 1) * DAY) : null; }
  function dateStr(n, sep = '.') {
    const d = dateObj(n);
    if (!d) return '';
    const p = (x) => String(x).padStart(2, '0');
    return d.getUTCFullYear() + sep + p(d.getUTCMonth() + 1) + sep + p(d.getUTCDate());
  }
  function yearOf(n) { const d = dateObj(n); return d ? d.getUTCFullYear() : ''; }
  function span(a, b, open) {
    const x = dateObj(a), y = dateObj(b);
    if (!x) return '';
    const ys = x.getUTCFullYear();
    const yb = y ? y.getUTCFullYear() : 0;
    if (open) return ys + '— 至今';
    if (!yb || yb === ys) return ys + ' —';
    return ys + '–' + yb;
  }

  /* ── string helpers ─────────────────────────────────── */
  const sv = (i) => (i ? S[i] || '' : '');
  // 列有两种编码：字典下标（dict/team）与原始字符串（raw），取值时按 fields 分开走
  const sval = (field, v) => (F[field] === 'raw' ? (v || '') : sv(v));
  const teamName = (i) => (i ? TEAMS[i] || '' : '');
  const num = (v) => (typeof v === 'number' ? v : 0);
  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n));
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

  /* ── icons (sprites packed into the CSS by the bundler) ─ */
  // 精灵图参数来自数据包；宿主 CSP 丢弃内联 style 属性，所以尺寸走自定义属性、位置走 CSSOM。
  function setIconScale() {
    const st = document.documentElement.style;
    const g = D.icons || {};
    if (g.champ) { st.setProperty('--cicon-size', g.champ.size + 'px'); st.setProperty('--cicon-w', g.champ.cols * g.champ.size + 'px'); }
    if (g.team) {
      st.setProperty('--tlogo-size', g.team.size + 'px');
      st.setProperty('--tlogo-w', g.team.cols * g.team.size + 'px');
      // 列表里的队标小一号（15px），精灵图按同比例缩放才不会错位
      st.setProperty('--tlogo-row-w', g.team.cols * 15 + 'px');
    }
  }
  const champLabel = (slot) => (slot >= 0 && D.champZh ? D.champZh[slot] || '' : '');
  const teamLogo = (teamIdx) => (teamIdx && D.logo ? (D.logo[teamIdx] || 0) - 1 : -1);
  function iconAt(el, kind, slot) {
    const g = D.icons && D.icons[kind];
    // 没有图标时占着位置但不显示：同一列里有无图标的行才会左对齐成一条线
    if (!g || slot === null || slot === undefined || slot < 0) { el.style.visibility = 'hidden'; return; }
    const col = slot % g.cols;
    el.style.backgroundPosition = -col * g.size + 'px ' + -Math.floor(slot / g.cols) * g.size + 'px';
  }
  function paintIcons(root) {
    for (const el of root.querySelectorAll('.cicon[data-slot]')) iconAt(el, 'champ', Number(el.dataset.slot));
    for (const el of root.querySelectorAll('.tlogo[data-slot]')) iconAt(el, 'team', Number(el.dataset.slot));
  }
  const champChip = (slot, extra) => {
    if (slot < 0) return '';
    const title = D.champTitle ? D.champTitle[slot] || '' : '';
    return '<span class="fav" title="' + esc((D.champEn && D.champEn[slot]) || '') + '">' +
      '<span class="cicon" data-slot="' + slot + '"></span>' +
      '<span class="fav-name">' + esc(champLabel(slot)) + '</span>' +
      (title ? '<span class="fav-title">' + esc(title) + '</span>' : '') +
      (extra || '') + '</span>';
  };
  const logoTip = (teamIdx) => '<span class="tlogo" data-slot="' + teamLogo(teamIdx) + '"></span>';

  /* ── field metadata ─────────────────────────────────── */
  const FLAG_LABELS = ['退役', '转无畏契约', '转云顶之弈', '转符文之地传奇', '转 2XKO', '内容创作者', '替补', '小写 ID', '自动战队', '低关注度'];
  // flag bit order in the dataset: IsRetired, ToWildrift, ToValorant, ToTFT, ToLegendsOfRuneterra, To2XKO, IsPersonality, IsSubstitute, IsLowercase, IsAutoTeam, IsLowContent
  const FLAG_NAMES = ['退役', '转战无畏契约', '转战 TFT', '转战符文之地', '转战 2XKO', '内容创作者', '替补', '小写 ID', '战队自动生成', '内容较少'];

  const SOCIALS = [
    ['Twitter', 'X', 'twitter.com/'],
    ['Stream', '直播', ''],
    ['Youtube', 'YouTube', 'youtube.com/'],
    ['Instagram', 'Instagram', 'instagram.com/'],
    ['Facebook', 'Facebook', 'facebook.com/'],
    ['Weibo', '微博', 'weibo.com/'],
    ['Tiktok', 'TikTok', 'tiktok.com/@'],
    ['Discord', 'Discord', 'discord.gg/'],
    ['Reddit', 'Reddit', 'reddit.com/'],
    ['Bluesky', 'Bluesky', 'bsky.app/'],
    ['Threads', 'Threads', 'threads.net/@'],
    ['LinkedIn', 'LinkedIn', 'linkedin.com/in/'],
    ['Vk', 'VK', 'vk.com/'],
    ['Snapchat', 'Snapchat', 'snapchat.com/add/'],
    ['Askfm', 'Ask.fm', 'ask.fm/'],
    ['KICK', 'Kick', 'kick.com/'],
    ['Website', '官网', ''],
  ];
  const PROFILE_LINKS = [
    ['Lolpros', 'LOLPros', 'lolpros.gg/player/'],
    ['DEEPLOL', 'DeepLoL', ''],
    ['DPMLOL', 'DPM.LOL', ''],
  ];

  const FACTS = [
    ['Birthdate', '出生日期', 'date'],
    ['Age', '年龄', 'num'],
    ['Nationality', '国籍', 'dict'],
    ['NationalityPrimary', '主要国籍', 'dict'],
    ['ResidencyFormer', '曾属赛区', 'dict'],
    ['RoleLast', '历任位置', 'list'],
    ['Team2', '次级战队', 'team'],
    ['TeamLast', '最后效力', 'team'],
    ['Contract', '合同到期', 'date'],
    ['ContractText', '合同说明', 'dict'],
    ['SoloqueueIds', '排位账号', 'text'],
    ['NameAlphabet', '文字系统', 'dict'],
    ['Deathdate', '逝世日期', 'date'],
  ];

  /* ── build indexes ──────────────────────────────────── */
  function build() {
    S = D.S; TEAMS = D.teams; TOURNS = D.tourn.name; F = D.fields;
    setIconScale();
    const cols = D.columns;
    const n = D.counts.players;
    const id = cols.ID, page = cols.OverviewPage, name = cols.Name, native = cols.NativeName,
      country = cols.Country, role = cols.Role, region = cols.Residency, team = cols.Team, fl = cols.fl,
      zh = cols.NameZh;

    P = {
      id: new Array(n), page: new Array(n), name: new Array(n), native: new Array(n), zh: new Array(n),
      country: new Array(n), role: new Array(n), region: new Array(n), team: new Array(n),
      bit: new Array(n), search: new Array(n),
      games: new Int32Array(n), wins: new Int32Array(n), last: new Int32Array(n), first: new Int32Array(n),
      tenureCount: new Int16Array(n), eventCount: new Int16Array(n),
      aliasFrom: new Int32Array(n + 1),
    };
    for (let i = 0; i < n; i++) {
      P.id[i] = id[i] || '';
      P.page[i] = page[i] || P.id[i];
      P.name[i] = sval('Name', name[i]);
      P.native[i] = sval('NativeName', native[i]);
      P.zh[i] = zh ? sv(zh[i]) : '';
      P.country[i] = sv(country[i]);
      P.role[i] = sv(role[i]);
      P.region[i] = sv(region[i]);
      P.team[i] = teamName(team[i]);
      P.bit[i] = fl[i] || 0;
    }

    // prefix sums for delta-encoded player columns
    const prefix = (tbl) => {
      const pd = tbl.pd, out = new Int32Array(pd.length);
      let acc = 0;
      for (let i = 0; i < pd.length; i++) { acc += pd[i]; out[i] = acc; }
      tbl.abs = out;
      return out;
    };
    D.tenures.abs = prefix(D.tenures);
    D.contracts.abs = prefix(D.contracts);
    if (D.tp && D.tp.pd) D.tp.abs = prefix(D.tp);

    // per-player ranges (tables are sorted by player)
    const range = (abs, n2) => {
      const start = new Int32Array(n2 + 1);
      let j = 0;
      for (let i = 0; i < n2; i++) {
        while (j < abs.length && abs[j] < i) j++;
        start[i] = j;
      }
      start[n2] = abs.length;
      // fix: start[i] must be first index with abs === i; handle skipped players
      for (let i = n2 - 1; i >= 0; i--) if (start[i] > start[i + 1]) start[i] = start[i + 1];
      return start;
    };
    D.tenures.start = range(D.tenures.abs, n);
    D.contracts.start = range(D.contracts.abs, n);
    if (D.tp && D.tp.abs) D.tp.start = range(D.tp.abs, n);
    P.tenureCount = countPer(D.tenures.start, n);
    if (D.tp) P.eventCount = countPer(D.tp.start, n);

    // stats
    if (D.stats && D.stats.n) {
      const sp = D.stats.p;
      for (let k = 0; k < sp.length; k++) {
        const i = sp[k];
        P.games[i] = D.stats.g[k];
        P.wins[i] = D.stats.w[k];
        P.first[i] = D.stats.first[k];
        P.last[i] = D.stats.last[k];
      }
    }

    // 招牌英雄：人数数组 → 前缀和，槽位表直接用
    if (D.fav && D.fav.n) {
      const c = D.fav.c;
      const from = new Int32Array(n + 1);
      let acc = 0;
      for (let i = 0; i < n; i++) { from[i] = acc; acc += c[i] || 0; }
      from[n] = acc;
      P.favFrom = from;
      P.favSlots = D.fav.s;
    }

    // aliases
    const al = D.aliases;
    const af = P.aliasFrom;
    let j = 0;
    for (let i = 0; i <= n; i++) {
      while (j < al.p.length && al.p[j] < i) j++;
      af[i] = j;
    }
    for (let i = n - 1; i >= 0; i--) if (af[i] > af[i + 1]) af[i] = af[i + 1];
    P.aliasNames = al.names;

    // search text
    for (let i = 0; i < n; i++) {
      let s = P.id[i] + ' ' + P.page[i] + ' ' + P.name[i] + ' ' + P.native[i] + ' ' + P.zh[i];
      for (let k = af[i]; k < af[i + 1]; k++) s += ' ' + al.names[k];
      P.search[i] = s.toLowerCase();
    }
  }
  function countPer(start, n) {
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.min(32767, start[i + 1] - start[i]);
    return out;
  }

  /* ── filter + sort ──────────────────────────────────── */
  function teamPlayers(teamIdx) {
    const set = new Set();
    const t = D.tenures.t;
    for (let i = 0; i < t.length; i++) if (t[i] === teamIdx) set.add(D.tenures.abs[i]);
    return set;
  }
  function tournPlayers(tIdx) {
    const set = new Set();
    const t = D.tp.t;
    for (let i = 0; i < t.length; i++) if (t[i] === tIdx) set.add(D.tp.abs[i]);
    return set;
  }

  function matches(i, tokens, restrict) {
    if (restrict && !restrict.has(i)) return false;
    if (state.role && P.role[i] !== state.role) return false;
    if (state.region && P.region[i] !== state.region) return false;
    if (state.country && P.country[i] !== state.country) return false;
    const bit = P.bit[i];
    if (state.status === 'active' && (bit & 1 || !P.team[i])) return false;
    if (state.status === 'retired' && !(bit & 1)) return false;
    if (state.status === 'other' && !((bit & 2) || (bit & 4) || (bit & 8) || (bit & 16))) return false;
    if (!tokens.length) return true;
    const text = P.search[i];
    for (let t = 0; t < tokens.length; t++) if (!text.includes(tokens[t])) return false;
    return true;
  }

  function computeView() {
    const tokens = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    let restrict = null;
    if (state.team) restrict = teamPlayers(Number(state.team));
    if (state.tourn) {
      const s2 = tournPlayers(Number(state.tourn));
      restrict = restrict ? new Set([...restrict].filter((v) => s2.has(v))) : s2;
    }
    const out = [];
    const n = D.counts.players;
    for (let i = 0; i < n; i++) if (matches(i, tokens, restrict)) out.push(i);

    const sort = state.sort;
    if (sort === 'games') out.sort((a, b) => P.games[b] - P.games[a] || P.id[a].localeCompare(P.id[b]));
    else if (sort === 'recent') out.sort((a, b) => P.last[b] - P.last[a] || P.id[a].localeCompare(P.id[b]));
    else if (sort === 'debut') out.sort((a, b) => (P.first[a] || 9e9) - (P.first[b] || 9e9));
    else out.sort((a, b) => P.id[a].localeCompare(P.id[b], 'en', { sensitivity: 'base' }));
    return out;
  }

  /* ── list rendering (virtual) ───────────────────────── */
  const ROW_H = 58;
  let scrollFrame = 0;

  function renderList() {
    state.view = computeView();
    const total = state.view.length;
    listInner.style.height = total * ROW_H + 'px';    $('#resultCount').textContent = total.toLocaleString('en-US') + ' 名选手';
    $('#activeCount').textContent = total === D.counts.players ? '' :
      (total / D.counts.players * 100).toFixed(1) + '%';
    list.scrollTop = 0;
    paintList();
    requestAnimationFrame(paintList);
    if (!total) {
      listInner.replaceChildren();
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '没有匹配的选手';
      listInner.style.height = 'auto';
      listInner.appendChild(empty);
      state.sel = -1;
    } else {
      if (state.sel < 0 || state.view.indexOf(state.sel) < 0) select(state.view[0], false);
    }
    renderCrossbar();
  }

  function paintList() {
    const total = state.view.length;
    const top = list.scrollTop;
    const h = list.clientHeight || 600;
    const from = Math.max(0, Math.floor(top / ROW_H) - 3);
    const to = Math.min(total, Math.ceil((top + h) / ROW_H) + 3);
    const frag = document.createDocumentFragment();
    for (let k = from; k < to; k++) {
      const i = state.view[k];
      const bit = P.bit[i];
      const retired = (bit & 1) === 1;
      const team = P.team[i];
      const node = document.createElement('button');
      node.type = 'button';
      node.className = 'row';
      node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', String(i === state.sel));
      node.dataset.i = String(i);
      node.tabIndex = i === state.sel ? 0 : -1;
      node.style.transform = 'translateY(' + k * ROW_H + 'px)';

      const name = document.createElement('span');
      name.className = 'r-name';
      name.textContent = P.id[i];
      node.appendChild(name);

      const sub = document.createElement('span');
      sub.className = 'r-sub';
      const flag = document.createElement('span');
      flag.className = 'flag' + (retired || !team ? ' off' : '');
      flag.setAttribute('aria-hidden', 'true');
      sub.appendChild(flag);
      const bits = [P.zh[i], P.country[i], P.role[i]].filter(Boolean);
      const teamSlot = teamLogo(D.columns.Team[i]);
      bits.forEach((v, idx) => {
        if (idx) {
          const dot = document.createElement('span');
          dot.className = 'dot';
          dot.textContent = '·';
          sub.appendChild(dot);
        }
        const it = document.createElement('i');
        it.textContent = v;
        sub.appendChild(it);
      });
      if (team) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = '·';
        sub.appendChild(dot);
        if (teamSlot >= 0 && D.icons && D.icons.team) {
          const logo = document.createElement('span');
          logo.className = 'tlogo row-logo';
          sub.appendChild(logo);
          iconAt(logo, 'team', teamSlot);
        }
        const it = document.createElement('i');
        it.textContent = team;
        sub.appendChild(it);
      }
      node.appendChild(sub);

      const right = document.createElement('span');
      right.className = 'r-right';
      const games = document.createElement('b');
      games.textContent = P.games[i] ? P.games[i].toLocaleString('en-US') : '—';
      const year = document.createElement('span');
      year.textContent = P.last[i] ? String(yearOf(P.last[i])) : '';
      right.append(games, year);
      node.appendChild(right);

      frag.appendChild(node);
    }
    listInner.replaceChildren(frag);
  }

  list.addEventListener('scroll', () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; paintList(); });
  });

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) select(Number(row.dataset.i), true);
  });

  list.addEventListener('keydown', (e) => {
    if (!state.view.length) return;
    const pos = state.view.indexOf(state.sel);
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      select(state.view[Math.min(state.view.length - 1, pos + 1)], true);
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      select(state.view[Math.max(0, pos - 1)], true);
    } else if (e.key === 'Home') {
      e.preventDefault(); select(state.view[0], true);
    } else if (e.key === 'End') {
      e.preventDefault(); select(state.view[state.view.length - 1], true);
    }
  });

  function scrollToSel() {
    const pos = state.view.indexOf(state.sel);
    if (pos < 0) return;
    const top = pos * ROW_H;
    const h = list.clientHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (top + ROW_H > list.scrollTop + h) list.scrollTop = top + ROW_H - h;
  }

  /* ── crossbar ───────────────────────────────────────── */
  function renderCrossbar() {
    const bar = $('#crossbar');
    const chips = [];
    if (state.team) chips.push(['team', '战队', teamName(Number(state.team))]);
    if (state.tourn) chips.push(['tourn', '赛事', TOURNS[Number(state.tourn)] || '']);
    if (state.role) chips.push(['role', '位置', state.role]);
    if (state.region) chips.push(['region', '赛区', state.region]);
    if (state.country) chips.push(['country', '国家', state.country]);
    bar.hidden = chips.length === 0;
    bar.innerHTML = chips.map(([k, label, value]) =>
      '<button class="chip" data-clear="' + k + '"><b>' + esc(label) + '</b><span>' + esc(value) +
      '</span><b>×</b></button>').join('');
    if (chips.length) {
      $('#fRole').value = state.role;
      $('#fRegion').value = state.region;
      $('#fCountry').value = state.country;
    }
  }

  $('#crossbar').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-clear]');
    if (!chip) return;
    const key = chip.dataset.clear;
    state[key] = '';
    if (key === 'role') $('#fRole').value = '';
    if (key === 'region') $('#fRegion').value = '';
    if (key === 'country') $('#fCountry').value = '';
    renderList();
  });

  /* ── filters ────────────────────────────────────────── */
  function fillSelect(id, values) {
    const sel = $(id);
    const frag = document.createDocumentFragment();
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      frag.appendChild(o);
    }
    sel.appendChild(frag);
  }

  function setupFilters() {
    const countBy = (getter) => {
      const map = new Map();
      const n = D.counts.players;
      for (let i = 0; i < n; i++) { const v = getter(i); if (v) map.set(v, (map.get(v) || 0) + 1); }
      return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    };
    fillSelect('#fRole', countBy((i) => P.role[i]).map((e) => e[0]));
    fillSelect('#fRegion', countBy((i) => P.region[i]).map((e) => e[0]));
    fillSelect('#fCountry', countBy((i) => P.country[i]).map((e) => e[0]));

    $('#fRole').addEventListener('change', (e) => { state.role = e.target.value; renderList(); });
    $('#fRegion').addEventListener('change', (e) => { state.region = e.target.value; renderList(); });
    $('#fCountry').addEventListener('change', (e) => { state.country = e.target.value; renderList(); });
    $('#fStatus').addEventListener('change', (e) => { state.status = e.target.value; renderList(); });
    $('#fSort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });

    let timer = 0;
    qInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = qInput.value.trim(); renderList(); }, 90);
    });

    document.addEventListener('keydown', (e) => {
      const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
      if (e.key === '/' && !typing) { e.preventDefault(); qInput.focus(); qInput.select(); }
      else if (e.key === 'Escape' && document.activeElement === qInput) {
        qInput.value = ''; state.q = ''; renderList(); qInput.blur();
      }
    });
  }

  /* ── dossier ────────────────────────────────────────── */
  function statRow(i) {
    if (!D.stats || !D.stats.n) return null;
    const p = D.stats.p;
    let lo = 0, hi = p.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (p[mid] === i) {
        const k = mid;
        const o = (key) => D.stats[key][k];
        return { g: o('g'), w: o('w'), k: o('k'), d: o('d'), a: o('a'), pk: o('pk'), gold: o('gold'),
          cs10: o('cs'), vs10: o('vs'), dmg: o('dmg'), first: o('first'), last: o('last') };
      }
      if (p[mid] < i) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  }

  /* 赛事期间的战队：包内只在「与履历推导不一致」时才存，否则按履历回填 */
  function teamAt(tenures, date) {
    let hit = 0;
    for (const t of tenures) {
      if (!t.join) continue;
      if (t.join <= date && (!t.leave || t.leave >= date)) hit = t.team;
    }
    return hit;
  }

  function sectionsFor(i) {
    const out = { tenures: [], events: [], contracts: [], champs: [], aliases: [], favs: [] };
    const T = D.tenures;
    for (let k = T.start[i]; k < T.start[i + 1]; k++) {
      out.tenures.push({
        team: T.t[k], join: T.j[k], leave: T.l[k], cur: T.cur[k], nx: T.nx[k], ce: T.ce[k],
      });
    }
    if (!out.tenures.length) {
      const tNow = D.columns.Team[i];
      if (tNow) out.tenures.push({ team: tNow, join: 0, leave: 0, cur: 1, nx: 0, ce: 0 });
    }
    // 战队履历按入队日期升序，下一站就是下一段的战队
    out.tenures.forEach((t, k) => {
      const next = out.tenures[k + 1];
      t.next = next && !t.cur ? next.team : 0;
    });
    if (D.tp && D.tp.n) {
      const TP = D.tp;
      for (let k = TP.start[i]; k < TP.start[i + 1]; k++) {
        const date = D.tourn.date[TP.t[k]] || 0;
        out.events.push({
          t: TP.t[k],
          team: TP.team[k] || teamAt(out.tenures, date),
          date,
        });
      }
      out.events.sort((a, b) => b.date - a.date);
    }
    const C = D.contracts;
    for (let k = C.start[i]; k < C.start[i + 1]; k++) {
      out.contracts.push({ team: C.t[k], end: C.e[k], rm: C.rm[k] });
    }
    out.contracts.sort((a, b) => b.end - a.end);
    if (D.champs && D.champs.n) {
      const CH = D.champs;
      for (let k = 0; k < CH.p.length; k++) {
        if (CH.p[k] === i) out.champs.push({ c: sv(CH.c[k]), g: CH.g[k], w: CH.w[k] });
      }
    }
    const al = D.aliases;
    for (let k = P.aliasFrom[i]; k < P.aliasFrom[i + 1]; k++) out.aliases.push(al.names[k]);
    if (P.favFrom) {
      for (let k = P.favFrom[i]; k < P.favFrom[i + 1]; k++) out.favs.push(P.favSlots[k] - 1);
    }
    return out;
  }

  function band(i, st, sec) {
    const cells = [];
    if (st && st.g) {
      cells.push(['出场', st.g.toLocaleString('en-US')]);
      cells.push(['胜率', pct(st.w, st.g) + '<small>%</small>', pct(st.w, st.g) >= 50 ? 'good' : 'bad']);
      const kda = st.d ? (st.k + st.a) / st.d : st.k + st.a;
      cells.push(['KDA', kda.toFixed(2)]);
      cells.push(['场均击杀', (st.k / st.g).toFixed(1)]);
      cells.push(['场均死亡', (st.d / st.g).toFixed(1)]);
      cells.push(['场均助攻', (st.a / st.g).toFixed(1)]);
      cells.push(['五杀', String(st.pk)]);
      cells.push(['场均经济', fmt(st.gold)]);
      cells.push(['场均补刀', (st.cs10 / 10).toFixed(1)]);
      cells.push(['场均视野', st.vs10 ? (st.vs10 / 10).toFixed(1) : '—']);
    } else {
      cells.push(['战队', String(sec.tenures.length)]);
      cells.push(['赛事', String(sec.events.length)]);
    }
    return '<div class="band">' + cells.map((c) =>
      '<div class="band-cell ' + (c[2] || '') + '"><span class="band-val">' + c[1] +
      '</span><span class="band-key">' + esc(c[0]) + '</span></div>').join('') + '</div>';
  }

  function sectionHead(title, count, extra) {
    return '<div class="section-head"><h3>' + esc(title) + '</h3>' +
      (count === null ? '' : '<span class="count">' + count + '</span>') +
      '<span class="spacer"></span>' + (extra || '') + '</div>';
  }

  function renderTenures(sec, key) {
    if (!sec.tenures.length) return '';
    const limit = state.limit[key] || 8;
    const rows = sec.tenures.slice().reverse().slice(0, limit);
    let html = '<div class="section">' + sectionHead('战队履历', sec.tenures.length);
    html += '<div class="tl">' + rows.map((t) => {
      const dates = t.join ? dateStr(t.join, '.') : '—';
      const leave = t.cur ? '今' : (t.leave ? dateStr(t.leave, '.') : '—');
      const dur = !t.join ? '' : (t.cur ? '' : t.leave ? months(t.join, t.leave) : '');
      // 续约会让同一支队伍连着出现几段，这一段的下一站又是同一支队伍时不必再写一次
      const next = t.next && teamName(t.next) !== teamName(t.team) ? '→ ' + teamName(t.next) : '';
      return '<div class="tl-row">' +
        '<span class="tl-date">' + dates + ' <em>—</em> <span class="' + (t.cur ? 'now' : '') + '">' + leave + '</span></span>' +
        '<span class="tl-team">' + logoTip(t.team) +
        '<button data-team="' + t.team + '">' + esc(teamName(t.team)) + '</button>' +
        (t.cur ? '<span class="role now">现役</span>' : '') +
        (next ? '<span class="next">' + esc(next) + '</span>' : '') + '</span>' +
        '<span class="tl-dur">' + dur + '</span>' +
        '</div>';
    }).join('') + '</div>';
    if (sec.tenures.length > limit) {
      html += '<button class="more" data-more="' + key + '">展开其余 ' + (sec.tenures.length - limit) + ' 段 →</button>';
    }
    return html + '</div>';
  }

  function months(a, b) {
    const x = dateObj(a), y = dateObj(b);
    if (!x || !y) return '';
    const m = Math.max(1, Math.round((y - x) / (30.44 * DAY)));
    return m >= 12 ? Math.floor(m / 12) + ' 年' + (m % 12 ? ' ' + (m % 12) + ' 月' : '') : m + ' 个月';
  }

  function renderEvents(sec, key) {
    if (!sec.events.length) return '';
    const limit = state.limit[key] || 14;
    const rows = sec.events.slice(0, limit);
    let html = '<div class="section">' + sectionHead('赛事履历', sec.events.length);
    let year = '';
    for (const ev of rows) {
      const y = yearOf(ev.date) || '';
      if (y !== year) { html += '<div class="ev-year">' + y + '</div>'; year = y; }
      const meta = [sv(D.tourn.league[ev.t]), sv(D.tourn.region[ev.t])].filter(Boolean);
      html += '<div class="ev-row">' +
        logoTip(ev.team) +
        '<button class="ev-name" data-tourn="' + ev.t + '">' + esc(D.tourn.name[ev.t] || TOURNS[ev.t]) +
        (ev.team ? ' <span>· ' + esc(teamName(ev.team)) + '</span>' : '') + '</button>' +
        '<span class="ev-meta">' + meta.map((m) => '<span>' + esc(m) + '</span>').join('') + '</span>' +
        '<span class="ev-right">' + (ev.date ? dateStr(ev.date, '.') : '') + '</span>' +
        '</div>';
    }
    if (sec.events.length > limit) {
      html += '<button class="more" data-more="' + key + '">展开其余 ' + (sec.events.length - limit) + ' 项 →</button>';
    }
    return html + '</div>';
  }

  function renderPool(sec) {
    if (!sec.champs.length) return '';
    const max = Math.max(...sec.champs.map((c) => c.g));
    return '<div class="section">' + sectionHead('英雄池', sec.champs.length) +
      '<div class="pool">' + sec.champs.map((c) =>
        '<div class="pool-row"><span class="pool-name">' + esc(c.c) + '</span>' +
        '<span class="pool-bar"><i data-w="' + Math.max(6, Math.round(c.g / max * 100)) + '"></i></span>' +
        '<span class="pool-games">' + c.g + ' · ' + pct(c.w, c.g) + '%</span></div>').join('') + '</div></div>';
  }

  function renderFavs(sec) {
    if (!sec.favs.length) return '';
    return '<div class="section">' + sectionHead('招牌英雄', sec.favs.length) +
      '<div class="favs">' + sec.favs.map((slot) => champChip(slot)).join('') + '</div></div>';
  }

  function renderContracts(sec) {
    if (!sec.contracts.length) return '';
    return '<div class="section">' + sectionHead('合同', sec.contracts.length) +
      '<div class="tl">' + sec.contracts.map((c) =>
        '<div class="tl-row"><span class="tl-date">' + (c.end ? dateStr(c.end, '.') : '未知') + '</span>' +
        '<span class="tl-team">' + logoTip(c.team) +
        '<button data-team="' + c.team + '">' + esc(teamName(c.team)) + '</button>' +
        (c.rm ? '<span class="next">已离队</span>' : '') + '</span><span class="tl-dur"></span></div>').join('') +
      '</div></div>';
  }

  function factValue(i, field, kind) {
    const v = D.columns[field] ? D.columns[field][i] : '';
    if (kind === 'date') return dateStr(v, '-');
    if (kind === 'num') return v ? String(v) : '';
    if (kind === 'dict') return sv(v);
    if (kind === 'team') return teamName(v);
    if (kind === 'list') return String(v || '').split(/[,;、]/).map((s) => s.trim()).filter(Boolean).join(' · ');
    return String(v || '');
  }

  function renderFacts(i) {
    const rows = [];
    for (const [field, label, kind] of FACTS) {
      const value = factValue(i, field, kind);
      if (!value) continue;
      rows.push('<div class="fact"><dt>' + esc(label) + '</dt><dd>' + esc(value) + '</dd></div>');
    }
    const bit = P.bit[i];
    const on = FLAG_NAMES.filter((_, idx) => (bit & (1 << idx)) !== 0);
    if (on.length) {
      rows.push('<div class="fact"><dt>标记</dt><dd>' + esc(on.join(' · ')) + '</dd></div>');
    }
    if (P.page[i] && P.page[i] !== P.id[i]) {
      rows.push('<div class="fact"><dt>资料页</dt><dd>' + esc(P.page[i]) + '</dd></div>');
    }
    rows.push('<div class="fact"><dt>编号</dt><dd class="mono">' + String(i + 1).padStart(5, '0') + '</dd></div>');
    return '<div class="section">' + sectionHead('档案', null) + '<div class="facts">' + rows.join('') + '</div></div>';
  }

  function renderLinks(i) {
    const items = [];
    for (const [field, label, base] of SOCIALS) {
      const raw = D.columns[field] ? D.columns[field][i] : '';
      if (!raw) continue;
      items.push([label, /^https?:/i.test(raw) ? raw : 'https://' + (raw.includes('.') ? raw : base + raw)]);
    }
    for (const [field, label] of PROFILE_LINKS) {
      const raw = D.columns[field] ? D.columns[field][i] : '';
      if (!raw) continue;
      items.push([label, /^https?:/i.test(raw) ? raw : 'https://' + raw]);
    }
    if (!items.length) return '';
    return '<div class="section">' + sectionHead('链接', items.length) + '<div class="links">' + items.map(([label, url]) =>
      '<a class="link-pill" href="' + esc(url) + '" data-open="' + esc(url) + '">' + esc(label) +
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2h6v6M10 2 4.5 7.5M3 4v5h5"/></svg></a>').join('') + '</div></div>';
  }

  const ICON_BACK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 3.5 5 8l4.5 4.5"/></svg>';
  const ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5V3.2A1.2 1.2 0 0 0 9.3 2H3.2A1.2 1.2 0 0 0 2 3.2v6.1a1.2 1.2 0 0 0 1.2 1.2h2.3"/></svg>';
  const ICON_OUT = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 6.5 9.5M4 5v8h8"/></svg>';

  function renderDossier(i) {
    const sec = sectionsFor(i);
    const st = statRow(i);
    const bit = P.bit[i];
    const retired = (bit & 1) === 1;
    const eyebrow = [...new Set([P.country[i], P.region[i], P.role[i]].filter(Boolean))];
    const page = P.page[i] || P.id[i];
    const url = 'https://lol.fandom.com/wiki/' + encodeURIComponent(page.replace(/ /g, '_'));

    let html = '<div class="backbar"><button class="btn" data-back="1">' + ICON_BACK + '索引</button></div>';
    html += '<div class="dhead">' +
      '<div class="dhead-eyebrow">' +
      eyebrow.map((v) => '<span>' + esc(v) + '</span>').join('<span>·</span>') +
      (retired ? '<span class="tagon on">已退役</span>' : P.team[i] ? '<span class="tagon on">现役</span>' : '') +
      '</div>' +
      '<h2>' + esc(P.id[i]) + '</h2>' +
      (P.zh[i] && P.zh[i] !== P.id[i] ? '<p class="dhead-zh">' + esc(P.zh[i]) + '</p>' : '') +
      '<div class="dhead-name">' +
      (P.name[i] ? '<span>' + esc(P.name[i]) + '</span>' : '') +
      (P.native[i] && P.native[i] !== P.zh[i] ? '<span class="native">' + esc(P.native[i]) + '</span>' : '') +
      (P.team[i] ? '<span class="native">' + logoTip(D.columns.Team[i]) + esc(P.team[i]) + '</span>' : '') +
      '</div>' +
      '<div class="dhead-actions">' +
      '<button class="btn" data-copy="1" aria-label="复制选手档案">' + ICON_COPY + '复制</button>' +
      '<a class="btn" href="' + esc(url) + '" data-open="' + esc(url) + '" aria-label="在 Leaguepedia 打开">Leaguepedia' + ICON_OUT + '</a>' +
      '</div></div>';

    html += band(i, st, sec);
    html += renderFavs(sec);
    html += renderTenures(sec, i + 't');
    html += renderEvents(sec, i + 'e');
    html += renderPool(sec);
    html += renderContracts(sec);
    html += renderFacts(i);
    if (sec.aliases.length) {
      html += '<div class="section">' + sectionHead('曾用名', sec.aliases.length) +
        '<div class="tagnames">' + sec.aliases.map((n) =>
          '<span>' + esc(n) + '</span>').join('') + '</div></div>';
    }
    html += renderLinks(i);

    dossier.innerHTML = html;
    paintIcons(dossier);
    // 宿主 CSP 会丢弃内联 style 属性，宽度只能通过 CSSOM 设置
    for (const bar of dossier.querySelectorAll('.pool-bar > i[data-w]')) {
      bar.style.width = bar.dataset.w + '%';
    }
    dossier.scrollTop = 0;
    dossier.classList.add('entered');
    dossier.dataset.sel = i;
  }

  /* ── selection ──────────────────────────────────────── */
  function select(i, focus) {
    if (i < 0 || i >= D.counts.players) return;
    state.sel = i;
    document.body.dataset.view = 'detail';
    renderDossier(i);
    for (const row of listInner.children) {
      const on = Number(row.dataset.i) === i;
      row.setAttribute('aria-selected', String(on));
      row.tabIndex = on ? 0 : -1;
    }
    if (focus) scrollToSel();
    saveState();
  }

  dossier.addEventListener('click', (e) => {
    const team = e.target.closest('[data-team]');
    if (team) {
      state.team = team.dataset.team;
      state.tourn = '';
      renderList();
      document.body.dataset.view = 'list';
      return;
    }
    const tourn = e.target.closest('[data-tourn]');
    if (tourn) {
      state.tourn = tourn.dataset.tourn;
      state.team = '';
      renderList();
      document.body.dataset.view = 'list';
      return;
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      state.limit[more.dataset.more] = 1e6;
      renderDossier(state.sel);
      return;
    }
    if (e.target.closest('[data-back]')) {
      document.body.dataset.view = 'list';
      return;
    }
    const copy = e.target.closest('[data-copy]');
    if (copy) { copyDossier(state.sel); return; }
    const open = e.target.closest('[data-open]');
    if (open) {
      const url = open.dataset.open;
      if (supports('external.open')) {
        e.preventDefault();
        host.request('external.open', { url }).catch(() => toast('无法打开链接'));
      }
    }
  });

  function dossierText(i) {
    const parts = [P.id[i]];
    if (P.zh[i] && P.zh[i] !== P.id[i]) parts.push(P.zh[i]);
    if (P.name[i]) parts.push(P.name[i]);
    if (P.native[i] && P.native[i] !== P.zh[i]) parts.push(P.native[i]);
    const line = [P.country[i], P.region[i], P.role[i], P.team[i]].filter(Boolean).join(' · ');
    if (line) parts.push(line);
    if (P.games[i]) parts.push('出场 ' + P.games[i] + ' 场，胜率 ' + pct(P.wins[i], P.games[i]) + '%');
    parts.push('https://lol.fandom.com/wiki/' + encodeURIComponent((P.page[i] || P.id[i]).replace(/ /g, '_')));
    return parts.join('\n');
  }

  function copyDossier(i) {
    const text = dossierText(i);
    if (supports('clipboard.write')) {
      host.request('clipboard.write', { text }).then(() => toast('已复制')).catch(() => toast('复制失败'));
    } else if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => toast('复制失败'));
    } else toast('当前环境不支持复制');
  }

  let toastTimer = 0;
  function toast(text) {
    const node = $('#statusline');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 1800);
  }

  /* ── persistence ────────────────────────────────────── */
  function saveState() {
    if (!supports('storage.set')) return;
    host.request('storage.set', {
      key: 'view',
      value: { sel: state.sel, sort: state.sort, role: state.role, region: state.region, country: state.country, status: state.status },
    }).catch(() => {});
  }
  async function restoreState() {
    if (!supports('storage.get')) return null;
    try { return await host.request('storage.get', { key: 'view' }); } catch { return null; }
  }

  /* ── start ──────────────────────────────────────────── */
  async function start() {
    if (!window.__DEX__) { stage('数据未打包', 100); return; }
    stage('解压档案', 12);
    await new Promise((r) => setTimeout(r, 0)); // 后台标签页里 rAF 不会触发
    const bytes = b64bytes(window.__DEX__);
    stage('解压档案', 38);
    const text = await gunzip(bytes);
    stage('解析档案', 62);
    await new Promise((r) => setTimeout(r, 0));
    D = JSON.parse(text);
    window.__DEX__ = null;
    expandColumns(D);
    stage('建立索引', 84);
    await new Promise((r) => setTimeout(r, 0));
    build();
    stage('就绪', 100);

    $('#snapCount').textContent = D.counts.players.toLocaleString('en-US') + ' 名选手';
    $('#snapDate').textContent = D.generatedAt.replace(/-/g, '.');

    setupFilters();
    const saved = await restoreState();
    if (saved && typeof saved === 'object') {
      if (saved.sort) { state.sort = saved.sort; $('#fSort').value = saved.sort; }
      if (saved.role) { state.role = saved.role; $('#fRole').value = saved.role; }
      if (saved.region) { state.region = saved.region; $('#fRegion').value = saved.region; }
      if (saved.country) { state.country = saved.country; $('#fCountry').value = saved.country; }
      if (saved.status) { state.status = saved.status; $('#fStatus').value = saved.status; }
    }
    renderList();
    if (saved && Number.isInteger(saved.sel) && saved.sel >= 0 && saved.sel < D.counts.players) {
      select(saved.sel, false);
      scrollToSel();
      paintList();
    } else if (state.view.length) {
      select(state.view[0], false);
    } else {
      dossier.innerHTML = '<div class="dossier-empty"><p>索引</p></div>';
    }
    document.body.dataset.view = window.innerWidth <= 860 ? 'list' : 'detail';
    boot.classList.add('done');
    setTimeout(() => { boot.hidden = true; }, 320);
  }

  window.addEventListener('resize', () => {
    if (D) paintList();
  });

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { if (D) paintList(); }).observe(list);
  }

  if (host) {
    host.ready.then(() => { document.body.dataset.view = window.innerWidth <= 860 ? 'list' : 'detail'; }).catch(() => {});
  }

  start().catch((err) => {
    bootLine.textContent = '加载失败：' + (err && err.message ? err.message : err);
    bootBar.style.width = '100%';
    bootBar.style.background = 'var(--loss)';
    console.error(err);
  });
})();
