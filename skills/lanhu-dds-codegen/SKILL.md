---
name: lanhu-dds-codegen
description: 用蓝湖「转代码」(DDS) 把设计图还原成前端代码。当任务要求照蓝湖设计稿写页面/组件、做 UI 1:1 还原、把 Figma/蓝湖稿子变成代码，或需要用 lanhu-mcp / DDS 做像素级复刻时使用。
whenToUse: 用户给出蓝湖设计图链接要求实现页面或组件；用户要求高保真/像素级还原；用户要求把设计稿转成 React/Vue/小程序代码；已有页面与设计稿不一致需要定位差异。
---

# 蓝湖 DDS 代码还原

DDS（转代码）是蓝湖提供的结构化布局树。编译器已将它加工成**屏内相对坐标 `(0,0)` + 父相位移 + 兄弟间距 + 完整样式 + 切图像素宽高 + 组合小图标预裁资产 + 文案**的单屏紧凑规格表 `screen-N.spec.md` 与单屏裁图 `screen-N.png`。

## 0. 执行铁律（开工契约确认 + 一页一闭环）

```
① doctor 检查项目规范与 UI/图标库
   ↓
② screens 列出画布全部屏 + 快速确认项目内对应页面文件列表
   ↓
③ 固定弹 1 次 ask_user_question 确认「整体重构 vs 局部优化」与「本次屏→路由页面映射清单」（严禁跳过）
   ↓
④ build 一次性编译已确认的屏
   ↓
⑤ 逐页增量闭环（每次只处理 1 个路由页面及其状态变体屏）：
   读本页 screen-N.spec.md + screen-N.png (+ variants-diff.md) + 本页既有源码
   → 按所选模式（重构整页 write / 优化局部 edit）落盘本页代码
   → 过本页静态门禁 → 再进入下一页
```

1. **多页任务必须一页一闭环**：当任务涉及多个页面（如同时改首页、列表、详情、确认页）时，**严禁**先把所有页面的旧源码和所有屏的裁图/产物一次性全读进上下文再去构思全局！一次只处理当前这 1 个路由页面（含该页面的弹窗/空态变体屏），把当前页真正落盘并过完静态校验后，再处理下一页（不设单页内的只读步数硬上限，但未写完当前页前不预读下一页）。
2. **直接消费 `screen-N.spec.md`，严禁自写解析或图像脚本**：`screen-N.spec.md` 已算好屏内 `(0,0)` 坐标、父偏移 `rel(dx,dy)`、兄弟间距 `↑gap`/`←gap`、样式、切图真实像素尺寸 `(pxW×pxHpx)` 及组合碎片小图标预裁图 `composite-icon:...`。**严禁**在思考中手算画布绝对坐标减法，**严禁**手写 `dump-ir.cjs`、`rects-rel.cjs`、`System.Drawing` 裁图/量宽高/像素采样对比脚本或 `Get-FileHash` 新旧图比对脚本。
3. **压缩上下文的时机**：只在**某一页代码已落盘并通过静态检查之后**，才把该页已消费的规格表/截图记录压缩掉；**严禁**在当前页尚未落盘前压缩刚读完的规格表与源码导致失忆重读。

## 1. 准备：Cookie 固定存一处

Cookie 唯一存放路径：**`~/.dsh-lanhu-dds/cookie`**（可用 `DSH_LANHU_DDS_HOME` 改根目录，权限 0600）。不读环境变量、不读 `.env`、不读配置。

1. **文件存在 → 自动复用**，无需询问用户。
2. **文件不存在 → 工具返回 `missing-cookie`**：把返回里的 `say` + `howToGet` 转述给用户（可用 `ask_user_question`）并停下等待。不要伪造、不要盲写页面。
3. **用户贴回 Cookie → 先验证再落盘**：传给 `lanhu_dds_screens` 或 `lanhu_dds_build` 的 `cookie` 参数（CLI 为 `--cookie "<值>"`），工具真读一次设计图验证通过后自动写入 `~/.dsh-lanhu-dds/cookie`；若返回 `cookie-expired` 则提示用户更换有效 Cookie，工具不落盘坏值。

