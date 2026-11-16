/** 高层入口：拉取 → 选屏 → 编译 → 切图 → 落盘。 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { decodePng } from './png.mjs'
import { round } from './util.mjs'
import { getBinary, parseLanhuUrl, resolveImage, fetchDds } from './lanhu-api.mjs'
import { sessionKey, sessionTmp, resolveOutDir } from './store.mjs'
import { rawRect, detectScaleAndScreens, describeScreen } from './dds-tree.mjs'
import { compileScreen, buildIr } from './compile.mjs'
import { renderHtml, collectTokens, tokensCss } from './render-html.mjs'
import { findRepeatGroups, outlineMarkdown, specMarkdown } from './spec.mjs'
import { buildVariantsDiff } from './variants.mjs'
import { buildReport } from './report.mjs'
import { localizeAssets, cropScreenPng } from './assets.mjs'

export function writeArtifacts(outDir, { meta, tree, screens, screenDescs, compiled, groups, crop, skipSummary = false }) {
  mkdirSync(outDir, { recursive: true })
  const p = (f) => join(outDir, f)
  const screenNo = compiled.screenIndex
  const title = screenDescs?.[screenNo]?.title ?? ''

  if (!skipSummary) {
    writeFileSync(p('meta.json'), JSON.stringify({
      ...meta,
      reference: meta.referenceUrl ? 'screen-<n>.png 已裁出；整张原图见 reference.png' : undefined,
      screens: screenDescs,
      compiledAt: new Date().toISOString(),
    }, null, 2))
    if (tree) writeFileSync(p('dds.raw.json'), JSON.stringify(tree))
    if (screenDescs) writeFileSync(p('screens.json'), JSON.stringify(screenDescs, null, 2))
  }

  const singleTokensText = tokensCss(collectTokens(compiled))
  if (!skipSummary) writeFileSync(p('tokens.css'), singleTokensText + '\n')

  compiled.ir = buildIr(compiled.boxes, compiled.root)
  const html = renderHtml(compiled, { tokens: singleTokensText, title: `screen ${screenNo}` })
  const spec = specMarkdown(compiled, groups, { title, unit: meta.unit ?? 'design' })
  writeFileSync(p(`screen-${screenNo}.spec.md`), spec)
  writeFileSync(p(`screen-${screenNo}.html`), html)
  writeFileSync(p(`screen-${screenNo}.ir.json`), JSON.stringify(compiled.ir, null, 2))
  writeFileSync(p(`screen-${screenNo}.rects.json`), JSON.stringify(compiled.rects, null, 2))
  writeFileSync(p(`screen-${screenNo}.outline.md`), outlineMarkdown(compiled, groups))
  if (crop && Buffer.isBuffer(crop)) writeFileSync(p(`screen-${screenNo}.png`), crop)

  if (!skipSummary) {
    const report = buildReport({
      meta,
      screens: screenDescs ?? [],
      compiledList: [compiled],
      groupsByScreen: [[screenNo, groups]],
    })
    writeFileSync(p('report.md'), report)
  }

  return {
    outDir: resolve(outDir),
    screen: screenNo,
    index: screenNo,
    specFile: `screen-${screenNo}.spec.md`,
    files: [
      `screen-${screenNo}.spec.md`, `screen-${screenNo}.png`, `screen-${screenNo}.html`,
      `screen-${screenNo}.ir.json`, `screen-${screenNo}.rects.json`, `screen-${screenNo}.outline.md`,
      'tokens.css', 'report.md', 'screens.json', 'meta.json',
    ],
    warnings: compiled.warnings.length,
    nodes: compiled.boxes.size,
    repeatGroups: groups.length,
  }
}

function writeSummaryArtifacts(outDir, { meta, screenDescs, builtEntries, assetStats }) {
  const p = (f) => join(outDir, f)
  const compiledList = builtEntries.map((e) => e.compiled)
  const tokensText = tokensCss(collectTokens(compiledList))
  writeFileSync(p('tokens.css'), tokensText + '\n')

  const { pairs, markdown } = buildVariantsDiff(builtEntries)
  if (markdown) writeFileSync(p('variants-diff.md'), markdown)

  const report = buildReport({
    meta,
    screens: screenDescs ?? [],
    compiledList,
    groupsByScreen: builtEntries.map((e) => [e.compiled.screenIndex, e.groups]),
    assetStats,
    variantPairs: pairs,
  })
  writeFileSync(p('report.md'), report)
  return {
    variantsDiff: markdown ? 'variants-diff.md' : null,
    variantPairs: pairs.map(({ A, B, ratio }) => ({
      a: A.compiled.screenIndex,
      b: B.compiled.screenIndex,
      overlap: Math.round(ratio * 100) / 100,
    })),
  }
}

// ---------------------------------------------------------------- 高层入口

/**
 * 一条命令走完「拉取 → 选屏 → 编译 → 切图 → 裁参考图 → 落盘」。
 */
