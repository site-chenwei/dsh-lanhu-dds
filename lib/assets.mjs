/** 切图落地：公开 CDN → alipic 镜像 → 参考图裁切三级回退，含尺寸与空白图识别。 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { decodePng, encodePng, cropPng } from './png.mjs'
import { getBinary, toAlipicMirror } from './lanhu-api.mjs'
import { CSS_URL_RE, extractCssUrl, detectScreenChrome } from './spec.mjs'

// ---------------------------------------------------------------- 产物落盘

function overlapsText(raw, textRects) {
  for (const tr of textRects) {
    const ox = Math.min(raw.x + raw.w, tr.x + tr.w) - Math.max(raw.x, tr.x)
    const oy = Math.min(raw.y + raw.h, tr.y + tr.h) - Math.max(raw.y, tr.y)
    if (ox > 2 && oy > 2) return true
  }
  return false
}

/** 纯 Node 读取常见光栅图片（PNG/GIF/WebP/JPEG）文件头真实像素宽高，避免模型手写 System.Drawing 脚本查尺寸。 */
export function imageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 10) return null
  // PNG: 89 50 4E 47 0D 0A 1A 0A + IHDR(width@16, height@20)
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  // RIFF....WEBP
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16)
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') {
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    }
  }
  // JPEG: FF D8 ... SOFn
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf[i + 1]
      if (marker === 0xff) { i++; continue }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2
        continue
      }
      const len = buf.readUInt16BE(i + 2)
      if (len < 2) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      }
      i += 2 + len
    }
  }
  return null
}

function isCompositeIconContainer(b, boxes) {
  if (b.type !== 'lanhublock' || b.kids.length < 2) return false
  if (b.raw.w < 12 || b.raw.w > 96 || b.raw.h < 12 || b.raw.h > 96) return false
  let hasText = false
  let imgCount = 0
  let maxImgArea = 0
  const walk = (x) => {
    if (x.type === 'lanhutext' && x.text?.trim()) hasText = true
    if (x.type === 'lanhuimage') {
      imgCount++
      maxImgArea = Math.max(maxImgArea, x.raw.w * x.raw.h)
    }
    for (const k of x.kids) walk(boxes.get(k))
  }
  walk(b)
  return !hasText && imgCount >= 1 && maxImgArea < b.raw.w * b.raw.h * 0.85
}

/**
 * 切图本地化三级策略：
 *   1. 直连原 URL（lanhu-oss-*.lanhuapp.com），某域名首次失败即同域熔断，不逐张卡超时；
 *   2. 自动改写到同源镜像 alipic.lanhuapp.com（携带 Cookie + Referer，逐字节一致，解决内网拦截 lanhu-oss-*）；
 *   3. 仍不可达时，若已拿到整张 reference.png 且该图片节点无上层文字遮挡，直接从原图裁切兜底；有文字遮挡则标为占位。
 * 同时读取切图真实像素宽高写入 manifest 与 spec.md，并为 Figma 拆碎的组合小图标自动预裁整图。
 */
function isBlankIconPng(buf, dims) {
  if (!Buffer.isBuffer(buf) || buf.length > 8192 || buf[0] !== 0x89) return false
  if (!dims || dims.width > 128 || dims.height > 128) return false
  try {
    const decoded = decodePng(buf)
    const { channels, data } = decoded ?? {}
    if (!data?.length || !channels) return false
    let maxA = 0
    let minVisA = 255
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0
    for (let i = 0; i <= data.length - channels; i += channels) {
      const r = data[i]
      const g = channels >= 3 ? data[i + 1] : r
      const b = channels >= 3 ? data[i + 2] : r
      const a = channels === 4 ? data[i + 3] : channels === 2 ? data[i + 1] : 255
      if (a > maxA) maxA = a
      if (a > 16) {
        if (a < minVisA) minVisA = a
        if (r < minR) minR = r; if (r > maxR) maxR = r
        if (g < minG) minG = g; if (g > maxG) maxG = g
        if (b < minB) minB = b; if (b > maxB) maxB = b
      }
    }
    if (maxA <= 3) return true
    if (
      maxR - minR <= 3
      && maxG - minG <= 3
      && maxB - minB <= 3
      && maxA - minVisA <= 3
      && minR >= 248
      && minG >= 248
      && minB >= 248
    ) return true
    return false
  } catch {
    return false
  }
}

