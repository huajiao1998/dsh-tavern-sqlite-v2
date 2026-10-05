// 本会话当前卡/书的资源能力：current 作用域按「读取当刻」取本会话当前卡/书，
// 不生成历史 revision、不保存 oldwholechat、不冒充旧 revision；legacy 作用域原样保持。
//
// 为什么需要：getCharData/getWorldbook 的调用脚本要的是**本局当前**的人物卡/世界书，
// 而不是「面板显示那一刻的存档 revision」。SQLite 下按 revision 读历史副本要回放整份
// Chat/老快照，既慢又可能把旧 revision 当成现在的卡。改为 current 作用域后：
//   · issue 产出 current:true 的签名 scope；
//   · read 对 current 直接取本会话当前行，返回**实际** revision（不要求等于签发时的 hint）；
//   · 客户端 reader 对 current 放宽 revision 相等校验、不落 token cache（值随时可变）。
//
// 边界：只改这三个消费者；不动路由与 Cache-Control（current 的 no-store 由 routes 侧负责）、
// 不加 extraRPC/无签名接口、不改 resource cache header、不动 createTavernResourceReader 的
// 装配接线（split 源码由构建产物承担）。
//
// V2 差异（相对 V1）：V2 是服务端执行线，客户端经 client-seams 的唯一 browserWrite 通道施加；
// browser-ui 的 bootstrap 提供 `options.isActive` 寿命门禁；普通资源读取者没有该参数时仍可用。
// assertResourceActive 保持可选，不把服务端计算误接进浏览器生命周期。
//
// 三个纯文本转换均为幂等：已施则按标记回读校验，缺消费者即抛错。

const ACCESS_MARKER = '// [dsh-tavern-current-resource-access:v1]'
const HOST_MARKER = '// [dsh-tavern-current-resource-host:v1]'
const CLIENT_MARKER = '// [dsh-tavern-current-resource-client:v1]'

function once(source, before, after, label) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error('当前资源接缝锚点不唯一：' + label + '（' + count + '）')
  return source.replace(before, after)
}

// ---------------------------------------------------------------------------
// ① domain/session-resource-access.js —— 签名 scope 加 current，read 分流
// ---------------------------------------------------------------------------
const ACCESS_SCOPE_OLD = `  function issue(chatId, revision, kind) {
    if (!Number.isSafeInteger(revision) || revision < 0 || !['card', 'worldbook'].includes(kind)) throw Error('Invalid resource revision')
    const body = Buffer.from(JSON.stringify({ chatId, revision, kind })).toString('base64url')
    return { token: body + '.' + sign(body).toString('base64url'), revision, kind }
  }`

const ACCESS_SCOPE_NEW = `  ${ACCESS_MARKER}
  // current：本会话当前卡/书，revision 只是签发当刻的提示值，读取时以实际行为准。
  function issue(chatId, revision, kind, current = false) {
    if (!Number.isSafeInteger(revision) || revision < 0 || !['card', 'worldbook'].includes(kind)) throw Error('Invalid resource revision')
    if (current === true && (typeof chatId !== 'string' || chatId === '')) throw Error('Invalid resource chat')
    const scope = current === true ? { chatId, revision, kind, current: true } : { chatId, revision, kind }
    const body = Buffer.from(JSON.stringify(scope)).toString('base64url')
    return { token: body + '.' + sign(body).toString('base64url'), revision, kind, ...(current === true ? { current: true } : {}) }
  }`

const ACCESS_RESOLVE_OLD = `    const scope = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (cache.has(token)) { const item = cache.get(token); cache.delete(token); cache.set(token, item); return item.json }
    if (pending.has(token)) return pending.get(token)
    const task = Promise.resolve().then(async () => {
      const value = await read(scope)
      if (value === undefined) throw Error('Resource revision unavailable')
      const json = JSON.stringify({ kind: scope.kind, revision: scope.revision, value })
      const size = Buffer.byteLength(json)
      if (size <= maxBytes) {
        cache.set(token, { json, size }); bytes += size
        while (bytes > maxBytes || cache.size > 32) { const first = cache.keys().next().value; bytes -= cache.get(first).size; cache.delete(first) }
      }
      return json
    }).finally(() => pending.delete(token))
    pending.set(token, task)
    return task`

