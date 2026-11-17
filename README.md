# dsh-lanhu-dds

[![npm](https://img.shields.io/npm/v/dsh-lanhu-dds.svg)](https://www.npmjs.com/package/dsh-lanhu-dds)
[![license](https://img.shields.io/npm/l/dsh-lanhu-dds.svg)](LICENSE)

把蓝湖「转代码」(DDS) 接进 DeepSeek Harness：设计图 → 可写代码的产物 → 还原 Skill。

**零依赖**。不需要 lanhu-mcp、不需要 Python、不需要 Playwright、不需要 pip 装 wheel。装一个插件就完事。

## 它做什么

装好后模型获得三个工具和一个 Skill：

| 能力 | 名字 | 作用 |
|---|---|---|
| 工具 | `lanhu_dds_screens` | 列出设计图里的所有手机屏（一张图常横排 5~10 屏）：每屏的导航标题、是否弹层、去壳后的全部业务文案，以及「哪几屏是同一个页面」的分组。不落盘、不下载，够用来向用户确认范围 |
| 工具 | `lanhu_dds_build` | 按用户确认的 `plan`（模式 + 页面文件 → 屏号 + 旧功能去留，必填）编译：产出单文件紧凑规格表 `screen-N.spec.md`（顶部带拍板契约与切图清单）、设计稿裁图 `screen-N.png`、同页多屏差异 `variants-diff.md`（独有区块 + 同一元素的属性差）、汇总体检报告 `report.md`，并内置 `lanhu-oss-* → alipic.lanhuapp.com` 内网切图镜像回退。返回值 `work` 按页面文件分组，顺序即出码顺序 |
| 工具 | `lanhu_dds_doctor` | 项目接入自检：自动取当前会话工作目录、读出 `unit`、识别既有 `AGENTS.md`、区分内网 UI 库/图标库与工具包，支持一键生成 `ui-library.md`（兼容 Windows 路径、`DefineComponent<ExtractPropTypes<...>>` 与全量图标导出名列表）；传 `component` 返回组件卡片（prop 默认值、事件、插槽与类名出现顺序、样式规则体；定位不到实现的组件退到类型声明出卡）；本会话编译过之后，无参调用会附带 `closeout`（拍板契约清单，供收尾逐项确认；一个会话编译过多张画布时按画布分组返回 `canvasCount`/`canvases`） |
| Skill | `lanhu-dds-codegen` | 选屏 → 一次拍板 → 按 plan 编译 → 按 `work` 逐个文件还原 → 按 `closeout` 确认后交付的流程 |

## 接入（内网装完之后的第一件事）

```js
// 1. 直接自检（自动定位当前会话工作目录，无需手传 project）
lanhu_dds_doctor({})

// 2. 自动扫描内网 UI 组件库与图标库 → .agents/skills/lanhu-dds-codegen/ui-library.md
//    （若项目没有 AGENTS.md，可同时传 init: true 生成 project-rules.md 模板）
lanhu_dds_doctor({ ui: true })
```

`doctor` 自动处理三件事：

- **`unit`**：读 `config.ts` 的 `designWidth`（750 → `design`，375 → `css`）或 postcss 的 `rootValue`/`viewportWidth`。`design` 下 `build` 还会按 `designWidth` 归一：首屏实测 1404px 宽的 4x 图除以 1.872 折成 750 基准（除数是首屏原始宽，不是整张画布的宽；切图尺寸按原样给出，不跟着归一）。
- **`agentDocs` 与 `rules`**：若项目根已有完备的 `AGENTS.md` / `CLAUDE.md`，直接认作主规范来源，不再强制生成空白 `project-rules.md` 避免冲突。
- **`uiPackages` / `iconPackages`**：自动排除 `@xxx/func`、`@xxx/rrweb-sdk` 等工具包，递归跟进多级 `export * from` 与深层组件 `.d.ts`（兼容 `DefineComponent<ExtractPropTypes<{...}>>`、`DefineComponent<XxxProps>`、`interface *Props` 及 Windows 反斜杠路径），并为图标包输出全部单图标导出名清单到 `ui-library.md`。

## 安装

### 方式 A：本地目录（开发/试装）

```bash
# 在 DSH 里让 agent 调用 plugin_manager
plugin_manager({ action: "install_bundle", target: "<本目录绝对路径>" })
```

新装的 bundle 能通过 HMR 直接生效；**替换已安装的同一包需要重启 DSH**。

### 方式 B：npm

```js
plugin_manager({ action: "install_bundle", target: "dsh-lanhu-dds" })
```

内网走私域源：先在私域源发布同一份包（`npm publish --registry <私域源>`），再在 profile 的 `cordis.patch.yml` 里指定源：

```yaml
- id: dsh-plugin-manager
  config:
    registry: https://<私域源>/
```

注意：**配置进 `registry` 的私有源不会被公共源兜底**，内网只用私域源是安全的。

### 方式 C：完全离线

把整个目录压成 zip 拷进内网，解压后用方式 A 装。安装时 pnpm 不会去拉任何依赖（`dependencies` 是空的），所以内网断网也能装。

## Cookie：一个文件，验证过才写

存在固定位置：**`~/.dsh-lanhu-dds/cookie`**（`DSH_LANHU_DDS_HOME` 可改根目录，权限 0600）。工具每次读它，不读环境变量、不读 `.env`、不读配置——只有一个位置，有没有、失没失效，看这个文件就知道。

```bash
# 第一次：工具说 missing-cookie，把 say 转给用户
# 用户贴来 Cookie → 工具先真读一次设计图验证：
#   通过 → 写入 ~/.dsh-lanhu-dds/cookie，返回 cookieSavedTo，以后所有会话直接复用
#   不通过 → 返回 cookie-expired，不落盘

# 换号/排查：
lanhu_dds_doctor({ forget: true })
```

产出的载荷：

```json
{
  "ok": false,
  "error": "missing-cookie",
  "cookieFile": "/Users/you/.dsh-lanhu-dds/cookie",
  "askUser": "停在这里向用户要 Cookie。不要猜、不要伪造、不要绕过它去凭想象编页面结构和样式。",
  "say": "这次还原需要蓝湖登录态：给我一份蓝湖网页的 Cookie（F12 里那个整行 Cookie）。",
  "howToGet": "浏览器登录蓝湖 → F12 → Network → 任一 lanhuapp.com 请求 → 复制完整 Cookie 请求头",
  "howToGive": ["直接在对话里贴给我，我验证通过后会存到 ~/.dsh-lanhu-dds/cookie（0600），以后所有会话都不必再贴"],
  "whatHappensNext": "收到后我先用一个真实设计图验证能不能读，通过就存到 …（0600），以后所有会话都不用再贴；不通过我会告诉你，绝不存坏值。",
  "afterFill": "以后只要这个文件还在就直接用；换号或过期时重贴一次，自动覆盖。",
  "security": "只存本机 0600 权限的文件，不回显、不写入任何日志或产物"
}
```

## 中间产物放哪

按会话隔离，全部在 **`~/.dsh-lanhu-dds/`**（`DSH_LANHU_DDS_HOME` 可改根），不进项目：

```
~/.dsh-lanhu-dds/
├── cookie                          # 蓝湖登录态（0600，验证通过才写），跨会话共用
└── sessions/
    └── <会话标识>/                  # 当前 DSH 会话 id 去掉 session- 前缀、剔掉非字母数字后取前 12 位
        ├── tmp/                    # 本次会话的临时脚本
        └── 我的订单-4a3b8460/       # 本次会话的产物（始终与该画布的 plan 一致；DDS 与切图有缓存，传 clean:true 才重新拉取）
```

两次对话互相看不到对方的产物，也不会在根目录堆成一坨。想跨会话复用同一份产物才传 `session`；一旦自己指定过 `session`，收尾时 `lanhu_dds_doctor({ session: "<同一个值>" })` 也要传同一个值，否则读不回该会话的 `plans.json`。

两个清理动作都有副作用，别在排查到一半时顺手用：

- `lanhu_dds_doctor({ prune: true, days: 7 })` 删的是**整个会话目录**（`tmp/` 里的临时脚本一起删），只保留 `cookie`。
- `lanhu_dds_doctor({ forget: true })` 删的是**全机器共用的 `cookie`**，下一个会话会回到 `missing-cookie`。多个会话并行时不要用它「测试一下」。

`out` 只接受一层目录名（带斜杠或 `..` 直接拒绝）。产物不在项目里，**不需要 gitignore**。

项目里只该多出两个文件，都该提交：

| 文件 | 是什么 |
|---|---|
| `.agents/skills/lanhu-dds-codegen/project-rules.md` | 项目规范（技术栈 / 目录 / token / 字体 / 数据层） |
| `.agents/skills/lanhu-dds-codegen/ui-library.md` | 内网 UI 组件清单（`lanhu_dds_doctor({ ui: true })` 生成，库升级重跑） |

其余的 `.agents/tmp/`、`dump-*.mjs`、`probe-*.mjs` 以及落回项目的 `screen-N.ir.json` / `screen-N.rects.json` / `screen-N.spec.md` 都是污染，`lanhu_dds_doctor` 会扫出来报 `strays`。它认的模式是 `screen-N.ir.json` / `screen-N.rects.json` / `screen-N.spec.md` 这类产物名，外加 `tmp/`、`scratch/`、`.lanhu-dds/`、`design/dds/` 这几个目录；其它裸文件不报。

每屏与汇总产物：

| 文件 | 作用 |
|---|---|
| `screen-N.spec.md` | **主输入**：单文件紧凑规格表（拍板契约 + 切图与小图标清单（小图标标出单色色值或多色） + 组件候选 + 屏内 `(0,0)` 坐标 + 父相位移 + 兄弟间距 + 完整样式 + 文案 + 切图真实像素尺寸 + 组合碎片图标预裁图） |
| `screen-N.png` | 设计稿裁图（视觉唯一真相） |
| `variants-diff.md` | 自动识别同页面的状态/弹层变体：各自独有的区块，加上同一元素在两屏里不同的字号、间距、颜色、底色、尺寸、文案（含同位置换文案、同文案换位置的元素） |
| `tokens.css` / `report.md` | 颜色/字体 token 与体检报告（顶部是拍板契约） |
| `assets/` | 本地切图 + `manifest.json`（内置 `lanhu-oss-*` → `alipic.lanhuapp.com` 带 Cookie+Referer 内网镜像回退 + 原图无遮挡裁切） |
| `screen-N.ir.json` / `screen-N.rects.json` / `screen-N.html` | 原始树结构（屏内相对坐标）、几何表与参考 HTML（备查） |
| `screen-N.outline.md` | 单屏结构大纲（比 `ir.json` 短的备查视图） |

## 为什么不用 lanhu-mcp

| | lanhu-mcp | 本插件 |
|---|---|---|
| 依赖 | Python 3.10–3.13 + 76 个 wheel + Playwright chromium（离线包 563MB） | 无，纯 Node |
| DDS 数据 | `dds_layout_suggestions` 是**拍平**的 CSS 列表，合成包装节点全丢，拿不到层级 | 原始 DDS 树，完整层级 |
| 参考图 | 需要浏览器渲染 | 纯 Node 解码 + 裁剪 |
| 切图 | 落盘到 MCP 自己的缓存目录 | 直接进项目 `assets/` |
| 协议开销 | MCP 进程 + schema 常驻 | 原生工具 |

lanhu-mcp 的视觉工具（`lanhu_inspect_design_region` 等）在需要局部特写时仍然有用，两者不冲突；但**DDS 还原走本插件**，因为层级信息只有原始树里有。

## 已知边界

- **不生成框架代码**。它产出的是「结构 + 几何 + 文案 + 颜色」这些不会错的事实，怎么写代码由模型的 Skill 流程决定（读项目规范后写）。
- **DDS 给得到的东西就会给到底**：颜色、字号/字重/行高、圆角、边框、背景色、box-shadow（`style.boxShadow`，有就输出、px 已按设计比归一；没有命中说明设计稿确实没用投影）、线性渐变（角度+色标完整）、渐变文字（`WebkitBackgroundClip`+`WebkitTextFillColor`）。这些不需要模型猜。
- **DDS 给不到的**：交互态（hover/active/禁用）、响应式约束、图标矢量（切图是位图）、以及设计稿里靠图层叠加出来的效果。`report.md` 逐条列出缺口，由模型对着裁图补。
- **整图导入的屏无法还原**：`screens` 返回 `raster: true` 时说明这屏在 DDS 里是一张图，没有结构，只能要源文件。
- **弹层与页面的边界是结构判断**：整屏只有弹层的帧标 `popup: true` 并挂到所属页面的 `popups`；但「页面 + 盖在上面的确认框」混在同一帧里的稿子按一个页面输出，弹层内容照常出现在树里，拆不拆成两个状态由模型读 `texts` 后向用户确认。
- **选屏靠两条可算的事实**：候选屏要内容铺满自身宽度（最宽的直接子节点 ≥ 自身 85%），或顶部 8% 内贴着状态栏时钟。展示板（灰底 + 标题牌 + 居中一台手机）两条都不成立，于是被跳过、认里面那台手机。过了这两道之后按「谁被谁包住」去重（等大的包装层只留外层；比机身更高的滚动内容只留机身），再按宽度取数量最多的那一批。两条事实都算不出来时不做这层过滤，画布上的注释文字会混进规格表。
- **整图屏与空框分开算**：只有一个子节点且那是图片 = 整图屏（`raster`，规格表说「无法结构化还原」）；只有空盒子 = 空框（`empty`，会被 `unplanned` 提示「要跟用户确认真要不要」）。两者都不该静默当成正常页面。
- **展示板有两种形态都认**：板内并列放着 ≥2 个几乎等宽的手机帧，或板比里面那台手机大一圈、手机上还有标题牌/图注这类帧外内容。后者是靠「帧外还有东西」判的，如果板上除了那台手机什么都没有，仍会被当成一屏。
- **已知选不准的一种稿子**：一个帧被单独塞进一层比它宽得多的行容器分组（只会选到其中一帧）。遇到这种，用 `screens` 的返回人工核对一遍再填 `plan`。

## 目录

```
index.js              # 入口：注册 3 个工具 + 1 个 skill
cordis.patch.yml      # 只插自己这一行
lib/
  util.mjs            # 取整、HTML 实体解码、Markdown/CSS 转义
  lanhu-api.mjs       # 蓝湖接口：链接解析、版本信息、DDS 树、二进制下载
  store.mjs           # Cookie 与按会话隔离的产物目录
  dds-tree.mjs        # 树遍历、几何读取、选屏
  compile.mjs         # 单屏编译：DDS 节点 → 屏内坐标 + CSS
  spec.mjs            # 紧凑规格表（壳层折叠、安全区、样式树）
  variants.mjs        # 屏间变体配对与差异表
  assets.mjs          # 切图三级回退落地
  render-html.mjs     # 参考 HTML 与 token
  report.mjs          # 体检报告
  build.mjs           # 高层入口：拉取 → 编译 → 落盘
  project.mjs         # 项目接入自检
  ui-library.mjs      # 内网 UI 库扫描与速查表
  component-card.mjs  # 组件卡片：默认值、插槽与类名顺序、样式规则体
  png.mjs             # 纯 Node PNG 解码/裁剪/编码
skills/               # 随包的 skill 与参考文档
```
