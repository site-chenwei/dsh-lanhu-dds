/**
 * dsh-lanhu-dds — 把蓝湖「转代码」(DDS) 接进 DSH。
 *
 * 零依赖：不需要 lanhu-mcp、不需要 Python、不需要 Playwright。
 * 蓝湖 DDS 接口只要一个 Cookie，切图支持公开 CDN + alipic 内网镜像 + 原图无遮挡裁切三级回退。
 *
 * 提供三个工具（lanhu_dds_screens / lanhu_dds_build / lanhu_dds_doctor），并注册 lanhu-dds-codegen skill。
 */

import { readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildDesign,
  diagnoseProject,
  initProjectRules,
  scanAndWriteUiDocs,
  COOKIE_FILE,
  readCookie,
  saveCookie,
  forgetCookie,
  pruneSessions,
} from './lib/lanhu-dds.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = join(HERE, 'skills', 'lanhu-dds-codegen')

export const name = 'dsh-lanhu-dds'
export const inject = ['tools', 'skills']

// ---------------------------------------------------------------- Cookie
//
// 唯一存放位置：lib 里的 COOKIE_FILE，默认 ~/.dsh-lanhu-dds/cookie（0600）。
// 没有就向用户要；拿到后先真读一次设计图验证，通过才落盘；之后所有会话直接复用。
// 不读环境变量、不读 .env、不读 config —— 只有一个位置，配没配、有没有过期，看这个文件就知道。

export { COOKIE_FILE, readCookie, saveCookie, forgetCookie }

const HOW_TO_GET =
  '浏览器登录蓝湖 → F12 → Network → 任一 lanhuapp.com 请求 → 复制完整 Cookie 请求头（一整行，通常含 SESSION 等键）'

const SECURITY =
  `Cookie 等同登录态：不要写进代码、不要提交到仓库、不要在回复里回显。它只会被存到 ${COOKIE_FILE}（权限 0600）`

/** 缺 Cookie / Cookie 被拒时返回一份可以直接转述给用户的载荷，而不是一句错误字符串。 */
function cookiePayload(kind, detail) {
  const out = {
    ok: false,
    error: kind,
    cookieFile: COOKIE_FILE,
    askUser:
      kind === 'cookie-expired'
        ? `已存的 Cookie（${COOKIE_FILE}）被拒绝了，重试没用。把下面这段话说给用户，拿到新的我验证后覆盖它。`
        : '停在这里向用户要 Cookie。不要猜、不要伪造、不要绕过它去凭想象编页面结构和样式。',
    say:
      kind === 'cookie-expired'
        ? '蓝湖拒绝访问：Cookie 过期，或当前账号没有这个项目的权限。请确认登录的账号，重新给我一份 Cookie。'
        : '这次还原需要蓝湖登录态：给我一份蓝湖网页的 Cookie（F12 里那个整行 Cookie）。',
    howToGet: HOW_TO_GET,
    howToGive: [`直接在对话里贴给我，我验证通过后会存到 ${COOKIE_FILE}（0600），以后所有会话都不必再贴`],
    whatHappensNext: `收到后我先用一个真实设计图验证能不能读，通过就存到 ${COOKIE_FILE}（0600），以后所有会话都不用再贴；不通过我会告诉你，绝不存坏值。`,
    afterFill: '以后只要这个文件还在就直接用；换号或过期时重贴一次，自动覆盖。',
    security: SECURITY,
  }
  if (detail) out.detail = detail
  return out
}

const COOKIE_PARAM = {
  type: 'string',
  description:
    '用户在对话里给出的蓝湖 Cookie（整行）。唯一来源：没有就先按 missing-cookie 的说法问用户，' +
    '不要从环境变量、配置文件、历史消息里找替代值。同一轮任务后续调用可省略，会复用。',
}

