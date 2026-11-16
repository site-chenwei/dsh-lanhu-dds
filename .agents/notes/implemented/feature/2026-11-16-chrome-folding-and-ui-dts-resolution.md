# Agent Note: 折叠页面壳层、修复背景切图与桶文件组件签名提取

Status: implemented

## Problem

在 10 屏金融 H5 蓝湖 DDS 真实测试中，0.6.0 版编译器与工作流暴露出四类结构性损耗：

1. **页面壳层干扰与底栏安全区摇摆**：蓝湖画布每屏顶部均带手机状态栏与标准导航栏（如 `0..176px` 内的 `"9:41"`、信号与胶囊按钮），底部均带 `68px` 的 `HomeIndicator` 切图。原 `screen-N.spec.md` 原样展开全部壳层节点并下载壳层切图，导致 Agent 反复纠结是否手写顶栏、手算首块内容顶距，且在多页重构中因迁就旧页面缺漏而回退吸底栏安全区适配；共享壳层还把不同路由页的结构重合度抬过 `0.35`，造成 `variants-diff.md` 跨路由误配。
2. **`style.background` 简写切图与线性渐变漏提**：DDS 大量节点将图片 URL 写在 `props.style.background: url(...) 100% no-repeat`、将按钮与角标渐变写在 `props.style.backgroundImage: linear-gradient(...)`。原 `localizeAssets` 仅扫描 `backgroundImage` 的 `url(...)`，原 `specMarkdown` 仅读取 `background`/`backgroundColor` 且在遇到 `url(` 时隐藏背景，致使详情长图漏下、HTML 残留外链、按钮渐变丢失，迫使 Agent 手翻 HTML 并写脚本拉图量尺寸。
3. **桶文件 `.d.ts` 串台与单行超长截断**：`vue-tsc` 产出的内网组件库在桶文件 `atoms/index.d.ts` 中使用 `import X from './X.vue'; export { X }` 两段式重导出。原扫描器未剥离 `.vue` 后缀且在单组件 `.d.ts` 未匹配组件名时回退至同目录首个组件，导致全库 76 个组件全部串成 `XwActionSheet` 的 props，同时缺失 `__VLS_WithTemplateSlots` 插槽、`v-model` 事件与包内 CSS 变量，且 151 个图标名拼成单行超 2000 字符被 `read` 工具截断。
4. **二次拍板滞后与收尾空转**：原 `SKILL.md` 未强制在开工提问时合并确认「设计稿未画出的旧页面业务开关去留」，也未为纯视图层还原设立静态过检即停边界，导致先删后补整页返工与收尾长尾自检。

## Decision

编译器（`lib/lanhu-dds.mjs`）与技能规范（`skills/lanhu-dds-codegen/SKILL.md`）协同收紧壳层边界、资产提取与组件库元数据契约：

1. **默认忽略顶导壳层并强制底栏安全区适配**：新增 `detectScreenChrome`，识别贴顶状态栏/标准导航栏（折叠为 `# [顶部导航壳层 默认忽略]` 注释并向首块实际内容输出 `↑nav:<px>`）与贴底设备安全区指示条（折叠为 `# [底部安全区占位 ... 默认忽略切图]` 并跳过切图下载）。`SKILL.md` 将「默认忽略蓝湖顶部导航栏，仅关心实际内容区域与底栏安全区域高度适配（不因旧代码漏写而省掉或回退）」设为最高优视觉边界。
2. **统一提取 `background` / `backgroundImage` 切图与渐变**：新增 `extractCssUrl` 同时解析并重写 `css.background` 与 `css.backgroundImage` 中的远程图片 URL，对真实高度超容器 `1.35×` 且贴近屏底的切图追加画布截断长图提示；`specMarkdown` 补齐 `linear-gradient(...)` 输出、清洗 `rgba(..., 1.000000)` 浮点尾数与 alpha `< 0.001` 的全透明无效边框、折叠组合图标内部碎片并为小图标标注邻近短文本 `near:"..."`。
3. **去壳层同路由变体配对与精简构建返回**：`buildVariantsDiff` 先剥离顶底壳层节点，再仅对同导航标题的全屏页或同页底部弹层计算差异；`buildDesign` 返回值仅保留当前请求屏摘要，不再重复回传全画布 `screens` 列表。
4. **精确匹配组件独立 `.d.ts` 并补齐插槽、`v-model` 与 CSS 变量**：`resolveModuleTarget` 支持剥离 `.vue/.tsx/.jsx` 后缀映射到同目录 `.d.ts`，`collectBarrelExports` 支持 `import + export { ... }` 两段转发与包内组件名索引兜底，`fileMatchesComponent` 阻断跨组件兜底串台；新增 `extractSlotsFromText`、`extractVModelsFromText`、`collectPkgCssVars` 提取插槽、`v-model` 与 `--<prefix>-*` 变量；图标清单按每行 12 个折行，无独立 `.d.ts` 的透传重导出组件折叠为紧凑列表。
5. **前置一次性三合一拍板与过检即停硬闸**：`SKILL.md` 要求开工唯一一次 `ask_user_question` 同时拍板「重构/优化模式 + 屏到页面映射 + 旧页面独有业务开关去留」，单页静态检查通过即封板，全部目标页过检且 `strays` 为空后立即收尾，纯视图层还原默认不立 `.agents/notes/` 笔记。

