#!/usr/bin/env node
/**
 * lanhu-dds — 蓝湖 DDS（转代码）确定性编译器。零依赖，只用 Node 内置模块。
 *
 * 它把蓝湖「设计图」拆成三类模型可以直接消费的产物：
 *   1. 屏幕清单（screens.json）—— 一张设计大板里往往有 N 台手机屏，必须先选屏
 *   2. 单屏源码级 IR + 像素级 HTML 参考渲染 + 期望几何表（rects.json）
 *   3. 设计 token、组件切分建议、以及一份「这份 DDS 哪里不可信」的体检报告
 *
 * 设计原则：所有几何/字号/颜色都从 DDS 直接算出，不做猜测；算不出来的写进 report 的 gaps。
 *
 * 用法：
 *   node lanhu-dds.mjs build    --url "<蓝湖链接>" --out ./design/orders [--screen all|0,2] [--scale 2] [--unit design|css]
 *   node lanhu-dds.mjs local    --dds ./dds.raw.json --meta ./meta.json --out ./design/orders [--screen 0]
 *   node lanhu-dds.mjs inventory --dds ./dds.raw.json
 *
 * Cookie：--cookie <值> 或环境变量 LANHU_COOKIE（蓝湖网页版 document.cookie 全串）。
 * 只有拉取 DDS 需要 Cookie；切图与参考图 URL 是公开的。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { decodePng, encodePng, cropPng } from './png.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const LANHU = 'https://lanhuapp.com'
const DDS = 'https://dds.lanhuapp.com'

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      out[k] = v
    } else out._.push(a)
  }
  return out
}

function die(msg) {
  console.error(`\n[lanhu-dds] ${msg}\n`)
  process.exit(1)
}

// ---------------------------------------------------------------- 网络

export async function getJson(url, cookie, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: referer ?? `${LANHU}/`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}\n${text.slice(0, 400)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${url} → 非 JSON 响应\n${text.slice(0, 400)}`)
  }
}

export async function getBinary(url, cookie) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `${LANHU}/`, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`参考图下载失败 HTTP ${res.status}: ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** 从蓝湖链接里抠出 project_id / image_id / team_id。支持 hash 路由与 query 两种写法。 */
export function parseLanhuUrl(input) {
  const hashQuery = input.includes('#') ? input.slice(input.indexOf('#') + 1) : ''
  const tail = hashQuery.includes('?') ? hashQuery.slice(hashQuery.indexOf('?') + 1) : hashQuery
  const sp = new URLSearchParams(tail)
  const q = new URLSearchParams(input.includes('?') ? input.slice(input.indexOf('?') + 1) : '')
  const pick = (k) => sp.get(k) || q.get(k)
  const projectId = pick('project_id') || pick('pid')
  const imageId = pick('image_id') || pick('imageId')
  const teamId = pick('tid') || pick('team_id')
  if (!imageId) die('链接里没有 image_id。请用「设计图详情」页的链接，或显式传 --image-id。')
  if (!projectId) die('链接里没有 project_id / pid。')
  return { projectId, imageId, teamId }
}

/** 取设计图版本信息：参考图直链、画布尺寸、缩放比。 */
export async function resolveImage({ projectId, imageId, teamId, cookie }) {
  const qs = new URLSearchParams({ project_id: projectId, image_id: imageId, dds_status: '1' })
  if (teamId) qs.set('team_id', teamId)
  const json = await getJson(`${LANHU}/api/project/image?${qs}`, cookie)
  const result = json.result ?? json.data
  if (!result) throw new Error(`project/image 响应缺 result：${JSON.stringify(json).slice(0, 300)}`)
  const versions = result.versions ?? []
  const dds = versions.find((v) => v.type === 'dds' || v.d2c_url || v.json_url) ?? versions[0]
  if (!dds) throw new Error('该设计图没有可用版本（versions 为空）。')
  const meta = (result.meta ?? {}) || {}
  const scaleMeta = meta.scaleMetadata ?? meta.scale_metadata ?? {}
  const device = String(scaleMeta.device ?? meta.device ?? '')
  let scale = Number(scaleMeta.sliceScale ?? scaleMeta.slice_scale ?? 0) || 0
  if (!scale) {
    const m = device.match(/@\s*(\d(?:\.\d+)?)x/i)
    scale = m ? Number(m[1]) : 2
  }
  const referenceUrl = String(dds.url ?? '').replace(/([?&])x-oss-process=[^&]*/g, '$1').replace(/[?&]$/, '')
  return {
    versionId: dds.id,
    referenceUrl,
    width: Number(dds.width ?? 0),
    height: Number(dds.height ?? 0),
    scale,
    device,
    name: result.name ?? result.image_name ?? '',
    sourceType: result.source_type ?? meta.sourceType ?? '',
    allVersions: versions.map((v) => ({ id: v.id, type: v.type, width: v.width, height: v.height, url: v.url })),
  }
}

/** 取 DDS 布局树。只要 Cookie，不需要 Authorization，也不需要浏览器。 */
export async function fetchDds({ versionId, cookie }) {
  if (!cookie) throw new Error('拉取 DDS 需要蓝湖 Cookie：设置环境变量 LANHU_COOKIE，或传 --cookie。')
  const meta = await getJson(`${DDS}/api/dds/image/store_schema_revise?version_id=${encodeURIComponent(versionId)}`, cookie, `${DDS}/`)
  if (String(meta.code ?? '') !== '00000') {
    throw new Error(`DDS 接口返回 code=${meta.code} ${meta.message ?? ''}（Cookie 过期或无权访问）`)
  }
  const url = meta.data?.data_resource_url
  if (!url) throw new Error(`DDS 接口没有 data_resource_url：${JSON.stringify(meta).slice(0, 300)}`)
  const tree = await getJson(url, cookie, `${DDS}/`)
  return tree?.children ? tree : (tree?.data ?? tree)
}

