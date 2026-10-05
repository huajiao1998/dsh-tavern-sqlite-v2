// 对账脚本：查看某档的 SQLite 变量存储状态（第一阶段验收用）
// 用法：node verify-variable-store.mjs <chatId> [chatsRoot]
// 路径说明：本脚本随包走（test/ 下），store 在包根 ⇒ 用 ../ 相对路径。
// （2026-09-30 拉进包时这里写死了 lab 绝对路径 /root/e2e-lab/... ⇒ 本机必然找不到；已修正。）
import { createVariableSqliteStore } from '../variable-sqlite-store.js'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

const [chatId, chatsRootArg] = process.argv.slice(2)
if (!chatId) { console.error('用法: node verify-variable-store.mjs <chatId> [chatsRoot]'); process.exit(2) }
const chatsRoot = chatsRootArg || '/root/.dsh-tavern/profile-data/tavern/data/chats'

const store = createVariableSqliteStore({ chatsRoot })
const sqlite = store.has(chatId) ? store.stats(chatId) : null
console.log('=== SQLite (variables.db) ===')
console.log(sqlite ? JSON.stringify(sqlite, null, 2) : '（无库——该档尚未结算或未迁移）')

// JSON 侧：物化最新快照，统计变量树的楼数与字节
const dir = path.join(chatsRoot, chatId)
try {
  const names = (await readdir(path.join(dir, 'snapshots'))).filter(n => /^\d{12}\.json(\.gz)?$/.test(n)).sort()
  const latest = names.at(-1)
  if (latest) {
    const raw = await readFile(path.join(dir, 'snapshots', latest))
    const chat = JSON.parse(latest.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8'))
    let treeFloors = 0, treeBytes = 0, baselineFloors = 0, baselineBytes = 0
    for (const message of chat.messages || []) {
      if (Array.isArray(message.variables)) {
        for (const tree of message.variables) {
          if (tree && typeof tree === 'object' && tree.stat_data !== undefined) { treeFloors++; treeBytes += JSON.stringify(tree).length }
        }
      }
      if (message.mvuBaseline?.variables) { baselineFloors++; baselineBytes += JSON.stringify(message.mvuBaseline.variables).length }
    }
    const { stat: _stat, ...headBytes } = { stat: 0 }
    console.log('=== JSON（最新快照', latest, '）===')
    console.log(JSON.stringify({
      storageRevision: chat._storageRevision,
      messageCount: (chat.messages || []).length,
      variableTreeFloors: treeFloors, variableTreeBytes: treeBytes,
      mvuBaselineFloors: baselineFloors, mvuBaselineBytes: baselineBytes,
      suppressedDshTurns: chat.suppressedDshTurns || [],
      rollbackUndoReady: chat.rollbackUndo?.ready ?? null
    }, null, 2))
  }
} catch (error) { console.warn('JSON 侧读取失败:', error.message) }
// 档目录体积
let total = 0
try {
  const { execSync } = await import('node:child_process')
  total = Number(execSync('du -sb ' + JSON.stringify(dir)).toString().split('\t')[0])
  console.log('=== 档目录总大小:', (total / 1024 / 1024).toFixed(2), 'MB ===')
} catch {}
store.dispose()
