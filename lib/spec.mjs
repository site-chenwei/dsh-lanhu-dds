/** 紧凑规格表 screen-N.spec.md：壳层折叠、安全区标注、重复结构与样式树。 */

import { round } from './util.mjs'

// ---------------------------------------------------------------- 组件切分与紧凑规格表

/**
 * 重复结构检测：同一个父节点下、同宽、节点数量接近的兄弟块 = 组件抽取候选。
 * 不按「尺寸完全相等」分组——同一组订单卡片里，带「取消订单」按钮的那张会高 50px，
 * 按精确尺寸分组会把它们拆成两组。同宽 + 节点数接近才是稳的信号。
 */
let currentBoxes = new Map()

export function findRepeatGroups(compiled) {
  currentBoxes = compiled.boxes
  const groups = []
  for (const [, b] of compiled.boxes) {
    if (b.kids.length < 2) continue
    const byWidth = new Map()
    for (const k of b.kids) {
      const child = compiled.boxes.get(k)
      if (!child.kids.length) continue
      const nodes = countNodes(child)
      if (nodes < 3) continue
      const key = String(Math.round(child.rect.w / 2) * 2)
      if (!byWidth.has(key)) byWidth.set(key, [])
      byWidth.get(key).push({ child, nodes, h: child.rect.h })
    }
    for (const [width, list] of byWidth) {
      const fams = []
      for (const item of [...list].sort((x, y) => x.nodes - y.nodes)) {
        const fam = fams.find((f) => Math.abs(item.nodes - f[0].nodes) <= 4)
        if (fam) fam.push(item)
        else fams.push([item])
      }
      for (const fam of fams) {
        if (fam.length < 2) continue
        const hs = fam.map((x) => x.h)
        groups.push({
          parent: b.id,
          parentName: b.name,
          count: fam.length,
          width: Number(width),
          height: Math.min(...hs) === Math.max(...hs) ? hs[0] : `${round(Math.min(...hs))}–${round(Math.max(...hs))}`,
          nodes: fam[0].nodes,
          texts: fam.map((x) => firstText(x.child)).filter(Boolean).slice(0, 6),
          members: fam.map((x) => x.child.id),
        })
      }
    }
  }
  return groups.sort((a, b) => b.count * b.nodes - a.count * a.nodes).slice(0, 12)
}

function countNodes(b) {
  let n = 0
  const walk = (x) => { n++; for (const k of x.kids) walk(currentBoxes.get(k)) }
  walk(b)
  return n
}

function firstText(b) {
  if (b.text) return b.text.slice(0, 24)
  for (const k of b.kids) {
    const t = firstText(currentBoxes.get(k))
    if (t) return t
  }
  return ''
}

export function outlineMarkdown(compiled, groups) {
  const L = ['# 结构大纲（供组件切分）', '']
  L.push('```')
  const walk = (b, d) => {
    const label = b.text ? `"${b.text.slice(0, 30).replace(/\n/g, ' ')}"` : ''
    L.push(`${'  '.repeat(d)}${b.name} ${b.rect.w}×${b.rect.h}${label ? ' ' + label : ''}`)
    for (const k of b.kids) walk(compiled.boxes.get(k), d + 1)
  }
  walk(compiled.boxes.get(compiled.root), 0)
  L.push('```', '')
  if (groups.length) {
    L.push('## 重复结构 → 组件候选', '')
    L.push('| 父节点 | 重复次数 | 单块尺寸 | 单块节点 | 文案样本 |')
    L.push('|---|---|---|---|---|')
    for (const g of groups) {
      L.push(`| ${cellEsc(g.parentName)}(${g.parent}) | ${g.count} | ${g.width} × ${g.height} | ${g.nodes} | ${cellEsc(g.texts.map((t) => `"${t}"`).join(' / '))} |`)
    }
    L.push('')
  }
  return L.join('\n')
}

function formatPadding(css) {
  const pt = css.paddingTop ?? '0'
  const pr = css.paddingRight ?? '0'
  const pb = css.paddingBottom ?? '0'
  const pl = css.paddingLeft ?? '0'
  if (pt === '0' && pr === '0' && pb === '0' && pl === '0') return ''
  return `pad:${pt}/${pr}/${pb}/${pl}`
}

function formatRadii(css) {
  if (css.borderRadius) return `r:${css.borderRadius}`
  const tl = css.borderTopLeftRadius
  const tr = css.borderTopRightRadius
  const br = css.borderBottomRightRadius
  const bl = css.borderBottomLeftRadius
  if (!tl && !tr && !br && !bl) return ''
  return `r:${tl ?? 0}/${tr ?? 0}/${br ?? 0}/${bl ?? 0}`
}

