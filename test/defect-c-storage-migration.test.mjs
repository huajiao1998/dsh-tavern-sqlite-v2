// 缺陷 C 修复验收：getStorageMigration 未被接管，已迁移档被误报 + 迁移按钮必然失败
//
// 现场（chat-muzd2bvc-go5gnx，该档目录只有 archive.db）：
//   · 作者 lib/domain/conversation-migration.js（**未被任何接缝改过**）：
//         L8  version.startsWith('native:') ? 'native' : 'legacy'
//         L18 store.migrateNative(id, { assertCanMigrate, onProgress })
//   · index.js 把**我们的** store 绑给了 createConversationMigration（S2(b) 后 chatJournalStore 即我们的 store）
//   · 我们的 version() 返回 'sqlite:gen:<n>'，且冻结导出面里没有 migrateNative
//     ⇒ 状态面板永久显示"本局使用旧格式…"；点迁移 ⇒ store.migrateNative is not a function
//
// 本测试跑的是**真作者源**（lib/domain/conversation-migration.js 逐字）＋ 我们的适配器。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { wrapAuthorMigrationStore } from '../lib/author-migration-adapter.js'
import { transformStorageIndex } from '../deploy/apply-seams.mjs'
import { describeSaveFormat, formatSaveResult } from '../lib/migration-ops.js'

const AUTHOR_ROOT = process.env.AUTHOR_TAVERN_PLUGIN
  || 'C:\\Users\\aoloong\\AppData\\Local\\DSH-Tavern\\data\\harness\\apps\\dsh-tavern\\tavern-plugin'

/** 从插件自带的 author-clean-images.json.gz 取一份**未装缝**的作者 index.js。 */
function loadCleanIndexSource(gzPath) {
  const payload = JSON.parse(gunzipSync(readFileSync(gzPath)).toString('utf8'))
  for (const tree of payload.trees) {
    const entry = tree.files && tree.files['tavern-plugin/lib/index.js']
    if (entry && entry.body !== null) {
      return { cleanIndexSource: Buffer.from(entry.body, 'base64').toString('utf8'), commit: tree.commit.slice(0, 8) }
    }
  }
  throw new Error('镜像集里没有 tavern-plugin/lib/index.js')
}

// ---------- ① 适配器本体（纯函数，不需要作者树） ----------

const stamps = {
  migrated: 'sqlite:gen:12',
  migratedEmpty: 'sqlite:gen:0:empty',
  legacy: 'legacy:1234567:9876543210',
  missing: '',
}

/** 我们 store 的同形替身：值域与 chat-sqlite-store.js 的 version() 一致。 */
function ourStore(overrides = {}) {
  const calls = { version: [], migrateNative: [], reads: [] }
  return {
    version: async chatId => { calls.version.push(chatId); return overrides.stamp },
    read: async chatId => { calls.reads.push(chatId); return { id: chatId } },
    async remove(chatId) { calls.reads.push('remove:' + chatId); return overrides.stamp },
    _calls: calls,
  }
}

test('适配：archive.db 在位 ⇒ 对作者报 native（状态面板不再误显"旧格式"）', async () => {
  const wrapped = wrapAuthorMigrationStore(ourStore({ stamp: stamps.migrated }))
  assert.equal(await wrapped.version('c1'), 'native:sqlite:gen:12')
  assert.equal(String(await wrapped.version('c1')).startsWith('native:'), true)
})

test('适配：空档 sqlite:gen:0:empty 也算已迁移（否则同样被误判成 legacy）', async () => {
  const wrapped = wrapAuthorMigrationStore(ourStore({ stamp: stamps.migratedEmpty }))
  assert.equal(String(await wrapped.version('c1')).startsWith('native:'), true)
})

test('适配：legacy 原档原样透传（作者对它判 legacy 本来就是对的）', async () => {
  const wrapped = wrapAuthorMigrationStore(ourStore({ stamp: stamps.legacy }))
  assert.equal(await wrapped.version('c1'), stamps.legacy)
})

test('适配：找不到档仍是空串（作者 status 会抛"找不到当前存档"）', async () => {
  const wrapped = wrapAuthorMigrationStore(ourStore({ stamp: stamps.missing }))
  assert.equal(await wrapped.version('c1'), '')
})