获取方式：浏览器登录蓝湖 → F12 → Network → 任一 `lanhuapp.com` 请求 → 复制完整 `Cookie` 请求头。
**安全红线**：严禁把 Cookie 写进业务代码、提交仓库或在回复正文回显明文。清除旧值用 `lanhu_dds_doctor({ forget: true })`。

## 2. 查项目规范与 UI/图标库（先跑 doctor）

> 环境里有 `lanhu_dds_doctor` / `lanhu_dds_screens` / `lanhu_dds_build` 工具（已装 `dsh-lanhu-dds` 插件）时直接调工具（`lanhu_dds_doctor` 自动定位当前会话工作目录，无需手传 `project`）；纯 Skill 环境跑 `node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs <子命令>`。

1. 调 `lanhu_dds_doctor({})`（CLI：`doctor`），一次性拿到：
   - **输出单位 `--unit`**：自动读取 `config` 的 `designWidth`（750 → `design`；375 → `css`）或 `postcss` 的 `rootValue`/`viewportWidth`。
   - **项目主规范来源**：
     - 若项目根已有完备的 **`AGENTS.md` / `CLAUDE.md`**，`doctor` 直接认它为最高准则（`rules.delegatedTo: "AGENTS.md"`），**不要**再跑 `init` 生成空白 `project-rules.md`。
     - 若项目既无 `AGENTS.md` 也无 `.agents/skills/lanhu-dds-codegen/project-rules.md`，才跑 `lanhu_dds_doctor({ init: true, ui: true })` 生成模板并结合仓库现状补齐。
   - **内网 UI 组件库与图标库（`uiPackages` / `iconPackages`）**：
     - 若 `ui.present === false`，调 `lanhu_dds_doctor({ ui: true })` 自动扫描内网 UI 组件包（解析组件与 props）和图标包（全量导出单图标名清单），生成 `.agents/skills/lanhu-dds-codegen/ui-library.md`。
     - **直接查 `ui-library.md` 选组件和图标名**（图标包已列出全部可用单图标名，无需再进 `node_modules` 手翻 `.d.ts`）；仅当个别复杂组件的深层插槽/事件在表中未体现时，才按表中的「依据」路径定点 `read` 对应 `.d.ts` 一眼。
     - 若扫描后 `ui.usable === false`，按 `ui.askUser` 向用户索取组件清单或用法示例，**严禁盲猜组件名与 props**。
2. 开工前读一遍项目主规范（`AGENTS.md` 或 `project-rules.md`）、`ui-library.md`、全局主题变量（如 `src/styles/theme.css`）及当前业务模块共享入口（如 `shared.ts`、路由定义）。**禁止**把模板文件里的占位示例抄进业务代码。

## 3. 选屏、开工契约确认（每次必问）与编译

### 3.1 选屏

调 `lanhu_dds_screens({ url })`（CLI：`build --url "<链接>" --list`），查看每屏 `index / width×height / nodes / raster / title / texts`（`raster: true` 代表整张位图无图层结构，需明确告知用户无法由 DDS 结构化还原）。同时用 `glob` 看一眼目标业务目录下的既有路由页面文件。

### 3.2 开工契约确认（每次必问，禁止跳过）

**无论用户提示词中是否已经写了「重构」或「优化」**，拿到屏清单后、调 `build` 出码前，**固定调用 1 次 `ask_user_question`** 向用户同时拍板以下两项（把你根据提示词预判的推荐项放在第 1 个并标 `(Recommended)`）：

1. **任务类型（整体重构 vs 局部优化）**：
   - **整体重构（Rewrite）**：推翻目标页面的旧 DOM 结构与旧 CSS，以蓝湖设计稿为唯一视觉基准整文件重写；只保留路由/接口/Store 业务契约。
   - **局部优化（Patch）**：保留目标页面既有 DOM 骨架与样式体系，仅针对设计稿变更区块做定点修改。