const SCREENS_PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['url'],
  properties: {
    cookie: COOKIE_PARAM,
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
    cookie: COOKIE_PARAM,
    url: { type: 'string', description: '蓝湖设计图链接。' },
    screens: {
      type: 'string',
      description: '要编译哪几屏：逗号分隔的屏序号（如 "0,2"）或 "all"。默认 "all"；建议先用 lanhu_dds_screens 选屏。',
    },
    out: {
      type: 'string',
      description:
        '产物子目录名（只一层，默认 <设计图名>-<id8>）。落在 ~/.dsh-lanhu-dds/sessions/<会话>/ 下，不接受路径与 ..。',
    },
    session: {
      type: 'string',
      description: '会话目录名。默认取当前 DSH 会话 id（每次对话各自隔离）；一般不用填，只在要跨会话复用产物时指定。',
    },
    scale: { type: 'number', description: '强制缩放比（1/2/3）。默认按屏宽自动推断。' },
    unit: {
      type: 'string',
      enum: ['design', 'css'],
      description: '输出单位。design（默认）= 直出设计稿 px，750 基准，交给项目内 px→rem 换算；css = 折成 375 逻辑宽的 CSS px。',
    },
    reference: { type: 'boolean', description: '是否下载整张画布参考图并裁出每屏 PNG。默认 true。' },
    assets: { type: 'boolean', description: '是否把切图下载到本地 assets/（含像素宽高与组合碎片小图标预裁）。默认 true。' },
    clean: {
      type: 'boolean',
      description: '是否清空同会话产物目录后全量重建。默认 false（同设计图同单位下增量合并，保留此前已编译的其他屏与 reference.png）。',
    },
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
  const msg = String(error?.message ?? error)
  if (/10089|登录权限|permission to access this project|Cookie 过期|未登录|HTTP 40[13]|HTTP 418/i.test(msg)) {
    return cookiePayload('cookie-expired', msg)
  }
  const out = { ok: false, error: msg }
  if (hint) out.hint = hint
  return out
}

export function createScreensTool() {
  return {
    name: 'lanhu_dds_screens',
    description:
      '列出蓝湖设计图里包含的所有手机屏（一张设计图通常横排多台手机屏）。' +
      '返回每屏的序号、尺寸、节点数、是否整图（raster）、导航栏标题与首屏文案。' +
      '照设计稿写代码前必须先调用它选屏，随后用 ask_user_question 向用户确认「整体重构 vs 局部优化」与「屏→页面范围映射」后再调 lanhu_dds_build。' +
      '缺 Cookie 时返回 missing-cookie 与获取方法——此时停下来问用户，不要自行编造。',
    parameters: SCREENS_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const given = typeof args.cookie === 'string' ? args.cookie.trim() : ''
      const cookie = given || readCookie()
      if (!cookie) return cookiePayload('missing-cookie')
      try {
        const r = await buildDesign({ url: args.url, cookie, exec, list: true })
        const saved = given ? saveCookie(given) : null
        return {
          ok: true,
          name: r.name,
          canvas: r.canvas,
          scale: r.scale,
          screens: r.screens,
          ...(saved?.ok ? { cookieSavedTo: saved.path } : {}),
        }
      } catch (error) {
        return describeError(error, '检查链接是否指向设计图（不是 PRD），以及 Cookie 是否过期。')
      }
    },
  }
}

const DOCTOR_PARAMS = {
  type: 'object',
  properties: {
    project: { type: 'string', description: '项目根目录；省略时自动取当前会话工作目录（无需手传）。' },
    init: { type: 'boolean', description: '生成 project-rules.md 接入模板（已存在不覆盖；若项目已有完备 AGENTS.md 则无需开启）。可与 ui:true 同时传入。' },
    ui: { type: 'boolean', description: '扫内网 UI 库与图标库，把真实组件清单写到 .agents/skills/lanhu-dds-codegen/ui-library.md。可与 init:true 同时传入。' },
    pkg: { type: 'string', description: '显式指定要扫描的 UI 库包名；不填则自动扫描全部识别到的内网 UI 包与图标包（自动排除工具/SDK 包）。' },
    forget: { type: 'boolean', description: '删除已保存的蓝湖 Cookie（换号或排查 Cookie 问题时用）。' },
    prune: { type: 'boolean', description: '清掉超过 days 天没动的会话目录（产物 + 临时脚本），不动 Cookie。' },
    days: { type: 'number', description: 'prune 的天数阈值，默认 7。' },
  },
}