/**
 * 小图标是单色还是多色：单色图标可以换成图标库图标再用 color 上色，多色的只能用切图。
 * 这是模型反复纠结「图标库还是切图」时缺的那条事实。返回 '#rrggbb'（单色）、'multi'，不是小 PNG 时返回 undefined。
 */
function iconTint(buf, dims) {
  if (buf[0] !== 0x89 || !dims || dims.width > 192 || dims.height > 192) return undefined
  let img
  try { img = decodePng(buf) } catch { return undefined }
  const { channels, data } = img
  const visible = []
  let hasAlpha = false
  for (let i = 0; i <= data.length - channels; i += channels) {
    const r = data[i]
    const g = channels >= 3 ? data[i + 1] : r
    const b = channels >= 3 ? data[i + 2] : r
    const a = channels === 4 ? data[i + 3] : channels === 2 ? data[i + 1] : 255
    if (a < 128) hasAlpha = true
    else visible.push([r, g, b])
  }
  const dist = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2])
  const hex = (p) => `#${p.map((v) => v.toString(16).padStart(2, '0')).join('')}`
  const mostly = (list, ok) => list.filter(ok).length >= list.length * 0.92
  if (hasAlpha) {
    // 透明底：抗锯齿只改 alpha，单色图标的可见像素颜色基本一致
    const count = new Map()
    for (const p of visible) {
      const key = p.map((v) => v >> 4).join()
      count.set(key, (count.get(key) ?? 0) + 1)
    }
    const top = [...count].sort((x, y) => y[1] - x[1])[0]?.[0]
    const main = visible.find((p) => p.map((v) => v >> 4).join() === top)
    if (!main) return undefined
    return mostly(visible, (p) => dist(p, main) <= 48) ? hex(main) : 'multi'
  }
  // 不透明（从整图裁出的组合图标）：以左上角为底色，单色图标的像素都落在「底色 → 图标色」这条线段上
  const bg = visible[0]
  const ink = visible.filter((p) => dist(p, bg) > 48)
  if (!ink.length) return undefined
  const main = ink.reduce((far, p) => (dist(p, bg) > dist(far, bg) ? p : far))
  const axis = main.map((v, i) => v - bg[i])
  const len2 = axis.reduce((n, v) => n + v * v, 0)
  const offLine = (p) => {
    const d = p.map((v, i) => v - bg[i])
    const t = Math.min(1, Math.max(0, (d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / len2))
    return dist(d, axis.map((v) => v * t))
  }
  return mostly(ink, (p) => offLine(p) <= 36) ? hex(main) : 'multi'
}

