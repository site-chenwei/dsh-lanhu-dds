# Agent Note: 单屏画布崩溃、坐标按 designWidth 归一、图标改为占位交付

Status: implemented

## Problem

0.9.0 在单页任务上的真实会话是 175 步、177 次调用、79.4 分钟、推理 38.5 万字符。同一模型在 0.8.0 的 10 屏任务上是 125 步、32.9 分钟。逐步回放后的原因：

1. **`lanhu_dds_build` 四次调用四次崩溃，插件全程 0 个可用产物**。第 5、6、8 步返回 `Maximum call stack size exceeded`，第 7 步是参数误写成 `{"fields":"none"}` 的 `缺少 url`。四次都附带 `hint: 检查链接里的 image_id 是否属于当前项目、Cookie 是否过期`——这条提示与真实原因无关，前两次模型照着它怀疑链接。第 10–29 步它改为读插件源码（`lib/build.mjs` 13991 字符、`lib/compile.mjs` 14709、`lib/dds-tree.mjs` 5586），在会话临时目录写 `dbg.mjs`、`dbg2.mjs`、`gen.mjs`、`gen2.mjs` 自建了一条编译与切图管线。此后读到的 `screen-0.spec.md` 是它自己生成的 4200 字符，不是插件产物；`plan.json` 从未写入，`closeout` 一次都没出现。
2. **崩溃的代码原因**：`lib/compile.mjs:82` 的 `const parent = parentOf.get(node) ?? screenNode`。根节点在 `parentOf` 里没有条目，回退成屏节点，而单屏画布时屏节点就是根节点自己；`lib/compile.mjs:109` 的 `if (parent && boxes.get(parent)) boxes.get(parent).kids.push(node)` 于是把根节点推进了它自己的 `kids`。同文件 106 行的 `parentNode: depth > 0 ? parent : null` 有守卫，109 行没有。`lib/build.mjs:23` 的 `renderHtml` 是最先遍历 `kids` 的，立刻爆栈。前三轮的画布是 9382×3254 横排 10 屏，根节点宽 >1800 不会成为屏候选，所以从未触发；这一次是 1404×2588 的单屏画布。
3. **`unit: design` 不等于项目基准**。`lib/build.mjs` 在 `unit === 'design'` 时 `div = 1`，直出画布 px；本项目 `designWidth: 750`，画布 1404 宽，所有尺寸、字号、圆角偏大 1.872 倍。而切图像素是 750 空间的（安全区 750×68、对勾 47×33），两种空间混在同一份规格表里。模型在第 30、37 步反复推断「reference 是 351 宽放大 4 倍」「切图尺寸对不上」，最后在自建的 `gen2.mjs` 里手算 750/1404 归一。前三轮画布正好 750 宽，`div = 1` 恰好正确。
4. **图标该不该换、换成哪个，插件给不出依据**。19 步用 `node -e` 挖 `@xwfintech/icon-components/es/index.js` 里 151 个图标的 `paths`，8 步用 Python/PIL 裁图取色，28 步开 dev server 用浏览器比对。第 86 步的结论是 `CheckOutline` 是「圆环+勾」而不是设计稿的「实心圆+勾」，第 108 步又量出 `CheckCircleFill` 的勾宽 52 对参考 45。这三类动作合计 55 步，占全程三分之一，而插件只需要它写图标的 CSS。
5. **状态栏时间混进文案清单**。`lanhu_dds_screens` 的 `texts` 里有 `9:41`，`texts` 的过滤条件只有长度 ≥4。

## Decision

1. **根节点不进自己的 `kids`**（`lib/compile.mjs`）：`depth === 0` 时 `parent` 为 `null`，`parentRect` 直接取自身 `rect`。109 行不再需要单独判断深度。
2. **`design` 按项目 `designWidth` 归一**（`lib/build.mjs`、`lib/project.mjs`）：`div = 屏原始宽 / designWidth`，比值与 1 的差 ≤0.01 时不归一。`lib/project.mjs` 把设计稿基准的判断抽成导出的 `detectUnitBasis(dir, read)`，`diagnoseProject` 与 `build` 共用，避免两处判断漂移；`diagnoseProject` 的返回值新增 `designWidth`。`index.js` 的 `createBuildTool(ctx)` 用 `resolveProjectDir` 拿到项目目录后把 `designWidth` 传进 `buildDesign`。
3. **归一后的坐标取整**（`lib/dds-tree.mjs` 的 `nodeRect`）：`scale` 是整数时保持两位小数（`unit: css` 折 375 时会有小数），是归一后的小数时取整，规格表里不出现 `57.69px`。
4. **插件自身异常不再挂链接/Cookie 提示**（`index.js` 的 `describeError`）：消息命中 `Maximum call stack`、`Converting circular`、`Cannot read propert`、`is not a function`、`of undefined`、`out of memory` 时，返回「插件内部错误，与链接和 Cookie 无关：不要重试同一调用，把这条 error 原文贴给插件维护者」。链接/Cookie 类错误仍走原来的 cookie 分支。为可验证，`describeError` 改为导出。
5. **图标改为占位交付**（`lib/spec.mjs`、`lib/report.mjs`、`skills/lanhu-dds-codegen/SKILL.md`）：插件只给图标的 CSS 依据，资源由用户提供。规格表的清单标题改为「本屏图标（资源待用户提供：只按下面的尺寸与颜色写 CSS 占位）」，树内标注由 `[图标候选 单色 #…]` 改为 `[图标占位 …，资源待用户提供]`，`composite-icon:` 不再建议「换图标库」或「直接用预裁整图」。`report.md` 新增「待用户提供」一节汇总图标数。技能写明：按尺寸写 `width`/`height`、单色把色值写进 `color` 或占位底色，不手写 SVG、不去图标库找相似的、不用 Python/PIL 或 `md5sum` 比对切图、不为图标开浏览器验证。
6. **技能新增「拿不准就交出去」**：插件给不出依据的事最多验证两步，写进「未验证项或残留风险」交用户定。`closeout` 的 `next` 也写明图标占位不算未完成项。
7. **文案清单过滤状态栏时间**（`lib/dds-tree.mjs` 的 `describeScreen`、`lib/variants.mjs` 的 `prepare`）：`\d{1,2}:\d{2}` 形态的文案不进 `texts`。