const ACCESS_RESOLVE_NEW = `    const scope = JSON.parse(Buffer.from(body, 'base64url').toString())
    const current = scope !== null && typeof scope === 'object' && scope.current === true
    // 校验独立于签发：scope 必须是对象，chatId 非空字符串、revision 安全非负整数、kind 已知。
    if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) throw Error('Invalid resource capability')
    if (typeof scope.chatId !== 'string' || scope.chatId === '') throw Error('Invalid resource capability')
    if (!Number.isSafeInteger(scope.revision) || scope.revision < 0) throw Error('Invalid resource capability')
    if (!['card', 'worldbook'].includes(scope.kind)) throw Error('Invalid resource capability')
    if (current) {
      // current 的值随本会话当前卡/书变化，不能进 token cache；并发相同 token 仍可合并。
      if (pending.has(token)) return pending.get(token)
      const currentTask = Promise.resolve().then(async () => {
        const result = await read(scope)
        if (result === undefined || result === null || typeof result !== 'object') throw Error('Resource revision unavailable')
        const revision = result.revision
        if (!Number.isSafeInteger(revision) || revision < 0) throw Error('Resource revision unavailable')
        const value = result.value
        if (value === undefined) throw Error('Resource revision unavailable')
        return JSON.stringify({ kind: scope.kind, revision, value, current: true })
      }).finally(() => pending.delete(token))
      pending.set(token, currentTask)
      return currentTask
    }
    if (cache.has(token)) { const item = cache.get(token); cache.delete(token); cache.set(token, item); return item.json }
    if (pending.has(token)) return pending.get(token)
    const task = Promise.resolve().then(async () => {
      const value = await read(scope)
      if (value === undefined) throw Error('Resource revision unavailable')
      const json = JSON.stringify({ kind: scope.kind, revision: scope.revision, value })
      const size = Buffer.byteLength(json)
      if (size <= maxBytes) {
        cache.set(token, { json, size }); bytes += size
        while (bytes > maxBytes || cache.size > 32) { const first = cache.keys().next().value; bytes -= cache.get(first).size; cache.delete(first) }
      }
      return json
    }).finally(() => pending.delete(token))
    pending.set(token, task)
    return task`

export function applyCurrentResourceAccessTransform(source) {
  if (source.includes(ACCESS_MARKER)) {
    for (const required of [ACCESS_SCOPE_NEW, ACCESS_RESOLVE_NEW]) {
      if (!source.includes(required)) throw new Error('当前资源能力标记存在但实现不完整')
    }
    if (source.includes(ACCESS_SCOPE_OLD) || source.includes('const scope = JSON.parse')) {
      if (source.includes('const scope = JSON.parse') && !source.includes('const current = scope !== null')) {
        throw new Error('当前资源能力标记存在但旧 read 路径残留')
      }
    }
    return source
  }
  let next = once(source, ACCESS_SCOPE_OLD, ACCESS_SCOPE_NEW, 'issue 作用域')
  next = once(next, ACCESS_RESOLVE_OLD, ACCESS_RESOLVE_NEW, 'resolve 分流')
  return next
}

// ---------------------------------------------------------------------------
// ② lib/index.js —— callback 参数加 current；current 走 head 零 messages
// ---------------------------------------------------------------------------
const HOST_OLD = `  const sessionResources = createSessionResourceAccess({ read: async ({chatId, revision, kind}) => {
    if (deletedChatIds.has(chatId)) throw new Error('对话已删除')
    const chat = await readChatRevision(chatId, revision)
    if (!chat) return undefined
    const card = await readChatCard(chat)
    if (kind === 'card') return cardViewOf(card, chat)
    const record = await worldBooks.bound(chat.cardPath, card, chat)
    return record ? projectTavernHelperWorldbook(record.view) : null
  } })`

const HOST_NEW = `  ${HOST_MARKER}
  // current 分支只取本会话头行的 revision/chat，零 messages；卡/书投影与 legacy 完全一致
  // （直开型已在书写时保证 cardDefinitionSnapshot / openingWorldbookSnapshot 落库）。
  // readWindow 返回 { chat, messageCount, from, to, revision }：chat.messages=[]（limit1/before0 只取头），
  // revision 是**读取当刻**的实际行版本，不是签发时的 hint。
  const sessionResources = createSessionResourceAccess({ read: async ({chatId, revision, kind, current = false}) => {
    if (deletedChatIds.has(chatId)) throw new Error('对话已删除')
    if (current === true) {
      const head = await chatPersistence.readWindow(chatId, { limit: 1, before: 0,
        fields: ['id', 'sessionId', 'mode', 'cardPath', 'cardDefinitionSnapshot', 'openingWorldbookSnapshot'] })
      if (!head || !Number.isSafeInteger(head.revision) || head.revision < 0) return undefined
      const chat = head.chat
      if (!chat || chat.id !== chatId || chat.mode === 'card' || !chat.cardDefinitionSnapshot || chat.openingWorldbookSnapshot?.version !== 1) return undefined
      const revision = head.revision
      const card = await readChatCard(chat)
      if (kind === 'card') return { revision, value: cardViewOf(card, chat) }
      const record = await worldBooks.bound(chat.cardPath, card, chat)
      return { revision, value: record ? projectTavernHelperWorldbook(record.view) : null }
    }
    const chat = await readChatRevision(chatId, revision)
    if (!chat) return undefined
    const card = await readChatCard(chat)
    if (kind === 'card') return cardViewOf(card, chat)
    const record = await worldBooks.bound(chat.cardPath, card, chat)
    return record ? projectTavernHelperWorldbook(record.view) : null
  } })`

