/** 数值、HTML/CSS 转义等与 DDS 无关的小工具。 */

export const round = (n) => Math.round(n * 100) / 100

const ENTITIES = { '&nbsp;': '\u00a0', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' }
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/g, '\u00a0')
    .replace(/&lt;br\s*\/?&gt;/gi, '\n')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;|&apos;|&lt;|&gt;/g, (m) => ENTITIES[m])
    .replace(/&amp;/g, '&')
}
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** 属性值里的双引号必须转义，否则 url("...") 会把 style 属性截断——这是最容易踩的坑。 */
export const attrEsc = (s) => esc(s).replace(/"/g, '&quot;')
export const cssEsc = (s) => String(s).replace(/["\\]/g, '\\$&')
