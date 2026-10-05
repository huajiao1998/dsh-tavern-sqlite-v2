// 存档格式判定与共用文案：原档只读，必须由用户显式分叉为新 SQLite 档才能游玩。
//
//   · status 仅调用注入的 chats.version，不读取或更新原档。
//   · legacy stamp 的身份优先于同 ID 数据库残留，由 store 的 version 统一保证。
//   · migrate 名称保留用于兼容旧调用者，但旧同 ID 迁移入口一律响亮拒绝。
//   · 手动分叉编排只由 legacy-view-seams 的 createLegacySaveActions 实现；这里不造第二份。
//
// 依赖由调用方注入，本模块不创建第二个存储实例，也绝不调用 chats.update。

/** 存档动作名（命令/工具共用）。 */
export const SAVE_ACTIONS = ['status', 'migrate']

function isLegacyStamp(stamp) {
  return typeof stamp === 'string' && /^legacy:\d+:\d+$/.test(stamp)
}

/**
 * 这个 stamp 是不是**我们 SQLite store** 的语义？
 *   我们 store 的 version() 只有三种值：
 *     ''                         —— 该 chatId 既没有 db 也没有任何 legacy 承载（= 找不到这个档）
 *     'legacy:<size>:<mtimeNs>'  —— 原档存在（journal 单文件 或 块布局 head.json），只读不可玩
 *     'sqlite:gen:<n>[:empty]'   —— 我们的 archive.db 在位
 *
 * ⚠ 为什么必须有这一层：`tavernChats` 是"注入的接口"，**不保证**底下是我们的 store
 *   （只打 expose-chats 缝、没换 chat-sqlite-store 时，底下就是作者的原生存储）。
 *   作者存储的 version() 返回它自己的字符串 ⇒ 前缀判据不成立 ⇒ 会得出
 *   "已使用数据库存档" —— 那是**假话**（底下根本不是我们的库）。
 *   宁可响亮失败，也不假称已迁移（本项目定过的底线）。
 */
function isOurStamp(stamp) {
  return isLegacyStamp(stamp) || (typeof stamp === 'string' && /^sqlite:gen:\d+(?::empty)?$/.test(stamp))
}

/**
 * 读当前存档格式。
 * @param chats - 酒馆的聊天存储接口（需实现 version(chatId)）
 * @param chatId - 聊天 id
 * @returns {{ migrated: boolean, legacy: boolean, readonly: boolean, playable: boolean, stamp: string }}
 */
export async function describeSaveFormat({ chats, chatId }) {
  if (!chats || typeof chats.version !== 'function') {
    throw new Error('describeSaveFormat：缺少 chats.version（酒馆聊天存储接口未接入）')
  }
  const stamp = String(await chats.version(chatId))
  if (stamp === '') {
    // 既没有我们的 db、也没有任何 legacy 承载 ⇒ 这个 chatId 根本不存在。
    // 最常见的原因：**调用方把 DSH 会话 id 当成了酒馆档 id**（2026-09-30 实测：
    // 档 chat-mtx0iahn-s2qwrl 的 chat.sessionId 是 session-38469e74-…，两者不同命名空间）。
    const error = new Error('找不到本局存档（chatId=' + chatId + '）—— 会话 id ≠ 酒馆档 id，或该档已不存在')
    // 显式错误码（2026-10-01）：**只有**这个码代表"确证不存在"。读取失败 / 权限 / 损坏 /
    // 不是我们的存储实现都会抛别的错 ⇒ 调用方按"未知"处理，绝不把未知当成 missing。
    error.code = 'DSH_TAVERN_SAVE_NOT_FOUND'
    throw error
  }
  if (!isOurStamp(stamp)) {
    throw new Error('当前聊天存储不是本插件的 SQLite 实现（version 返回 ' + JSON.stringify(stamp) + '）⇒ 不判定、不迁移；请先应用 chat-sqlite-store 缝')
  }
  const legacy = isLegacyStamp(stamp)
  return { migrated: !legacy, legacy, readonly: legacy, playable: !legacy, stamp }
}

/** 兼容旧导出，但永久废除同 ID 迁移；必须先验证存储身份，任何情况下都不写。 */
export async function migrateSave({ chats, chatId }) {
  const before = await describeSaveFormat({ chats, chatId })
  const error = new Error('已废除同 ID 原地迁移：原档可看不可玩；请使用显式分叉迁移流程，创建独立的新 SQLite 存档后再游玩（原档不改动）')
  error.code = 'DSH_TAVERN_EXPLICIT_FORK_REQUIRED'
  error.chatId = chatId
  error.stamp = before.stamp
  throw error
}

/**
 * UI / 工具共用入口。
 * @param action - 'status' | 'migrate'
 */
export async function runSaveAction({ chats, chatId, action }) {
  const name = String(action || 'status')
  if (!SAVE_ACTIONS.includes(name)) {
    throw new Error('未知的存档动作：' + name + '（可用：' + SAVE_ACTIONS.join(' / ') + '）')
  }
  if (typeof chatId !== 'string' || chatId === '') throw new Error('缺少 chatId（本局聊天 id）')
  return name === 'migrate' ? await migrateSave({ chats, chatId }) : { ...(await describeSaveFormat({ chats, chatId })), changed: false }
}

/** 结果 → 一行人类可读文案（UI 与工具共用，避免两处措辞分叉）。 */
export function formatSaveResult(result) {
  if (result.migrated && result.changed) return '已创建独立的 SQLite 分叉存档（原档未改动；请在新档继续游玩）'
  if (result.migrated) return '已使用数据库存档'
  return '本局原档使用旧格式（只读，可看不可玩）；必须手动显式分叉迁移为新的数据库存档后才能游玩：' + result.stamp
}