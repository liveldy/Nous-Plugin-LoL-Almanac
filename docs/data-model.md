# 数据结构

`ui/data/dex.js` 是唯一的数据文件：

```js
window.__DEX__ = "<base64(gzip(dataset))>";
```

页面用 `DecompressionStream('gzip')` 解压后 `JSON.parse`，因此插件包内不需要任何第三方解压库。
数据集由 `tools/build-data.mjs` 生成、`tools/pack-data.mjs` 打包，两者都可重复运行。

## 为什么是列式 + 字典

4 MiB 的插件包上限是这份数据的硬约束。原始 Cargo 表合计约 160 MB（`Tenures` 57 MB、
`TournamentPlayers` 67 MB、`Players` 26 MB、`Tournaments` 10 MB），所以构建时做了四件事：

1. **共享字符串字典** `S`：国家、赛区、位置、联赛等重复值只存一次，列里放整数下标（0 = 空）。
2. **日期按天编码**：`YYYY-MM-DD` 变成「1980-01-01 起的天数 + 1」，4 位数字代替 10 个字符。
3. **按选手排序 + 差分**：每位选手的履历行连续排列，选手列存差值（大量 0），gzip 后几乎不占空间。
4. **布尔字段并成位掩码**：`IsRetired`、`ToWildrift` 等 10 个布尔字段合成一个列 `fl`。
5. **数字列存定宽二进制**：所有整数列在 JSON 里是 `{ w: 'u8'|'u16'|'u32', d: base64 }`，
   页面在 `JSON.parse` 之后就地还原成 `Uint8Array` / `Uint16Array` / `Uint32Array`
   （`ui/app.js` 的 `expandColumns()`），测试里用同样的 `expand()`。十进制文本两百万个整数约 9 MB，
   u16 二进制只要 4 MB。

## 顶层字段

| 键 | 说明 |
| --- | --- |
| `generatedAt` | 快照日期（ISO） |
| `source` / `zhNamesSource` / `iconsSource` | 数据来源说明（Cargo / 中文维基 / Data Dragon + 维基文件） |
| `counts` | 各表行数，界面与测试都用它（`zhNames` 带中文名的选手数、`favouriteChampions` 招牌英雄条目、`teamLogos` 有队标的队伍数） |
| `base` | 日期编码起点年份（1980） |
| `flags` | `fl` 位掩码的字段顺序 |
| `S` | 字符串字典，`S[0] === ''` |
| `teams` | 战队名字典，`teams[0] === ''` |
| `fields` | 选手列的编码类型表：`raw` / `dict` / `team` / `date` / `num` |
| `columns` | 选手列，每个字段一个数组，长度等于选手数 |
| `tenures` | 战队履历 |
| `contracts` | 合同 |
| `tourn` | 赛事元数据（`name` 是已中文化的赛事名，字符串数组；其余列是数字） |
| `tp` | 赛事出场 |
| `stats` | 生涯合计（`ScoreboardPlayers` 聚合） |
| `champs` | 英雄池；当前构建为 `null`（体积不够，见 README） |
| `fav` | 招牌英雄：`{ c, s, n }` —— `c` 是每人的数量，`s` 是连续的英雄槽位（1 起，0 = 空） |
| `aliases` | 曾用名 → 选手下标 |
| `honors` | 荣誉：`title`（赛事名次）、`award`（赛季奖项）、`awardNames`（奖项中文名表） |
| `portraits` | 肖像：`slot`（每人一个槽位，与选手等长）、`cols` / `size` / `count` |
| `icons` | 三张精灵图的网格参数：`champ` / `team` / `player` 各为 `{ cols, size, count }` |
| `logo` | 队标槽位表，与 `teams` 等长（0 = 该队无图标，否则为槽位 + 1） |
| `champZh` / `champEn` / `champTitle` | 按槽位排的英雄中文名、Data Dragon 键名、称号 |

赛事页面名（`Tournaments.OverviewPage`）不进数据集：`tourn.name` 已经是可显示的名字，
重复存一份页面名要多花约 58 KB 压缩体积。

## 选手列

`columns` 的每个键对应 `Players` 表的一个字段，编码类型见 `fields`：

- `raw`：字符串本身（高基数字段，如 `ID`、`Name`、社交链接；链接去掉了 `https://` 与 `www.` 前缀）
- `dict`：`S` 的下标
- `team`：`teams` 的下标
- `date`：天数编码
- `num`：整数

`OverviewPage` 与 `ID` 相同时存 0，页面回退到 `ID`，省掉近两万个重复字符串。

`Country`、`Nationality`、`NationalityPrimary`、`Residency`、`ResidencyFormer`、`Role`、`RoleLast`、
`NameAlphabet` 这几列在构建时按 `tools/zh-terms.json` 换成了中文（多重国籍用「、」连接），所以数据集里
存的是界面直接显示的值，筛选下拉也是从列里取的。`NameZh` 是中文名：选手档案的本名用汉字写的时候就是它，
其余来自 `raw/ZhNames.json`（`tools/fetch_zh_names.py` + `tools/verify_zh_names.py` 从中文维基核对来的
译名），没有中文名的选手该列为 0。

