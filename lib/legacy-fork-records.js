// 原档手动分叉的持久去重记录：插件自有 SQLite，与 legacy_bindings **同库同路径**。
//
// 状态单调：claimed → bound → created → complete。**没有**自动 lease / 过期 / 回收 / reset，
// **没有** claimed/bound/created 的放行口：
//   · claimed —— 只表示"原生 fork 的 SID 回执未知"，**不保证没有 SID**（客户端可能在 fork 返回后
//     崩掉）。因此 claim 必须是"一次 native fork 之前"的独占占位：源档唯一记录，重复 claim 一律拒绝；
//     未知回执只能人工核实，本模块**不提供**任何自动/超时放行。
//   · bound —— 目标 SID 已 durable 冻结（chat 可能还没建）；此后只允许同一个 SID，换 SID 即拒。
//   · created —— 目标 chat 已落 SQLite；complete —— 标题已写、流程收口。
//   · complete → 删除（唯一显式出口，2026-10-01）：`releaseCompletedForkRecord`，由用户在
//     "目标 Chat 已被确证删除"时显式触发（服务端仍要用 DSH_TAVERN_SAVE_NOT_FOUND 再确证一次），
//     使源档可再次显式分叉（宿主分配新的 SID）。它只删精确一行，不是状态回退、也不是自动回收。
// 全部迁移用单条 SQL CAS；不引入跨进程锁/租约文件（SQLite 自带锁 + busy_timeout）。
//
// 并发作用域（明确不承诺的部分）：本模块只保证"源档唯一记录 + 状态单调 CAS"。**跨进程**（多实例同时写
// 同一 profile）不做承诺——completeFork 的"同 token 只跑一次"由 legacy-view-seams 的 service 实例内存表
// 保证（**只承诺单个 service 进程**）；bound/created 有助精确恢复，但不是跨进程原子建档保证。
//
// 读路径只容忍"表不存在"（老库/新库），**损坏或权限错误必须抛出**，不得静默吞掉。

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { legacyBindingsPath } from './legacy-bindings.js'

/** 唯一合法状态集（顺序即迁移方向）。 */
export const FORK_RECORD_STATES = Object.freeze(['claimed', 'bound', 'created', 'complete'])

// 与 lib/legacy-bindings.js 的 DDL 同形。新库必须同时具备两表：只建分叉表会让旧读路径
// （listLegacyBindings → 会话目录 list()/启动期 workspace 登记/原档读/写闸）在新 DB 上炸。
const BINDINGS_DDL = 'CREATE TABLE IF NOT EXISTS legacy_bindings (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, original_session_id TEXT NOT NULL, artifact_path TEXT NOT NULL)'
const FORKS_DDL = `CREATE TABLE IF NOT EXISTS legacy_fork_records (
  source_chat_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  at_seq INTEGER NOT NULL,
  target_title TEXT NOT NULL,
  token TEXT NOT NULL,
  state TEXT NOT NULL,
  target_session_id TEXT NOT NULL DEFAULT '',
  target_chat_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  claimed_at INTEGER NOT NULL,
  bound_at INTEGER,
  created_at INTEGER,
  completed_at INTEGER
)`

function str(value) { return value === undefined || value === null ? '' : String(value) }
function stamp(value) { const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : Date.now() }
function timeOf(value) { return value === undefined || value === null ? undefined : Number(value) }

function indexOf(value, label, minimum = 0) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error('分叉记录 ' + label + ' 不是合法整数：' + String(value))
  return number
}

function forkRecordError(code, message, extra = {}) {
  const error = new Error(message)
  error.code = code
  for (const [key, value] of Object.entries(extra)) error[key] = value
  return error
}

function isMissingTable(error) { return /no such table/i.test(String(error?.message ?? error)) }

