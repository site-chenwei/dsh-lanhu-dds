/**
 * dsh-lanhu-dds — 把蓝湖「转代码」(DDS) 接进 DSH。
 *
 * 零依赖：不需要 lanhu-mcp、不需要 Python、不需要 Playwright。
 * 蓝湖 DDS 接口只要一个 Cookie，切图支持公开 CDN + alipic 内网镜像 + 原图无遮挡裁切三级回退。
 *
 * 提供三个工具（lanhu_dds_screens / lanhu_dds_build / lanhu_dds_doctor），并注册 lanhu-dds-codegen skill。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDesign } from './lib/build.mjs'
import { diagnoseProject, initProjectRules, scanAndWriteUiDocs, detectUnitBasis } from './lib/project.mjs'
import { describeComponents } from './lib/component-card.mjs'
import { COOKIE_FILE, PLAN_FILE, readCookie, saveCookie, forgetCookie, pruneSessions, sessionDir } from './lib/store.mjs'
import { UI_DOC_REL } from './lib/ui-library.mjs'

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
  required: ['url', 'plan'],
  properties: {
    cookie: COOKIE_PARAM,
    url: { type: 'string', description: '蓝湖设计图链接。' },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'pages'],
      description:
        '用户拍板的结果，原样填入；会写进 report.md 和每份规格表顶部，之后以规格表里的这一行为准。' +
        '一个页面的多个状态、变体、弹层屏归到同一个 file 下（参考 lanhu_dds_screens 返回的 pages 分组）。',
      properties: {
        mode: { type: 'string', enum: ['rewrite', 'optimize'], description: 'rewrite = 整体重构；optimize = 局部优化。' },
        pages: {
          type: 'array',
          minItems: 1,
          description: '页面文件 → 屏号。一屏只归一个文件。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['file', 'screens'],
            properties: {
              file: { type: 'string', description: '项目内页面文件路径，如 src/pages/mall/detail/index.vue。' },
              screens: { type: 'array', minItems: 1, items: { type: 'integer' }, description: '对应的屏序号。' },
            },
          },
        },
        keep: { type: 'array', items: { type: 'string' }, description: '旧页里设计稿没有、但用户要保留的功能，每项一条。' },
        drop: { type: 'array', items: { type: 'string' }, description: '旧页里设计稿没有、用户同意移除的功能，每项一条。' },
      },
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
      description:
        '输出单位。design（默认）= 设计稿 px，按项目 designWidth 归一（画布 1404 宽的 4x 图会 ÷1.872 折成 750 基准，与切图像素同一空间），交给项目内 px→rem 换算；css = 折成 375 逻辑宽的 CSS px。',
    },
    reference: { type: 'boolean', description: '是否下载整张画布参考图并裁出每屏 PNG。默认 true。' },
    assets: { type: 'boolean', description: '是否把切图下载到本地 assets/（含像素宽高与组合碎片小图标预裁）。默认 true。' },
    clean: {
      type: 'boolean',
      description: '是否清空同会话产物目录、重新拉取 DDS 与切图。默认 false（复用同设计图版本的缓存）。',
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

// 返回体是给模型读的：不缩进，省下的字符比可读性值钱
function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** 组件卡片本身是 Markdown，直接给正文；其余诊断结果仍走 JSON。 */
function renderDoctor(args, value) {
  if (!value.cards) return renderJson(args, value)
  const missing = value.missing?.length
    ? `\n\n未找到：${value.missing.join('、')}（在 ${value.searched.join('、')} 的编译产物和类型声明里都没有这个名字；确认它与 ui-library.md 里的写法一致，或它是底层库透传的组件）`
    : ''
  return [{ type: 'text', text: value.cards.join('\n\n') + missing }]
}

export function describeError(error, hint) {
  const msg = String(error?.message ?? error)
  if (/10089|登录权限|permission to access this project|Cookie 过期|未登录|HTTP 40[13]|HTTP 418/i.test(msg)) {
    return cookiePayload('cookie-expired', msg)
  }
  const out = { ok: false, error: msg }
  // 插件自身抛的异常和链接/Cookie 无关：给方向性错误的提示会让模型去查链接、重试同一次调用，比不给提示更贵
  if (/Maximum call stack|Converting circular|Cannot read propert|is not a function|of undefined|out of memory/i.test(msg)) {
    out.hint = '插件内部错误，与链接和 Cookie 无关：不要重试同一调用，把这条 error 原文贴给插件维护者。'
    return out
  }
  if (hint) out.hint = hint
  return out
}

