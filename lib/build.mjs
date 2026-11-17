/** 高层入口：拉取 → 选屏 → 编译 → 切图 → 落盘。 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng } from './png.mjs'
import { round } from './util.mjs'
import { getBinary, parseLanhuUrl, resolveImage, fetchDds } from './lanhu-api.mjs'
import { sessionTmp, sessionDir, resolveOutDir, PLAN_FILE, PLANS_FILE } from './store.mjs'
import { rawRect, detectScaleAndScreens, describeScreen } from './dds-tree.mjs'
import { compileScreen, buildIr } from './compile.mjs'
import { renderHtml, collectTokens, tokensCss } from './render-html.mjs'
import { findRepeatGroups, outlineMarkdown, specMarkdown, screenIsPopupSheet } from './spec.mjs'
import { buildVariantsDiff, digestScreens } from './variants.mjs'
import { buildReport } from './report.mjs'
import { localizeAssets, cropScreenPng } from './assets.mjs'

function writeArtifacts(outDir, { meta, screenDescs, compiled, groups, crop, contract, unitDiv = 1, uiDoc = false, raster = false }) {
  const p = (f) => join(outDir, f)
  const screenNo = compiled.screenIndex
  const title = screenDescs[screenNo].title

  compiled.ir = buildIr(compiled.boxes, compiled.root)
  const html = renderHtml(compiled, { tokens: tokensCss(collectTokens(compiled)), title: `screen ${screenNo}` })
  const spec = specMarkdown(compiled, groups, { title, unit: meta.unit, contract, unitDiv, designWidth: meta.designWidth, uiDoc, raster })
  writeFileSync(p(`screen-${screenNo}.spec.md`), spec)
  writeFileSync(p(`screen-${screenNo}.html`), html)
  writeFileSync(p(`screen-${screenNo}.ir.json`), JSON.stringify(compiled.ir, null, 2))
  writeFileSync(p(`screen-${screenNo}.rects.json`), JSON.stringify(compiled.rects, null, 2))
  writeFileSync(p(`screen-${screenNo}.outline.md`), outlineMarkdown(compiled, groups))
  if (crop) writeFileSync(p(`screen-${screenNo}.png`), crop)

  return { specFile: `screen-${screenNo}.spec.md`, warningCount: compiled.warnings.length }
}

function writeSummaryArtifacts(outDir, { meta, screenDescs, builtEntries, assetStats, plan, unplanned = [] }) {
  const p = (f) => join(outDir, f)
  const compiledList = builtEntries.map((e) => e.compiled)
  const tokensText = tokensCss(collectTokens(compiledList))
  writeFileSync(p('tokens.css'), tokensText + '\n')

  const { pairs, identical, markdown } = buildVariantsDiff(builtEntries)
  if (markdown) writeFileSync(p('variants-diff.md'), markdown)
  else rmSync(p('variants-diff.md'), { force: true })

  const report = buildReport({
    meta,
    screens: screenDescs ?? [],
    compiledList,
    groupsByScreen: builtEntries.map((e) => [e.compiled.screenIndex, e.groups]),
    assetStats,
    variantPairs: pairs,
    identicalPairs: identical,
    unplanned,
    plan: { mode: MODES[plan.mode], pages: plan.pages, keep: plan.keep, drop: plan.drop },
  })
  writeFileSync(p('report.md'), report)
  return {
    variantsDiff: markdown ? 'variants-diff.md' : null,
    identicalPairs: identical,
    variantPairs: pairs.map(({ A, B, ratio }) => ({
      a: A.compiled.screenIndex,
      b: B.compiled.screenIndex,
      overlap: Math.round(ratio * 100) / 100,
    })),
  }
}

// ---------------------------------------------------------------- 高层入口

const MODES = { rewrite: '整体重构', optimize: '局部优化' }

/**
 * plan 是用户拍板结果的落盘形态（模式 + 页面文件 → 屏号 + 旧页独有功能的去留）。
 * 必填是为了把「先问后编」变成结构约束：没问过就填不出来；随产物落盘则保证上下文被压缩后仍能从规格表读回。
 */