export const CSS_URL_RE = /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/i

export function extractCssUrl(val) {
  if (!val) return null
  return CSS_URL_RE.exec(String(val))?.[2] ?? null
}

export function cleanCssColorNoise(val) {
  if (!val) return ''
  return String(val)
    .replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.eE+-]+)\s*\)/gi, (_m, r, g, b, a) => {
      const num = Number(a)
      if (!Number.isFinite(num)) return _m
      const rounded = Math.round(num * 1000) / 1000
      return `rgba(${r},${g},${b},${rounded})`
    })
    .replace(/(\d+)\.0+(?=%|px\b|\s|\)|,|$)/g, '$1')
    .replace(/(\.\d*?[1-9])0+(?=%|px\b|\s|\)|,|$)/g, '$1')
}

function isEffectivelyTransparent(val) {
  if (!val || /gradient\(/i.test(val)) return false
  if (/\btransparent\b/i.test(val)) return true
  const m = /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.eE+-]+)\s*\)/i.exec(val)
  if (!m) return false
  const a = Number(m[1])
  return Number.isFinite(a) && a < 0.001
}

/**
 * 识别页面壳层（默认忽略的顶部状态栏/导航栏 + 底部 iOS Home Indicator 安全区占位条）：
 *   1. 顶部壳层：贴顶（y<=4，宽>=90%屏宽，底边<=0.32*屏宽），含状态栏时间 "9:41" 或 StatusBar/NavBar 命名，且无搜索框/多标签栏；
 *   2. 底部安全区条：贴底（|y+h-屏高|<=4，宽>=90%屏宽，高度在 4%~13% 屏宽之间，如 750 屏下的 68px），无业务文案。
 */
export function detectScreenChrome(compiled) {
  const { boxes, root, screenRect } = compiled
  const rootBox = boxes.get(root)
  const topRoots = []
  const topNodeSet = new Set()
  const bottomSafeNodes = new Set()
  let navTitle = ''
  let topBottom = 0

  const addSubtree = (node, set) => {
    const b = boxes.get(node)
    if (!b) return
    set.add(node)
    for (const k of b.kids) addSubtree(k, set)
  }

  const subtreeInfo = (node) => {
    let hasClock = false
    let hasChromeHint = false
    const texts = []
    const walk = (n) => {
      const b = boxes.get(n)
      if (!b) return
      if (/StatusBar|NavigationBar|NavBar|Capsule|WechatCapsule/i.test(`${b.id} ${b.eleName}`)) hasChromeHint = true
      if (b.type === 'lanhutext' && b.text?.trim()) {
        const t = b.text.trim().replace(/\s+/g, ' ')
        if (/^\d{1,2}:\d{2}$/.test(t)) hasClock = true
        else texts.push(t)
      }
      for (const k of b.kids) walk(k)
    }
    walk(node)
    return { hasClock, hasChromeHint, texts }
  }

  if (rootBox) {
    const maxTopH = screenRect.w * 0.32
    // 顶栏不一定挂在根节点下面：Figma 分组常把导航栏塞进某个卡片框里（视觉上仍在屏顶、坐标仍是 (0,0)）。
    // 只在根的直接子节点里找会整块漏掉，于是 9:41 和导航标题被当成页面内容写进树里。
    const fullWidthBoxes = [...boxes.entries()]
      .filter(([, b]) => b.depth > 0 && b.screenRect.x <= 4 && b.screenRect.w >= screenRect.w * 0.9)
      .sort((a, b) => a[1].screenRect.y - b[1].screenRect.y || b[1].screenRect.h - a[1].screenRect.h)
    for (const [k, b] of fullWidthBoxes) {
      if (topNodeSet.has(k)) continue
      const sr = b.screenRect
      if (sr.y <= 4 && sr.y + sr.h <= maxTopH) {
        // 状态栏/整条顶栏：必须带时钟或命名线索，否则只是恰好贴在屏顶的内容块
        const info = subtreeInfo(k)
        if ((info.hasClock || info.hasChromeHint) && info.texts.length <= 2) {
          topRoots.push(k)
          addSubtree(k, topNodeSet)
          topBottom = Math.max(topBottom, sr.y + sr.h)
          if (!navTitle && info.texts[0]) navTitle = info.texts[0]
        }
      } else if (
        topRoots.length === 1
        && sr.y >= topBottom - 2
        && sr.y + sr.h <= maxTopH
      ) {
        // 第二块：状态栏与导航栏分开画的设计稿，导航栏紧贴状态栏下沿且只有一行标题
        const info = subtreeInfo(k)
        if (info.texts.length <= 1 && !/搜索|请输入/.test(info.texts[0] ?? '')) {
          topRoots.push(k)
          addSubtree(k, topNodeSet)
          topBottom = Math.max(topBottom, sr.y + sr.h)
          if (!navTitle && info.texts[0]) navTitle = info.texts[0]
        }
      }
    }
  }

  for (const [node, b] of boxes) {
    if (b.depth === 0 || topNodeSet.has(node)) continue
    const sr = b.screenRect
    const nearBottom = Math.abs(sr.y + sr.h - screenRect.h) <= 4
    const fullWidth = Math.abs(sr.x) <= 4 && sr.w >= screenRect.w * 0.9
    const safeHeight = sr.h >= screenRect.w * 0.04 && sr.h <= screenRect.w * 0.13
    if (!nearBottom || !fullWidth || !safeHeight) continue
    const info = subtreeInfo(node)
    const namedSafe = /HomeIndicator|SafeArea|HomeBar/i.test(`${b.id} ${b.eleName}`)
    if (info.texts.length === 0 && !info.hasClock && (namedSafe || b.kids.length <= 2)) {
      addSubtree(node, bottomSafeNodes)
    }
  }

  const skipNodeSet = new Set([...topNodeSet, ...bottomSafeNodes])
  return { topRoots, topNodeSet, topBottom, navTitle, bottomSafeNodes, skipNodeSet }
}

