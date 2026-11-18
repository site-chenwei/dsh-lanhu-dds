/** 屏间变体配对与差异表 variants-diff.md。 */

import { cleanCssColorNoise, detectScreenChrome } from './spec.mjs'

function nodeSig(b) {
  const sr = b.screenRect
  if (b.type === 'lanhutext' && b.text?.trim()) {
    const qx = Math.round(sr.x / 16) * 16
    return `lanhutext|${qx}|${b.text.trim().replace(/\s+/g, ' ').slice(0, 24)}`
  }
  const qx = Math.round(sr.x / 12) * 12
  const qw = Math.round(sr.w / 12) * 12
  const qh = Math.round(sr.h / 16) * 16
  // 渐变底色存在 backgroundImage 里；漏掉它，无底色的容器会和同尺寸的渐变按钮撞签名
  const gradient = /url\(/i.test(b.css.backgroundImage ?? '') ? '' : b.css.backgroundImage?.slice(0, 24)
  const tag = b.text ? b.text.trim().slice(0, 24) : cleanCssColorNoise(b.css.backgroundColor || b.css.background?.slice(0, 24) || gradient || '')
  return `${b.type}|${qx},${qw}x${qh}|${tag}`
}

function collectSampleTexts(b, boxes, limit = 4) {
  const out = []
  const walk = (x) => {
    if (out.length >= limit) return
    if (x.text?.trim()) out.push(x.text.trim().replace(/\s+/g, ' ').slice(0, 20))
    for (const k of x.kids) walk(boxes.get(k))
  }
  walk(b)
  return out
}

function topDiffBlocks(compiled, otherSigs, skipNodeSet, alsoMatched) {
  const { boxes, root } = compiled
  const diffs = []
  const subtreeStats = (node, b) => {
    let total = 0
    let hit = 0
    const walk = (n, x) => {
      if (skipNodeSet?.has(n)) return
      total++
      if (otherSigs.has(nodeSig(x)) || alsoMatched.has(x)) hit++
      for (const k of x.kids) walk(k, boxes.get(k))
    }
    walk(node, b)
    return { total, hit }
  }
  const visit = (node, b) => {
    if (skipNodeSet?.has(node)) return
    if (b.depth === 0) {
      for (const k of b.kids) visit(k, boxes.get(k))
      return
    }
    const { total, hit } = subtreeStats(node, b)
    if (total === 0 || hit === total) return
    if (hit / total < 0.35 || !b.kids.length) {
      const sr = b.screenRect
      const texts = collectSampleTexts(b, boxes)
      diffs.push(`- \`${b.name}\` @(${sr.x},${sr.y} ${sr.w}×${sr.h}, ${total}节点)${texts.length ? `：${texts.map((t) => `"${t}"`).join(' / ')}` : ''}`)
      return
    }
    for (const k of b.kids) visit(k, boxes.get(k))
  }
  visit(root, boxes.get(root))
  return diffs.slice(0, 16)
}

function prepare(e) {
  const chrome = detectScreenChrome(e.compiled)
  const sigs = new Set()
  const bizTexts = new Set()
  const texts = []
  let minContentY = Infinity
  for (const [node, b] of e.compiled.boxes) {
    if (b.depth === 0 || chrome.skipNodeSet.has(node)) continue
    sigs.add(nodeSig(b))
    if (b.depth === 1) minContentY = Math.min(minContentY, b.screenRect.y)
    const t = b.type === 'lanhutext' ? b.text?.trim().replace(/\s+/g, ' ') : ''
    if (!t) continue
    if (/^\d{1,2}:\d{2}$/.test(t)) continue
    if (!texts.includes(t)) texts.push(t)
    if (t.length >= 4) bizTexts.add(t)
  }
  const isPopupSheet = chrome.topRoots.length === 0 && minContentY >= e.compiled.screenRect.h * 0.2
  const navTitle = (chrome.navTitle || e.title || '').trim()
  return { ...e, chrome, sigs, bizTexts, texts, isPopupSheet, navTitle }
}

/**
 * 识别「同一页面的不同状态变体」（如详情页 vs 规格弹窗、确认页无地址 vs 有地址）：
 * 先剔除顶部状态栏/导航栏与底部安全区公共壳，再按同导航标题/弹层态与结构重合度配对，杜绝把不同路由页误配成变体。
 */
function pairScreens(prepared) {
  const pairs = []
  for (let j = 1; j < prepared.length; j++) {
    const B = prepared[j]
    if (B.sigs.size < 4) continue
    let best = null
    for (let i = 0; i < j; i++) {
      const A = prepared[i]
      if (A.sigs.size < 4) continue
      if (Math.abs(A.compiled.screenRect.w - B.compiled.screenRect.w) > 4) continue
      let shared = 0
      for (const s of A.sigs) if (B.sigs.has(s)) shared++
      const ratio = shared / Math.min(A.sigs.size, B.sigs.size)

      const bothFullPagesWithNav = !A.isPopupSheet && !B.isPopupSheet && A.chrome.topRoots.length > 0 && B.chrome.topRoots.length > 0
      const sameTitle = Boolean(A.navTitle && B.navTitle && A.navTitle === B.navTitle)
      // 两屏都是带顶栏的独立页面且导航标题不同（如「实物黄金商城」vs「所有商品」vs「积存金兑换」），除非主体结构 >=85% 一致，否则属于不同路由页
      if (bothFullPagesWithNav && A.navTitle && B.navTitle && !sameTitle && ratio < 0.85) continue

      let sharedBizText = 0
      for (const t of A.bizTexts) if (B.bizTexts.has(t)) sharedBizText++
      const popupOverlayPair = (A.isPopupSheet !== B.isPopupSheet) && sharedBizText >= 1 && ratio >= 0.25
      const minRatio = sameTitle ? 0.25 : 0.65

      if ((ratio >= minRatio || popupOverlayPair) && (!best || ratio > best.ratio)) {
        best = { A, B, ratio, shared }
      }
    }
    if (best) pairs.push(best)
  }
  return pairs
}

const TEXT_LIMIT = 40

/**
 * 选屏阶段的全画布摘要（纯内存，不落盘）：每屏去壳去重后的业务文案 + 是否弹层，
 * 以及按结构推断的「同一页面」分组。拍板「屏 → 页面文件」映射只需要这些，不必先编译。
 */
export function digestScreens(entries) {
  const prepared = entries.map(prepare)
  const groupOf = new Map(prepared.map((p) => [p, [p]]))
  for (const { A, B } of pairScreens(prepared)) {
    const ga = groupOf.get(A)
    const gb = groupOf.get(B)
    if (ga === gb) continue
    for (const p of gb) { ga.push(p); groupOf.set(p, ga) }
  }
  const idx = (p) => p.compiled.screenIndex
  const groups = [...new Set(groupOf.values())]
  const pageGroups = groups.filter((g) => g.some((p) => !p.isPopupSheet))
  const pages = pageGroups.map((g) => ({ title: g.find((p) => !p.isPopupSheet).navTitle, screens: g.map(idx).sort((a, b) => a - b), group: g }))
  // 纯弹层组挂到与它共享业务文案的页面上；设计师习惯把弹层排在所属页面右侧，所以优先取左侧最近的页面
  for (const g of groups) {
    if (pageGroups.includes(g)) continue
    const first = Math.min(...g.map(idx))
    const owners = pages.filter((pg) => pg.group.some((p) => g.some((q) => [...q.bizTexts].some((t) => p.bizTexts.has(t)))))
    const before = owners.filter((pg) => pg.screens[0] < first)
    const owner = before.at(-1) ?? owners[0]
    if (owner) (owner.popups ??= []).push(...g.map(idx))
    else pages.push({ title: g[0].navTitle, screens: g.map(idx).sort((a, b) => a - b), popupOnly: true, group: g })
  }
  return {
    screens: prepared.map((p) => ({
      index: idx(p),
      popup: p.isPopupSheet,
      texts: p.texts.slice(0, TEXT_LIMIT).map((t) => t.slice(0, 40)),
      ...(p.texts.length > TEXT_LIMIT ? { moreTexts: p.texts.length - TEXT_LIMIT } : {}),
    })),
    pages: pages.map(({ group: _g, ...rest }) => rest).sort((a, b) => a.screens[0] - b.screens[0]),
  }
}

/** 规格表里用的同一套缩写，保证差异表与 screen-N.spec.md 能逐项对上。 */
function comparableProps(b) {
  const c = b.css
  const sr = b.screenRect
  return {
    w: sr.w,
    h: sr.h,
    gap: b.gap ? `${b.gap.axis === 'y' ? '↑' : '←'}${b.gap.px}` : undefined,
    fs: c.fontSize,
    fw: c.fontWeight,
    lh: c.lineHeight,
    c: c.color && cleanCssColorNoise(c.color),
    bg: cleanCssColorNoise([c.backgroundImage, c.background, c.backgroundColor].find((v) => v && !/url\(/i.test(v)) ?? '') || undefined,
    r: c.borderRadius,
    text: b.text?.trim().replace(/\s+/g, ' ') || undefined,
  }
}

const PROP_DIFF_LIMIT = 30

/**
 * 把两屏的节点配成「同一个元素」。第 0 轮按「同型同深同名同父名」：变体屏多从同一母版复制
 * 而来，名字与层级会保留——弹层整体加高/下移时签名与近邻都配不上（y 和 h 变了），名字没变。
 * 只信名字会被独立绘制的空态/有数据屏坑到（两屏同名节点位置尺寸全异），所以加 x/宽与
 * 「顶或底至少一头对齐」的护栏：真变体的移动要么顶部锚定、要么吸底加高，两头都漂的不配。
 * 第一轮按签名：签名为了容忍 ±2px 微调放宽了分桶，不含纵坐标，所以内容整体下移的变体也配得上。
 * 第二轮收剩下的：同文案换了位置（右对齐的值随字号左移），或左上角没动但换了文案/底色/高度
 * （「立即购买」→「立即兑换」、弹层头部换底色）——不配上它们，差异表会把一处改动拆成
 * 「仅在 A」「仅在 B」两条，或者因为子节点全相同而整条不报。同位置的文本还要求字号相同：
 * 字号和文案都变了的多半是两个元素（价格 → 「兑换价差」标签）。
 */
function matchNodes(A, B) {
  const live = (P) => [...P.compiled.boxes].filter(([node, b]) => b.depth !== 0 && !P.chrome.skipNodeSet.has(node)).map(([, b]) => b)
  const pairs = []
  const matchedA = new Set()
  const matchedB = new Set()
  const restA = []
  const keyOf = (P, b) => `${b.type}|${b.depth}|${P.compiled.boxes.get(b.parentNode)?.name ?? ''}|${b.name}`
  const byKey = new Map()
  for (const b of live(B)) {
    const k = keyOf(B, b)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(b)
  }
  for (const a of live(A)) {
    const b = (byKey.get(keyOf(A, a)) ?? []).find((x) => !matchedB.has(x)
      && Math.abs(a.screenRect.x - x.screenRect.x) <= 24
      && Math.abs(a.screenRect.w - x.screenRect.w) <= 24
      && (Math.abs(a.screenRect.y - x.screenRect.y) <= 24
        || Math.abs(a.screenRect.y + a.screenRect.h - (x.screenRect.y + x.screenRect.h)) <= 24))
    if (b) { matchedA.add(a); matchedB.add(b); pairs.push([a, b]) } else restA.push(a)
  }
  const restB = new Set(live(B).filter((b) => !matchedB.has(b)))
  const bySig = new Map()
  for (const b of restB) {
    const sig = nodeSig(b)
    if (!bySig.has(sig)) bySig.set(sig, [])
    bySig.get(sig).push(b)
  }
  for (const a of restA) {
    const b = bySig.get(nodeSig(a))?.shift()
    if (b) {
      matchedA.add(a)
      matchedB.add(b)
      pairs.push([a, b])
      restB.delete(b)
    }
  }
  const norm = (x) => x.text?.trim().replace(/\s+/g, ' ') ?? ''
  const off = (a, b, k) => Math.abs(a.screenRect[k] - b.screenRect[k])
  const isText = (x) => x.type === 'lanhutext'
  const near = (a, b) => off(a, b, 'x') <= 12 && off(a, b, 'y') <= 12
    && (isText(a) ? a.css.fontSize === b.css.fontSize : off(a, b, 'w') <= 16)
  const sameText = (a, b) => isText(a) && norm(a) !== '' && norm(a) === norm(b)
  const cost = (a, b) => off(a, b, 'x') + off(a, b, 'y') + off(a, b, 'w') + off(a, b, 'h')
  for (const same of [sameText, near]) {
    for (const a of restA) {
      if (matchedA.has(a)) continue
      let best = null
      for (const b of restB) {
        if (b.type !== a.type || !same(a, b)) continue
        if (!best || cost(a, b) < cost(a, best)) best = b
      }
      if (!best) continue
      restB.delete(best)
      matchedA.add(a)
      matchedB.add(best)
      pairs.push([a, best])
    }
  }
  // 返回的 lateA/lateB 当 alsoMatched 用：第 0/二轮配上的节点签名对不上，不在集合里会被误报成「仅在某一屏」
  return { pairs: pairs.sort((p, q) => p[0].idx - q[0].idx), lateA: matchedA, lateB: matchedB }
}

function propDiffRows(pairs) {
  const rows = []
  for (const [a, b] of pairs) {
    const pa = comparableProps(a)
    const pb = comparableProps(b)
    const diffs = Object.keys(pa).filter((k) => String(pa[k] ?? '') !== String(pb[k] ?? ''))
    if (!diffs.length) continue
    // 文案与渐变色值里常带竖线，不转义会把表格撑错列
    const cell = (t) => String(t).replace(/\|/g, '\\|')
    const label = pa.text ? ` "${cell(pa.text.slice(0, 16))}"` : ''
    rows.push(`| \`${a.name}\` / \`${b.name}\`${label} | ${cell(diffs.map((k) => `${k}:${pa[k] ?? '无'}`).join(' '))} | ${cell(diffs.map((k) => `${k}:${pb[k] ?? '无'}`).join(' '))} |`)
  }
  return rows
}

export function buildVariantsDiff(entries) {
  if (!entries || entries.length < 2) return { pairs: [], markdown: '' }
  const prepared = entries.map(prepare)
  const pairs = pairScreens(prepared)
  if (!pairs.length) return { pairs: [], markdown: '' }
  const L = [
    '# 屏间状态变体差异（variants-diff）',
    '',
    '> 下列屏对共享主体结构，通常是**同一个页面/路由的不同状态或弹层**（如空地址 vs 有地址、基础页 vs 底部弹窗），建议合在同一页面组件内按状态/弹层实现，不要拆成两份重复页面。',
    '> 口径：本表的「仅在某屏」与节点计数都按**去壳后**的活节点算（剔除状态栏/导航栏/底部安全区），与 `ir.json` 的全量节点数差几个壳层节点属正常；文案相同或尺寸相同但结构不同的元素会在两侧各列一条，也属正常（以两份规格表为准）。',
    '',
  ]
  const identical = []
  const kept = []
  for (const { A, B, ratio } of pairs) {
    const matched = matchNodes(A, B)
    const onlyA = topDiffBlocks(A.compiled, B.sigs, A.chrome.skipNodeSet, matched.lateA)
    const onlyB = topDiffBlocks(B.compiled, A.sigs, B.chrome.skipNodeSet, matched.lateB)
    const rows = propDiffRows(matched.pairs)
    // 两屏一模一样（只有导航标题不同）：写成一节「无独有子树」等于什么都没说，交给 report 明说「同一套布局」
    if (!onlyA.length && !onlyB.length && !rows.length) {
      identical.push({
        a: A.compiled.screenIndex, b: B.compiled.screenIndex,
        titleA: A.title || A.navTitle || '', titleB: B.title || B.navTitle || '',
      })
      continue
    }
    kept.push({ A, B, ratio })
    const pct = Math.round(ratio * 100)
    L.push(`## Screen ${A.compiled.screenIndex}（${A.title || A.navTitle || '未命名'}） ↔ Screen ${B.compiled.screenIndex}（${B.title || B.navTitle || '未命名'}） — 去壳结构重合 ${pct}%`, '')
    L.push(`### 仅在 Screen ${A.compiled.screenIndex}（${A.compiled.screenRect.w}×${A.compiled.screenRect.h}）`)
    L.push(...(onlyA.length ? onlyA : ['- （无独有子树，Screen B 为其超集/弹层叠加）']), '')
    L.push(`### 仅在 Screen ${B.compiled.screenIndex}（${B.compiled.screenRect.w}×${B.compiled.screenRect.h}）`)
    L.push(...(onlyB.length ? onlyB : ['- （无独有子树）']), '')
    if (rows.length) {
      L.push('### 同一元素的属性差（两屏都有、数值不同）', '')
      L.push(`| 节点（Screen ${A.compiled.screenIndex} / Screen ${B.compiled.screenIndex}） | Screen ${A.compiled.screenIndex} | Screen ${B.compiled.screenIndex} |`, '|---|---|---|')
      L.push(...rows.slice(0, PROP_DIFF_LIMIT))
      if (rows.length > PROP_DIFF_LIMIT) L.push('', `> 另有 ${rows.length - PROP_DIFF_LIMIT} 处属性差未列出，以两份规格表为准。`)
      L.push('')
    }
  }
  return { pairs: kept, identical, markdown: kept.length ? L.join('\n') : '' }
}