// ---------------------------------------------------------------- 通用小工具

const round = (n) => Math.round(n * 100) / 100
const sum = (a) => a.reduce((x, y) => x + y, 0)

const ENTITIES = { '&nbsp;': '\u00a0', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }
function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lt;br\s*\/?&gt;/gi, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;|&apos;|&lt;|&gt;/g, (m) => ENTITIES[m])
    .replace(/&amp;/g, '&')
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** 属性值里的双引号必须转义，否则 url("...") 会把 style 属性截断——这是最容易踩的坑。 */
const attrEsc = (s) => esc(s).replace(/"/g, '&quot;')
const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&')

/** 合成包装节点 id：row_/col_/rect_ 开头，无对应 Figma 源，命名与语义都要特殊处理。 */
const isSynthetic = (n) => /^(row|col|rect)_/.test(String(n.id ?? ''))
const isRealLayer = (n) => Boolean(n.layerId) || /^I?[0-9]+:[0-9]+/.test(String(n.id ?? ''))

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

const FAMILY_KEY = (f) => 'font-' + f.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

/** Windows 上没有 PingFang SC，中文要靠雅黑兜底；这里统一给出跨平台栈。 */
function familyStack(family) {
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

// ---------------------------------------------------------------- 树遍历

function preorder(root, fn, depth = 0, parent = null) {
  fn(root, depth, parent)
  for (const c of root.children ?? []) preorder(c, fn, depth + 1, root)
}

function nodeRect(n, scale) {
  const d = n.rowDims ?? {}
  return {
    x: round(Number(d.left ?? 0) / scale),
    y: round(Number(d.top ?? 0) / scale),
    w: round(Number(d.width ?? 0) / scale),
    h: round(Number(d.height ?? 0) / scale),
  }
}

/** 把一屏里的节点编号（前序），给每层一种语义化短名：nav / list / card / text / img。 */
function nameOf(n, idx) {
  const t = String(n.type ?? '')
  const ui = String(n.uiType ?? '')
  if (t === 'lanhupage') return 'screen'
  if (/image/i.test(t) || /image/i.test(ui)) return `img-${idx}`
  if (/text/i.test(t) && !(n.children ?? []).length) return `text-${idx}`
  return `box-${idx}`
}

// ---------------------------------------------------------------- 屏幕（帧）识别

/** 设备像素矩形（不做缩放），用于在未知 scale 时先找屏。 */
function rawRect(n) {
  const d = n.rowDims ?? {}
  return { x: Number(d.left ?? 0), y: Number(d.top ?? 0), w: Number(d.width ?? 0), h: Number(d.height ?? 0) }
}

/**
 * 一张设计大板里通常横排 N 台手机屏。屏本身是「窄而高」的矩形，在设备像素域就能认出来：
 * 手机逻辑宽几乎总是 375，所以 屏宽/375 就是缩放比（@2x=750、@3x=1125）。
 * 先把候选按宽度分组取众数，避免把里层的卡片/弹窗误判成屏。
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

  if (!cands.length) {
    const r = rawRect(root)
    const scale = Number((r.w / 375).toFixed(2))
    return { scale: Math.abs(scale - Math.round(scale)) < 0.08 ? Math.round(scale) : 2, screens: [{ node: root, depth: 0, raw: r, index: 0, fallback: true }] }
  }

  const minDepth = Math.min(...cands.map((c) => c.depth))
  const top = cands.filter((c) => c.depth === minDepth)

  // 按宽度（取整到 10px）分组，取数量最多的一组当「屏宽」
  const byWidth = new Map()
  for (const c of top) {
    const k = Math.round(c.raw.w / 10) * 10
    if (!byWidth.has(k)) byWidth.set(k, [])
    byWidth.get(k).push(c)
  }
  let best = [...byWidth.values()].sort((a, b) => b.length - a.length)[0]
  const width = best[0].raw.w

  // 宽度校验：同一批屏应该等宽等高，容差外就退回「最靠左的那一批」
  best = best.filter((c) => Math.abs(c.raw.w - width) <= 2)
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
function describeScreen(s, scale) {
  const rect = s.rect ?? { x: round(s.raw.x / scale), y: round(s.raw.y / scale), w: round(s.raw.w / scale), h: round(s.raw.h / scale) }
  const texts = []
  let nodes = 0
  preorder(s.node, (n) => {
    nodes++
    if (n.data?.value && /text/i.test(String(n.type ?? ''))) texts.push(decodeEntities(n.data.value).trim())
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
  if (count <= 2) return true
  const kids = node.children ?? []
  if (kids.length === 1 && /image/i.test(String(kids[0].type ?? ''))) {
    let inner = 0
    preorder(kids[0], () => inner++)
    return inner <= 2
  }
  return false
}

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

  const boxes = new Map()
  for (const { node, depth, idx } of nodes) {
    const rect = nodeRect(node, scale)
    const parent = parentOf.get(node) ?? screenNode
    const parentRect = nodeRect(parent, scale)
    boxes.set(node, {
      idx,
      depth,
      id: String(node.id ?? ''),
      layerId: String(node.layerId ?? ''),
      type: String(node.type ?? ''),
      uiType: String(node.uiType ?? ''),
      eleName: String(node.eleName ?? ''),
      synthetic: isSynthetic(node),
      rect,
      // abs 模式：坐标转为相对父级，父级自身被裁切时才会继承 overflow 语义
      rel: {
        x: round(rect.x - parentRect.x),
        y: round(rect.y - parentRect.y),
      },
      kids: [],
    })
    if (parent && boxes.get(parent)) boxes.get(parent).kids.push(node)
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
  const origin = nodeRect(nodes[0].node, scale)
  const rects = nodes.map(({ node }) => {
    const b = boxes.get(node)
    // 屏内相对坐标：和浏览器 getBoundingClientRect 直接可比，做几何回归时不用再减原点
    return { idx: b.idx, dds: b.id, x: round(b.rect.x - origin.x), y: round(b.rect.y - origin.y), w: b.rect.w, h: b.rect.h }
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

function buildIr(boxes, screenNode) {
  const map = new Map()
  for (const [node, b] of boxes) {
    map.set(node, {
      dds: b.id,
      layerId: b.layerId,
      name: b.name,
      type: b.type,
      uiType: b.uiType,
      eleName: b.eleName,
      synthetic: b.synthetic,
      rect: b.rect,
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

// ---------------------------------------------------------------- 渲染

function styleString(css) {
  return Object.entries(css)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`)
    .join(';')
}

export function renderHtml(compiled, { tokens, title }) {
  const { boxes, screenRect } = compiled
  const body = renderNode(boxes.get(compiled.root), boxes)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title ?? 'DDS screen')}</title>
<style>
${tokens}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#eef0f3}
.stage{width:${screenRect.w}px;min-height:${screenRect.h}px;position:relative;overflow:hidden;background:#fff;margin:0 auto}
</style>
</head>
<body>
<div class="stage">
${body}
</div>
</body>
</html>
`
}

function renderNode(b, boxes) {
  const pad = '  '.repeat(b.depth)
  const attrs = [`class="${b.cls}"`, `data-dds="${esc(b.id)}"`, `data-idx="${b.idx}"`]
  const st = attrEsc(styleString(b.css))
  if (b.kids.length === 0) {
    const inner = b.text ? esc(b.text) : ''
    return `${pad}<div ${attrs.join(' ')} style="${st}">${inner}</div>`
  }
  const kids = b.kids.map((k) => renderNode(boxes.get(k), boxes)).join('\n')
  return `${pad}<div ${attrs.join(' ')} style="${st}">\n${kids}\n${pad}</div>`
}

// ---------------------------------------------------------------- token / 报告

function collectTokens(compiled) {
  const colors = new Map()
  const fonts = new Map()
  const radii = new Map()
  const add = (m, k) => k && m.set(k, (m.get(k) ?? 0) + 1)
  for (const b of compiled.boxes.values()) {
    add(colors, b.css.color)
    add(colors, b.css.backgroundColor)
    if (b.fontFamily) {
      const key = FAMILY_KEY(b.fontFamily)
      if (!fonts.has(key)) fonts.set(key, { count: 0, family: b.fontFamily })
      fonts.get(key).count++
    }
    add(radii, b.css.borderRadius)
  }
  return { colors, fonts, radii }
}

function tokensCss({ colors, fonts, radii }, scale) {
  const out = [':root{']
  const families = []
  for (const [, v] of fonts) families.push(`  --${FAMILY_KEY(v.family)}: ${familyStack(v.family)};`)
  out.push(...families)
  out.push('  --font-text: var(--font-pingfang-sc, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);')
  out.push('  --color-text-primary: #1a1a1a;')
  const named = [...colors.entries()]
    .filter(([c]) => c && String(c).startsWith('#'))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
  named.forEach(([c], i) => out.push(`  --color-brand-${i + 1}: ${c};`))
  out.push('}')
  return out.join('\n')
}

function buildReport({ meta, screens, compiled, warnings, gaps }) {
  const w = warnings.reduce((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {})
  const L = []
  L.push(`# DDS 体检报告 — ${meta.name || meta.imageId}`)
  L.push('')
  L.push(`- 画布：${meta.canvas.width}×${meta.canvas.height} 设计像素，缩放比 @${meta.scale}x（${meta.device || '按屏宽推算'}），逻辑宽 ${round(meta.canvas.width / meta.scale)}`)
  L.push(`- 输出单位：${(meta.unit ?? 'design') === 'design' ? '设计稿 px（750 基准，交给项目内 px→rem 换算）' : 'CSS px（375 逻辑宽）'}`)
  L.push(`- 参考图：${meta.referenceUrl ? `[原图](${meta.referenceUrl})` : '未取到'}`)
  L.push(`- 设计图含 **${screens.length}** 屏；本次编译第 ${compiled.screenIndex} 屏（${compiled.screenRect.w}×${compiled.screenRect.h} CSS px，${compiled.boxes.size} 个节点）`)
  L.push('')
  L.push('## 屏清单')
  L.push('')
  L.push('| # | 尺寸(CSS) | 节点 | 整图? | 标题 |')
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
  if (gaps.length) {
    L.push('## DDS 覆盖不到的地方（必须人工/视觉补齐）')
    L.push('')
    for (const g of gaps) L.push(`- ${g}`)
    L.push('')
  }
  return L.join('\n')
}

// ---------------------------------------------------------------- 组件切分建议

/**
 * 重复结构检测：同一个父节点下、同宽、节点数量接近的兄弟块 = 组件抽取候选。
 * 不按「尺寸完全相等」分组——同一组订单卡片里，带「取消订单」按钮的那张会高 50px，
 * 按精确尺寸分组会把它们拆成两组。同宽 + 节点数接近才是稳的信号。
 */
let currentBoxes = new Map()

function findRepeatGroups(compiled) {
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
      // 节点数分簇：把 ±3 以内的算同一族，避免把不同构的块硬塞进一组
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

function outlineMarkdown(compiled, groups) {
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

// ---------------------------------------------------------------- 产物落盘

/**
 * 把 DDS 里的图片地址抓成本地文件，并把 CSS 改写成相对路径。
 * 蓝湖的切图 CDN 不校验 Cookie，但地址会过期，所以不能让它留在产物里。
 */
export async function localizeAssets(compiled, outDir, cookie) {
  const urls = new Set()
  for (const b of compiled.boxes.values()) {
    const m = /^url\("?(.+?)"?\)$/.exec(String(b.css.backgroundImage ?? ''))
    if (m && /^https?:/.test(m[1])) urls.add(m[1])
  }
  if (!urls.size) return { total: 0, saved: 0, failed: [] }
  const dir = join(outDir, 'assets')
  mkdirSync(dir, { recursive: true })
  const manifest = []
  const failed = []
  const list = [...urls]
  for (let i = 0; i < list.length; i += 6) {
    await Promise.all(list.slice(i, i + 6).map(async (url) => {
      try {
        const buf = await getBinary(url, cookie)
        const ext = (/\\.(png|jpe?g|webp|gif|svg)(\\?|$)/i.exec(url)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg')
        const name = createHash('sha1').update(url).digest('hex').slice(0, 10) + '.' + ext
        writeFileSync(join(dir, name), buf)
        manifest.push({ url, file: `assets/${name}`, bytes: buf.length })
      } catch (e) {
        failed.push({ url, error: String(e.message ?? e) })
      }
    }))
  }
  for (const b of compiled.boxes.values()) {
    const m = /^url\("?(.+?)"?\)$/.exec(String(b.css.backgroundImage ?? ''))
    if (!m) continue
    const hit = manifest.find((x) => x.url === m[1])
    if (hit) b.css.backgroundImage = `url("./${hit.file}")`
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  return { total: urls.size, saved: manifest.length, failed }
}

/** 把整张画布裁出这一屏，产出人/模型都能直接看的参考图。解不了的格式就跳过。 */
export function cropScreenPng(refPng, screenRaw) {
  try {
    const img = decodePng(refPng)
    const pad = 0
    const rect = {
      x: screenRaw.x - pad, y: screenRaw.y - pad,
      w: screenRaw.w + pad * 2, h: screenRaw.h + pad * 2,
    }
    return encodePng(cropPng(img, rect))
  } catch (e) {
    return { error: String(e.message ?? e) }
  }
}

export function writeArtifacts(outDir, { meta, tree, screens, screenDescs, compiled, groups, crop }) {
  mkdirSync(outDir, { recursive: true })
  const p = (f) => join(outDir, f)
  const screenNo = compiled.screenIndex

  writeFileSync(p('meta.json'), JSON.stringify({
    ...meta,
    reference: meta.referenceUrl ? 'screen-<n>.png 已裁出；整张原图见 reference.png' : undefined,
    screens: screenDescs,
    compiledAt: new Date().toISOString(),
  }, null, 2))

  if (tree) writeFileSync(p('dds.raw.json'), JSON.stringify(tree))
  if (screenDescs) writeFileSync(p('screens.json'), JSON.stringify(screenDescs, null, 2))

  const tokens = collectTokens(compiled)
  const tokensText = tokensCss(tokens, compiled.scale)
  writeFileSync(p('tokens.css'), tokensText + '\n')

  const html = renderHtml(compiled, { tokens: tokensText, title: `screen ${screenNo}` })
  writeFileSync(p(`screen-${screenNo}.html`), html)
  writeFileSync(p(`screen-${screenNo}.ir.json`), JSON.stringify(compiled.ir, null, 2))
  writeFileSync(p(`screen-${screenNo}.rects.json`), JSON.stringify(compiled.rects, null, 2))
  writeFileSync(p(`screen-${screenNo}.outline.md`), outlineMarkdown(compiled, groups))
  if (crop && Buffer.isBuffer(crop)) writeFileSync(p(`screen-${screenNo}.png`), crop)

  const gaps = [
    'DDS 提供 boxShadow（本项目 4837 个节点里出现 5 次），但里面的 px 是设备像素，本目录产物已按缩放比折算；手写时同样要除。',
    'DDS 不提供 textShadow / filter / 模糊类效果：这些只能从参考图估。',
    'DDS 的图标只有切图 PNG，没有矢量也没有语义名：按 Skill 6.4 做占位、写全 CSS，并把「位置 + 建议图标」列进交付待办。',
    'DDS 的渐变是完整可用的 linear-gradient（角度与色标齐全），不要重新取色。',
    'DDS 不提供响应式约束（百分比/媒体查询/安全区），375 逻辑宽之外的适配需要按项目栅格重算。',
    'DDS 不提供交互状态（hover/按压/空态/加载态/错误态）与原型流转，必须回到蓝湖原型确认。',
    'DDS 里的圆角/边框/描边可能有 1px 级别的丢失，验收以参考图为准。',
  ]
  const report = buildReport({ meta, screens: screenDescs ?? [], compiled, warnings: compiled.warnings, gaps })
  writeFileSync(p('report.md'), report + '\n\n'
    + '## 重复结构 → 组件候选\n\n'
    + (groups.length
      ? ['| 父节点 | 次数 | 单块尺寸 | 单块节点 | 文案样本 |', '|---|---|---|---|---|',
        ...groups.map((g) => `| ${g.parentName}(${g.parent}) | ${g.count} | ${g.width} × ${g.height} | ${g.nodes} | ${g.texts.map((t) => `"${t}"`).join(' / ')} |`)].join('\n')
      : '未发现同构重复（或本屏是单实例页面）。')
    + '\n')

  return {
    outDir: resolve(outDir),
    screen: screenNo,
    files: [
      `screen-${screenNo}.html`, `screen-${screenNo}.ir.json`, `screen-${screenNo}.rects.json`,
      `screen-${screenNo}.outline.md`, 'tokens.css', 'report.md', 'screens.json', 'meta.json',
    ],
    warnings: compiled.warnings.length,
    nodes: compiled.boxes.size,
    repeatGroups: groups.length,
  }
}

// ---------------------------------------------------------------- 高层入口

/**
 * 一条命令走完「拉取 → 选屏 → 编译 → 切图 → 裁参考图 → 落盘」。
 * CLI 与 DSH 插件共用这个函数，保证两条路径产出完全一致。
 */
export async function buildDesign({
  url, cookie, out, screens: picked, scale: forcedScale, unit: unitOpt,
  reference = true, assets = true, list = false, meta: injectedMeta,
} = {}) {
  if (!url && !injectedMeta) throw new Error('缺少 url')
  if (!cookie && !injectedMeta) throw new Error('缺少蓝湖 Cookie：设置 LANHU_COOKIE 环境变量，或传 cookie')
  const ids = url ? parseLanhuUrl(url) : {}
  const meta0 = await resolveImage({ ...ids, cookie })
  const tree = await fetchDds({ versionId: meta0.versionId, cookie })
  const detected = detectScaleAndScreens(tree)
  const scale = Number(forcedScale ?? detected.scale)
  // 输出单位：design = 直出设计稿 px（750 基准，项目内 px→rem 统一换算，值是设计稿上看到多少就是多少）
  //           css    = 折到 375 逻辑宽（1x 项目用）
  const unit = unitOpt === 'css' ? 'css' : 'design'
  const div = unit === 'css' ? scale : 1
  const allScreens = detected.screens.map((s, i) => ({
    ...s,
    index: i,
    rect: { x: round(s.raw.x / div), y: round(s.raw.y / div), w: round(s.raw.w / div), h: round(s.raw.h / div) },
  }))
  const canvas = { width: rawRect(tree).w, height: rawRect(tree).h }
  const meta = { ...meta0, ...(injectedMeta ?? {}), scale, unit, canvas, ...ids }
  const descs = allScreens.map((s) => describeScreen(s, div))

  if (list) return { ok: true, list: true, name: meta.name, canvas, scale, unit, screens: descs }

  const outDir = resolve(out ?? 'design/dds')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'dds.raw.json'), JSON.stringify(tree))
  writeFileSync(join(outDir, 'screens.json'), JSON.stringify(descs, null, 2))
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({ ...meta, screens: descs }, null, 2))

  let refPng = null
  if (reference && meta.referenceUrl) {
    try {
      refPng = await getBinary(meta.referenceUrl, cookie)
      writeFileSync(join(outDir, 'reference.png'), refPng)
    } catch (e) {
      refPng = null
      meta.referenceError = String(e.message ?? e)
    }
  }

  const want = picked === undefined || picked === 'all'
    ? allScreens.map((s) => s.index)
    : String(picked).split(',').map((x) => Number(x.trim()))
  const built = []
  for (const idx of want) {
    const s = allScreens[idx]
    if (!s) { built.push({ screen: idx, error: '该屏不存在' }); continue }
    const compiled = compileScreen(tree, s.node, { scale: div, screenIndex: idx })
    const assetResult = assets ? await localizeAssets(compiled, outDir, cookie) : null
    const crop = refPng ? cropScreenPng(refPng, s.raw) : null
    const groups = findRepeatGroups(compiled)
    const result = writeArtifacts(outDir, {
      meta, tree: null, screens: allScreens, screenDescs: descs, compiled, groups,
      crop: Buffer.isBuffer(crop) ? crop : null,
    })
    built.push({
      ...result,
      title: descs[idx].title,
      size: { width: descs[idx].width, height: descs[idx].height },
      raster: descs[idx].raster,
      assets: assetResult ? { total: assetResult.total, saved: assetResult.saved, failed: assetResult.failed.length } : null,
      crop: Buffer.isBuffer(crop) ? `screen-${idx}.png` : (crop?.error ?? null),
      repeatGroups: groups.map((g) => ({ parent: g.parentName, count: g.count, texts: g.texts })),
    })
  }
  return { ok: true, outDir, canvas, scale, screens: descs, built, reference: Boolean(refPng) }
}

// ---------------------------------------------------------------- 命令

async function cmdBuild(args) {
  const cookie = args.cookie ?? process.env.LANHU_COOKIE
  if (!args.url) die('build 需要 --url "<蓝湖设计图链接>"')
  const r = await buildDesign({
    url: args.url,
    cookie,
    out: args.out,
    screens: args.screen,
    scale: args.scale,
    unit: args.unit,
    reference: args['no-ref'] !== 'true',
    assets: args['no-assets'] !== 'true',
    list: args.list === 'true',
  })
  if (r.list) { console.log(JSON.stringify({ name: r.name, canvas: r.canvas, scale: r.scale, screens: r.screens }, null, 2)); return }
  console.error(`[lanhu-dds] 画布 ${r.canvas.width}×${r.canvas.height} @${r.scale}x，共 ${r.screens.length} 屏；输出 ${r.outDir}`)
  console.log(JSON.stringify(r, null, 2))
}

async function cmdLocal(args) {
  if (!args.dds) die('local 需要 --dds <dds.raw.json>')
  const tree = JSON.parse(readFileSync(args.dds, 'utf8'))
  const metaFile = args.meta && existsSync(args.meta) ? JSON.parse(readFileSync(args.meta, 'utf8')) : {}
  const detected = detectScaleAndScreens(tree)
  const scale = Number(args.scale ?? detected.scale)
  const unit = args.unit === 'css' ? 'css' : 'design'
  const div = unit === 'css' ? scale : 1
  const screens = detected.screens.map((s, i) => ({
    ...s, index: i,
    rect: { x: round(s.raw.x / div), y: round(s.raw.y / div), w: round(s.raw.w / div), h: round(s.raw.h / div) },
  }))
  const meta = { ...metaFile, scale, unit, canvas: { width: rawRect(tree).w, height: rawRect(tree).h } }
  const descs = screens.map((s) => describeScreen(s, div))
  const outDir = resolve(args.out ?? 'design/dds')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'screens.json'), JSON.stringify(descs, null, 2))
  const picked = args.screen === 'all' || args.screen === undefined ? screens.map((s) => s.index) : String(args.screen).split(',').map(Number)
  let refPng = args.ref && existsSync(args.ref) ? readFileSync(args.ref) : null
  const results = []
  for (const idx of picked) {
    const s = screens[idx]
    if (!s) continue
    const compiled = compileScreen(tree, s.node, { scale: div, screenIndex: idx })
    if (args['no-assets'] !== 'true') await localizeAssets(compiled, outDir, process.env.LANHU_COOKIE)
    const crop = refPng ? cropScreenPng(refPng, s.raw) : null
    if (crop?.error) console.error(`[lanhu-dds] 屏 ${idx} 裁剪跳过：${crop.error}`)
    results.push(writeArtifacts(outDir, { meta, tree: null, screens, screenDescs: descs, compiled, groups: findRepeatGroups(compiled), crop: Buffer.isBuffer(crop) ? crop : null }))
  }
  console.log(JSON.stringify({ ok: true, outDir, screens: descs, built: results }, null, 2))
}

function cmdInventory(args) {
  const tree = JSON.parse(readFileSync(args.dds, 'utf8'))
  const detected = detectScaleAndScreens(tree)
  const scale = Number(args.scale ?? detected.scale)
  const screens = detected.screens.map((s, i) => ({
    ...s, index: i,
    rect: { x: round(s.raw.x / scale), y: round(s.raw.y / scale), w: round(s.raw.w / scale), h: round(s.raw.h / scale) },
  }))
  console.log(JSON.stringify({ scale, canvas: rawRect(tree), screens: screens.map((s) => describeScreen(s, scale)) }, null, 2))
}


// ---------------------------------------------------------------- 项目接入自检

/** 公共 scope：判断「哪些依赖是内网私有的」时排除掉。 */
const PUBLIC_SCOPES = new Set([
  'tarojs', 'vant', 'vue', 'vueuse', 'react', 'babel', 'types', 'testing-library',
  'typescript-eslint', 'eslint', 'commitlint', 'changesets', 'rollup', 'vitejs',
  'nutui', 'ant-design', 'vue-', 'playwright', 'storybook', 'sentry', 'semi-design',
])

const RULES_REL = '.agents/skills/lanhu-dds-codegen/project-rules.md'

function pickWidth(text, key) {
  if (!text) return null
  const m = text.match(new RegExp(`${key}\\s*[:=]\\s*(\\d+(?:\\.\\d+)?)`))
  return m ? Number(m[1]) : null
}

/**
 * 判断这个项目该用哪个输出单位、规范文件有没有接入。
 * 不联网、不猜：找不到就明说找不到，交给人的那一步列成 todo。
 */
export function diagnoseProject(projectDir = process.cwd()) {
  const dir = resolve(projectDir)
  const read = (rel) => { try { return readFileSync(join(dir, rel), 'utf8') } catch { return null } }

  const pkgRaw = read('package.json')
  if (!pkgRaw) return { ok: false, error: `不是项目根目录（没有 package.json）：${dir}` }
  const pkg = JSON.parse(pkgRaw)
  const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })

  const framework = []
  if (deps.includes('@tarojs/taro')) framework.push('Taro')
  else if (deps.includes('vite')) framework.push('Vite')
  if (deps.includes('vue')) framework.push('Vue')
  else if (deps.includes('react')) framework.push('React')

  const internalPackages = deps.filter((n) => {
    if (!n.startsWith('@')) return false
    const scope = n.slice(1).split('/')[0]
    return !PUBLIC_SCOPES.has(scope) && !PUBLIC_SCOPES.has(scope.split('-')[0])
  })

  // 单位基准：Taro 看 designWidth，其余看 postcss 转换插件
  const taroConfig = ['config/index.ts', 'config/index.js', 'config.ts', 'config.js']
    .map(read).find(Boolean) ?? null
  const designWidth = pickWidth(taroConfig, 'designWidth')
  const postcss = ['postcss.config.js', 'postcss.config.ts', 'postcss.config.mjs', 'postcss.config.cjs']
    .map(read).find(Boolean) ?? null
  const rootValue = pickWidth(postcss, 'rootValue')
  const viewportWidth = pickWidth(postcss, 'viewportWidth')

  let unit = null
  let unitFrom = null
  if (designWidth === 750) { unit = 'design'; unitFrom = 'config 里 designWidth: 750' }
  else if (designWidth === 375) { unit = 'css'; unitFrom = 'config 里 designWidth: 375' }
  else if (rootValue === 75) { unit = 'design'; unitFrom = 'postcss rootValue: 75' }
  else if (rootValue === 37.5) { unit = 'css'; unitFrom = 'postcss rootValue: 37.5' }
  else if (viewportWidth === 750) { unit = 'design'; unitFrom = 'postcss viewportWidth: 750' }
  else if (viewportWidth === 375) { unit = 'css'; unitFrom = 'postcss viewportWidth: 375' }

  // 规范接入情况
  const rulesRaw = read(RULES_REL)
  let rules = { present: false, unfilled: [], placeholders: 0 }
  if (rulesRaw) {
    const unfilled = []
    for (const line of rulesRaw.split('\n')) {
      const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/)
      if (!m) continue
      const label = m[1].trim()
      if (!label || label === '项' || /^[-: ]+$/.test(label)) continue
      if (!m[2].trim()) unfilled.push(label)
    }
    const placeholders = (rulesRaw.match(/（如 |（内网 |待填|TODO\(接入\)/g) ?? []).length
    rules = { present: true, unfilled, placeholders }
  }

  const todos = []
  if (!rules.present) {
    todos.push(`没有 ${RULES_REL}：先跑 lanhu-dds doctor --init 生成模板，再把项目真实规范填进去`)
  } else {
    if (rules.unfilled.length) todos.push(`project-rules.md 有 ${rules.unfilled.length} 项空着没填：${rules.unfilled.slice(0, 8).join('、')}${rules.unfilled.length > 8 ? '…' : ''}`)
    if (rules.placeholders) todos.push(`project-rules.md 里还有 ${rules.placeholders} 处示例占位（（如 …）/（内网 …）），换成真实内容或整段删掉`)
  }
  if (internalPackages.length) {
    if (!existsSync(join(dir, UI_DOC_REL))) {
      todos.push(`内网 UI 库清单还没生成：跑 doctor --ui（会扫 node_modules 里的真实组件，写到 ${UI_DOC_REL}）`)
    }
    todos.push(`识别到内网包：${internalPackages.join('、')} —— 组件清单见 ${UI_DOC_REL}，没收录的再去 node_modules 翻`)
  } else if (deps.includes('vant')) {
    todos.push('只看到公共 vant，没识别到内网 UI 库：确认内网库包名，填进 project-rules.md')
  }
  if (!unit) todos.push('没找到单位基准（designWidth / rootValue / viewportWidth）：默认按 750 设计稿输出，接入时确认一次')

  return {
    ok: true,
    dir,
    packageName: pkg.name ?? null,
    framework,
    internalPackages,
    unit: unit ?? 'design',
    unitFrom: unitFrom ?? '未找到配置，默认 750 设计稿',
    rules,
    todos,
    ready: todos.length === 0,
  }
}

