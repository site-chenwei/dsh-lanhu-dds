# dsh-lanhu-dds

[![npm](https://img.shields.io/npm/v/dsh-lanhu-dds.svg)](https://www.npmjs.com/package/dsh-lanhu-dds)
[![license](https://img.shields.io/npm/l/dsh-lanhu-dds.svg)](LICENSE)

把蓝湖「转代码」(DDS) 接进 DeepSeek Harness：设计图 → 可写代码的产物 → 还原 Skill。

**零依赖**。不需要 lanhu-mcp、不需要 Python、不需要 Playwright、不需要 pip 装 wheel。装一个插件就完事。

## 它做什么

装好后模型获得三个工具和一个 Skill：

| 能力 | 名字 | 作用 |
|---|---|---|
| 工具 | `lanhu_dds_screens` | 列出设计图里的所有手机屏（一张图常横排 5~10 屏），含尺寸/节点数/是否整图/导航标题 |
| 工具 | `lanhu_dds_build` | 编译指定屏：产出单文件紧凑规格表 `screen-N.spec.md`、设计稿裁图 `screen-N.png`、多屏变体差异 `variants-diff.md`、汇总体检报告 `report.md`，并内置 `lanhu-oss-* → alipic.lanhuapp.com` 内网切图镜像回退 |
| 工具 | `lanhu_dds_doctor` | 项目接入自检：自动取当前会话工作目录、读出 `unit`、识别既有 `AGENTS.md`、区分内网 UI 库/图标库与工具包，支持一键生成 `ui-library.md` |
| Skill | `lanhu-dds-codegen` | 一页一闭环增量还原流程：自检 → 选屏 → 编译 → 逐页读 `spec.md`+`png` 出码 → 静态门禁验收 |

## 接入（内网装完之后的第一件事）

```js
// 1. 直接自检（自动定位当前会话工作目录，无需手传 project）
lanhu_dds_doctor({})

// 2. 自动扫描内网 UI 组件库与图标库 → .agents/skills/lanhu-dds-codegen/ui-library.md
//    （若项目没有 AGENTS.md，可同时传 init: true 生成 project-rules.md 模板）
lanhu_dds_doctor({ ui: true })
```

`doctor` 自动处理三件事：

- **`unit`**：读 `config.ts` 的 `designWidth`（750 → `design`，375 → `css`）或 postcss 的 `rootValue`/`viewportWidth`。
- **`agentDocs` 与 `rules`**：若项目根已有完备的 `AGENTS.md` / `CLAUDE.md`，直接认作主规范来源，不再强制生成空白 `project-rules.md` 避免冲突。
- **`uiPackages` / `iconPackages`**：自动排除 `@xxx/func`、`@xxx/rrweb-sdk` 等工具包，递归跟进多级 `export * from` 与深层组件 `.d.ts`（含 `DefineComponent<{...}>`、`interface *Props`），生成 `ui-library.md`。

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
#   通过 → 写入 ~/.dsh/lanhu-cookie，返回 cookieSavedTo，以后所有会话直接复用
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
  "say": "这次还原需要蓝湖登录态：给我一份蓝湖网页的 Cookie（F12 里那个整行 Cookie）。",
  "howToGet": "浏览器登录蓝湖 → F12 → Network → 任一 lanhuapp.com 请求 → 复制完整 Cookie 请求头",
  "howToGive": ["直接在对话里贴给我，我验证通过后会存到 ~/.dsh/lanhu-cookie（0600），以后所有会话都不必再贴"],
  "whatHappensNext": "收到后我先用一个真实设计图验证能不能读，通过就存到 …（0600），以后所有会话都不用再贴；不通过我会告诉你，绝不存坏值。"
}
```

命令行形态同一件事：`--cookie "<值>"`，验证通过同样写进那个文件。

## 中间产物放哪

按会话隔离，全部在 **`~/.dsh-lanhu-dds/`**（`DSH_LANHU_DDS_HOME` 可改根），不进项目：

```
~/.dsh-lanhu-dds/
├── cookie                          # 蓝湖登录态（0600，验证通过才写），跨会话共用
└── sessions/
    └── <会话标识>/                  # 插件取当前 DSH 会话 id 前 12 位；命令行取时间戳
        ├── tmp/                    # 本次会话的临时脚本
        └── 我的订单-4a3b8460/       # 本次会话的产物，重跑先清空再写
```

两次对话互相看不到对方的产物，也不会在根目录堆成一坨。想跨会话复用同一份产物才传 `session`（命令行 `--session`）。攒多了用 `lanhu_dds_doctor({ prune: true, days: 7 })` 清掉超期会话。

`out` 只接受一层目录名（带斜杠或 `..` 直接拒绝）。产物不在项目里，**不需要 gitignore**。

项目里只该多出两个文件，都该提交：

| 文件 | 是什么 |
|---|---|
| `.agents/skills/lanhu-dds-codegen/project-rules.md` | 项目规范（技术栈 / 目录 / token / 字体 / 数据层） |
| `.agents/skills/lanhu-dds-codegen/ui-library.md` | 内网 UI 组件清单（`doctor --ui` 生成，库升级重跑） |

其余的 `.agents/tmp/`、`dump-*.mjs`、`design/dds/`、`screen-*.json` 都是污染，`lanhu_dds_doctor` 会扫出来报 `strays`。

每屏与汇总产物：

| 文件 | 作用 |
|---|---|
| `screen-N.spec.md` | **主输入**：单文件紧凑规格表（组件候选 + 屏内 `(0,0)` 坐标 + 父相位移 + 兄弟间距 + 完整样式 + 文案 + 切图路径） |
| `screen-N.png` | 设计稿裁图（视觉唯一真相） |
| `variants-diff.md` | 多屏编译时自动识别同页面状态/弹层变体并列出差异块 |
| `tokens.css` / `report.md` | 多屏汇总的颜色/字体 token 与体检报告（不覆盖前序屏） |
| `assets/` | 本地切图 + `manifest.json`（内置 `lanhu-oss-*` → `alipic.lanhuapp.com` 带 Cookie+Referer 内网镜像回退 + 原图无遮挡裁切） |
| `screen-N.ir.json` / `rects.json` / `html` | 原始树结构（屏内相对坐标）、几何表与参考 HTML（备查） |

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
- **DDS 给得到的东西就会给到底**：颜色、字号/字重/行高、圆角、边框、背景色、box-shadow（`style.boxShadow`，全项目 4837 个节点里命中 5 次，px 已按设计比归一）、线性渐变（角度+色标完整）、渐变文字（`WebkitBackgroundClip`+`WebkitTextFillColor`）。这些不需要模型猜。
- **DDS 给不到的**：交互态（hover/active/禁用）、响应式约束、图标矢量（切图是位图）、以及设计稿里靠图层叠加出来的效果。`report.md` 逐条列出缺口，由模型对着裁图补。
- **整图导入的屏无法还原**：`screens` 返回 `raster: true` 时说明这屏在 DDS 里是一张图，没有结构，只能要源文件。

## 目录

```
index.js              # 入口：注册 3 个工具 + 1 个 skill
cordis.patch.yml      # 只插自己这一行
lib/lanhu-dds.mjs     # DDS 抓取 + 编译核心（CLI 与插件共用）
lib/png.mjs           # 纯 Node PNG 解码/裁剪/编码
skills/               # 随包的 skill 与参考文档
```
