// 阶段③：只保留**纯业务 transform**（无 fs / 无 manifest / 无备份 / 无 CLI / 无 __main__ 入口）。
// 唯一导出 transformStorageIndex；消费者（主）按 `transformLegacyIndex(transformStorageIndex(raw))` 组成统一 host before-base。
// S1/S2 三处装配语义（保持作者原参数不变，只在外面套一层）：
//   S2(a) 补 chat-sqlite-store 的 import；
//   S2(b) 作者 store 保留作 legacy 读源 + 我们的 SQLite store 叠在上面；
//   S2(c) flushMaintenance 指向作者 store（加存在性守卫）；
//   S1   在 createChatPersistence(...) 之后 ctx.provide('tavernChats', chatPersistence)。
function fail(message) { throw new Error(message) }

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