function rowToRecord(row) {
  if (!row) return undefined
  const state = str(row.state)
  if (!FORK_RECORD_STATES.includes(state)) throw new Error('分叉记录状态无效：' + JSON.stringify(state))
  return Object.freeze({
    sourceChatId: str(row.source_chat_id), sourceSessionId: str(row.source_session_id),
    sourceRevision: Number(row.source_revision), turn: Number(row.turn), atSeq: Number(row.at_seq),
    targetTitle: str(row.target_title), token: str(row.token), state,
    targetSessionId: str(row.target_session_id), targetChatId: str(row.target_chat_id), title: str(row.title),
    claimedAt: Number(row.claimed_at), boundAt: timeOf(row.bound_at), createdAt: timeOf(row.created_at), completedAt: timeOf(row.completed_at)
  })
}

function readRow(db, chatId) {
  return rowToRecord(db.prepare('SELECT * FROM legacy_fork_records WHERE source_chat_id = ?').get(chatId))
}

/** 写路径：懒建两表（含 legacy_bindings，见文件头），显式事务内执行迁移 CAS。 */
function withWrite(work) {
  const file = legacyBindingsPath()
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 2000')
    db.exec(BINDINGS_DDL)
    db.exec(FORKS_DDL)
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* 以原始失败为准 */ }
      throw error
    }
  } finally { db.close() }
}

/** 读本源档的分叉记录；库/表不存在 → undefined；损坏或权限错误 → 抛。 */
export function readForkRecord(sourceChatId) {
  const chatId = str(sourceChatId)
  if (chatId === '') return undefined
  const file = legacyBindingsPath()
  if (!existsSync(file)) return undefined
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    try { return readRow(db, chatId) } catch (error) {
      if (isMissingTable(error)) return undefined
      throw error
    }
  } finally { db.close() }
}

/**
 * 一次 native fork 之前的独占占位。源档已有任何记录（claimed/bound/created/complete）一律拒绝。
 * token 由服务端生成，仅保存在记录里、由 claim 的返回值交给调用方。
 */
export function claimForkRecord({ sourceChatId, sourceSessionId, sourceRevision, turn, atSeq, targetTitle, now } = {}) {
  const chatId = str(sourceChatId)
  const sessionId = str(sourceSessionId)
  if (chatId === '' || sessionId === '') throw new Error('分叉记录缺少源档身份')
  const title = str(targetTitle)
  if (title === '') throw new Error('分叉记录缺少目标标题')
  const record = {
    sourceRevision: indexOf(sourceRevision, 'sourceRevision'),
    turn: indexOf(turn, 'turn', 1),
    atSeq: indexOf(atSeq, 'atSeq'),
    claimedAt: stamp(now)
  }
  const token = randomUUID()
  return withWrite(db => {
    const changes = db.prepare('INSERT INTO legacy_fork_records (source_chat_id, source_session_id, source_revision, turn, at_seq, target_title, token, state, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'claimed\', ?) ON CONFLICT(source_chat_id) DO NOTHING')
      .run(chatId, sessionId, record.sourceRevision, record.turn, record.atSeq, title, token, record.claimedAt).changes
    const stored = readRow(db, chatId)
    if (changes === 0 || stored === undefined) {
      throw forkRecordError('DSH_TAVERN_FORK_RECORD_EXISTS', '本源档已有分叉记录（' + str(stored?.state) + '），拒绝再次 claim；禁止重复分叉', {
        state: stored?.state, targetChatId: stored?.targetChatId, targetSessionId: stored?.targetSessionId
      })
    }
    return { record: stored, changed: true, token }
  })
}

function requireRecordForToken(db, chatId, token) {
  const stored = readRow(db, chatId)
  if (stored === undefined) throw forkRecordError('DSH_TAVERN_FORK_RECORD_MISSING', '找不到本源档的分叉记录，请重新准备')
  if (stored.token !== token) {
    throw forkRecordError('DSH_TAVERN_FORK_TOKEN_MISMATCH', '分叉记录 token 不一致，拒绝写入（记录已被另一次分叉占用）', {
      state: stored.state, targetChatId: stored.targetChatId, targetSessionId: stored.targetSessionId
    })
  }
  return stored
}

