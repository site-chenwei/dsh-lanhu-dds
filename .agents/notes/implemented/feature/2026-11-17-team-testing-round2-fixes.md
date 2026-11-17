# Agent Note: 团队模式第二轮测试——选屏再收紧、计数与口径统一、规格表补齐读法

Status: implemented

## Problem

第一轮修复（[2026-11-17-team-testing-round1-fixes.md](./2026-11-17-team-testing-round1-fixes.md)）之后，用同样的四个角色重跑一轮：真实画布回归、边界压测（8 套新用例 374 条断言）、文档核对（45 条）、出码流程模拟（按 SKILL.md + 规格表写 `invoice/index.vue`，记录每条猜测）。报告在 `/tmp/lanhu-golden/team2/{a,b,c,d}/report.md`。去掉重复与「测试期望过时」后 16 类：

1. **同框嵌套帧被当成独立屏**。地址管理 `screen-7.png` 与 `screen-6.png` 逐字节相同，父屏规格表里已含该弹窗子树，`variants-diff.md` 却说 7「无独有子树」；`plan` 把 6→`list`、7→`select`，同一个弹窗被实现两遍。根因是上一轮的 `encloses` 要求「更大」，父子等大时两边都算屏。
2. **切图计数逐屏累加**。`localizeAssets` 的 `countedUrls` 每屏新建、`build` 再累加，同一张图被多屏引用就重复计：报告 23 / 磁盘 8、37 / 22、15 / 9。
3. **`manifest.json` 不幂等**。条目顺序随并发下载完成序变化，同一画布重跑字节不一致。
4. **屏号漂移无提示**。选屏规则一改，地址从 9 屏变 8 屏，旧 `plan` 的 `[0,7]` 静默变成「收货地址 + 删除弹窗」。
5. **图标数两处不一致**。报告按节点数、规格表按文件去重，组合图标的碎片 `1856ab0b4a.png` 只在报告里多算一个（14 vs 13）。
6. **规格表没有记号图例**。`grad-text` 从无解释，`c:MISSING` 又被上一轮删掉，渐变文字成了唯一无线索的项。
7. **行高提示在 `line-height` 写成 px 时静默失效**：`parseFloat("32px")` 当倍数用，算出 896px 的差再被上限过滤掉。
8. **行高示例会给出负 margin**：`↑gap:0`、`line-height 34`、图层高 28 → 「margin 取 -6」。
9. **磁盘 `screens.json` 缺 `raster`/`empty`/`popup`**，与 `lanhu_dds_screens` 的返回口径不一致。
10. **选屏还有四类错**：等大父子各出一屏、机身内 750×1200 的滚动内容顶替 750×900 的机身、纵向叠放两台手机选到整块画布、分组容器比帧大 1px 时屏宽变 752。
11. **组件候选表没转义竖线**（`spec.mjs` 主表与 `outlineMarkdown` 各一处），文案带 `|` 时 5 列表头配 7 列数据。
12. **EPERM/EACCES/ENOSPC 落成「链接 or Cookie」提示**，模型会去换 Cookie。
13. **`isRasterScreen` 与规格表的 `imageOnly` 判据不一致**：2 节点整图屏 `screens[]` 标 `raster`、report 写「整图?是」，规格表顶部却说「空框」。
14. **只有 `name:` 没有 props 的 `defineComponent` 被判「没有找到」**，实现被识别成缺失。
15. **文档五处不符**：归一倍数写成「画布」（实现取首屏原始宽）、规格表体积「2–11KB」（实测 1.3–12KB）、`strays` 只认三个文件模式、`util.mjs` 写成「哈希/PNG 尺寸」、`references/dds-format.md` 的「4837 个节点」与 README 的同一假统计、缺 Cookie 载荷示例漏 `askUser`/`afterFill`/`security`。
16. **出码模拟差最后一跳**（390 的问题只解了一半）：按上一轮的行高提示算出卡片 396，还差 6px——行盒上下各外扩一半，容器上下内距要各减 3。另外「11 处」计数不准（12 个文字节点里 10 个是 6px）、`ta` 在实测宽的文本节点上是空转、容器 `height` 无从判断是实测还是硬约束。

## Decision

1. **选屏在「包含关系去重」之上再分三档**（[dds-tree.mjs](../../../lib/dds-tree.mjs)）：先剔展示板（自己带页面帧类型、且内部并列着 ≥2 个宽度占自身 80% 以上、互不重叠的页面帧），再对「同一矩形 ±2px」的候选只留页面帧（`lanhupage`/`artboard`/`frame`）那一侧，最后补一条「同宽同起点但更高」的溢出内容判定。实测 address 9→8 屏，invoice 4、orders 5、gold 10、result 1 不变；合成的纵向双机、组比帧大 1px 也比 0.9.3 更准。
   页面帧类型**只用来给同一矩形的两个候选分高下，不能拿来整体筛候选**——先试过「有页面帧就只留页面帧」，gold 立刻从 10 屏变 18 屏（真实画布的屏本身是 `lanhubox`，里面反而套着 `lanhupage` 的内容帧）。
   展示板里的帧还要求「宽度 ≥ 自身 80%」：一屏里的内容块也是并列的页面帧，但宽度只有一半，不加这条会把正常页面判成展示板（gold 又变 18 屏）。
