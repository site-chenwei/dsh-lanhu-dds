# 项目还原约定（lanhu-dds-codegen 项目级扩展）

> **先看项目根目录有没有 `AGENTS.md` / `CLAUDE.md`**：若项目根已有完备的 `AGENTS.md`，`lanhu-dds doctor` 会直接认它为最高准则，**不需要**生成或维护本文件，只跑 `doctor --ui` 生成 `ui-library.md` 即可（避免两份规范打架）。
> 仅当项目没有 `AGENTS.md` 时，才由项目维护本文件，优先级**高于** `SKILL.md` 的通用规则。
> 首次在本项目使用该 Skill 时：先按第 0 节做一次现场取证，把结论填进第 1~8 节，再动代码（本文件应当进版本库）。

## 这就是「接入点」

Skill 是通用的，本文件（或项目既有的 `AGENTS.md`）+ `ui-library.md` 是**项目特异**的那一半：技术栈、目录、token、字体、组件库、数据层。

```bash
# 1. 扫内网 UI 库与图标库，生成真实组件清单 → ui-library.md
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs doctor --ui

# 2. （仅在项目没有 AGENTS.md 时）生成本模板并填入真实规范
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs doctor --init

# 3. 查接入状态与输出单位 --unit
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs doctor
```

第 1 步会自动排除工具/SDK 包，递归扫描内网 UI 库与图标库的入口 `.d.ts` 及深层组件目录，产出 `ui-library.md`。库升级后重新执行即可。

`doctor` 会输出「空着 N 项、占位 M 处」和逐条待办。**空着的项不是可选项**——那正是模型会自己编的地方。全部填完后 `ready: true`，再开始还原。

占位符约定：`（如 …）`、`（内网 …）`、`待填`、`TODO(接入)` 都会被 `doctor` 统计，填完删掉标记。

## 0. 首次使用的取证清单

填这份文件前，先把下面这些查清（查不到就写「无」并说明）：

```bash
# 项目形态
ls; cat package.json | head -60
# 规范与笔记
ls AGENTS.md CLAUDE.md .agents .agents/notes .agents/skills 2>/dev/null
# 样式方案与组件库
ls src/components src/styles src/theme* src/assets 2>/dev/null
cat tailwind.config.* 2>/dev/null | head -60
# 路径别名 / 构建
cat vite.config.* tsconfig.json 2>/dev/null | head -60
```

然后找**一个已经在跑的同类页面**通读一遍——它的目录、命名、取数、样式组织方式，就是本项目的事实规范。

## 1. 技术栈

| 项 | 本项目取值 |
|---|---|
| 框架 | （如 Taro 4 + Vue 3（H5）/ React 18 + Vite） |
| 语言 | （TS / JS，是否允许 any） |
| 样式方案 | （CSS Module / Tailwind / SCSS / styled-components / 原子类） |
| UI 组件库 | （包名 + 版本；组件清单见 `ui-library.md`，由 `doctor --ui` 生成；有没有基于原生标签的通用组件） |
| 单位方案 | **代码里写设计稿 px（750 基准），构建期转 rem/rpx**：`postcss-px-to-rem` 的 `rootValue` = ___（750 稿通常 75）；Taro 看 `config.ts` 的 `designWidth`（750 → 直接写 px） |
| 适配方案 | （固定 375 / 弹性布局 / postcss-px-to-viewport / lib-flexible） |
| 是否需要 `--unit css` | 若项目不用 px→rem 且按 375 逻辑宽开发，则填「是」（产物折半） |

## 2. 目录与命名

| 项 | 约定 |
|---|---|
| 页面目录 | |
| 组件目录 | |
| 业务组件命名 | （如 `OrderCard/index.tsx` 还是 `order-card.tsx`） |
| 样式文件命名 | |
| 静态资源目录 | （切图放哪、是否要 images/ 二级目录） |
| 路径别名 | （如 `@/` → `src/`） |

## 3. 设计 token

**优先用项目既有变量，禁止在业务代码里写字面色值。**

| 类别 | 项目变量位置 | 备注 |
|---|---|---|
| 颜色 | （如 `src/styles/variables.scss` / tailwind theme） | 列出主色、文本色、分割线、成功/警告/错误 |
| 字号 | | |
| 圆角 | | |
| 阴影 | | DDS 直接给 `box-shadow`（设备像素，编译产物已按单位换算），优先套项目阴影 token |
| 间距 | | 是否有 4/8 栅格 |

`lanhu-dds-codegen` 生成的 `tokens.css` 是候选值，**不直接引入项目**，只用来和项目 token 做映射。

## 3.5 项目里放什么（接入件 vs 污染）

这个 Skill 只在项目里写**两个文件**，都该提交：

- `.agents/skills/lanhu-dds-codegen/project-rules.md` —— 本文
- `.agents/skills/lanhu-dds-codegen/ui-library.md` —— 内网 UI 组件清单（`doctor --ui` 生成，库升级后重跑）