const planFail = (msg) => { throw new Error(`plan 不合法：${msg}。plan 来自用户拍板，先用 ask_user_question 确认模式与「页面文件 → 屏号」映射再编译。`) }

/**
 * 只查形状、不查屏号的那部分校验。放在拉数据之前跑：plan 缺字段、mode 拼错这类错误
 * 不需要联网就能判，先去下载 DDS 再报错等于白跑三次请求。
 */
export function prevalidatePlan(plan) {
  if (!plan || typeof plan !== 'object') planFail('缺少 plan')
  if (!MODES[plan.mode]) planFail('mode 只能是 rewrite（整体重构）或 optimize（局部优化）')
  if (!Array.isArray(plan.pages) || !plan.pages.length) planFail('pages 至少一项')
  plan.pages.forEach((pg, i) => {
    if (!String(pg?.file ?? '').trim()) planFail(`pages[${i}].file 为空`)
    if (!Array.isArray(pg?.screens) || !pg.screens.length) planFail(`pages[${i}]（${String(pg?.file ?? '')}）没有对应屏号，screens 要是屏号数组`)
  })
}

export function normalizePlan(plan, totalScreens) {
  const fail = planFail
  prevalidatePlan(plan)
  const owner = new Map()
  const pages = plan.pages.map((pg, i) => {
    const file = String(pg.file).trim()
    const raw = pg.screens
    const screens = raw.map(Number)
    for (let j = 0; j < screens.length; j++) {
      const n = screens[j]
      // 报错要带原始值：Number('abc') 是 NaN，写成「屏 NaN 不存在」等于没说
      if (!Number.isInteger(n) || n < 0 || n >= totalScreens) fail(`${file} 的屏 ${JSON.stringify(raw[j])} 不是合法屏号（设计图共 ${totalScreens} 屏，序号 0–${totalScreens - 1}）`)
      if (owner.has(n)) {
        fail(owner.get(n) === file ? `${file} 里的屏 ${n} 重复了，一屏只能写一次` : `屏 ${n} 同时出现在 ${owner.get(n)} 和 ${file}，一屏只能归一个页面文件`)
      }
      owner.set(n, file)
    }
    return { file, screens }
  })
  const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [])
  return { mode: plan.mode, pages, keep: list(plan.keep), drop: list(plan.drop), owner }
}

/** 契约的一行写法：写进每份规格表与报告，压缩上下文后重读规格表即可恢复拍板结果。 */
function planLine(plan, screenIndex) {
  const page = plan.pages.find((pg) => pg.screens.includes(screenIndex))
  const siblings = page.screens.filter((n) => n !== screenIndex)
  return [
    `${MODES[plan.mode]} → \`${page.file}\``,
    siblings.length ? `同文件还有屏 ${siblings.join('、')}（同一页面的其他状态/弹层，合并实现）` : '',
    plan.keep.length ? `保留旧页功能：${plan.keep.join('、')}` : '',
    plan.drop.length ? `移除旧页功能：${plan.drop.join('、')}` : '',
  ].filter(Boolean).join('；')
}

/**
 * 「拉取 → 选屏 → 编译 → 切图 → 裁参考图 → 落盘」的唯一入口。
 */
