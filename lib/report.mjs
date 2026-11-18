/** 体检报告 report.md：告警汇总与「这份 DDS 哪里不可信」。 */

import { round } from './util.mjs'
import { collectTokens } from './render-html.mjs'

const REPORT_GAPS = [
  'DDS 提供 boxShadow（有就输出，px 已按输出单位折算）；本画布没有命中时说明设计稿确实没用投影。',
  'DDS 不提供 textShadow / filter / 模糊类效果：这些只能从 screen-N.png 参考图目测。',
  'DDS 的图标只有切图 PNG，没有矢量也没有语义名：插件只写图标 CSS 占位，图标资源由用户提供（不比对图标库、不猜图标名）。',
  'DDS 的渐变是完整可用的 linear-gradient（角度与色标齐全），不要重新取色。',
  'DDS 不提供响应式约束（百分比/媒体查询/安全区），375 逻辑宽之外的适配需要按项目栅格重算。',
  'DDS 不提供交互状态（hover/按压/空态/加载态/错误态）与原型流转，需结合需求或既有页面补齐。',
]

/** 交付建议放 report 也放 build 返回体：返回体是裸列表时处置指引只在一处，容易被漏读。 */
export function unplannedAdvice(unplanned) {
  return [
    unplanned.some((u) => u.empty) ? '空屏可以忽略' : '',
    unplanned.some((u) => u.raster) ? '整图屏要跟用户确认真要不要（只能整图铺满或要源文件）' : '',
    unplanned.some((u) => !u.empty && !u.raster) ? '其余要么补进 plan，要么先问用户' : '',
  ].filter(Boolean).join('；')
}

export function buildReport({ meta, screens, compiledList, groupsByScreen, assetStats, variantPairs, identicalPairs = [], unplanned = [], plan, gaps = REPORT_GAPS }) {
  const list = Array.isArray(compiledList) ? compiledList : [compiledList]
  const allWarnings = list.flatMap((c) => c.warnings)
  const w = allWarnings.reduce((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {})
  const unitLabel = (meta.unit ?? 'design') === 'design'
    ? `设计稿 px（${meta.designWidth ?? 750} 基准，交给项目内 px→rem 换算${meta.div && meta.div !== 1 ? `；首屏 ${meta.rawScreenWidth}px 宽已 ÷${Math.round(meta.div * 1000) / 1000} 归一` : ''}）`
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
  // 设计稿只画新样式，保留项在稿里一般是零内容：不说清楚，出码时会以为「规格表没有就不用做」
  if (plan.keep.length) L.push('- 保留项在设计稿里通常没有对应结构和文案（设计稿只画新样式）：按旧代码保留，位置与写法自行决定；容器不要照抄固定 `height`，改成内容撑开')
  L.push('')
  // 画布尺寸和屏尺寸是两件事：一张画布常横排 5~10 屏，用画布宽推算「逻辑宽」会得出 4691 这种数
  L.push(`- 画布：${meta.canvas.width}×${meta.canvas.height} 设计像素（整张设计图，含 ${screens.length} 屏），缩放比 @${meta.scale}x（${meta.device || '按屏宽推算'}，指切图倍率；各屏 \`screen-N.png\` 是 1x 设计像素）`)
  L.push(`- 输出单位：${unitLabel}`)
  L.push(`- 参考图：${meta.referenceOff ? '本次未取（build 参数 reference:false）' : meta.referenceUrl ? '已裁出各屏 `screen-N.png`' : '未取到'}`)
  L.push(`- 设计图含 **${screens.length}** 屏；本次编译 **${list.length}** 屏：${builtSummary}`)
  if (variantPairs?.length) {
    L.push(`- 屏间变体：检测到 ${variantPairs.length} 组同页状态变体（详见 \`variants-diff.md\`）`)
  }
  if (identicalPairs.length) {
    // 结构完全一致、只有标题不同：写在变体表里会是一条「无独有子树」的空节，模型读不出结论
    L.push(`- 结构完全一致、只有标题不同的屏对：${identicalPairs.map((p) => `#${p.a}（${p.titleA || '无标题'}） = #${p.b}（${p.titleB || '无标题'}）`).join('、')}——同一套布局，按一个页面实现`)
  }
  if (unplanned.length) {
    // 建议只写这次真实存在的那几类：没有空屏时还提「空屏可以忽略」会把模型带偏
    L.push(`- **未纳入 plan 的屏**：${unplanned.map((u) => `#${u.index}（${u.title || '无标题'}，${u.nodes} 节点${u.raster ? '，整图屏' : u.empty ? '，空屏' : ''}）`).join('、')}——${unplannedAdvice(unplanned)}`)
  }
  if (assetStats) {
    const parts = [`共 ${assetStats.total} 张 URL`]
    if (assetStats.cdn) parts.push(`CDN 直下 ${assetStats.cdn}（含缓存命中）`)
    if (assetStats.alipic) parts.push(`alipic 镜像 ${assetStats.alipic}`)
    if (assetStats.cropped) parts.push(`reference.png 无遮挡裁切 ${assetStats.cropped}`)
    if (assetStats.compositeIcons) parts.push(`组合小图标预裁 ${assetStats.compositeIcons}`)
    if (assetStats.placeholders) parts.push(`需占位 ${assetStats.placeholders}（下载失败或文字压在图上，按规格表的 PLACEHOLDER 说明用 CSS 兜底，勿用 curl 重试）`)
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

  // 挑颜色/字体最直接的证据：tokens.css 只有变量名，模型需要「色值 → 出现次数」对照（含 rgba 主色）
  const tokens = collectTokens(list)
  const topColors = [...tokens.colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const topText = [...tokens.textColors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const fontRows = [...tokens.fonts.values()].sort((a, b) => b.count - a.count)
  if (topColors.length || topText.length || fontRows.length) {
    L.push('## 高频色值与字体')
    L.push('')
    if (topColors.length) L.push(`- 颜色 top 8（全部来自样式属性，含 rgba）：${topColors.map(([c, n]) => `\`${c}\`×${n}`).join('、')}`)
    if (topText.length) L.push(`- 文本色 top 5：${topText.map(([c, n]) => `\`${c}\`×${n}`).join('、')}`)
    if (fontRows.length) L.push(`- 字体：${fontRows.map((f) => `${f.family}×${f.count}`).join('、')}`)
    L.push('')
  }

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

  // 与规格表「本屏图标」清单同一口径：规格表在 specMarkdown 里把进清单的文件挂在 compiled.iconFiles 上，
  // 自己再算一套必然漂移（组合图标的碎片、折叠的壳层、弹层底层背景都在那一套规则里）
  const iconFiles = new Set()
  for (const c of list) for (const f of c.iconFiles ?? []) iconFiles.add(f)
  const iconCount = iconFiles.size
  // 这份清单每次都在：模型收尾时最容易漏的就是「没跑 lint / 没在浏览器里看过」，不提就会自己编一遍
  L.push('## 交付前还没验证的事（逐条确认一次即可，不要为此重读已写的文件）', '')
  L.push('- 没有跑 prettier / eslint（跑一次就行，不要为格式反复改）')
  L.push('- 没有在浏览器里渲染对比（交互与滚动行为按旧页面实现，样式照规格表）')
  L.push('- 动态数据仍走旧接口，样例值以设计稿为准')
  L.push('')
  if (iconCount) {
    L.push('## 待用户提供（交付时写进「未验证项或残留风险」，不算未完成的功能）')
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