function findNearestShortText(targetBox, compiled, skipNodeSet) {
  const sr = targetBox.screenRect
  const cx = sr.x + sr.w / 2
  const cy = sr.y + sr.h / 2
  let best = null
  for (const [node, b] of compiled.boxes) {
    if (skipNodeSet?.has(node)) continue
    if (b.type !== 'lanhutext' || !b.text?.trim()) continue
    const txt = b.text.trim().replace(/\s+/g, ' ')
    if (txt.length > 14 || /^\d{1,2}:\d{2}$/.test(txt)) continue
    const tr = b.screenRect
    const dx = Math.max(0, Math.max(sr.x - (tr.x + tr.w), tr.x - (sr.x + sr.w)))
    const dy = Math.max(0, Math.max(sr.y - (tr.y + tr.h), tr.y - (sr.y + sr.h)))
    const alignPenalty = Math.min(Math.abs(cx - (tr.x + tr.w / 2)), Math.abs(cy - (tr.y + tr.h / 2))) * 0.25
    const dist = Math.hypot(dx, dy) + alignPenalty
    if (dist <= 80 && (!best || dist < best.dist)) best = { txt, dist }
  }
  return best?.txt ?? ''
}

/**
 * 单屏紧凑规格表（screen-N.spec.md）：把层级、屏内相对坐标、父容器偏移、前兄弟间距、
 * 视觉样式、文案与本地切图路径合在一份几 KB 的文本里，模型单次 read 即可直接写代码，无需写脚本拆 ir.json。
 */
/** Markdown 表格单元格：文案里带竖线会把列数撑错，换行会把表格断成两段 */
const cellEsc = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')

/**
 * 整屏只有一层弹层（没有顶栏、首块内容低于屏高 20%）时才算「弹层帧」。
 * screens 工具、规格表、落盘 screens.json 都从这里取，判据只有一份。
 */
export function screenIsPopupSheet(compiled, chrome = detectScreenChrome(compiled)) {
  const { boxes, root, screenRect } = compiled
  const rootBox = boxes.get(root)
  let minContentY = Infinity
  if (rootBox) {
    for (const k of rootBox.kids) {
      if (chrome.skipNodeSet.has(k)) continue
      const kb = boxes.get(k)
      if (kb) minContentY = Math.min(minContentY, kb.screenRect.y)
    }
  }
  return chrome.topRoots.length === 0 && minContentY >= screenRect.h * 0.2
}

