/**
 * dsh-lanhu-dds — 把蓝湖「转代码」(DDS) 接进 DSH。
 *
 * 零依赖：不需要 lanhu-mcp、不需要 Python、不需要 Playwright。
 * 蓝湖 DDS 接口只要一个 Cookie，切图是公开 CDN，PNG 裁切由本包的 lib/ 自己实现。
 *
 * 提供三个工具（lanhu_dds_screens / lanhu_dds_build / lanhu_dds_doctor），并注册 lanhu-dds-codegen skill。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { buildDesign, diagnoseProject, initProjectRules, inspectUiLibrary, writeUiLibraryDoc } from './lib/lanhu-dds.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = join(HERE, 'skills', 'lanhu-dds-codegen')

export const name = 'dsh-lanhu-dds'
export const inject = ['tools', 'skills']

// ---------------------------------------------------------------- Cookie

/**
 * 凭据解析优先级：显式 config → 环境变量 → harness home 的 .env → 家目录单独文件。
 * 不写死在配置里，配置文件会被提交。
 */
export function resolveCookie(config) {
  if (config?.cookie) return { value: String(config.cookie), from: 'config' }
  if (process.env.LANHU_COOKIE) return { value: process.env.LANHU_COOKIE, from: 'env:LANHU_COOKIE' }

  const candidates = []
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  candidates.push(join(home, '.env'))
  candidates.push(join(process.cwd(), '.env'))
  if (config?.cookieFile) candidates.unshift(String(config.cookieFile))
  candidates.push(join(homedir(), '.lanhu-cookie'))

  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      if (file.endsWith('.env')) {
        const m = /^\s*(?:export\s+)?LANHU_COOKIE\s*=\s*"?([^"\n]+)"?\s*$/m.exec(text)
        if (m) return { value: m[1].trim(), from: file }
      } else {
        const v = text.trim().replace(/^["']|["']$/g, '')
        if (v) return { value: v, from: file }
      }
    } catch {
      // 读不到就试下一个来源，不在这里抛
    }
  }
  return { value: '', from: '' }
}

// ---------------------------------------------------------------- 工具定义

const COOKIE_HINT =
  '未找到蓝湖 Cookie。在蓝湖网页登录后按 F12 → Network → 任一 lanhuapp.com 请求 → 复制完整 Cookie 请求头，' +
  '然后设置环境变量 LANHU_COOKIE，或写入 ~/.lanhu-cookie。'

const SCREENS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: {
      type: 'string',
      description: '蓝湖设计图链接（可含 #、pid、image_id、tid）。只接受设计图，不接受 PRD/Axure 链接。',
    },
  },
}

const BUILD_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    url: { type: 'string', description: '蓝湖设计图链接。' },
    screens: {
      type: 'string',
      description: '要编译哪几屏：逗号分隔的屏序号（如 "0,2"）或 "all"。默认 "all"；建议先用 lanhu_dds_screens 选屏。',
    },
    out: {
      type: 'string',
      description: '产物目录，相对会话工作目录或绝对路径。默认 design/<设计图名>。',
    },
    scale: { type: 'number', description: '强制缩放比（1/2/3）。默认按屏宽自动推断。' },
    unit: {
      type: 'string',
      enum: ['design', 'css'],
      description: '输出单位。design（默认）= 直出设计稿 px，750 基准，交给项目内 px→rem 换算；css = 折成 375 逻辑宽的 CSS px。',
    },
    reference: { type: 'boolean', description: '是否下载整张画布参考图并裁出每屏 PNG。默认 true。' },
    assets: { type: 'boolean', description: '是否把切图下载到本地 assets/。默认 true。' },
  },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    hint: { type: 'string' },
  },
}

function renderJson(_args, value) {
  return [{ type: 'text', text: '```json\n' + JSON.stringify(value, null, 2) + '\n```' }]
}

function describeError(error, hint) {
  const out = { ok: false, error: String(error?.message ?? error) }
  if (hint) out.hint = hint
  return out
}

export function createScreensTool(getConfig) {
  return {
    name: 'lanhu_dds_screens',
    description:
      '列出蓝湖设计图里包含的所有手机屏（一张设计图通常横排多台手机屏）。' +
      '返回每屏的序号、尺寸、节点数、是否整图（raster）、导航栏标题与首屏文案。' +
      '照设计稿写代码前先调用它选屏，不要跳过。',
    parameters: SCREENS_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const { value: cookie } = resolveCookie(getConfig())
      if (!cookie) return { ok: false, error: 'missing-cookie', hint: COOKIE_HINT }
      try {
        const r = await buildDesign({ url: args.url, cookie, list: true })
        return { ok: true, name: r.name, canvas: r.canvas, scale: r.scale, screens: r.screens }
      } catch (error) {
        return describeError(error, '检查链接是否指向设计图（不是 PRD），以及 Cookie 是否过期。')
      }
    },
  }
}

