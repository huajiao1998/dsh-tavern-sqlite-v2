// 阶段③：只保留**纯业务 transform**（无 fs / 无 manifest / 无备份 / 无 CLI / 无 __main__ 入口）。
// 唯一导出 transformStorageIndex；消费者（主）按 `transformLegacyIndex(transformStorageIndex(raw))` 组成统一 host before-base。
// S1/S2 三处装配语义（保持作者原参数不变，只在外面套一层）：
//   S2(a) 补 chat-sqlite-store 的 import；
//   S2(b) 作者 store 保留作 legacy 读源 + 我们的 SQLite store 叠在上面；
//   S2(c) flushMaintenance 指向作者 store（加存在性守卫）；
//   S2(d) 作者 createConversationMigration 的 store 换成**作者存储契约**的适配器
//         （缺陷 C：作者的 conversation-migration.js 只认 native: 前缀 + migrateNative()，
//          而我们的 store 是 sqlite:gen: 值域且没有 migrateNative ⇒ 已迁移档被误报成
//          "本局使用旧格式"、迁移按钮必然 TypeError）；
//   S1   在 createChatPersistence(...) 之后 ctx.provide('tavernChats', chatPersistence)。
function fail(message) { throw new Error(message) }

/** 在 `callStart` 起的配对括号内，把唯一出现的 `from` 替换成 `to`（不越界、不改调用体其它部分）。 */
function replaceInsideCall(text, callStart, from, to, label) {
  let i = text.indexOf('(', callStart)
  if (i < 0) fail(label + '：找不到调用左括号')
  let depth = 0
  let end = -1
  for (; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') { depth -= 1; if (depth === 0) { end = i; break } }
  }
  if (end < 0) fail(label + '：括号不平衡')
  const body = text.slice(callStart, end)
  if (body.split(from).length !== 2) fail(label + '：锚点未命中或不唯一：' + from)
  return text.slice(0, callStart) + body.replace(from, to) + text.slice(end)
}

