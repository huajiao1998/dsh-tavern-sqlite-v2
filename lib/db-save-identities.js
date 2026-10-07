// DB交换只改结构化身份/资源字段；正文、变量值、anchor与脚本字符串原样保留。
import { randomUUID } from 'node:crypto'
const ID = /^[a-zA-Z0-9_-]{1,160}$/
export function saveId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw Error('DB存档身份无效')
  return value
}
const SESSION_KEYS = new Set(['sessionId', 'foregroundSessionId', 'traceSessionId', 'traceSessionIds', 'backgroundHistoryIds', 'startedSessionId', 'backgroundSessionId', 'parentSessionId', 'parentSession'])
const TEXT_KEYS = new Set(['text', 'sourceText', 'rawText', 'message', 'content', 'anchor', 'tree', 'variables', 'tavernHelperScriptVariables', 'tavernScriptPrompts', 'cardDefinitionSnapshot', 'runtimePresetSnapshot', 'openingWorldbookSnapshot', 'snapshot'])
export function ownedSaveSessions(chat) {
  saveId(chat.id); saveId(chat.sessionId)
  if (!['story', 'script'].includes(chat.mode || 'story')) throw Error('只有游玩DB档可交换')
  if (chat.rollbackPending || chat.regenInProgress || chat.regenRecovery || chat.settleStatus === 'running' || chat.settleStatus === 'pending' || chat.messages?.some(row => row?.mvu?.pending)) throw Error('本局尚未静止，不能导出DB存档')
  const ids = new Set([chat.sessionId])
  const add = id => { if (id) ids.add(saveId(id)) }
  add(chat.backgroundSessionId)
  for (const id of chat.backgroundHistoryIds || []) add(id)
  add(chat.candidates?.traceSessionId)
  for (const id of chat.candidates?.traceSessionIds || []) add(id)
  for (const participant of Object.values(chat.timeline?.participants || {})) add(participant?.sessionId)
  for (const checkpoint of chat.timeline?.checkpoints || []) {
    for (const participant of Object.values(checkpoint.participants || {})) add(participant?.sessionId)
    for (const id of Object.keys(checkpoint.sessionCuts || {})) add(id)
  }
  for (const cut of Object.values(chat.rollbackSessionCuts || {})) for (const id of Object.keys(cut || {})) add(id)
  // 操作只可引用本局已确认的参与者/回退会话，不把任意外部trace纳入闭包。
  for (const operation of Object.values(chat.timeline?.operations || {})) {
    if (operation.status === 'running' || operation.status === 'pending') throw Error('本局后台任务尚未完成')
    if (operation.sessionId && !ids.has(operation.sessionId)) throw Error('后台操作缺少确切本局会话归属')
  }
  if (ids.size > 64) throw Error('本局原生会话超出DB包上限')
  return [...ids]
}
export function saveIdentityMap(chat, ids, newId = () => 'session-' + randomUUID()) {
  const sessions = new Map(ids.map(id => [saveId(id), saveId(newId())]))
  if (sessions.size !== ids.length || [...sessions.values()].some(id => ids.includes(id)) || !sessions.has(chat.sessionId) || new Set(sessions.values()).size !== sessions.size) throw Error('DB导入会话身份映射冲突')
  const chatId = 'chat-' + randomUUID()
  const branchId = randomUUID()
  return { chatId, sessionId: sessions.get(chat.sessionId), sessions, branchId }
}
// 该遍历只用于运行元数据，不用于剧情正文/变量快照/原生消息内容。
export function rewriteSaveMetadata(value, sourceChat, identity, key = '') {
  if (TEXT_KEYS.has(key)) return structuredClone(value)
  if (Array.isArray(value)) return value.map(child => rewriteSaveMetadata(child, sourceChat, identity, key))
  if (!value || typeof value !== 'object') {
    if (SESSION_KEYS.has(key) && value) {
      if (!identity.sessions.has(value)) throw Error('DB存档含闭包外会话引用：' + key)
      return identity.sessions.get(value)
    }
    if (key === 'chatId' && value === sourceChat.id) return identity.chatId
    if (key === 'branchId' && value === sourceChat.timeline?.branchId) return identity.branchId
    return value
  }
  const out = Object.create(null)
  for (const [field, child] of Object.entries(value)) {
    if (field === 'rollbackSessionCuts' || field === 'sessionCuts') {
      const cutsFor = cuts => Object.fromEntries(Object.entries(cuts || {}).map(([id, boundary]) => {
        if (!identity.sessions.has(id) || !Number.isSafeInteger(boundary) || boundary < -1) throw Error('DB存档回退边界无效')
        return [identity.sessions.get(id), boundary]
      }))
      out[field] = field === 'sessionCuts' ? cutsFor(child) : Object.fromEntries(Object.entries(child || {}).map(([turn, cuts]) => {
        if (!/^[1-9]\d*$/.test(turn)) throw Error('DB存档回退会话边界键无效')
        return [turn, cutsFor(cuts)]
      }))
    } else out[field] = rewriteSaveMetadata(child, sourceChat, identity, field)
  }
  return out
}
export function rewriteSaveTables(tables, sourceChat, identity, { cardPath, cwd } = {}) {
  const out = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.map(row => ({ ...row }))]))
  if (out.archive_head_fields) {
    // 自含快照的源局可能已无库卡路径；目标新卡路径必须进入SQL头，而非只改已有键。
    if (cardPath && !out.archive_head_fields.some(row => row.key === 'cardPath')) out.archive_head_fields.push({ key: 'cardPath', ord: out.archive_head_fields.length, kind: 0, value_json: JSON.stringify(cardPath) })
    for (const row of out.archive_head_fields) {
      if (row.value_json === null) continue
      let value = JSON.parse(row.value_json)
      if (row.key === 'id') value = identity.chatId
      else if (row.key === 'sessionId') value = identity.sessionId
      else if (row.key === 'cardPath' && cardPath) value = cardPath
      else if (row.key === 'rollbackSessionCuts' || row.key === 'sessionCuts') {
        // 逐键SQL头部不带外层字段名，补回字段上下文才能命中专用边界映射。
        value = rewriteSaveMetadata({ [row.key]: value }, sourceChat, identity)[row.key]
      } else value = rewriteSaveMetadata(value, sourceChat, identity, row.key)
      row.value_json = JSON.stringify(value)
    }
    for (const row of out.archive_timeline_nodes || []) row.value_json = JSON.stringify(rewriteSaveMetadata(JSON.parse(row.value_json), sourceChat, identity))
    for (const row of out.archive_messages || []) {
      const value = JSON.parse(row.message_json)
      row.message_json = JSON.stringify(rewriteSaveMetadata(value, sourceChat, identity))
    }
  }
  if (out.sessions) {
    for (const row of out.sessions) {
      const id = identity.sessions.get(row.id)
      if (!id) throw Error('DB会话不在导入闭包')
      row.id = id
      row.header_json = JSON.stringify({ ...rewriteSaveMetadata(JSON.parse(row.header_json), sourceChat, identity), id, cwd })
    }
    // 原生事件正文/工具参数是原始模型上下文，不做任何字符串替换。
    // 有路径/外部Session依赖的事件必须由宿主严格解码检查，不能猜字段递归替换。
    out.meta = [{ key: 'schema_version', value: '1' }]
  }
  return out
}
