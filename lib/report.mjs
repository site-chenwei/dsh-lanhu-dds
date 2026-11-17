/** 体检报告 report.md：告警汇总与「这份 DDS 哪里不可信」。 */

import { round } from './util.mjs'

const REPORT_GAPS = [
  'DDS 提供 boxShadow（本项目 4837 个节点里出现 5 次），里面的 px 已按输出单位折算。',
  'DDS 不提供 textShadow / filter / 模糊类效果：这些只能从 screen-N.png 参考图目测。',
  'DDS 的图标只有切图 PNG，没有矢量也没有语义名：插件只写图标 CSS 占位，图标资源由用户提供（不比对图标库、不猜图标名）。',
  'DDS 的渐变是完整可用的 linear-gradient（角度与色标齐全），不要重新取色。',
  'DDS 不提供响应式约束（百分比/媒体查询/安全区），375 逻辑宽之外的适配需要按项目栅格重算。',
  'DDS 不提供交互状态（hover/按压/空态/加载态/错误态）与原型流转，需结合需求或既有页面补齐。',
]

export function buildReport({ meta, screens, compiledList, groupsByScreen, assetStats, variantPairs, plan, gaps = REPORT_GAPS }) {
  const list = Array.isArray(compiledList) ? compiledList : [compiledList]
  const allWarnings = list.flatMap((c) => c.warnings)
  const w = allWarnings.reduce((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {})
  const unitLabel = (meta.unit ?? 'design') === 'design'
    ? `设计稿 px（${meta.designWidth ?? 750} 基准，交给项目内 px→rem 换算${meta.div && meta.div !== 1 ? `；画布 ${meta.rawScreenWidth}px 宽已 ÷${Math.round(meta.div * 1000) / 1000} 归一` : ''}）`
    : 'CSS px（375 逻辑宽）'
  const builtSummary = list.map((c) => `#${c.screenIndex}(${c.screenRect.w}×${c.screenRect.h}, ${c.boxes.size}节点)`).join('、')

  const L = []
  L.push(`# DDS 体检报告 — ${meta.name || meta.imageId || 'design'}`)
  L.push('')
  L.push('## 拍板契约（用户已确认，出码与收尾都以此为准）', '')
  L.push(`- 模式：${plan.mode}`)
  for (const pg of plan.pages) L.push(`- \`${pg.file}\` ← 屏 ${pg.screens.join('、')}`)
  L.push(`- 保留旧页功能：${plan.keep.join('、') || '（无）'}`)
  L.push(`- 移除旧页功能：${plan.drop.join('、') || '（无）'}`)
  L.push('')
  L.push(`- 画布：${meta.canvas.width}×${meta.canvas.height} 设计像素，缩放比 @${meta.scale}x（${meta.device || '按屏宽推算'}），逻辑宽 ${round(meta.canvas.width / meta.scale)}`)
  L.push(`- 输出单位：${unitLabel}`)
  L.push(`- 参考图：${meta.referenceUrl ? '已裁出各屏 `screen-N.png`' : '未取到'}`)
  L.push(`- 设计图含 **${screens.length}** 屏；本次编译 **${list.length}** 屏：${builtSummary}`)
  if (variantPairs?.length) {
    L.push(`- 屏间变体：检测到 ${variantPairs.length} 组同页状态变体（详见 \`variants-diff.md\`）`)
  }
  if (assetStats) {
    const parts = [`共 ${assetStats.total} 张 URL`]
    if (assetStats.cdn) parts.push(`CDN 直下 ${assetStats.cdn}`)
    if (assetStats.alipic) parts.push(`alipic 镜像 ${assetStats.alipic}`)
    if (assetStats.cropped) parts.push(`reference.png 无遮挡裁切 ${assetStats.cropped}`)
    if (assetStats.compositeIcons) parts.push(`组合小图标预裁 ${assetStats.compositeIcons}`)
    if (assetStats.placeholders) parts.push(`需占位 ${assetStats.placeholders}（CDN 不可达且有文字叠加，勿用 curl 重试）`)
    L.push(`- 切图资源：${parts.join('，')}`)
  }
  L.push('')
  L.push('## 屏清单')
  L.push('')
  L.push('| # | 尺寸 | 节点 | 整图? | 标题 |')
  L.push('|---|---|---|---|---|')
  for (const s of screens) {
    L.push(`| ${s.index} | ${s.width}×${s.height} | ${s.nodes} | ${s.raster ? '⚠️ 是' : '否'} | ${(s.title || '').replace(/\|/g, '\\|').slice(0, 30)} |`)
  }
  L.push('')
  L.push('## 告警统计')
  L.push('')
  if (!Object.keys(w).length) L.push('无。')
  for (const [k, n] of Object.entries(w).sort((a, b) => b[1] - a[1])) L.push(`- \`${k}\`: ${n}`)
  L.push('')

  const allGroups = []
  for (const [scrIdx, gs] of groupsByScreen ?? []) {
    for (const g of gs) allGroups.push({ screen: scrIdx, ...g })
  }
  L.push('## 重复结构 → 组件候选')
  L.push('')
  if (allGroups.length) {
    L.push('| 屏 | 父节点 | 次数 | 单块尺寸 | 单块节点 | 文案样本 |')
    L.push('|---|---|---|---|---|---|')
    for (const g of allGroups) {
      L.push(`| #${g.screen} | ${g.parentName}(${g.parent}) | ${g.count} | ${g.width} × ${g.height} | ${g.nodes} | ${g.texts.map((t) => `"${t}"`).join(' / ')} |`)
    }
  } else {
    L.push('未发现同构重复（或均为单实例块）。')
  }
  L.push('')

  const iconCount = list.reduce((n, c) => n + [...c.boxes.values()].filter((b) => Boolean(b.compositeAsset?.file)
    || (b.asset?.status === 'ok' && !b.asset.blank && b.screenRect.w <= 64 && b.screenRect.h <= 64 && b.kids.length === 0)).length, 0)
  if (iconCount) {
    L.push('## 待用户提供（交付时的未完成项，不是缺陷）')
    L.push('')
    L.push(`- 图标 ${iconCount} 个：各 \`screen-N.spec.md\` 的「本屏图标」清单给了尺寸与颜色，代码里只写 CSS 占位，图标资源由用户提供。不为此比对图标库、不猜图标名、不用图片脚本取色。`)
    L.push('')
  }

  if (gaps.length) {
    L.push('## DDS 覆盖不到的地方（必须人工/视觉补齐）')
    L.push('')
    for (const g of gaps) L.push(`- ${g}`)
    L.push('')
  }
  return L.join('\n')
}