2. **切图计数改成循环外按文件统一算**（[build.mjs](../../../lib/build.mjs)），`total = cdn + alipic + cropped + placeholders`；`manifest.json` 落盘前按 `url` 排序。
3. **`plans.json` 里记 `screens: 屏数`**，重跑时与本次识别结果比对，不同就往返回值加一条 `warnings`；顶层 `warnings` 改成数组，容纳 `scale` 无效与屏号漂移两种。
4. **图标清单唯一来源**：`specMarkdown` 把真正进清单的文件挂到 `compiled.iconFiles`，`report.md` 直接取用，不再自己算一套。
5. **规格表补一行「记号」图例**（[spec.mjs](../../../lib/spec.mjs)），把 `fs/fw/lh/c/grad-text/ta/bg/r/bd/sh/op/pad/jc/ai` 全部列出；行高提示改成「兄弟间距 = `↑gap` − 溢出」+「容器上下内距各减 溢出/2」，`line-height` 支持 px，扣完变负的样本不拿来举例；补「容器尺寸是实测值，撑开的容器别写死 `height`」与「`ta` 在 flex 行里不要再叠」两条条件提示。
6. **`screenIsPopupSheet` 提成共享函数**，`screens` 工具、规格表、落盘 `screens.json` 三处同判据；`isRasterScreen` 里「只有一个子节点」必须那张是图片才算整图屏，否则归空框。
7. **`describeError` 加文件系统分支**（[index.js](../../../index.js)）：`EPERM|EACCES|ENOSPC|EROFS|EMFILE|ENOTDIR|EISDIR|EBUSY|ENOENT` 走「检查输出目录/磁盘/路径」，不再挂链接或 Cookie 的提示。
8. **组件实现识别的第三档**（[component-card.mjs](../../../lib/component-card.mjs)）：`__name` → `name:` 且能解析 props → `name:` 且同名标识符在本文件被导出（编译产物把 `defineComponent` 压成单字母时靠这条）。
9. **文档按实现改写**：归一说明改成「首屏实测宽」并说明切图尺寸不跟着归一；规格表体积 1.3–12KB；`strays` 模式补目录；`util.mjs` 描述改实；`dds-format.md` 的旧统计标注为「早期大样本，复测 1587 节点」；README 补「整图屏与空框分开算」与「已知选不准的两种稿子」。
10. **不做**：给「容器 `height` 是实测还是硬约束」出一个判据（DDS 里没有这个信息，得靠人看裁图）；把「分组行容器里只放一帧」也修掉（要区分它与正常内容块，靠宽度比与时钟都不可靠，会把 gold 打回 18 屏）。

## Alternatives considered

- **用页面帧类型整体筛候选**（`frames.length ? frames : pool`）：gold 10 → 18 屏。真实 DDS 的屏是 `lanhubox`、内容帧才是 `lanhupage`，类型方向与合成夹具相反。
- **按重叠面积聚簇选最大者**：纵向叠放的两台手机与整块画布的簇内重叠都是 100%，会把画布选成唯一屏。
- **展示板只要求 ≥2 个内部帧**：正常页面里的并列内容块也满足，gold 10 → 18 屏；加「宽度 ≥ 自身 80%」才区分得开。
- **`screens.json` 里把没进 plan 的屏也补 `popup`**：需要为它们多编译一遍（`popup` 判据依赖编译产物），而没进 plan 的屏本来就没有产物，需要时问 `screens` 工具更省。
- **行高提示直接给「容器内距 = rel 累加 − 溢出」**：flow2 实测仍差一跳（396 vs 390），必须说明是「两端各减一半」。

## Consequences

- 收益：address 不再把一个弹窗实现两遍（9→8 屏）；报告与规格表的图标数、切图数、弹层/整图/空框口径全部对齐；同一画布重跑 `manifest.json` 字节一致；屏号漂移、`scale` 无效都会在返回值里明说；出码模拟的 390 现在能一次算对；边界压测 u2 24/24、u6 23/23、u7 19/19、u1 175/175。
- 代价：`warnings` 从对象变数组（内部消费，无外部契约）；`compiled.iconFiles` 是 `specMarkdown` 的副作用，报告必须先跑规格表（`build` 里本来就是这个顺序）。
- 验证：`/tmp/lanhu-golden/verify-091.mjs`、`verify-092.mjs` 均 `ALL PASS`；`/tmp/lanhu-golden/team/b` 六套件 `54/56`、`54/54`、`21/22`、`25/25`、`6/6`、`27/28`；`/tmp/lanhu-golden/team2/b` 八套件 `175/175`、`24/24`、`15/15`、`69/69`、`17/17`、`23/23`、`19/19`、`28/32`；5 张真实画布重跑 result 1 / invoice 4 / address 8 / orders 5 / gold 10 屏，产物全部生成。
- 残留的 6 条 FAIL 全部是「测试期望过时」：plan 错误不带 `hint`（正文已写明动作）、冷缓存无效 plan 现在 0 请求、doctor 已有 `session` 参数、组件无卡片改 `{ok:false}`、address 现在 8 屏（断言写 9）、两条「与 0.9.3 一致」的断言（我们已比 0.9.3 更准）。
- 未验证：`u8` 的「分组行容器里只放一帧」仍然漏选（已写进 README 的已知边界）；没有在真实设计稿上验证「纵向叠放两台手机」的新判据（只有合成夹具）。