export async function buildDesign({
  url, cookie, out, session, exec, plan: rawPlan, scale: forcedScale, unit: unitOpt, designWidth: designWidthOpt,
  uiDoc = false, reference = true, assets = true, list = false, clean = false,
} = {}) {
  if (!url) throw new Error('缺少 url')
  if (!cookie) throw new Error('缺少蓝湖 Cookie：由用户给出后作为参数传入（不读环境变量、不读配置文件）')
  if (!list) prevalidatePlan(rawPlan)
  const ids = parseLanhuUrl(url)
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
  // 输出单位：design = 设计稿 px（750 基准，项目内 px→rem 统一换算，值是设计稿上看到多少就是多少）
  //           css    = 折到 375 逻辑宽（1x 项目用）
  // design 的「750 基准」不是画布原样直出：画布可能是 1404 宽的 4x 图，直出会让所有尺寸偏大 1404/750 倍
  const unit = unitOpt === 'css' ? 'css' : 'design'
  const baseWidth = Number(designWidthOpt) || 0
  const screenWidth = detected.screens[0]?.raw?.w ?? 0
  const normalize = unit === 'design' && baseWidth > 0 && screenWidth > 0 && Math.abs(screenWidth / baseWidth - 1) > 0.01
  const div = unit === 'css' ? scale : (normalize ? screenWidth / baseWidth : 1)
  const allScreens = detected.screens.map((s, i) => ({
    ...s,
    index: i,
    rect: { x: round(s.raw.x / div), y: round(s.raw.y / div), w: round(s.raw.w / div), h: round(s.raw.h / div) },
  }))
  const canvas = { width: rawRect(tree).w, height: rawRect(tree).h }
  const meta = {
    ...meta0,
    scale,
    unit,
    canvas,
    ...ids,
    ...(normalize ? { div, designWidth: baseWidth, rawScreenWidth: screenWidth } : {}),
  }
  const descs = allScreens.map((s) => describeScreen(s, div))

  if (list) {
    // 选屏阶段就把全部业务文案和同页分组给出来（纯内存编译，不落盘、不下切图），用户拍板不需要先 build
    const digest = digestScreens(allScreens.map((s) => ({
      compiled: compileScreen(tree, s.node, { scale: div, screenIndex: s.index }),
      title: descs[s.index].title,
    })))
    return {
      ok: true,
      name: meta.name,
      scale,
      unit,
      // 归一倍数也要给出来：不然调用方拿 screens 的宽度和 build 的产物对不上，只能自己去猜
      ...(normalize ? { div, designWidth: baseWidth } : {}),
      screens: descs.map((d, i) => ({
        index: d.index, title: d.title, width: d.width, height: d.height, nodes: d.nodes,
        ...(d.raster ? { raster: true } : {}),
        // 几乎没节点的屏是设计器里的空框：写进 plan 只会换来一份空规格表（整图屏不算空）
        ...(!d.raster && d.nodes <= 3 ? { empty: true } : {}),
        ...(digest.screens[i].popup ? { popup: true } : {}),
        texts: digest.screens[i].texts,
        ...(digest.screens[i].moreTexts ? { moreTexts: digest.screens[i].moreTexts } : {}),
      })),
      pages: digest.pages,
    }
  }

  // 产物目录始终等于 plan：每次都按 plan 全量落盘（DDS 与切图有缓存，重跑不走网络），不在 plan 里的旧屏产物清掉
  const plan = normalizePlan(rawPlan, allScreens.length)
  const want = [...plan.owner.keys()].sort((a, b) => a - b)
  // plan 没覆盖的屏：可能是个该忽略的空屏，也可能是个被漏掉的状态。不给出来就只能靠用户自己数屏号
  const unplanned = allScreens
    .filter((s) => !plan.owner.has(s.index))
    .map((s) => ({
      index: s.index,
      title: descs[s.index].title,
      nodes: descs[s.index].nodes,
      // 整图屏不是「空屏」：它有内容，只是没有结构，处理方式和空框完全不同
      ...(descs[s.index].raster ? { raster: true } : descs[s.index].nodes <= 3 ? { empty: true } : {}),
    }))

  const outDir = tempOutDir
  const canReuse = Boolean(
    !clean
    && existingMeta
    && existingMeta.versionId === meta.versionId
    && existingMeta.unit === unit
    && existingMeta.scale === scale,
  )
  if (!canReuse && existsSync(outDir) && readdirSync(outDir).length) {
    // 仅在显式 clean 或设计稿版本/单位变更时清空目录；否则保留 DDS、参考图与切图缓存
    for (const f of readdirSync(outDir)) rmSync(join(outDir, f), { recursive: true, force: true })
  }
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(join(outDir, 'dds.raw.json'))) writeFileSync(join(outDir, 'dds.raw.json'), JSON.stringify(tree))
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

  for (const f of readdirSync(outDir)) {
    const m = /^screen-(\d+)\./.exec(f)
    if (m && !plan.owner.has(Number(m[1]))) rmSync(join(outDir, f), { force: true })
  }

  const built = []
  const builtEntries = []
  const popupByIdx = new Map()
  const deadHosts = new Set()
  const manifestByUrl = new Map()
  const assetSummary = { total: 0, saved: 0, cdn: 0, alipic: 0, cropped: 0, compositeIcons: 0, placeholders: 0 }

  for (const idx of want) {
    const s = allScreens[idx]
    const compiled = compileScreen(tree, s.node, { scale: div, screenIndex: idx })
    // 落盘的 screens.json 要与 screens 工具同口径：弹层、空框都标出来，否则两边对不上
    popupByIdx.set(idx, screenIsPopupSheet(compiled))
    // 计数不在循环里累加：同一张图被多屏引用会重复计入，报告数比磁盘上多两三倍。放在循环后按文件统一算
    if (assets) await localizeAssets(compiled, outDir, cookie, { refImg, deadHosts, manifestByUrl })
    const needCrop = reference || !existsSync(join(outDir, `screen-${idx}.png`))
    const crop = needCrop && (refImg || refPng)
      ? cropScreenPng(refImg || refPng, s.raw)
      : (existsSync(join(outDir, `screen-${idx}.png`)) ? 'reused' : null)
    const groups = findRepeatGroups(compiled)
    const result = writeArtifacts(outDir, {
      meta, screenDescs: descs, compiled, groups,
      crop: Buffer.isBuffer(crop) ? crop : null,
      contract: planLine(plan, idx),
      unitDiv: div,
      uiDoc,
      raster: Boolean(descs[idx].raster),
    })
    builtEntries.push({ compiled, groups, title: descs[idx].title })
    // 返回体只留「去读哪个文件」：重复结构、切图明细都在规格表里，不在这里重复一遍
    built.push({
      index: idx,
      title: descs[idx].title,
      spec: result.specFile,
      png: Buffer.isBuffer(crop) || crop === 'reused' ? `screen-${idx}.png` : null,
      ...(crop?.error ? { pngError: crop.error } : {}),
      ...(descs[idx].raster ? { raster: true } : {}),
      ...(result.warningCount ? { warningCount: result.warningCount } : {}),
    })
  }

  if (assets) {
    const files = { cdn: new Set(), alipic: new Set(), cropped: new Set(), composite: new Set(), placeholder: new Set() }
    for (const { compiled } of builtEntries) {
      for (const b of compiled.boxes.values()) {
        const a = b.asset
        if (a?.status === 'ok' && a.file) {
          const bucket = a.source === 'alipic' ? files.alipic : a.source === 'cropped-from-reference' ? files.cropped : files.cdn
          bucket.add(a.file)
        } else if (a?.status === 'placeholder') {
          // 占位按 URL 去重：同一张图在几屏里都要兜底，报告只算一个
          files.placeholder.add(a.url ?? b.name ?? `node:${b.node}`)
        }
        if (b.compositeAsset?.file) files.composite.add(b.compositeAsset.file)
      }
    }
    assetSummary.cdn = files.cdn.size
    assetSummary.alipic = files.alipic.size
    assetSummary.cropped = files.cropped.size
    assetSummary.compositeIcons = files.composite.size
    assetSummary.placeholders = files.placeholder.size
    assetSummary.total = files.cdn.size + files.alipic.size + files.cropped.size + files.placeholder.size
    assetSummary.saved = files.cdn.size + files.alipic.size + files.cropped.size
  }

  writeFileSync(join(outDir, 'screens.json'), JSON.stringify(descs.map((d) => {
    const { raster, ...rest } = d
    return {
      ...rest,
      ...(raster ? { raster: true } : {}),
      // 没进 plan 的屏没编译过，弹层标志无从判断：留空，需要就问 screens 工具
      ...(!raster && d.nodes <= 3 ? { empty: true } : {}),
      ...(popupByIdx.get(d.index) ? { popup: true } : {}),
    }
  }), null, 2))

  const summary = writeSummaryArtifacts(outDir, { meta, screenDescs: descs, builtEntries, assetStats: assets ? assetSummary : null, plan, unplanned })

  // 收尾时 doctor 从这里读回契约：那时上下文多半已被压缩，模型靠回忆对不上拍板结果
  const contract = { mode: MODES[plan.mode], pages: plan.pages, keep: plan.keep, drop: plan.drop }
  writeFileSync(join(sessionDir(session, exec), PLAN_FILE), JSON.stringify(contract))
  // 一个会话里连着编译几张设计图时（多个画布链接），单文件会被后一张覆盖，收尾清单就只剩最后一张
  const plansPath = join(sessionDir(session, exec), PLANS_FILE)
  let plans = {}
  try { plans = JSON.parse(readFileSync(plansPath, 'utf8')) } catch { plans = {} }
  const canvasKey = meta.imageId || meta.name || `design-${Object.keys(plans).length + 1}`
  const prev = plans[canvasKey]
  // 选屏规则变化会让屏号整体漂移，旧 plan 里的屏号就会指到别的屏——不提示没人会去核对
  const driftWarnings = prev?.screens && prev.screens !== allScreens.length
    ? [`这张画布上次识别到 ${prev.screens} 屏、这次 ${allScreens.length} 屏：plan 里的屏号可能已经指到别的屏，核对 pages 的「文件 ← 屏号」映射（report.md 的屏清单有每屏标题）`]
    : []
  plans[canvasKey] = { ...contract, title: meta.name || '', outDir, screens: allScreens.length }
  writeFileSync(plansPath, JSON.stringify(plans, null, 2))

  const failedAssets = assetSummary.placeholders
  return {
    ok: true,
    outDir,
    tmpDir: sessionTmp(session, exec),
    unit,
    scale,
    // 按页面文件分组而不是按屏平铺：返回体的形状就是干活的顺序。平铺的 9 屏列表会被当成「先读完这 9 份」
    work: plan.pages.map((pg) => {
      const variants = summary.variantPairs.filter((v) => pg.screens.includes(v.a)).map((v) => `${v.a}↔${v.b}`)
      return {
        file: pg.file,
        screens: built.filter((b) => pg.screens.includes(b.index)),
        ...(variants.length ? { variants } : {}),
      }
    }),
    how: '一次只做一个文件：读它名下的规格表和裁图（有 variants 的再读 variants-diff.md 里对应的小节）→ 写完并过 lint → 再读下一个文件的。规格表留在磁盘上随用随读；先把所有屏读完再动笔，上下文一压缩就得重读。',
    ...(assets ? { assets: { saved: assetSummary.saved, ...(failedAssets ? { placeholders: failedAssets } : {}) } } : {}),
    ...(summary.variantsDiff ? { variantsDiff: summary.variantsDiff } : {}),
    ...(summary.identicalPairs?.length ? { identicalPairs: summary.identicalPairs } : {}),
    ...(unplanned.length ? { unplanned } : {}),
    ...(existsSync(refPath) ? {} : { reference: false, referenceError: meta.referenceError ?? '未取到参考图' }),
    // design 模式下坐标由屏宽自动归一，scale 只在 unit: css 时参与；传了却无声无息地不生效会被当成「调过了」
    ...(() => {
      const warnings = [
        ...(unit === 'design' && forcedScale != null
          ? ['scale 只在 unit: css 时生效；当前 unit=design，坐标按首屏宽/designWidth 自动归一，本次忽略 scale']
          : []),
        ...driftWarnings,
      ]
      return warnings.length ? { warnings } : {}
    })(),
  }
}
