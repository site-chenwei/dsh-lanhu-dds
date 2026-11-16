/**
 * 极简 PNG 编解码：只做「裁一张设计稿」这一件事。
 * 支持 8bit 非隔行的 RGB / RGBA / 灰度 / 灰度+alpha，其余位深/隔行直接报错交给上层降级。
 * 不引第三方包，是因为内网 Windows 装不了 sharp/canvas。
 */

import { inflateSync, deflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG（签名不符）')
  const chunks = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    chunks.push({ type, data })
    off += 12 + len
    if (type === 'IEND') break
  }
  return chunks
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** 解码成 { width, height, channels, data: Uint8Array }（已反滤子）。 */
export function decodePng(buf) {
  const chunks = readChunks(buf)
  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (!ihdr) throw new Error('PNG 缺 IHDR')
  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const interlace = ihdr.data[12]
  if (bitDepth !== 8) throw new Error(`仅支持 8bit PNG，实际 ${bitDepth}bit`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = CHANNELS[colorType]
  if (!channels) throw new Error(`不支持的 PNG colorType=${colorType}`)

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  const raw = inflateSync(idat)
  const stride = width * channels
  const out = new Uint8Array(stride * height)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev ? prev[x] : 0
      const c = prev && x >= channels ? prev[x - channels] : 0
      let v = line[x]
      switch (filter) {
        case 0: break
        case 1: v += a; break
        case 2: v += b; break
        case 3: v += (a + b) >> 1; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
        default: throw new Error(`未知 PNG 行过滤类型 ${filter}`)
      }
      cur[x] = v & 0xff
    }
  }
  return { width, height, channels, data: out }
}

function crc32(buf) {
  let c
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function encodePng({ width, height, channels, data }) {
  const colorType = channels === 4 ? 6 : channels === 3 ? 2 : channels === 2 ? 4 : 0
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  const stride = width * channels
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 裁一块矩形（设备像素坐标），越界部分补白。 */
export function cropPng(img, rect) {
  const { x, y, w, h } = rect
  const cw = Math.max(1, Math.round(w))
  const chh = Math.max(1, Math.round(h))
  const out = new Uint8Array(cw * chh * img.channels)
  for (let row = 0; row < chh; row++) {
    const sy = Math.round(y) + row
    for (let col = 0; col < cw; col++) {
      const sx = Math.round(x) + col
      const di = (row * cw + col) * img.channels
      if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) {
        for (let c = 0; c < img.channels; c++) out[di + c] = c === img.channels - 1 ? 255 : 255
        continue
      }
      const si = (sy * img.width + sx) * img.channels
      for (let c = 0; c < img.channels; c++) out[di + c] = img.data[si + c]
    }
  }
  return { width: cw, height: chh, channels: img.channels, data: out }
}
