/** DDS 树的遍历、几何读取与「一张画布里有哪几台手机屏」的识别。 */

import { round, decodeEntities } from './util.mjs'

/** 合成包装节点 id：row_/col_/rect_ 开头，无对应 Figma 源，命名与语义都要特殊处理。 */
export const isSynthetic = (n) => /^(row|col|rect)_/.test(String(n.id ?? ''))

// ---------------------------------------------------------------- 树遍历

export function preorder(root, fn, depth = 0, parent = null) {
  fn(root, depth, parent)
  for (const c of root.children ?? []) preorder(c, fn, depth + 1, root)
}

export function nodeRect(n, scale) {
  const d = n.rowDims ?? {}
  // 归一后的 scale 是小数（1404→750 即 1.872）：设计稿像素取整，别把 57.69px 这类值写进规格表
  const q = Number.isInteger(scale) ? round : Math.round
  return {
    x: q(Number(d.left ?? 0) / scale),
    y: q(Number(d.top ?? 0) / scale),
    w: q(Number(d.width ?? 0) / scale),
    h: q(Number(d.height ?? 0) / scale),
  }
}

/** 把一屏里的节点编号（前序），给每层一种语义化短名：nav / list / card / text / img。 */
export function nameOf(n, idx) {
  const t = String(n.type ?? '')
  const ui = String(n.uiType ?? '')
  if (t === 'lanhupage') return 'screen'
  if (/image/i.test(t) || /image/i.test(ui)) return `img-${idx}`
  if (/text/i.test(t) && !(n.children ?? []).length) return `text-${idx}`
  return `box-${idx}`
}

// ---------------------------------------------------------------- 屏幕（帧）识别

/** 设备像素矩形（不做缩放），用于在未知 scale 时先找屏。 */
export function rawRect(n) {
  const d = n.rowDims ?? {}
  return { x: Number(d.left ?? 0), y: Number(d.top ?? 0), w: Number(d.width ?? 0), h: Number(d.height ?? 0) }
}

/** 内容占满力：最宽的直接子节点 / 自身宽。手机屏里的状态栏、底栏、卡片几乎都按屏宽铺满（≈1）；展示板上放手机时，最宽的子节点就是那台手机，值只有 0.5 上下。 */
function contentFill(n, rect) {
  if (!rect.w) return 0
  let max = 0
  for (const c of n.children ?? []) max = Math.max(max, rawRect(c).w)
  return max / rect.w
}

/** 这块子树里有没有状态栏时钟（不看位置）。用来判「时钟是它自己的，还是在它包住的手机里」。 */
function ownsClock(n) {
  let found = false
  preorder(n, (x) => {
    if (found || !x.data?.value || !/text/i.test(String(x.type ?? ''))) return
    if (/^\d{1,2}:\d{2}$/.test(decodeEntities(x.data.value).trim())) found = true
  })
  return found
}

/** 这块子树里有没有状态栏时钟（不看位置）——不含 `skip`（里面那台手机）的子树。 */
function ownsClockOutside(n, skip) {
  let found = false
  const walk = (x) => {
    if (found || x === skip) return
    if (x.data?.value && /text/i.test(String(x.type ?? '')) && /^\d{1,2}:\d{2}$/.test(decodeEntities(x.data.value).trim())) { found = true; return }
    for (const k of x.children ?? []) walk(k)
  }
  walk(n)
  return found
}

/** 屏顶 8% 的纵向区间里有没有状态栏时钟（`9:41`）。真机截图的时钟一定贴着屏顶；展示板上的时钟跟着手机一起下沉。 */
function hasStatusClock(n, rect) {
  const limit = rect.y + rect.h * 0.08
  let found = false
  preorder(n, (x) => {
    if (found || !x.data?.value || !/text/i.test(String(x.type ?? ''))) return
    if (!/^\d{1,2}:\d{2}$/.test(decodeEntities(x.data.value).trim())) return
    if (Number(x.rowDims?.top ?? 0) <= limit) found = true
  })
  return found
}

