---
name: lanhu-dds-codegen
description: 用蓝湖「转代码」(DDS) 把设计图还原成前端代码。当任务要求照蓝湖设计稿写页面/组件、做 UI 1:1 还原、把 Figma/蓝湖稿子变成代码，或需要用 lanhu-mcp / DDS 做像素级复刻时使用。
whenToUse: 用户给出蓝湖设计图链接要求实现页面或组件；用户要求高保真/像素级还原；用户要求把设计稿转成 React/Vue/小程序代码；已有页面与设计稿不一致需要定位差异。
---

# 蓝湖 DDS 代码还原

DDS（转代码）是蓝湖给的结构化产物：一棵带**画布绝对坐标**的布局树，比截图靠谱，比 MCP 的扁平 CSS 提示完整。它给你四样东西——几何、文案、颜色、**阴影与渐变**；它给不了三样东西——响应式、交互态、图标矢量。**你的工作是把前者变成代码，把后者补上。**

## 0. 流程总览

```
蓝湖链接 → ① 选屏 → ② 编译成产物 → ③ 读项目规范 → ④ 按产物写代码 → ⑤ 几何+视觉验收
```

任何一步都别跳。尤其 **① 选屏**：一张设计图往往横排 5~10 台手机屏，选错屏后面全白做。

## 1. 准备：拿 Cookie

只拉 DDS 树和参考图需要 Cookie，切图不需要。三种给法，优先级从高到低：

1. `--cookie "<值>"`
2. 环境变量 `LANHU_COOKIE`
3. 项目本地 `.env` 里的 `LANHU_COOKIE`（脚本不自动读，需你 `export`）

拿法：浏览器登录蓝湖 → F12 → Network → 任选一个 `lanhuapp.com` 请求 → 复制完整 `Cookie` 请求头。
**Cookie 是凭据：不要写进代码、不要提交、不要在回复里回显。** 只放在环境变量或本地 `.env`（并确保 `.env` 在 `.gitignore` 里）。

## 2. 选屏（必做）

> 两种入口，产物完全一致：**环境里有 `lanhu_dds_screens` / `lanhu_dds_build` 工具**（装了 `dsh-lanhu-dds` 插件）就直接用工具，参数与下面的命令行一一对应；没有就跑本 Skill 目录下的脚本。下文用命令行为例。

```bash
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs build --url "<蓝湖链接>" --out design/<页面名> --list
```

输出每屏的 `index / 尺寸 / 节点数 / raster / title / texts`。读它，然后决定做第几屏：

- `title` 是导航栏标题，通常就是屏的名字。
- `raster: true` 表示这屏在 DDS 里是一张整图，**没有任何结构**——直接告诉用户「这屏 DDS 无法还原，需要设计源文件或人工切图」，不要硬写代码。
- 一屏固定 375 逻辑宽（脚本已按 `屏宽/375` 推出缩放比，@2x/@3x 自动处理）。

一次做完所有需要的屏也可以：`--screen 0,2,5` 或 `--screen all`。**屏数超过 3 个时先跟用户确认要哪几屏**，别默认全做。

## 3. 编译

```bash
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs build \
  --url "<蓝湖链接>" --out design/<页面名> --screen 0
```

产物（每屏一套）：

| 文件 | 作用 | 怎么用 |
|---|---|---|
| `screen-N.png` | 该屏的设计稿裁图（已从整张画布裁好） | **视觉唯一真相**：阴影、图标形态、图形细节看它（渐变与圆角 DDS 本身已给全） |
| `screen-N.ir.json` | 结构树：每个节点的 box、文案、颜色、字号、flex 语义、`dds` id | 写代码的主要依据 |
| `screen-N.rects.json` | 扁平几何表 `{idx,dds,x,y,w,h}`，屏内相对坐标 | 验收基线，可直接和 DOM 比对 |
| `screen-N.html` | 绝对定位参考渲染，含 `data-dds` 标记 | 拿不准某处层级/坐标时打开看；也可截图做像素对比 |
| `screen-N.outline.md` | 缩进结构大纲 + 重复结构→组件候选 | 决定怎么拆组件，先读它 |
| `tokens.css` | 颜色/字体 token（按出现频次） | 映射到项目既有的 token/变量 |
| `report.md` | 屏清单 + 告警统计 + DDS 缺口清单 | 先读一遍，告警就是「这里还得你补」 |
| `assets/` | 已下载到本地的切图 + `manifest.json` | 拷进项目静态目录，**不要引用蓝湖 CDN 地址** |

