# Agent Note: 团队模式第一轮测试的 12 类缺陷——漏屏、噪声提示、口径不一致

Status: implemented

## Problem

用四个并发 agent 分别做真实链接回归、边界压测、文档核对、出码流程模拟（任务与报告在 `/tmp/lanhu-golden/team/`），跑了 5 张真实画布 23 屏、194 条边界断言、76 条文档核对，外加一次「只按 SKILL.md 写发票管理页」的对照实验。四条线各自报出缺陷，去掉重复后 12 类：

1. **画布 4 帧只识别 1 帧**（最严重）。发票管理的 3 个 750×1624 帧在 DDS 里被打包进一层 `row___90275`，深度比首个候选深一级；[dds-tree.mjs](../../../lib/dds-tree.mjs) 只取 `minDepth`，三个页面状态零产物。
2. **选屏把「兄弟关系的整图帧」也吞掉**。地址管理 8 屏里有 1 帧是「您确认要删除此收货地址吗？」的独立整图，因为落在同一层又被 minDepth 之外的规则排除。
3. **网络/超时/5xx 全挂「Cookie 过期」提示**。[index.js](../../../index.js) 的 `describeError` 只有 cookie 与 plan 两个分支，其余一律套调用方给的链接 hint，模型据此去换 Cookie、改链接、重试同一调用。
4. **`Cannot convert undefined or null to object`、`out:'a/b'` 也走链接 hint**：内部错误正则与参数分支都漏了对应词。
5. **文本几何三值矛盾**（出码模拟唯一「照抄必错」）：`text-18` 是 `120×30` + `fs:30px lh:1.2`，兄弟行 `↑gap:36`，行距实际 66；照字面写 `line-height:1.2` 加 `margin-top:36` 得 72，卡片被撑到 420 而非 390。规格表没有任何一句话说这三者的关系。
6. **`jc:space-between` 行里的文本宽与 `←gap` 是派生量**，写死会随文案变长溢出，规格表也没说。
7. **多层 `rel()` 要累加**：`box-16 rel(24,24)` + `box-17 rel(0,24)` 纵向内距是 48，被写成 24，回量 png 才发现。
8. **整图屏被报成「空屏可以忽略」**：地址 #5 实为单张 750×1299 的图，`unplanned` 与屏清单（`整图?=是`）自相矛盾；空屏与整图屏是两种完全不同的处置。
9. **`manifest.json` 不幂等**：只有空白图写 `blank: true`，读回时补 `blank: false`，同一画布重跑必变（其余 21 类产物字节一致）。
10. **渐变文字误报 `text-color-missing`**：`background-clip:text` 的压字本来靠 `background-image` 上色，被报缺色后模型会去猜一个 `color`，把渐变盖掉。
11. **计数口径不一致**：报告「图标 N 个」按节点数、规格表清单按文件去重（15 vs 7、24 vs 19）；切图「CDN 直下 56」把缓存命中和同一 URL 的多节点引用都算进去（磁盘实际 22 个文件）。
12. **文档与实现不一致**：README 声称「4837 个节点里 box-shadow 命中 5 次」是假统计（真实 5 张画布 1587 节点、命中 0），产物文件名写错且漏了 `screen-N.outline.md`，`strays` 模式描述不符；SKILL 把 `img:PLACEHOLDER` 说成只有下载失败一种，`prune`/`forget` 的副作用两份文档都没写。

另有边界缺陷：组件卡片 CSS 截断在单行规则体上 `lastIndexOf` 返回 -1、`name:` 形态的 props 回看窗口只有 400 字符（emits 一长就判缺失）、`component: ''` 静默改跑整套体检、plan 形状错误要先下载 3 次请求才报、`variants-diff.md` 单元格里的竖线没转义把表格撑错列。

## Decision

