---
name: lanhu-dds-codegen
description: 用蓝湖「转代码」(DDS) 把设计图还原成前端代码。当任务要求照蓝湖设计稿写页面/组件、做 UI 1:1 还原、把 Figma/蓝湖稿子变成代码，或需要用 lanhu-mcp / DDS 做像素级复刻时使用。
whenToUse: 用户给出蓝湖设计图链接要求实现页面或组件；用户要求高保真/像素级还原；用户要求把设计稿转成 React/Vue/小程序代码；已有页面与设计稿不一致需要定位差异。
---

# 蓝湖 DDS 代码还原

DDS（转代码）是蓝湖提供的结构化布局树。编译器已将它加工成**屏内相对坐标 `(0,0)` + 父相位移 + 兄弟间距 + 完整样式 + 文案**的单屏紧凑规格表 `screen-N.spec.md` 与单屏裁图 `screen-N.png`。

## 0. 执行铁律（一页一闭环，禁止全量预读空转）

```
① doctor 检查项目规范与 UI 库 → ② screens 选屏 → ③ build 编译所需屏
   ↓
④ 逐页增量闭环（每次只处理 1 个路由页面及其状态变体屏）：
   读本页 screen-N.spec.md + screen-N.png (+ variants-diff.md) + 本页既有源码
   → 写完本页代码 → 跑本页静态门禁 → 再进入下一页
```

1. **多页任务必须一页一闭环**：当任务涉及多个页面（例如同时改首页、列表、详情、确认页）时，**严禁**先把所有页面的旧源码和所有屏的裁图/产物一次性全读进上下文再去构思全局！一次只读当前这 1 个页面的规格表、裁图与对应源码，把这一页真正 `write`/`edit` 落盘并过完静态校验后，再处理下一页（不限制单页内的必要核查，但未写完当前页前不预读下一页）。
2. **直接读 `screen-N.spec.md` 出码，禁止自写解析脚本**：`screen-N.spec.md` 已经算好屏内 `(0,0)` 坐标、父容器偏移 `rel(dx,dy)`、兄弟间距 `↑gap`/`←gap`、flex 属性、颜色字号圆角阴影与文案。**禁止**在思考过程里心算画布绝对坐标减法，**禁止**手写 `dump-ir.cjs`、`rects-rel.cjs`、PowerShell 裁图脚本去拆 `ir.json`。
3. **压缩上下文的时机**：只在**某一页代码已落盘并通过静态检查之后**，才把该页已消费的规格表/截图读取记录压缩掉；**严禁**在还没写任何代码前把刚读完的源文件压掉导致失忆重读。

## 1. 准备：Cookie 固定存一处

Cookie 唯一存放路径：**`~/.dsh-lanhu-dds/cookie`**（可用 `DSH_LANHU_DDS_HOME` 改根目录，权限 0600）。不读环境变量、不读 `.env`、不读配置。

1. **文件存在 → 自动复用**，无需询问用户。
2. **文件不存在 → 工具返回 `missing-cookie`**：把返回里的 `say` + `howToGet` 转述给用户（可用 `ask_user_question`）并停下等待。不要伪造、不要凭想象盲写页面。
3. **用户贴回 Cookie → 先验证再落盘**：传给 `lanhu_dds_screens` 或 `lanhu_dds_build` 的 `cookie` 参数（CLI 为 `--cookie "<值>"`），工具真读一次设计图验证通过后自动写入 `~/.dsh-lanhu-dds/cookie`，后续会话永久复用；若返回 `cookie-expired` 则提示用户换有效账号重取，工具绝不落盘坏值。

获取方式：浏览器登录蓝湖 → F12 → Network → 任一 `lanhuapp.com` 请求 → 复制完整 `Cookie` 请求头。
**安全红线**：Cookie 等同登录态，严禁写进业务代码、提交仓库或在回复正文回显明文。清除旧值用 `lanhu_dds_doctor({ forget: true })`。

## 2. 查项目规范与 UI 库（先跑 doctor）

> 环境里有 `lanhu_dds_doctor` / `lanhu_dds_screens` / `lanhu_dds_build` 工具（已装 `dsh-lanhu-dds` 插件）时直接调工具（`lanhu_dds_doctor` 会自动定位当前会话工作目录，无需手传 `project`）；纯 Skill 环境跑 `node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs <子命令>`。

