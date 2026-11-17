/** 单屏编译：DDS 节点 → 带屏内坐标与 CSS 的盒模型（所有数值直接取自 DDS）。 */

import { round, decodeEntities, cssEsc } from './util.mjs'
import { isSynthetic, preorder, nodeRect, nameOf, rawRect } from './dds-tree.mjs'

// ---------------------------------------------------------------- 尺寸与字体

const PX_NUMBER_KEYS = new Set([
  'width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'fontSize', 'lineHeight', 'letterSpacing', 'borderRadius',
  'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'textIndent', 'textShadow', 'outline', 'outlineOffset',
])

const WEIGHT_NAMES = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300,
  regular: 400, normal: 400, book: 400, roman: 400,
  medium: 500, demibold: 600, semibold: 600, bold: 700,
  extrabold: 800, heavy: 900, black: 900,
}

/** "PingFang SC-Semibold" → { family:'PingFang SC', weight:600 }；含逗号的直传字体栈原样保留。 */
function parseFont(raw) {
  if (!raw || /undefined/i.test(String(raw))) return {}
  const s = String(raw).trim()
  if (s.includes(',')) return { stack: s }
  const i = s.lastIndexOf('-')
  if (i <= 0) return { family: s }
  const family = s.slice(0, i).trim()
  const tail = s.slice(i + 1).trim().toLowerCase().replace(/\s+/g, '')
  if (WEIGHT_NAMES[tail]) return { family, weight: WEIGHT_NAMES[tail] }
  if (/^\d{3}$/.test(tail)) return { family, weight: Number(tail) }
  return { family: s }
}

export const FAMILY_KEY = (f) => 'font-' + f.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

/** Windows 上没有 PingFang SC，中文要靠雅黑兜底；这里统一给出跨平台栈。 */
export function familyStack(family) {
  const f = cssEsc(family)
  const win = /^(pingfang|hiragino|\.sf|sf pro)/i.test(family) ? ', "Microsoft YaHei"' : ''
  return `"${f}"${win}, "Microsoft YaHei", system-ui, -apple-system, "Segoe UI", sans-serif`
}

