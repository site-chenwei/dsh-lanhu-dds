/** 本机数据目录：Cookie（唯一存放点）、按会话隔离的产物目录。 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, chmodSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------- Cookie

/**
 * Cookie 只存一个地方：<DATA_HOME>/cookie（默认 ~/.dsh-lanhu-dds/cookie，0600）。
 * 不读环境变量、不读 .env —— 只有一个位置，有没有、失没失效，看这一个文件就够。
 */
/** 根目录：Cookie 常驻，产物与临时脚本按会话分目录。不往项目里写。 */
export const DATA_HOME = process.env.DSH_LANHU_DDS_HOME || join(homedir(), '.dsh-lanhu-dds')
export const COOKIE_FILE = join(DATA_HOME, 'cookie')
export const SESSIONS_DIR = join(DATA_HOME, 'sessions')

/**
 * 会话键：显式指定 > DSH 会话 id（exec.agent.id）> 环境变量 > 按当前目录的短哈希。
 * 拿不到会话 id 时用 cwd 哈希，让同一项目的多次运行复用同一个会话目录。
 */
export function sessionKey(explicit, exec) {
  // 显式名保留成可读的 slug；DSH 会话 id 形如 session-<uuid>，去掉前缀只留 12 位十六进制
  if (explicit) {
    const name = String(explicit).replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 24)
    if (name) return name
  }
  const derived = exec?.agent?.id || process.env.DSH_SESSION_ID
  if (derived) {
    const key = String(derived).replace(/^session-/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
    if (key) return key
  }
  return `cli-${createHash('sha1').update(resolve(process.cwd())).digest('hex').slice(0, 6)}`
}

export function sessionDir(explicit, exec) {
  return join(SESSIONS_DIR, sessionKey(explicit, exec))
}

/** 该会话的临时脚本目录（存在即建好）。 */
export function sessionTmp(explicit, exec) {
  const dir = join(sessionDir(explicit, exec), 'tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 清掉 N 天没动过的会话目录。 */
export function pruneSessions({ days = 7 } = {}) {
  const cutoff = Date.now() - days * 86400000
  const removed = []
  let entries = []
  try {
    entries = readdirSync(SESSIONS_DIR, { withFileTypes: true })
  } catch {
    return { ok: true, days, removed, kept: 0 }
  }
  const kept = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = join(SESSIONS_DIR, e.name)
    if (statSync(dir).mtimeMs >= cutoff) {
      kept.push(e.name)
      continue
    }
    rmSync(dir, { recursive: true, force: true })
    removed.push(e.name)
  }
  return { ok: true, days, removed, kept: kept.length }
}

export function readCookie() {
  try {
    return readFileSync(COOKIE_FILE, 'utf8').trim()
  } catch {
    return ''
  }
}

export function saveCookie(value) {
  const v = String(value ?? '').trim()
  if (!v) return { ok: false, error: '空值不保存' }
  mkdirSync(dirname(COOKIE_FILE), { recursive: true })
  writeFileSync(COOKIE_FILE, v + '\n', { mode: 0o600 })
  try {
    chmodSync(COOKIE_FILE, 0o600)
  } catch {
    // Windows 上 chmod 基本是空操作
  }
  return { ok: true, path: COOKIE_FILE }
}

export function forgetCookie() {
  try {
    rmSync(COOKIE_FILE, { force: true })
    return { ok: true, removed: COOKIE_FILE }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

// ---------------------------------------------------------------- 产物目录

/** 中间产物统一落在 <工作目录>/.lanhu-dds/ 下，不散落。 */
export const OUT_ROOT = '.lanhu-dds'

export function resolveOutDir(out, { name = '', imageId = '', session, exec } = {}) {
  const base = sessionDir(session, exec)
  mkdirSync(base, { recursive: true })
  const safe = (v) => String(v || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (out) {
    const sub = String(out).trim()
    if (/[\\/]/.test(sub) || sub === '..' || sub === '.') {
      throw new Error(`out 只能是会话目录下的一层目录名，不能带路径：${sub}`)
    }
    return join(base, safe(sub) || safe(name) || 'design')
  }
  const slug = safe(name) || 'design'
  const id = String(imageId || '').slice(0, 8)
  return join(base, id ? `${slug}-${id}` : slug)
}
