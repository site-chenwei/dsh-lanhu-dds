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
  const tag = b.text ? b.text.trim().slice(0, 24) : cleanCssColorNoise(b.css.backgroundColor || b.css.background?.slice(0, 24) || '')
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

function topDiffBlocks(compiled, otherSigs, skipNodeSet = null) {
  const { boxes, root } = compiled
  const diffs = []
  const subtreeStats = (node, b) => {
    let total = 0
    let hit = 0
    const walk = (n, x) => {
      if (skipNodeSet?.has(n)) return
      total++
      if (otherSigs.has(nodeSig(x))) hit++
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

/**
 * 多屏编译时自动识别「同一页面的不同状态变体」（如详情页 vs 规格弹窗、确认页无地址 vs 有地址），
 * 先剔除顶部状态栏/导航栏与底部安全区公共壳，再按同导航标题/弹层态与结构重合度配对，杜绝把不同路由页误配成变体。
 */
export function buildVariantsDiff(entries) {
  if (!entries || entries.length < 2) return { pairs: [], markdown: '' }
  const prepared = entries.map((e) => {
    const chrome = detectScreenChrome(e.compiled)
    const sigs = new Set()
    const bizTexts = new Set()
    const rootBox = e.compiled.boxes.get(e.compiled.root)
    const firstContentKid = rootBox?.kids.map((k) => e.compiled.boxes.get(k)).find((b) => b && !chrome.skipNodeSet.has(rootBox.kids[rootBox.kids.indexOf(b)]))
    let minContentY = Infinity
    for (const [node, b] of e.compiled.boxes) {
      if (b.depth === 0 || chrome.skipNodeSet.has(node)) continue
      sigs.add(nodeSig(b))
      if (b.depth === 1) minContentY = Math.min(minContentY, b.screenRect.y)
      if (b.type === 'lanhutext' && b.text?.trim() && b.text.trim().length >= 4) {
        bizTexts.add(b.text.trim().replace(/\s+/g, ' '))
      }
    }
    const isPopupSheet = chrome.topRoots.length === 0 && minContentY >= e.compiled.screenRect.h * 0.2
    const navTitle = (chrome.navTitle || e.title || '').trim()
    return { ...e, chrome, sigs, bizTexts, isPopupSheet, navTitle, firstContentKid }
  })

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

  if (!pairs.length) return { pairs: [], markdown: '' }
  const L = [
    '# 屏间状态变体差异（variants-diff）',
    '',
    '> 下列屏对共享主体结构，通常是**同一个页面/路由的不同状态或弹层**（如空地址 vs 有地址、基础页 vs 底部弹窗），建议合在同一页面组件内按状态/弹层实现，不要拆成两份重复页面。',
    '',
  ]
  for (const { A, B, ratio } of pairs) {
    const pct = Math.round(ratio * 100)
    L.push(`## Screen ${A.compiled.screenIndex}（${A.title || A.navTitle || '未命名'}） ↔ Screen ${B.compiled.screenIndex}（${B.title || B.navTitle || '未命名'}） — 去壳结构重合 ${pct}%`, '')
    const onlyA = topDiffBlocks(A.compiled, B.sigs, A.chrome.skipNodeSet)
    const onlyB = topDiffBlocks(B.compiled, A.sigs, B.chrome.skipNodeSet)
    L.push(`### 仅在 Screen ${A.compiled.screenIndex}（${A.compiled.screenRect.w}×${A.compiled.screenRect.h}）`)
    L.push(...(onlyA.length ? onlyA : ['- （无独有子树，Screen B 为其超集/弹层叠加）']), '')
    L.push(`### 仅在 Screen ${B.compiled.screenIndex}（${B.compiled.screenRect.w}×${B.compiled.screenRect.h}）`)
    L.push(...(onlyB.length ? onlyB : ['- （无独有子树）']), '')
  }
  return { pairs, markdown: L.join('\n') }
}