**单位默认是设计稿 px（750 基准）**。蓝湖原型按 750 宽设计，产物里的 `750px / 352px / 28px` 就是设计稿上量到的数值，**不要自己除以 2**。移动端项目普遍在构建期用 `postcss-px-to-rem`（750 稿 + `rootValue: 75`）或 `lib-flexible` 把 px 换算成 rem，所以代码里写设计稿 px 就是对的。

项目是 1x（375 逻辑宽）或者不走 px→rem 时，加 `--unit css`，全部数值自动折半成 CSS px。

`--no-ref` 跳过参考图下载，`--no-assets` 跳过切图。离线场景：先把 `dds.raw.json` 存下来，之后用
`local --dds dds.raw.json --meta meta.json --ref reference.png --out ...` 重跑，不再需要网络。

## 4. 谁说了算

还原时按这个优先级裁决冲突，不要凭感觉：

1. **`screen-N.png`（设计稿裁图）** > 一切。**图标形态、描边细节**只信它（阴影/渐变/圆角 DDS 有，冲突时以裁图为准）。
2. **`ir.json` 的 `rect`** > `html` 的视觉位置。几何误差 > 1px 就是错。
3. **`ir.json` 的 `css.color`** > 你的直觉。DDS 缺 color 时脚本会回落到 `--color-text-primary`，并在 `report.md` 的 `text-color-missing` 里点名——这些必须对着裁图逐个确认。
4. **`tokens.css`** 只是候选值，项目里有自己的 token 就用项目的。
5. 你从裁图上「看出来」的间距，与 `rect` 冲突时，以 `rect` 为准，把差值记到验收报告里。

## 5. 先读项目，再写代码（不可跳过）

**这一步决定了产出是「能合并的代码」还是「一个孤立的 Demo」。**

**第 0 步，先跑自检**：

```bash
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs doctor
```

它会告诉你三件事：**该用哪个 `--unit`**（读 `designWidth` / `rootValue` 推出来的，不用猜）、**识别到了哪些内网包**、**`project-rules.md` 还空着几项**。

- 输出 `ready: true` → 直接开工。
- 有 `未接入` 或一堆空格 → 先补 `project-rules.md`（`doctor --init` 生成模板）。**不要拿模板里的示例当项目规范**，那些 `@company/ui`、`UiButton` 是占位，照着写就是编。
- 提示「UI 库清单还没生成」→ 跑 `doctor --ui`，它扫 `node_modules` 写出 `ui-library.md`（真实组件名 + 导入路径 + 尽力解析的 props）。**这份清单是出码时"有没有现成组件"的唯一依据**，不要凭想象写 `<Button>`。

然后按顺序找项目自己的规矩，读到什么就遵守什么：

1. 根目录 `AGENTS.md` / `CLAUDE.md` / `.cursor/rules` / `README` 里的开发约定
2. `.agents/` 下的笔记与规范（`.agents/notes/`、`.agents/skills/`）
3. 组件库与样式方案：**先读 `.agents/skills/lanhu-dds-codegen/ui-library.md`**（`doctor --ui` 生成的真实组件清单，比文档新）。没有这个文件就去看 `package.json` 里的内网包名，去 `node_modules/<包>/es/` 翻；再看 `src/components/`、`tailwind.config.*`、`*.module.css`、`theme.ts`、`variables.scss`
4. **同类页面的既有实现**（最重要）：找一个已经在线上、结构和本屏接近的页面，读它的取数、样式组织、埋点、路由注册方式
5. `package.json`：框架、UI 库、CSS 方案、路径别名、lint 规则
6. **构建配置里的单位基准**（决定产物单位对不对）：
   - Taro：`config/index.ts` 或根目录 `config.ts` 的 `designWidth`（750 → 产物直接用默认 `--unit design`；375 → 加 `--unit css`）与 `deviceRatio`
   - Vite/webpack：`postcss.config.*` 里 `postcss-px-to-rem` 的 `rootValue`（75 → `design`；37.5 → `css`）、`postcss-px-to-viewport` 的 `viewportWidth`

