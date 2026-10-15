// iframe 诊断不是剧情前像；每面板一行，复用本档 archive.db 与写队列，不推动存档 revision。
import { stmt } from './statement-cache.js'

export const DISPLAY_RUNTIME_SQL = Object.freeze({
  archive_display_frames: `CREATE TABLE IF NOT EXISTS archive_display_frames (
    turn INTEGER NOT NULL, part_index INTEGER NOT NULL, panel_id TEXT NOT NULL,
    message_index INTEGER NOT NULL, source_activity_at INTEGER NOT NULL, frame_json TEXT NOT NULL,
    PRIMARY KEY(turn, part_index, panel_id)
  )`,
  archive_display_delete: `CREATE TRIGGER IF NOT EXISTS archive_display_delete AFTER DELETE ON archive_messages BEGIN
    DELETE FROM archive_display_frames WHERE message_index = OLD.message_index;
  END`,
  archive_display_replace: `CREATE TRIGGER IF NOT EXISTS archive_display_replace AFTER UPDATE OF message_json ON archive_messages
  WHEN json_extract(OLD.message_json,'$.text') IS NOT json_extract(NEW.message_json,'$.text')
    OR json_extract(OLD.message_json,'$.swipes') IS NOT json_extract(NEW.message_json,'$.swipes')
    OR json_extract(OLD.message_json,'$.swipeId') IS NOT json_extract(NEW.message_json,'$.swipeId')
    OR json_extract(OLD.message_json,'$.turn') IS NOT json_extract(NEW.message_json,'$.turn')
    OR (json_extract(OLD.message_json,'$.displayRuntime') IS NOT NULL AND json_extract(NEW.message_json,'$.displayRuntime') IS NULL)
  BEGIN DELETE FROM archive_display_frames WHERE message_index = OLD.message_index; END`,
})
export function ensureDisplayRuntimeTable(db) {
  for (const sql of Object.values(DISPLAY_RUNTIME_SQL)) db.exec(sql)
}

export function readDisplayRuntime(db, turn) {
  if (!db) return undefined
  const rows = stmt(db, 'SELECT source_activity_at,frame_json FROM archive_display_frames WHERE turn=? ORDER BY part_index,panel_id').all(turn)
  if (!rows.length) return undefined
  return { sourceActivityAt: Number(rows[0].source_activity_at), frames: rows.map(row => JSON.parse(row.frame_json)) }
}

export function recentDisplayRuntime(db) {
  if (!db) return {}
  const out = {}
  for (const row of stmt(db, 'SELECT DISTINCT turn FROM archive_display_frames ORDER BY turn').all()) out[String(row.turn)] = readDisplayRuntime(db, row.turn)
  return out
}

export function mergeDisplayFrame(db, chatId, turn, frame, options, assertWritable) {
  const { revision, messageIndex, sourceActivityAt = 0, seed = [] } = options || {}
  if (!Number.isSafeInteger(turn) || turn <= 0 || !Number.isSafeInteger(revision) || !Number.isSafeInteger(messageIndex) || messageIndex < 0) throw Error('iframe诊断缺少当前楼层/版本凭据')
  if (!frame || !Number.isSafeInteger(frame.partIndex) || frame.partIndex < 0 || typeof frame.panelId !== 'string') throw Error('iframe诊断面板身份非法')
  db.exec('BEGIN IMMEDIATE')
  try {
    assertWritable(chatId)
    const head = stmt(db, 'SELECT revision FROM archive_head WHERE id=1').get()
    const identity = stmt(db, "SELECT value_json FROM archive_head_fields WHERE key='id'").get()
    const row = stmt(db, 'SELECT message_json FROM archive_messages WHERE message_index=?').get(messageIndex)
    const message = row ? JSON.parse(row.message_json) : null
    if (!head || !identity || JSON.parse(identity.value_json) !== chatId || message?.role !== 'assistant' || Number(message.turn) !== turn) throw Error('iframe诊断目标已变化，拒绝迟到采集')
    if (Number(head.revision) !== revision) { db.exec('ROLLBACK'); return false }
    // 回退/换正文的SQL触发器已经清掉旧代；不能凭两面板同时读到的reset重复清空新代。
    const existing = readDisplayRuntime(db, turn)
    const at = existing?.sourceActivityAt || Math.max(0, Number(sourceActivityAt) || 0)
    const put = stmt(db, `INSERT INTO archive_display_frames(turn,part_index,panel_id,message_index,source_activity_at,frame_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(turn,part_index,panel_id) DO UPDATE SET message_index=excluded.message_index,source_activity_at=excluded.source_activity_at,frame_json=excluded.frame_json`)
    // 只在该轮尚无外置诊断时接纳旧版行内种子；当前面板总是覆盖同键种子。
    if (!existing) for (const item of Array.isArray(seed) ? seed : []) {
      if (Number.isSafeInteger(item?.partIndex) && typeof item?.panelId === 'string') put.run(turn, item.partIndex, item.panelId, messageIndex, at, JSON.stringify(item))
    }
    put.run(turn, frame.partIndex, frame.panelId, messageIndex, at, JSON.stringify(frame))
    stmt(db, 'DELETE FROM archive_display_frames WHERE turn NOT IN (SELECT DISTINCT turn FROM archive_display_frames ORDER BY turn DESC LIMIT 20)').run()
    db.exec('COMMIT')
    return true
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