export async function buildDesign({
  url, cookie, out, session, exec, screens: picked, scale: forcedScale, unit: unitOpt,
  reference = true, assets = true, list = false, clean = false, meta: injectedMeta,
} = {}) {
  if (!url && !injectedMeta) throw new Error('缺少 url')
  if (!cookie && !injectedMeta) {
    throw new Error('缺少蓝湖 Cookie：由用户给出后作为参数传入（不读环境变量、不读配置文件）')
  }
  const ids = url ? parseLanhuUrl(url) : {}
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
  // 输出单位：design = 直出设计稿 px（750 基准，项目内 px→rem 统一换算，值是设计稿上看到多少就是多少）
  //           css    = 折到 375 逻辑宽（1x 项目用）
  const unit = unitOpt === 'css' ? 'css' : 'design'
  const div = unit === 'css' ? scale : 1
  const allScreens = detected.screens.map((s, i) => ({
    ...s,
    index: i,
    rect: { x: round(s.raw.x / div), y: round(s.raw.y / div), w: round(s.raw.w / div), h: round(s.raw.h / div) },
  }))
  const canvas = { width: rawRect(tree).w, height: rawRect(tree).h }
  const meta = { ...meta0, ...(injectedMeta ?? {}), scale, unit, canvas, ...ids }
  const descs = allScreens.map((s) => describeScreen(s, div))

  if (list) return { ok: true, list: true, session: sessionKey(session, exec), name: meta.name, canvas, scale, unit, screens: descs }

  const outDir = tempOutDir
  const canReuse = Boolean(
    !clean
    && existingMeta
    && existingMeta.versionId === meta.versionId
    && existingMeta.unit === unit
    && existingMeta.scale === scale,
  )
  if (!canReuse && existsSync(outDir) && readdirSync(outDir).length) {
    // 仅在显式 clean 或设计稿版本/单位变更时清空目录；同版本局部重编保留其余屏产物与切图
    for (const f of readdirSync(outDir)) rmSync(join(outDir, f), { recursive: true, force: true })
  }
  mkdirSync(outDir, { recursive: true })
  if (!existsSync(join(outDir, 'dds.raw.json'))) writeFileSync(join(outDir, 'dds.raw.json'), JSON.stringify(tree))
  writeFileSync(join(outDir, 'screens.json'), JSON.stringify(descs, null, 2))
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

  const want = picked === undefined || picked === 'all'
    ? allScreens.map((s) => s.index)
    : String(picked).split(',').map((x) => Number(x.trim()))
  const built = []
  const builtEntriesByIdx = new Map()
  const deadHosts = new Set()
  const manifestByUrl = new Map()
  const assetSummary = { total: 0, saved: 0, cdn: 0, alipic: 0, cropped: 0, compositeIcons: 0, placeholders: 0 }

  for (const idx of want) {
    const s = allScreens[idx]
    if (!s) { built.push({ screen: idx, error: '该屏不存在' }); continue }
    const compiled = compileScreen(tree, s.node, { scale: div, screenIndex: idx })
    const assetResult = assets
      ? await localizeAssets(compiled, outDir, cookie, { refImg, deadHosts, manifestByUrl })
      : null
    if (assetResult) {
      assetSummary.total += assetResult.total
      assetSummary.saved += assetResult.saved
      assetSummary.cdn += assetResult.cdn
      assetSummary.alipic += assetResult.alipic
      assetSummary.cropped += assetResult.cropped
      assetSummary.compositeIcons += assetResult.compositeIcons ?? 0
      assetSummary.placeholders += assetResult.placeholders
    }
    const needCrop = reference || !existsSync(join(outDir, `screen-${idx}.png`))
    const crop = needCrop && (refImg || refPng)
      ? cropScreenPng(refImg || refPng, s.raw)
      : (existsSync(join(outDir, `screen-${idx}.png`)) ? 'reused' : null)
    const groups = findRepeatGroups(compiled)
    const result = writeArtifacts(outDir, {
      meta, tree: null, screens: allScreens, screenDescs: descs, compiled, groups,
      crop: Buffer.isBuffer(crop) ? crop : null,
      skipSummary: true,
    })
    builtEntriesByIdx.set(idx, { compiled, groups, title: descs[idx].title })
    built.push({
      index: idx,
      title: descs[idx].title,
      size: { width: descs[idx].width, height: descs[idx].height },
      raster: descs[idx].raster,
      specFile: result.specFile,
      crop: Buffer.isBuffer(crop) || crop === 'reused' ? `screen-${idx}.png` : (crop?.error ?? null),
      nodes: result.nodes,
      warnings: result.warnings,
      assets: assetResult ? {
        total: assetResult.total,
        saved: assetResult.saved,
        cdn: assetResult.cdn,
        alipic: assetResult.alipic,
        cropped: assetResult.cropped,
        compositeIcons: assetResult.compositeIcons ?? 0,
        placeholders: assetResult.placeholders,
      } : null,
      repeatGroups: groups.map((g) => ({ parent: g.parentName, count: g.count, texts: g.texts })),
    })
  }

  // 若目录下还保留着同会话前序编译的其他屏（增量构建），一并纳入全局 report.md 与 variants-diff.md，避免冲掉前序汇总
  if (canReuse) {
    for (const f of readdirSync(outDir)) {
      const m = /^screen-(\d+)\.spec\.md$/.exec(f)
      if (!m) continue
      const idx = Number(m[1])
      if (builtEntriesByIdx.has(idx) || !allScreens[idx]) continue
      const compiled = compileScreen(tree, allScreens[idx].node, { scale: div, screenIndex: idx })
      builtEntriesByIdx.set(idx, { compiled, groups: findRepeatGroups(compiled), title: descs[idx].title })
    }
  }
  const summaryEntries = [...builtEntriesByIdx.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)

  const summary = summaryEntries.length
    ? writeSummaryArtifacts(outDir, { meta, screenDescs: descs, builtEntries: summaryEntries, assetStats: assets ? assetSummary : null })
    : { variantsDiff: null, variantPairs: [] }

  const key = sessionKey(session, exec)
  return {
    ok: true,
    session: key,
    tmpDir: sessionTmp(session, exec),
    outDir,
    reusedCache: canReuse,
    canvas,
    scale,
    unit,
    totalScreens: descs.length,
    built,
    cachedScreens: [...builtEntriesByIdx.keys()].sort((a, b) => a - b),
    assets: assets ? assetSummary : null,
    variantsDiff: summary.variantsDiff,
    variantPairs: summary.variantPairs,
    reference: existsSync(refPath),
  }
}
