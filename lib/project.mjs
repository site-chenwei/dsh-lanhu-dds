/** 项目接入自检：框架、输出单位、内网 UI/图标包与规范来源。 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_HOME } from './store.mjs'
import { ICON_PKG_RE, UI_DOC_REL, readUiLibrary, inspectUiLibrary, writeUiLibraryDoc } from './ui-library.mjs'

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

const RULES_REL = '.agents/skills/lanhu-dds-codegen/project-rules.md'

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
 * 单位基准：Taro 看 designWidth，其余看 postcss 转换插件。
 * build 也要用它把画布 px 归一，所以单独导出，避免两处判断漂移。
 */
export function detectUnitBasis(dir, read = (rel) => { try { return readFileSync(join(dir, rel), 'utf8') } catch { return null } }) {
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
  return { designWidth, rootValue, viewportWidth, unit, unitFrom }
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

  const { designWidth, unit, unitFrom } = detectUnitBasis(dir, read)

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
    todos.push(`项目根无 AGENTS.md 且无 ${RULES_REL}：调 lanhu_dds_doctor({ init: true }) 生成模板并填入真实规范`)
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
        `未生成 ${UI_DOC_REL}：调 lanhu_dds_doctor({ ui: true })（将自动扫描 ${[...uiPackages, ...iconPackages].join('、')}）。若扫不出再向用户询问组件用法，勿凭包名猜 API`
      )
    } else if (!ui.usable) {
      todos.push(`UI 清单不可用（${ui.components} 个组件，${ui.withProps} 个含 props）：可重调 lanhu_dds_doctor({ ui: true, pkg: "${uiPackages[0] || targetUiPkgs[0]}" })，仍为空再询问用户`)
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
  // 文件名模式全项目递归（限深 5、跳过依赖/构建目录、上限 20 条）：
  // 只扫根目录与 .agents/tmp 会漏掉 src/、pages/ 下散落的临时脚本与中间产物（进了 git 就污染仓库）
  const STRAY_DIR_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.lanhu-dds'])
  const strayFile = (name) =>
    /^(dump|probe|tmp|debug|scratch)[\w.-]*\.(mjs|js|cjs|ts)$/.test(name)
    || /^screen-\d+\.(ir|rects|spec)\.(json|md)$/.test(name)
  const walkStrays = (rel, depth) => {
    if (strays.length >= 20 || depth > 5) return
    let entries = []
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (strays.length >= 20) return
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isFile()) {
        if (strayFile(e.name)) strays.push(relPath)
      } else if (e.isDirectory() && !STRAY_DIR_SKIP.has(e.name)) {
        walkStrays(relPath, depth + 1)
      }
    }
  }
  walkStrays('', 0)
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
    designWidth: designWidth ?? null,
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

export function scanAndWriteUiDocs(projectDir, explicitPkg) {
  const diag = diagnoseProject(projectDir)
  if (!diag.ok) return diag
  const targets = explicitPkg
    ? [explicitPkg]
    : [...diag.uiPackages, ...diag.iconPackages]
  if (!targets.length) {
    return { ok: false, error: '没有识别到内网 UI/图标包（已自动排除工具/SDK 包），请用 pkg 参数显式指定包名' }
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