如果项目根目录有 `.agents/skills/lanhu-dds-codegen/project-rules.md`，**它优先级高于本文档**——那是这个项目沉淀的还原约定（组件放哪、样式怎么写、token 叫什么、要不要接入设计系统）。没有就按本文档走，并在本次任务结束时把新增的约定补进去。

产出必须落到项目的既有结构里：同样的目录、同样的命名、同样的 import 别名、同样的样式方案。**禁止**为了省事新建一套并行的目录或引入新依赖。

## 6. 出码

### 6.1 结构映射

- **`outline.md` 的「组件候选」就是组件边界**：重复 N 次且结构同构的块 → 抽成一个组件，可变部分（文案、金额、状态、图片）做成 props。重复 5 次的订单卡片写成 5 段复制粘贴是错的。
- `ir.json` 里 `display:flex` 的节点按 flex 语义还原（`flexDirection`/`justifyContent`/`alignItems`）；**不要**把 abs 参考渲染的 `position:absolute; left; top` 直接搬进项目代码。abs 只用于对齐校验。
- 尺寸定值来自 `rect`，但**能用 padding/gap 表达的间距就不要写死 margin**。DDS 的父子同 rect 会变成「双倍 padding」，写代码时按视觉裁图确认一次真实内边距。
- **UI 组件优先，不要手写**。目标是 H5，项目里有一套内网 Vant 封装（也可能有原生 HTML 封装的通用组件）。顺序永远是：**内网组件库有 → 直接用；库能配出来 → 用库的 props/CSS 变量配；都没有 → 才手写**。手写按钮、单元格、标签、空态、骨架屏基本都是错的产出。
  - 先摸清库里有什么：`package.json` 里的内网包名 → `node_modules/<包>/es/` 或组件文档 → 拿到组件名与 props。常见的 `Button / Cell / CellGroup / Tag / Popup / Dialog / Toast / List / Empty / Skeleton / Tabs / Picker` 一定要查过再动手。
  - 库组件的默认样式跟设计稿不会一样（内边距、字号、圆角、行高）。**用库暴露的 CSS 变量或 `:deep()` 局部覆盖**，不要全局 `!important`、不要改 `node_modules`。
- **标签按目标平台来**：这套是 **Taro H5**，写普通 HTML/Vue SFC —— `div/span/img/ul/li/a/button` 都合法。`<view>/<text>/<image>` 是给小程序端的，**这里不用**（会跟内网 UI 库的样式重置打架）。
- `uiType` 含 `Image`/`Text`/`ImageText` 可作提示：`ImageText` 通常是「图标/图片 + 文案」的一行，优先找库里的 Cell / Media 类组件。
- 可点击区域用库的 Button 或 `<a>`/`<button>`，语义与可访问性一起给（内网组件库多半已经处理过）。

### 6.2 样式规矩

- 颜色/字号/圆角先查项目 token，命中就用变量；没命中才用 `tokens.css` 的字面值，并在验收里标注「新增 token」。
- 字体：`tokens.css` 已把字体家族转成 `--font-*` 变量并对 Windows 做了雅黑兜底。不要直接写 `PingFang SC`。
- 单行文本垂直居中用 flex（`display:flex;align-items:center`），不要靠 `line-height` 猜。
- 单位直接写**设计稿 px**（750 基准），交给项目内 px→rem 换算；**不要手算 rem/vw**，也不要自己除 2。项目是 1x 或产物用了 `--unit css` 时，值已经是 CSS px。
- **Taro 项目（`designWidth: 750`）**：样式里就写设计稿量到的 px，Taro 的 `pxtransform` 在构建期统一换算成适配单位（H5 端转 rem）。**不要写 `rpx`、不要写 `rem`、不要手算**——这正是产物默认 `--unit design` 的原因。`designWidth` 是别的值（如 375）时才需要 `--unit css`。
- 内网 UI 组件库自带一套间距/字号刻度，和设计稿会有 2–4px 的偏差。**允许这层偏差**：能用库的默认值就用默认值，不要为了 1px 去覆盖库样式——那样维护成本远大于收益，评审也会问「为什么这里特殊」。

