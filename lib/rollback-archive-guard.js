// 精确绑定既有archive，不扫描存档；跨库完成意图是写屏障唯一成功判据。
import {DatabaseSync} from 'node:sqlite'
import {isAbsolute} from 'node:path'
export function assertRollbackArchiveWritable(file) {
  if(!file || !isAbsolute(file))throw new Error('Session回退archive绑定路径无效')
  const db=new DatabaseSync(file,{readOnly:true})
  try {
    const row=db.prepare("SELECT value_json FROM archive_head_fields WHERE key='rollbackPending'").get()
    if(row?.value_json && JSON.parse(row.value_json))throw new Error('物理回退未完成，archive禁止Session追加事件，请先重试回退')
    const owner=db.prepare("SELECT value_json FROM archive_head_fields WHERE key='sessionId'").get()
    return owner?.value_json ? JSON.parse(owner.value_json) : undefined
  } finally { db.close() }
}
export function validateRollbackArchive(file) {
  assertRollbackArchiveWritable(file)
  return file
}