2. **本次纳入的「屏序号 → 页面文件」范围映射**：
   - 明确列出准备处理的 `screen-N → 页面路径`（含合并在同一页实现的状态/弹层变体屏）；
   - **画布中多出的未点名业务屏默认不改**（在问题/选项中点名询问是否一并纳入，严禁不打招呼擅自扩改未点名页面）；
   - **涉及 `src/components/` 等跨模块全局公共组件的屏**（如全站共用的交易密码弹窗、安全键盘）：默认**只保留调用、不改全局公共组件源码**；若确需修改全局公共组件，必须在此次提问中单列征得用户同意。

### 3.3 编译与产物消费优先级

用户确认后，一次性调 `lanhu_dds_build({ url, screens: "0,1,..." })` 编译已拍板的屏（同一会话内若后续补编某几屏，工具会**非破坏性增量合并**，不会删掉同目录已生成的其他屏与 `reference.png`；无需反复重编）。产物位于 `~/.dsh-lanhu-dds/sessions/<会话>/`，**严禁拷入项目目录**：

| 优先级 | 文件 | 作用与正确读法 |
|---|---|---|
| **1（主输入）** | **`screen-N.spec.md`** | **单屏紧凑规格表（几 KB）**：含组件候选、缩进层级、屏内 `(0,0)` 坐标 `@(x,y w×h)`、父偏移 `rel(dx,dy)`/`=parent`、前兄弟间距 `↑gap`/`←gap`、flex 布局、颜色/字号/行高/圆角/边框/阴影、本地切图路径与真实像素尺寸 `(pxW×pxHpx)`、组合碎片图标预裁图 `composite-icon:...` 与文案。**写某屏前直接 `read` 它，无需读 `ir.json`。** |
| **1（主输入）** | **`screen-N.png`** | 该屏设计稿裁图（视觉唯一真相）：核对整体视觉、图标语义、`c:MISSING` 文本真实颜色与层次细节。 |
| **2（多屏必读）** | **`variants-diff.md`** | 自动配对「同页面的不同状态/弹层变体」（如详情页 ↔ 规格弹窗、无地址 ↔ 有地址），直接列出差异块。 |
| **2（总览）** | **`report.md` / `tokens.css`** | 全部已编译屏的汇总体检报告、切图落盘统计与高频色值/字体候选。 |
| **资源** | **`assets/` + `manifest.json`** | 已本地化的切图（含像素宽高）与编译器预裁的 `composite-sN-box-M.png`；业务所需图片语义化重命名后拷入项目静态资源目录，**严禁在代码里直接引用蓝湖线上 URL**。 |

### 3.4 内网切图域名替换规则（`lanhu-oss-*` → `alipic.lanhuapp.com`）

内网通常放行 `lanhuapp.com`、`dds.lanhuapp.com` 与 `alipic.lanhuapp.com`，拦截 `lanhu-oss-*.lanhuapp.com`（TLS `SEC_E_WRONG_PRINCIPAL` 或 HTTP 403）。

- **编译器已内置三级自动回退**：① 直连 `lanhu-oss-*`（单域失败立即熔断）→ ② **自动替换为 `https://alipic.lanhuapp.com/<同名路径>` 并带蓝湖 `Cookie` + `Referer: https://lanhuapp.com/` 拉取逐字节一致的真切图** → ③ 无文字遮挡时从 `reference.png` 裁切兜底，有文字叠加则剥除死链标 `img:PLACEHOLDER(...)`（直接用 CSS 渐变/底色实现）。
- **禁止排障死循环**：切勿跑 `curl` / `Invoke-WebRequest` / `rejectUnauthorized: false` 探测 `lanhu-oss-*`；如确需手工补拉，只用 `https://alipic.lanhuapp.com/<文件路径>` + `~/.dsh-lanhu-dds/cookie` + `Referer: https://lanhuapp.com/`。

**项目写入边界**：

