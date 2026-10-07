// DB导入失败补偿：只撤本次新身份在作者登记（index.json / sessions.json）里的条目。
// 不走registry的readIndex→writeIndex整对象RMW，改用profileData.updateJson单文件独占updater；
// 两个文件各自独立尝试，任一异常汇总为AggregateError上报，不吞错、不假装删除成功。
const ID = /^[A-Za-z0-9_-]{1,160}$/
function saveId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw Error('DB导入登记身份无效')
  return value
}
export function createDbSaveRegistration(deps = {}) {
  const store = deps.store
  if (!store || typeof store.updateJson !== 'function') throw Error('DB导入登记补偿缺少store.updateJson')
  async function discard(identity) {
    // 只接受引擎本次新建的id；不拿importSource身份去删源档登记。
    const chatId = saveId(identity && identity.chatId)
    const sessionId = saveId(identity && identity.sessionId)
    const failures = []
    try {
      await store.updateJson('index.json', function (index) {
        const rows = index && Array.isArray(index.chats) ? index.chats : []
        const next = rows.filter(function (row) { return !row || row.id !== chatId })
        if (next.length === rows.length) return undefined
        return Object.assign({}, index || {}, { chats: next })
      })
    } catch (error) { failures.push(error) }
    try {
      await store.updateJson('sessions.json', function (links) {
        const current = links !== null && typeof links === 'object' && !Array.isArray(links) ? links : {}
        if (current[sessionId] !== chatId) return undefined
        const next = Object.assign({}, current)
        delete next[sessionId]
        return next
      })
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'DB导入登记补偿未完成；本次新身份可能残留登记')
  }
  return Object.freeze({ discard })
}
