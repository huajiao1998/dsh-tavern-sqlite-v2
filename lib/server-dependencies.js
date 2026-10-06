// 标准服务端执行的依赖组装；仅生产shim加载，纯DI测试不要求第三方模块。
// **依赖来自包内 vendor**（见 lib/vendor/VENDOR.md）：安装零外部依赖，任何宿主都能离线安装。
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const vendor = name => path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor', name)
export function serverLodash() { return require(vendor('lodash/lodash.min.js')) }
export function serverYaml() { return require(vendor('yaml/dist/index.js')) }

// 卡脚本DOM标记属于插件元数据；SQLite替代旧整份JSON+延时写，关闭时无残留计时器。
export function createServerDispatchStore({ dataRoot } = {}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new Error('卡脚本标记库必须明确指定绝对数据路径')
  const file = path.join(dataRoot, 'storage-server-dispatch.db')
  let db, closed = false
  function open(create = false) {
    if (closed) throw new Error('卡脚本标记库已释放')
    if (db) return db
    if (!create && !existsSync(file)) return null
    mkdirSync(path.dirname(file), { recursive: true })
    db = new DatabaseSync(file)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS dispatch_marks(card_path TEXT NOT NULL,script_id TEXT NOT NULL,content TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(card_path,script_id,content))')
    return db
  }
  function lookup(cardPath, id, content) {
    const row = open()?.prepare('SELECT reason FROM dispatch_marks WHERE card_path=? AND script_id=? AND content=?').get(String(cardPath), String(id), String(content))
    return row ? { class: 'browser-ui', reason: row.reason } : null
  }
  function mark(cardPath, id, content, reason) {
    open(true).prepare('INSERT INTO dispatch_marks(card_path,script_id,content,reason) VALUES(?,?,?,?) ON CONFLICT(card_path,script_id,content) DO UPDATE SET reason=excluded.reason').run(String(cardPath), String(id), String(content), String(reason))
  }
  return Object.freeze({
    lookupCard: cardPath => lookup(cardPath, '', ''),
    markCard: (cardPath, reason) => mark(cardPath, '', '', reason),
    lookupScript: (cardPath, id, content) => lookup(cardPath, id, content),
    markScript: mark,
    dispose() { if (closed) return; closed = true; db?.close(); db = undefined },
  })
}
