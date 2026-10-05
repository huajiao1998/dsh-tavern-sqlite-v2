// SQLite回退不再读取按轮号隐藏的旧浏览器记录；复用轮号不能继承旧隐藏。
const MARKER = '// [dsh-tavern-client-history-authority:v1]'
const OLD = ['\t\t\t\tapplyHiddenTurns(sessionId);','\t\t\t\tapplyRolledBackTurns(sessionId);','\t\t\t\tapplyHiddenRegenUserTurns(sessionId);'].join('\n')
const NEXT = `${MARKER}
                // 清理本session旧缓存；保留其他session记录，不依赖本地缓存判断正文可见性。
                for (const key of [HIDDEN_TURNS_KEY, ROLLED_BACK_TURNS_KEY, HIDDEN_REGEN_USER_TURNS_KEY]) {
                    try {
                        const all = JSON.parse(storage().getItem(key) || "{}");
                        if (all && typeof all === "object" && Object.prototype.hasOwnProperty.call(all, sessionId)) {
                            delete all[sessionId];
                            if (Object.keys(all).length) storage().setItem(key, JSON.stringify(all));
                            else storage().removeItem(key);
                        }
                    } catch (_) { /* 本地存储不可用/旧记录损坏也不得隐藏权威正文。 */ }
                }`
export function applyClientHistoryAuthorityTransform(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || !source.includes(NEXT) || source.includes(OLD)) throw new Error('客户端数据库权威标记不完整')
    return source
  }
  if (source.split(OLD).length !== 2) throw new Error('客户端旧隐藏消费者锚点不唯一/未命中')
  return source.replace(OLD, NEXT)
}