1. 调 `lanhu_dds_doctor({})`（CLI：`doctor`），一次性拿到：
   - **输出单位 `--unit`**：自动读取 `config` 的 `designWidth`（750 → `design`；375 → `css`）或 `postcss` 的 `rootValue`/`viewportWidth`。
   - **项目主规范来源**：
     - 若项目根已有完备的 **`AGENTS.md` / `CLAUDE.md`**，`doctor` 直接认它为最高准则（`rules.delegatedTo: "AGENTS.md"`），**不要**再跑 `init` 生成空白 `project-rules.md` 制造冲突。
     - 若项目既无 `AGENTS.md` 也无 `.agents/skills/lanhu-dds-codegen/project-rules.md`，才跑 `lanhu_dds_doctor({ init: true, ui: true })` 生成模板并结合仓库现状补齐。
   - **内网 UI 组件库与图标库（`uiPackages` / `iconPackages`）**：
     - `doctor` 已自动排除 `@xxx/func`、`@xxx/rrweb-sdk` 等非 UI 工具包。
     - 若 `ui.present === false`，调 `lanhu_dds_doctor({ ui: true })` 自动递归扫描内网 UI 包与图标包，生成 `.agents/skills/lanhu-dds-codegen/ui-library.md`（支持同时传 `{ init: true, ui: true }`）。
     - 若扫描后 `ui.usable === false`，再按 `ui.askUser` 向用户索取组件清单或用法示例，**严禁凭包名盲猜组件名与 props**。
2. 开工写第 1 页前，读一遍项目主规范（`AGENTS.md` 或 `project-rules.md`）、`ui-library.md`、全局主题变量文件（如 `src/styles/theme.css`）及业务目录共享入口（如 `shared.ts`、路由 hook）。**禁止**把模板文件里的占位示例（如 `@company/ui` 或被项目禁用的路由 API）抄进业务代码。

## 3. 选屏与编译

### 3.1 选屏（必做）

调 `lanhu_dds_screens({ url })`（CLI：`build --url "<链接>" --list`）。一张蓝湖画布通常横排 5~10 台手机屏：

- 看每屏 `index / width×height / nodes / raster / title / texts`。
- `raster: true` 说明该屏在设计稿里只是一张合并位图，无图层结构——直接告知用户该屏无法由 DDS 结构化还原。
- 屏数较多且用户未指明具体屏时，把屏序号与业务页面对应关系列给用户确认一次（如 `0,1,3,4,7,8`），再调 `build`。

### 3.2 编译与产物消费优先级

调 `lanhu_dds_build({ url, screens: "0,1,..." })`（CLI：`build --url "<链接>" --screen 0,1`）。产物落在 `~/.dsh-lanhu-dds/sessions/<会话>/` 下，按会话自动隔离，**严禁拷入项目目录**：

| 优先级 | 文件 | 作用与正确读法 |
|---|---|---|
| **1（主输入）** | **`screen-N.spec.md`** | **单屏紧凑规格表（几 KB）**：含组件候选、缩进层级、屏内 `(0,0)` 坐标 `@(x,y w×h)`、父偏移 `rel(dx,dy)`/`=parent`、前兄弟间距 `↑gap`/`←gap`、flex 布局、颜色/字号/行高/圆角/边框/阴影、本地切图路径与文案。**写某屏前直接 `read` 它，无需读 `ir.json`。** |
| **1（主输入）** | **`screen-N.png`** | 该屏设计稿裁图（视觉唯一真相）：核对整体视觉、图标语义、`c:MISSING` 文本真实颜色与描边细节。 |
| **2（多屏必读）** | **`variants-diff.md`** | 当编译多屏时自动识别「同页面的不同状态/弹层变体」（如基础详情页 ↔ 规格弹窗、空地址 ↔ 有地址），直接列出两屏差异块，合在同一个页面组件里用状态/弹层实现。 |
| **2（总览）** | **`report.md` / `tokens.css`** | 全部已编译屏的汇总体检报告、切图落盘统计与高频色值/字体候选。 |
| 3（备查） | `screen-N.html` / `ir.json` / `rects.json` | 仅在个别极端节点需排查原始字段时才按需查看，常规还原不必读取。 |
| **资源** | **`assets/` + `manifest.json`** | 已本地化的切图，业务需要的图片拷入项目静态资源目录，**严禁在代码里直接引用蓝湖线上 URL**。 |