## Alternatives considered

### 在 `renderHtml` 外面兜一层 try/catch

能立刻让 `build` 返回成功，不再爆栈。但 `kids` 里的环留下来，`detectScreenChrome`、规格表树、`findRepeatGroups`、`variants-diff` 全都在遍历 `kids`，崩在这里只是换一个地方崩，或者静默产出错误结构。

### 只改 109 行的条件，不动 `parent`

`parent` 在深度 0 时仍是根节点自身，`parentRect` 与 `rel` 会按自己算，得到 `rel(0,0)` 之外的位置偏移。三处一起改才不会留下`rel` 错位。

### 不归一，在技能里要求模型自己按比例换算

这正是本次会话里发生的事，模型在第 30、37 步反复推断比例，并把归一写进自建的生成器。比例来自项目的 `designWidth`，插件已经读到了，没有理由让模型重算。

### 保留「单色换图标库」的引导，只把理由写得更清楚

单色/多色能回答「图标库的单色图标能不能还原」，回答不了「换成哪一个」。图标库以组件形式发布，没有可比对的位图；没有 rasterizer 就只能靠路径几何加实际渲染去猜，本次会话的 55 步就是这条路。用户也明确不需要百分百还原。

### 图标改用空的占位方块、不给切图

干净，但用户拿不到「这个位置原来长什么样」的参照。切图仍留在 `assets/` 里，规格表只说别引它。

## Consequences

- **收益**：单屏画布不再崩溃，这是一条必现路径；`design` 输出与项目基准一致，规格表里的坐标与切图像素同空间，模型不用自己换算；插件自身的异常不再把模型引向链接和 Cookie；图标从「必须查清」变成「按尺寸写占位」，`spec`、`report`、技能三处口径一致。
- **代价**：
  - `design` 输出数值变了：1404 宽画布的 10 屏设计稿此前输出 1404 基准，现在输出 750 基准；只有画布宽等于 `designWidth` 的工程行为不变。
  - 项目未配置 `designWidth`/`rootValue`/`viewportWidth` 时仍按原样直出，规格表里加不出归一说明（`diagnoseProject` 的 `todos` 已有这条提醒）。
  - 图标不再给「用哪个图标库图标」的建议，视觉还原依赖用户补资源；`iconTint` 保留，但只作为 CSS 色值依据。
  - `describeError` 成为导出，`index.js` 的公开面多了一个函数。
- **验证**（`/tmp/lanhu-golden/verify-091.mjs`，走真实 `buildDesign` + mock fetch）：
  - 单屏 1404×2588 画布 + 合法 plan：修复前抛 `Maximum call stack size exceeded`，修复后产出 19 个文件；规格表首行为 `# Screen 0 — 支付结果 (750×1382, unit=design, 7 节点)`，第二段为「坐标归一：画布实测宽 1404px，是项目 750 基准的 1.872 倍…」。`screens.json` 的 `texts` 不含 `9:41`。
  - 750 宽画布：不出现归一说明，首行 `(750×…)`。
  - 未传 `designWidth`：保持直出，首行 `(1404×…)`。
  - 8000×1720 画布横排两台 750 手机、同一页面文件：两屏都编译，`variants-diff.md` 生成，`screen-0.ir.json` 的根 `children` 里没有它自己。
  - 规格表出现 `图标占位`、`资源待用户提供`，不出现 `换成图标库`、`优先换图标库`、`直接用切图`；`report.md` 有「待用户提供」一节且写明归一。
  - `describeError` 对爆栈返回「插件内部错误」，不再提 `image_id`；`HTTP 403` 仍走 cookie 分支；`plan 不合法` 不带无关提示。
  - `diagnoseProject` 对 `config/index.ts` 里 `designWidth: 750` 的夹具返回 `designWidth: 750`、`unit: 'design'`。
- **未验证**：
  - 没有在真实设计稿与真实模型上重跑。重跑时的判断数字：`lanhu_dds_build` 不再返回 `Maximum call stack`；规格表数值与项目 750 基准同量级；图标相关步骤不超过 5 个（本次 55）；总步数不超过 90（本次 175）。
  - 崩溃只在合成夹具上复现，没有拿本次设计稿的真实 DDS 原文回归；结论建立在「`parentOf` 里没有根节点条目」这一代码事实上。
  - `cropScreenPng` 直接用画布 px 从参考图裁，前提是参考图自然尺寸等于画布尺寸；参考图实际像素未取得，不归一之后这条路径不受影响，但仍是未验证项。