export function specMarkdown(compiled, groups, { title = '', unit = 'design', contract = '', unitDiv = 1, designWidth = 0, uiDoc = false, raster = false } = {}) {
  const { boxes, screenRect, screenIndex } = compiled
  const chrome = detectScreenChrome(compiled)
  const isPopupSheet = screenIsPopupSheet(compiled, chrome)

  const isEmptyLeafBox = (b) => {
    if (b.depth === 0 || b.type === 'lanhutext' || b.kids.length > 0) return false
    if (b.text?.trim() || b.asset || b.compositeAsset || b.compositeHint) return false
    const c = b.css
    const hasBg = [c.background, c.backgroundImage, c.backgroundColor].some((v) => v && !isEffectivelyTransparent(v))
    const hasBorder = ['border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight'].some((k) => c[k] && !isEffectivelyTransparent(c[k]))
    return !hasBg && !hasBorder && !c.boxShadow
  }

  // 切图清单：模型选图、拷图要的文件名/像素/字节/位置一次给全，不用再翻 manifest.json 或列目录
  const fmtBytes = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`)
  const tintNote = (tint) => (tint === 'multi' ? '多色' : tint ? `单色 ${tint}` : '')
  const bizAssets = new Map()
  const iconAssets = new Map()
  // 组合图标已整块预裁，它内部的半截碎片在树里折叠了，清单里也不能再单列
  const folded = new Set()
  const fold = (b) => { for (const k of b.kids) { folded.add(k); fold(boxes.get(k)) } }
  for (const [node, b] of boxes) {
    if (chrome.skipNodeSet.has(node) || folded.has(node)) continue
    const sr = b.screenRect
    if (b.compositeAsset?.file) {
      const a = b.compositeAsset
      const near = findNearestShortText(b, compiled, chrome.skipNodeSet)
      iconAssets.set(a.file, [`${a.pxWidth}×${a.pxHeight}px ${fmtBytes(a.bytes)}`, '组合图标预裁图', tintNote(a.tint), near && `near:"${near}"`].filter(Boolean).join(' '))
      fold(b)
      continue
    }
    if (b.asset?.status !== 'ok' || b.asset.blank) continue
    if (b.depth === 0 && isPopupSheet) continue
    const a = b.asset
    const dims = `${a.pxWidth && a.pxHeight ? `${a.pxWidth}×${a.pxHeight}px` : `${sr.w}×${sr.h}`} ${fmtBytes(a.bytes)}`
    if (sr.w <= 64 && sr.h <= 64 && !b.kids.length) {
      if (iconAssets.has(a.file)) continue
      const near = findNearestShortText(b, compiled, chrome.skipNodeSet)
      iconAssets.set(a.file, [dims, tintNote(a.tint), near && `near:"${near}"`].filter(Boolean).join(' '))
      continue
    }
    if (!bizAssets.has(a.file)) bizAssets.set(a.file, `${dims} @(${sr.x},${sr.y} ${sr.w}×${sr.h})`)
  }

  // 报告要与规格表同口径统计图标数：把本次真正进清单的文件挂回编译结果，report 直接取用
  compiled.iconFiles = [...iconAssets.keys()]

  // 三处数字之间的换算关系规格表本身没说清，模型照字面写会错：行高与图层高不等价、
  // 文本宽/←gap 是实测文字宽的派生量、多层 rel 要累加。只在真的存在时才出这几行，避免每屏都灌规则。
  const allBoxes = [...boxes.values()]
  const hasText = allBoxes.some((b) => b.type === 'lanhutext' && b.text)
  const lhDiffs = []
  let lhSamples = []
  for (const b of allBoxes) {
    if (b.type !== 'lanhutext' || !b.text) continue
    const fs = Number.parseFloat(b.css.fontSize)
    const lhRaw = String(b.css.lineHeight ?? '')
    // line-height 写成 px 时 parseFloat 拿到的是像素值，当成倍数乘字号会算出几百倍的差
    const lhPx = /px/i.test(lhRaw) ? Number.parseFloat(lhRaw) : Number.parseFloat(lhRaw) * fs
    if (!Number.isFinite(fs) || !Number.isFinite(lhPx) || lhPx <= 0) continue
    const d = Math.round(lhPx - b.screenRect.h)
    if (d >= 2 && d <= 40) {
      lhDiffs.push(d)
      // 例子要带真实数字：文字的纵向间距记在父行上（文字自己是行内的），所以取父行的 ↑gap。
      // 扣完变负数的样本不拿来举例——那会教模型写负 margin
      const par = b.parentNode ? boxes.get(b.parentNode) : null
      if (!lhSamples.length && par?.gap?.axis === 'y' && par.gap.px - d >= 0) {
        lhSamples = [`例如父行 ↑gap:${par.gap.px}、本行 line-height ${Math.round(lhPx)}、图层高 ${b.screenRect.h} → margin 取 ${Math.round(par.gap.px - d)}`]
      }
    }
  }
  // 反向情况：图层比行盒高（标题、多行文案常见）。照抄 height 会与 line-height 打架
  const tallDiffs = []
  for (const b of allBoxes) {
    if (b.type !== 'lanhutext' || !b.text) continue
    const fs = Number.parseFloat(b.css.fontSize)
    const lhRaw = String(b.css.lineHeight ?? '')
    const lhPx = /px/i.test(lhRaw) ? Number.parseFloat(lhRaw) : Number.parseFloat(lhRaw) * fs
    if (!Number.isFinite(fs) || !Number.isFinite(lhPx) || lhPx <= 0) continue
    const d = Math.round(b.screenRect.h - lhPx)
    if (d >= 4 && d <= 40) tallDiffs.push(d)
  }
  const lhDiff = lhDiffs.length ? [...new Set(lhDiffs)].sort((a, b) => lhDiffs.filter((x) => x === b).length - lhDiffs.filter((x) => x === a).length)[0] : 0
  const spaceBetweenRows = allBoxes.some((b) => b.css.justifyContent === 'space-between' && b.css.flexDirection !== 'column')
  const nestedRel = allBoxes.some((b) => b.depth >= 2 && b.rel && (b.rel.x || b.rel.y) && (() => {
    const par = b.parentNode ? boxes.get(b.parentNode) : null
    return Boolean(par?.rel && (par.rel.x || par.rel.y))
  })())
  const readingNotes = [
    ...(tallDiffs.length
      ? [`> 文字盒高度提示：${tallDiffs.length} 处文字的图层高比它的行盒大 ${tallDiffs[0]}px 左右（标题、多行文案常见）。` +
        '照抄 `height` 会和 `line-height` 打架：按行盒写 `line-height`，多出来的高度用上下 `padding` 各补一半，或者让父容器 flex 居中。']
      : []),
    ...(allBoxes.some((b) => b.depth > 0 && b.kids.length > 0 && b.css.height)
      ? ['> 容器尺寸提示：`@(x,y w×h)` 是设计稿实测值。内容撑开的容器（含 `jc:center` 的行容器）按「子节点 + 内距」还原，不要照抄 `height`——往定高容器里补内容（例如要保留的旧功能）会直接溢出；只有图片、占位、固定高度的卡片才写死。']
      : []),
    ...(hasText && lhDiffs.length
      ? [`> 行高提示：${lhDiffs.filter((x) => x === lhDiff).length} 处单行文字的行高（字号×行高）比图层高大 ${lhDiff}px。` +
        `↑gap 是按图层高算的，写 \`line-height\` 之后要补两处，否则容器会被撑高：兄弟间距 = \`↑gap\` − ${lhDiff}${lhSamples[0] ? `（${lhSamples[0]}）` : ''}；` +
        `容器定高时，只把紧贴文本行那一层的上下内距各减 ${Math.round(lhDiff / 2)}px（行盒上下各外扩一半；外层容器的内距不要再减，否则会少一截）。`]
      : []),
    ...(spaceBetweenRows
      ? ['> 派生尺寸提示：文本节点的 `w` 与 `←gap` 是按文字实测宽度算出来的（`jc:space-between` 的行里尤其如此），照抄会写死宽度、文案一变长就溢出；按字号与左右对齐写，整行用 flex + `justify-content: space-between`。值可能变长的那一列（金额、克数、数量）加 `text-overflow: ellipsis; white-space: nowrap; overflow: hidden`，别让它把行撑高。`ta` 只在盒子明显宽于文字（`w` 比文字实测宽大出一截）时才有意义；宽度就等于文字宽的节点上 `ta` 是空转，左右位置由 flex 决定，不要再叠。']
      : []),
    ...(nestedRel
      ? ['> 内距提示：`rel()` 相对父节点，多层都没有 `pad:` 时真实内距要逐层累加（父 `rel(24,24)` + 子 `rel(0,24)` → 纵向 48）。']
      : []),
  ]
  // 与 screens/report 的 raster 判据同一个来源（build 传进来的 descs[idx].raster），不再各算一套：
  // 之前 assets:false 时这里没有 asset.file，会把整图屏说成「空框」
  const imageOnly = raster
  const screenNotes = [
    ...(imageOnly
      ? ['> **本屏在 DDS 里是整张位图**：只有一个覆盖全屏的图片节点、没有可用的结构，无法结构化还原。要么向用户要源文件，要么按一张整图铺满处理，不要凭空编造层级。']
      : boxes.size <= 3
        ? ['> **本屏是空框**：只有个位数节点、没有业务内容，通常是设计器里的空占位。不要为它建页面。']
        : []),
  ]

  const L = [
    `# Screen ${screenIndex} — ${title || chrome.navTitle || '未命名'} (${screenRect.w}×${screenRect.h}, unit=${unit}, ${boxes.size} 节点)`,
    ...screenNotes,
    ...(unitDiv !== 1
      ? ['', `> 坐标归一：本屏实测宽 ${Math.round(screenRect.w * unitDiv)}px，是项目 ${designWidth} 基准的 ${Math.round(unitDiv * 1000) / 1000} 倍，本表所有数值已 ÷${Math.round(unitDiv * 1000) / 1000}，可直接写进代码（切图尺寸是原图 px，需按同一比例理解）。`]
      : []),
    '',
    '> 坐标系：本屏左上角 `(0,0)`；`@(x,y w×h)` 为屏内位置，`rel(dx,dy)` 为相对父容器偏移（`=parent` 表示与父同框，勿重复叠加 padding），`↑gap` / `←gap` 为与上一兄弟间距，`↑nav` 为首块内容距顶部导航栏底边的间距。',
    '> 记号：`fs` 字号 `fw` 字重 `lh` 行高 `c` 文字色（`c:MISSING(看裁图)` = DDS 没给，按裁图取）`grad-text` 渐变文字（颜色来自 background-image，别再写 `color`）`ta` 水平对齐 `bg` 背景 `r` 圆角 `bd` 描边 `sh` 投影 `op` 不透明度 `pad` 内距 `jc`/`ai` 主轴/交叉轴对齐 `flex:1` 撑开。',
    ...readingNotes,
    // 只描述实际发生的事：没折叠就不说折叠，否则模型会以为顶栏已交给宿主而漏写或重写
    chrome.topRoots.length
      ? `> 壳层规则：顶部${chrome.navTitle ? `导航栏（标题「${chrome.navTitle}」）` : '状态栏/导航栏'}已自动折叠，标题交宿主导航，禁在页面内手写渲染顶栏。`
      : '> 壳层规则：本屏没有识别到状态栏/导航栏块，顶栏按项目既有页面的做法处理，不要在页面里另写一套。',
    ...(chrome.bottomSafeNodes.size
      ? ['> 壳层规则：底部安全区占位条勿当图片渲染，统一转为吸底栏或滚动容器的 `safe-area-inset-bottom` 高度适配。']
      : []),
    '> 直接读本文件 + `screen-' + screenIndex + '.png` 出码；切图的文件名、像素、字节都在下方清单里，不用再读 `ir.json`、`manifest.json` 或列 `assets/` 目录。',
    '',
  ]

  if (contract) L.push(`> 拍板契约：${contract}`, '')

  if (bizAssets.size) {
    L.push('## 本屏业务切图（已剔除壳层、空白占位与弹层底图）', '')
    for (const [file, desc] of bizAssets) L.push(`- \`${file}\` — ${desc}`)
    L.push('')
  }
  if (iconAssets.size) {
    L.push('## 本屏图标（资源待用户提供：只按下面的尺寸与颜色写 CSS 占位）', '')
    L.push('> 图标不追求像素级还原，也不比对图标库：写 `width/height/border-radius`，单色再给 `color` 或占位底色。图标文件等用户提供——不手写 SVG、不翻图标库找相似的、不用图片脚本取色。', '')
    if (uiDoc) {
      L.push('> 页面结构里确实需要一个图标名时（例如状态图标），读 `.agents/skills/lanhu-dds-codegen/ui-library.md`——全部图标名与通用 props 都在里面，一次 `read` 就有；不要为此翻 `node_modules`。', '')
    }
    for (const [file, desc] of iconAssets) L.push(`- \`${file}\` — ${desc}`)
    L.push('')
  }

  if (groups.length) {
    L.push('## 组件候选（同父同宽重复结构）', '')
    L.push('| 父节点 | 次数 | 单块尺寸 | 单块节点 | 文案样本 |')
    L.push('|---|---|---|---|---|')
    for (const g of groups) {
      L.push(`| ${cellEsc(g.parentName)}(${g.parent}) | ${g.count} | ${g.width}×${g.height} | ${g.nodes} | ${cellEsc(g.texts.map((t) => `"${t}"`).join(' / '))} |`)
    }
    L.push('')
  }

  L.push('## 布局与样式树', '', '```text')
  let annotatedFirstContent = false
  const emittedBottomSafe = new Set()
  const emittedBottomSafeRects = new Set()

  const walk = (node, b) => {
    if (chrome.topNodeSet.has(node)) return
    if (chrome.bottomSafeNodes.has(node)) {
      if (!emittedBottomSafe.has(node)) {
        emittedBottomSafe.add(node)
        for (const k of b.kids) emittedBottomSafe.add(k)
        const sr = b.screenRect
        const rectKey = `${sr.x},${sr.y},${sr.w},${sr.h}`
        if (!emittedBottomSafeRects.has(rectKey)) {
          emittedBottomSafeRects.add(rectKey)
          L.push(`${'  '.repeat(Math.min(b.depth, 1))}# [底部安全区占位 ${sr.h}px 默认忽略切图] @(${sr.x},${sr.y} ${sr.w}×${sr.h}) — 勿渲染此图，请为吸底栏或滚动容器底部做 safe-area-inset-bottom 高度适配`)
        }
      }
      return
    }
    if (isEmptyLeafBox(b)) return

    const sr = b.screenRect
    const parent = b.parentNode ? boxes.get(b.parentNode) : null
    const sameAsParent = parent && b.rel.x === 0 && b.rel.y === 0 && sr.w === parent.screenRect.w && sr.h === parent.screenRect.h
    const outOfParentFullWidth = parent && b.depth >= 2 && b.rel.x < 0 && sr.w >= screenRect.w * 0.95 && parent.screenRect.w < screenRect.w * 0.95
    const tokens = []
    const uiTag = b.uiType && !/^(lanhu|block|text|image|$)/i.test(b.uiType) ? `[${b.uiType}]` : ''
    tokens.push(`${'  '.repeat(b.depth)}${b.name}${uiTag}`)
    tokens.push(`@(${sr.x},${sr.y} ${sr.w}×${sr.h})`)
    if (b.depth > 0) tokens.push(sameAsParent ? '=parent' : `rel(${b.rel.x},${b.rel.y})`)
    if (outOfParentFullWidth) tokens.push('[跨出父容器的全宽悬浮层]')
    if (!annotatedFirstContent && b.depth === 1 && chrome.topBottom > 0) {
      annotatedFirstContent = true
      tokens.push(`↑nav:${round(sr.y - chrome.topBottom)}`)
    } else if (b.gap) {
      // 大段留白多是固定高度稿里的摆放（真实数据里 240px 以上的间距全部是这种情况），写死 margin 会跟着屏高错
      const bigY = b.gap.axis === 'y' && b.gap.px >= 240 ? '[大段留白：多为固定高度稿的摆放，用 flex 撑开别写死]' : ''
      tokens.push(`${b.gap.axis === 'y' ? '↑gap:' : '←gap:'}${b.gap.px}${bigY}`)
    }

    const c = b.css
    if (b.kids.length > 0 && !b.compositeAsset?.file) {
      tokens.push(c.flexDirection === 'column' ? 'col' : 'row')
      if (c.justifyContent && c.justifyContent !== 'flex-start') tokens.push(`jc:${c.justifyContent}`)
      if (c.alignItems && c.alignItems !== 'stretch') tokens.push(`ai:${c.alignItems}`)
      if (c.flexWrap === 'wrap') tokens.push('wrap')
      const pad = formatPadding(c)
      if (pad) tokens.push(pad)
    }

    const bgGrad = [c.background, c.backgroundImage].find((v) => v && /gradient\(/i.test(v))
    if (bgGrad) {
      tokens.push(`bg:${cleanCssColorNoise(bgGrad)}`)
    } else if (c.background && !/url\(/i.test(c.background) && !isEffectivelyTransparent(c.background)) {
      tokens.push(`bg:${cleanCssColorNoise(c.background)}`)
    } else if (c.backgroundColor && !isEffectivelyTransparent(c.backgroundColor)) {
      tokens.push(`bg:${cleanCssColorNoise(c.backgroundColor)}`)
    }

    const rad = formatRadii(c)
    if (rad) tokens.push(rad)
    for (const bk of ['border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight']) {
      if (c[bk] && !isEffectivelyTransparent(c[bk])) tokens.push(`${bk}:${cleanCssColorNoise(c[bk])}`)
    }
    if (c.boxShadow) tokens.push(`sh:${cleanCssColorNoise(c.boxShadow)}`)
    if (c.opacity && c.opacity !== '1') tokens.push(`op:${c.opacity}`)

    if (b.type === 'lanhutext') {
      if (c.fontSize) tokens.push(`fs:${c.fontSize}`)
      if (c.fontWeight && c.fontWeight !== '400') tokens.push(`fw:${c.fontWeight}`)
      if (c.lineHeight) tokens.push(`lh:${c.lineHeight}`)
      tokens.push(b.colorMissing ? 'c:MISSING(看裁图)' : (c.color ? `c:${cleanCssColorNoise(c.color)}` : ''))
      if (c.WebkitBackgroundClip === 'text') tokens.push('grad-text')
      if (c.textAlign && c.textAlign !== 'left') tokens.push(`ta:${c.textAlign}`)
    }

    if (b.compositeAsset?.file) {
      const near = findNearestShortText(b, compiled, chrome.skipNodeSet)
      const nearNote = near ? ` near:"${near}"` : ''
      const advice = [tintNote(b.compositeAsset.tint), '图标占位，资源待用户提供'].filter(Boolean).join('，')
      tokens.push(`composite-icon:${b.compositeAsset.file}(${b.compositeAsset.pxWidth}×${b.compositeAsset.pxHeight}px)${nearNote}[${advice}]`)
    } else if (b.compositeHint) {
      tokens.push('[图标碎片：按本节点尺寸写 CSS 占位，资源待用户提供]')
    }

    if (b.asset?.status === 'ok') {
      const pxW = b.asset.pxWidth
      const pxH = b.asset.pxHeight
      const pxNote = pxW && pxH ? `(${pxW}×${pxH}px)` : ''
      if (b.asset.blank) {
        tokens.push(`img:${b.asset.file}${pxNote}[空白占位切图，勿渲染]`)
      } else if (b.depth === 0 && isPopupSheet) {
        tokens.push(`img:${b.asset.file}${pxNote}[弹层底层页面预览背景，勿当弹层内容渲染]`)
      } else {
        const nonEmptyKids = b.kids.filter((k) => {
          const kb = boxes.get(k)
          return kb && !isEmptyLeafBox(kb)
        })
        const isSmallIcon = sr.w <= 64 && sr.h <= 64 && nonEmptyKids.length === 0
        const iconHint = isSmallIcon ? `[图标占位${b.asset.tint ? ` ${tintNote(b.asset.tint)}` : ''}，资源待用户提供]` : ''
        const near = isSmallIcon ? findNearestShortText(b, compiled, chrome.skipNodeSet) : ''
        const nearNote = near ? ` near:"${near}"` : ''
        const isClippedLong = pxW > 0 && pxH > 0 && sr.w >= 200 && sr.h >= 200 && (pxH / pxW) > (sr.h / sr.w) * 1.25
        const longNote = isClippedLong ? '[完整长图被画布底边截断，按真实图片比例自然撑开]' : ''
        const srcNote = b.asset.source === 'cropped-from-reference' ? '(原图裁切)' : ''
        tokens.push(`img:${b.asset.file}${pxNote}${srcNote}${iconHint}${longNote}${nearNote}`)
      }
    } else if (b.asset?.status === 'placeholder') {
      // 下载失败和「文字压在背景图上」是两件事，混成一句话会让模型去修本来没坏的图
      const why = b.asset.reason === 'download-failed' ? '切图下载失败，用 CSS 底色或渐变兜底' : '文字叠加在背景图上，图不可用，用 CSS 兜底'
      tokens.push(`img:PLACEHOLDER(${sr.w}×${sr.h}，${why})`)
    }

    if (b.text) tokens.push(`"${b.text.replace(/\s+/g, ' ').slice(0, 80)}"`)
    L.push(tokens.filter(Boolean).join(' '))
    // 组合碎片小图标已整块预裁，内部半截碎片不再展开干扰模型
    if (b.compositeAsset?.file) return
    for (const k of b.kids) walk(k, boxes.get(k))
  }
  const treeStart = L.length
  walk(compiled.root, boxes.get(compiled.root))
  // 顶栏这条注释固定在根节点之后：它可能被设计器塞在任意层级的框里，跟着自身层级缩进会让人以为它是那个框的内容
  if (chrome.topRoots.length) {
    const titleNote = chrome.navTitle ? ` title:"${chrome.navTitle}"` : ''
    L.splice(treeStart + 1, 0, `${'  '}# [顶部导航壳层 默认忽略] @(0,0 ${screenRect.w}×${chrome.topBottom})${titleNote} — 仅将标题交宿主导航设置，勿手写渲染状态栏/返回/胶囊`)
  }
  L.push('```', '')
  return L.join('\n')
}
