// 仅为显式授权绑定的真实源登记原生 workspace；不 resume、不创建/改写 Session。
export async function initializeLegacySourceWorkspaces({ bindings, persistence, registry }) {
  if (!Array.isArray(bindings)) throw new Error('原件 workspace 初始化缺少显式绑定清单')
  if (bindings.length === 0) return []
  if (typeof persistence?.stat !== 'function' || typeof registry?.create !== 'function') throw new Error('原件 workspace 初始化缺少原生服务')
  const sources = new Set()
  const plans = []
  // 先验证每个绑定源的真实 header，绝不扫描其他会话或读取 archive。
  for (const binding of bindings) {
    const sessionId = binding?.sessionId
    if (typeof sessionId !== 'string' || !sessionId || !binding?.chatId || sources.has(sessionId)) throw new Error('原件 workspace 绑定身份无效或重复')
    sources.add(sessionId)
    const snapshot = await persistence.stat(sessionId)
    if (snapshot?.header?.id !== sessionId || typeof snapshot.header.cwd !== 'string' || !snapshot.header.cwd) throw new Error('原件真实源缺少匹配 header/cwd，拒绝登记 workspace：' + JSON.stringify({ sessionId, headerId: snapshot?.header?.id, cwd: snapshot?.header?.cwd, snapshotKeys: snapshot && Object.keys(snapshot), stat: { type: typeof persistence.stat, name: persistence.stat?.name, own: Object.hasOwn(persistence, 'stat'), src: String(persistence.stat).slice(0, 160) }, ctor: persistence.constructor?.name, ownKeys: Object.keys(persistence).slice(0, 24) }))
    plans.push({ sessionId, cwd: snapshot.header.cwd })
  }
  const results = []
  for (const { sessionId, cwd } of plans) {
    // create 自行 realpath 规范化并幂等复用；attachSession 自行核验持久 header.cwd。
    const workspace = await registry.create(cwd)
    if (!workspace?.id || !workspace.path || typeof workspace.attachSession !== 'function') throw new Error('原生 workspace 返回无效实体')
    const attached = workspace.sessionIds?.includes(sessionId) === true
    if (!attached) await workspace.attachSession(sessionId)
    if (workspace.sessionIds?.includes(sessionId) !== true) throw new Error('原件 workspace 登记后置校验失败')
    results.push({ sessionId, workspaceId: workspace.id, path: workspace.path, attached: !attached })
  }
  return results
}
