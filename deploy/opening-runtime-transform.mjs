// 私有开局只调用上游worker与作者草稿API，不维护初始化算法。
import { replaceOnce } from './upstream-compute-transform.mjs'
export const OPENING_RUNTIME_MARKER = '// [dsh-tavern-opening-upstream:v1]'
export function applyOpeningRuntimeTransform(source) {
  let next = "import { assertUpstreamRequest } from './storage-upstream-compute.js'\n" + OPENING_RUNTIME_MARKER + '\n' + source
  const once = (before, after) => { next = replaceOnce(next, before, after) }
  once('readRuntimeExtensions, extensionSettings, now = Date.now })', 'readRuntimeExtensions, extensionSettings, compute, readRuntimePolicy, now = Date.now })')
  once("      generations.stopAll('opening:' + id)", "      compute()?.stop('opening:' + id)\n      generations.stopAll('opening:' + id)")
  once("{ generations.stopAll('opening:' + id); drafts.delete(id) }", "{ compute()?.stop('opening:' + id); generations.stopAll('opening:' + id); drafts.delete(id) }")
  // 对外展示视图不下发计算脚本；内部getSession仍返回作者脚本原文。
  once("scripts: (draft.chat.mvu.enabled ? [{ id: '__dsh_official_mvu__', name: 'MVU', system: 'official-mvu', assetUrl: OFFICIAL_MVU_VERSION.assetUrl }] : []).concat(draft.helperScripts || [])", 'scripts: [], serverOwned: true')
  once('      drafts.set(draft.id, draft)\n      return present(draft)', `      draft.runtimePolicy = readRuntimePolicy ? await readRuntimePolicy() : {}
      drafts.set(draft.id, draft)
      try {
        if (draft.runtimeEnabled) {
          if (!compute()) throw new Error('上游服务端计算尚未装配，不能完成开局')
          await compute().opening(draft.id)
        }
        return present(draft)
      } catch (error) {
        compute()?.stop(draft.chat.sessionId)
        generations.stopAll(draft.chat.sessionId)
        // 先删除草稿，使仍在途的operation无法取得新草稿；随后等待实际工作收口。
        drafts.delete(draft.id)
        await compute()?.whenIdle(draft.chat.sessionId)
        await generations.whenIdle(draft.chat.sessionId)
        throw error
      }`)
  once('    get(id) { return present(requireDraft(id)) },', `    async workerRequest(id, method, args) {
      assertUpstreamRequest('opening:' + id)
      const draft = requireDraft(id)
      if (method === 'getSession') return { view: {
        chatId: draft.id, card: copy(draft.card), playerName: draft.userName,
        tavernHelper: runtimeContext(draft), tavernHelperWorldbook: present(draft).worldbook,
        tavernHelperScripts: draft.helperScripts,
        tavernMvuRuntime: draft.chat.mvu.enabled ? { owner: 'official', assetUrl: OFFICIAL_MVU_VERSION.assetUrl } : null,
        tavernRuntimePolicy: { trustedCardMode: draft.runtimePolicy.trustedCardMode === true }
      } }
      if (method === 'getTavernHelperContext') return { context: runtimeContext(draft) }
      if (method === 'hydrateTavernHelperMessages') return { from: 0, to: 1, messages: runtimeContext(draft).messages }
      if (method === 'recordTavernCompatibilityCalls') return { recorded: true }
      return await this.callRuntime(id, method, args)
    },
    get(id) { return present(requireDraft(id)) },`)
  once("release(id) { generations.stopAll('opening:' + id); return { released: drafts.delete(id) } }", `async release(id) {
      const sessionId = 'opening:' + id
      compute()?.stop(sessionId); generations.stopAll(sessionId)
      const released = drafts.delete(id)
      await compute()?.whenIdle(sessionId)
      await generations.whenIdle(sessionId)
      return { released }
    }`)
  once('    resolve(id, cardPath, openingId) {\n      const draft = requireDraft(id)', `    async resolve(id, cardPath, openingId) {
      requireDraft(id)
      const sessionId = 'opening:' + id
      compute()?.stop(sessionId); generations.stopAll(sessionId)
      await compute()?.whenIdle(sessionId)
      await generations.whenIdle(sessionId)
      const draft = requireDraft(id)`)
  once('dispose() { generations.dispose(); drafts.clear() }', "dispose() { for (const id of drafts.keys()) compute()?.stop('opening:' + id); generations.dispose(); drafts.clear() }")
  once("      if (method === 'stopTavernHelperGeneration')", "      if (method !== 'prepareOpeningCommand') assertUpstreamRequest(draft.chat.sessionId)\n      if (method === 'stopTavernHelperGeneration')")
  return next
}