/**
 * 一张设计大板里通常横排 N 台手机屏。屏本身是「窄而高」的矩形，在设备像素域就能认出来：
 * 手机逻辑宽几乎总是 375，所以 屏宽/375 就是缩放比（@2x=750、@3x=1125）。
 * 先把候选按宽度分组取众数，避免把里层的卡片/弹窗误判成屏。
 *
 * 展示板（灰底 + 标题牌 + 一台居中的手机 + 图注）也落在手机的宽高区间里，只按「最浅一层」会把它当屏：
 * 于是画布注释进了布局树、手机只占一半宽、所有数值是真实值的 0.5 倍。所以候选先过一道「像不像一台手机」：
 * 内容铺满宽度，或顶部贴着状态栏时钟——展示板上这两条都不成立（最宽子节点就是手机本身，时钟在 20% 处）。
 * 过滤后一个不剩时退回原规则，保证这条判据不认识的设计稿仍按老办法出结果。
 */
export function detectScaleAndScreens(root) {
  const cands = []
  preorder(root, (n, depth) => {
    const r = rawRect(n)
    if (!(n.children ?? []).length) return
    if (r.w < 320 || r.w > 1800) return
    if (r.h < 450 || r.h > 6500) return
    if (r.w >= r.h) return
    cands.push({ node: n, depth, raw: r })
  })

  // 一个候选都挑不出来时只能整块当一屏：宁可出「画布当屏」的规格表，也不能返回空屏或抛错
  const rootFallback = () => {
    const r = rawRect(root)
    const scale = Number((r.w / 375).toFixed(2))
    return { scale: Math.abs(scale - Math.round(scale)) < 0.08 ? Math.round(scale) : 2, screens: [{ node: root, depth: 0, raw: r, index: 0, fallback: true }] }
  }

  if (!cands.length) return rootFallback()

  const deviceLike = cands.filter((c) => contentFill(c.node, c.raw) >= 0.85 || hasStatusClock(c.node, c.raw))
  const pool = deviceLike.length ? deviceLike : cands
  // 页面帧才有的类型；真实画布上屏本身常是 lanhubox、里面反而套着 lanhupage 的内容帧，
  // 所以它只用来给「同一矩形」的两个候选分高下，不能拿来整体筛候选（筛一次 gold 就从 10 屏变 18 屏）
  const isFrame = (c) => /lanhupage|artboard|frame|^screen$/i.test(String(c.node?.type ?? ''))
  // 屏不可能被另一个屏包住，所以「不被别的候选包含」才是屏。原先只取最浅一层，
  // 遇到设计器把几帧打一层行容器分组（深度不同）时会把除最浅那帧之外的整块漏掉。
  // 等大也要算包含：设计器常给一帧套一层同尺寸的包装，两边都不算「更大」时会各出一屏
  const encloses = (o, c) =>
    o !== c
    && o.raw.w >= c.raw.w && o.raw.h >= c.raw.h
    && c.raw.x >= o.raw.x - 2 && c.raw.y >= o.raw.y - 2
    && c.raw.x + c.raw.w <= o.raw.x + o.raw.w + 2
    && c.raw.y + c.raw.h <= o.raw.y + o.raw.h + 2
    && (o.raw.w > c.raw.w || o.raw.h > c.raw.h || o.depth < c.depth)
  const insideOf = (o, c, slack) =>
    c.raw.x >= o.raw.x - slack && c.raw.y >= o.raw.y - slack
    && c.raw.x + c.raw.w <= o.raw.x + o.raw.w + slack && c.raw.y + c.raw.h <= o.raw.y + o.raw.h + slack
  const overlaps = (a, b) => !(a.raw.x + a.raw.w <= b.raw.x || b.raw.x + b.raw.w <= a.raw.x
    || a.raw.y + a.raw.h <= b.raw.y || b.raw.y + b.raw.h <= a.raw.y)
  // 展示板：自己是个页面帧，里面还并列摆着 ≥2 个互不重叠的页面帧——它装的是几张屏，不是一屏
  // 里面的帧还得占它一半以上宽度（同一尺寸的手机并排/上下叠、展示板里那台 750 在 1100 板上），
  // 才说明它装的是几张屏；一屏里的内容块也是并列的页面帧，但只有 335/750 = 0.45，不能据此判成展示板
  const boards = new Set(pool.filter((c) => {
    const kids = pool.filter((o) => o !== c && insideOf(c, o, 4) && o.raw.w >= c.raw.w * 0.5)
    return kids.length >= 2 && kids.some((a, i) => kids.some((b, k) => k > i && !overlaps(a, b)))
  }))
  const stage = boards.size && boards.size < pool.length ? pool.filter((c) => !boards.has(c)) : pool
  // 同一矩形（含 ±2px 容差）的两个候选：留页面帧、丢包装层/分组盒，屏宽才不会被容器的 752 带走
  const sameRect = (a, b) => Math.abs(a.raw.x - b.raw.x) <= 2 && Math.abs(a.raw.y - b.raw.y) <= 2
    && Math.abs(a.raw.w - b.raw.w) <= 4 && Math.abs(a.raw.h - b.raw.h) <= 4 && a.depth !== b.depth
  // 机身里放一块比机身更高的滚动内容（750×1200 在 750×900 里）：两个方向都包不住，
  // 但「同宽、同起点、更高」只可能是机身的内容，屏还是机身
  const overflows = (o, c) => o !== c && o.depth < c.depth
    && Math.abs(o.raw.x - c.raw.x) <= 2 && Math.abs(o.raw.w - c.raw.w) <= 4
    && o.raw.y <= c.raw.y + 2 && c.raw.h > o.raw.h + 2
  // 顺序要紧：先按「溢出内容」剔掉深层块，再做包含去重。
  // 反过来的话机身会被那块更高的内容判成「被包含」，两边互删，top 变空后取 best[0] 直接崩
  const stage2 = stage.filter((c) => !stage.some((o) => overflows(o, c)))
  const kept = (stage2.length ? stage2 : stage)
  // 再做「同一矩形只留页面帧」：包装层与分组盒的宽高会顶替真屏（752 的屏宽就是这么来的）
  const framed = kept.filter((c) => !kept.some((o) => o !== c && isFrame(o) && !isFrame(c) && sameRect(o, c)))
  const finalPool = framed.length ? framed : kept
  // 包装层：只包着一个页面帧、四边各宽出 ≤60px、自己又没有状态栏时钟——它只是分组盒，屏还是那个帧
  const unwrapped = finalPool.map((c) => {
    const inner = finalPool.filter((o) => o !== c && isFrame(o) && insideOf(c, o, 8))
    if (inner.length !== 1) return c
    const f = inner[0]
    const marginX = f.raw.x - c.raw.x
    const marginY = f.raw.y - c.raw.y
    const marginR = c.raw.x + c.raw.w - (f.raw.x + f.raw.w)
    const marginB = c.raw.y + c.raw.h - (f.raw.y + f.raw.h)
    if (Math.max(marginX, marginY, marginR, marginB) > 60) return c
    // 外框的时钟如果只存在于帧里面，那说明它是包着一台手机的分组盒/画布，不是屏
    const outerOwns = ownsClockOutside(c.node, f.node)
    return outerOwns ? c : f
  })
  // 替换后会出现同一个节点两份（画布自己 + 被换成的手机），按对象去重
  const uniqWrapped = [...new Set(unwrapped)]
  const contains = uniqWrapped.filter((c) => !uniqWrapped.some((o) => o !== c && encloses(o, c)))

  // 两个方向都包不住、又不是溢出内容的那种：整块盖在同位置的浮层（设计稿里弹层帧常整块压在页面帧上）。
  // 按「重叠面积占较小者 ≥90%」判，只收拾更深的那个——浅的那层才是页面。
  const overlapRatio = (a, b) => {
    const x1 = Math.max(a.raw.x, b.raw.x)
    const y1 = Math.max(a.raw.y, b.raw.y)
    const x2 = Math.min(a.raw.x + a.raw.w, b.raw.x + b.raw.w)
    const y2 = Math.min(a.raw.y + a.raw.h, b.raw.y + b.raw.h)
    if (x2 <= x1 || y2 <= y1) return 0
    return ((x2 - x1) * (y2 - y1)) / Math.min(a.raw.w * a.raw.h, b.raw.w * b.raw.h)
  }
  // 只收拾「更深的那个」：设计稿里弹层帧常整块压在页面帧上（同层、同矩形），
  // 那是两个状态而不是两层，按同层聚簇会把弹层删掉
  const top = contains.filter((c) => !contains.some((o) => o !== c
    && o.depth < c.depth
    && o.raw.w >= c.raw.w - 2
    && overlapRatio(o, c) >= 0.9))

  // 按宽度（取整到 10px）分组，取数量最多的一组当「屏宽」
  const byWidth = new Map()
  for (const c of top) {
    const k = Math.round(c.raw.w / 10) * 10
    if (!byWidth.has(k)) byWidth.set(k, [])
    byWidth.get(k).push(c)
  }
  let best = [...byWidth.values()]
    .sort((a, b) => b.length - a.length || Math.min(...a.map((c) => c.raw.x)) - Math.min(...b.map((c) => c.raw.x)))[0]
  // 各种去重规则叠在一起时有互相删空的可能（曾经因为溢出块与机身互删而崩在这里）
  if (!best?.length) return rootFallback()
  const width = best[0].raw.w

  // 宽度校验：同一批屏应该等宽等高，容差外就退回「最靠左的那一批」
  best = best.filter((c) => Math.abs(c.raw.w - width) <= 2)
  // 展示板兜底（灰底铺满 + 一张标题牌 + 居中一台手机）：它的灰底让它看起来「内容铺满」，
  // 于是自己也进了候选，而里面只有一台手机、构不成「≥2 帧并列」。这里用「帧外还有东西」把它换回手机。
  best = best.map((c) => {
    const inner = cands
      .filter((o) => o !== c && isFrame(o) && insideOf(c, o, 6) && o.raw.w >= 320)
      .sort((a, b) => b.raw.w * b.raw.h - a.raw.w * a.raw.h)[0]
    if (!inner) return c
    const areaRatio = (inner.raw.w * inner.raw.h) / (c.raw.w * c.raw.h)
    // 帧外还有别的直接子节点（标题牌、图注）：板上那台手机才是屏，这块是画布
    const outside = (c.node.children ?? []).some((k) => {
      if (k === inner.node) return false
      const r = rawRect(k)
      if (r.w <= 0) return false
      const inside = r.x >= inner.raw.x - 4 && r.y >= inner.raw.y - 4
        && r.x + r.w <= inner.raw.x + inner.raw.w + 4 && r.y + r.h <= inner.raw.y + inner.raw.h + 4
      return !inside
    })
    // 展示板一定比里面那台手机宽：屏里的内容帧与屏同宽（750 机身里套 750×1300 的滚动帧），
    // 少了这条判断，屏会被换成它的内容帧，屏高少掉一截
    if (inner.raw.w > c.raw.w - 8) return c
    const bigger = c.raw.w - inner.raw.w >= 8 || c.raw.h - inner.raw.h >= 8
    // 画布比手机只大 8px 时面积比是 0.98，光看比例换不过来；这时看「谁像手机」——有状态栏时钟的才是
    // 「有状态栏时钟」要算它自己的：画布把手机顶到边缘时，手机的时钟也落在画布顶部 8% 里
    const outerLooks = ownsClockOutside(c.node, inner.node)
    const innerLooks = ownsClockOutside(inner.node, null)
    if (outside && areaRatio < 0.7) return inner
    // 板上只有这台手机、什么都没有：画布比手机大一圈（Figma 画板留白/投影边距）时也换成手机，
    // 否则画布的标题注释会被当成业务文案，屏宽也会大出一截
    if (bigger && (areaRatio < 0.9 || (!outerLooks && innerLooks))) return inner
    return c
  })
  best.sort((a, b) => a.raw.x - b.raw.x || a.raw.y - b.raw.y)

  let scale = Math.round(width / 375)
  if (scale < 1 || scale > 4 || Math.abs(width / scale - 375) > 6) {
    // 不是标准 375 逻辑宽（例如 414 / 390 设计），退化为「高度最像一屏」的整数比
    scale = [2, 3, 1, 4].sort((a, b) => Math.abs(width / a - 375) - Math.abs(width / b - 375))[0]
  }
  return { scale, screens: best.map((c, i) => ({ ...c, index: i })) }
}