/** claimed → bound：**永久冻结**目标 SID。同 token 同 SID 幂等复用；换 SID 即拒。 */
export function bindForkRecord({ sourceChatId, token, targetSessionId, now } = {}) {
  const chatId = str(sourceChatId)
  const claimToken = str(token)
  const target = str(targetSessionId)
  if (chatId === '' || claimToken === '' || target === '') throw new Error('分叉绑定缺少源档/token/目标 SID')
  return withWrite(db => {
    const at = stamp(now)
    const changes = db.prepare("UPDATE legacy_fork_records SET state='bound', target_session_id=?, bound_at=? WHERE source_chat_id=? AND token=? AND state='claimed'")
      .run(target, at, chatId, claimToken).changes
    const stored = requireRecordForToken(db, chatId, claimToken)
    if (changes === 1) return { record: stored, changed: true }
    if (stored.state === 'claimed') throw forkRecordError('DSH_TAVERN_FORK_STATE_CONFLICT', '分叉记录状态竞态（claimed 未能绑定），拒绝继续', { state: stored.state })
    if (stored.targetSessionId !== target) {
      throw forkRecordError('DSH_TAVERN_FORK_TARGET_FROZEN', '本源档的目标 SID 已冻结为其他会话，拒绝改用新 SID', {
        state: stored.state, targetSessionId: stored.targetSessionId, targetChatId: stored.targetChatId
      })
    }
    return { record: stored, changed: false }
  })
}

/** bound → created：持久记录目标 chat。重复调用（同目标）幂等。 */
export function markForkRecordCreated({ sourceChatId, token, targetSessionId, targetChatId, now } = {}) {
  const chatId = str(sourceChatId)
  const claimToken = str(token)
  const target = str(targetSessionId)
  const targetChat = str(targetChatId)
  if (chatId === '' || claimToken === '' || target === '' || targetChat === '') throw new Error('分叉 created 记录缺少源档/token/目标 SID/目标 chat')
  return withWrite(db => {
    const changes = db.prepare("UPDATE legacy_fork_records SET state='created', target_chat_id=?, created_at=? WHERE source_chat_id=? AND token=? AND state='bound' AND target_session_id=?")
      .run(targetChat, stamp(now), chatId, claimToken, target).changes
    const stored = requireRecordForToken(db, chatId, claimToken)
    if (changes === 1) return { record: stored, changed: true }
    if (stored.targetSessionId !== target || stored.targetChatId !== targetChat) {
      throw forkRecordError('DSH_TAVERN_FORK_CREATED_CONFLICT', '分叉记录已持久化其他目标，拒绝改写', {
        state: stored.state, targetSessionId: stored.targetSessionId, targetChatId: stored.targetChatId
      })
    }
    if (stored.state === 'created' || stored.state === 'complete') return { record: stored, changed: false }
    throw forkRecordError('DSH_TAVERN_FORK_STATE_CONFLICT', '分叉记录状态不是 bound，拒绝标记 created', { state: stored.state })
  })
}

/** created → complete：记录已接受的标题并收口。重复调用幂等（保留首个标题）。 */
export function finishForkRecord({ sourceChatId, token, title, now } = {}) {
  const chatId = str(sourceChatId)
  const claimToken = str(token)
  const accepted = str(title)
  if (chatId === '' || claimToken === '' || accepted === '') throw new Error('分叉完成记录缺少源档/token/标题')
  return withWrite(db => {
    const changes = db.prepare("UPDATE legacy_fork_records SET state='complete', title=?, completed_at=? WHERE source_chat_id=? AND token=? AND state='created'")
      .run(accepted, stamp(now), chatId, claimToken).changes
    const stored = requireRecordForToken(db, chatId, claimToken)
    if (changes === 1) return { record: stored, changed: true }
    if (stored.state === 'complete') return { record: stored, changed: false }
    throw forkRecordError('DSH_TAVERN_FORK_STATE_CONFLICT', '分叉记录状态不是 created，拒绝收口', { state: stored.state })
  })
}

