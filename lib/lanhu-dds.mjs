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
 * Cookie：--cookie <值>，唯一来源，由用户提供（不读环境变量、不读文件）。
 * 只有拉取 DDS 需要 Cookie；切图与参考图 URL 是公开的。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs'
import { join, dirname, basename, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
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

export async function getBinary(url, cookie, timeoutMs = 120_000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `${LANHU}/`, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error(`下载返回空内容 (0B): ${url}`)
  return buf
}

/** 内网常拦截 lanhu-oss-*.lanhuapp.com，改写到同源镜像 alipic.lanhuapp.com（需带 Cookie + Referer）可拿到逐字节一致的切图。 */
export function toAlipicMirror(url) {
  return /^https?:\/\/lanhu-oss-[^/]+\.lanhuapp\.com\//i.test(String(url ?? ''))
    ? String(url).replace(/^https?:\/\/lanhu-oss-[^/]+\.lanhuapp\.com\//i, 'https://alipic.lanhuapp.com/')
    : null
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
  if (!cookie) {
    throw new Error(
      `拉取 DDS 需要蓝湖 Cookie：要么 ${COOKIE_FILE} 存在，要么用 --cookie "<值>" 给一次（验证通过会存到该文件）。` +
        '拿法：浏览器登录蓝湖 → F12 → Network → 任一 lanhuapp.com 请求 → 复制完整 Cookie 请求头。'
    )
  }
  const meta = await getJson(`${DDS}/api/dds/image/store_schema_revise?version_id=${encodeURIComponent(versionId)}`, cookie, `${DDS}/`)
  if (String(meta.code ?? '') !== '00000') {
    throw new Error(
      `DDS 接口返回 code=${meta.code} ${meta.message ?? ''}（Cookie 过期，或当前账号没有该设计图权限；重新取一份 Cookie 再来）`
    )
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

  const origin = nodeRect(nodes[0].node, scale)
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

function buildIr(boxes, screenNode) {
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

// ---------------------------------------------------------------- token / 报告 / 紧凑规格表

function collectTokens(compiledOrList) {
  const list = Array.isArray(compiledOrList) ? compiledOrList : [compiledOrList]
  const colors = new Map()
  const fonts = new Map()
  const radii = new Map()
  const add = (m, k) => k && m.set(k, (m.get(k) ?? 0) + 1)
  for (const compiled of list) {
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
  }
  return { colors, fonts, radii }
}

function tokensCss({ colors, fonts }) {
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

const REPORT_GAPS = [
  'DDS 提供 boxShadow（本项目 4837 个节点里出现 5 次），里面的 px 已按输出单位折算。',
  'DDS 不提供 textShadow / filter / 模糊类效果：这些只能从 screen-N.png 参考图目测。',
  'DDS 的图标只有切图 PNG，没有矢量也没有语义名：优先换项目既有图标库，没有的按 Skill 6.4 做占位并列入待办。',
  'DDS 的渐变是完整可用的 linear-gradient（角度与色标齐全），不要重新取色。',
  'DDS 不提供响应式约束（百分比/媒体查询/安全区），375 逻辑宽之外的适配需要按项目栅格重算。',
  'DDS 不提供交互状态（hover/按压/空态/加载态/错误态）与原型流转，需结合需求或既有页面补齐。',
]

function buildReport({ meta, screens, compiledList, groupsByScreen, assetStats, variantPairs, gaps = REPORT_GAPS }) {
  const list = Array.isArray(compiledList) ? compiledList : [compiledList]
  const allWarnings = list.flatMap((c) => c.warnings)
  const w = allWarnings.reduce((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {})
  const unitLabel = (meta.unit ?? 'design') === 'design' ? '设计稿 px（750 基准，交给项目内 px→rem 换算）' : 'CSS px（375 逻辑宽）'
  const builtSummary = list.map((c) => `#${c.screenIndex}(${c.screenRect.w}×${c.screenRect.h}, ${c.boxes.size}节点)`).join('、')

  const L = []
  L.push(`# DDS 体检报告 — ${meta.name || meta.imageId || 'design'}`)
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

  if (gaps.length) {
    L.push('## DDS 覆盖不到的地方（必须人工/视觉补齐）')
    L.push('')
    for (const g of gaps) L.push(`- ${g}`)
    L.push('')
  }
  return L.join('\n')
}

// ---------------------------------------------------------------- 组件切分与紧凑规格表

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

const CSS_URL_RE = /url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/i

function extractCssUrl(val) {
  if (!val) return null
  return CSS_URL_RE.exec(String(val))?.[2] ?? null
}

function cleanCssColorNoise(val) {
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
export function specMarkdown(compiled, groups, { title = '', unit = 'design' } = {}) {
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

  // 汇总本屏需拷入项目或复用的业务切图清单（自动剔除壳层、空白占位、弹层底层预览背景与常规 <=64px 小图标候选）
  const bizAssets = new Map()
  for (const [node, b] of boxes) {
    if (chrome.skipNodeSet.has(node)) continue
    const sr = b.screenRect
    if (b.compositeAsset?.file) {
      const near = findNearestShortText(b, compiled, chrome.skipNodeSet)
      bizAssets.set(b.compositeAsset.file, `${b.compositeAsset.pxWidth}×${b.compositeAsset.pxHeight}px 组合图标预裁图${near ? `（${near}）` : ''}`)
      continue
    }
    if (b.asset?.status !== 'ok' || b.asset.blank) continue
    if (b.depth === 0 && isPopupSheet) continue
    const isSmallIcon = sr.w <= 64 && sr.h <= 64 && !b.kids.length
    if (isSmallIcon) continue
    const dims = b.asset.pxWidth && b.asset.pxHeight ? `${b.asset.pxWidth}×${b.asset.pxHeight}px` : `${sr.w}×${sr.h}`
    if (!bizAssets.has(b.asset.file)) {
      bizAssets.set(b.asset.file, `${dims} @(${sr.x},${sr.y} ${sr.w}×${sr.h})`)
    }
  }

  const L = [
    `# Screen ${screenIndex} — ${title || chrome.navTitle || '未命名'} (${screenRect.w}×${screenRect.h}, unit=${unit}, ${boxes.size} 节点)`,
    '',
    '> 坐标系：本屏左上角 `(0,0)`；`@(x,y w×h)` 为屏内位置，`rel(dx,dy)` 为相对父容器偏移（`=parent` 表示与父同框，勿重复叠加 padding），`↑gap` / `←gap` 为与上一兄弟间距，`↑nav` 为首块内容距顶部导航栏底边的间距。',
    '> 壳层规则：顶部状态栏/导航栏已自动折叠（仅将标题交宿主导航，禁在页面内手写渲染顶栏）；底部安全区占位条勿当图片渲染，统一转为吸底栏或滚动容器的 `safe-area-inset-bottom` 高度适配。',
    '> 直接读本文件 + `screen-' + screenIndex + '.png` 出码，无需再写脚本解析 `ir.json` 或 `manifest.json`。',
    '',
  ]

  if (bizAssets.size) {
    L.push('## 本屏业务切图（不含已折叠壳层、空白占位与 <=64px 常规小图标）', '')
    for (const [file, desc] of bizAssets) {
      L.push(`- \`${file}\` — ${desc}`)
    }
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
      tokens.push(`composite-icon:${b.compositeAsset.file}(${b.compositeAsset.pxWidth}×${b.compositeAsset.pxHeight}px)${nearNote}[组合碎片小图标：优先换图标库，或直接用此预裁整图，禁手写裁图脚本]`)
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
        const iconHint = isSmallIcon ? '[图标候选]' : ''
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

// ---------------------------------------------------------------- 产物落盘

function overlapsText(raw, textRects) {
  for (const tr of textRects) {
    const ox = Math.min(raw.x + raw.w, tr.x + tr.w) - Math.max(raw.x, tr.x)
    const oy = Math.min(raw.y + raw.h, tr.y + tr.h) - Math.max(raw.y, tr.y)
    if (ox > 2 && oy > 2) return true
  }
  return false
}

/** 纯 Node 读取常见光栅图片（PNG/GIF/WebP/JPEG）文件头真实像素宽高，避免模型手写 System.Drawing 脚本查尺寸。 */
export function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR(width@16, height@20)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  // RIFF....WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    }
  }
  // JPEG: FF D8 ... SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xff) { i++; continue }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2
        continue
      }
      const len = buf.readUInt16BE(i + 2)
      if (len < 2) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      }
      i += 2 + len
    }
  }
  return null
}

function isCompositeIconContainer(b, boxes) {
  if (b.type !== 'lanhublock' || b.kids.length < 2) return false
  if (b.raw.w < 12 || b.raw.w > 96 || b.raw.h < 12 || b.raw.h > 96) return false
  let hasText = false
  let imgCount = 0
  let maxImgArea = 0
  const walk = (x) => {
    if (x.type === 'lanhutext' && x.text?.trim()) hasText = true
    if (x.type === 'lanhuimage') {
      imgCount++
      maxImgArea = Math.max(maxImgArea, x.raw.w * x.raw.h)
    }
    for (const k of x.kids) walk(boxes.get(k))
  }
  walk(b)
  return !hasText && imgCount >= 1 && maxImgArea < b.raw.w * b.raw.h * 0.85
}

/**
 * 切图本地化三级策略：
 *   1. 直连原 URL（lanhu-oss-*.lanhuapp.com），某域名首次失败即同域熔断，不逐张卡超时；
 *   2. 自动改写到同源镜像 alipic.lanhuapp.com（携带 Cookie + Referer，逐字节一致，解决内网拦截 lanhu-oss-*）；
 *   3. 仍不可达时，若已拿到整张 reference.png 且该图片节点无上层文字遮挡，直接从原图裁切兜底；有文字遮挡则标为占位。
 * 同时读取切图真实像素宽高写入 manifest 与 spec.md，并为 Figma 拆碎的组合小图标自动预裁整图。
 */
function isBlankIconPng(buf, dims) {
  if (!Buffer.isBuffer(buf) || buf.length > 8192 || buf[0] !== 0x89) return false
  if (!dims || dims.width > 128 || dims.height > 128) return false
  try {
    const decoded = decodePng(buf)
    const { channels, data } = decoded ?? {}
    if (!data?.length || !channels) return false
    let maxA = 0
    let minVisA = 255
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
    for (let i = 0; i <= data.length - channels; i += channels) {
      const r = data[i]
      const g = channels >= 3 ? data[i + 1] : r
      const b = channels >= 3 ? data[i + 2] : r
      const a = channels === 4 ? data[i + 3] : channels === 2 ? data[i + 1] : 255
      if (a > maxA) maxA = a
      if (a > 16) {
        if (a < minVisA) minVisA = a
        if (r < minR) minR = r; if (r > maxR) maxR = r
        if (g < minG) minG = g; if (g > maxG) maxG = g
        if (b < minB) minB = b; if (b > maxB) maxB = b
      }
    }
    if (maxA <= 3) return true
    if (
      maxR - minR <= 3
      && maxG - minG <= 3
      && maxB - minB <= 3
      && maxA - minVisA <= 3
      && minR >= 248
      && minG >= 248
      && minB >= 248
    ) return true
    return false
  } catch {
    return false
  }
}

export async function localizeAssets(compiled, outDir, cookie, { refImg = null, deadHosts = new Set(), manifestByUrl = null } = {}) {
  const chrome = detectScreenChrome(compiled)
  const imgBoxes = []
  const urls = new Set()
  for (const [node, b] of compiled.boxes) {
    if (chrome.skipNodeSet.has(node)) {
      if (extractCssUrl(b.css.backgroundImage)) delete b.css.backgroundImage
      if (extractCssUrl(b.css.background)) {
        const stripped = String(b.css.background).replace(CSS_URL_RE, '').trim()
        if (!stripped || /^(no-repeat|repeat|center|cover|contain|\d+%|\s)+$/i.test(stripped)) delete b.css.background
        else b.css.background = stripped
      }
      continue
    }
    const bgImgUrl = extractCssUrl(b.css.backgroundImage)
    const bgShorthandUrl = !bgImgUrl ? extractCssUrl(b.css.background) : null
    const url = bgImgUrl || bgShorthandUrl
    if (url) {
      urls.add(url)
      imgBoxes.push({ box: b, url, prop: bgImgUrl ? 'backgroundImage' : 'background' })
    }
  }
  if (!urls.size && !refImg) return { total: 0, saved: 0, cdn: 0, alipic: 0, cropped: 0, compositeIcons: 0, placeholders: 0, failed: [] }

  const dir = join(outDir, 'assets')
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'manifest.json')
  const store = manifestByUrl ?? new Map()
  if (!store.size && existsSync(manifestPath)) {
    try {
      for (const item of JSON.parse(readFileSync(manifestPath, 'utf8'))) {
        if (!item?.url || !item?.file) continue
        const absFile = join(outDir, item.file)
        if (!existsSync(absFile)) continue
        if (!item.pxWidth || !item.pxHeight || item.blank === undefined) {
          try {
            const rawBuf = readFileSync(absFile)
            const dims = imageDimensions(rawBuf)
            if (dims) {
              item.pxWidth = dims.width
              item.pxHeight = dims.height
              item.blank = isBlankIconPng(rawBuf, dims)
            }
          } catch { /* 忽略 */ }
        }
        store.set(item.url, item)
      }
    } catch { /* 旧 manifest 损坏时重建 */ }
  }

  const failedByUrl = new Map()
  const todoUrls = [...urls].filter((u) => !store.has(u))
  for (let i = 0; i < todoUrls.length; i += 6) {
    await Promise.all(todoUrls.slice(i, i + 6).map(async (url) => {
      const ext = (/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.exec(url)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg')
      const name = createHash('sha1').update(url).digest('hex').slice(0, 10) + '.' + ext
      let lastErr = ''
      let host = ''
      try { host = new URL(url).host } catch { host = '' }

      if (host && !deadHosts.has(host)) {
        try {
          const buf = await getBinary(url, cookie, 8_000)
          writeFileSync(join(dir, name), buf)
          const dims = imageDimensions(buf)
          const blank = isBlankIconPng(buf, dims)
          store.set(url, {
            url,
            file: `assets/${name}`,
            bytes: buf.length,
            ...(dims ? { pxWidth: dims.width, pxHeight: dims.height } : {}),
            ...(blank ? { blank: true } : {}),
            source: 'cdn',
          })
          return
        } catch (e) {
          lastErr = String(e.message ?? e)
          deadHosts.add(host)
        }
      } else if (host) {
        lastErr = `${host} 已熔断`
      }

      const mirror = toAlipicMirror(url)
      if (mirror && !deadHosts.has('alipic.lanhuapp.com')) {
        try {
          const buf = await getBinary(mirror, cookie, 12_000)
          writeFileSync(join(dir, name), buf)
          const dims = imageDimensions(buf)
          const blank = isBlankIconPng(buf, dims)
          store.set(url, {
            url,
            mirror,
            file: `assets/${name}`,
            bytes: buf.length,
            ...(dims ? { pxWidth: dims.width, pxHeight: dims.height } : {}),
            ...(blank ? { blank: true } : {}),
            source: 'alipic',
          })
          return
        } catch (e) {
          lastErr = String(e.message ?? e)
          if (!/^HTTP \d{3}\b/i.test(lastErr)) deadHosts.add('alipic.lanhuapp.com')
        }
      }

      failedByUrl.set(url, lastErr || '下载失败')
    }))
  }

  const textRects = [...compiled.boxes.values()]
    .filter((b) => b.type === 'lanhutext' && b.text?.trim())
    .map((b) => b.raw)

  let cdn = 0
  let alipic = 0
  let cropped = 0
  let compositeIcons = 0
  let placeholders = 0
  const failed = []

  const applyLocalUrl = (b, prop, localFile) => {
    if (prop === 'background' && b.css.background) {
      b.css.background = String(b.css.background).replace(CSS_URL_RE, `url("./${localFile}")`)
    } else {
      b.css.backgroundImage = `url("./${localFile}")`
    }
  }

  const stripDeadUrl = (b, prop) => {
    if (prop === 'background' && b.css.background) {
      const stripped = String(b.css.background).replace(CSS_URL_RE, '').trim()
      if (!stripped || /^(no-repeat|repeat|center|cover|contain|\d+%|\s)+$/i.test(stripped)) delete b.css.background
      else b.css.background = stripped
    }
    delete b.css.backgroundImage
  }

  for (const { box: b, url, prop } of imgBoxes) {
    const hit = store.get(url)
    if (hit) {
      applyLocalUrl(b, prop, hit.file)
      b.asset = {
        status: 'ok',
        file: hit.file,
        source: hit.source,
        pxWidth: hit.pxWidth,
        pxHeight: hit.pxHeight,
        ...(hit.blank ? { blank: true } : {}),
      }
      if (hit.source === 'alipic') alipic++
      else cdn++
      continue
    }
    const errMsg = failedByUrl.get(url) ?? '下载失败'
    if (refImg && b.raw.w >= 2 && b.raw.h >= 2 && !overlapsText(b.raw, textRects)) {
      try {
        const cropBuf = encodePng(cropPng(refImg, b.raw))
        const cropName = `crop-s${compiled.screenIndex}-${b.idx}-${createHash('sha1').update(url).digest('hex').slice(0, 6)}.png`
        writeFileSync(join(dir, cropName), cropBuf)
        const file = `assets/${cropName}`
        store.set(`${url}#s${compiled.screenIndex}-${b.idx}`, {
          url,
          file,
          bytes: cropBuf.length,
          pxWidth: b.raw.w,
          pxHeight: b.raw.h,
          source: 'cropped-from-reference',
        })
        applyLocalUrl(b, prop, file)
        b.asset = { status: 'ok', file, source: 'cropped-from-reference', pxWidth: b.raw.w, pxHeight: b.raw.h }
        cropped++
        continue
      } catch { /* 裁剪异常退回占位 */ }
    }
    stripDeadUrl(b, prop)
    b.asset = { status: 'placeholder', reason: 'overlaid-by-text', error: errMsg }
    placeholders++
    failed.push({ url, node: b.name, error: errMsg })
  }

  // 预裁 Figma 拆碎的组合小图标（如 CSS 描边矩形 + 半截切图拼成的入口小图标）
  const matchedCompositeNodes = new Set()
  const hasMatchedAncestor = (b) => {
    let p = b.parentNode
    while (p) {
      if (matchedCompositeNodes.has(p)) return true
      p = compiled.boxes.get(p)?.parentNode ?? null
    }
    return false
  }
  for (const [node, b] of compiled.boxes) {
    if (chrome.skipNodeSet.has(node) || hasMatchedAncestor(b) || !isCompositeIconContainer(b, compiled.boxes)) continue
    matchedCompositeNodes.add(node)
    if (refImg && !overlapsText(b.raw, textRects)) {
      try {
        const compBuf = encodePng(cropPng(refImg, b.raw))
        const compName = `composite-s${compiled.screenIndex}-${b.name}.png`
        const file = `assets/${compName}`
        writeFileSync(join(dir, compName), compBuf)
        const key = `composite://screen-${compiled.screenIndex}/${b.name}`
        store.set(key, {
          url: key,
          file,
          bytes: compBuf.length,
          pxWidth: b.raw.w,
          pxHeight: b.raw.h,
          source: 'composite-icon-crop',
        })
        b.compositeAsset = { file, pxWidth: b.raw.w, pxHeight: b.raw.h }
        compositeIcons++
        continue
      } catch { /* 退回纯标注 */ }
    }
    b.compositeHint = true
  }

  writeFileSync(manifestPath, JSON.stringify([...store.values()], null, 2))
  const saved = cdn + alipic + cropped
  return { total: imgBoxes.length, saved, cdn, alipic, cropped, compositeIcons, placeholders, failed }
}

/** 把整张画布裁出这一屏；支持传入 PNG Buffer 或已解码的图像对象以在多屏时复用解码结果。 */
export function cropScreenPng(refPngOrImg, screenRaw) {
  try {
    const img = Buffer.isBuffer(refPngOrImg) ? decodePng(refPngOrImg) : refPngOrImg
    if (!img?.data) return { error: '无效 PNG 数据' }
    return encodePng(cropPng(img, { x: screenRaw.x, y: screenRaw.y, w: screenRaw.w, h: screenRaw.h }))
  } catch (e) {
    return { error: String(e.message ?? e) }
  }
}

export function writeArtifacts(outDir, { meta, tree, screens, screenDescs, compiled, groups, crop, skipSummary = false }) {
  mkdirSync(outDir, { recursive: true })
  const p = (f) => join(outDir, f)
  const screenNo = compiled.screenIndex
  const title = screenDescs?.[screenNo]?.title ?? ''

  if (!skipSummary) {
    writeFileSync(p('meta.json'), JSON.stringify({
      ...meta,
      reference: meta.referenceUrl ? 'screen-<n>.png 已裁出；整张原图见 reference.png' : undefined,
      screens: screenDescs,
      compiledAt: new Date().toISOString(),
    }, null, 2))
    if (tree) writeFileSync(p('dds.raw.json'), JSON.stringify(tree))
    if (screenDescs) writeFileSync(p('screens.json'), JSON.stringify(screenDescs, null, 2))
  }

  const singleTokensText = tokensCss(collectTokens(compiled))
  if (!skipSummary) writeFileSync(p('tokens.css'), singleTokensText + '\n')

  compiled.ir = buildIr(compiled.boxes, compiled.root)
  const html = renderHtml(compiled, { tokens: singleTokensText, title: `screen ${screenNo}` })
  const spec = specMarkdown(compiled, groups, { title, unit: meta.unit ?? 'design' })
  writeFileSync(p(`screen-${screenNo}.spec.md`), spec)
  writeFileSync(p(`screen-${screenNo}.html`), html)
  writeFileSync(p(`screen-${screenNo}.ir.json`), JSON.stringify(compiled.ir, null, 2))
  writeFileSync(p(`screen-${screenNo}.rects.json`), JSON.stringify(compiled.rects, null, 2))
  writeFileSync(p(`screen-${screenNo}.outline.md`), outlineMarkdown(compiled, groups))
  if (crop && Buffer.isBuffer(crop)) writeFileSync(p(`screen-${screenNo}.png`), crop)

  if (!skipSummary) {
    const report = buildReport({
      meta,
      screens: screenDescs ?? [],
      compiledList: [compiled],
      groupsByScreen: [[screenNo, groups]],
    })
    writeFileSync(p('report.md'), report)
  }

  return {
    outDir: resolve(outDir),
    screen: screenNo,
    index: screenNo,
    specFile: `screen-${screenNo}.spec.md`,
    files: [
      `screen-${screenNo}.spec.md`, `screen-${screenNo}.png`, `screen-${screenNo}.html`,
      `screen-${screenNo}.ir.json`, `screen-${screenNo}.rects.json`, `screen-${screenNo}.outline.md`,
      'tokens.css', 'report.md', 'screens.json', 'meta.json',
    ],
    warnings: compiled.warnings.length,
    nodes: compiled.boxes.size,
    repeatGroups: groups.length,
  }
}

function writeSummaryArtifacts(outDir, { meta, screenDescs, builtEntries, assetStats }) {
  const p = (f) => join(outDir, f)
  const compiledList = builtEntries.map((e) => e.compiled)
  const tokensText = tokensCss(collectTokens(compiledList))
  writeFileSync(p('tokens.css'), tokensText + '\n')

  const { pairs, markdown } = buildVariantsDiff(builtEntries)
  if (markdown) writeFileSync(p('variants-diff.md'), markdown)

  const report = buildReport({
    meta,
    screens: screenDescs ?? [],
    compiledList,
    groupsByScreen: builtEntries.map((e) => [e.compiled.screenIndex, e.groups]),
    assetStats,
    variantPairs: pairs,
  })
  writeFileSync(p('report.md'), report)
  return {
    variantsDiff: markdown ? 'variants-diff.md' : null,
    variantPairs: pairs.map(({ A, B, ratio }) => ({
      a: A.compiled.screenIndex,
      b: B.compiled.screenIndex,
      overlap: Math.round(ratio * 100) / 100,
    })),
  }
}

// ---------------------------------------------------------------- Cookie

/**
 * Cookie 只存一个地方：<DATA_HOME>/cookie（默认 ~/.dsh-lanhu-dds/cookie，0600）。
 * 不读环境变量、不读 .env —— 只有一个位置，有没有、失没失效，看这一个文件就够。
 */
/** 根目录：Cookie 常驻，产物与临时脚本按会话分目录。不往项目里写。 */
export const DATA_HOME = process.env.DSH_LANHU_DDS_HOME || join(homedir(), '.dsh-lanhu-dds')
export const COOKIE_FILE = join(DATA_HOME, 'cookie')
export const SESSIONS_DIR = join(DATA_HOME, 'sessions')

/**
 * 会话键：显式指定 > DSH 会话 id（exec.agent.id）> 环境变量 > 按当前目录的短哈希。
 * 命令行没有会话概念，用 cwd 哈希可以让同一项目的多次运行复用同一个会话目录。
 */
export function sessionKey(explicit, exec) {
  // 显式名保留成可读的 slug；DSH 会话 id 形如 session-<uuid>，去掉前缀只留 12 位十六进制
  if (explicit) {
    const name = String(explicit).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 24)
    if (name) return name
  }
  const derived = exec?.agent?.id || process.env.DSH_SESSION_ID
  if (derived) {
    const key = String(derived).replace(/^session-/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
    if (key) return key
  }
  return `cli-${createHash('sha1').update(resolve(process.cwd())).digest('hex').slice(0, 6)}`
}

export function sessionDir(explicit, exec) {
  return join(SESSIONS_DIR, sessionKey(explicit, exec))
}

/** 该会话的临时脚本目录（存在即建好）。 */
export function sessionTmp(explicit, exec) {
  const dir = join(sessionDir(explicit, exec), 'tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 清掉 N 天没动过的会话目录。 */
export function pruneSessions({ days = 7 } = {}) {
  const cutoff = Date.now() - days * 86400000
  const removed = []
  let entries = []
  try {
    entries = readdirSync(SESSIONS_DIR, { withFileTypes: true })
  } catch {
    return { ok: true, days, removed, kept: 0 }
  }
  const kept = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(SESSIONS_DIR, e.name)
    if (statSync(dir).mtimeMs >= cutoff) {
      kept.push(e.name)
      continue
    }
    rmSync(dir, { recursive: true, force: true })
    removed.push(e.name)
  }
  return { ok: true, days, removed, kept: kept.length }
}

export function readCookie() {
  try {
    return readFileSync(COOKIE_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

export function saveCookie(value) {
  const v = String(value ?? '').trim()
  if (!v) return { ok: false, error: '空值不保存' }
  mkdirSync(dirname(COOKIE_FILE), { recursive: true })
  writeFileSync(COOKIE_FILE, v + '\n', { mode: 0o600 })
  try {
    chmodSync(COOKIE_FILE, 0o600)
  } catch {
    // Windows 上 chmod 基本是空操作
  }
  return { ok: true, path: COOKIE_FILE }
}

export function forgetCookie() {
  try {
    rmSync(COOKIE_FILE, { force: true })
    return { ok: true, removed: COOKIE_FILE }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

// ---------------------------------------------------------------- 产物目录

/** 中间产物统一落在 <工作目录>/.lanhu-dds/ 下，不散落。 */
export const OUT_ROOT = '.lanhu-dds'

export function resolveOutDir(out, { name = '', imageId = '', session, exec } = {}) {
  const base = sessionDir(session, exec)
  mkdirSync(base, { recursive: true })
  const safe = (v) => String(v || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (out) {
    const sub = String(out).trim()
    if (/[\\/]/.test(sub) || sub === '..' || sub === '.') {
      throw new Error(`out 只能是会话目录下的一层目录名，不能带路径：${sub}`)
    }
    return join(base, safe(sub) || safe(name) || 'design')
  }
  const slug = safe(name) || 'design'
  const id = String(imageId || '').slice(0, 8)
  return join(base, id ? `${slug}-${id}` : slug)
}

// ---------------------------------------------------------------- 高层入口

/**
 * 一条命令走完「拉取 → 选屏 → 编译 → 切图 → 裁参考图 → 落盘」。
 * CLI 与 DSH 插件共用这个函数，保证两条路径产出完全一致。
 */
export async function buildDesign({
  url, cookie, out, session, exec, screens: picked, scale: forcedScale, unit: unitOpt,
  reference = true, assets = true, list = false, clean = false, meta: injectedMeta,
} = {}) {
  if (!url && !injectedMeta) throw new Error('缺少 url')
  if (!cookie && !injectedMeta) {
    throw new Error('缺少蓝湖 Cookie：由用户给出后作为参数传入（不读环境变量、不读配置文件）')
  }
  const ids = url ? parseLanhuUrl(url) : {}
  const meta0 = await resolveImage({ ...ids, cookie })
  const tempOutDir = !list ? resolveOutDir(out, { name: meta0.name, imageId: ids.imageId, session, exec }) : null
  let existingMeta = null
  if (tempOutDir && !clean && existsSync(join(tempOutDir, 'meta.json'))) {
    try { existingMeta = JSON.parse(readFileSync(join(tempOutDir, 'meta.json'), 'utf8')) } catch { existingMeta = null }
  }
  const rawCachePath = tempOutDir ? join(tempOutDir, 'dds.raw.json') : null
  let tree = null
  if (existingMeta && existingMeta.versionId === meta0.versionId && rawCachePath && existsSync(rawCachePath)) {
    try { tree = JSON.parse(readFileSync(rawCachePath, 'utf8')) } catch { tree = null }
  }
  if (!tree) tree = await fetchDds({ versionId: meta0.versionId, cookie })
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

  if (list) return { ok: true, list: true, session: sessionKey(session, exec), name: meta.name, canvas, scale, unit, screens: descs }

  const outDir = tempOutDir
  const canReuse = Boolean(
    !clean
    && existingMeta
    && existingMeta.versionId === meta.versionId
    && existingMeta.unit === unit
    && existingMeta.scale === scale,
  )
  if (!canReuse && existsSync(outDir) && readdirSync(outDir).length) {
    // 仅在显式 clean 或设计稿版本/单位变更时清空目录；同版本局部重编保留其余屏产物与切图
    for (const f of readdirSync(outDir)) rmSync(join(outDir, f), { recursive: true, force: true })
  }
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(join(outDir, 'dds.raw.json'))) writeFileSync(join(outDir, 'dds.raw.json'), JSON.stringify(tree))
  writeFileSync(join(outDir, 'screens.json'), JSON.stringify(descs, null, 2))
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
    ...meta,
    reference: meta.referenceUrl ? 'screen-<n>.png 已裁出；整张原图见 reference.png' : undefined,
    screens: descs,
    compiledAt: new Date().toISOString(),
  }, null, 2))

  let refPng = null
  let refImg = null
  const refPath = join(outDir, 'reference.png')
  if (canReuse && existsSync(refPath)) {
    try {
      refPng = readFileSync(refPath)
      refImg = decodePng(refPng)
    } catch {
      refPng = null
      refImg = null
    }
  }
  if (!refPng && reference && meta.referenceUrl) {
    try {
      refPng = await getBinary(meta.referenceUrl, cookie)
      writeFileSync(refPath, refPng)
      try { refImg = decodePng(refPng) } catch { refImg = null }
    } catch (e) {
      refPng = null
      meta.referenceError = String(e.message ?? e)
    }
  }

  const want = picked === undefined || picked === 'all'
    ? allScreens.map((s) => s.index)
    : String(picked).split(',').map((x) => Number(x.trim()))
  const built = []
  const builtEntriesByIdx = new Map()
  const deadHosts = new Set()
  const manifestByUrl = new Map()
  const assetSummary = { total: 0, saved: 0, cdn: 0, alipic: 0, cropped: 0, compositeIcons: 0, placeholders: 0 }

  for (const idx of want) {
    const s = allScreens[idx]
    if (!s) { built.push({ screen: idx, error: '该屏不存在' }); continue }
    const compiled = compileScreen(tree, s.node, { scale: div, screenIndex: idx })
    const assetResult = assets
      ? await localizeAssets(compiled, outDir, cookie, { refImg, deadHosts, manifestByUrl })
      : null
    if (assetResult) {
      assetSummary.total += assetResult.total
      assetSummary.saved += assetResult.saved
      assetSummary.cdn += assetResult.cdn
      assetSummary.alipic += assetResult.alipic
      assetSummary.cropped += assetResult.cropped
      assetSummary.compositeIcons += assetResult.compositeIcons ?? 0
      assetSummary.placeholders += assetResult.placeholders
    }
    const needCrop = reference || !existsSync(join(outDir, `screen-${idx}.png`))
    const crop = needCrop && (refImg || refPng)
      ? cropScreenPng(refImg || refPng, s.raw)
      : (existsSync(join(outDir, `screen-${idx}.png`)) ? 'reused' : null)
    const groups = findRepeatGroups(compiled)
    const result = writeArtifacts(outDir, {
      meta, tree: null, screens: allScreens, screenDescs: descs, compiled, groups,
      crop: Buffer.isBuffer(crop) ? crop : null,
      skipSummary: true,
    })
    builtEntriesByIdx.set(idx, { compiled, groups, title: descs[idx].title })
    built.push({
      index: idx,
      title: descs[idx].title,
      size: { width: descs[idx].width, height: descs[idx].height },
      raster: descs[idx].raster,
      specFile: result.specFile,
      crop: Buffer.isBuffer(crop) || crop === 'reused' ? `screen-${idx}.png` : (crop?.error ?? null),
      nodes: result.nodes,
      warnings: result.warnings,
      assets: assetResult ? {
        total: assetResult.total,
        saved: assetResult.saved,
        cdn: assetResult.cdn,
        alipic: assetResult.alipic,
        cropped: assetResult.cropped,
        compositeIcons: assetResult.compositeIcons ?? 0,
        placeholders: assetResult.placeholders,
      } : null,
      repeatGroups: groups.map((g) => ({ parent: g.parentName, count: g.count, texts: g.texts })),
    })
  }

  // 若目录下还保留着同会话前序编译的其他屏（增量构建），一并纳入全局 report.md 与 variants-diff.md，避免冲掉前序汇总
  if (canReuse) {
    for (const f of readdirSync(outDir)) {
      const m = /^screen-(\d+)\.spec\.md$/.exec(f)
      if (!m) continue
      const idx = Number(m[1])
      if (builtEntriesByIdx.has(idx) || !allScreens[idx]) continue
      const compiled = compileScreen(tree, allScreens[idx].node, { scale: div, screenIndex: idx })
      builtEntriesByIdx.set(idx, { compiled, groups: findRepeatGroups(compiled), title: descs[idx].title })
    }
  }
  const summaryEntries = [...builtEntriesByIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)

  const summary = summaryEntries.length
    ? writeSummaryArtifacts(outDir, { meta, screenDescs: descs, builtEntries: summaryEntries, assetStats: assets ? assetSummary : null })
    : { variantsDiff: null, variantPairs: [] }

  const key = sessionKey(session, exec)
  return {
    ok: true,
    session: key,
    tmpDir: sessionTmp(session, exec),
    outDir,
    reusedCache: canReuse,
    canvas,
    scale,
    unit,
    totalScreens: descs.length,
    built,
    cachedScreens: [...builtEntriesByIdx.keys()].sort((a, b) => a - b),
    assets: assets ? assetSummary : null,
    variantsDiff: summary.variantsDiff,
    variantPairs: summary.variantPairs,
    reference: existsSync(refPath),
  }
}

// ---------------------------------------------------------------- 命令

async function cmdBuild(args) {
  const givenCookie = args.cookie
  const cookie = givenCookie || readCookie()
  if (!args.url) die('build 需要 --url "<蓝湖设计图链接>"')
  const r = await buildDesign({
    url: args.url,
    cookie,
    out: args.out,
    session: args.session,
    screens: args.screen,
    scale: args.scale,
    unit: args.unit,
    reference: args['no-ref'] !== 'true',
    assets: args['no-assets'] !== 'true',
    list: args.list === 'true',
    clean: args.clean === 'true',
  })
  if (r.list) { console.log(JSON.stringify({ name: r.name, canvas: r.canvas, scale: r.scale, screens: r.screens }, null, 2)); return }
  if (givenCookie) saveCookie(givenCookie)
  console.error(`[lanhu-dds] 画布 ${r.canvas.width}×${r.canvas.height} @${r.scale}x，共 ${r.totalScreens} 屏；会话 ${sessionKey(args.session)}，输出 ${r.outDir}`)
  console.log(JSON.stringify(r, null, 2))
}

async function cmdLocal(args) {
  if (!args.dds) die('local 需要 --dds <dds.raw.json>')
  const cookie = args.cookie || readCookie()
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
  const outDir = resolveOutDir(args.out, { session: args.session })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'screens.json'), JSON.stringify(descs, null, 2))
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify({ ...meta, screens: descs, compiledAt: new Date().toISOString() }, null, 2))
  const picked = args.screen === 'all' || args.screen === undefined ? screens.map((s) => s.index) : String(args.screen).split(',').map(Number)
  const refPng = args.ref && existsSync(args.ref) ? readFileSync(args.ref) : null
  let refImg = null
  if (refPng) {
    try { refImg = decodePng(refPng) } catch { refImg = null }
  }
  const results = []
  const builtEntries = []
  const deadHosts = new Set()
  const manifestByUrl = new Map()
  const assetSummary = { total: 0, saved: 0, cdn: 0, alipic: 0, cropped: 0, compositeIcons: 0, placeholders: 0 }
  const wantAssets = args['no-assets'] !== 'true'

  for (const idx of picked) {
    const s = screens[idx]
    if (!s) continue
    const compiled = compileScreen(tree, s.node, { scale: div, screenIndex: idx })
    if (wantAssets) {
      const ar = await localizeAssets(compiled, outDir, cookie, { refImg, deadHosts, manifestByUrl })
      assetSummary.total += ar.total
      assetSummary.saved += ar.saved
      assetSummary.cdn += ar.cdn
      assetSummary.alipic += ar.alipic
      assetSummary.cropped += ar.cropped
      assetSummary.compositeIcons += ar.compositeIcons ?? 0
      assetSummary.placeholders += ar.placeholders
    }
    const crop = (refImg || refPng) ? cropScreenPng(refImg || refPng, s.raw) : null
    if (crop?.error) console.error(`[lanhu-dds] 屏 ${idx} 裁剪跳过：${crop.error}`)
    const groups = findRepeatGroups(compiled)
    builtEntries.push({ compiled, groups, title: descs[idx].title })
    results.push(writeArtifacts(outDir, {
      meta, tree: null, screens, screenDescs: descs, compiled, groups,
      crop: Buffer.isBuffer(crop) ? crop : null,
      skipSummary: true,
    }))
  }
  const summary = builtEntries.length
    ? writeSummaryArtifacts(outDir, { meta, screenDescs: descs, builtEntries, assetStats: wantAssets ? assetSummary : null })
    : { variantsDiff: null, variantPairs: [] }
  console.log(JSON.stringify({ ok: true, outDir, screens: descs, built: results, variantsDiff: summary.variantsDiff, variantPairs: summary.variantPairs }, null, 2))
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
  ' floating-ui'.trim(), 'iconify', 'unocss', 'tailwindcss', 'postcss', 'swc', 'esbuild',
])

const NON_UI_PKG_RE = /(?:^|[-/])(func|utils?|tools?|sdk|rrweb[\w-]*|track[\w-]*|monitor[\w-]*|logger|commit[\w-]*|eslint[\w-]*|stylelint[\w-]*|prettier[\w-]*|tsconfig[\w-]*|vite[\w-]*|babel[\w-]*|webpack[\w-]*|rollup[\w-]*|cli|mock[\w-]*|types|hooks?|request|axios|http|bridge|jssdk|crypto|storage|埋点)(?:$|[-/])/i
const UI_PKG_RE = /(?:^|[-/])(ui|components?|design|widgets?|mobile|vant|nutui)(?:$|[-/])/i
const ICON_PKG_RE = /(?:^|[-/])icons?(?:$|[-/])/i

const RULES_REL = '.agents/skills/lanhu-dds-codegen/project-rules.md'
const UI_DOC_REL = '.agents/skills/lanhu-dds-codegen/ui-library.md'

function classifyInternalPackages(internalPackages) {
  const uiPackages = []
  const iconPackages = []
  for (const name of internalPackages) {
    const short = name.includes('/') ? name.split('/')[1] : name
    if (ICON_PKG_RE.test(short)) {
      iconPackages.push(name)
      continue
    }
    if (NON_UI_PKG_RE.test(short) && !UI_PKG_RE.test(short)) continue
    if (UI_PKG_RE.test(short)) uiPackages.unshift(name)
    else uiPackages.push(name)
  }
  return { uiPackages, iconPackages }
}

function detectAgentDocs(dir) {
  const candidates = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md']
  const found = []
  for (const rel of candidates) {
    try {
      const t = readFileSync(join(dir, rel), 'utf8').trim()
      if (t.length >= 200) found.push({ file: rel, chars: t.length })
    } catch { /* 不存在 */ }
  }
  return {
    present: found.length > 0,
    primary: found[0]?.file ?? null,
    files: found,
  }
}

function pickWidth(text, key) {
  if (!text) return null
  const m = text.match(new RegExp(`${key}\\s*[:=]\\s*(\\d+(?:\\.\\d+)?)`))
  return m ? Number(m[1]) : null
}

/**
 * 判断这个项目该用哪个输出单位、既有 AGENTS.md / project-rules.md / ui-library.md 接入情况。
 * 若项目根已有完备的 AGENTS.md / CLAUDE.md，直接认作主规范来源，不再强迫生成空白 project-rules.md。
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
  const { uiPackages, iconPackages } = classifyInternalPackages(internalPackages)

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

  const agentDocs = detectAgentDocs(dir)

  // 规范接入情况
  const rulesRaw = read(RULES_REL)
  let rules = { present: false, delegatedTo: agentDocs.primary, unfilled: [], placeholders: 0 }
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
    rules = { present: true, delegatedTo: agentDocs.primary, unfilled, placeholders }
  }

  const todos = []
  if (!rules.present && !agentDocs.present) {
    todos.push(`项目根无 AGENTS.md 且无 ${RULES_REL}：跑 doctor --init 生成模板并填入真实规范`)
  } else if (rules.present && !agentDocs.present) {
    if (rules.unfilled.length) todos.push(`project-rules.md 有 ${rules.unfilled.length} 项未填：${rules.unfilled.slice(0, 8).join('、')}${rules.unfilled.length > 8 ? '…' : ''}`)
    if (rules.placeholders) todos.push(`project-rules.md 还有 ${rules.placeholders} 处示例占位，换成真实内容或删掉`)
  } else if (rules.present && agentDocs.present && (rules.unfilled.length >= 10 || rules.placeholders >= 5)) {
    todos.push(`项目已有 ${agentDocs.primary}，而 ${RULES_REL} 仍是未填模板（空 ${rules.unfilled.length} 项）：直接以 ${agentDocs.primary} 为准，可删掉空模板避免冲突`)
  }

  const ui = readUiLibrary(dir)
  const targetUiPkgs = uiPackages.length ? uiPackages : iconPackages
  if (targetUiPkgs.length) {
    if (!ui.present) {
      todos.push(
        `未生成 ${UI_DOC_REL}：跑 doctor --ui（将自动扫描 ${[...uiPackages, ...iconPackages].join('、')}）。若扫不出再向用户询问组件用法，勿凭包名猜 API`
      )
    } else if (!ui.usable) {
      todos.push(`UI 清单不可用（${ui.components} 个组件，${ui.withProps} 个含 props）：可重跑 doctor --ui --pkg ${uiPackages[0] || targetUiPkgs[0]}，仍为空再询问用户`)
    }
  } else if (!internalPackages.length && deps.includes('vant') && !agentDocs.present) {
    todos.push('只看到公共 vant，没识别到内网 UI 库：确认是否有内网封装组件库')
  }
  if (!unit) todos.push('没找到单位基准（designWidth / rootValue / viewportWidth）：默认按 750 设计稿输出，接入时确认一次')

  // 中间文件污染检测
  const strays = []
  for (const rel of ['.agents/tmp', 'tmp', 'scratch', '.lanhu-dds', 'design/dds']) {
    if (existsSync(join(dir, rel))) strays.push(rel)
  }
  for (const base of ['.', '.agents/tmp']) {
    let entries = []
    try {
      entries = readdirSync(join(dir, base))
    } catch {
      continue
    }
    for (const f of entries) {
      if (!/^(dump|probe|tmp|debug|scratch)[\w.-]*\.(mjs|js|cjs|ts)$/.test(f) && !/^screen-\d+\.(ir|rects|spec)\.(json|md)$/.test(f)) continue
      strays.push(base === '.' ? f : `${base}/${f}`)
    }
  }
  if (strays.length) {
    todos.push(
      `${strays.length} 处中间/临时文件留在项目里（${strays.slice(0, 4).join('、')}${strays.length > 4 ? '…' : ''}）：删掉，临时脚本只放 ${DATA_HOME}`
    )
  }

  return {
    ok: true,
    dir,
    packageName: pkg.name ?? null,
    framework,
    internalPackages,
    uiPackages,
    iconPackages,
    unit: unit ?? 'design',
    unitFrom: unitFrom ?? '未找到配置，默认 750 设计稿',
    agentDocs,
    rules,
    ui,
    strays,
    todos,
    ready: todos.length === 0,
  }
}

/** 把 Skill 自带的 project-rules.md 模板复制到项目里，作为接入起点；若已有完备 AGENTS.md 则直接复用不建空模板。 */
export function initProjectRules(projectDir = process.cwd()) {
  const dir = resolve(projectDir)
  const dest = join(dir, RULES_REL)
  if (existsSync(dest)) return { ok: false, error: `${RULES_REL} 已存在，不覆盖`, path: dest }
  const agentDocs = detectAgentDocs(dir)
  if (agentDocs.present) {
    return {
      ok: true,
      skipped: true,
      delegatedTo: agentDocs.primary,
      note: `项目根已有 ${agentDocs.primary}，直接以它为主规范来源，不生成空白 ${RULES_REL}`,
    }
  }
  const src = ['../project-rules.md', '../skills/lanhu-dds-codegen/project-rules.md', './project-rules.md']
    .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
    .find((p) => existsSync(p))
  if (!src) return { ok: false, error: '找不到 project-rules.md 模板（安装包不完整）' }
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(src))
  return { ok: true, path: dest }
}

const SKIP_DIRS = /^(node_modules|\.\w|__tests__|__mocks__|demo|demos|docs|example|examples|components?|atoms?|molecules?|organisms?|templates?|pages?|views?|business|modules?|packages?|containers?|layouts?|widgets?|es|esm|lib|dist|src|build|cjs|mjs|umd|types|typings|style|styles|theme|locale|locales|utils?|hooks?|_util|common|shared|assets|icons?|constants|mixins|directives|composables)$/i
const WALK_PRUNE_DIRS = /^(node_modules|\.\w|__tests__|__mocks__|demo|demos|docs|example|examples|style|styles|theme|locale|locales|utils?|hooks?|_util|assets|constants|mixins|directives|composables)$/i

const pascal = (s) => s.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')

const NOISE_PROP = /^(class|style|innerHTML|ref|key|slots?|scopedSlots|attrs|children|v-slots|modelModifiers|\$\w+|__\w+|on[A-Z]\w*)$/
const NOISE_SLOT = /^(\$\w+|__\w+)$/
const WRAPPER_TYPE_NAMES = new Set([
  'Readonly', 'Partial', 'Required', 'Pick', 'Omit', 'ExtractPropTypes', 'ExtractPublicPropTypes',
  'typeof', 'import', 'vue', 'PublicProps', 'VNodeProps', 'AllowedComponentProps', 'ComponentCustomProps',
  '__VLS_TypePropsToRuntimeProps', '__VLS_WithDefaults', '__VLS_PrettifyLocal', '__VLS_NonUndefinedable', '__VLS_PublicProps',
])

const normCompKey = (s) => String(s ?? '').toLowerCase().replace(/[-_]/g, '')

function stripJsComments(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/** 提取从 openBraceIdx ('{') 开始的平衡花括号内容与顶层（depth=1）属性键名。 */
function topKeysInBrace(text, openBraceIdx, { isSlot = false } = {}) {
  if (text[openBraceIdx] !== '{') return []
  let depth = 0
  let inStr = ''
  let inLineComment = false
  let inBlockComment = false
  let segStart = openBraceIdx + 1
  const topSegments = []

  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++ }
      continue
    }
    if (inStr) {
      if (ch === '\\') { i++; continue }
      if (ch === inStr) inStr = ''
      continue
    }
    if (ch === '/' && next === '/') { inLineComment = true; i++; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue }
    if (ch === '\'' || ch === '"' || ch === '`') { inStr = ch; continue }

    if (ch === '{') {
      if (depth === 1 && segStart >= 0) {
        topSegments.push(text.slice(segStart, i) + '_nested_')
        segStart = -1
      }
      depth++
      if (depth === 1) segStart = i + 1
    } else if (ch === '}') {
      if (depth === 1 && segStart >= 0) topSegments.push(text.slice(segStart, i))
      depth--
      if (depth === 0) break
      if (depth === 1) segStart = i + 1
    }
  }

  const keys = []
  const body = topSegments.join('')
  const filterRe = isSlot ? NOISE_SLOT : NOISE_PROP
  for (const rawLine of body.split(/[;\n]/)) {
    const line = rawLine.replace(/^\s*readonly\s+/, '').trim()
    const m = line.match(/^(['"]?)([A-Za-z_$][\w$-]*)\1\??\s*[:(]/)
    if (!m) continue
    const k = m[2]
    if (filterRe.test(k)) continue
    if (!keys.includes(k)) keys.push(k)
  }
  return keys
}

function lookupNamedTypeBrace(text, refName, baseDir = null) {
  const escName = refName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declRe = new RegExp(
    `(?:(?:interface|type)\\s+${escName}(?:\\s*<[^>]*>)?\\s*(?:=\\s*)?(?:extends[^{;]*)?|(?:export\\s+)?(?:declare\\s+)?const\\s+${escName}\\s*:\\s*(?:Readonly\\s*<\\s*)?)\\{`,
  )
  const localMatch = declRe.exec(text)
  if (localMatch) return topKeysInBrace(text, localMatch.index + localMatch[0].length - 1)
  if (!baseDir) return []

  const impRe = new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${escName}\\b[^}]*\\}\\s+from\\s+['"](\\.[^'"]+)['"]`)
  const impMatch = impRe.exec(text)
  if (!impMatch) return []
  const target = resolveModuleTarget(baseDir, impMatch[1])
  if (!target) return []
  try {
    const extText = readFileSync(target, 'utf8')
    const extMatch = declRe.exec(extText)
    if (extMatch) return topKeysInBrace(extText, extMatch.index + extMatch[0].length - 1)
  } catch { /* 忽略 */ }
  return []
}

/**
 * 解析 DefineComponent<FirstTypeArg, ...> 的第一个类型参数：
 * 兼容 DefineComponent<{...}>、DefineComponent<ExtractPropTypes<{...}>>、
 * DefineComponent<__VLS_TypePropsToRuntimeProps<{...}>>、DefineComponent<XwCardProps> 等全部 vue-tsc 产物形态。
 */
function extractFromDefineComponentAt(text, ltIdx, baseDir = null) {
  if (text[ltIdx] !== '<') return []
  let angle = 0
  let paren = 0
  let brace = 0
  for (let i = ltIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') { paren++; continue }
    if (ch === ')') { if (paren > 0) paren--; continue }
    if (paren > 0) continue
    if (ch === '{') {
      if (brace === 0 && angle >= 1) {
        const direct = topKeysInBrace(text, i)
        if (direct.length) return direct
      }
      brace++
      continue
    }
    if (ch === '}') { if (brace > 0) brace--; continue }
    if (brace > 0) continue
    if (ch === '<') { angle++; continue }
    if (ch === '>') {
      angle--
      if (angle === 0) {
        const firstArg = text.slice(ltIdx + 1, i)
        return resolveTypeArgRefs(text, firstArg, baseDir)
      }
      continue
    }
    if (ch === ',' && angle === 1) {
      const firstArg = text.slice(ltIdx + 1, i)
      return resolveTypeArgRefs(text, firstArg, baseDir)
    }
  }
  return []
}

function resolveTypeArgRefs(text, firstArg, baseDir) {
  const keys = new Set()
  for (const idMatch of firstArg.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const id = idMatch[1]
    if (WRAPPER_TYPE_NAMES.has(id)) continue
    for (const k of lookupNamedTypeBrace(text, id, baseDir)) keys.add(k)
  }
  return [...keys]
}

function extractSlotsFromText(text) {
  const slots = new Set()
  for (const m of text.matchAll(/__VLS_WithTemplateSlots\s*</g)) {
    const ltIdx = m.index + m[0].length - 1
    let angle = 0
    let paren = 0
    let brace = 0
    let secondArgStart = -1
    for (let i = ltIdx; i < text.length; i++) {
      const ch = text[i]
      if (ch === '(') { paren++; continue }
      if (ch === ')') { if (paren > 0) paren--; continue }
      if (paren > 0) continue
      if (ch === '{') {
        if (secondArgStart >= 0 && brace === 0 && angle === 1) {
          for (const s of topKeysInBrace(text, i, { isSlot: true })) slots.add(s)
          break
        }
        brace++
        continue
      }
      if (ch === '}') { if (brace > 0) brace--; continue }
      if (brace > 0) continue
      if (ch === '<') { angle++; continue }
      if (ch === '>') {
        angle--
        if (angle === 0) break
        continue
      }
      if (ch === ',' && angle === 1 && secondArgStart < 0) secondArgStart = i + 1
    }
  }
  for (const re of [/\$slots\??\s*:\s*(?:Readonly\s*<\s*)?\{/g, /\bSlotsType\s*<\s*(?:Readonly\s*<\s*)?\{/g]) {
    for (const m of text.matchAll(re)) {
      const braceIdx = m.index + m[0].length - 1
      for (const s of topKeysInBrace(text, braceIdx, { isSlot: true })) slots.add(s)
    }
  }
  return [...slots].slice(0, 8)
}

function extractVModelsFromText(text) {
  const models = new Set()
  const re = /(?:['"]onUpdate:([A-Za-z][\w-]*)['"]|\bonUpdate:([A-Za-z][\w-]*)\??\s*:|['"]update:([A-Za-z][\w-]*)['"])/g
  for (const m of text.matchAll(re)) {
    const key = m[1] || m[2] || m[3]
    if (!key) continue
    models.add(key === 'modelValue' ? 'v-model' : `v-model:${key}`)
  }
  return [...models].slice(0, 5)
}

function fileMatchesComponent(filePath, compName) {
  if (!filePath || !compName) return false
  const base = basename(filePath).replace(/\.(?:vue\.d\.ts|d\.ts|vue|tsx|jsx|mjs|cjs|ts|js)$/i, '')
  const target = normCompKey(compName)
  if (base.toLowerCase() === 'index') {
    return normCompKey(basename(dirname(filePath))) === target
  }
  return normCompKey(base) === target
}

function extractPropsFromText(t, { compName = null, baseDir = null, filePath = null } = {}) {
  const keys = new Set()
  const dedicatedFile = !compName || (filePath ? fileMatchesComponent(filePath, compName) : false)

  // 多组件合包或非同名文件优先精确定位目标组件的声明，绝不退回全文件乱抓别的组件（根治 Barrel 串台）
  if (compName) {
    const escComp = compName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const compDeclRe = new RegExp(
      `(?:export\\s+)?(?:declare\\s+)?const\\s+${escComp}\\s*:\\s*(?:__VLS_WithTemplateSlots\\s*<\\s*)?(?:import\\([^)]*\\)\\.)?DefineComponent\\s*<`,
      'g',
    )
    for (const m of t.matchAll(compDeclRe)) {
      const ltIdx = m.index + m[0].length - 1
      for (const k of extractFromDefineComponentAt(t, ltIdx, baseDir)) keys.add(k)
    }
    const lowerFirst = compName.charAt(0).toLowerCase() + compName.slice(1)
    for (const candidate of [`${compName}Props`, `${lowerFirst}Props`]) {
      for (const k of lookupNamedTypeBrace(t, candidate, baseDir)) keys.add(k)
    }
    if (keys.size && !dedicatedFile) return [...keys].slice(0, 14)
    if (!dedicatedFile) {
      // 无 filePath 调用（纯文本片段测试）且仅含单个 DefineComponent 时仍兼容解析；若有真实非同名文件路径则直接返回空
      if (filePath || (t.match(/\bDefineComponent\s*</g) ?? []).length !== 1) return []
    }
  }

  for (const m of t.matchAll(/\bDefineComponent\s*</g)) {
    const ltIdx = m.index + m[0].length - 1
    for (const k of extractFromDefineComponentAt(t, ltIdx, baseDir)) keys.add(k)
  }
  const patterns = [
    /(?:interface|type)\s+\w*(?:Props|Options|Attrs)\w*(?:\s*<[^>]*>)?\s*(?:=\s*)?(?:extends[^{;]*)?\{/g,
    /(?:export\s+)?(?:declare\s+)?const\s+\w*(?:Props|props)\w*\s*:\s*(?:Readonly\s*<\s*)?\{/g,
    /defineProps\s*<\s*\{/g,
    /\bprops\s*:\s*\{/g,
  ]
  for (const re of patterns) {
    for (const m of t.matchAll(re)) {
      const braceIdx = m.index + m[0].length - 1
      for (const k of topKeysInBrace(t, braceIdx)) keys.add(k)
    }
  }
  return [...keys].slice(0, 14)
}

function propsOfFile(filePath, pkgDir, compName = null) {
  try {
    const t = readFileSync(filePath, 'utf8')
    const props = extractPropsFromText(t, { compName, baseDir: dirname(filePath), filePath })
    const dedicated = !compName || fileMatchesComponent(filePath, compName)
    const slots = dedicated ? extractSlotsFromText(t) : []
    const vModels = dedicated ? extractVModelsFromText(t) : []
    const hasMeta = props.length > 0 || slots.length > 0 || vModels.length > 0
    const rel = filePath.startsWith(pkgDir) ? filePath.slice(pkgDir.length + 1).replace(/\\/g, '/') : basename(filePath)
    return { props, slots, vModels, from: hasMeta ? rel : null }
  } catch {
    return { props: [], slots: [], vModels: [], from: null }
  }
}

/** 从目录或单文件（.d.ts / .ts / .vue）抠 props、插槽与 v-model；from 记录取自哪个相对路径。 */
function propsOf(targetPath, pkgDir, compName = null) {
  let st = null
  try { st = statSync(targetPath) } catch { return { props: [], slots: [], vModels: [], from: null } }
  if (st.isFile()) return propsOfFile(targetPath, pkgDir, compName)

  let files = []
  try {
    files = readdirSync(targetPath).filter((f) => /\.(d\.ts|ts|vue)$/.test(f))
  } catch {
    return { props: [], slots: [], vModels: [], from: null }
  }
  // 优先读同名 .d.ts / index.d.ts / props.d.ts
  files.sort((a, b) => {
    const score = (x) => (compName && fileMatchesComponent(join(targetPath, x), compName) ? -1 : /props/i.test(x) ? 0 : x.endsWith('.d.ts') ? 1 : 2)
    return score(a) - score(b)
  })
  const keys = new Set()
  const slots = new Set()
  const vModels = new Set()
  let from = null
  const dirMatchesComp = compName ? normCompKey(basename(targetPath)) === normCompKey(compName) : true
  for (const f of files) {
    const full = join(targetPath, f)
    const r = propsOfFile(full, pkgDir, dirMatchesComp ? null : compName)
    if (r.props.length || r.slots.length || r.vModels.length) {
      for (const k of r.props) keys.add(k)
      for (const s of r.slots) slots.add(s)
      for (const vm of r.vModels) vModels.add(vm)
      if (!from) from = r.from
    }
  }
  return { props: [...keys].slice(0, 14), slots: [...slots].slice(0, 8), vModels: [...vModels].slice(0, 5), from }
}

function resolveModuleTarget(baseDir, spec) {
  const clean = spec.replace(/\.(?:vue\.d\.ts|d\.ts|vue|tsx|jsx|mjs|cjs|ts|js)$/i, '')
  const candidates = [
    join(baseDir, `${clean}.d.ts`),
    join(baseDir, `${clean}.vue.d.ts`),
    join(baseDir, clean, 'index.d.ts'),
    join(baseDir, `${clean}.vue`),
    join(baseDir, `${clean}.ts`),
    join(baseDir, spec),
    join(baseDir, `${clean}.mjs`),
    join(baseDir, `${clean}.js`),
    join(baseDir, clean, 'index.mjs'),
    join(baseDir, clean, 'index.js'),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

function collectBarrelExports(entryAbs, pkgDir) {
  const exported = new Map() // name -> absTargetPath | null
  const visited = new Set()

  const visit = (fileAbs, depth) => {
    if (!fileAbs || depth > 7 || visited.has(fileAbs)) return
    visited.add(fileAbs)
    let raw = ''
    try { raw = readFileSync(fileAbs, 'utf8') } catch { return }
    const t = stripJsComments(raw)
    const dir = dirname(fileAbs)

    // 0. 记录本地 import 绑定（兼容 `import XwCard from './XwCard.vue'; export { XwCard }` 两段式桶文件）
    const importedTargets = new Map()
    for (const m of t.matchAll(/import\s+(?:type\s+)?([A-Z][\w]*)\s+from\s+['"](\.[^'"]+)['"]/g)) {
      importedTargets.set(m[1], resolveModuleTarget(dir, m[2]))
    }
    for (const m of t.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](\.[^'"]+)['"]/g)) {
      const target = resolveModuleTarget(dir, m[2])
      for (const part of m[1].split(',')) {
        const cleaned = part.replace(/\btype\s+/g, '').trim()
        if (!cleaned) continue
        const [orig, alias] = cleaned.split(/\s+as\s+/)
        const localName = (alias ?? orig ?? '').trim()
        if (localName) importedTargets.set(localName, target)
      }
    }

    // 1. 本地声明的组件常量/类：export declare const XwButton: DefineComponent<...>
    const localDecls = new Set()
    for (const m of t.matchAll(/(?:export\s+)?(?:declare\s+)?(?:const|function|class)\s+([A-Z][\w]*)\b/g)) {
      localDecls.add(m[1])
      if (m[0].startsWith('export ') && !exported.has(m[1])) exported.set(m[1], fileAbs)
    }
    // 2. 无 from 的聚合导出：export { AddCircleOutline, XwIcon }
    for (const m of t.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}(?!\s*from)/g)) {
      if (/^export\s+type\b/.test(m[0])) continue
      for (const part of m[1].split(',')) {
        const cleaned = part.replace(/\btype\s+/g, '').trim()
        if (!cleaned) continue
        const [orig, alias] = cleaned.split(/\s+as\s+/)
        const origTrim = (orig ?? '').trim()
        const name = (alias ?? orig ?? '').trim()
        if (!/^[A-Z][\w]*$/.test(name) || exported.has(name)) continue
        if (importedTargets.has(origTrim)) {
          exported.set(name, importedTargets.get(origTrim) ?? null)
        } else if (localDecls.has(origTrim)) {
          exported.set(name, fileAbs)
        }
      }
    }
    // 3. 带 from 的具名转发：export { default as XwCard, XwButton } from './xxx'
    //    注意：target 解析失败时绝不把当前桶文件 fileAbs 冒充组件声明文件，否则会导致同桶组件 props 串台
    for (const m of t.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolveModuleTarget(dir, m[2])
      for (const part of m[1].split(',')) {
        if (/^\s*type\s+/.test(part)) continue
        const [orig, alias] = part.trim().split(/\s+as\s+/)
        const name = (alias ?? orig ?? '').trim()
        if (!/^[A-Z][\w]*$/.test(name)) continue
        if (!exported.has(name) || (!exported.get(name) && target)) {
          exported.set(name, target ?? null)
        }
      }
    }
    // 4. 透传第三方底层库的具名重导出（如 export { Button as VanButton } from 'vant'），记录为 null 供清单折叠展示
    for (const m of t.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^.'"][^'"]*)['"]/g)) {
      for (const part of m[1].split(',')) {
        if (/^\s*type\s+/.test(part)) continue
        const [orig, alias] = part.trim().split(/\s+as\s+/)
        const name = (alias ?? orig ?? '').trim()
        if (/^[A-Z][\w]*$/.test(name) && !exported.has(name)) exported.set(name, null)
      }
    }
    // 5. 递归跟进多级转发：export * from './components/wealth'（忽略命名空间对象 export * as Atoms）
    for (const m of t.matchAll(/export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolveModuleTarget(dir, m[2])
      if (!m[1] && target) visit(target, depth + 1)
    }
    // 若当前 .js 入口旁边有同名 .d.ts，顺带读它的类型导出
    if (/\.(m?js|cjs)$/.test(fileAbs)) {
      const dts = fileAbs.replace(/\.(m?js|cjs)$/, '.d.ts')
      if (existsSync(dts)) visit(dts, depth + 1)
    }
  }

  visit(entryAbs, 0)
  return exported
}

function isAggregatorDir(subAbs) {
  if (existsSync(join(subAbs, 'index.vue'))) return false
  const idxFile = ['index.d.ts', 'index.mjs', 'index.js', 'index.cjs']
    .map((f) => join(subAbs, f))
    .find((p) => existsSync(p))
  if (!idxFile) return false
  let raw = ''
  try { raw = readFileSync(idxFile, 'utf8') } catch { return false }
  const t = stripJsComments(raw)
  const hasReExport = /export\s*(?:\*|\{[^}]*\})\s*from\s*['"]/.test(t) || /import\s+[A-Z][\w]*\s+from\s+['"]\./.test(t)
  if (!hasReExport) return false
  const hasDefault = /\bexport\s+default\b|\bas\s+default\b/.test(t)
  const hasOwnDecl = /\bDefineComponent\b|(?:interface|type)\s+\w*(?:Props|Options)\b|(?:export\s+)?(?:declare\s+)?(?:const|function|class)\s+[A-Z]/.test(t)
  return !hasDefault && !hasOwnDecl
}

function indexComponentFiles(pkgDir) {
  const byKey = new Map() // normCompKey -> absPath（优先 .d.ts）
  const roots = ['es', 'esm', 'components', 'lib', 'src', 'dist']
    .map((r) => join(pkgDir, r))
    .filter((p) => existsSync(p))

  const prefer = (prev, next) => {
    if (!prev) return next
    const rank = (p) => (p.endsWith('.d.ts') ? 0 : p.endsWith('.vue') ? 1 : 2)
    return rank(next) < rank(prev) ? next : prev
  }

  const walk = (dirAbs, depth) => {
    if (depth > 6) return
    let entries = []
    try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (WALK_PRUNE_DIRS.test(e.name)) continue
        const subAbs = join(dirAbs, e.name)
        if (!SKIP_DIRS.test(e.name) && !isAggregatorDir(subAbs)) {
          const idx = ['index.d.ts', 'index.vue.d.ts', 'index.vue', 'index.ts']
            .map((f) => join(subAbs, f))
            .find((p) => existsSync(p))
          if (idx) {
            const k = normCompKey(e.name)
            byKey.set(k, prefer(byKey.get(k), idx))
          }
        }
        walk(subAbs, depth + 1)
      } else if (e.isFile()) {
        const m = e.name.match(/^([A-Z][A-Za-z0-9]+)\.(?:vue\.d\.ts|d\.ts|vue)$/)
        if (!m) continue
        const k = normCompKey(m[1])
        byKey.set(k, prefer(byKey.get(k), join(dirAbs, e.name)))
      }
    }
  }
  for (const r of roots) walk(r, 0)
  return byKey
}

function collectPkgCssVars(pkgDir) {
  const cssFiles = []
  const scanRoots = ['es', 'esm', 'dist', 'lib', '.']
  const walk = (dirAbs, depth) => {
    if (depth > 4 || cssFiles.length >= 30) return
    let entries = []
    try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (cssFiles.length >= 30) break
      if (e.isDirectory()) {
        if (depth === 0 && dirAbs === pkgDir && e.name !== 'style' && e.name !== 'styles' && e.name !== 'theme') continue
        if (/^(node_modules|\.\w|__tests__|demo|docs|src)$/.test(e.name)) continue
        walk(join(dirAbs, e.name), depth + 1)
      } else if (e.isFile() && e.name.endsWith('.css')) {
        cssFiles.push(join(dirAbs, e.name))
      }
    }
  }
  for (const r of scanRoots) {
    const abs = r === '.' ? pkgDir : join(pkgDir, r)
    if (existsSync(abs)) walk(abs, 0)
    if (cssFiles.length) break
  }

  const allVars = new Set()
  const bemClasses = new Set()
  for (const f of cssFiles) {
    try {
      const css = readFileSync(f, 'utf8')
      for (const m of css.matchAll(/(--[a-zA-Z][\w-]*)\s*:/g)) allVars.add(m[1])
      for (const m of css.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)/g)) allVars.add(m[1])
      for (const m of css.matchAll(/\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*__[a-zA-Z0-9_-]+)/g)) bemClasses.add(`.${m[1]}`)
    } catch { /* 忽略 */ }
  }
  const themeVars = [...allVars].filter((v) => /theme/i.test(v)).slice(0, 16)
  return { allVars: [...allVars], bemClasses: [...bemClasses], themeVars }
}

function matchCompCssVars(allVars, compName, allCompKeys = null) {
  if (!allVars?.length || !compName) return []
  const key = normCompKey(compName)
  if (key.length < 4) return []
  const longerSiblingKeys = allCompKeys
    ? [...allCompKeys].filter((k) => k.length > key.length && k.startsWith(key))
    : []
  const matched = []
  for (const v of allVars) {
    const vn = normCompKey(v.replace(/^--/, ''))
    if (!vn.startsWith(key) || vn.length <= key.length) continue
    if (longerSiblingKeys.some((lk) => vn.startsWith(lk))) continue
    matched.push(v)
    if (matched.length >= 10) break
  }
  return matched
}

function matchCompBemClasses(bemClasses, compName) {
  if (!bemClasses?.length || !compName) return []
  const key = normCompKey(compName)
  if (key.length < 4) return []
  const matched = []
  for (const cls of bemClasses) {
    const block = cls.replace(/^\./, '').split('__')[0]
    if (normCompKey(block) === key) {
      matched.push(cls)
      if (matched.length >= 5) break
    }
  }
  return matched
}

function walkComponentFiles(pkgDir, coveredNames) {
  const found = []
  const roots = ['es', 'esm', 'components', 'lib', 'src', 'dist']
    .map((r) => ({ rel: r, abs: join(pkgDir, r) }))
    .filter((r) => existsSync(r.abs))

  const seenNames = new Set(coveredNames)
  const walk = (dirAbs, relPrefix, depth) => {
    if (depth > 5) return
    let entries = []
    try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { return }

    for (const e of entries) {
      if (e.isDirectory()) {
        if (WALK_PRUNE_DIRS.test(e.name)) continue
        const subAbs = join(dirAbs, e.name)
        const subRel = `${relPrefix}/${e.name}`
        // 目录式组件：foo/index.{d.ts,vue,js,mjs}（排除纯转发聚合目录如 wealth/index.d.ts、atoms/index.d.ts）
        if (
          !SKIP_DIRS.test(e.name)
          && ['index.d.ts', 'index.vue', 'index.mjs', 'index.js', 'index.cjs'].some((f) => existsSync(join(subAbs, f)))
          && !isAggregatorDir(subAbs)
        ) {
          const compName = pascal(e.name)
          if (!seenNames.has(compName)) {
            seenNames.add(compName)
            const parsed = propsOf(subAbs, pkgDir, compName)
            found.push({
              name: compName,
              sub: subRel,
              barrel: false,
              props: parsed.props,
              slots: parsed.slots,
              vModels: parsed.vModels,
              propsFrom: parsed.from,
            })
          }
          continue
        }
        walk(subAbs, subRel, depth + 1)
      } else if (e.isFile()) {
        // 平铺式组件文件：es/components/wealth/atoms/XwCard.d.ts 或 XwCard.vue
        const m = e.name.match(/^([A-Z][A-Za-z0-9]+)\.(?:vue\.d\.ts|d\.ts|vue)$/)
        if (!m) continue
        const compName = m[1]
        if (/(?:Props|Types|Context|Config|Constants|Helper|Util|Hook|Store|Service|Api|Enum|Event)$/i.test(compName)) continue
        if (seenNames.has(compName)) continue
        seenNames.add(compName)
        const fileAbs = join(dirAbs, e.name)
        const parsed = propsOfFile(fileAbs, pkgDir, compName)
        const cleanSub = `${relPrefix}/${compName}`
        found.push({
          name: compName,
          sub: cleanSub,
          barrel: false,
          props: parsed.props,
          slots: parsed.slots,
          vModels: parsed.vModels,
          propsFrom: parsed.from,
        })
      }
    }
  }

  for (const r of roots) {
    walk(r.abs, r.rel, 0)
    if (found.length) break // 优先使用第一个命中的产物树（如 es/），避免与 lib/ 重复
  }
  return found
}

/**
 * 扫内网 UI 库安装产物：
 *   1. 递归跟进入口 .d.ts / barrel（支持多级 `export * from`、`import X; export { X }` 与 `.vue` 后缀剥离，兼容 Windows 路径）；
 *   2. 严格按组件专属文件提取 props、插槽（`__VLS_WithTemplateSlots` / `$slots`）、`v-model` 绑定与包内 CSS 变量，彻底杜绝桶文件串台；
 *   3. 识别纯图标包并按多行折行输出完整可用图标名列表，折叠无独立类型声明的底层透传组件。
 */
export function inspectUiLibrary(projectDir, pkgName) {
  const project = resolve(projectDir)
  const pkgDir = join(project, 'node_modules', pkgName)
  if (!existsSync(pkgDir)) return { ok: false, error: `没有安装 ${pkgName}（查 ${pkgDir}）` }

  let pj = {}
  try {
    pj = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  } catch { /* 忽略 */ }

  const entryCandidates = [
    pj.types, pj.typings, 'es/index.d.ts', 'esm/index.d.ts', 'lib/index.d.ts', 'dist/index.d.ts', 'index.d.ts',
    pj.module, pj.main, 'es/index.mjs', 'es/index.js', 'esm/index.js', 'index.mjs', 'index.js', 'lib/index.js',
  ].filter(Boolean)
  const entryRel = entryCandidates.find((f) => existsSync(join(pkgDir, f))) ?? null
  const jsEntryRel = [pj.module, pj.main, 'es/index.mjs', 'es/index.js', 'index.mjs', 'index.js', 'lib/index.js']
    .filter(Boolean)
    .find((f) => existsSync(join(pkgDir, f))) ?? entryRel

  const exported = new Map()
  if (entryRel) {
    for (const [k, v] of collectBarrelExports(join(pkgDir, entryRel), pkgDir)) exported.set(k, v)
  }
  if (jsEntryRel && jsEntryRel !== entryRel) {
    for (const [k, v] of collectBarrelExports(join(pkgDir, jsEntryRel), pkgDir)) {
      if (!exported.has(k) || (!exported.get(k) && v)) exported.set(k, v)
    }
  }

  const fileIndex = indexComponentFiles(pkgDir)
  const { allVars: pkgCssVars, bemClasses: pkgBemClasses, themeVars } = collectPkgCssVars(pkgDir)
  const allCompKeys = new Set([...exported.keys()].map(normCompKey))

  const components = []
  const coveredNames = new Set()
  for (const [name, rawTargetAbs] of exported) {
    if (/(?:Props|Options|Attrs|Instance|Expose|Emits|Slots|Theme|Locale|Config)$/i.test(name)) continue
    if (SKIP_DIRS.test(name)) continue
    const indexedAbs = fileIndex.get(normCompKey(name)) ?? null
    const targetIsDedicated = rawTargetAbs ? fileMatchesComponent(rawTargetAbs, name) : false
    const effectiveTarget = targetIsDedicated ? rawTargetAbs : (indexedAbs ?? rawTargetAbs)
    const hasOwnSource = Boolean(effectiveTarget)

    let parsed = { props: [], slots: [], vModels: [], from: null }
    if (effectiveTarget) {
      const dirCandidate = effectiveTarget.replace(/[\\/]index\.(d\.ts|vue|m?js|cjs|ts)$/, '')
      const useDir = dirCandidate !== effectiveTarget
        && existsSync(dirCandidate)
        && !SKIP_DIRS.test(basename(dirCandidate))
        && !isAggregatorDir(dirCandidate)
        && normCompKey(basename(dirCandidate)) === normCompKey(name)
      parsed = useDir
        ? propsOf(dirCandidate, pkgDir, name)
        : propsOf(effectiveTarget, pkgDir, name)
    }
    coveredNames.add(name)
    components.push({
      name,
      sub: null,
      importPath: pkgName,
      barrel: true,
      props: parsed.props,
      slots: parsed.slots,
      vModels: parsed.vModels,
      cssVars: hasOwnSource ? matchCompCssVars(pkgCssVars, name, allCompKeys) : [],
      bemClasses: hasOwnSource ? matchCompBemClasses(pkgBemClasses, name) : [],
      propsFrom: parsed.from,
    })
  }

  for (const item of walkComponentFiles(pkgDir, coveredNames)) {
    allCompKeys.add(normCompKey(item.name))
    const isBarrelPkg = exported.size > 0
    components.push({
      ...item,
      cssVars: matchCompCssVars(pkgCssVars, item.name, allCompKeys),
      bemClasses: matchCompBemClasses(pkgBemClasses, item.name),
      barrel: isBarrelPkg,
      importPath: isBarrelPkg ? pkgName : `${pkgName}/${item.sub}`,
    })
  }

  // 区分图标组件与普通业务 UI 组件（兼容 *Outline / *Fill / *Filled / *TwoTone 等全部图标命名后缀）
  const iconGlyphRe = /(?:Outline|Outlined|Filled|Fill|TwoTone|Twotone|Glyph|Solid|Line)$|^Icon[A-Z]/
  const glyphIcons = components.filter((c) => iconGlyphRe.test(c.name))
  const isIconPack = ICON_PKG_RE.test(pkgName) || (glyphIcons.length >= 15 && glyphIcons.length >= components.length * 0.6)
  const mainComponents = isIconPack
    ? components.filter((c) => !iconGlyphRe.test(c.name))
    : components
  const sortedGlyphNames = isIconPack
    ? glyphIcons.map((c) => c.name).sort((a, b) => a.localeCompare(b))
    : []
  const glyphProps = isIconPack
    ? (glyphIcons.find((c) => c.props.length)?.props ?? [])
    : []

  // 全局注册库检测
  let globalLib = false
  for (const f of ['index.d.ts', 'es/index.d.ts', 'types/index.d.ts', 'global.d.ts']) {
    try {
      if (readFileSync(join(pkgDir, f), 'utf8').includes('GlobalComponents')) {
        globalLib = true
        break
      }
    } catch { /* 跳过 */ }
  }

  return {
    ok: true,
    pkg: pkgName,
    version: pj.version ?? null,
    entry: jsEntryRel ?? entryRel ?? null,
    global: globalLib,
    isIconPack,
    themeVars,
    glyphCount: sortedGlyphNames.length,
    glyphProps,
    glyphNames: sortedGlyphNames,
    glyphSamples: sortedGlyphNames.slice(0, 20),
    components: (isIconPack ? mainComponents : components).sort((x, y) => x.name.localeCompare(y.name)),
  }
}

/** 出码前检查现有清单够不够用；不够就给出「该向用户要什么」。 */
export function readUiLibrary(projectDir) {
  const path = join(resolve(projectDir), UI_DOC_REL)
  if (!existsSync(path)) {
    return { present: false, path, pkg: null, components: 0, withProps: 0, placeholder: false, usable: false, askUser: null }
  }
  const t = readFileSync(path, 'utf8')
  const rows = t.split('\n').filter((l) => /^\|\s*`<[^>]+>`/.test(l))
  const foldedMatch = t.match(/其余未附带独立类型声明的导出组件（共\s*(\d+)\s*个/)
  const foldedCount = foldedMatch ? Number(foldedMatch[1]) : 0
  const components = rows.length + foldedCount
  const withProps = rows.length - (t.match(/（未解析到）/g) ?? []).length
  const placeholder = /（待填|TODO\(接入\)|（示例组件）/.test(t)
  const pkg = (t.match(/- 包：`([^`]+)`/) ?? [])[1] ?? null
  const hasIconsOnly = components === 0 && /图标总数：[1-9]\d*/.test(t)
  const usable = ((components > 0 && withProps > 0) || hasIconsOnly) && !placeholder
  let askUser = null
  if (!components && !hasIconsOnly) askUser = 'ui-library.md 是空表。先确认 --pkg 是否指向了真正的 UI 组件包（而非工具包），仍扫不出再向用户要常用组件清单或真实用法示例。'
  else if (components > 0 && !withProps) askUser = `ui-library.md 里 ${components} 个组件均未解析到 props。先确认 --pkg 是否为 UI 组件包，或向用户索取常用 props 与示例。`
  else if (placeholder) askUser = 'ui-library.md 里还有（待填）之类占位，跟用户确认是删掉还是补齐。'
  return { present: true, path, pkg, components, withProps, placeholder, usable, askUser }
}