const CSS_ENUM = {
  display: { flex: 'flex', block: 'block', none: 'none', inline: 'inline', 'inline-block': 'inline-block', grid: 'grid' },
  flexDirection: { row: 'row', column: 'column', 'row-reverse': 'row-reverse', 'column-reverse': 'column-reverse', horizontal: 'row', vertical: 'column' },
  justifyContent: { 'flex-center': 'center', center: 'center', 'flex-start': 'flex-start', start: 'flex-start', 'flex-end': 'flex-end', end: 'flex-end', 'space-between': 'space-between', 'space-around': 'space-around', 'space-evenly': 'space-evenly' },
  alignItems: { 'flex-center': 'center', center: 'center', start: 'flex-start', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' },
  textAlign: { justified: 'justify', justify: 'justify', start: 'left', end: 'right', left: 'left', right: 'right', center: 'center' },
  whiteSpace: { nowrap: 'nowrap', normal: 'normal', 'pre-wrap': 'pre-wrap' },
  overflow: { hidden: 'hidden', visible: 'visible', auto: 'auto', scroll: 'scroll' },
  position: { absolute: 'absolute', relative: 'relative', fixed: 'fixed', static: 'static' },
  backgroundSize: {},
}

const COPY_TEXT = ['borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius',
  'borderBottomLeftRadius', 'borderBottomRightRadius', 'backgroundColor', 'backgroundImage', 'background', 'backgroundSize', 'backgroundPosition',
  'backgroundRepeat', 'border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'boxShadow',
  'opacity', 'zIndex', 'transform', 'filter', 'WebkitBackgroundClip', 'WebkitTextFillColor',
  'overflowWrap', 'wordBreak', 'textDecorationLine', 'textTransform', 'textShadow', 'mixBlendMode']

// ---------------------------------------------------------------- 单屏编译

export function compileScreen(ddsRoot, screenNode, { scale, mode = 'abs', screenIndex = 0 }) {
  const parentOf = new Map()
  preorder(ddsRoot, (n, _d, p) => { if (p) parentOf.set(n, p) })

  const nodes = []
  const warnings = []
  let i = 0
  preorder(screenNode, (n, depth) => {
    nodes.push({ node: n, depth, idx: i++ })
  })

  const origin = nodeRect(nodes[0].node, scale)
  const boxes = new Map()
  for (const { node, depth, idx } of nodes) {
    const rect = nodeRect(node, scale)
    const parent = depth === 0 ? null : (parentOf.get(node) ?? screenNode)
    // 单屏画布时屏节点就是根节点自己：深 0 只能以自身为基准，否则 rel 会把根容器的位置重复累加一次
    const parentRect = parent ? nodeRect(parent, scale) : rect
    boxes.set(node, {
      idx,
      depth,
      id: String(node.id ?? ''),
      layerId: String(node.layerId ?? ''),
      type: String(node.type ?? ''),
      uiType: String(node.uiType ?? ''),
      eleName: String(node.eleName ?? ''),
      synthetic: isSynthetic(node),
      raw: rawRect(node),
      rect,
      screenRect: {
        x: round(rect.x - origin.x),
        y: round(rect.y - origin.y),
        w: rect.w,
        h: rect.h,
      },
      // abs 模式：坐标转为相对父级，父级自身被裁切时才会继承 overflow 语义
      rel: {
        x: round(rect.x - parentRect.x),
        y: round(rect.y - parentRect.y),
      },
      parentNode: depth > 0 ? parent : null,
      kids: [],
    })
    if (parent && boxes.get(parent)) boxes.get(parent).kids.push(node)
  }

  for (const b of boxes.values()) {
    for (let k = 1; k < b.kids.length; k++) {
      const prev = boxes.get(b.kids[k - 1])
      const cur = boxes.get(b.kids[k])
      if (cur.screenRect.y >= prev.screenRect.y + prev.screenRect.h - 1) {
        cur.gap = { axis: 'y', px: round(cur.screenRect.y - (prev.screenRect.y + prev.screenRect.h)) }
      } else if (cur.screenRect.x >= prev.screenRect.x + prev.screenRect.w - 1) {
        cur.gap = { axis: 'x', px: round(cur.screenRect.x - (prev.screenRect.x + prev.screenRect.w)) }
      }
    }
  }

  for (const { node, depth, idx } of nodes) {
    const b = boxes.get(node)
    const r = b.rect
    const style = node.props?.style ?? {}
    const kids = b.kids
    const isText = String(node.type ?? '') === 'lanhutext'
    const isImage = String(node.type ?? '') === 'lanhuimage'
    const hasKids = kids.length > 0
    const text = isText ? decodeEntities(node.data?.value ?? '') : ''

    const css = {}
    css.width = `${r.w}px`
    css.height = `${r.h}px`

    if (mode === 'abs') {
      css.position = 'absolute'
      css.left = `${b.rel.x}px`
      css.top = `${b.rel.y}px`
    }

    if (hasKids || /flex/.test(String(style.display ?? ''))) {
      css.display = 'flex'
      const dir = normalEnum('flexDirection', style.flexDirection ?? style.flexDirectionRaw)
      if (dir) css.flexDirection = dir
      // DDS 的 justifyContent 有两份副本，props.style 优先，alignJustify 兜底，值可能是 "flex-center"
      const jc = normalEnum('justifyContent', style.justifyContent ?? node.alignJustify?.justifyContent)
      if (jc) css.justifyContent = jc
      const ai = normalEnum('alignItems', style.alignItems ?? node.alignJustify?.alignItems)
      if (ai) css.alignItems = ai
      const fw = style.flexWrap
      if (fw === 'wrap' || fw === 'nowrap') css.flexWrap = fw
      const gap = Number(style.gapPx ?? style.gap ?? 0)
      if (gap > 0) css.gap = `${round(gap / scale)}px`
      if (style.flexGrow !== undefined && style.flexGrow !== '') css.flexGrow = String(style.flexGrow)
      if (style.flexShrink !== undefined && style.flexShrink !== '') css.flexShrink = String(style.flexShrink)
    }

    for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) {
      const v = Number(style[k] ?? 0)
      if (v) css[k] = `${round(v / scale)}px`
    }

    for (const k of COPY_TEXT) {
      const v = style[k]
      if (v === undefined || v === null || v === '') continue
      if (k === 'zIndex' || k === 'opacity') { css[k] = String(v); continue }
      css[k] = pxifyValue(k, v, scale)
    }

    // 背景色/边框是合成节点唯一的视觉信息，务必保留
    if (isImage) {
      const src = String(node.data?.value ?? '').trim()
      if (/^https?:/.test(src)) {
        css.backgroundImage = `url("${src}")`
        if (!css.backgroundSize) css.backgroundSize = '100% 100%'
        if (!css.backgroundRepeat) css.backgroundRepeat = 'no-repeat'
      } else if (src) {
        warnings.push({ kind: 'image-without-url', node: b.id, value: src.slice(0, 80) })
      }
    }

    if (isText) {
      const f = parseFont(style.fontFamily ?? node.props?.fontFamily)
      if (f.stack) { css.fontFamily = f.stack; b.fontStack = f.stack }
      else if (f.family) { css.fontFamily = `var(--${FAMILY_KEY(f.family)})`; b.fontFamily = f.family }
      const weight = f.weight ?? (Number(style.fontWeight) || undefined)
      if (weight) css.fontWeight = String(weight)
      const fs = Number(style.fontSize ?? 0)
      if (fs > 0) css.fontSize = `${round(fs / scale)}px`
      const ta = normalEnum('textAlign', style.textAlign)
      if (ta) css.textAlign = ta
      const ws = normalEnum('whiteSpace', style.whiteSpace)
      css.whiteSpace = ws ?? 'pre-wrap'
      const ls = Number(style.letterSpacing ?? 0)
      if (ls) css.letterSpacing = `${round(ls / scale)}px`
      const color = style.color
      if (color) css.color = String(color)
      else if (String(node.type) === 'lanhutext' && text.trim()) {
        css.color = 'var(--color-text-primary)'
        b.colorMissing = true
        warnings.push({ kind: 'text-color-missing', node: b.id, text: text.slice(0, 20) })
      }
      if (!fs) warnings.push({ kind: 'text-fontsize-missing', node: b.id, text: text.slice(0, 20) })

      // 单行文本用 flex 垂直居中：line-height 在 DDS 里不可靠，盒子居中才是稳定的
      const fsCss = Number(css.fontSize?.replace('px', '') ?? 0)
      const singleLine = css.whiteSpace === 'nowrap' && fsCss > 0 && r.h <= fsCss * 2.4
      if (singleLine) {
        css.display = 'flex'
        css.alignItems = 'center'
        css.justifyContent = css.textAlign === 'right' ? 'flex-end' : css.textAlign === 'center' ? 'center' : 'flex-start'
        css.lineHeight = '1.2'
      } else {
        const lh = pickLineHeight(Number(style.lineHeight ?? 0), r.h, fsCss, false)
        if (lh) css.lineHeight = `${lh}px`
      }
    }

    if (depth === 0) {
      css.position = 'relative'
      css.left = '0px'
      css.top = '0px'
      css.margin = '0'
      css.overflow = 'hidden'
      css.backgroundColor = css.backgroundColor ?? '#ffffff'
    }

    b.css = css
    b.text = text
    b.name = nameOf(node, idx)
    b.tag = isText ? 'div' : 'div'
    b.cls = `${b.name} d${idx}`
  }

  // 期望几何表：给页面加 data-dds，之后在真实 DOM 里逐元素核对
  const rects = nodes.map(({ node }) => {
    const b = boxes.get(node)
    return { idx: b.idx, dds: b.id, x: b.screenRect.x, y: b.screenRect.y, w: b.screenRect.w, h: b.screenRect.h }
  })

  const ir = buildIr(boxes, screenNode)
  const tree = nodes[0].node
  const screenRect = nodeRect(tree, scale)

  return { ir, root: tree, screenRect, boxes, rects, warnings, scale, mode, screenIndex }
}