### 3.3 内网切图域名替换规则（`lanhu-oss-*` → `alipic.lanhuapp.com`）

内网环境通常放行 `lanhuapp.com`、`dds.lanhuapp.com` 与 `alipic.lanhuapp.com`，但会拦截 `lanhu-oss-*.lanhuapp.com`（表现为 TLS 证书报错 `SEC_E_WRONG_PRINCIPAL` 或 HTTP 403）。

- **标准解法**：把切图 URL 的域名 `https://lanhu-oss-<任意后缀>.lanhuapp.com/<文件路径>` 直接替换为 **`https://alipic.lanhuapp.com/<文件路径>`**，并携带蓝湖 `Cookie` 与 `Referer: https://lanhuapp.com/` 请求，即可拿到与原 CDN 逐字节一致的真切图。
- **编译器已内置三级自动回退**：
  1. 直连原 `lanhu-oss-*.lanhuapp.com`（某域名首次失败立即同域熔断，不逐张卡超时）；
  2. **自动改写为 `https://alipic.lanhuapp.com/<文件路径>`（带 Cookie + Referer）下载原始切图**；
  3. 若仍失败且该节点在画布上无文字叠加遮挡，自动从 `reference.png` 裁切兜底；若有文字叠加则剥除死链并在 `spec.md` 标为 `img:PLACEHOLDER(...)`（通常是渐变横幅底图，直接用 CSS 渐变 + 修饰块实现）。
- **严禁排障死循环**：编译器跑完后，`report.md` 与返回结果里的 `assets` 字段已是最终结果。若个别资源仍为 `PLACEHOLDER`，直接按 CSS/占位处理并在交付说明列出，**禁止**再去跑 `curl` / `Invoke-WebRequest` / `rejectUnauthorized: false` 反复探测 `lanhu-oss-*`。如确需手工补拉某张蓝湖图片，一律换用 `https://alipic.lanhuapp.com/<文件路径>` + `~/.dsh-lanhu-dds/cookie` + `Referer: https://lanhuapp.com/`。

**项目里该写什么 vs 污染红线**：

| 应写入项目（正常接入件与交付物） | 严禁写入项目（中间污染） |
|---|---|
| 业务页面/组件源码与拷入项目静态目录的正式图片 | `design/dds/`、`.lanhu-dds/`、`screen-*.json`、`screen-*.spec.md` |
| `.agents/skills/lanhu-dds-codegen/ui-library.md`（及无 `AGENTS.md` 时的 `project-rules.md`） | `.agents/tmp/`、`dump-ir.*`、`rects-rel.*`、`crop.ps1` 等任何临时脚本（确需临时文件只放 `build` 返回的 `tmpDir`） |

## 4. 冲突裁决优先级

1. **项目既有规范（`AGENTS.md` / `project-rules.md` / 同目录既有页面）** 决定技术栈、组件引入路径、路由方式、样式变量名。
2. **`screen-N.png`（设计稿裁图）** 决定视觉真值：`spec.md` 标 `c:MISSING(看裁图)` 的文字颜色、图标长相、细节层次一律看裁图。
3. **`screen-N.spec.md` 的几何与样式数值** 决定尺寸、间距、`linear-gradient`、`boxShadow`、圆角（默认 `unit=design` 即 750 设计稿 px，直接写进样式交给构建期 `pxtransform` / `postcss-px-to-rem` 换算，**不要手动除以 2**）。

## 5. 出码规范

### 5.1 组件复用与结构映射

