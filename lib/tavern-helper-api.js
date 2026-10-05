// 作者2.4浏览器Helper契约的纯包装层；不访问存档、不自行创造宿主API或空成功。
// 变量：client:5668–5699、5813–5863；世界书：5949–5992；MVU：6076–6098。
const copy = value => value === undefined ? undefined : structuredClone(value)
const text = value => String(value || '')
const isPromise = value => value && typeof value.then === 'function'
function unsupported(name, reason = '') {
  const error = new Error('服务端未支持 Tavern Helper API "' + name + '"' + (reason ? '：' + reason : ''))
  error.code = 'DSH_TAVERN_SERVER_UNSUPPORTED_API'
  throw error
}

export function createTavernHelperExtensions({
  getVariables, replaceVariables, readOpen, requireOpen, assertOpen, host = {}, lodash,
  currentScriptId = () => '', Mvu = {}, globals = () => ({}), globalWaitTimeoutMs = 1000,
} = {}) {
  for (const [name, value] of Object.entries({getVariables, replaceVariables, readOpen, requireOpen, assertOpen})) {
    if (typeof value !== 'function') throw new TypeError('Helper包装依赖缺失：' + name)
  }
  function optionOf(option) {
    const resolved = option && typeof option === 'object' ? copy(option) : {type:'message'}
    if (!resolved.type) resolved.type = 'message'
    if (resolved.type === 'script' && !resolved.script_id) {
      resolved.script_id = text(currentScriptId())
      if (!resolved.script_id) unsupported('script variables', '没有当前脚本身份，不能写入空ID或其他脚本')
    }
    return resolved
  }
  function readVariables(option) {
    readOpen()
    const result = getVariables(optionOf(option))
    if (isPromise(result)) unsupported('getVariables', '同步读口不能返回Promise')
    return copy(result)
  }
  async function writeVariables(value, option) {
    const current = requireOpen()
    const result = await replaceVariables(copy(value || {}), optionOf(option))
    assertOpen(current)
    if (result?.stale) throw new Error('聊天已变化，变量未保存')
    return result
  }
  function requireLodash(name) {
    if (typeof lodash?.[name] !== 'function') unsupported(name, '未注入真实lodash实现')
    return lodash[name].bind(lodash)
  }
  const api = {
    getVariables: readVariables,
    replaceVariables: writeVariables,
    insertOrAssignVariables: async (variables, option) => {
      const current = requireOpen(), resolved = optionOf(option)
      const next = requireLodash('mergeWith')(readVariables(resolved), copy(variables || {}), (_left,right) => Array.isArray(right) ? right : undefined)
      await writeVariables(next, resolved); assertOpen(current)
      return copy(next)
    },
    insertVariables: async (variables, option) => {
      const current = requireOpen(), resolved = optionOf(option)
      const next = requireLodash('mergeWith')({}, copy(variables || {}), readVariables(resolved), (_left,right) => Array.isArray(right) ? right : undefined)
      await writeVariables(next, resolved); assertOpen(current)
      return copy(next)
    },
    updateVariablesWith: async (updater, option) => {
      const current = requireOpen(), resolved = optionOf(option), before = readVariables(resolved)
      // 作者变量更新器undefined时保留原值（与世界书的保留修改后draft不同）。
      let next = typeof updater === 'function' ? await updater(copy(before)) : before
      assertOpen(current)
      if (next === undefined) next = before
      next = copy(next)
      await writeVariables(next, resolved)
      return copy(next)
    },
    deleteVariable: async (path, option) => {
      const current = requireOpen(), resolved = optionOf(option), next = readVariables(resolved)
      // 作者client:7010–7016：delete_occurred **就是 lodash unset 的返回值本身**，不做二次加工。
      // 该标志位是 lodash 的结果，不基于全树 diff：lodash 规定「路径不存在时 unset 仍返回 true」
      // （对象不变、但函数报告"已按该路径执行删除"），故此处保留 true，不得改写成"真的删掉了"的语义。
      const deleted = requireLodash('unset')(next, text(path))
      await writeVariables(next, resolved); assertOpen(current)
      return {variables:copy(next), delete_occurred:Boolean(deleted)}
    },
    getAllVariables: () => {
      readOpen()
      // 作者client:6957–6959：global→character→script→chat，**不遍历聊天消息**（全程copy隔离，不外泄真身）。
      return copy(Object.assign(
        {},
        readVariables({type:'global'}), readVariables({type:'character'}),
        readVariables({type:'script'}), readVariables({type:'chat'}),
      ))
    },
  }
  function bookEntries(result, name) {
    if (!Array.isArray(result?.worldbook?.entries)) throw new TypeError('世界书宿主返回缺少worldbook.entries：' + name)
    return copy(result.worldbook.entries)
  }
  function worldbookPayload(entries) {
    if (!Array.isArray(entries)) throw new TypeError('世界书条目必须是数组')
    return entries.map(value => {
      const entry = copy(value)
      if (Array.isArray(value?.strategy?.keys)) entry.strategy.keys = value.strategy.keys.map(String)
      if (Array.isArray(value?.strategy?.keys_secondary?.keys)) entry.strategy.keys_secondary.keys = value.strategy.keys_secondary.keys.map(String)
      return entry
    })
  }
  function hostMethod(name) {
    if (typeof host[name] !== 'function') unsupported(name, '缺少真实宿主接线')
    return host[name].bind(host)
  }
  async function freshWorldbook(name) {
    const current = readOpen()
    const result = await hostMethod('getWorldbook')(current.sessionId, text(name), false)
    assertOpen(current)
    return bookEntries(result, name)
  }
  async function writeWorldbook(name, entries, expectedEntries) {
    const current = requireOpen()
    // 必传expectedEntries，由作者自己检查CAS和跨存储MVU事务禁写；不绕开其guard。
    const result = await hostMethod('replaceWorldbook')(current.sessionId, text(name), worldbookPayload(entries), copy(expectedEntries), false)
    assertOpen(current)
    return bookEntries(result, name)
  }
  Object.assign(api, {
    getWorldbook: freshWorldbook,
    replaceWorldbook: async (name, entries) => {
      const current = requireOpen(), before = await freshWorldbook(name)
      assertOpen(current)
      await writeWorldbook(name, entries, before)
      // 作者浏览器replaceWorldbook为Promise<void>，不是entries或宿主receipt。
    },
    updateWorldbookWith: async (name, updater) => {
      if (typeof updater !== 'function') throw new TypeError('世界书更新器必须是函数')
      const current = requireOpen(), before = await freshWorldbook(name), draft = copy(before)
      const next = await updater(draft)
      assertOpen(current)
      return await writeWorldbook(name, next === undefined ? draft : next, before)
    },
    createWorldbookEntries: async (name, entries) => {
      const additions = worldbookPayload(entries).map(entry => { delete entry.uid; return entry })
      let previous
      const worldbook = await api.updateWorldbookWith(name, current => {
        previous = new Set(current.map(entry => entry.uid))
        return current.concat(additions)
      })
      return {worldbook, new_entries:worldbook.filter(entry => !previous.has(entry.uid))}
    },
    deleteWorldbookEntries: async (name, predicate) => {
      if (typeof predicate !== 'function') throw new TypeError('世界书删除条件必须是函数')
      const deleted = []
      const worldbook = await api.updateWorldbookWith(name, current => current.filter(entry => {
        if (!predicate(copy(entry))) return true
        deleted.push(copy(entry)); return false
      }))
      return {worldbook, deleted_entries:deleted}
    },
    // 名称/整书CRUD/regex没有当前adapter生产实现，不从上下文猜名称或伪造success。
    // 只可由显式注入的同名宿主契约提供；未注入时始终unsupported。
    getWorldbookNames: (...args) => hostMethod('getWorldbookNames')(readOpen().sessionId, ...args),
    createWorldbook: (...args) => hostMethod('createWorldbook')(requireOpen().sessionId, ...args),
    deleteWorldbook: (...args) => hostMethod('deleteWorldbook')(requireOpen().sessionId, ...args),
    getTavernRegexes: (...args) => hostMethod('getTavernRegexes')(readOpen().sessionId, ...args),
    replaceTavernRegexes: (...args) => hostMethod('replaceTavernRegexes')(requireOpen().sessionId, ...args),
    updateTavernRegexesWith: (...args) => hostMethod('updateTavernRegexesWith')(requireOpen().sessionId, ...args),
    importRawTavernRegex: (...args) => hostMethod('importRawTavernRegex')(requireOpen().sessionId, ...args),
  })
  const mvu = {
    ...Mvu,
    getMvuData: readVariables,
    replaceMvuData: async (value, option) => {
      await api.updateVariablesWith(() => value, option)
      return copy(value)
    },
    parseMessage: async () => unsupported('Mvu.parseMessage', '未开放脚本内手动MVU重算'),
  }
  api.Mvu = mvu
  api.waitGlobalInitialized = async name => {
    const current = readOpen(), key = String(name), timeout = Number(globalWaitTimeoutMs)
    if (!Number.isFinite(timeout) || timeout < 0) throw new TypeError('全局初始化等待超时必须为有限非负数')
    const deadline = Date.now() + timeout
    for (;;) {
      assertOpen(current)
      const available = globals() || {}
      const value = Object.hasOwn(available, key) ? available[key] : key === 'Mvu' ? mvu : undefined
      if (value !== undefined && !(value && value.__dshBootstrap === true)) return value
      if (Date.now() >= deadline) unsupported('waitGlobalInitialized', '全局对象未初始化：' + key)
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))))
    }
  }
  return api
}