// ---------- S2 三处装配（保持作者原参数不变，只在外面套一层） ----------
function patchIndex(text, changes) {
  let next = text
  // (a) 导入
  if (!next.includes("from './domain/chat-sqlite-store.js'")) {
    const anchor = "import { createChatJournalStore } from './domain/chat-journal-store.js'\n"
    if (!next.includes(anchor)) fail('S2(a)：找不到 createChatJournalStore 的 import 锚点（上游可能改了导入形态）')
    next = next.replace(anchor, anchor + "import { createChatSqliteStore } from './domain/chat-sqlite-store.js'\n")
    changes.push('S2(a) 加 chat-sqlite-store 的 import')
  }
  // (a2) 同一模块再导入作者迁移契约适配器（S2(d) 用；幂等 —— 已含即跳过）
  if (!next.includes('wrapAuthorMigrationStore')) {
    const anchor = "import { createChatSqliteStore } from './domain/chat-sqlite-store.js'\n"
    if (!next.includes(anchor)) fail('S2(a2)：找不到 chat-sqlite-store 的 import 锚点（S2(a) 应先装）')
    next = next.replace(anchor, "import { createChatSqliteStore, wrapAuthorMigrationStore } from './domain/chat-sqlite-store.js'\n")
    changes.push('S2(a2) 加 wrapAuthorMigrationStore 的 import')
  }
  // (b) 作者 store 保留作 legacy 读源 + 我们的 store 叠在上面（**原选项整段保留**）
  if (!(next.includes('createChatSqliteStore(') && next.includes('legacyStore'))) {
    const rx = /^([ \t]*)const chatJournalStore = createChatJournalStore\(\{([\s\S]*?)\}\)[ \t]*$/m
    const hit = rx.exec(next)
    if (!hit) fail('S2(b)：找不到 `const chatJournalStore = createChatJournalStore({ … })` 锚点')
    const indent = hit[1]
    const options = hit[2]
    const replacement = [
      `${indent}// [dsh-tavern-sqlite-v2] 作者原存储**保留**：上游块布局 / journal 单文件的读源与维护者（我们只读它）`,
      `${indent}const authorChatStore = createChatJournalStore({${options}})`,
      `${indent}// [dsh-tavern-sqlite-v2] 我们的行级 SQLite store 叠在上面：写入走 archive.db，未迁移档的读取（含块布局）交给作者 store`,
      `${indent}const chatJournalStore = createChatSqliteStore({ dataRoot, legacyData: profileData, legacyStore: authorChatStore, now: Date.now, logger: console })`,
    ].join('\n')
    next = next.replace(rx, replacement)
    changes.push('S2(b) 装配改为「作者 store（legacy 读源）+ 我们的 SQLite store」')
  }
  // (d) 作者对话迁移绑定改用**作者存储契约**的适配器（缺陷 C）。
  //     独立生效、独立幂等：老装机可能已装 S2(b) 但没有 (d)，必须能只补这一处。
  if (!next.includes('authorMigrationStore')) {
    const migrationCall = 'const conversationMigration = createConversationMigration({'
    const migrationAt = next.indexOf(migrationCall)
    if (migrationAt < 0) fail('S2(d)：找不到 `const conversationMigration = createConversationMigration({` 锚点（上游可能改了布局）')
    next = replaceInsideCall(next, migrationAt, 'store: chatJournalStore', 'store: authorMigrationStore', 'S2(d)')
    const rxBind = /^([ \t]*)(const chatJournalStore = createChatSqliteStore\([^\n]*\))[ \t]*$/m
    const bindHit = rxBind.exec(next)
    if (!bindHit) fail('S2(d)：找不到 `const chatJournalStore = createChatSqliteStore(…)` 装配行')
    next = next.replace(rxBind, [
      bindHit[1] + bindHit[2],
      `${bindHit[1]}// [dsh-tavern-sqlite-v2] 作者对话迁移（getStorageMigration/migrateStorage）需要**作者存储契约**：`,
      `${bindHit[1]}//   version() 以 native: 前缀表"已迁移" + migrateNative()。我们的 store 是 sqlite:gen: 值域且没有`,
      `${bindHit[1]}//   migrateNative（作者 conversation-migration.js 未被接缝改过，仍是原始 native: 判据）⇒ 只给这`,
      `${bindHit[1]}//   一个绑定包一层适配器，绝不动我们自己的 version()（分叉/守卫/缓存键都依赖它）。`,
      `${bindHit[1]}const authorMigrationStore = wrapAuthorMigrationStore(chatJournalStore)`,
    ].join('\n'))
    changes.push('S2(d) 作者对话迁移的 store 包作者存储契约适配器')
  }
  // (c) 维护钩子指向作者 store
  if (!next.includes('authorChatStore.flushMaintenance')) {
    const rx = /^([ \t]*)ctx\.effect\(\(\) => \(\) => chatJournalStore\.flushMaintenance\(\), '([^']*)'\)[ \t]*$/m
    const hit = rx.exec(next)
    if (hit) {
      next = next.replace(rx, `${hit[1]}ctx.effect(() => () => { if (typeof authorChatStore.flushMaintenance === 'function') authorChatStore.flushMaintenance() }, '${hit[2]}')`)
      changes.push('S2(c) flushMaintenance 指向作者 store（加存在性守卫）')
    }
  }
  // S1：聊天存储接口暴露成服务（`/tavern-save`、变量面板要用）
  if (!(next.includes("ctx.provide('tavernChats'") || next.includes('ctx.provide("tavernChats"'))) {
    const start = next.indexOf('const chatPersistence = createChatPersistence(')
    if (start < 0) fail('S1：找不到 `const chatPersistence = createChatPersistence(` 锚点')
    let i = next.indexOf('(', start)
    let depth = 0
    let end = -1
    for (; i < next.length; i += 1) {
      const ch = next[i]
      if (ch === '(') depth += 1
      else if (ch === ')') { depth -= 1; if (depth === 0) { end = i; break } }
    }
    if (end < 0) fail('S1：createChatPersistence(...) 括号不平衡')
    const lineStart = next.lastIndexOf('\n', start) + 1
    const indent = next.slice(lineStart, start)
    const insertAt = next.indexOf('\n', end) + 1
    const block = [
      `${indent}// [dsh-tavern-sqlite-v2] 把聊天存储接口暴露给我们的插件（/tavern-save 命令与迁移面板要用）`,
      `${indent}ctx.provide('tavernChats', chatPersistence)`,
      '',
    ].join('\n')
    next = next.slice(0, insertAt) + block + next.slice(insertAt)
    changes.push('S1 暴露 tavernChats 服务（1 行）')
  }
  return next
}

/** 纯转换（首装预检与统一 host before-base 共用）：补足 S1/S2 锚点，不提前写作者树。 */
export function transformStorageIndex(source) { return patchIndex(source, []) }
