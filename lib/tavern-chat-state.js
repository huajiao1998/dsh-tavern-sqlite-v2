// 酒馆「档 ↔ 会话」状态：供**开始轮次拦截**（def-migration-vs-fork §4.1「可看不可玩」）与
// host-actions 的"会话→档"反查共用。**零依赖**（只读文件），因此会话后端（index.js）也能用。
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { legacyBindingForSession } from './legacy-bindings.js'

/** 酒馆数据根：优先 profile 清单里作者安装器写的 `dshTavern.dataRoot`（权威），否则按约定推。 */
export function tavernDataRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern')
  try {
    const manifest = JSON.parse(readFileSync(path.join(home, 'profiles', 'tavern', 'package.json'), 'utf8'))
    const declared = manifest?.dshTavern?.dataRoot
    if (typeof declared === 'string' && declared !== '') return declared
  } catch { /* 清单缺失时退回约定路径 */ }
  return path.join(home, 'profile-data', 'tavern', 'data')
}

// sessionId → chatId 链接表（`<dataRoot>/sessions.json`，作者 conversation registry 的权威映射）。
// 5 秒缓存：链接表很小但写路径是热路径，不做每次都读盘。
let linkCache = { at: 0, root: '', map: new Map() }

export function linkMap() {
  const root = tavernDataRoot()
  const now = Date.now()
  if (linkCache.root === root && now - linkCache.at < 5000) return linkCache.map
  const map = new Map()
  try {
    const raw = JSON.parse(readFileSync(path.join(root, 'sessions.json'), 'utf8'))
    for (const [sessionId, chatId] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (typeof sessionId === 'string' && typeof chatId === 'string' && chatId !== '') map.set(sessionId, chatId)
    }
  } catch { /* 没有链接表 ⇒ 该会话不是酒馆对话 */ }
  linkCache = { at: now, root, map }
  return map
}

/** 作者已有明确链接的原档 Session：只查精确 Chat 承载，不扫描正文或推断/写入绑定。 */
export function listLinkedLegacySessionIds() {
  const result = []
  for (const [sessionId, chatId] of linkMap()) {
    // 项目禁令对象在任何原档存在性检查之前排除；目录列表也不得触碰它。
    if (chatId === 'chat-mu0rqvmu-ji0z6a') continue
    if (!/^session-[A-Za-z0-9_-]+$/.test(sessionId) || !/^chat-[A-Za-z0-9_-]+$/.test(chatId)) continue
    if (hasLegacyArtifact(chatId)) result.push(sessionId)
  }
  return result
}

/** 会话 → 档 id（拿不到返回 ''）。比"逐个读档比对 chat.sessionId"便宜得多（只读 ~900 字节的链接表）。 */
export function chatIdForSession(sessionId) {
  const id = String(sessionId || '')
  return id === '' ? '' : (legacyBindingForSession(id)?.chatId || linkMap().get(id) || '')
}

/** 档是否已迁到数据库存档（`chats/<chatId>/archive.db` 在位）。 */
export function isChatMigrated(chatId, root = tavernDataRoot()) {
  return chatId !== '' && !hasLegacyArtifact(chatId, root) && existsSync(path.join(root, 'chats', chatId, 'archive.db'))
}

/** 档是否存在**原档承载**：上游块布局 `chats/<id>/head.json`、journal 承载
 *  `chats/<id>/{snapshots,journals}`、内容寻址 `blocks/**` 或 journal 单文件 `chats/<id>.json`。 */
export function hasLegacyArtifact(chatId, root = tavernDataRoot()) {
  if (chatId === '') return false
  if (existsSync(path.join(root, 'chats', chatId, 'head.json'))) return true
  if (existsSync(path.join(root, 'chats', chatId + '.json'))) return true
  const dir = path.join(root, 'chats', chatId)
  return existsSync(path.join(dir, 'snapshots')) || existsSync(path.join(dir, 'journals')) || existsSync(path.join(dir, 'blocks'))
}

/** §4.2 第 3 条的文案（发送处阻断要指向按钮，而不是只报错）。 */
export const UNMIGRATED_MESSAGE = '本局是只读原存档，不能直接游玩或修改。请到「酒馆状态」的存档区域点「分叉迁移到数据库存档」，创建独立数据库分叉后继续。'

export function isLegacySession(sessionId) {
  if (legacyBindingForSession(String(sessionId || ''))) return true
  const chatId = chatIdForSession(sessionId)
  return hasLegacyArtifact(chatId)
}

export function assertLegacySessionWritable(sessionId) {
  if (!isLegacySession(sessionId)) return
  const error = new Error(UNMIGRATED_MESSAGE)
  error.code = 'DSH_TAVERN_LEGACY_READ_ONLY'
  throw error
}

/**
 * §4.1：**开始轮次前**必须过这道门 —— 未迁移档「可看不可玩」。
 *
 * 为什么拦在"开始轮次之前"而不是 chat-store 的写层：那里**会话回合事件已经落库**，
 * 拦下来会留半状态（会话推进了、档没动）。这里在 turn/start 落库之前抛，LLM 调用也不会发生。
 *
 * 放行条件（任一）：不是酒馆会话 / 档已迁移 / 档根本不存在（交给上层自己报错）。
 */
export function assertPlayable(sessionId) {
  assertLegacySessionWritable(sessionId)
}
