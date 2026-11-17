/** 扫描内网 UI 库的 .d.ts 与样式，生成组件速查表 ui-library.md。 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, resolve } from 'node:path'

export const ICON_PKG_RE = /(?:^|[-/])icons?(?:$|[-/])/i
export const UI_DOC_REL = '.agents/skills/lanhu-dds-codegen/ui-library.md'

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
  if (!components && !hasIconsOnly) askUser = 'ui-library.md 是空表。先确认 pkg 参数是否指向了真正的 UI 组件包（而非工具包），仍扫不出再向用户要常用组件清单或真实用法示例。'
  else if (components > 0 && !withProps) askUser = `ui-library.md 里 ${components} 个组件均未解析到 props。先确认 pkg 参数是否为 UI 组件包，或向用户索取常用 props 与示例。`
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

> 由 \`lanhu_dds_doctor({ ui: true })\` 自动扫描 \`node_modules\` 生成，库升级后重跑覆盖。
> 注意：若项目有 \`AGENTS.md\` 或业务模块统一的转发入口（如 \`shared.ts\`），引入路径与命名冲突规则以项目文档和同目录既有页面为准。
> 本表只列字段名。要某个组件的 prop 默认值、插槽渲染位置、内部类名或默认样式，调 \`lanhu_dds_doctor({ component: "组件名" })\` 取组件卡片。

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
    // 扫描口径：props 解析成功的组件数；与 readUiLibrary 的 withProps（清单里非「未解析到」的行数）不是同一个数
    withSignature: totalWithProps,
  }
}
