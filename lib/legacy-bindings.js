// 原档逻辑绑定仅存插件自己的 SQLite 表；不改作者 chat/links/index 或原生日志。
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function legacyBindingsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-tavern')
  return path.join(home, 'profile-data', 'tavern', 'storages', 'tavern-sqlite-bindings.db')
}

function rowBinding(row) {
  return row ? { chatId: row.chat_id, sessionId: row.session_id, originalSessionId: row.original_session_id, artifactPath: row.artifact_path } : undefined
}

function readBindings(query, ...args) {
  const file = legacyBindingsPath()
  if (!existsSync(file)) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try { return db.prepare(query).all(...args).map(rowBinding) }
  finally { db.close() }
}

export function listLegacyBindings() {
  return readBindings('SELECT * FROM legacy_bindings ORDER BY chat_id')
}

export function legacyBindingForChat(chatId) {
  return readBindings('SELECT * FROM legacy_bindings WHERE chat_id = ?', String(chatId || ''))[0]
}

export function legacyBindingForSession(sessionId) {
  return readBindings('SELECT * FROM legacy_bindings WHERE session_id = ? OR original_session_id = ?', String(sessionId || ''), String(sessionId || ''))[0]
}

// 只供显式部署修复；只读查看没有配置写入或自动推断扫描。
export function setLegacyBinding({ chatId, sessionId, originalSessionId = '', artifactPath }) {
  if (!/^chat-[A-Za-z0-9_-]+$/.test(chatId) || !/^session-[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('原档绑定身份无效')
  if (!path.isAbsolute(artifactPath) || !existsSync(artifactPath)) throw new Error('原档绑定必须指向现存绝对路径')
  const file = legacyBindingsPath()
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS legacy_bindings (chat_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE, original_session_id TEXT NOT NULL, artifact_path TEXT NOT NULL)')
    db.prepare('INSERT INTO legacy_bindings VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET session_id=excluded.session_id, original_session_id=excluded.original_session_id, artifact_path=excluded.artifact_path').run(chatId, sessionId, originalSessionId, artifactPath)
  } finally { db.close() }
  return legacyBindingForChat(chatId)
}

export function overlayLegacyLinks(links) {
  const result = { ...(links || {}) }
  for (const binding of listLegacyBindings()) {
    for (const [sessionId, chatId] of Object.entries(result)) if (chatId === binding.chatId) delete result[sessionId]
    result[binding.sessionId] = binding.chatId
  }
  return result
}

export function projectLegacyEnvelope(value) {
  if (!value || typeof value !== 'object') return value
  if (value.chat && typeof value.chat === 'object') {
    const chat = projectLegacyEnvelope(value.chat)
    return chat === value.chat ? value : { ...value, chat }
  }
  const binding = legacyBindingForChat(value.id)
  return binding && value.sessionId !== binding.sessionId ? { ...value, sessionId: binding.sessionId } : value
}