| 应写入项目（正常接入件与交付物） | 严禁写入项目（中间污染） |
|---|---|
| 业务页面/子组件源码、拷入项目静态目录的正式图片 | `design/dds/`、`.lanhu-dds/`、`screen-*.json`、`screen-*.spec.md` |
| `.agents/skills/lanhu-dds-codegen/ui-library.md`（及无 `AGENTS.md` 时的 `project-rules.md`） | `.agents/tmp/`、`dump-ir.*`、`rects-rel.*`、`crop.ps1` 等任何临时文件（确需临时文件只放 `build` 返回的 `tmpDir`） |

## 4. 「整体重构」vs「局部优化」执行硬边界（防死磕旧代码铁律）

确认任务模式后，严格按对应列执行，**严禁混用**：

| 维度 | 整体重构（Rewrite） | 局部优化（Patch） |
|---|---|---|
| **写文件方式** | **一律用 `write` 整文件重写页面模板与样式**。严禁在几十 KB 旧文件上连打一二十次 `edit` 局部缝补。 | **用 `edit` 定点修改目标区块与对应样式**，严禁重写无关区块。 |
| **旧页面源码怎么用** | **只读 1 遍提取「业务契约五件套」后立即脱离旧 DOM/旧 CSS**：① 路由入参与跳转调用；② Store / 接口取数与字段名、格式化函数；③ 页面级导航栏/生命周期 Hook；④ 提交校验与弹层状态联动；⑤ 公共组件调用点。**旧 `<template>` 层级、旧 class 名、旧纯视觉子组件全部丢弃，严禁逐节点比对旧代码！** | 以旧页面 DOM 结构、class 命名与组件拆分为基准，仅对齐 `spec.md` 中变更节点的尺寸、颜色与文案。 |
| **设计稿未画出的旧业务元素**（如旧功能开关、合规提示条） | **严禁自行在代码里先删后加反复摇摆！** 读旧源码摘契约时若发现设计稿未体现的业务开关/合规提示条，用 `ask_user_question` 向用户确认去留（纯演示性质的假文案如借贷协议标题替换为当前业务真实协议名即可）。 | 默认保留既有页面上的其他业务开关与合规提示，仅改动用户指定的优化点。 |
| **静态图片与小图标** | 直接采用 `assets/` 新切图（或保留动态接口字段 `item.imgUrl`，静态默认图用新切图），**严禁算 hash 或写像素采样脚本去跟项目旧静态图做逐像素对比**。 | 未涉及改动的既有静态图片与图标保持原样不动。 |
| **跨模块全局公共组件**（如 `src/components/`） | **只保留调用与传参契约，严禁越界修改全局公共组件源码**（防破坏全站其他调用方）；设计稿与全局组件的视觉差异记入交付说明或询问用户。 | 同左，未获用户明确授权严禁修改全局公共组件。 |

## 5. 出码规范

### 5.1 冲突裁决优先级

1. **项目既有规范（`AGENTS.md` / `project-rules.md` / 同模块 `shared.ts`）** 决定技术栈、组件引入路径、路由方式、主题变量名。
2. **`screen-N.png`（设计稿裁图）** 决定视觉真值：`spec.md` 标 `c:MISSING(看裁图)` 的文字颜色、图标长相与层次细节一律看裁图。
3. **`screen-N.spec.md` 的几何与样式数值** 决定尺寸、间距、`linear-gradient`、`boxShadow`、圆角（默认 `unit=design` 即 750 设计稿 px，直接写进样式交给构建期 `pxtransform` / `postcss-px-to-rem` 换算，**不要手动除以 2**）。

### 5.2 组件复用与流式布局

