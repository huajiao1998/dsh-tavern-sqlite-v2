// 警告投影的纯源码接缝；路由恢复不是压缩成功，不改存档历史。
const MARKER = '// [dsh-tavern-compaction-warning:v1]'
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('压缩警告消费者锚点不唯一：' + before)
  return source.replace(before, after)
}
const COMPACTION_WARNING_FIELD = 'contextCompaction: projectCompactionWarning(chat.contextCompaction, ctx.llm.listProviders())'
// 2.5.0 起作者把 volatile 投影一行化并新增 forkTurnsByMessageId（见
// conversation-fork-targets.js：fork 目标源自实时会话事件，不随 chat revision 变化）。
// 该字段不是压缩警告，**不许当成"已有warning"而删**；本缝只做合并投影（保留新字段 + 追加我们的警告字段）。
const VOLATILE_SINGLE_LINE = 'function volatileSessionViewFields(chat, activity, changes) { return sessionStateView.volatile(chat, activity, changes) }'
const VOLATILE_25_HEAD = 'function volatileSessionViewFields(chat, activity, changes) {\n    return { ...sessionStateView.volatile(chat, activity, changes)'
const VOLATILE_MERGED_HEAD = 'function volatileSessionViewFields(chat, activity, changes) {\n    return { ...sessionStateView.volatile(chat, activity, changes), contextCompaction: projectCompactionWarning(chat.contextCompaction, ctx.llm.listProviders())'
const FORK_FIELD = 'forkTurnsByMessageId: forkTurnsForChat(chat)'
export function applyCompactionWarningTransform(source) {
  if (source.includes(MARKER)) {
    // fork新字段与我们自己的warning字段都是必需消费者：标记在而任一缺失即拒，不静默放过。
    for (const required of [COMPACTION_WARNING_FIELD, "from './domain/storage-compaction-warning.js'", VOLATILE_MERGED_HEAD, FORK_FIELD]) {
      if (!source.includes(required)) throw new Error('压缩警告接缝消费者缺失：' + required)
    }
    return source
  }
  let next = `import { projectCompactionWarning } from './domain/storage-compaction-warning.js'\n${MARKER}\n` + source
  next = once(next, 'contextCompaction: chat.contextCompaction || null,', COMPACTION_WARNING_FIELD + ',')
  if (next.includes(VOLATILE_SINGLE_LINE)) {
    next = next.replace(VOLATILE_SINGLE_LINE, 'function volatileSessionViewFields(chat, activity, changes) { return { ...sessionStateView.volatile(chat, activity, changes), contextCompaction: projectCompactionWarning(chat.contextCompaction, ctx.llm.listProviders()) } }')
  } else if (next.split(VOLATILE_25_HEAD).length === 2) {
    // 合并而非替换：`forkTurnsByMessageId: forkTurnsForChat(chat)` 原样保留在本行尾部。
    next = next.replace(VOLATILE_25_HEAD, VOLATILE_MERGED_HEAD)
  } else {
    throw new Error('压缩警告消费者锚点不唯一：volatile 投影既非2.4单行亦非2.5新增fork字段形态')
  }
  // 合并结果必须同时带上 fork 新字段与我们的警告字段；缺 fork 说明投影被覆盖，fail closed。
  if (!next.includes(FORK_FIELD)) throw new Error('压缩警告合并投影丢失作者forkTurnsByMessageId字段')
  return next
}