export function applyCurrentResourceHostTransform(source) {
  if (source.includes(HOST_MARKER)) {
    for (const required of [
      'read: async ({chatId, revision, kind, current = false}) => {',
      "fields: ['id', 'sessionId', 'mode', 'cardPath', 'cardDefinitionSnapshot', 'openingWorldbookSnapshot'] })",
      'return { revision, value: cardViewOf(card, chat) }',
      "sessionResources.issue(chat.id, resourceRevision, 'card', true)",
      "sessionResources.issue(chat.id, resourceRevision, 'worldbook', true)",
      'const chat = await readChatRevision(chatId, revision)'
    ]) {
      if (!source.includes(required)) throw new Error('当前资源 Host 标记存在但消费者缺失：' + required)
    }
    return source
  }
  let next = once(source, HOST_OLD, HOST_NEW, '资源读取回调')
  next = once(next, "sessionResources.issue(chat.id, resourceRevision, 'card')", "sessionResources.issue(chat.id, resourceRevision, 'card', true)", '当前卡能力')
  return once(next, "sessionResources.issue(chat.id, resourceRevision, 'worldbook')", "sessionResources.issue(chat.id, resourceRevision, 'worldbook', true)", '当前书能力')
}

// ---------------------------------------------------------------------------
// ③ 客户端 reader.accept —— current 放宽 revision、不落 cache
// ---------------------------------------------------------------------------
const CLIENT_OLD = `            function accept(access, result) {
                if (!result || result.kind !== access.kind || result.revision !== access.revision || !Object.prototype.hasOwnProperty.call(result, 'value')) throw new Error('人物卡资源版本不匹配，请刷新会话');
                cache.set(access.token, result.value);
                while (cache.size > 4) cache.delete(cache.keys().next().value);
                return result.value;
            }
            function read(access) {
                if (cache.has(access.token)) return cache.get(access.token);`

const CLIENT_NEW = `            ${CLIENT_MARKER}
            function assertResourceActive() { if (options?.isActive && !options.isActive()) { const error = new Error('人物卡脚本窗口已销毁，资源读取已取消'); error.code = 'TAVERN_SCRIPT_RUNTIME_DISPOSED'; throw error; } }
            function accept(access, result) {
                assertResourceActive();
                const current = access && access.current === true;
                if (!result || result.kind !== access.kind || !Object.prototype.hasOwnProperty.call(result, 'value')) throw new Error('人物卡资源版本不匹配，请刷新会话');
                if (current) {
                    // 本会话当前卡/书：revision 是读取当刻的实际值，不要求等于签发时的提示值。
                    if (result.current !== true || !Number.isSafeInteger(result.revision) || result.revision < 0) throw new Error('人物卡资源版本不匹配，请刷新会话');
                    return result.value;
                }
                if (result.revision !== access.revision) throw new Error('人物卡资源版本不匹配，请刷新会话');
                cache.set(access.token, result.value);
                while (cache.size > 4) cache.delete(cache.keys().next().value);
                return result.value;
            }
            function read(access) {
                assertResourceActive();
                if (!(access && access.current === true) && cache.has(access.token)) return cache.get(access.token);`

const CLIENT_ASYNC_OLD = `            async function readAsync(access) {
                if (cache.has(access.token)) return cache.get(access.token);
                if (pending.has(access.token)) return pending.get(access.token);`

const CLIENT_ASYNC_NEW = `            async function readAsync(access) {
                assertResourceActive();
                const current = access && access.current === true;
                if (!current && cache.has(access.token)) return cache.get(access.token);
                if (pending.has(access.token)) return pending.get(access.token);`

export function applyCurrentResourceClientTransform(source) {
  if (source.startsWith('// Full card data') && source.includes('\nfunction createTavernResourceReader(options) {')) {
    return applyCurrentResourceClientTransform(source.split('\n').map(line=>'        '+line).join('\n')).split('\n').map(line=>line.slice(8)).join('\n')
  }
  if (source.includes(CLIENT_MARKER)) {
    for (const required of [
      CLIENT_NEW, CLIENT_ASYNC_NEW
    ]) {
      if (!source.includes(required)) throw new Error('当前资源客户端标记存在但实现不完整')
    }
    return source
  }
  let next = once(source, CLIENT_OLD, CLIENT_NEW, '客户端 accept/read')
  next = once(next, CLIENT_ASYNC_OLD, CLIENT_ASYNC_NEW, '客户端 readAsync')
  return next
}

// ---------------------------------------------------------------------------
// ④ 当前态世界书守卫 —— 从 V1 browser-ui-lifetime 的单条通用修复中提取
// ---------------------------------------------------------------------------
// 这条与浏览器无关：current 令牌下资源值随时可变，token 相等不代表同一个值，
// 用 token 相等去覆盖 state.worldbook 会把旧的当前书写回。必须加 !access.current 守卫。
const BOOK_GUARD_OLD = '                    if (state.worldbook?.resourceAccess?.token === access.token) state.worldbook = copy(book);'
const BOOK_GUARD_NEW = '                    if (!access.current && state.worldbook?.resourceAccess?.token === access.token) state.worldbook = copy(book);'

export function applyCurrentResourceBookGuardTransform(source) {
  if (source.includes(BOOK_GUARD_NEW)) return source
  if (!source.includes(BOOK_GUARD_OLD)) throw new Error('当前资源世界书守卫锚点缺失')
  return source.replace(BOOK_GUARD_OLD, BOOK_GUARD_NEW)
}
