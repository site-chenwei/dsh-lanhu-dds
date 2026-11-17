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
      L.push(`| ${g.parentName}(${g.parent}) | ${g.count} | ${g.width} × ${g.height} | ${g.nodes} | ${g.texts.map((t) => `"${t}"`).join(' / ')} |`)
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
    for (const k of rootBox.kids) {
      const b = boxes.get(k)
      if (!b) continue
      const sr = b.screenRect
      if (sr.x <= 4 && sr.w >= screenRect.w * 0.9 && sr.y <= 4 && sr.y + sr.h <= maxTopH) {
        const info = subtreeInfo(k)
        if ((info.hasClock || info.hasChromeHint) && info.texts.length <= 2) {
          topRoots.push(k)
          addSubtree(k, topNodeSet)
          topBottom = Math.max(topBottom, sr.y + sr.h)
          if (!navTitle && info.texts[0]) navTitle = info.texts[0]
        }
      } else if (
        topRoots.length === 1
        && sr.x <= 4
        && sr.w >= screenRect.w * 0.9
        && sr.y >= topBottom - 2
        && sr.y + sr.h <= maxTopH
      ) {
        const info = subtreeInfo(k)
        if (info.texts.length <= 1 && !/搜索|请输入/.test(info.texts[0] ?? '')) {
          topRoots.push(k)
          addSubtree(k, topNodeSet)
          topBottom = Math.max(topBottom, sr.y + sr.h)
          if (!navTitle && info.texts[0]) navTitle = info.texts[0]
        }
      } else {
        break
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
export function specMarkdown(compiled, groups, { title = '', unit = 'design', contract = '' } = {}) {
  const { boxes, root, screenRect, screenIndex } = compiled
  const chrome = detectScreenChrome(compiled)
  const rootBox = boxes.get(root)
  let minContentY = Infinity
  if (rootBox) {
    for (const k of rootBox.kids) {
      if (chrome.skipNodeSet.has(k)) continue
      const kb = boxes.get(k)
      if (kb) minContentY = Math.min(minContentY, kb.screenRect.y)
    }
  }
  const isPopupSheet = chrome.topRoots.length === 0 && minContentY >= screenRect.h * 0.2

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

  const L = [
    `# Screen ${screenIndex} — ${title || chrome.navTitle || '未命名'} (${screenRect.w}×${screenRect.h}, unit=${unit}, ${boxes.size} 节点)`,
    '',
    '> 坐标系：本屏左上角 `(0,0)`；`@(x,y w×h)` 为屏内位置，`rel(dx,dy)` 为相对父容器偏移（`=parent` 表示与父同框，勿重复叠加 padding），`↑gap` / `←gap` 为与上一兄弟间距，`↑nav` 为首块内容距顶部导航栏底边的间距。',
    '> 壳层规则：顶部状态栏/导航栏已自动折叠（仅将标题交宿主导航，禁在页面内手写渲染顶栏）；底部安全区占位条勿当图片渲染，统一转为吸底栏或滚动容器的 `safe-area-inset-bottom` 高度适配。',
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
    L.push('## 本屏小图标切图（<=64px；单色的换成图标库图标并按色值上色，图标库没有对应图标或标了多色的直接用切图）', '')
    for (const [file, desc] of iconAssets) L.push(`- \`${file}\` — ${desc}`)
    L.push('')
  }

  if (groups.length) {
    L.push('## 组件候选（同父同宽重复结构）', '')
    L.push('| 父节点 | 次数 | 单块尺寸 | 单块节点 | 文案样本 |')
    L.push('|---|---|---|---|---|')
    for (const g of groups) {
      L.push(`| ${g.parentName}(${g.parent}) | ${g.count} | ${g.width}×${g.height} | ${g.nodes} | ${g.texts.map((t) => `"${t}"`).join(' / ')} |`)
    }
    L.push('')
  }

  L.push('## 布局与样式树', '', '```text')
  let emittedTopChrome = false
  let annotatedFirstContent = false
  const emittedBottomSafe = new Set()
  const emittedBottomSafeRects = new Set()

  const walk = (node, b) => {
    if (chrome.topNodeSet.has(node)) {
      if (!emittedTopChrome) {
        emittedTopChrome = true
        const titleNote = chrome.navTitle ? ` title:"${chrome.navTitle}"` : ''
        L.push(`${'  '.repeat(b.depth)}# [顶部导航壳层 默认忽略] @(0,0 ${screenRect.w}×${chrome.topBottom})${titleNote} — 仅将标题交宿主导航设置，勿手写渲染状态栏/返回/胶囊`)
      }
      return
    }
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
      tokens.push(`${b.gap.axis === 'y' ? '↑gap:' : '←gap:'}${b.gap.px}`)
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
      const advice = b.compositeAsset.tint === 'multi' ? '多色，直接用此预裁整图' : `${tintNote(b.compositeAsset.tint) || '组合碎片'}，图标库有对应图标就换图标库，否则用此预裁整图`
      tokens.push(`composite-icon:${b.compositeAsset.file}(${b.compositeAsset.pxWidth}×${b.compositeAsset.pxHeight}px)${nearNote}[${advice}]`)
    } else if (b.compositeHint) {
      tokens.push('[组合碎片小图标：优先换图标库或语义占位，禁手写裁图脚本]')
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
        const iconHint = isSmallIcon ? `[图标候选${b.asset.tint ? ` ${tintNote(b.asset.tint)}` : ''}]` : ''
        const near = isSmallIcon ? findNearestShortText(b, compiled, chrome.skipNodeSet) : ''
        const nearNote = near ? ` near:"${near}"` : ''
        const isClippedLong = pxW > 0 && pxH > 0 && sr.w >= 200 && sr.h >= 200 && (pxH / pxW) > (sr.h / sr.w) * 1.25
        const longNote = isClippedLong ? '[完整长图被画布底边截断，按真实图片比例自然撑开]' : ''
        const srcNote = b.asset.source === 'cropped-from-reference' ? '(原图裁切)' : ''
        tokens.push(`img:${b.asset.file}${pxNote}${srcNote}${iconHint}${longNote}${nearNote}`)
      }
    } else if (b.asset?.status === 'placeholder') {
      tokens.push(`img:PLACEHOLDER(${sr.w}×${sr.h},文字叠加背景)`)
    }

    if (b.text) tokens.push(`"${b.text.replace(/\s+/g, ' ').slice(0, 80)}"`)
    L.push(tokens.filter(Boolean).join(' '))
    // 组合碎片小图标已整块预裁，内部半截碎片不再展开干扰模型
    if (b.compositeAsset?.file) return
    for (const k of b.kids) walk(k, boxes.get(k))
  }
  walk(compiled.root, boxes.get(compiled.root))
  L.push('```', '')
  return L.join('\n')
}