### 6.3 状态与交互

DDS 没有交互态。以下必须主动补齐并在交付说明里写清楚：

- 空态、加载态、错误态、无网络
- 按压/禁用/选中态的颜色
- 长文本截断、金额超长、图片加载失败
- 点击去向（回蓝湖原型确认，不要自己编）

### 6.4 图标：做占位，不还原

图标是**唯一允许留空的东西**。DDS 只给切图 PNG（无矢量、无语义名），硬描一遍 SVG 既慢又容易走形——这不是模型该干的活。

规矩：

1. **结构写全**：占位元素要有真实尺寸、定位、`border-radius`、`background-size`，从 `rects.json` 取数，保证布局和间距是对的。
2. **语义留位**：类名 / `data-icon` 写成可识别的语义（`icon-arrow-left`、`icon-search`、`icon-status-paid`），别叫 `img-13`。
3. **可访问性不断**：功能性图标保留 `aria-label`（关闭、返回、搜索），纯装饰图标 `aria-hidden="true"`。
4. **别留裸 `<img>` 指向蓝湖**：要么用 `assets/` 的本地切图临时顶上，要么留一个可见的空占位（如 `background: #eee` 的方块），**不能 404**。
5. **进待办清单**：交付说明里逐条写「第 X 处 → 语义 → 建议换成图标库的哪个」。
6. 项目本来就有图标库/设计系统时，**能直接换的就别留占位**——占位是给「没有对应图标」的兜底，不是偷懒借口。
7. **只对「图标」放宽，不对「内容图」放宽**：商品图、banner 背景、证书缩略图这类属于内容，必须用 `assets/` 里的真图，不能占位。判断标准是「这张图是不是承载业务信息」。

示例：

```jsx
// TODO(icon): status-paid → 换成 @acme/icons 的 PaidIcon，尺寸 14
<span className="icon icon--status-paid" aria-hidden="true" />
```

```css
.icon--status-paid { width: 7px; height: 7px; background: currentColor; border-radius: 50%; }
```

## 7. 验收

### 7.1 几何（可自动）

`rects.json` 是**设计稿 px、屏内相对坐标**。DOM 量出来是 CSS px，所以要乘 `750 / 视口宽` 换回设计 px 再比——这样在 375 手机、750 桌面、任何缩放比下都成立。

```js
const rects = /* 贴入 screen-N.rects.json 内容 */;
const K = 750 / document.documentElement.clientWidth;   // 设计稿 750 基准
const base = document.querySelector('[data-check-root]').getBoundingClientRect(); // 页面根容器
const bad = rects.filter(e => {
  const el = document.querySelector(`[data-dds-check="${e.idx}"]`);
  if (!el) return true;                                  // 找不到 = 直接算失败
  const r = el.getBoundingClientRect();
  return Math.abs((r.x - base.x) * K - e.x) > 3
      || Math.abs((r.y - base.y) * K - e.y) > 3
      || Math.abs(r.width * K - e.w) > 3
      || Math.abs(r.height * K - e.h) > 3;
});
console.table(bad);
```

验收要求：**差值 ≤ 3 设计 px（≈1.5 CSS px）视为通过**；超过必须解释原因（字体度量、图标尺寸、内容溢出、换行行数不同）。不想加 `data-dds-check` 属性也没关系，用组件里对应的选择器逐个手查也行，但必须真的量过。

### 7.2 视觉（人工或截图）

把实现页面截成 375 宽整图，和 `screen-N.png` 并排看。重点看 DDS 给不了的两类：**图标形态、字体度量**（字形宽度差会让数字/标题轻微错位，不必强求像素一致，但不能错行、错位到破坏布局）。阴影/渐变 DDS 有，对不上先怀疑自己没按缩放比换算。

### 7.3 交付说明必须写