1. **选屏改成包含关系去重**（[dds-tree.mjs](../../../lib/dds-tree.mjs)）：`top = pool.filter(c => !pool.some(o => encloses(o, c)))`，`encloses` 判「更大且四周都在容差内包住」。不再依赖深度——深度只说明 Figma 分组包了几层，与「是不是一个屏」无关。实测 invoice 1→4 屏、address 8→9 屏，orders/gold/result 不变。
2. **`describeError` 加网络与参数两条分支**（[index.js](../../../index.js)）：网络/超时/5xx/限流/非 JSON 走「原样重试一次，仍失败就停下来告诉用户」；参数类错误走「按参数描述改正后重试」，但 `plan 不合法` 与 `缺少 url` 例外——前者的正文已经写明该去问用户什么，后者确实是链接问题。内部错误正则补 `Cannot convert`、`of null`、`Invalid URL`。
3. **规格表补三行读法提示**（[spec.mjs](../../../lib/spec.mjs) 的 `readingNotes`，条件输出）：行高与 `↑gap` 的差额怎么处理（给一组真实数字做例子）、`jc:space-between` 行里的文本宽与 `←gap` 是派生量、多层 `rel()` 内距要累加。只在命中时才出现，短页不会被无谓拉长。
4. **整图屏与空屏分开表述**：`unplanned` 与 `screens` 列表按 `raster` 标 `raster: true`，`empty` 只给真正的空框；`report.md` 的处置建议分开写；规格表顶部对整图屏直接说「无法结构化还原，要么要源文件要么整张铺」。
5. **`manifest.json` 只在空白图写 `blank: true`**，读回时也只在算出来是空白时补，`blank === false` 直接删掉这个键。
6. **`background-clip:text` 不再报缺色**（[compile.mjs](../../../lib/compile.mjs)）。
7. **计数统一到「文件」**：报告图标数改成跨屏按文件名去重，与规格表清单同口径；切图计数按 URL 去重且注明「含缓存命中」。
8. **plan 形状校验提前**（[build.mjs](../../../lib/build.mjs) 的 `prevalidatePlan`）：缺 plan、mode 非法、pages 空、file 空、screens 非数组这些不需要联网就能判，放在拉 DDS 之前；屏号错误带原始值（`screens: ['abc']` 报「屏 "abc" 不是合法屏号」而不是「屏 NaN」），同一文件重复屏单独一句。
9. **组件卡片三处修正**（[component-card.mjs](../../../lib/component-card.mjs)）：CSS 截断在无换行时退化为定长截断；`parseProps` 回看窗口 400→4000，同时用「中间是否又出现一个 `name:`」挡住跨组件误抓；无卡片时返回 `{ok:false,error,searched,hint}`，`component: ''` 直接报参数错。
10. **`doctor` 接受 `session`**（[index.js](../../../index.js)）：`build` 用自定义会话名时，收尾要能读回同一个 `plans.json`。
11. **文档按实现改**：删掉假统计，改写产物文件名清单（补 `screen-N.outline.md`）、`strays` 实际匹配模式、会话标识变换规则、`prune`/`forget` 的副作用、PLACEHOLDER 的两种原因、规格表体积区间、`session` 与 `closeout` 的配对关系。

## Alternatives considered

### 选屏继续用深度，只把「同层被打包」的帧捞回来

比如按「宽度众数 ± 容差」放宽 `minDepth`。但发票管理的三个帧在 `depth=3`、首个候选在 `depth=2`，放宽深度会连带把 `row___90275` 这类纯布局容器也算成屏；包含关系是唯一既能把它们捞回来、又不会把容器当屏的判据。

### `describeError` 直接不挂 hint

0.9.0 之前就是这么做的，结果是模型只能看到一句 `Maximum call stack size exceeded`。hint 的问题不在「有没有」而在「对不对」，所以按错误类型分四支，而不是全撤。

### 行高/派生宽/内距写进 SKILL.md 而不进规格表

技能里写会变成一段永远在的长文，且与具体屏无关；规格表里按命中条件输出，正好在需要那一刻出现，压缩上下文后重读规格表也能恢复。代价是规格表多三行（约 300 字符）。

### `blank: false` 两边都写，让 manifest 自始自终带这个键

那就要改已发布的 `manifest.json` 语义，读旧 manifest 的路径也得兼容。改成「只在为真时出现」对读回代码零成本。

## Consequences

收益（同夹具、同真实画布对比）：

- 发票管理 1→4 屏、地址管理 8→9 屏；`variants-diff.md` 单元格不再撑错列。
- `manifest.json` 重跑逐字节一致，gold 画布 22 类产物全部幂等。
- 边界套件 194 条断言从 21 失败收敛到 2 条「测试期望过时」（冷缓存下无效 plan 现在 0 次请求，比断言的 1 次更好；plan 错误仍不带 `hint` 字段，因为正文已含动作）。
- 组件卡片 27/28（唯一 FAIL 是断言旧的 `{ok:true,cards:[]}` 形状）；`team/b/t2-errors.mjs` 54/54。
- 规格表多出三行读法提示，发票管理实测命中 11 处行高差并给出真实数字的例子。

代价与残留：

- 规格表体积增加约 300 字符/屏（仅命中时）。
- 包含关系去重是 O(n²)，候选数在真实画布上是个位数到十几个，可忽略。
- 整图屏与空屏的区分依赖编译期 `raster` 标记，若 DDS 里整图屏带了一层可展开的包装，仍会被当正常屏——已知边界，未在真实稿上遇到。
- 组件卡片 `parseProps` 的 4000 字符窗口在极端压缩的产物（整个文件一行）里可能抓到下一个组件，已用 `name:` 计数守卫，但只挡得住有第二个 `name:` 的形态。

验证：`node --check` 全部文件；`/tmp/lanhu-golden/verify-091.mjs`、`verify-092.mjs` 均 ALL PASS；`team/b/t1-plan.mjs` 54/56、`t2-errors.mjs` 54/54、`t3-closeout.mjs` 21/22、`t4-cache.mjs` 25/25、`t5-consistency.mjs` 6/6、`t6-components.mjs` 27/28；5 张真实画布重跑（invoice 4、address 9、orders 5、gold 10、result 1）。

未验证：真实项目里 `unplanned` 整图屏的用户拍板流程没走过；`doctor({session})` 只有夹具覆盖，没有跨进程实测。