- **内网 UI 库优先，不手搓已有组件**：先查 `ui-library.md` 与模块 `shared.ts`。导航栏、卡片、按钮、标签、单元格、底部动作面板、步进器、空态优先用现成组件；默认样式与设计稿差 2–4px 属组件库正常刻度，用组件 props、CSS 变量或局部 `:deep()` 微调，禁止全局 `!important` 或改 `node_modules`。
- **同构重复块必抽子组件或 `v-for`**：`spec.md` 顶部「组件候选」列出的同父同宽重复块不复制粘贴 N 份模板。
- **同路由多状态合页**：`variants-diff.md` 配对的状态屏（详情页 + 规格弹层、无地址 + 有地址）合在同一页面组件体系内用响应式状态切换，完整保留原接口调用与路由交互。
- **语义流式布局**：按 `spec.md` 的 `col`/`row`、`pad:`、`↑gap`/`←gap` 用 Flex/Grid 写文档流；`=parent` 代表与父同框的包装层，合并冗余嵌套；**禁止**照搬 `screen-N.html` 的全屏 `position: absolute`。

### 5.3 图标与组合碎片图标处理（零手工裁图）

1. **优先换项目图标库**：直接从 `ui-library.md` 的「全部可用单图标名」列表中选语义匹配的图标组件。
2. **定制图标 / 组合碎片图标**：
   - 若 Figma 中一个小图标由「CSS 边框节点 + 半截切图」拼成，编译器已自动从整张原图预裁出完整图标写入 `assets/composite-sN-box-M.png` 并在 `spec.md` 标注 `composite-icon:...`——若图标库无替代项，直接拷入该预裁文件或 `assets/` 中的完整切图即可。
   - 若仍无合适切图，写带精确宽高的语义占位块（保留 `aria-label` 或 `aria-hidden="true"`，不留 404 链接）并在交付说明列出待办。
   - **红线**：**严禁**为了一个小图标手写 PowerShell `System.Drawing` / Python / Canvas 脚本去裁切或缩放 `reference.png`。

## 6. 分级验收与交付清单

### 6.1 默认必过门禁（静态校验，不强制起本地服务）

内网 H5 项目常依赖网关代理、登录态或商户配置才能在浏览器打开路由。**默认采用静态门禁，禁止因本地起不来服务而卡住**：

1. **项目静态检查**：运行项目 `package.json` / `AGENTS.md` 规定的检查命令（如 `eslint`、`vue-tsc` / `tsc --noEmit`、`prettier --check`；项目声明无测试框架时不跑不存在的 `npm test`）。
2. **契约与污染自检**：确认 ① 核心文案、价格/状态色值（尤其 `c:MISSING` 项）、渐变圆角已还原；② 原页面路由参数、Store/接口绑定与事件处理未丢失；③ 跑一次 `lanhu_dds_doctor` 确认 `strays` 为空。

### 6.2 浏览器 DOM 几何校验（仅当页面已在本地可访问或用户明确要求时）

若页面可在本地直接打开且用户要求 DOM 复核，可在页面根元素加 `data-check-root` 并在控制台对比 `screen-N.rects.json`（`const K = 750 / document.documentElement.clientWidth`，差值 ≤ 3 设计 px 视为通过）。

### 6.3 交付汇总清单

全部目标页面完成后，输出：
- **改了什么**：本次确认的任务模式（重构 / 优化）、逐页对应屏号（`screen-N`）、复用的内网组件、保留的业务契约与用户拍板的差异项。
- **怎么验证**：实际跑过的静态检查/构建命令与结果。
- **未验证项或残留风险**：图标占位待办、未纳入屏或未改动的全局公共组件说明（无则写「无」）。

## 7. 两种运行方式与零依赖说明

| 维度 | 纯 Skill（CLI） | Skill + `dsh-lanhu-dds` 插件 |
|---|---|---|
| 调用方式 | `node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs ...` | 直接调 `lanhu_dds_doctor` / `lanhu_dds_screens` / `lanhu_dds_build` |
| Cookie 与产物 | `~/.dsh-lanhu-dds/cookie`；`~/.dsh-lanhu-dds/sessions/<会话>/` | 完全相同 |
| 运行环境 | 纯 Node ≥ 18（内置 PNG 裁剪、像素尺寸解析与 `alipic` 镜像回退，无需 Python / Playwright / lanhu-mcp） | 完全相同 |