const DOCTOR_PARAMS = {
  type: 'object',
  properties: {
    project: { type: 'string', description: '项目根目录，默认当前工作目录。' },
    init: { type: 'boolean', description: '生成 project-rules.md 接入模板（已存在不覆盖）。' },
    ui: { type: 'boolean', description: '扫内网 UI 库，把真实组件清单写到 .agents/skills/lanhu-dds-codegen/ui-library.md。' },
    pkg: { type: 'string', description: '内网 UI 库包名；不填则用 doctor 自动识别的第一个。' },
  },
}

export function createDoctorTool() {
  return {
    name: 'lanhu_dds_doctor',
    description:
      '检查项目是否已接入蓝湖 DDS 还原规范：读出该用的输出单位（design/css，依据 designWidth 或 postcss rootValue）、' +
      '识别内网 UI 包、列出 project-rules.md 还空着哪几项。**照设计稿写代码前先跑它**，' +
      '输出 ready:false 时说明项目规范还没填，此时照模板示例写就是编。',
    parameters: DOCTOR_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const dir = args.project ?? process.cwd()
      if (args.init) {
        const r = initProjectRules(dir)
        return r.ok ? { ok: true, ...r, hint: '把真实技术栈/目录/token/组件库填进去，填完再跑一次本工具直到 ready:true' } : { ok: false, ...r }
      }
      if (args.ui) {
        const diag = diagnoseProject(dir)
        if (!diag.ok) return { ok: false, error: diag.error }
        const pkg = args.pkg ?? diag.internalPackages[0]
        if (!pkg) return { ok: false, error: '没有识别到内网 UI 包', hint: '用 pkg 参数指定包名；或先确认 package.json 里内网库的写法' }
        const info = inspectUiLibrary(dir, pkg)
        if (!info.ok) return { ok: false, ...info, hint: '确认依赖已安装（node_modules 里有这个包）' }
        const w = writeUiLibraryDoc(dir, info)
        return { ok: true, ...w, components: info.components.map((c) => c.name), hint: '出码前先读这份清单找现成组件；缺的组件手写后加到文件末尾' }
      }
      const r = diagnoseProject(dir)
      if (!r.ok) return { ok: false, error: r.error, hint: '传入项目根目录（有 package.json 的那层）' }
      return r
    },
  }
}

export function createBuildTool(getConfig) {
  return {
    name: 'lanhu_dds_build',
    description:
      '把蓝湖设计图的指定屏编译成可直接消费的产物：设计稿裁图 PNG、结构 IR、像素几何表、绝对定位参考 HTML、' +
      '组件切分大纲、设计 token、体检报告，并把切图下载到本地。纯 Node 实现，不需要浏览器或 Python。',
    parameters: BUILD_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args) {
      const config = getConfig()
      const { value: cookie, from } = resolveCookie(config)
      if (!cookie) return { ok: false, error: 'missing-cookie', hint: COOKIE_HINT }
      try {
        const r = await buildDesign({
          url: args.url,
          cookie,
          out: args.out,
          screens: args.screens ?? 'all',
          scale: args.scale,
          unit: args.unit,
          reference: args.reference !== false,
          assets: args.assets !== false,
        })
        return { ok: true, cookieFrom: from, ...r }
      } catch (error) {
        return describeError(error, '检查链接里的 image_id 是否属于当前项目、Cookie 是否过期。')
      }
    },
  }
}

// ---------------------------------------------------------------- Skill

/** 从 SKILL.md 里剥掉 YAML frontmatter，拿到 name/description/正文。 */
export function readSkill(dir = SKILL_DIR) {
  const file = join(dir, 'SKILL.md')
  const raw = readFileSync(file, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  let meta = {}
  let body = raw
  if (m) {
    body = raw.slice(m[0].length)
    meta = Object.fromEntries(
      m[1].split(/\r?\n/).map((line) => {
        const i = line.indexOf(':')
        return i < 0 ? [line.trim(), ''] : [line.slice(0, i).trim(), line.slice(i + 1).trim()]
      }).filter(([k]) => k),
    )
  }
  return {
    name: meta.name ?? 'lanhu-dds-codegen',
    description: meta.description ?? '用蓝湖 DDS 把设计图还原成前端代码。',
    whenToUse: meta.whenToUse,
    content: body,
    resourceBase: { kind: 'directory', path: dir },
  }
}

// ---------------------------------------------------------------- 入口

export function apply(ctx, config) {
  const getConfig = () => config ?? {}

  for (const make of [createScreensTool, createBuildTool, createDoctorTool]) {
    try {
      const dispose = ctx.tools.register(make(getConfig))
      ctx.effect(() => dispose)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-lanhu-dds: 工具注册失败: ${error?.message ?? error}`)
    }
  }

  try {
    const skill = readSkill()
    ctx.effect(() => ctx.skills.register({ ...skill, source: 'custom' }))
  } catch (error) {
    ctx.logger?.warn?.(`dsh-lanhu-dds: skill 注册失败: ${error?.message ?? error}`)
  }

  ctx.logger?.info?.('dsh-lanhu-dds: 已就绪（tools: lanhu_dds_screens, lanhu_dds_build, lanhu_dds_doctor; skill: lanhu-dds-codegen）')
}
