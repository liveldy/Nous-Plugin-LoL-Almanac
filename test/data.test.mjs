// 数据与页面规则的自测：node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dexPath = path.join(root, 'ui/data/dex.js');
const appPath = path.join(root, 'ui/app.js');

const source = fs.readFileSync(dexPath, 'utf8');
const b64 = /window\.__DEX__="([^"]+)";/.exec(source)?.[1];
const data = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'));

test('快照包含全部选手与全部 Players 字段', () => {
  assert.ok(data.counts.players > 20000, '选手数应超过两万');
  assert.equal(data.columns.ID.length, data.counts.players);
  assert.ok(data.columns.Birthdate && data.columns.Nationality && data.columns.Twitter, '字段列缺失');
  assert.ok(data.S.length > 1000, '字符串字典应已建立');
  assert.equal(data.S[0], '', '字典第 0 项必须是空串');
});

test('籍贯、位置与战队索引都能解析', () => {
  const { columns, S, teams } = data;
  const n = data.counts.players;
  let withCountry = 0;
  let withRole = 0;
  for (let i = 0; i < n; i++) {
    if (columns.Country[i]) { assert.ok(S[columns.Country[i]]); withCountry++; }
    if (columns.Role[i]) { assert.ok(S[columns.Role[i]]); withRole++; }
  }
  assert.ok(withCountry > 19000, '绝大多数选手应有国家');
  assert.ok(withRole > 19000, '绝大多数选手应有位置');
  assert.ok(teams.length > 7000, '战队表应包含数支队伍');
});

test('履历表按选手排序，选手列差分后仍可还原', () => {
  const t = data.tenures;
  assert.ok(t.n > 100000, '履历行数应超过十万');
  let acc = 0;
  let prev = -1;
  for (let i = 0; i < t.pd.length; i++) {
    acc += t.pd[i];
    assert.ok(acc >= 0 && acc < data.counts.players, '选手下标越界');
    assert.ok(acc >= prev, '履历必须按选手升序');
    prev = acc;
  }
  assert.ok(t.n > 0 && t.j.length === t.n && t.l.length === t.n);
});

test('赛事出场与赛事表一致', () => {
  const tp = data.tp;
  if (!tp || !tp.n) {
    assert.ok(true, '本构建未包含赛事出场');
    return;
  }
  let acc = 0;
  for (let i = 0; i < tp.pd.length; i++) {
    acc += tp.pd[i];
    assert.ok(acc < data.counts.players);
    assert.ok(tp.t[i] > 0 && tp.t[i] < data.tournNames.length, '赛事下标越界');
    assert.ok(data.tourn.name[tp.t[i]], '赛事缺少名称');
  }
});

test('曾用名指向真实选手', () => {
  const al = data.aliases;
  assert.ok(al.n > 0);
  assert.equal(al.p.length, al.names.length);
  for (const p of al.p) assert.ok(p >= 0 && p < data.counts.players);
});

test('日期编码可还原成合法年份', () => {
  const base = Date.UTC(data.base, 0, 1);
  const sample = data.columns.Birthdate.filter((v) => v > 0).slice(0, 200);
  assert.ok(sample.length > 100);
  for (const v of sample) {
    const year = new Date(base + (v - 1) * 86400000).getUTCFullYear();
    assert.ok(year >= 1960 && year <= 2026, '出生年份不合理: ' + year);
  }
});

test('宿主 CSP 禁止内联 style 属性，页面不得生成它们', () => {
  const app = fs.readFileSync(appPath, 'utf8');
  assert.ok(!/style="/.test(app), 'ui/app.js 生成了内联 style 属性，会在宿主 CSP 下被丢弃');
  const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
  assert.ok(!/style="/.test(html), 'ui/index.html 含内联 style 属性');
});

test('选手有中文名，界面上的国家与位置已本地化', () => {
  assert.ok(data.counts.zhNames > 2000, '应有两千余名选手带中文名');
  const ids = data.columns.ID;
  const zhOf = (id) => data.S[data.columns.NameZh[ids.indexOf(id)]];
  assert.equal(zhOf('Uzi'), '简自豪', '汉字本名应直接成为中文名');
  assert.equal(zhOf('Faker'), '李相赫', '维基核对过的译名应写进数据');
  for (const v of data.columns.NameZh) {
    if (v) assert.match(data.S[v], /[\u4e00-\u9fa5]/, '中文名必须是汉字: ' + data.S[v]);
  }
  for (const field of ['Country', 'Role', 'NameAlphabet']) {
    for (const v of data.columns[field]) {
      if (v) assert.doesNotMatch(data.S[v], /[A-Za-z]/, field + ' 还没本地化: ' + data.S[v]);
    }
  }
});

test('插件包体积在 4 MiB 之内', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  let bytes = 0;
  for (const name of manifest.resources) bytes += fs.statSync(path.join(root, name)).size;
  assert.ok(bytes <= 4 * 1024 * 1024, '资源合计 ' + bytes + ' 字节，超过 4 MiB');
  assert.ok(manifest.resources.length <= 256);
});