/**
 * complete → 无记录：**唯一**的显式释放（用户点「重新创建」时清理已完成的精确关系）。
 *
 * 为什么需要它（2026-10-01 实测）：目标 Chat 被用户删除后，关系行仍是 complete ⇒ status 继续
 * 报 forked=true、按钮永久禁用、无法重建。释放后源档可再次显式分叉（宿主会分配**新的** SID）。
 *
 * 边界（与"未知回执不自动释放"一致，逐条硬判，任一不满足即拒）：
 *   · 只接受 `complete`；claimed（SID 回执未知）/bound（SID 已冻结）/created 一律拒绝 —— 未知不是"不存在"；
 *   · targetChatId / targetSessionId 必须与记录逐字段一致（陈旧 UI 不得删掉别的、更新的关系）；
 *   · **目标 Chat 是否真已不存在由 service 用 `DSH_TAVERN_SAVE_NOT_FOUND` 确证**，本函数只做记录 CAS；
 *   · 单条 SQL CAS（source + token + complete + 目标二字段），changes 必须为 1 且事务内重读为空；
 *   · 不删原生会话、不动 legacy_bindings、不改源档（本模块只碰 legacy_fork_records）。
 */
export function releaseCompletedForkRecord({ sourceChatId, targetChatId, targetSessionId } = {}) {
  const chatId = str(sourceChatId)
  const targetChat = str(targetChatId)
  const targetSession = str(targetSessionId)
  if (chatId === '' || targetChat === '' || targetSession === '') {
    throw new Error('释放完成关系缺少源档/targetChatId/targetSessionId')
  }
  return withWrite(db => {
    const stored = readRow(db, chatId)
    if (stored === undefined) {
      throw forkRecordError('DSH_TAVERN_FORK_RECORD_MISSING', '找不到本源档的分叉记录，无需释放', {})
    }
    if (stored.state !== 'complete') {
      throw forkRecordError('DSH_TAVERN_FORK_RELEASE_NOT_COMPLETE',
        '分叉记录状态是 ' + stored.state + '，不是 complete，拒绝释放（未知/未完成回执必须人工核实，禁止自动重置）',
        { state: stored.state, targetChatId: stored.targetChatId, targetSessionId: stored.targetSessionId })
    }
    if (stored.targetChatId !== targetChat || stored.targetSessionId !== targetSession) {
      throw forkRecordError('DSH_TAVERN_FORK_RELEASE_TARGET_MISMATCH', '释放参数与记录里的目标不一致，拒绝释放',
        { state: stored.state, targetChatId: stored.targetChatId, targetSessionId: stored.targetSessionId })
    }
    const changes = db.prepare("DELETE FROM legacy_fork_records WHERE source_chat_id=? AND token=? AND state='complete' AND target_chat_id=? AND target_session_id=?")
      .run(chatId, stored.token, targetChat, targetSession).changes
    const left = readRow(db, chatId)
    if (changes !== 1 || left !== undefined) {
      throw forkRecordError('DSH_TAVERN_FORK_RELEASE_CONFLICT', '释放完成关系未生效（记录被并发改动），已回滚',
        { state: left?.state, targetChatId: left?.targetChatId, targetSessionId: left?.targetSessionId })
    }
    return { record: stored, removed: stored, changed: true }
  })
}

/** 注入 legacy-view-seams 的服务依赖：{ read, claim, bind, created, finish, release }。 */
export function createForkRecords() {
  return Object.freeze({
    read: readForkRecord, claim: claimForkRecord, bind: bindForkRecord,
    created: markForkRecordCreated, finish: finishForkRecord, release: releaseCompletedForkRecord
  })
}
