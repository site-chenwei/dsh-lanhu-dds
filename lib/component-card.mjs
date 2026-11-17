/**
 * 组件卡片：出码时要的「默认值 / 事件 / 插槽与类名位置 / 样式规则体」一次给全，
 * 不让模型去 node_modules 里猜 XwStepper2.js 这类打包序号文件名。
 *
 * 只做文本提取、不引解析器：渲染结构只给类名与插槽的出现顺序，不承诺嵌套层级。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const BUILD_ROOTS = ['es', 'esm', 'lib', 'dist']
const MAX_JS_FILES = 4000
const MAX_CSS_CHARS = 3000
const CLASS_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:__[\w-]+)?(?:--[\w-]+)?$/

function listFiles(root, exts) {
  const out = []
  const walk = (dir) => {
    if (out.length >= MAX_JS_FILES) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(join(dir, e.name))
      } else if (exts.some((x) => e.name.endsWith(x)) && e.name.endsWith('.d.ts') === exts.includes('.d.ts')) {
        out.push(join(dir, e.name))
      }
    }
  }
  walk(root)
  return out
}

/** 每个包只读一遍：编译后 JS 的全文与样式表全文。 */
function loadPackage(projectDir, pkg) {
  const pkgDir = join(resolve(projectDir), 'node_modules', pkg)
  const root = BUILD_ROOTS.map((r) => join(pkgDir, r)).find((p) => existsSync(p)) ?? pkgDir
  const read = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  return {
    pkg,
    pkgDir,
    js: listFiles(root, ['.js', '.mjs']).map((file) => ({ file, text: read(file) })),
    css: listFiles(root, ['.css']).map(read).join('\n'),
    dts: listFiles(root, ['.d.ts']),
  }
}

/** 从 openIdx 处的 { 或 [ 起，返回配对闭括号的下标；字符串内的括号不计。 */
function matchClose(text, openIdx) {
  const open = text[openIdx]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let quote = ''
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === open) depth++
    else if (ch === close && --depth === 0) return i
  }
  return -1
}