test('适配：migrateNative 零写入 —— 已迁移档返回完成、legacy 原档抛 EXPLICIT_FORK_REQUIRED', async () => {
  const migrated = wrapAuthorMigrationStore(ourStore({ stamp: stamps.migrated }))
  assert.deepEqual(await migrated.migrateNative('c1', {}), { status: 'native', chatId: 'c1', stamp: stamps.migrated })

  const legacy = wrapAuthorMigrationStore(ourStore({ stamp: stamps.legacy }))
  await assert.rejects(() => legacy.migrateNative('c1', {}), error => {
    assert.equal(error.code, 'DSH_TAVERN_EXPLICIT_FORK_REQUIRED')
    assert.equal(error.chatId, 'c1')
    assert.match(String(error.message), /显式分叉/)
    return true
  })
})

test('适配：legacy 原档的拒绝走作者 assertIdle 门（本轮忙时不谈迁移）', async () => {
  const seen = []
  const store = ourStore({ stamp: stamps.legacy })
  const wrapped = wrapAuthorMigrationStore(store)
  await assert.rejects(() => wrapped.migrateNative('c1', { assertCanMigrate: chat => seen.push(chat) }),
    error => error.code === 'DSH_TAVERN_EXPLICIT_FORK_REQUIRED')
  assert.deepEqual(seen, [{ id: 'c1' }], '必须先把作者 chat 交给 assertIdle 再拒绝')
})

test('适配：只覆盖 version/migrateNative，其它方法原样透传（不复制实现）', async () => {
  const source = ourStore({ stamp: stamps.migrated })
  const wrapped = wrapAuthorMigrationStore(source)
  assert.equal(typeof wrapped.read, 'function')
  assert.equal(typeof wrapped.remove, 'function')
  assert.deepEqual(await wrapped.read('c1'), { id: 'c1' }, 'read 必须是同一个实现（透传，不是包装副本）')
  assert.equal(wrapped.version !== source.version, true)
})

test('适配：缺 version() 的 store 构造期就拒绝（不把未知 storage 当原生）', () => {
  assert.throws(() => wrapAuthorMigrationStore({}), /version\(\)/)
  assert.throws(() => wrapAuthorMigrationStore(null), /version\(\)/)
})

test('我们自己的值域判据完全不受影响（describeSaveFormat 仍认 sqlite:gen:）', async () => {
  const ours = ourStore({ stamp: stamps.migrated })
  const format = await describeSaveFormat({ chats: ours, chatId: 'c1' })
  assert.deepEqual(format, { migrated: true, legacy: false, readonly: false, playable: true, stamp: stamps.migrated })
  assert.equal(formatSaveResult(format), '已使用数据库存档')
})

// ---------- ② 接缝 S2(d) 落在真作者 index.js 上 ----------

function authorIndexSource() {
  return readFileSync(AUTHOR_ROOT + '\\lib\\index.js', 'utf8')
}

test('接缝：幂等 —— 对已装缝的 index.js 二次应用不变', () => {
  const once = transformStorageIndex(authorIndexSource())
  assert.equal(transformStorageIndex(once), once, 'S2 系列必须幂等')
})

test('接缝：从**干净作者源**（镜像回放）出发也能装出 S2(d)', t => {
  const gzPath = process.env.AUTHOR_CLEAN_IMAGES
  if (!gzPath || !existsSync(gzPath)) return t.skip('未提供 AUTHOR_CLEAN_IMAGES（镜像集只在已安装插件里）')
  const { cleanIndexSource } = loadCleanIndexSource(gzPath)
  const patched = transformStorageIndex(cleanIndexSource)
  assert.match(patched, /import \{ createChatSqliteStore, wrapAuthorMigrationStore \} from '\.\/domain\/chat-sqlite-store\.js'/)
  assert.match(patched, /const authorMigrationStore = wrapAuthorMigrationStore\(chatJournalStore\)/)
  assert.match(patched, /const conversationMigration = createConversationMigration\(\{\s*store: authorMigrationStore/)
  // 二次应用仍幂等
  assert.equal(transformStorageIndex(patched), patched)
})

test('接缝：作者源缺 createConversationMigration 绑定 ⇒ 响亮拒绝（不静默跳过）', () => {
  const clean = authorIndexSource()
    .replace('const conversationMigration = createConversationMigration({', 'const conversationMigration = createConversationMigrationMissing({')
  assert.throws(() => transformStorageIndex(clean), /S2\(d\)/)
})
