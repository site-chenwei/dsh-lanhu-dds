/** 蓝湖接口：解析设计图链接、取版本信息与 DDS 布局树、下载二进制。 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const LANHU = 'https://lanhuapp.com'
export const DDS = 'https://dds.lanhuapp.com'

// ---------------------------------------------------------------- 网络

export async function getJson(url, cookie, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: referer ?? `${LANHU}/`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}\n${text.slice(0, 400)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${url} → 非 JSON 响应\n${text.slice(0, 400)}`)
  }
}

export async function getBinary(url, cookie, timeoutMs = 120_000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: `${LANHU}/`, ...(cookie ? { Cookie: cookie } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error(`下载返回空内容 (0B): ${url}`)
  return buf
}

/** 内网常拦截 lanhu-oss-*.lanhuapp.com，改写到同源镜像 alipic.lanhuapp.com（需带 Cookie + Referer）可拿到逐字节一致的切图。 */
export function toAlipicMirror(url) {
  return /^https?:\/\/lanhu-oss-[^/]+\.lanhuapp\.com\//i.test(String(url ?? ''))
    ? String(url).replace(/^https?:\/\/lanhu-oss-[^/]+\.lanhuapp\.com\//i, 'https://alipic.lanhuapp.com/')
    : null
}

/** 从蓝湖链接里抠出 project_id / image_id / team_id。支持 hash 路由与 query 两种写法。 */
export function parseLanhuUrl(input) {
  const hashQuery = input.includes('#') ? input.slice(input.indexOf('#') + 1) : ''
  const tail = hashQuery.includes('?') ? hashQuery.slice(hashQuery.indexOf('?') + 1) : hashQuery
  const sp = new URLSearchParams(tail)
  const q = new URLSearchParams(input.includes('?') ? input.slice(input.indexOf('?') + 1) : '')
  const pick = (k) => sp.get(k) || q.get(k)
  const projectId = pick('project_id') || pick('pid')
  const imageId = pick('image_id') || pick('imageId')
  const teamId = pick('tid') || pick('team_id')
  if (!imageId) throw new Error('链接里没有 image_id：请用「设计图详情」页的链接（不是 PRD/项目首页链接）。')
  if (!projectId) throw new Error('链接里没有 project_id / pid。')
  return { projectId, imageId, teamId }
}

/** 取设计图版本信息：参考图直链、画布尺寸、缩放比。 */
export async function resolveImage({ projectId, imageId, teamId, cookie }) {
  const qs = new URLSearchParams({ project_id: projectId, image_id: imageId, dds_status: '1' })
  if (teamId) qs.set('team_id', teamId)
  const json = await getJson(`${LANHU}/api/project/image?${qs}`, cookie)
  const result = json.result ?? json.data
  if (!result) throw new Error(`project/image 响应缺 result：${JSON.stringify(json).slice(0, 300)}`)
  const versions = result.versions ?? []
  const dds = versions.find((v) => v.type === 'dds' || v.d2c_url || v.json_url) ?? versions[0]
  if (!dds) throw new Error('该设计图没有可用版本（versions 为空）。')
  const meta = (result.meta ?? {}) || {}
  const scaleMeta = meta.scaleMetadata ?? meta.scale_metadata ?? {}
  const device = String(scaleMeta.device ?? meta.device ?? '')
  let scale = Number(scaleMeta.sliceScale ?? scaleMeta.slice_scale ?? 0) || 0
  if (!scale) {
    const m = device.match(/@\s*(\d(?:\.\d+)?)x/i)
    scale = m ? Number(m[1]) : 2
  }
  const referenceUrl = String(dds.url ?? '').replace(/([?&])x-oss-process=[^&]*/g, '$1').replace(/[?&]$/, '')
  return {
    versionId: dds.id,
    referenceUrl,
    width: Number(dds.width ?? 0),
    height: Number(dds.height ?? 0),
    scale,
    device,
    name: result.name ?? result.image_name ?? '',
    sourceType: result.source_type ?? meta.sourceType ?? '',
    allVersions: versions.map((v) => ({ id: v.id, type: v.type, width: v.width, height: v.height, url: v.url })),
  }
}

/** 取 DDS 布局树。只要 Cookie，不需要 Authorization，也不需要浏览器。 */
export async function fetchDds({ versionId, cookie }) {
  if (!cookie) {
    throw new Error(
      '拉取 DDS 需要蓝湖 Cookie。' +
        '拿法：浏览器登录蓝湖 → F12 → Network → 任一 lanhuapp.com 请求 → 复制完整 Cookie 请求头。'
    )
  }
  const meta = await getJson(`${DDS}/api/dds/image/store_schema_revise?version_id=${encodeURIComponent(versionId)}`, cookie, `${DDS}/`)
  if (String(meta.code ?? '') !== '00000') {
    throw new Error(
      `DDS 接口返回 code=${meta.code} ${meta.message ?? ''}（Cookie 过期，或当前账号没有该设计图权限；重新取一份 Cookie 再来）`
    )
  }
  const url = meta.data?.data_resource_url
  if (!url) throw new Error(`DDS 接口没有 data_resource_url：${JSON.stringify(meta).slice(0, 300)}`)
  const tree = await getJson(url, cookie, `${DDS}/`)
  return tree?.children ? tree : (tree?.data ?? tree)
}