另有 `fl` 位掩码，顺序见 `flags` 数组：退役、转无畏契约、转 TFT、转符文之地、转 2XKO、
内容创作者、替补、小写 ID、战队自动生成、内容较少。

## 履历 / 出场表

`tenures`、`contracts`、`tp` 都是「按选手排序 + 差分选手列」的结构：

```
pd:   [p0, p1-p0, p2-p1, ...]   // 选手下标差分，累加即绝对下标
n:    行数
```

`tenures` 的列：`t` 战队、`j` 入队日期、`l` 离队日期、`cur` 是否在队。
离队赛区、下一站战队、合同到期、下一站状态这几列没有存：页面按日期顺序从下一段履历推出来
（「下一站」就是下一段履历的战队），省掉四列整数。

`contracts` 的列：`t` 战队、`e` 到期日期、`rm` 是否为解约记录。

`honors.title` 的列：`t` 赛事下标、`pl` 名次（1 冠军 / 2 亚军 / 3 和 4 都是四强）；
`honors.award` 的列：`t` 赛事下标（0 = 该奖项不挂在某个赛事上）、`a` 奖项名下标。
两张表同样按选手排序 + 差分，行内顺序是「赛事日期倒序」，界面直接按顺序渲染。

名次的来源是 `TournamentResults` 的前四名：一张名次行是「某赛事、某战队、第几名」，而选手在
`tp` 里记着自己在那届赛事的登记战队，两边按战队名对齐，就把「战队成绩」变成了「选手荣誉」。
对齐用的是战队名而不是履历推导——赛事登记页与名次行对同一支队伍的写法可能不同，
但都以 `TournamentPlayers.Team` 与 `TournamentResults.Team` 的原文为准。

奖项来自 `IndividualAchievements`，`Display` 字段按 `tools/zh-terms.json` 的 `award` 表换成中文
（MVP / 一阵 / 二阵 / 三阵 / 最佳新秀 / 最佳教练组……），表里没有的取值原文照录，构建结束会打印出来。
同一选手在同一赛事的同名奖项只算一次。

`portraits.slot` 是「肖像精灵图的槽位 + 1」，0 表示这名选手没有肖像：只有出场最多的一批选手能进图集，
因为 4 MiB 只装得下几百张 48px 的小图（图集是 WebP——照片类图像用调色板 PNG 反而更大）。槽位来自
`PlayerImages` 里 `IsProfileImage=1` 的那张（没有就退到 `ImageType=Headshot`），按出场数从多到少排，
`icons.player` 是同一张图的 `{ cols, size, count }`，页面按 `slot - 1` 反算行列。

`tp` 的列：`t` 赛事下标、`team` 战队下标（只有与履历推导出的战队不一致时才存，其余为 0）。
同一选手同一赛事只保留一行，资格赛不收录。

`stats` 的列（按选手下标升序，页面顺序扫描）：`p` 选手下标、`g` 出场、`w` 胜场、
`k` / `d` / `a` 击杀死亡助攻、`pk` 五杀、`gold` 场均经济、`cs` 场均补刀 ×10、
`vs` 场均视野 ×10、`dmg` 场均伤害、`first` / `last` 首末场日期。
`CareerStats` 里同一选手可能有多行（旧 ID、重定向都会解析到同一档案），构建时只保留出场最多的一行。

## 体积（实测）

| 部分 | gzip 边际体积 |
| --- | --- |
| 选手列 | 835 KB |
| 战队履历 | 642 KB |
| 赛事出场 | 531 KB |
| 生涯数据 | 291 KB |
| 曾用名 | 97 KB |
| 赛事元数据 | 86 KB |
| 战队名字典 | 78 KB |
| 合同 | 52 KB |
| 赛事荣誉 | 32 KB |
| 字符串字典（含 2,336 个中文名） | 28 KB |
| 招牌英雄 | 27 KB |
| 赛季奖项 | 7 KB |
| 英雄名表（173 个中文名 + 称号） | 4 KB |
| 队标槽位 | 2 KB |
| 肖像槽位 | 1 KB |
| **合计** | **2.71 MB** |

「边际」指在完整数据集上删掉这一部分后重新 gzip 省下的字节，共享字典的收益按删除顺序摊到各部分，
所以合计等于 `dataset.json` 压缩后的 2.65 MB 上下。

base64 后 `dex.js` 3.53 MiB；打包成 `.nous-plugin.json` 是 4,182,666 字节（3.99 MiB），其中三张精灵图
215 KB（英雄图标 54,878、队标 64,855、肖像 100,268；base64 内联后 286 KiB），字体 70 KB，页面与 SDK 约
79 KB。距 4 MiB 上限还剩 11,638 字节，所以肖像数量停在第 240 名。
每个整数列的位宽（u8/u16/u32）按最大值自动选择，`packColumns()` 跳过含字符串的列。
