// 作者对话迁移（getStorageMigration / migrateStorage RPC）↔ 我们 SQLite store 的**契约适配**
// （缺陷 C：已迁移档被误报成"本局使用旧格式"，迁移按钮必然失败）。
//
// 为什么必须有这一层
//   · 作者的 `lib/domain/conversation-migration.js` **没有被任何接缝改过**（镜像集里没有它，
//     作者树全树扫 `[dsh-tavern-*:v*]` 标记也没有它）⇒ 跑的是作者的原始判据：
//         L8   version.startsWith('native:') ? 'native' : 'legacy'
//         L18  store.migrateNative(id, { assertCanMigrate, onProgress })
//   · 而 `index.js:3175`（作者代码）把这个 store 绑给了 `createConversationMigration`：
//         const conversationMigration = createConversationMigration({ store: chatJournalStore, ... })
//     经 S2(b) 后 `chatJournalStore` 就是**我们**的 store（chat-sqlite-store.js）。
//   · 我们 store 的值域（lib/migration-ops.js L13-14/58-59）是
//         ''                        —— 没有 db 也没有 legacy 承载
//         'legacy:<size>:<mtimeNs>' —— 原档（journal 单文件 / 上游块布局 head.json），只读不可玩
//         'sqlite:gen:<n>[:empty]'  —— 我们的 archive.db 在位
//     **没有** `native:` 前缀；`chat-sqlite-store.js` 的冻结导出面里也**没有** `migrateNative`
//     /`migrateCompatibility`/`restoreLegacy`（作者自己的 chat-journal-store.js:901/927/960 有）。
//   ⇒ 现场：分叉出来的 SQLite 档 version() 返回 `sqlite:gen:<n>`，被作者判成 `legacy`
//     ⇒ 状态面板永久显示"本局使用旧格式…"；点"迁移旧存档" → `store.migrateNative is not a function`。
//
// 做法：只给**迁移这一个绑定**包一层作者契约，**绝不动**我们自己的 `version()`。
//   version() 的值域被 `isOurStamp()`/`describeSaveFormat()`（分叉、守卫、`legacy-view-seams`
//   的 createLegacySaveActions）以及 store 内部 `generationStamp()` 的状态缓存键共同依赖，
//   换成 native: 前缀会连带破坏那一整套判据。适配器只把 `sqlite:gen:*` 翻译成作者认的
//   `native:`，把 `legacy:*` 原样透传（作者对它的 legacy 判据本来就是对的）。
//
// 同 ID 原地迁移已永久废除（lib/migration-ops.js L63-69 无论如何抛
// DSH_TAVERN_EXPLICIT_FORK_REQUIRED，注释写明"任何情况下都不写"）⇒ 对 legacy 原档，
// 这里同样响亮拒绝，并把显式分叉的指引交给作者 job runner 显示在面板上；
// 已经是我们 SQLite 档时返回 `{status:'native'}`（"本来就是原生档"，不是失败）。

const SQLITE_STAMP = /^sqlite:gen:\d+(?::empty)?$/

/** 我们 store 的值域里，"已经是 SQLite 存档"的那一种。 */
function isSqliteStamp(stamp) { return SQLITE_STAMP.test(stamp) }

/**
 * 给作者 `createConversationMigration({ store })` 包一层作者存储契约。
 * 其余方法原样透传（读/写/version 语义不变），只覆盖 `version` 与补一个 `migrateNative`。
 * @param store - 我们的聊天存储接口（必须实现 version(chatId)）
 */
export function wrapAuthorMigrationStore(store) {
  if (!store || typeof store.version !== 'function') {
    throw new Error('wrapAuthorMigrationStore：store 缺少 version()（作者对话迁移需要读存档版本）')
  }
  return Object.freeze({
    ...store,
    async version(chatId) {
      const stamp = String((await store.version(chatId)) ?? '')
      // 我们的 archive.db 在位 ⇒ 对作者就是"已迁移的原生存档"。
      if (isSqliteStamp(stamp)) return 'native:' + stamp
      // 原档（journal 单文件 / 上游块布局）⇒ 仍是 legacy，作者"本局使用旧格式"的判据正确。
      return stamp
    },
    async migrateNative(chatId, options = {}) {
      const stamp = String((await store.version(chatId)) ?? '')
      if (stamp === '') throw new Error('找不到当前存档')
      if (!isSqliteStamp(stamp)) {
        // 与作者自己的 assertIdle 语义一致：忙时不谈迁移，忙完再谈。
        if (typeof options.assertCanMigrate === 'function') options.assertCanMigrate(await readForAssertIdle(store, chatId))
        const error = new Error('已废除同 ID 原地迁移：原档可看不可玩；请使用显式分叉迁移流程，创建独立的新 SQLite 存档后再游玩（原档不改动）')
        error.code = 'DSH_TAVERN_EXPLICIT_FORK_REQUIRED'
        error.chatId = chatId
        error.stamp = stamp
        throw error
      }
      // 已经是我们的 SQLite 档：没有可迁移的东西，报"完成"而不是失败。
      if (typeof options.onProgress === 'function') options.onProgress('completed')
      return { status: 'native', chatId, stamp }
    },
  })
}

// 作者的 assertIdle 只有一个入参（chat）；这里不改它的签名，只在能取到时取。
async function readForAssertIdle(store, chatId) {
  if (typeof store.read !== 'function') return chatId
  try { return await store.read(chatId) } catch { return chatId }
}