export function createScreensTool() {
  return {
    name: 'lanhu_dds_screens',
    description:
      '列出蓝湖设计图里的所有手机屏（一张设计图通常横排多台手机屏）。不落盘、不下载切图。' +
      '每屏返回序号、尺寸、导航栏标题、是否弹层（popup）与去掉壳层后的全部业务文案（texts）；' +
      'pages 给出「哪几屏是同一个页面的不同状态/弹层」的分组。' +
      '这些信息足够对照旧页面、向用户确认模式与「页面文件 → 屏号」映射；确认结果填进 lanhu_dds_build 的 plan。' +
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
          scale: r.scale,
          screens: r.screens,
          pages: r.pages,
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
    component: {
      type: 'string',
      description:
        '查组件卡片：逗号分隔的组件名（如 "XwStepper,XwPageContainer"）。返回每个组件的 props 类型/默认值/说明、事件、插槽、' +
        '类名与插槽的渲染出现顺序、全部样式规则体（含 CSS 变量回退值）。要用某个组件却拿不准默认值、插槽位置或内部样式时调它，不用翻 node_modules。',
    },
    pkg: { type: 'string', description: '显式指定 UI 库包名（配合 ui 或 component）；不填则用自动识别到的全部内网 UI 包（自动排除工具/SDK 包）。' },
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
      '区分内网 UI 组件包/图标包与工具包，并支持一键生成 ui-library.md（ui:true）与 project-rules.md（init:true，二者可同传）。' +
      '传 component 时改为返回指定组件的卡片（默认值、插槽位置、样式规则体）。',
    parameters: DOCTOR_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderDoctor },
    async execute(args, exec) {
      if (args.forget) return { ok: true, ...forgetCookie(), hint: '已删除存着的 Cookie，下次调用会重新向用户要' }
      if (args.prune) return { ok: true, ...pruneSessions({ days: args.days ?? 7 }), hint: '已清掉超期会话目录；Cookie 不受影响' }

      const dir = await resolveProjectDir(ctx, args.project, exec)
      if (args.component) {
        const pkgs = args.pkg ? [args.pkg] : diagnoseProject(dir).uiPackages ?? []
        if (!pkgs.length) return { ok: false, error: '没有识别到内网 UI 包', hint: '用 pkg 参数显式指定包名' }
        const names = String(args.component).split(',').map((x) => x.trim().replace(/^<|\/?>$/g, '')).filter(Boolean)
        const { cards, missing } = describeComponents(dir, names, pkgs)
        return { ok: cards.length > 0, cards, missing, searched: pkgs }
      }
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
      // 本会话编译过：把拍板契约带回来。收尾时上下文多半已被压缩，模型不记得写过什么，
      // 会靠重读自己的文件来找安全感；给它一份可逐项勾掉的清单和明确的停止条件
      let plan = null
      try { plan = JSON.parse(readFileSync(join(sessionDir(undefined, exec), PLAN_FILE), 'utf8')) } catch { /* 还没编译过 */ }
      if (!plan) return diag
      return {
        ...diag,
        closeout: {
          mode: plan.mode,
          pages: plan.pages.map((pg) => `${pg.file} ← 屏 ${pg.screens.join('、')}`),
          keep: plan.keep,
          drop: plan.drop,
          next: `代码已写完并过了 lint 时，收尾只剩这一步：pages 的每个文件都已按设计稿实现、keep 的每一项还在、drop 的每一项已去掉${diag.strays.length ? '，并删掉 strays 里的文件' : ''}——各确认一次就交付。图标只按规格表给的尺寸与颜色写了 CSS 占位、资源由用户提供，这不算未完成项；同理不要为确认去重读已写的文件、规格表或图标库，除非想得起某一条具体没做。代码还没写完时忽略本段。`,
        },
      }
    },
  }
}

export function createBuildTool(ctx) {
  return {
    name: 'lanhu_dds_build',
    description:
      '按用户拍板的 plan 把蓝湖设计图编译成可直接消费的产物：每屏一份紧凑规格表 screen-N.spec.md（自动折叠顶部状态栏/导航栏壳层并标注底部安全区占位，含屏内坐标、父相位移、间距、完整背景渐变与样式、切图像素尺寸、组合小图标预裁图与文案，单次 read 即可写代码）、' +
      '设计稿裁图 screen-N.png、同页多屏的变体差异表 variants-diff.md（独有区块 + 同一元素的字号/间距/颜色等属性差）、汇总体检报告 report.md，并自动通过公开 CDN / alipic 内网镜像 / 原图无遮挡裁切三级回退保存本地切图（含 style.background 简写背景图）。' +
      'plan 必填且来自用户确认：没确认过模式与「页面文件 → 屏号」映射就先去问，不要先编译再问。' +
      '每次按 plan 全量落盘，产物目录始终与 plan 一致；同会话重跑复用已缓存的 DDS、参考图与切图，不重复下载。',
    parameters: BUILD_PARAMS,
    output: { schema: OUTPUT_SCHEMA, render: renderJson },
    async execute(args, exec) {
      const given = typeof args.cookie === 'string' ? args.cookie.trim() : ''
      const cookie = given || readCookie()
      if (!cookie) return cookiePayload('missing-cookie')
      try {
        const projectDir = await resolveProjectDir(ctx, undefined, exec)
        const { designWidth } = detectUnitBasis(projectDir)
        // 规格表里要不要指路 ui-library.md，取决于这份清单是否已经生成过
        const uiDoc = existsSync(join(projectDir, UI_DOC_REL))
        const r = await buildDesign({
          url: args.url,
          cookie,
          exec,
          session: args.session,
          out: args.out,
          plan: args.plan,
          scale: args.scale,
          unit: args.unit,
          designWidth,
          uiDoc,
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
        // plan 校验失败的报错自带下一步，不再附加与之无关的链接/Cookie 提示
        const planError = /^plan 不合法/.test(String(error?.message))
        return describeError(error, planError ? '' : '检查链接里的 image_id 是否属于当前项目、Cookie 是否过期。')
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
  for (const make of [() => createScreensTool(), () => createBuildTool(ctx), () => createDoctorTool(ctx)]) {
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