- 做了哪几屏、对应哪个设计稿链接/版本
- 抽了哪些组件，各承接什么 props
- 哪些值是新引入的 token（而不是复用项目现有 token）
- DDS 缺口是怎么补的（图标占位方案、字体兜底方案）
- **图标待办清单**：哪些位置是占位、需要人工换成项目图标库的哪个组件
- 明确的未还原项（如果有）

## 8. DDS 的已知缺口

这些不要试图从 DDS 里挖，挖不到，直接补：

| 缺口 | 表现 | 补法 |
|---|---|---|
| （无） | 阴影 DDS **有**：`style.boxShadow`，值形如 `0px 4px 40px 0px rgba(0,0,0,0.13)` | 直接用；脚本已把里面的 px 按缩放比折算（漏了会大一倍） |
| 响应式 | 只有 375 一套绝对坐标 | 按项目栅格重算，或只做 375 并说明 |
| 交互态 | 无 | 见 6.3 |
| **图标** | 只有切图 PNG，没有矢量、没有语义名 | **不要还原**，做占位并写全 CSS，列为待办交人工（见 6.4） |
| 字重细节 | `fontWeight` 有时缺失或与设计不符 | 看裁图 |
| 1px 描边 | 可能丢 | 看裁图 |

**阴影和渐变都不是缺口**：`background` 给的是完整可用的 `linear-gradient(...)`，角度色标齐全，渐变文字（`WebkitBackgroundClip:text` + `WebkitTextFillColor:transparent`）也成对给全；`boxShadow` 是合法的 CSS 阴影值。
两者共同的坑是**单位**：DDS 全是设备像素，阴影的 `0px 4px 40px` 在 @2x 下要变成 `0px 2px 20px`。脚本已处理，你手写时别忘。

`report.md` 里的每条告警都是「DDS 在这里没给准」，逐条处理，不要静默忽略。

## 9. 常见错误（都会导致返工）

1. **不选屏就编译**：把整张画布当一个页面写，出来是个 3750 宽的怪物。
2. **直接搬 abs 布局**：`screen-N.html` 是校验用的参考，不是交付代码。
3. **信了 DDS 的 `color`**：文字颜色经常缺失，全部变黑，红价橙状态全丢。
4. **引用了蓝湖 CDN 图片地址**：会过期，必须用 `assets/` 里的本地文件。
5. **跳过第 5 步**：产出和项目代码风格格格不入，评审直接打回。
6. **一次性生成整页巨型组件**：先按 outline 拆，再填内容。
7. **把 `&nbsp;` 当真文本**：DDS 的文案里有 HTML 实体，脚本已经解码过，别再手动转一次。

## 10. 两种运行方式（等价）

| | 纯 Skill | Skill + `dsh-lanhu-dds` 插件 |
|---|---|---|
| 怎么跑 | 用 bash 执行本目录 `scripts/lanhu-dds.mjs` | 直接调 `lanhu_dds_screens` / `lanhu_dds_build` / `lanhu_dds_doctor` 工具 |
| 产物 | 完全一致 | 完全一致 |
| Cookie | 自己 `export LANHU_COOKIE` 或传 `--cookie` | 插件按 环境变量 → `$DSH_HOME/.env` → 当前目录 `.env` → `~/.lanhu-cookie` 自动找 |
| 依赖 | Node ≥18 | 同左（插件本身零依赖） |

**只装 Skill 就能完成全部还原**，插件只是省掉「拼命令行 + 手动传 Cookie」这两步。
唯一必须用插件的场景：模型所在环境**不能执行 shell 命令**（没有 bash/node 工具），那时只能靠插件提供的原生工具。

## 11. 没有 python / 没有浏览器也能跑

脚本零依赖，纯 Node（≥18）。**不需要** Python、不需要 Playwright、不需要 pip 装任何东西。
`lanhu-dds.mjs` 自带 PNG 裁剪，参考图裁切也能在纯 Node 里完成。

若环境里装了 lanhu-mcp，可以用它的视觉工具做二次确认（`lanhu_inspect_design_region` 看局部特写），
但**不要**用它的 `dds_layout_suggestions` 代替本流程的 DDS 树——那份是被拍平成扁平 CSS 的，丢了包装节点和层级。
