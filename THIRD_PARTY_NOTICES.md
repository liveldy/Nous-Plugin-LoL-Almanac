# 第三方来源与署名

## 数据

**Leaguepedia**（`lol.fandom.com`）—— Fandom 的英雄联盟维基，职业选手、战队、赛事与逐局数据
由社区维护。经 Cargo API 导出的表以 CC BY-SA 3.0 提供：

> Leaguepedia | League of Legends Esports Wiki. https://lol.fandom.com/
> Text and data available under CC BY-SA 3.0.

插件内为 `2026-11-15` 的快照，不联网更新。使用的表：`Players`、`Tenures`、`Tournaments`、
`TournamentPlayers`、`Contracts`、`PlayerRedirects`，以及对 `ScoreboardPlayers` 的聚合查询。

联盟、战队、选手名称与标志归 Riot Games 及各战队所有。

**中文维基百科**（`zh.wikipedia.org`）—— 部分知名选手的中文名取自对应条目，经
`tools/verify_zh_names.py` 核对（条目须存在且正文讲的是《英雄联盟》），内容以 CC BY-SA 4.0 提供。

## 字体

**Newsreader** — Copyright 2020 The Newsreader Project Authors
(https://github.com/productiontype/Newsreader)，SIL Open Font License 1.1，见 `ui/fonts/OFL.txt`。

## 代码

**Nous Plugin SDK 1.3** — MIT，Copyright Nous；副本在 `sdk/`。
**mwcleric** — MIT，Copyright RheingoldRiver；仅作为构建期数据抓取工具使用，不随插件分发。
