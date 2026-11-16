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
| 工具 | `lanhu_dds_build` | 编译指定屏：设计稿裁图、结构 IR、像素几何表、参考 HTML、组件切分大纲、设计 token、体检报告、本地切图 |
| 工具 | `lanhu_dds_doctor` | 项目接入自检：该用哪个 `unit`、识别到哪些内网包、扫 UI 库生成组件清单、`project-rules.md` 还空着几项 |
| Skill | `lanhu-dds-codegen` | 还原流程：接入自检 → 选屏 → 编译 → 读项目规范 → 出码 → 几何/视觉验收 |

## 接入（内网装完之后的第一件事）

插件和 Skill 是**通用**的，项目特异的那一半在 `project-rules.md`。不填它，模型就会拿模板里的占位示例当规范——`@company/ui`、`UiButton` 这些词一个都不存在，编出来的代码不能编译。

```bash
# 1. 生成规范模板（已存在不覆盖）
lanhu_dds_doctor({ project: "/path/to/project", init: true })

# 2. 扫内网 UI 库 → ui-library.md（真实组件名 + 导入路径 + 尽力解析的 props）
lanhu_dds_doctor({ project: "/path/to/project", ui: true })

# 3. 人工填规范里剩下的空格：技术栈 / 目录 / token / 字体 / 数据层
# 4. 再查一次，直到 ready: true
lanhu_dds_doctor({ project: "/path/to/project" })
```

`doctor` 输出三件事：

- **`unit`**：读 `config.ts` 的 `designWidth`（750 → `design`，375 → `css`）或 postcss 的 `rootValue`（75 → `design`，37.5 → `css`）。不用猜，也不用问人。
- **`internalPackages`**：`package.json` 里非公共 scope 的依赖，就是你们的内网 UI 库。拿去 `node_modules/<包>/es/` 翻真实组件名。
- **`rules.unfilled` / `rules.placeholders`**：规范文件还空着哪些格子、还有几处 `（如 …）` `TODO(接入)` 没换掉。

`ui` 那一步不靠人抄文档：它直接读 `node_modules/<内网包>/es|lib|dist/` 的目录结构，组件名与导入路径是**确定信息**；props 从 `.d.ts` 里尽力解析，解析不到的标「看源码」。库升级后重跑覆盖即可。

`ready: false` 时不要开始还原——那正是模型自由发挥的地方。

产物（每屏一套，落在工作区）：

```
design/<页面>/
├── screen-0.png          # 从整张画布裁出的设计稿（视觉唯一真相）
├── screen-0.ir.json      # 结构树：box / 文案 / 颜色 / 字号 / flex 语义
├── screen-0.rects.json   # 扁平几何表，可直接和 DOM getBoundingClientRect 比对
├── screen-0.html         # 绝对定位参考渲染（带 data-dds，可截图做像素 diff）
├── screen-0.outline.md   # 缩进大纲 + 重复结构 → 组件候选
├── tokens.css            # 颜色/字体 token（含 Windows 雅黑兜底）
├── report.md             # 屏清单 + DDS 缺口告警
├── screens.json / meta.json / dds.raw.json / reference.png
└── assets/               # 切图 + manifest.json（不放蓝湖 CDN 地址）
```

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

## 配置 Cookie

蓝湖 DDS 接口只需要登录态的 Cookie。按优先级：

1. `config.cookie`（写在 patch 里，不推荐，会被提交）
2. 环境变量 `LANHU_COOKIE`
3. `$DSH_HOME/.env`（或 `~/.dsh/.env`）里的 `LANHU_COOKIE=...`
4. `<工作目录>/.env` 里的 `LANHU_COOKIE=...`
5. `~/.lanhu-cookie`（整份 cookie 一行）

拿 Cookie：蓝湖网页登录 → F12 → Network → 任一 `lanhuapp.com` 请求 → 复制完整 `Cookie` 请求头。

```yaml
# profile 的 cordis.patch.yml：从环境变量注入，避免明文落盘
- id: dsh-lanhu-dds
  config:
    cookie: !!js process.env.LANHU_COOKIE
```

Cookie 过期表现为 DDS 接口返回 `code: "10089"`（登录权限校验失败），工具会返回 `missing-cookie` 或原始错误，不会静默降级。

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
