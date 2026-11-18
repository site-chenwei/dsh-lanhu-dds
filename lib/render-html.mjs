/** 把编译结果渲染成像素级参考 HTML，并汇总颜色/字体 token。 */

import { esc, attrEsc } from './util.mjs'
import { FAMILY_KEY, familyStack } from './compile.mjs'
import { cleanCssColorNoise, detectScreenChrome } from './spec.mjs'

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

/** 从任意 css 值里提取颜色字面量（#hex / rgb / rgba）；var()、渐变函数名等不会命中。 */
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d+[^)]*\)/g
/** 逐个属性提取，避免把 url(...) 里的片段或函数名误当颜色。 */
const COLOR_PROPS = [
  'color', 'backgroundColor', 'background', 'backgroundImage',
  'border', 'borderTop', 'borderBottom', 'borderLeft', 'borderRight', 'boxShadow',
]

export function collectTokens(compiledOrList) {
  const list = Array.isArray(compiledOrList) ? compiledOrList : [compiledOrList]
  const colors = new Map()
  const textColors = new Map()
  const fonts = new Map()
  const radii = new Map()
  // 状态栏/导航栏/底部安全区的颜色不算设计色板（纯黑/纯白壳层色会挤进高频榜首，让人拿它当正文色）；
  // 但缺色文本要引用的 --color-text-primary 得有值，所以壳层文字色留一份兜底
  const chromeText = new Map()
  const add = (m, k) => k && m.set(k, (m.get(k) ?? 0) + 1)
  for (const compiled of list) {
    let skip = null
    try { skip = detectScreenChrome(compiled).skipNodeSet } catch { skip = null }
    for (const [node, b] of compiled.boxes) {
      const isChrome = Boolean(skip?.has(node))
      const tc = String(b.css.color ?? '').match(COLOR_RE)
      // 与规格表树行同一个写法（cleanCssColorNoise）：否则 tokens.css 写 rgba(255,255,255,1.000000)、
      // 规格表写 rgba(255,255,255,1)，同一颜色被当成两种
      if (tc) {
        if (isChrome) add(chromeText, cleanCssColorNoise(tc[0]))
        else add(textColors, cleanCssColorNoise(tc[0]))
      }
      if (isChrome) continue
      for (const prop of COLOR_PROPS) {
        const v = b.css[prop]
        if (!v) continue
        for (const m of String(v).matchAll(COLOR_RE)) add(colors, cleanCssColorNoise(m[0]))
      }
      if (b.fontFamily) {
        const key = FAMILY_KEY(b.fontFamily)
        if (!fonts.has(key)) fonts.set(key, { count: 0, family: b.fontFamily })
        fonts.get(key).count++
      }
      add(radii, b.css.borderRadius)
    }
  }
  if (!textColors.size) for (const [k, v] of chromeText) textColors.set(k, v)
  return { colors, fonts, radii, textColors }
}

export function tokensCss({ colors, fonts, textColors }) {
  const out = [
    '/* 设计稿里数出来的颜色与字体，不是项目色板：变量名是临时序号（--color-brand-N），',
    '   接入时优先换成项目已有的 CSS 变量；数量超过 24 个的部分没有列出来。 */',
    ':root{',
  ]
  const families = []
  for (const [, v] of fonts) families.push(`  --${FAMILY_KEY(v.family)}: ${familyStack(v.family)};`)
  out.push(...families)
  out.push('  --font-text: var(--font-pingfang-sc, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);')
  // 缺色文本（css.color = var(--color-text-primary)）引用这个变量，填设计稿里出现最多的真实文本色
  const topText = [...textColors.entries()].sort((a, b) => b[1] - a[1])[0]
  // 这个变量名是 compile.mjs 给「DDS 没给文字色」的节点用的引用名，不是项目的主文字色：
  // 填的是本设计稿出现次数最多的文字色（价格红常常胜出），必须在产物里写清来源
  if (topText) out.push(`  /* 缺色文本引用它：取本设计稿出现次数最多的文字色，不代表项目主文字色 */`, `  --color-text-primary: ${topText[0]};`)
  const named = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)
  named.forEach(([c, n], i) => out.push(`  --color-brand-${i + 1}: ${c}; /*×${n}*/`))
  out.push('}')
  return out.join('\n')
}