function chunkList(arr, size = 12) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function renderOnePkgSection(info) {
  const L = []
  L.push(`## \`${info.pkg}\`${info.version ? ` @ ${info.version}` : ''}`)
  L.push('')
  L.push(`- 包：\`${info.pkg}\`${info.version ? ` @ ${info.version}` : ''}`)
  L.push(`- 入口：\`${info.entry ?? '（未声明）'}\``)
  if (info.isIconPack) {
    L.push(`- 类型：图标库（包装组件 ${info.components.length} 个，单图标导出 — 图标总数：${info.glyphCount}）`)
    if (info.glyphProps?.length) {
      L.push(`- 单图标通用 props：${info.glyphProps.map((p) => `\`${p}\``).join(' ')}`)
    }
    const allNames = info.glyphNames ?? info.glyphSamples ?? []
    if (allNames.length) {
      const shown = allNames.slice(0, 600)
      L.push(`- 全部可用单图标名（\`import { Xxx } from '${info.pkg}'\`，直接从此列表选用，无需再翻 \`node_modules\`${allNames.length > shown.length ? `；展示前 ${shown.length}/${allNames.length} 个` : ''}）：`)
      for (const group of chunkList(shown, 12)) {
        L.push(`  - ${group.map((n) => `\`${n}\``).join(' ')}`)
      }
    }
  } else {
    const hasRichMeta = (c) => c.props.length > 0 || (c.slots?.length ?? 0) > 0 || (c.vModels?.length ?? 0) > 0
    const withPropsCount = info.components.filter(hasRichMeta).length
    L.push(`- 组件数：${info.components.length}（已解析出类型签名：${withPropsCount}）`)
    L.push(`- 注册方式：${info.global ? '全局注册（检测到 `GlobalComponents`：模板直接写标签）' : '按需引入（若项目有统一 `shared.ts` 转发或 `AGENTS.md` 另有约定，以项目既有页面写法为准）'}`)
    if (info.themeVars?.length) {
      L.push(`- 全局主题 CSS 变量：${info.themeVars.map((v) => `\`${v}\``).join(' ')}`)
    }
  }
  L.push('')
  if (info.components.length) {
    const hasRichMeta = (c) => c.props.length > 0 || (c.slots?.length ?? 0) > 0 || (c.vModels?.length ?? 0) > 0 || (c.cssVars?.length ?? 0) > 0 || (c.bemClasses?.length ?? 0) > 0
    const rich = info.components.filter(hasRichMeta)
    const passthrough = rich.length > 0 ? info.components.filter((c) => !hasRichMeta(c)) : []
    const tableRows = rich.length > 0 ? rich : info.components

    L.push('| 组件 | 引入 | 主要 props / v-model / 插槽 / CSS 变量 / 子类名 | 依据 |')
    L.push('|---|---|---|---|')
    for (const c of tableRows) {
      const use = info.global
        ? '全局注册，直接写标签'
        : c.barrel
          ? `import { ${c.name} } from '${c.importPath}'`
          : `import ${c.name} from '${c.importPath}'`
      const parts = []
      if (c.props.length) parts.push(c.props.map((x) => `\`${x}\``).join(' '))
      if (c.vModels?.length) parts.push(`双向绑定: ${c.vModels.map((x) => `\`${x}\``).join(' ')}`)
      if (c.slots?.length) parts.push(`插槽: ${c.slots.map((x) => `\`#${x}\``).join(' ')}`)
      if (c.cssVars?.length) parts.push(`变量: ${c.cssVars.map((x) => `\`${x}\``).join(' ')}`)
      if (c.bemClasses?.length) parts.push(`子类: ${c.bemClasses.map((x) => `\`${x}\``).join(' ')}`)
      const metaText = parts.length ? parts.join('；') : '（未解析到）'
      const from = parts.length ? (c.propsFrom ?? '源码') : '无 .d.ts'
      const cell = info.global ? use : `\`${use}\``
      L.push(`| \`<${c.name}>\` | ${cell} | ${metaText} | ${from} |`)
    }
    L.push('')

    if (passthrough.length) {
      L.push(`- 其余未附带独立类型声明的导出组件（共 ${passthrough.length} 个，多为底层 UI 库透传重导出）：`)
      for (const group of chunkList(passthrough.map((c) => c.name), 12)) {
        L.push(`  - ${group.map((n) => `\`${n}\``).join(' ')}`)
      }
      L.push('')
    }
  }
  return L.join('\n')
}

export function writeUiLibraryDoc(projectDir, infoOrList) {
  const infos = (Array.isArray(infoOrList) ? infoOrList : [infoOrList]).filter((x) => x?.ok)
  const dest = join(resolve(projectDir), UI_DOC_REL)
  mkdirSync(dirname(dest), { recursive: true })
  const totalComponents = infos.reduce((s, x) => s + x.components.length, 0)
  const totalWithProps = infos.reduce((s, x) => s + x.components.filter((c) => c.props.length).length, 0)

  const md = `# 内网 UI 组件与图标清单

> 由 \`lanhu-dds doctor --ui\` 自动扫描 \`node_modules\` 生成，库升级后重跑覆盖。
> 注意：若项目有 \`AGENTS.md\` 或业务模块统一的转发入口（如 \`shared.ts\`），引入路径与命名冲突规则以项目文档和同目录既有页面为准。
> props 为从 \`.d.ts\` 提取的顶层字段名，拿不准默认值或插槽时直接 \`read\` 对应「依据」文件，不要盲猜。

${infos.map(renderOnePkgSection).join('\n')}## 怎么用

1. 出码前先在这张表里找现成组件（导航栏 / 卡片 / 按钮 / 单元格 / 标签 / 弹层 / 空态…）。
2. 有 → 直接复用，微调走组件 props、CSS 变量或局部 \`:deep()\`。
3. 没有 → 才用语义 HTML + scoped CSS 手写，并在下方登记。

## 缺组件登记

（手写替代的记这里：组件名 — 用在哪 — 为什么没复用）
`
  writeFileSync(dest, md)
  return {
    ok: true,
    path: dest,
    packages: infos.map((x) => x.pkg),
    components: totalComponents,
    withProps: totalWithProps,
  }
}