export async function localizeAssets(compiled, outDir, cookie, { refImg = null, deadHosts = new Set(), manifestByUrl = null } = {}) {
  const chrome = detectScreenChrome(compiled)
  const imgBoxes = []
  const urls = new Set()
  for (const [node, b] of compiled.boxes) {
    if (chrome.skipNodeSet.has(node)) {
      if (extractCssUrl(b.css.backgroundImage)) delete b.css.backgroundImage
      if (extractCssUrl(b.css.background)) {
        const stripped = String(b.css.background).replace(CSS_URL_RE, '').trim()
        if (!stripped || /^(no-repeat|repeat|center|cover|contain|\d+%|\s)+$/i.test(stripped)) delete b.css.background
        else b.css.background = stripped
      }
      continue
    }
    const bgImgUrl = extractCssUrl(b.css.backgroundImage)
    const bgShorthandUrl = !bgImgUrl ? extractCssUrl(b.css.background) : null
    const url = bgImgUrl || bgShorthandUrl
    if (url) {
      urls.add(url)
      imgBoxes.push({ box: b, url, prop: bgImgUrl ? 'backgroundImage' : 'background' })
    }
  }
  if (!urls.size && !refImg) return { total: 0, saved: 0, cdn: 0, alipic: 0, cropped: 0, compositeIcons: 0, placeholders: 0, failed: [] }

  const dir = join(outDir, 'assets')
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'manifest.json')
  const store = manifestByUrl ?? new Map()
  if (!store.size && existsSync(manifestPath)) {
    try {
      for (const item of JSON.parse(readFileSync(manifestPath, 'utf8'))) {
        if (!item?.url || !item?.file) continue
        const absFile = join(outDir, item.file)
        if (!existsSync(absFile)) continue
        if (!item.pxWidth || !item.pxHeight || item.blank === undefined) {
          try {
            const rawBuf = readFileSync(absFile)
            const dims = imageDimensions(rawBuf)
            if (dims) {
              item.pxWidth = dims.width
              item.pxHeight = dims.height
              // 写盘时只在空白图画 blank:true；读回时补 blank:false 会让 manifest 每次重跑都变（不幂等）
              const blank = isBlankIconPng(rawBuf, dims)
              if (blank) item.blank = true
              else delete item.blank
            }
          } catch { /* 忽略 */ }
        }
        if (item.blank === false) delete item.blank
        store.set(item.url, item)
      }
    } catch { /* 旧 manifest 损坏时重建 */ }
  }

  const failedByUrl = new Map()
  const todoUrls = [...urls].filter((u) => !store.has(u))
  for (let i = 0; i < todoUrls.length; i += 6) {
    await Promise.all(todoUrls.slice(i, i + 6).map(async (url) => {
      const ext = (/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.exec(url)?.[1] ?? 'png').toLowerCase().replace('jpeg', 'jpg')
      const name = createHash('sha1').update(url).digest('hex').slice(0, 10) + '.' + ext
      let lastErr = ''
      let host = ''
      try { host = new URL(url).host } catch { host = '' }

      if (host && !deadHosts.has(host)) {
        try {
          const buf = await getBinary(url, cookie, 8_000)
          writeFileSync(join(dir, name), buf)
          const dims = imageDimensions(buf)
          const blank = isBlankIconPng(buf, dims)
          store.set(url, {
            url,
            file: `assets/${name}`,
            bytes: buf.length,
            ...(dims ? { pxWidth: dims.width, pxHeight: dims.height } : {}),
            ...(blank ? { blank: true } : { tint: iconTint(buf, dims) }),
            source: 'cdn',
          })
          return
        } catch (e) {
          lastErr = String(e.message ?? e)
          deadHosts.add(host)
        }
      } else if (host) {
        lastErr = `${host} 已熔断`
      }

      const mirror = toAlipicMirror(url)
      if (mirror && !deadHosts.has('alipic.lanhuapp.com')) {
        try {
          const buf = await getBinary(mirror, cookie, 12_000)
          writeFileSync(join(dir, name), buf)
          const dims = imageDimensions(buf)
          const blank = isBlankIconPng(buf, dims)
          store.set(url, {
            url,
            mirror,
            file: `assets/${name}`,
            bytes: buf.length,
            ...(dims ? { pxWidth: dims.width, pxHeight: dims.height } : {}),
            ...(blank ? { blank: true } : { tint: iconTint(buf, dims) }),
            source: 'alipic',
          })
          return
        } catch (e) {
          lastErr = String(e.message ?? e)
          if (!/^HTTP \d{3}\b/i.test(lastErr)) deadHosts.add('alipic.lanhuapp.com')
        }
      }

      failedByUrl.set(url, lastErr || '下载失败')
    }))
  }

  const textRects = [...compiled.boxes.values()]
    .filter((b) => b.type === 'lanhutext' && b.text?.trim())
    .map((b) => b.raw)

  let cdn = 0
  let alipic = 0
  let cropped = 0
  let compositeIcons = 0
  let placeholders = 0
  const failed = []
  // 同一张图可能被多个节点引用：计数按 URL 去重，否则「CDN 直下 56」与磁盘 22 个文件对不上
  const countedUrls = new Set()

  const applyLocalUrl = (b, prop, localFile) => {
    if (prop === 'background' && b.css.background) {
      b.css.background = String(b.css.background).replace(CSS_URL_RE, `url("./${localFile}")`)
    } else {
      b.css.backgroundImage = `url("./${localFile}")`
    }
  }

  const stripDeadUrl = (b, prop) => {
    if (prop === 'background' && b.css.background) {
      const stripped = String(b.css.background).replace(CSS_URL_RE, '').trim()
      if (!stripped || /^(no-repeat|repeat|center|cover|contain|\d+%|\s)+$/i.test(stripped)) delete b.css.background
      else b.css.background = stripped
    }
    delete b.css.backgroundImage
  }

  for (const { box: b, url, prop } of imgBoxes) {
    const hit = store.get(url)
    if (hit) {
      applyLocalUrl(b, prop, hit.file)
      b.asset = {
        status: 'ok',
        file: hit.file,
        source: hit.source,
        pxWidth: hit.pxWidth,
        pxHeight: hit.pxHeight,
        bytes: hit.bytes,
        tint: hit.tint,
        ...(hit.blank ? { blank: true } : {}),
      }
      if (!countedUrls.has(url)) {
        countedUrls.add(url)
        if (hit.source === 'alipic') alipic++
        else cdn++
      }
      continue
    }
    const errMsg = failedByUrl.get(url) ?? '下载失败'
    if (refImg && b.raw.w >= 2 && b.raw.h >= 2 && !overlapsText(b.raw, textRects)) {
      try {
        const cropBuf = encodePng(cropPng(refImg, b.raw))
        const cropName = `crop-s${compiled.screenIndex}-${b.idx}-${createHash('sha1').update(url).digest('hex').slice(0, 6)}.png`
        writeFileSync(join(dir, cropName), cropBuf)
        const file = `assets/${cropName}`
        store.set(`${url}#s${compiled.screenIndex}-${b.idx}`, {
          url,
          file,
          bytes: cropBuf.length,
          pxWidth: b.raw.w,
          pxHeight: b.raw.h,
          source: 'cropped-from-reference',
        })
        applyLocalUrl(b, prop, file)
        b.asset = { status: 'ok', file, source: 'cropped-from-reference', pxWidth: b.raw.w, pxHeight: b.raw.h, bytes: cropBuf.length }
        if (!countedUrls.has(url)) { countedUrls.add(url); cropped++ }
        continue
      } catch { /* 裁剪异常退回占位 */ }
    }
    stripDeadUrl(b, prop)
    // 拉不到图 ≠ 文字压在图上：真实原因要分开写，否则模型拿到「文字叠加」会放弃本来能用的切图
    const overlapped = overlapsText(b.raw, textRects)
    b.asset = { status: 'placeholder', reason: overlapped ? 'overlaid-by-text' : 'download-failed', error: errMsg }
    if (!countedUrls.has(url)) { countedUrls.add(url); placeholders++ }
    failed.push({ url, node: b.name, error: errMsg, reason: b.asset.reason })
  }

  // 预裁 Figma 拆碎的组合小图标（如 CSS 描边矩形 + 半截切图拼成的入口小图标）
  const matchedCompositeNodes = new Set()
  const hasMatchedAncestor = (b) => {
    let p = b.parentNode
    while (p) {
      if (matchedCompositeNodes.has(p)) return true
      p = compiled.boxes.get(p)?.parentNode ?? null
    }
    return false
  }
  for (const [node, b] of compiled.boxes) {
    if (chrome.skipNodeSet.has(node) || hasMatchedAncestor(b) || !isCompositeIconContainer(b, compiled.boxes)) continue
    matchedCompositeNodes.add(node)
    if (refImg && !overlapsText(b.raw, textRects)) {
      try {
        const compBuf = encodePng(cropPng(refImg, b.raw))
        const compName = `composite-s${compiled.screenIndex}-${b.name}.png`
        const file = `assets/${compName}`
        writeFileSync(join(dir, compName), compBuf)
        const key = `composite://screen-${compiled.screenIndex}/${b.name}`
        const tint = iconTint(compBuf, { width: b.raw.w, height: b.raw.h })
        store.set(key, {
          url: key,
          file,
          bytes: compBuf.length,
          pxWidth: b.raw.w,
          pxHeight: b.raw.h,
          tint,
          source: 'composite-icon-crop',
        })
        b.compositeAsset = { file, pxWidth: b.raw.w, pxHeight: b.raw.h, bytes: compBuf.length, tint }
        compositeIcons++
        continue
      } catch { /* 退回纯标注 */ }
    }
    b.compositeHint = true
  }

  // 按 url 排序再落盘：并发下载的完成顺序不固定，不排序的话同一画布重跑 manifest 字节不一致
  writeFileSync(manifestPath, JSON.stringify([...store.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)), null, 2))
  const saved = cdn + alipic + cropped
  return { total: urls.size || imgBoxes.length, saved, cdn, alipic, cropped, compositeIcons, placeholders, failed }
}

/** 把整张画布裁出这一屏；支持传入 PNG Buffer 或已解码的图像对象以在多屏时复用解码结果。 */
export function cropScreenPng(refPngOrImg, screenRaw) {
  try {
    const img = Buffer.isBuffer(refPngOrImg) ? decodePng(refPngOrImg) : refPngOrImg
    if (!img?.data) return { error: '无效 PNG 数据' }
    return encodePng(cropPng(img, { x: screenRaw.x, y: screenRaw.y, w: screenRaw.w, h: screenRaw.h }))
  } catch (e) {
    return { error: String(e.message ?? e) }
  }
}
