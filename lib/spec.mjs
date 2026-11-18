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
        // 高度差超过 2 倍的不是同一组件：全宽节点（顶部横幅/吸底栏）按宽度会撞进同一桶，靠高度比排掉
        if (Math.max(...hs) > Math.max(1, Math.min(...hs)) * 2) continue
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

export function specMarkdown(compiled, groups, { title = '', unit = 'design', contract = '', unitDiv = 1, designWidth = 0, uiDoc = false, raster = false, pngReady = true } = {}) {
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

  // 同一个切图既当小图标又当大图出现时只留在图标清单里：两处都列会让人以为有两份资源
  for (const f of iconAssets.keys()) bizAssets.delete(f)

  // 报告要与规格表同口径统计图标数：把本次真正进清单的文件挂回编译结果，report 直接取用
  compiled.iconFiles = [...iconAssets.keys()]

  // 树序 ≠ 视觉序检测（DDS 按图层面板顺序导出，视觉主体可能排在背景层之后）：
  // ① 同父可见兄弟对里，树序更晚者与更早者矩形交叠 ≥ 小者面积 1/4 —— 记「后者画在前者之上」；
  // ② 某块的 ↑gap（≥100px）区间被树序更晚的任何节点盖住过半 —— 这个 gap 不是真留白。
  const gapCovered = (b) => {
    if (b.gap?.axis !== 'y' || b.gap.px < 100) return false
    const top = b.screenRect.y - b.gap.px
    const spans = []
    for (const [node, nb] of boxes) {
      if (nb.depth === 0 || nb.idx <= b.idx || chrome.skipNodeSet.has(node)) continue
      const s = nb.screenRect
      const lo = Math.max(top, s.y)
      const hi = Math.min(b.screenRect.y, s.y + s.h)
      if (hi > lo) spans.push([lo, hi])
    }
    spans.sort((p, q) => p[0] - q[0])
    let covered = 0
    let cur = null
    for (const [lo, hi] of spans) {
      if (!cur || lo > cur[1]) { if (cur) covered += cur[1] - cur[0]; cur = [lo, hi] }
      else cur[1] = Math.max(cur[1], hi)
    }
    if (cur) covered += cur[1] - cur[0]
    return covered >= b.gap.px * 0.5
  }
  const overlapFacts = []
  const compositeFacts = []
  const visibleKids = (b) => b.kids
    .map((k) => [k, boxes.get(k)])
    .filter(([k, kb]) => kb && !chrome.skipNodeSet.has(k) && !folded.has(k) && !isEmptyLeafBox(kb))
    .map(([, kb]) => kb)
  for (const b of boxes.values()) {
    const kids = visibleKids(b)
    for (let i = 0; i < kids.length && overlapFacts.length < 6; i++) {
      const si = kids[i].screenRect
      for (let j = i + 1; j < kids.length && overlapFacts.length < 6; j++) {
        const sj = kids[j].screenRect
        const ox = Math.min(si.x + si.w, sj.x + sj.w) - Math.max(si.x, sj.x)
        const oy = Math.min(si.y + si.h, sj.y + sj.h) - Math.max(si.y, sj.y)
        const minArea = Math.min(si.w * si.h, sj.w * sj.h)
        if (ox <= 4 || oy <= 4 || minArea < 16 || ox * oy < minArea * 0.25) continue
        // 双叶子的交叠几乎都是 DDS 把一行内多个 run 拆成兄弟（货币符+数字、不同色高亮、小图标+文字）：
        // 它们是同一行的片段，按 inline 组合，不是上下两层。真层叠至少有一侧是容器
        if (!kids[i].kids.length && !kids[j].kids.length) {
          if (compositeFacts.length < 4) compositeFacts.push(`\`${kids[i].name}\`+\`${kids[j].name}\`（${round(ox)}×${round(oy)} 交叠）`)
        } else {
          overlapFacts.push(`\`${kids[j].name}\` 画在 \`${kids[i].name}\` 之上（交叠 ${round(ox)}×${round(oy)}）`)
        }
      }
    }
    for (const kb of kids) {
      if (overlapFacts.length >= 6) break
      if (kb.gap?.axis === 'y' && kb.gap.px >= 100 && gapCovered(kb)) {
        overlapFacts.push(`\`${kb.name}\` 的 ↑gap:${kb.gap.px} 被树序更晚的节点盖住，不是真留白`)
      }
    }
  }

  // 三处数字之间的换算关系规格表本身没说清，模型照字面写会错：行高与图层高不等价、
  // 文本宽/←gap 是实测文字宽的派生量、多层 rel 要累加。只在真的存在时才出这几行，避免每屏都灌规则。
  const allBoxes = [...boxes.values()]
  const hasText = allBoxes.some((b) => b.type === 'lanhutext' && b.text)
  const lhDiffs = []
  let lhSamples = []
  // 树里第一块 depth=1 的内容：它的纵向距离印成 ↑nav，行高例子要跟着叫同一个名字
  let firstContentBox = null
  for (const [node, b] of boxes) {
    // 与 walk 的「第一块内容」判据保持一致：壳层、被折叠的底板不算，否则 ↑nav 会落到空盒上
    if (b.depth !== 1 || chrome.skipNodeSet.has(node) || isEmptyLeafBox(b)) continue
    if (!firstContentBox || b.idx < firstContentBox.idx) firstContentBox = b
  }
  for (const [node, b] of boxes) {
    if (b.type !== 'lanhutext' || !b.text) continue
    if (chrome.skipNodeSet.has(node)) continue // 壳层里的时间/导航标题不算版式证据
    const fs = Number.parseFloat(b.css.fontSize)
    const lhRaw = String(b.css.lineHeight ?? '')
    // line-height 写成 px 时 parseFloat 拿到的是像素值，当成倍数乘字号会算出几百倍的差
    const lhPx = /px/i.test(lhRaw) ? Number.parseFloat(lhRaw) : Number.parseFloat(lhRaw) * fs
    if (!Number.isFinite(fs) || !Number.isFinite(lhPx) || lhPx <= 0) continue
    // 多行文案要和「行数 × 行盒」比：直接拿单行行盒去减会得出 −80 这种没意义的数，整段被筛掉
    const lines = Math.max(1, Math.round(b.screenRect.h / lhPx))
    const dRaw = lhPx * lines - b.screenRect.h
    const d = Math.round(dRaw)
    if (d >= 2 && d <= 40) {
      lhDiffs.push(Math.round(dRaw * 10) / 10)
      // 例子要带真实数字：文字的纵向间距记在父行上（文字自己是行内的），所以取父行的 ↑gap。
      // 扣完变负数的不举例（会教模型写负 margin）；也只在「这一行的高度就是它撑起来的」时举例——
      // 同一行里还有更高的兄弟时，行高由那个兄弟决定，把差额算到行距上是错的（第五轮 F2）
      const par = b.parentNode ? boxes.get(b.parentNode) : null
      const parKidHs = par
        ? par.kids.filter((k) => boxes.has(k) && !chrome.skipNodeSet.has(k) && !isEmptyLeafBox(boxes.get(k))).map((k) => boxes.get(k).screenRect.h)
        : []
      const drivesRow = parKidHs.length > 0 && b.screenRect.h >= Math.max(...parKidHs) - 1
      if (!lhSamples.length && drivesRow && par?.gap?.axis === 'y' && par.gap.px - dRaw >= 0) {
        // 首块内容的父行在树里标 ↑nav（与导航栏底边的距离），不是 ↑gap：照抄标签会让人去搜不存在的行
        const isNavRow = chrome.topBottom > 0 && par.depth === 1 && par === firstContentBox
        const label = isNavRow ? '↑nav' : '↑gap'
        const val = isNavRow ? Math.round(par.screenRect.y - chrome.topBottom) : par.gap.px
        // 例子里的 margin 不取整：同一条提示后面写着「算出 30.4 就写 30.4」，例子先抹成 30 会自打嘴巴
        const one = (n) => Math.round(n * 10) / 10
        lhSamples = [`例如父行 ${label}:${val}、本行 line-height ${one(lhPx)}、图层高 ${b.screenRect.h} → margin 取 ${one(val - dRaw)}`]
      }
    }
  }
  // 反向情况：图层比行盒高（标题、多行文案常见）。照抄 height 会与 line-height 打架
  const tallDiffs = []
  for (const [node, b] of boxes) {
    if (b.type !== 'lanhutext' || !b.text) continue
    if (chrome.skipNodeSet.has(node)) continue
    const fs = Number.parseFloat(b.css.fontSize)
    const lhRaw = String(b.css.lineHeight ?? '')
    const lhPx = /px/i.test(lhRaw) ? Number.parseFloat(lhRaw) : Number.parseFloat(lhRaw) * fs
    if (!Number.isFinite(fs) || !Number.isFinite(lhPx) || lhPx <= 0) continue
    const lines = Math.max(1, Math.round(b.screenRect.h / lhPx))
    const dRaw = b.screenRect.h - lhPx * lines
    const d = Math.round(dRaw)
    if (d >= 4 && d <= 40) tallDiffs.push(Math.round(dRaw * 10) / 10)
  }
  const lhTiers = lhDiffs.length
    ? [...new Set(lhDiffs)]
        .sort((a, b) => lhDiffs.filter((x) => x === b).length - lhDiffs.filter((x) => x === a).length)
        .map((d) => `+${d}px×${lhDiffs.filter((x) => x === d).length}`)
        .join('、')
    : ''
  const spaceBetweenRows = allBoxes.some((b) => b.css.justifyContent === 'space-between' && b.css.flexDirection !== 'column')
  // 弹层/整页容器用 jc:space-between 且底部空出的高度正好等于安全区占位高度：那点空隙是安全区内缩，
  // 当间距摊开会让中间块下移、底部按钮贴到屏底（第五轮 F4）
  const safeRects = [...chrome.bottomSafeNodes].map((n) => boxes.get(n)?.screenRect).filter(Boolean)
  const safeInsetBoxes = []
  for (const b of boxes.values()) {
    if (safeInsetBoxes.length >= 2) break
    if (b.css.justifyContent !== 'space-between' || b.css.flexDirection === 'row' || !b.kids.length) continue
    const kidHs = b.kids
      .filter((k) => boxes.has(k) && !chrome.skipNodeSet.has(k) && !isEmptyLeafBox(boxes.get(k)))
      .map((k) => boxes.get(k).screenRect.h)
    if (!kidHs.length) continue
    const used = kidHs.reduce((a, n) => a + n, 0)
    const leftover = b.screenRect.h - used
    const bottom = b.screenRect.y + b.screenRect.h
    const hits = safeRects.some((r) => Math.abs(r.y + r.h - bottom) <= 4 && Math.abs(r.h - leftover) <= 4)
    if (leftover >= 40 && hits) safeInsetBoxes.push({ name: b.name, leftover, used, h: b.screenRect.h })
  }
  // 容器与直接子块的纵向内距（DDS 不导出 padding，只能由 rect 反推）：上 = 首块顶 − 盒顶 − 上边框，
  // 下 = 盒底 − 末块底 − 下边框。只报差额不够——「差额÷2 上下各减」只对上下对称的容器成立，
  // 只有底部内距的（吸底栏、弹层）和 jc:center 的容器方向完全不同，照「写 padding-bottom」会把内容整块推下去。
  const pxOf = (v) => {
    const m = String(v ?? '').match(/(\d+(?:\.\d+)?)px/)
    return m ? Number(m[1]) : 0
  }
  const containerInsets = []
  for (const [node, b] of boxes) {
    if (b.depth === 0 || !b.kids.length || chrome.skipNodeSet.has(node) || isEmptyLeafBox(b)) continue
    const kids = b.kids.filter((k) => boxes.has(k) && !chrome.skipNodeSet.has(k) && !isEmptyLeafBox(boxes.get(k)))
    if (!kids.length) continue
    const rects = kids.map((k) => boxes.get(k).screenRect)
    const bt = pxOf(b.css.borderTop) || pxOf(b.css.border)
    const bb = pxOf(b.css.borderBottom) || pxOf(b.css.border)
    const padTop = round(Math.min(...rects.map((r) => r.y)) - b.screenRect.y - bt)
    const padBottom = round(b.screenRect.y + b.screenRect.h - Math.max(...rects.map((r) => r.y + r.h)) - bb)
    if (padTop < -2 || padBottom < -2) continue // 子块溢出父容器：交给负偏移提示
    if (padTop + padBottom <= 4) continue
    containerInsets.push({ name: b.name, padTop, padBottom, border: round(Math.max(bt, bb)) })
  }
  const insetLabel = (c) =>
    c.padTop >= 2 && c.padBottom >= 2
      ? c.padTop === c.padBottom
        ? `上下各 ${c.padTop}`
        : `上 ${c.padTop}、下 ${c.padBottom}`
      : c.padBottom >= 4
        ? `只在下 ${c.padBottom}`
        : `只在上 ${c.padTop}`
  const insetBorders = containerInsets.filter((c) => c.border > 0)
  const hasBoxHeight = allBoxes.some((b) => b.depth > 0 && b.kids.length > 0 && b.css.height)
  const nestedRel = allBoxes.some((b) => b.depth >= 2 && b.rel && (b.rel.x || b.rel.y) && (() => {
    const par = b.parentNode ? boxes.get(b.parentNode) : null
    return Boolean(par?.rel && (par.rel.x || par.rel.y))
  })())
  const readingNotes = [
    ...(overlapFacts.length
      ? [`> 树序提示：本屏的兄弟顺序 ≠ 视觉顺序（DDS 按图层面板顺序导出，视觉主体可能排在背景层之后）——${overlapFacts.slice(0, 4).join('；')}。` +
          '出码别按树的先后排文档流：先按 `@y/@x` 重排可见内容；互相叠的按视觉关系处理——背景层（渐变/大图）当作视觉容器的 `background`，内容层正常文档流，蒙层/贴片用绝对定位；被盖住的 `↑gap` 不是真留白；完全嵌在另一盒里的节点改写成视觉父级的子节点。']
      : []),
    ...(compositeFacts.length
      ? [`> 同行拆分提示：${compositeFacts.slice(0, 4).join('、')} 是**同一行被 DDS 拆开的多个片段**（货币符+数字、不同色文字、小图标+文字），矩形相同或贴边是导出惯例：当一行内的 inline 内容组合（基线/垂直居中对齐），不要当上下两层、更不要用绝对定位叠起来。`]
      : []),
    ...(tallDiffs.length
      ? [`> 文字盒高度提示：${tallDiffs.length} 处文字的图层高比它的行盒大 ${Math.min(...tallDiffs) === Math.max(...tallDiffs) ? `${Math.min(...tallDiffs)}` : `${Math.min(...tallDiffs)}–${Math.max(...tallDiffs)}`}px（标题、多行文案常见）。` +
        '照抄 `height` 会和 `line-height` 打架：按行盒写 `line-height`，多出来的高度用上下 `padding` 各补一半，或者让父容器 flex 居中。']
      : []),
    ...(containerInsets.length
      ? [`> 容器尺寸提示：\`@(x,y w×h)\` 是设计稿实测值；DDS 不导出内距，下面是反推出来的「容器与直接子块的纵向内距」：` +
        `${containerInsets.slice(0, 4).map((c) => `\`${c.name}\` ${insetLabel(c)}`).join('、')}` +
        `${containerInsets.length > 4 ? `（本屏共 ${containerInsets.length} 个容器有内距，这里只列前 4 个；没列到的按同样办法从树行 \`@(x,y w×h)\` 与子块 \`rel()\` 自己反推，别只写点名的这几个）` : ''}。` +
        '按内距写 `padding-top`/`padding-bottom`（上下相同就写 `padding` 简写），别用 `justify-content` 去摊——内容一增减就把间距全摊歪' +
        `${insetBorders.length
          ? (() => {
              const lo = Math.min(...insetBorders.map((c) => c.border))
              const hi = Math.max(...insetBorders.map((c) => c.border))
              const range = lo === hi ? `${lo}px` : `${lo}–${hi}px`
              return insetBorders.length === containerInsets.length
                ? `；上面数值已扣掉容器自己的单边边框（${range}），别再额外补边框宽度`
                : `；带边框的容器已扣掉自己的单边边框（${range}），别再额外补边框宽度`
            })()
          : ''}。` +
        '内距约 0 的容器就是内容撑开，按子节点还原、别写死 `height`；上下都约 0 却空出一大块的容器才是定高摆放，写 `height` 更像素级接近设计稿，但要保留的旧功能往里加内容会溢出，那种情况改 `min-height` 自己排。' +
        '这些内距是按**图层高**量的：紧贴单行文本的那一层，写之前先按行高提示扣掉「档位÷2」（行盒比图层高大，扣完才是最终的 `padding`），其余层照这里写；两者说的是同一层的同一笔内距，不要各写一半。']
      : hasBoxHeight
        ? ['> 容器尺寸提示：`@(x,y w×h)` 是设计稿实测值。本屏容器的上下内距都可忽略，说明 `@h` 就是内容撑出来的：按子节点还原、别写死 `height`（写死之后文案一变长就溢出）。']
        : []),
    ...(hasText && lhDiffs.length
      ? [`> 行高提示：${lhDiffs.length} 处单行文字的行高（字号×行高）比图层高大，分档：${lhTiers}。` +
        '`↑gap`/`↑nav` 都是按图层高算的，写 `line-height` 之后要补两处，否则容器会被撑高：兄弟间距 = `↑gap` − 对应文字所在档位的数值' +
        `${lhSamples[0] ? `（${lhSamples[0]}）` : ''}；` +
        '容器定高时，只把紧贴文本行那一层的上下内距各减「该行档位÷2」——这里的内距就是容器尺寸提示给的那个值，扣完才是最终 `padding`（档位是近似值，像素级对齐用例子里的精确 margin；相邻两行文字按各自档位各扣一半，首末行各补差额的一半；外层容器的内距不要再减，否则会少一截）。' +
        '扣减结果别取整（算出 30.4 就写 30.4）；多行文字的容器最后按 `@h` 回量核对。']
      : []),
    ...(spaceBetweenRows
      ? ['> 派生尺寸提示：文本节点的 `w` 与 `←gap` 是按文字实测宽度算出来的（`jc:space-between` 的行里尤其如此），照抄会写死宽度、文案一变长就溢出；按字号与左右对齐写，整行用 flex + `justify-content: space-between`。值可能变长的那一列（金额、克数、数量）加 `text-overflow: ellipsis; white-space: nowrap; overflow: hidden`，别让它把行撑高。`ta` 只在盒子明显宽于文字（`w` 比文字实测宽大出一截）时才有意义；宽度就等于文字宽的节点上 `ta` 是空转，左右位置由 flex 决定，不要再叠。']
      : []),
    ...(nestedRel
      ? ['> 内距提示：DDS 不导出内距（`pad:` 基本不出现），内距只能由 `rel()` 与盒尺寸反推；`rel()` 相对父节点，多层都要累加（父 `rel(24,24)` + 子 `rel(0,24)` → 纵向 48）。']
      : []),
    ...(safeInsetBoxes.length
      ? [`> 底部内缩提示：${safeInsetBoxes.map((b) => `\`${b.name}\`（子块合计 ${b.used}、容器 ${b.h}，空出 ${b.leftover}）`).join('、')}用的是 \`jc:space-between\`，但空出的高度正好是底部安全区：这点空隙不是可摊开的间距，别用 space-between 去复现——给容器写 \`padding-bottom: ${safeInsetBoxes[0].leftover}px\`（或 \`env(safe-area-inset-bottom)\`），子块按 0 间距顺序排。`]
      : []),
    ...([...boxes.entries()].some(([node, b]) => b.depth > 0 && b.rel && (b.rel.x <= -8 || b.rel.y <= -8) && !chrome.skipNodeSet.has(node))
      // 不能一律教「父容器 overflow:hidden」：通栏吸底栏/横幅的父容器常常比它窄，裁剪会切掉它伸出边界的那一截
      ? ['> 负偏移提示：`rel()` 的 dx/dy 为负的节点画在父容器边界之外，按两种情形处置——①装饰圆、悬浮角标这类小贴片：用绝对定位，父容器按需 `overflow: hidden`；②宽度超过父容器的通栏层（横幅、吸底栏、通栏图）：同样绝对定位或提到父级渲染，但**不要裁剪**，`overflow: hidden` 会把伸出去的那一截切掉。两种都别当普通流内子节点排，否则会把上方内容顶开。']
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
      // designWidth 为 0 表示项目没给基准（unit:css 时靠切图倍率折算）：写成「项目 0 基准的 2 倍」是在编数字
      // unit:css 的除数来自切图倍率而非项目基准，即便传了 designWidth 也不能说成「按它的基准」
      ? ['', `> 坐标归一：本屏实测宽 ${Math.round(screenRect.w * unitDiv)}px，${unit !== 'css' && designWidth > 0 ? `项目基准 ${designWidth}px` : `切图倍率 @${Math.round(unitDiv * 1000) / 1000}x`}，本表所有数值已 ÷${Math.round(unitDiv * 1000) / 1000}，可直接写进代码（切图尺寸是原图 px，需按同一比例理解）。`]
      : []),
    '',
    '> 坐标系：本屏左上角 `(0,0)`；`@(x,y w×h)` 为屏内位置，`rel(dx,dy)` 为相对父容器偏移（`=parent` 表示与父同框，勿重复叠加 padding），`↑gap` / `←gap` 为与上一兄弟间距，`↑nav` 为首块内容距顶部导航栏底边的间距。',
    '> 记号：`fs` 字号 `fw` 字重 `lh` 行高 `c` 文字色（`c:MISSING(看裁图)` = DDS 没给，按裁图取）`grad-text` 渐变文字（颜色来自 background-image，别再写 `color`）`ta` 水平对齐 `bg` 背景 `r` 圆角 `border:`/`borderTop:`/`borderBottom:`/`borderLeft:`/`borderRight` 描边（树行直接用该属性名，没有 `bd` 缩写；`border:` 是 DDS 的边框属性，不等于四边都有线——相邻卡片之间那条 1px 分隔线会被记成两张卡的 `border`，按 `screen-N.png` 确认真正有线的是哪一边，只写单边时加 `box-sizing: border-box` 保住 `@h` 里的那 1px）`sh` 投影 `op` 不透明度 `pad` 内距 `jc`/`ai` 主轴/交叉轴对齐 `flex:1` 撑开。',
    ...readingNotes,
    // 只描述实际发生的事：没折叠就不说折叠，否则模型会以为顶栏已交给宿主而漏写或重写
    chrome.topRoots.length
      ? `> 壳层规则：顶部${chrome.navTitle ? `导航栏（标题「${chrome.navTitle}」）` : '状态栏/导航栏'}已自动折叠，标题交宿主导航，禁在页面内手写渲染顶栏。`
      : '> 壳层规则：本屏没有识别到状态栏/导航栏块，顶栏按项目既有页面的做法处理，不要在页面里另写一套。',
    ...(chrome.bottomSafeNodes.size
      ? ['> 壳层规则：底部安全区占位条勿当图片渲染，统一转为吸底栏或滚动容器的 `safe-area-inset-bottom` 高度适配。']
      : []),
    pngReady && (bizAssets.size || iconAssets.size)
      ? `> 直接读本文件 + \`screen-${screenIndex}.png\` 出码；切图的文件名、像素、字节都在下方清单里，不用再读 \`ir.json\`、\`manifest.json\` 或列 \`assets/\` 目录。`
      : pngReady
        ? `> 直接读本文件 + \`screen-${screenIndex}.png\` 出码；本屏没有可下载切图（图片与图标全部走样式/CSS 占位），不用再读 \`ir.json\`、\`manifest.json\` 或列 \`assets/\` 目录。`
        : (bizAssets.size || iconAssets.size)
          ? `> 直接读本文件出码；本次没裁参考图（\`screen-${screenIndex}.png\` 不在产物里），颜色与细节以本表数值为准；切图按下方清单的文件名与像素处理，要像素级对照先重跑 build 补参考图。`
          : `> 直接读本文件出码；本次没裁参考图、也没有已下载切图：数值照本表，图片与图标写 CSS 占位，需要图先重跑 build。`,
    '',
  ]

  if (contract) L.push(`> 拍板契约：${contract}`, '')

  if (bizAssets.size) {
    L.push('## 本屏业务切图（已剔除壳层、空白占位、弹层底图与上面列过的图标）', '')
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
    if ([...iconAssets.values()].some((d) => d.includes('多色'))) {
      L.push('', '> 标「多色」的图标常带选中/未选中两套（同形不同色）：按 `screen-N.png` 的裁图确认主色与状态，别拿同形节点的灰色占位顶替——那样几张卡会长得一模一样、状态丢失，而这种丢失 rect 与尺寸比对查不出来。')
    }
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
          // 缩进必须跟节点自己的 depth 一致：印浅一级会让紧随其后的兄弟看起来是它的子节点，
          // 而 SKILL 要求「忽略安全区占位」，读者一删就把后面的真实内容一起删掉
          // 占位行不参与排版，可它到上一个兄弟的距离是真实留白（键盘/吸底容器里常见）：不印出来，
          // 模型会把安全区高度直接当 padding，整块内容下移一截
          const safeGap = b.gap?.axis === 'y' && b.gap.px > 0 ? ` ↑gap:${b.gap.px}` : ''
          L.push(`${'  '.repeat(b.depth)}# [底部安全区占位 ${sr.h}px 默认忽略切图] @(${sr.x},${sr.y} ${sr.w}×${sr.h})${safeGap} — 勿渲染此图，请为吸底栏或滚动容器底部做 safe-area-inset-bottom 高度适配`)
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
      // gap 区间被树序更晚的节点盖住时它不是留白（主体层排在背景层之后），别再标大段留白
      const bigY = b.gap.axis === 'y' && b.gap.px >= 240 && !gapCovered(b) ? '[大段留白：多为固定高度稿的摆放，用 flex 撑开别写死]' : ''
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

    if (b.text) tokens.push(`"${b.text.replace(/\s+/g, ' ').replace(/"/g, '\\"').slice(0, 80)}"`)
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