- **内网 UI 库 / 共享组件优先，不重复造轮子**：先查 `ui-library.md` 与业务模块 `shared.ts`。导航栏、卡片、按钮、标签、单元格、弹层、空态、协议勾选等优先用现成组件；默认样式与设计稿差 2–4px 属组件库正常刻度，用组件 props、CSS 变量或局部 `:deep()` 微调，禁止全局 `!important` 或修改 `node_modules`。
- **同构重复块必抽组件**：`spec.md` 顶部「组件候选」列出的同父同宽重复块，抽成独立子组件或 `v-for` 渲染，不复制粘贴 N 份模板。
- **同路由多状态合页**：`variants-diff.md` 配对的状态屏（如详情页 + 购买规格 Popup、确认页无地址 + 有地址）写在同一个页面/组件体系内，通过状态切换还原，保留原页面的接口调用、Store、路由参数与业务逻辑不丢失。
- **语义流式布局**：按 `spec.md` 的 `col`/`row`、`pad:`、`↑gap`/`←gap` 用 Flex/Grid 写正常文档流；`=parent` 代表包装层与父同框，合并冗余层级避免双倍内边距；**禁止**照搬 `screen-N.html` 的全屏 `position: absolute`。
- **标签体系遵循目标平台**：Taro H5 / Vue Web 项目按项目既有页面使用标准 HTML 标签（`div/span/img/button`）与内网组件（除非项目自身规范要求小程序标签）。

### 5.2 图标与图片处理

- **图标优先换项目图标库，找不到的做语义占位**：
  1. 若项目装了图标库（见 `ui-library.md` 图标章节或既有页面），直接换对应语义图标组件。
  2. 图标库里没有的（如定制金条/营销徽章），若 `assets/` 已通过 `alipic` 拉下干净 PNG，可拷入项目静态目录使用；若是待替换小图标，也可写带精确宽高的语义占位块（保留 `aria-label` 或 `aria-hidden="true"`，不留 404 链接），并在最终交付说明列出待办。
- **业务内容图**：商品主图、规格缩略图使用 `assets/` 已落盘的本地图片或保留原页面动态接口字段 `item.imgUrl`（静态兜底图指向本地资源）；带文字叠加的横幅底图若为 `PLACEHOLDER`，直接用 `spec.md` 给出的渐变/底色实现。

## 6. 分级验收（适配内网网关项目）

### 6.1 默认必过门禁（静态校验，不强制起本地服务）

许多内网 H5 项目依赖网关代理、登录态或商户初始化配置才能在浏览器打开路由。**默认验收采用静态门禁，禁止因本地起不来页面而卡住或去写截图对比脚本**：

1. **项目自身静态检查**：运行项目 `package.json` / `AGENTS.md` 规定的检查命令（如 `eslint`、`vue-tsc` / `tsc --noEmit`、`prettier --check`；若项目声明无测试框架，不要跑不存在的 `npm test`）。
2. **规格表逐项自检**：对照 `screen-N.spec.md` 与旧页面源码，确认：① 核心文案、价格/状态色值（尤其 `c:MISSING` 项）、渐变与圆角未漏；② 原页面接口取数、路由跳转参数、事件处理未在重构中被误删；③ 无残留在项目里的临时文件（可跑一次 `lanhu_dds_doctor` 确认 `strays` 为空）。

### 6.2 浏览器 DOM 几何校验（仅当页面已在本地可访问或用户明确要求时）

若当前页面可在本地直接打开且用户要求像素级 DOM 复核，可在页面根元素加 `data-check-root` 并在浏览器控制台对比 `screen-N.rects.json`（`const K = 750 / document.documentElement.clientWidth`，差值 ≤ 3 设计 px 视为通过）。

### 6.3 交付汇总清单

全部目标页面完成后，清晰列出：
- **改了什么**：逐页对应哪几屏（`screen-N`）、复用了哪些内网组件、抽了哪些新子组件、保留了哪些原有业务交互。
- **怎么验证**：实际跑过的静态门禁命令与结果。
- **图标/资源待办与残留风险**：占位图标清单（位置 + 建议替换的图标名）、DDS 未覆盖的交互边界（如有）。

## 7. 两种运行方式与零依赖说明

| 维度 | 纯 Skill（CLI） | Skill + `dsh-lanhu-dds` 插件 |
|---|---|---|
| 调用方式 | `node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs ...` | 直接调 `lanhu_dds_doctor` / `lanhu_dds_screens` / `lanhu_dds_build` |
| Cookie 与产物 | `~/.dsh-lanhu-dds/cookie`；`~/.dsh-lanhu-dds/sessions/<会话>/` | 完全相同 |
| 运行环境 | 纯 Node ≥ 18（内置 PNG 裁剪与 `alipic` 镜像回退，无需 Python / Playwright / lanhu-mcp） | 完全相同 |
