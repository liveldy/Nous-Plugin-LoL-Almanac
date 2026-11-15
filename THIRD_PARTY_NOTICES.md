# 第三方来源与署名

## 数据

**Leaguepedia**（`lol.fandom.com`）—— Fandom 的英雄联盟维基，职业选手、战队、赛事与逐局数据
由社区维护。经 Cargo API 导出的表以 CC BY-SA 3.0 提供：

> Leaguepedia | League of Legends Esports Wiki. https://lol.fandom.com/
> Text and data available under CC BY-SA 3.0.

插件内为构建时抓取的快照，不联网更新。使用的表：`Players`、`Tenures`、`Tournaments`、
`TournamentPlayers`、`Contracts`、`PlayerRedirects`、`TournamentResults`（前四名）、
`IndividualAchievements`（赛季奖项）、`PlayerImages`（选手肖像的文件名），
以及对 `ScoreboardPlayers` 的聚合查询。

联盟、战队、选手名称与标志归 Riot Games 及各战队所有。

**中文维基百科**（`zh.wikipedia.org`）—— 部分知名选手的中文名取自对应条目，经
`tools/verify_zh_names.py` 核对（条目须存在且正文讲的是《英雄联盟》），内容以 CC BY-SA 4.0 提供。

## 图像

**英雄图标与中文英雄名**（173 个）—— 取自 Riot Games 的 **Data Dragon** 静态资源
（`ddragon.leagueoflegends.com`，`zh_CN` 语言包）。英雄名、称号、图标即 `title`、`name`、
`image.full` 三个字段，见 `tools/build-icons.py`。Riot Games 允许在非商业粉丝项目中使用
《英雄联盟》游戏素材；英雄图标版权归 Riot Games 所有。

**俱乐部队标**（510 支队伍的 `File:<Team>logo std.png` 等）—— 取自 Leaguepedia 维基文件，
经 MediaWiki `imageinfo` 接口拿到 Fandom CDN 上的原图地址后下载，按 CC BY-SA 3.0 署名使用。
队标是各战队的商标，此处仅用于识别俱乐部。

**选手肖像**（数百张 `PlayerImages` 里的 `<Player>Headshot.png` 等）—— 同样取自 Leaguepedia
维基文件，经 `imageinfo` 接口下载后在构建时裁成方形、缩成小图、拼成一张 WebP 精灵图，按 CC BY-SA 3.0 署名使用。
肖像的著作权属于摄影者或战队，此处仅用于识别选手；插件包里只放得下出场最多的那批选手。

三张图集在构建时合成（两张 256 色调色板 PNG 和一张有损 WebP），随插件包以 data URL 内联，
运行时不发起任何请求。

## 字体

**Newsreader** — Copyright 2020 The Newsreader Project Authors
(https://github.com/productiontype/Newsreader)，SIL Open Font License 1.1，见 `ui/fonts/OFL.txt`。

## 代码

**Nous Plugin SDK 1.3** — MIT，Copyright Nous；副本在 `sdk/`。
**mwcleric** — MIT，Copyright RheingoldRiver；仅作为构建期数据抓取工具使用，不随插件分发。