/** 兼容旧签名：给已定好的 scale 找屏。 */
export function findScreens(root, scale) {
  const { screens } = detectScaleAndScreens(root)
  return screens.map((s, i) => ({ ...s, index: i, rect: { x: round(s.raw.x / scale), y: round(s.raw.y / scale), w: round(s.raw.w / scale), h: round(s.raw.h / scale) } }))
}

/** 一屏的「身份特征」：标题文案 + 节点数 + 是否整图不可矢量。用于让模型选屏。 */
export function describeScreen(s, scale) {
  const rect = s.rect ?? { x: round(s.raw.x / scale), y: round(s.raw.y / scale), w: round(s.raw.w / scale), h: round(s.raw.h / scale) }
  const texts = []
  let nodes = 0
  preorder(s.node, (n) => {
    nodes++
    if (!n.data?.value || !/text/i.test(String(n.type ?? ''))) return
    const t = decodeEntities(n.data.value).trim()
    // 状态栏时间是壳层，混进文案清单会让模型以为要把它写进页面
    if (t && !/^\d{1,2}:\d{2}$/.test(t)) texts.push(t)
  })
  const raster = isRasterScreen(s.node)
  // 标题：优先取屏上部 18% 区域里、长度 2–14、不像时间的文案（导航栏标题最稳）
  const navLimit = rect.h * 0.18
  const navTexts = []
  preorder(s.node, (n) => {
    if (!n.data?.value || !/text/i.test(String(n.type ?? ''))) return
    const t = decodeEntities(n.data.value).trim()
    const y = Number(n.rowDims?.top ?? 0) / scale - rect.y
    if (!t || t.length < 2 || t.length > 14) return
    if (/^\d{1,2}:\d{2}$/.test(t)) return
    if (y >= 0 && y <= navLimit) navTexts.push(t)
  })
  return {
    index: s.index,
    x: rect.x, y: rect.y, width: rect.w, height: rect.h,
    nodes, raster,
    title: navTexts[0] ?? texts.find((t) => t.length > 1 && t.length < 24) ?? '',
    texts: texts.slice(0, 8),
  }
}

/** 整屏只有一张整图（DDS 没有下钻）——这类屏无法靠 DDS 还原，必须走视觉/OCR。 */
function isRasterScreen(node) {
  let count = 0
  preorder(node, () => count++)
  if (count <= 1) return true
  // 只有一个子节点时，只有它是图片才算整图屏；空盒子是空框，不能说成「整张位图」
  if (count === 2) return /image/i.test(String((node.children ?? [])[0]?.type ?? ''))
  const kids = node.children ?? []
  if (kids.length === 1 && /image/i.test(String(kids[0].type ?? ''))) {
    let inner = 0
    preorder(kids[0], () => inner++)
    return inner <= 2
  }
  return false
}