function normalEnum(key, value) {
  if (value === undefined || value === null || value === '') return undefined
  const map = CSS_ENUM[key] ?? {}
  const v = String(value).trim()
  const hit = map[v]
  if (hit) return hit
  // 未登记但合法的裸值（比如 space-evenly 变体）原样透传；明显非法的记下来由上层告警
  if (/^[a-z-]+$/.test(v)) return v
  return undefined
}

/** 复合值（阴影/边框）里的每个 px 都要单独折算，它是设备像素，不折算会大一倍。 */
const COMPOUND_PX_KEYS = new Set(['boxShadow', 'textShadow', 'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'outline'])
const scalePxInString = (v, scale) => String(v).replace(/(-?\d*\.?\d+)px/g, (_, n) => `${round(parseFloat(n) / scale)}px`)

/** CSS 值里的 px 数字要按缩放比折算；颜色/圆角百分比/渐变等原样保留。 */
function pxifyValue(key, value, scale) {
  const v = String(value).trim()
  if (/^-?\d+(\.\d+)?px$/.test(v)) return `${round(parseFloat(v) / scale)}px`
  if (/^-?\d+(\.\d+)?$/.test(v) && PX_NUMBER_KEYS.has(key)) return `${round(parseFloat(v) / scale)}px`
  if (key === 'borderRadius' && /^\d+(\.\d+)?%$/.test(v)) return v
  if (COMPOUND_PX_KEYS.has(key)) return scalePxInString(v, scale)
  return v
}

/**
 * lineHeight 在 DDS 里经常是离群值（28px 字配 150 行高）。
 * 单行且盒子高度合理时以盒高为准，这是最稳的垂直居中；否则夹紧到字号 1.0–1.4 倍。
 */
function pickLineHeight(raw, boxH, fontSize, nowrap) {
  if (nowrap && boxH > 0 && fontSize > 0) {
    const ratio = boxH / fontSize
    if (ratio >= 1 && ratio <= 2.4) return round(boxH)
  }
  if (!raw || raw <= 0) return fontSize > 0 ? round(fontSize * 1.4) : 0
  if (fontSize <= 0) return round(raw)
  if (raw < fontSize * 0.8) return round(fontSize)
  if (raw > fontSize * 2.4) return round(fontSize * 1.4)
  return round(raw)
}

export function buildIr(boxes, screenNode) {
  const map = new Map()
  for (const [node, b] of boxes) {
    map.set(node, {
      idx: b.idx,
      dds: b.id,
      layerId: b.layerId,
      name: b.name,
      type: b.type,
      uiType: b.uiType,
      eleName: b.eleName,
      synthetic: b.synthetic,
      // 统一输出屏内相对坐标（左上角 0,0），附带相对父节点偏移 rel 与前兄弟间距 gap，避免消费侧手算减法
      rect: b.screenRect,
      rel: b.rel,
      ...(b.gap ? { gap: b.gap } : {}),
      text: b.text || undefined,
      css: b.css,
      children: [],
    })
  }
  for (const [node, b] of boxes) {
    const item = map.get(node)
    for (const k of b.kids) {
      const child = map.get(k)
      if (child) item.children.push(child)
    }
  }
  return { root: map.get(screenNode) }
}