/** 按顶层逗号切分 `{...}` / `[...]` 的内部文本。 */
function splitTop(inner) {
  const parts = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if ('{[('.includes(ch)) depth++
    else if ('}])'.includes(ch)) depth--
    else if (ch === ',' && depth === 0) {
      parts.push(inner.slice(start, i))
      start = i + 1
    }
  }
  parts.push(inner.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

const readableLiteral = (raw) => raw
  .replace(/^!1$/, 'false').replace(/^!0$/, 'true').replace(/^void 0$/, 'undefined')
  .replace(/\s+/g, ' ').slice(0, 48)

function parseProps(text, from) {
  const m = /\bprops:\s*([{[])/.exec(text.slice(from, from + 400))
  if (!m) return []
  const open = from + m.index + m[0].length - 1
  const close = matchClose(text, open)
  if (close < 0) return []
  const entries = splitTop(text.slice(open + 1, close))
  if (m[1] === '[') return entries.map((e) => ({ name: e.replace(/["']/g, '') }))
  return entries.map((entry) => {
    const colon = entry.indexOf(':')
    const name = entry.slice(0, colon).trim().replace(/["']/g, '')
    const body = entry.slice(colon + 1).trim()
    const prop = { name }
    if (!body.startsWith('{')) {
      prop.runtimeType = body
      return prop
    }
    for (const field of splitTop(body.slice(1, -1))) {
      const fc = field.indexOf(':')
      const key = field.slice(0, fc).trim()
      const value = field.slice(fc + 1).trim()
      if (key === 'type') prop.runtimeType = value
      else if (key === 'default') prop.default = readableLiteral(value)
      else if (key === 'required' && value === '!0') prop.required = true
    }
    return prop
  })
}

function parseEmits(text, from) {
  const m = /\bemits:\s*\[/.exec(text.slice(from, from + 6000))
  if (!m) return []
  const open = from + m.index + m[0].length - 1
  return splitTop(text.slice(open + 1, matchClose(text, open))).map((e) => e.replace(/["']/g, ''))
}

/** 同目录 .d.ts 里的 `/** 说明 *\/ name?: type;`，给 props 补上 TS 类型与作者写的说明。 */
function readPropDocs(implFile, compName) {
  const dir = dirname(implFile)
  const text = [`${compName}.d.ts`, `${compName}.vue.d.ts`, 'types.d.ts', 'props.d.ts', 'index.d.ts']
    .map((f) => join(dir, f))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
  const docs = new Map()
  const aliases = new Map()
  for (const m of text.matchAll(/^export (?:declare )?type (\w+) = ([^;{]+);/gm)) aliases.set(m[1], m[2].trim())
  // 注释体不许跨过 */，否则文件头注释会一路吞到第一个字段上
  for (const m of text.matchAll(/(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?(?:readonly\s+)?(\w+)\??:\s*([^;{}\n]+);/g)) {
    if (docs.has(m[2])) continue
    const doc = (m[1] ?? '').replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
    docs.set(m[2], { type: m[3].trim(), doc })
  }
  return { docs, aliases }
}

const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

/**
 * 渲染函数里类名与插槽的出现顺序。
 * Vue 编译器会把静态属性提升成文件顶部的常量（`const S = { class: "..." }`），
 * 渲染处只剩标识符 `c("div", S, ...)`，所以要先建常量表再按引用位置回填。
 */
function renderOutline(text, from, block) {
  const isBlockClass = (lit) => {
    const tokens = lit.trim().split(/\s+/)
    return tokens.every((t) => CLASS_TOKEN.test(t)) && tokens.some((t) => t === block || t.startsWith(`${block}_`) || t.startsWith(`${block}-`))
  }
  const hoisted = new Map()
  for (const m of text.slice(0, from).matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*\{[^{}]*?\bclass:\s*"([^"]+)"[^{}]*\}/g)) {
    if (isBlockClass(m[2])) hoisted.set(m[1], m[2])
  }

  const body = text.slice(from)
  const items = []
  for (const m of body.matchAll(/"([^"\n]{1,120})"(\s*:)?/g)) {
    if (!isBlockClass(m[1])) continue
    items.push({ at: m.index, kind: m[2] ? 'conditional' : 'class', value: m[1].trim().split(/\s+/).map((t) => `.${t}`).join('') })
  }
  for (const m of body.matchAll(/\(\s*"[\w-]+",\s*([A-Za-z_$][\w$]*)\s*[,)]/g)) {
    const cls = hoisted.get(m[1])
    if (cls) items.push({ at: m.index, kind: 'class', value: cls.split(/\s+/).map((t) => `.${t}`).join('') })
  }
  const slots = []
  for (const m of body.matchAll(/\$slots,\s*"([\w-]+)"/g)) {
    items.push({ at: m.index, kind: 'slot', value: `#${m[1]}` })
    if (!slots.includes(m[1])) slots.push(m[1])
  }
  // `useSlots().bottom ? (...)`：没传该插槽时连外层容器都不渲染
  const optionalSlots = new Set()
  for (const m of body.matchAll(/\)\.([\w$]+)\s*\?\s*\(/g)) if (slots.includes(m[1])) optionalSlots.add(m[1])
  for (const m of body.matchAll(/\$slots\.([\w$]+)\s*\?\s*\(/g)) if (slots.includes(m[1])) optionalSlots.add(m[1])

  items.sort((a, b) => a.at - b.at)
  const order = []
  const conditional = []
  for (const it of items) {
    if (it.kind === 'conditional') {
      if (!conditional.includes(it.value)) conditional.push(it.value)
    } else if (order[order.length - 1] !== it.value) {
      order.push(it.value)
    }
  }
  return { order, conditional, slots, optionalSlots: [...optionalSlots] }
}

/** 取出选择器命中该组件 block 的全部规则；`.xw-stepper` 不应带出 `.xw-stepper-group`。 */
function cssRulesOf(css, block) {
  const hit = new RegExp(`\\.${block.replace(/[-]/g, '\\-')}(?![a-zA-Z0-9]|-[a-zA-Z0-9])`)
  const rules = []
  let scoped = false
  const scan = (text, wrap) => {
    let i = 0
    while (i < text.length) {
      const open = text.indexOf('{', i)
      if (open < 0) break
      const close = matchClose(text, open)
      if (close < 0) break
      const selector = text.slice(i, open).trim()
      const bodyText = text.slice(open + 1, close)
      if (/^@(media|supports)/.test(selector)) scan(bodyText, selector)
      else if (!selector.startsWith('@') && hit.test(selector)) {
        if (/\[data-v-[\w-]+\]/.test(selector)) scoped = true
        const rule = `${selector.replace(/\[data-v-[\w-]+\]/g, '')}{${bodyText.trim()}}`
        rules.push(wrap ? `${wrap}{${rule}}` : rule)
      }
      i = close + 1
    }
  }
  scan(css.replace(/\/\*[\s\S]*?\*\//g, ''), '')
  return { rules, scoped }
}

/**
 * `<script setup>` 组件编译后带 `__name`；手写 `defineComponent({ name, props })` 的只有 `name`。
 * 后者的 `name:` 也可能出现在别处（路由、图标表），所以要求紧跟着能解析出 props 才算数。
 */
function findImplementation(pack, compName) {
  for (const [pattern, needProps] of [[`__name:\\s*["']${compName}["']`, false], [`(?<![\\w$])name:\\s*["']${compName}["']`, true]]) {
    const needle = new RegExp(pattern)
    for (const { file, text } of pack.js) {
      const m = needle.exec(text)
      if (m && (!needProps || parseProps(text, m.index).length)) return { file, text, at: m.index }
    }
  }
  return null
}

const RUNTIME_TYPES = { StringConstructor: 'string', NumberConstructor: 'number', BooleanConstructor: 'boolean', ArrayConstructor: 'array', ObjectConstructor: 'object', FunctionConstructor: 'function' }

/**
 * 找不到实现文件时（渲染函数写的组件，编译产物里没有可定位的名字）退到类型声明：
 * `export declare const X: ...ExtractPropTypes<{ /** 说明 *\/ size: { type: PropType<T>; default: string } }>`。
 * 声明里的 default 只有类型没有值，所以这种卡片不给默认值列。
 */
function findDeclaration(pack, compName) {
  const needle = new RegExp(`^export declare const ${compName}\\s*:`, 'm')
  const byName = pack.dts.filter((f) => f.endsWith(`${compName}.d.ts`) || f.endsWith(`${compName}.vue.d.ts`))
  for (const file of [...byName, ...pack.dts.filter((f) => !byName.includes(f))]) {
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const m = needle.exec(text)
    if (!m) continue
    const next = text.indexOf('\nexport ', m.index + 1)
    const decl = text.slice(m.index, next < 0 ? text.length : next)
    const open = decl.indexOf('ExtractPropTypes<{')
    const props = []
    if (open >= 0) {
      const start = open + 'ExtractPropTypes<'.length
      const inner = decl.slice(start + 1, matchClose(decl, start))
      const field = /(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?(\w+):\s*\{/g
      for (let f = field.exec(inner); f; f = field.exec(inner)) {
        const bodyOpen = f.index + f[0].length - 1
        const bodyClose = matchClose(inner, bodyOpen)
        if (bodyClose < 0) break
        const body = inner.slice(bodyOpen + 1, bodyClose)
        const raw = /\btype:\s*([^;]+);/.exec(body)?.[1].trim() ?? ''
        const type = /^PropType<(.+)>$/.exec(raw)?.[1] ?? RUNTIME_TYPES[raw] ?? raw
        props.push({ name: f[2], type, doc: (f[1] ?? '').replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim(), required: /\brequired:\s*true/.test(body) })
        field.lastIndex = bodyClose + 1
      }
    }
    const emits = [.../\(("[^"]+"(?:\s*\|\s*"[^"]+")*)\)\[\]/.exec(decl)?.[1].matchAll(/"([^"]+)"/g) ?? []].map((e) => e[1])
    const aliases = [...text.matchAll(/^export (?:declare )?type (\w+) = ([^;{]+);/gm)].map((a) => [a[1], a[2].trim()])
    return { file, props, emits, aliases }
  }
  return null
}

function cssSection(pack, block) {
  const { rules, scoped } = cssRulesOf(pack.css, block)
  if (!rules.length) return []
  let css = rules.join('\n')
  const cut = css.length > MAX_CSS_CHARS
  if (cut) css = css.slice(0, css.lastIndexOf('\n', MAX_CSS_CHARS))
  const L = ['', `样式规则${scoped ? '（scoped：页面里覆盖内部类需 `:deep()`；CSS 变量可直接在外层设）' : ''}：`, '', '```css', css, '```']
  if (cut) L.push(`（共 ${rules.length} 条，已截到 ${MAX_CSS_CHARS} 字符）`)
  return L
}

function renderDeclCard(pack, compName) {
  const decl = findDeclaration(pack, compName)
  if (!decl) return null
  const esc = (t) => t.replace(/\|/g, '\\|')
  const L = [
    `## <${compName}> — \`${pack.pkg}\``,
    '',
    `- 来源：类型声明 \`${relative(pack.pkgDir, decl.file).replace(/\\/g, '/')}\`（编译产物里定位不到它的实现，默认值与渲染结构未知；类名看下方样式规则）`,
  ]
  if (decl.emits.length) L.push(`- 事件：${decl.emits.map((e) => `\`${e}\``).join(' ')}`)
  if (decl.props.length) {
    L.push('', '| prop | 类型 | 说明 |', '|---|---|---|')
    for (const p of decl.props) L.push(`| \`${p.name}\`${p.required ? ' *' : ''} | ${p.type ? `\`${esc(p.type)}\`` : ''} | ${esc(p.doc)} |`)
  }
  const used = decl.aliases.filter(([name]) => decl.props.some((p) => new RegExp(`\\b${name}\\b`).test(p.type)))
  if (used.length) L.push('', `类型别名：${used.map(([n, v]) => `\`${n} = ${v}\``).join('；')}`)
  L.push(...cssSection(pack, kebab(compName)))
  return L.join('\n')
}

function renderCard(pack, compName) {
  const impl = findImplementation(pack, compName)
  if (!impl) return renderDeclCard(pack, compName)
  const props = parseProps(impl.text, impl.at)
  const emits = parseEmits(impl.text, impl.at)
  const { docs, aliases } = readPropDocs(impl.file, compName)
  const block = kebab(compName)
  const outline = renderOutline(impl.text, impl.at, block)

  const L = [`## <${compName}> — \`${pack.pkg}\``, '', `- 实现文件：\`${relative(pack.pkgDir, impl.file).replace(/\\/g, '/')}\``]
  if (emits.length) L.push(`- 事件：${emits.map((e) => `\`${e}\``).join(' ')}`)
  if (outline.slots.length) {
    L.push(`- 插槽：${outline.slots.map((s) => `\`#${s}\`${outline.optionalSlots.includes(s) ? '（不传则其容器不渲染）' : ''}`).join(' ')}`)
  }
  if (outline.order.length) L.push(`- 渲染出现顺序（非嵌套层级）：${outline.order.map((x) => `\`${x}\``).join(' → ')}`)
  if (outline.conditional.length) L.push(`- 按状态追加的类：${outline.conditional.map((x) => `\`${x}\``).join(' ')}`)
  if (props.length) {
    const withDoc = props.some((p) => docs.get(p.name)?.doc)
    L.push('', `| prop | 类型 | 默认值 |${withDoc ? ' 说明 |' : ''}`, `|---|---|---|${withDoc ? '---|' : ''}`)
    for (const p of props) {
      const d = docs.get(p.name)
      const type = (d?.type ?? p.runtimeType ?? '').replace(/\|/g, '\\|')
      L.push(`| \`${p.name}\`${p.required ? ' *' : ''} | ${type ? `\`${type}\`` : ''} | ${p.default === undefined ? '' : `\`${p.default}\``} |${withDoc ? ` ${d?.doc ?? ''} |` : ''}`)
    }
  }
  const usedAliases = [...aliases].filter(([name]) => props.some((p) => new RegExp(`\\b${name}\\b`).test(docs.get(p.name)?.type ?? '')))
  if (usedAliases.length) L.push('', `类型别名：${usedAliases.map(([n, v]) => `\`${n} = ${v}\``).join('；')}`)
  L.push(...cssSection(pack, block))
  return L.join('\n')
}

/**
 * @param {string} projectDir
 * @param {string[]} names 组件名（大小写与导出名一致）
 * @param {string[]} pkgs 候选 UI 包，按顺序找
 */
export function describeComponents(projectDir, names, pkgs) {
  const packs = new Map()
  const cards = []
  const missing = []
  for (const name of names) {
    let card = null
    for (const pkg of pkgs) {
      if (!packs.has(pkg)) packs.set(pkg, loadPackage(projectDir, pkg))
      card = renderCard(packs.get(pkg), name)
      if (card) break
    }
    if (card) cards.push(card)
    else missing.push(name)
  }
  return { cards, missing }
}