export function scanAndWriteUiDocs(projectDir, explicitPkg) {
  const diag = diagnoseProject(projectDir)
  if (!diag.ok) return diag
  const targets = explicitPkg
    ? [explicitPkg]
    : [...diag.uiPackages, ...diag.iconPackages]
  if (!targets.length) {
    return { ok: false, error: '没有识别到内网 UI/图标包（已自动排除工具/SDK 包），请用 --pkg <包名> 显式指定' }
  }
  const infos = []
  const errors = []
  for (const pkg of targets) {
    const info = inspectUiLibrary(projectDir, pkg)
    if (info.ok) infos.push(info)
    else errors.push({ pkg, error: info.error })
  }
  if (!infos.length) return { ok: false, error: errors.map((e) => e.error).join('；'), errors }
  const w = writeUiLibraryDoc(projectDir, infos)
  return {
    ...w,
    scanned: infos.map((i) => ({
      pkg: i.pkg,
      version: i.version,
      isIconPack: i.isIconPack,
      components: i.components.length,
      glyphCount: i.glyphCount,
      sample: i.components.slice(0, 20).map((c) => c.name),
    })),
    errors,
  }
}

function cmdDoctor(args) {
  const project = args.project ?? process.cwd()
  if (args.prune === 'true') {
    const days = Number(args.days ?? 7)
    const r = pruneSessions({ days })
    console.log(JSON.stringify(r, null, 2))
    return
  }
  const actions = {}
  if (args.init === 'true') actions.init = initProjectRules(project)
  if (args.ui === 'true') {
    actions.ui = scanAndWriteUiDocs(project, args.pkg)
    if (!actions.ui.ok && !args.init) return die(actions.ui.error)
  }
  if (actions.init || actions.ui) {
    const diag = diagnoseProject(project)
    console.log(JSON.stringify({ ok: true, ...actions, diagnosis: diag }, null, 2))
    return
  }
  const r = diagnoseProject(project)
  if (!r.ok) return die(r.error)
  const rulesSummary = r.rules.present
    ? `已接入 project-rules.md（空 ${r.rules.unfilled.length} 项、占位 ${r.rules.placeholders} 处）`
    : r.agentDocs.present
      ? `由 ${r.agentDocs.primary} 承载（免建 project-rules.md）`
      : '未接入'
  const lines = [
    `项目：${r.packageName ?? '(未命名)'}　框架：${r.framework.join(' / ') || '(未识别)'}`,
    `输出单位：--unit ${r.unit}　依据：${r.unitFrom}`,
    `内网 UI 包：${r.uiPackages.join('、') || '(无)'}　图标包：${r.iconPackages.join('、') || '(无)'}　其他内网包：${r.internalPackages.filter((x) => !r.uiPackages.includes(x) && !r.iconPackages.includes(x)).join('、') || '(无)'}`,
    `规范来源：${rulesSummary}`,
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
  die('用法：\n  lanhu-dds.mjs build --url "<链接>" [--out <目录名>] [--screen all|0,1] [--list]\n  lanhu-dds.mjs local --dds <dds.raw.json> [--meta meta.json] [--out <目录名>] [--screen 0]\n  lanhu-dds.mjs inventory --dds <dds.raw.json>\n  lanhu-dds.mjs doctor [--project <项目目录>] [--init] [--ui [--pkg <包名>]] [--prune [--days 7]]')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().catch((e) => die(e.stack ?? String(e)))
