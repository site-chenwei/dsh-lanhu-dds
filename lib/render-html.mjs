/** 把编译结果渲染成像素级参考 HTML，并汇总颜色/字体 token。 */

import { esc, attrEsc } from './util.mjs'
import { FAMILY_KEY, familyStack } from './compile.mjs'

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

export function collectTokens(compiledOrList) {
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

export function tokensCss({ colors, fonts }) {
  const out = [
    '/* 设计稿里数出来的颜色与字体，不是项目色板：变量名是临时序号（--color-brand-N），',
    '   接入时优先换成项目已有的 CSS 变量；数量超过 24 个的部分没有列出来。 */',
    ':root{',
  ]
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