## Artifacts and contracts

- `screen-N.spec.md` 顶导与底栏安全区标记格式固定为 `# [顶部导航壳层 默认忽略] @(x,y w×h) title:"..."` 与 `# [底部安全区占位 <h>px 默认忽略切图] @(x,y w×h)`；首块实际内容节点携带 `↑nav:<px>`。
- 含搜索框、多标签切换栏或高度超过 `0.32 × 屏宽` 的自定义复合页头不会被 `detectScreenChrome` 折叠，继续作为常规内容节点输出。
- `.agents/skills/lanhu-dds-codegen/ui-library.md` 单行长度控制在 500 字符以内；`readUiLibrary` 将折叠的透传组件计入总导出组件数，同时以具备独立类型签名的组件判定 `usable`。
- `skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs` 保持与 `lib/lanhu-dds.mjs` 逐字节同步。

## Alternatives considered

### 为什么不在 `compileScreen` 阶段直接从 IR 物理删除顶部导航栏与底部安全区节点？

若在编译阶段直接将壳层节点从 `boxes` / `ir` 中物理剔除，`screen-N.html` 参考渲染将缺失顶底区域，导致与同目录整屏裁图 `screen-N.png` 视觉高度不一致；万一遇到特殊沉浸式头需要人工核对，也会彻底丢失几何坐标。保留 `ir` 原貌、仅在 `localizeAssets` 跳过无用壳层切图并在 `specMarkdown` 折叠为带坐标与标题的单行注释，既省掉 10+ 行状态栏噪音与冗余网络请求，又保留了标题文本与 `↑nav` 精确间距。

### 为什么不用 TypeScript Compiler API 解析组件库 `.d.ts`？

本插件定位为零外部依赖（`package.json` 无 `dependencies`），而目标宿主项目的 TypeScript 版本与包管理器各异。针对 `vue-tsc` / Rollup 产出的确定性声明模式（桶文件 `import + export`、组件专属 `.d.ts`、`DefineComponent<Props>` 与 `__VLS_WithTemplateSlots`），修正路径后缀剥离与单组件文件名守卫即可 100% 消除串台并提取顶层 props、插槽与 `v-model`，无需引入数兆字节的编译器运行时依赖。

## Consequences

- **收益**：消除 Agent 手扒 HTML 抓漏网背景长图、进 `node_modules` 跑十余次终端脚本查组件插槽/图标名、在顶导去留与底栏安全区上反复摇摆回退、以及先删业务开关再返工的整条失血链路；`ui-library.md` 不再被 DSH `read` 单行 2000 字符上限截断。
- **代价与边界**：`detectScreenChrome` 依赖状态栏时钟或导航命名及顶栏高度阈值（`<= 0.32 × 屏宽`）识别标准顶导；若设计稿顶导既无状态栏时间也无导航图层命名，则会退回普通节点展开，由 `SKILL.md` 的默认忽略顶导规则兜底。
