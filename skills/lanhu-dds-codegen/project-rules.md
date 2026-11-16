# 项目还原约定（lanhu-dds-codegen 项目级扩展）

> 本文件由**项目自己**维护，优先级**高于** `SKILL.md` 的通用规则。
> 首次在本项目使用该 Skill 时：先按第 0 节做一次现场取证，把结论填进第 1~8 节，再动代码。
> 之后每次还原都先读本文件；发现新约定就补进来（本文件应当进版本库）。

## 这就是「接入点」

Skill 是通用的，本文件是**项目特异**的那一半：技术栈、目录、token、字体、组件库、数据层。装到内网后，把下面这些换成真实内容，模型才算真的懂这个项目。

```bash
# 1. 生成模板（已存在则不覆盖）
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs doctor --init

# 2. 扫内网 UI 库，生成真实组件清单 → ui-library.md
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs doctor --ui

# 3. 查还有哪些没填 / 该用哪个 --unit
node .agents/skills/lanhu-dds-codegen/scripts/lanhu-dds.mjs doctor
```

第 2 步扫的是 `node_modules/<内网包>/es/`（或 `lib/`、`dist/`）下的组件目录，产出 `ui-library.md`：组件名、导入路径、从 `.d.ts` 里尽力解析的 props。**这个文件是确定的、可重跑的**——库升级后重新执行即可，不靠人抄文档。

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
// TODO(接入) 下面的 @company/ui / UiButton / UiTag 都是占位，换成内网库真实组件后删掉本行
import Taro from '@tarojs/taro'
import { UiButton, UiTag } from '@company/ui'

interface OrderItem { id: string; title: string; spec: string; price: string; thumb: string; status: string }
defineProps<{ order: OrderItem }>()

function goDetail(id: string) {
  Taro.navigateTo({ url: `/pages/order-detail/index?id=${id}` })
}
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
    <UiButton size="small" block @click="goDetail(order.id)">查看详情</UiButton>
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