/** 把 Skill 自带的 project-rules.md 模板复制到项目里，作为接入起点。 */
export function initProjectRules(projectDir = process.cwd()) {
  const dir = resolve(projectDir)
  // 模板位置随分发形态不同：Skill 里在 scripts/../，插件里在 lib/../skills/lanhu-dds-codegen/
  const src = ['../project-rules.md', '../skills/lanhu-dds-codegen/project-rules.md', './project-rules.md']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((p) => existsSync(p))
  if (!src) return { ok: false, error: '找不到 project-rules.md 模板（安装包不完整）' }
  const dest = join(dir, RULES_REL)
  if (existsSync(dest)) return { ok: false, error: `${RULES_REL} 已存在，不覆盖`, path: dest }
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(src))
  return { ok: true, path: dest }
}


const UI_DOC_REL = '.agents/skills/lanhu-dds-codegen/ui-library.md'
const SKIP_DIRS = /^(node_modules|\.\w|es|lib|dist|src|build|cjs|mjs|umd|types|typings|style|styles|theme|locale|locales|utils?|hooks?|_util|common|shared|assets|icons?|constants|mixins|directives|composables)$/

const pascal = (s) => s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')

/** 从 .d.ts 里抠出 Props 接口的字段名（尽力而为，抠不到就留空）。 */
function propsOf(dir) {
  const files = (() => { try { return readdirSync(dir).filter((f) => f.endsWith('.d.ts')) } catch { return [] } })()
  const texts = files.map((f) => { try { return readFileSync(join(dir, f), 'utf8') } catch { return '' } })
  const keys = new Set()
  for (const t of texts) {
    for (const m of t.matchAll(/interface\s+\w*(?:Props|Options)\w*\s*(?:extends[^{]*)?\{([\s\S]*?)\n\}/g)) {
      for (const line of m[1].split('\n')) {
        const k = line.match(/^\s{2,}([A-Za-z_$][\w$]*)\??\s*:/)
        if (k) keys.add(k[1])
      }
    }
  }
  return [...keys].slice(0, 12)
}

/**
 * 扫内网 UI 库的安装产物，列出真实组件名与（尽力而为的）props。
 * 组件清单是确定信息（目录结构），props 是启发式，文档里会标出来。
 */
export function inspectUiLibrary(projectDir, pkgName) {
  const project = resolve(projectDir)
  const pkgDir = join(project, 'node_modules', pkgName)
  if (!existsSync(pkgDir)) return { ok: false, error: `没有安装 ${pkgName}（查 ${pkgDir}）` }

  let pj = {}
  try { pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch { /* 保持空 */ }
  const roots = ['es', 'lib', 'dist', 'components', 'src'].filter((r) => existsSync(join(pkgDir, r)))
  const comps = []
  for (const root of [...roots, '.']) {
    const base = root === '.' ? pkgDir : join(pkgDir, root)
    let entries = []
    try { entries = readdirSync(base, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.test(e.name)) continue
      const d = join(base, e.name)
      if (!['index.js', 'index.mjs', 'index.cjs', 'index.d.ts'].some((f) => existsSync(join(d, f)))) continue
      comps.push({ name: pascal(e.name), dir: root === '.' ? e.name : `${root}/${e.name}`, props: propsOf(d) })
    }
    if (comps.length) break
  }

  // 兜底：库把组件平铺进一个 barrel 文件（export { default as Button } from './button'）
  if (!comps.length) {
    const entryFile = [pj.module, pj.main, 'index.js', 'es/index.js', 'lib/index.js'].filter(Boolean)
      .map((f) => join(pkgDir, f)).find((f) => existsSync(f))
    if (entryFile) {
      try {
        const barrel = readFileSync(entryFile, 'utf8')
        const seen = new Set()
        for (const m of barrel.matchAll(/from\s+['"]\.\/([\w-]+)['"]/g)) {
          const name = pascal(m[1])
          if (seen.has(name)) continue
          seen.add(name)
          comps.push({ name, dir: m[1], props: propsOf(join(dirname(entryFile), m[1])) })
        }
      } catch { /* 读不出来就返回空 */ }
    }
  }
  return {
    ok: true,
    pkg: pkgName,
    version: pj.version ?? null,
    entry: pj.module ?? pj.main ?? null,
    components: comps.sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** 把组件清单写成 markdown，落到项目的 Skill 目录里，模型出码前会先读它。 */
export function writeUiLibraryDoc(projectDir, info) {
  const dest = join(resolve(projectDir), UI_DOC_REL)
  mkdirSync(dirname(dest), { recursive: true })
  const rows = info.components.map((c) => `| \`<${c.name}>\` | \`${info.pkg}/${c.dir}\` | ${c.props.length ? c.props.map((p) => '`' + p + '`').join(' ') : '（未解析到，看源码）'} |`)
  const md = `# 内网 UI 组件清单（自动生成）

> 由 \`lanhu-dds doctor --ui\` 扫 \`node_modules/${info.pkg}\` 生成，**不要手改**——库升级后重跑覆盖。
> 组件名与目录是确定的；最后一列 props 是从 \`.d.ts\` 里尽力解析的，**不确定的去看源码，别猜**。
> 生成时间信息不写在这里，避免无意义的 diff。

- 包：\`${info.pkg}\`${info.version ? ` @ ${info.version}` : ''}
- 入口：\`${info.entry ?? '（package.json 未声明 module/main）'}\`
- 组件数：${info.components.length}

| 组件 | 导入路径 | 主要 props（启发式） |
|---|---|---|
${rows.join('\n')}

## 怎么用

1. 出码前先在这张表里找有没有现成组件（按钮 / 单元格 / 标签 / 弹层 / 空态 / 骨架屏…）。
2. 有 → 直接用，样式用库的 CSS 变量或 \`:deep()\` 覆盖。
3. 没有 → 才手写，并在此文件末尾追加一行「缺 XXX，已手写」，方便后续反馈给库维护者。
`
  writeFileSync(dest, md)
  return { ok: true, path: dest, components: info.components.length }
}

function cmdDoctor(args) {
  const project = args.project ?? process.cwd()
  if (args.init === 'true') return console.log(JSON.stringify(initProjectRules(project), null, 2))
  if (args.ui === 'true') {
    const diag = diagnoseProject(project)
    if (!diag.ok) return die(diag.error)
    const pkg = args.pkg ?? diag.internalPackages[0]
    if (!pkg) return die('没有识别到内网 UI 包，用 --pkg <包名> 指定')
    const info = inspectUiLibrary(project, pkg)
    if (!info.ok) return die(info.error)
    const w = writeUiLibraryDoc(project, info)
    console.log(`[lanhu-dds] ${pkg} 识别到 ${w.components} 个组件 → ${w.path}`)
    return console.log(JSON.stringify({ ...w, components: info.components.map((c) => c.name) }, null, 2))
  }
  const r = diagnoseProject(project)
  if (!r.ok) return die(r.error)
  const lines = [
    `项目：${r.packageName ?? '(未命名)'}　框架：${r.framework.join(' / ') || '(未识别)'}`,
    `输出单位：--unit ${r.unit}　依据：${r.unitFrom}`,
    `内网包：${r.internalPackages.join('、') || '(未识别)'}`,
    `规范文件：${r.rules.present ? `已接入，空 ${r.rules.unfilled.length} 项、占位 ${r.rules.placeholders} 处` : '未接入'}`,
    r.ready ? '状态：可以开工' : `待办 ${r.todos.length} 条：`,
    ...r.todos.map((t) => `  · ${t}`),
  ]
  console.log(lines.join('\n'))
  console.log('\n' + JSON.stringify(r, null, 2))
}

const main = async () => {
  const [, , cmd, ...rest] = process.argv
  const args = parseArgs(rest)
  if (cmd === 'build') return cmdBuild(args)
  if (cmd === 'local') return cmdLocal(args)
  if (cmd === 'inventory') return cmdInventory(args)
  if (cmd === 'doctor') return cmdDoctor(args)
  die('用法：\n  lanhu-dds.mjs build --url "<链接>" --out <目录> [--screen all|0,1] [--list]\n  lanhu-dds.mjs local --dds <dds.raw.json> [--meta meta.json] --out <目录> [--screen 0]\n  lanhu-dds.mjs inventory --dds <dds.raw.json>\n  lanhu-dds.mjs doctor [--project <项目目录>] [--init] [--ui [--pkg <包名>]]')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch((e) => die(e.stack ?? String(e)))