async function resolveProjectDir(ctx, explicit, exec) {
  if (explicit && String(explicit).trim()) return resolve(String(explicit).trim())
  try {
    const wd = ctx?.get?.('workingDirectory')
    if (wd?.ensure && exec?.agent) {
      const agentCwd = await wd.ensure(exec.agent, exec.signal)
      if (agentCwd) return resolve(agentCwd)
    }
  } catch { /* 回退到环境变量或进程工作目录 */ }
  return resolve(process.env.DSH_CWD || process.cwd())
}

export function createDoctorTool(ctx) {
  return {
    name: 'lanhu_dds_doctor',
    description:
      '检查项目是否已接入蓝湖 DDS 还原规范：自动定位当前会话工作目录、读出输出单位（design/css）、识别既有 AGENTS.md、' +
      '区分内网 UI 组件包/图标包与工具包，并支持一键生成 ui-library.md（ui:true）与 project-rules.md（init:true，二者可同传）。',
    parameters: DOCTOR_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      if (args.forget) return { ok: true, ...forgetCookie(), hint: '已删除存着的 Cookie，下次调用会重新向用户要' }
      if (args.prune) return { ok: true, ...pruneSessions({ days: args.days ?? 7 }), hint: '已清掉超期会话目录；Cookie 不受影响' }

      const dir = await resolveProjectDir(ctx, args.project, exec)
      const actions = {}
      if (args.init) {
        actions.init = initProjectRules(dir)
      }
      if (args.ui) {
        actions.ui = scanAndWriteUiDocs(dir, args.pkg)
      }
      const diag = diagnoseProject(dir)
      if (!diag.ok) {
        return { ok: false, error: diag.error, hint: '确认当前工作目录或 project 参数指向含 package.json 的项目根目录' }
      }
      if (args.init || args.ui) {
        const anyFailed = (actions.init && !actions.init.ok) || (actions.ui && !actions.ui.ok)
        return {
          ok: !anyFailed,
          ...actions,
          diagnosis: diag,
          ...(actions.ui && !actions.ui.ok ? { error: actions.ui.error } : {}),
          hint: diag.ready
            ? '项目规范与 UI 组件清单均已就绪，可直接进入选屏/编译/逐页出码。'
            : '请按 diagnosis.todos 处理剩余项；若项目已有完备 AGENTS.md，以其为最高准则。',
        }
      }
      return diag
    },
  }
}

export function createBuildTool() {
  return {
    name: 'lanhu_dds_build',
    description:
      '把蓝湖设计图的指定屏编译成可直接消费的产物：每屏一份紧凑规格表 screen-N.spec.md（自动折叠顶部状态栏/导航栏壳层并标注底部安全区占位，含屏内坐标、父相位移、间距、完整背景渐变与样式、切图像素尺寸、组合小图标预裁图与文案，单次 read 即可写代码）、' +
      '设计稿裁图 screen-N.png、去壳精准配对的多屏变体差异表 variants-diff.md、汇总体检报告 report.md，并自动通过公开 CDN / alipic 内网镜像 / 原图无遮挡裁切三级回退保存本地切图（含 style.background 简写背景图）。' +
      '同一会话重跑部分 screens 时默认非破坏性增量合并，不会删掉已编译的其他屏与 reference.png。',
    parameters: BUILD_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const given = typeof args.cookie === 'string' ? args.cookie.trim() : ''
      const cookie = given || readCookie()
      if (!cookie) return cookiePayload('missing-cookie')
      try {
        const r = await buildDesign({
          url: args.url,
          cookie,
          exec,
          session: args.session,
          out: args.out,
          screens: args.screens ?? 'all',
          scale: args.scale,
          unit: args.unit,
          reference: args.reference !== false,
          assets: args.assets !== false,
          clean: Boolean(args.clean),
        })
        const saved = given ? saveCookie(given) : null
        return {
          ok: true,
          cookieFrom: given ? '本次提供（已验证通过）' : COOKIE_FILE,
          ...r,
          ...(saved?.ok ? { cookieSavedTo: saved.path } : {}),
        }
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

export function apply(ctx, _config) {
  for (const make of [() => createScreensTool(), () => createBuildTool(), () => createDoctorTool(ctx)]) {
    try {
      const dispose = ctx.tools.register(make())
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
