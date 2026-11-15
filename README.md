# 英雄联盟职业选手图鉴 · Nous 插件

两万余名英雄联盟职业选手的完整档案，离线秒查。数据来自
[Leaguepedia](https://lol.fandom.com/)（Fandom 的英雄联盟维基，数据以 CC BY-SA 3.0 提供），
经 Cargo API 全量导出后在插件内以 gzip 快照形式携带。

插件宿主页面运行在不透明来源的 iframe 中，`connect-src 'none'`，因此**不做运行时联网**：
所有数据在构建时抓取、压缩、随包发布，打开即用，也意味着没有网络请求等待与失败态。

## 收录内容

| 数据 | 行数 | 来源表 |
| --- | --- | --- |
| 选手档案 | 20,879 | `Players`（除 `Image` 外全部字段） |
| 中文名 | 2,336 名选手 | `Players.NativeName` 的汉字本名 + 中文维基核对过的译名 |
| 战队履历 | 113,844 | `Tenures` |
| 赛事元数据（名称 / 联赛 / 赛区 / 级别 / 起止日期 / 奖金 / 赛制） | 10,560 | `Tournaments` |
| 赛事出场（赛事 / 战队 / 年份） | 254,361 | `TournamentPlayers` |
| 合同到期记录 | 15,196 | `Contracts` |
| 曾用名（检索用） | 13,760 | `PlayerRedirects` |
| 生涯合计（出场 / 胜率 / KDA / 五杀 / 场均经济·补刀·视野·伤害 / 首末场） | 14,470 名选手 | `ScoreboardPlayers` 聚合 |
| 俱乐部队标 | 526 支队伍 | Leaguepedia 维基文件（`<Team>logo std.png` 等） |
| 英雄图标与官方中文名 | 173 个英雄 | [Data Dragon](https://ddragon.leagueoflegends.com/) `zh_CN` |

选手档案展示 `Players` 表的每一个字段：本名、母语名、文字系统、国家、国籍、赛区、惯用位置、
现任与历任战队、合同与合同说明、招牌英雄、排位账号（`KR: Hide on bush#KR1` 这种原文已清掉维基标记），
以及 X、直播、YouTube、Instagram、微博、Discord、lolpros、Deeplol、DPM 等全部社交与战绩链接
（点击用系统浏览器打开）。空字段不显示，有值的字段全部显示；`IsRetired`、`ToValorant`、
`IsSubstitute` 等 10 个布尔标记合并成一行「标记」。

### 中文化

界面是中文，数据源是英文，所以构建时还要过一次「本地化」：

- **国家、国籍、赛区、惯用位置、文字系统**按 `tools/zh-terms.json` 换成中文（韩国 / 中单 / 韩文），
  筛选下拉里用到的也是这些中文值；表里查不到的值原样保留（目前只剩 `EMEA` 这个缩写）。多重国籍按
  「、」连接。
- **选手姓名**：有中文名就显示中文名，没有就显示 ID 加母语名。两万多名选手里有 2,336 人带中文名：
  - 2,312 人的来源是选手档案本身——`Players.NativeName` 用汉字写的，那就是他/她的中文名（中国大陆、
    台港澳、日本选手为主）；
  - 24 个知名选手（Faker 李相赫、Deft 金赫奎、Rookie 宋义进、TheShy 姜承録……）的中文名来自中文维基，
    由 `tools/verify_zh_names.py` 逐条核对：页面必须存在、且正文讲的是《英雄联盟》才算数。
  - 其余选手（韩国、欧美等）在 Leaguepedia 与中文维基里都没有中文名，硬造音译反而是错的，
    因此保留 ID，母语名照常显示。
- **赛事名与联赛名**中文化，**俱乐部名保持原文**（专有名词，硬翻反而认不出来）：
  - 联赛名通常是专名或缩写，只翻译有公认中文名的（`Tencent LoL Pro League` → LPL、`World Championship`
    → 全球总决赛、`EU Masters` → 欧洲大师赛，约 50 条），查不到的保持原样；
  - 赛事名按词组替换，长的先替换、按词边界匹配（`Spring` → 春季赛、`Playoffs` → 季后赛、`Qualifier`
    → 预选赛、`Season 3` → 第 3 赛季），替换后把相邻汉字之间的空格去掉，于是
    `LPL 2013 Spring Playoffs` 变成「LPL 2013 春季赛季后赛」；品牌名（Prime League、Hitpoint、
    UltraLiga…）不在词表里，原样保留；`<s>` 删除线标记先清掉。
- **英雄名用官方中文**：`Data Dragon` 的 `zh_CN` 语言包给出 173 个英雄的中文名与称号
  （`Lee Sin` → 李青 · 盲僧），招牌英雄按此显示中文名并配上英雄图标。
  注意 ddragon 的这个包里 `name` 与 `title` 是反的：`name` 是称号、`title` 才是中文名。
- 赛区、联赛之外的地名（如 `MENA`）保持 Leaguepedia 的写法。

### 没有收录的内容与原因

- **选手头像**：见下一条 —— Leaguepedia 没有可用的选手肖像字段，所以用队标与英雄图标来做视觉识别。
  `Players.Image` 在 Cargo 里全是空串；`PlayerImages` 表在这套接口上直接报
  `internal_api_error_MWException`（换 `*`、换字段、带过滤都一样），拿不到 `FileName` 列表。
  即便拿到，CSP 只允许 `img-src data:`，两万张头像也不可能塞进 4 MiB。
- **俱乐部队标的完整覆盖**：`Tenures` 里出现过的队伍有 10,708 支，队标图集只放 526 支
  （按「履历条数 + 9 × 现役选手数」排序，覆盖主流队伍与当下有人的队伍），因为每块图标约 80 字节，
  全量需要 800 KB 以上。没有图标的队伍在界面上不显示图标，不影响其他信息。
- **英雄池 / 位置分布**（`ScoreboardPlayers` 按 `Link,Champion` 聚合）：单人单英雄约 15 万个组合，
  实测这部分单独压缩就要 300 KB 以上，而插件包剩余预算不足 200 KB，因此不收录；选手的
  生涯合计仍然完整（见上表的生涯数据行）。`tools/fetch_stats.py` 里保留了抓取规格，配额宽裕时可以打开。
- **逐局战绩**（`ScoreboardPlayers` 原始行，数百万行）：单局数据装不进插件包。
- **队伍成绩**（`TournamentResults`）：与履历、赛事交叉后体积过大。
- **资格赛**（`Tournaments.IsQualifier=1`，1,927 个赛事、105,172 行出场）：不进入赛事履历，
  否则每人每年会多出十几场预选赛记录，把正式比赛淹掉。
- **没有选手档案的名字**：`TournamentPlayers` 有 81,289 行、`Tenures` 有 1.4 万行指向的名字在
  `Players` 表里没有对应行（业余与临时选手、没有填选手信息框的页面，共 46,797 个不同名字）。
  `Players` 表本身只有 20,879 行，这些行没有可展示的档案，构建时丢弃并计数。

## 界面

- **左栏索引**：虚拟滚动列表，20,879 行不掉帧；瞬时搜索覆盖 ID、中文名、本名、母语名与曾用名；
  每行带当前战队的队标（没有队标的队伍留白，保持左对齐）。
- **筛选**：位置、赛区、国家或地区、状态（现役 / 退役 / 转项目），中文取值；并可切换排序
  （名字 / 出场 / 最近比赛 / 出道）。筛选条件叠加后会变成可单独撤掉的标签。
- **右栏档案**：身份、ID 与中文名、本名与母语名、生涯数据带、招牌英雄卡片（英雄图标 + 中文名 + 称号）、
  战队履历（带队标）、赛事履历（按年分组，带当场战队队标）、合同、完整档案、曾用名、链接。
- **交叉跳转**：履历里的战队、赛事履历里的赛事都可以点，索引立刻筛出对应的人或赛事。
- 快捷键：`/` 聚焦搜索，`↑` `↓` 在列表里移动，`Esc` 清空搜索。
- 手机宽度（≤860px）切换成单栏：点选手看档案，档案顶部返回索引。

## 构建

```sh
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install mwcleric Pillow                       # Leaguepedia 客户端（MIT）+ 图片合成

# 凭据只从环境变量读，不写进仓库；没有凭据也能匿名抓，只是慢
export LEAGUEPEDIA_BOT_USER='...@...'
export LEAGUEPEDIA_BOT_PASSWORD='...'

# 国内网络访问 lol.fandom.com 与 ddragon 需要代理（抓图与抓表都要）
export HTTPS_PROXY=http://127.0.0.1:7890 HTTP_PROXY=http://127.0.0.1:7890

# 1. 抓原始表（写入 raw/，可重复运行，已存在的表会跳过）
python tools/fetch.py raw Players,Tenures,Tournaments,Contracts,PlayerRedirects
python tools/fetch_parts.py raw TournamentPlayers   # 44 万行，按首字母分片、可续跑
python tools/fetch_stats.py raw CareerStats         # 逐局表在服务端聚合，避免拉几百万行
python tools/fetch_zh_names.py raw                  # 中文维基里查得到的那批选手的中文名
python tools/verify_zh_names.py raw                 # 按名单核对通行译名（不存在或不是英雄联盟的丢弃）

# 2. 抓图并合成两张精灵图（downloads 缓存在 raw/icons/，重跑只抓新增）
python tools/build-icons.py raw ui/icons build
#    TEAM_ICONS=620 控制队标数量；写入 ui/icons/*.png 与 build/icons.json、build/champions.json

# 3. 压缩成插件数据（字典编码 + 差分 + 定宽二进制 + gzip + base64）
node tools/build-data.mjs raw build
node tools/pack-data.mjs build/dataset.json ui/data/dex.js

# 4. 检查与打包
node sdk/check.mjs .
node --test test/*.test.mjs
node sdk/pack.mjs .
```

`tools/build-data.mjs` 会在结束时打印各表行数、压缩体积，以及因资格赛 / 无档案 / 重复而被丢弃的行数，
还有招牌英雄里没有对上 Data Dragon 的英雄名（当前为 0 个）。

### 体积预算

插件包上限 4 MiB。快照压缩后 2.74 MB，base64 进 `dex.js` 是 3.66 MiB，两张精灵图 96 KB，
其余约 100 KB 是页面、字体与 SDK；`sdk/pack.mjs` 打出的发行包 4,143,094 字节（3.95 MiB），
距上限约 50 KB。细节见 `docs/data-model.md`。

## 开发预览

```sh
node sdk/dev.mjs .          # 宿主模拟：http://127.0.0.1:8088/，/configure?theme=dark 切深色
node tools/serve.mjs .      # 不进沙箱的检查台：http://127.0.0.1:8090/
```

`tools/harness.html` 是检查台，用来在不启动宿主时看真实渲染；它注入了与宿主一致的 CSP，
所以「内联 style 属性被丢弃」这类问题在检查台里就能看到。

## 许可

插件代码 MIT。数据来自 Leaguepedia / Fandom，按 CC BY-SA 3.0 使用，署名见 `THIRD_PARTY_NOTICES.md`。
字体 Newsreader 按 SIL Open Font License 1.1 使用。