**产物不进项目**：`~/.dsh-lanhu-dds/sessions/<会话>/` 下按会话隔离放裁图 / IR / 几何表 / 参考 HTML / 切图；Cookie 在 `~/.dsh-lanhu-dds/cookie`（`DSH_LANHU_DDS_HOME` 可改根）。所以不需要 gitignore 任何东西。

**项目里不允许出现**（`doctor` 会扫出来报 `strays`）：

| 类别 | 例子 |
|---|---|
| 产物拷贝 | `design/dds/`、`.lanhu-dds/`、`screen-*.ir.json`、`screen-*.spec.md` |
| 临时脚本 | `.agents/tmp/dump-ir.mjs`、`probe-*.mjs`、`scratch/`、`tmp/` |
| 手搓的中间态 | 根目录 `dump-*.json`、`test2.js` |

出码直接 `read` 会话产物目录下的 `screen-N.spec.md`，无需手写解析脚本；确需落临时文件时只写到当前会话的 `~/.dsh-lanhu-dds/sessions/<会话>/tmp/`。超期会话目录用 `lanhu_dds_doctor({ prune: true, days: 7 })` 清理。

## 4. 字体

| 项 | 约定 |
|---|---|
| 正文字体栈 | |
| 数字/金额字体 | （是否用等宽数字 `font-variant-numeric`） |
| 是否加载自定义字体 | |
| Windows 兜底 | （PingFang SC 在内网 Windows 上不存在，必须给雅黑兜底） |

## 5. 代码骨架

贴一段**本项目的标准页面骨架**（真实代码，不要编），让模型照着写：

```tsx
// 页面骨架（从 <某个真实页面> 摘取，替换成本项目的）
```

```css
/* 样式骨架（从 <某个真实页面> 摘取） */
```

### 5.1 Taro 4 + Vue 3（H5 端）参考

真项目如果是这套，照下面写；不是就删掉本节。

**要点先说**：目标是 H5，写普通 HTML + Vue SFC；`<view>/<text>/<image>` 是小程序端的，这里不用。UI 一律优先用**内网 UI 库**（Vant 封装），手写只用于布局容器和库覆盖不了的视觉。

```vue
<script setup lang="ts">
// TODO(接入) 下面的 @company/ui / UiButton / UiTag 与路由写法均为占位，务必换成项目真实组件与路由封装后删掉本行
import { UiButton, UiTag } from '@company/ui'

interface OrderItem { id: string; title: string; spec: string; price: string; thumb: string; status: string }
defineProps<{ order: OrderItem }>()
const emit = defineEmits<{ select: [id: string] }>()
</script>

<template>
  <div class="order-card">
    <header class="order-card__head">
      <span class="order-card__shop">实物黄金</span>
      <UiTag type="primary" plain>{{ order.status }}</UiTag>
    </header>
    <div class="order-card__body">
      <img class="order-card__thumb" :src="order.thumb" alt="" />
      <div class="order-card__info">
        <p class="order-card__title">{{ order.title }}</p>
        <p class="order-card__spec">{{ order.spec }}</p>
      </div>
      <span class="order-card__price">{{ order.price }}</span>
    </div>
    <UiButton size="small" block @click="emit('select', order.id)">查看详情</UiButton>
  </div>
</template>

<style lang="scss" scoped>
.order-card {
  display: flex;
  flex-direction: column;
  padding: 24px 24px 0;      // 设计稿 750 基准，直接写量到的 px，pxtransform 负责换算
  background: #fff;
  border-radius: 16px;

  &__head { display: flex; align-items: center; justify-content: space-between; }
  &__body { display: flex; align-items: center; gap: 16px; }

  // 覆盖内网组件库样式：用 :deep() 或库暴露的 CSS 变量，别全局 !important
  :deep(.ui-tag) { margin-left: 8px; }
}
</style>
```

`UiButton` / `UiTag` / `@company/ui` 都是**占位**：换成内网库里真实存在的组件与包名，别照抄。库里有 Cell / List / Empty / Skeleton 这类现成组件时，一律优先用。

## 6. 数据与接口

| 项 | 约定 |
|---|---|
| 取数方式 | （hooks / service 层 / 仓库封装的 request） |
| 接口文件位置 | |
| loading / error / empty 组件 | （组件名，或「项目无统一组件」） |
| mock 方式 | |

设计稿里的静态文案与真实字段的映射，写在这里或写在当次任务的交付说明里。

## 7. 质量门禁

| 项 | 命令 |
|---|---|
| 类型检查 | |
| lint | |
| 单测 | |
| 构建 | |

改动后必须跑的最小集：`（填命令）`

## 8. 本项目已踩过的坑

按时间追加，一条一行，写清现象与正确做法。

- （示例）订单卡片的设计稿内边距是 16，但 DDS 的父子同 rect 会让人误判成 32，实际取 16。
- （示例）项目里的金额组件 `<Money>` 自带 ¥ 与千分位，设计稿的 `¥1,965.00` 不能再手写。
