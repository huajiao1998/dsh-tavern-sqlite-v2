// 作者2.5(5d2ffacf)开局准备的服务端消费者接线；私有草稿成功初始化后才发布，不访问存档。
export const OPENING_RUNTIME_MARKER = '// [dsh-tavern-opening-server-runtime:v1]'
// 2.5.0 作者签名（actor Helper 新 host generate）；本缝只在其后追加 dispatchMarksProvider。
const OPENING_SIGNATURE_25 = 'createOpeningPreparation({ readCard, worldBooks, generate, generateRaw, readRuntimeExtensions, extensionSettings, now = Date.now })'
const OPENING_SIGNATURE_25_MERGED = 'createOpeningPreparation({ readCard, worldBooks, generate, generateRaw, readRuntimeExtensions, extensionSettings, dispatchMarksProvider, now = Date.now })'
function once(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error('开局服务端接线锚点不唯一：' + label)
  return source.replace(before, after)
}
export function applyOpeningRuntimeTransform(source) {
  if (source.includes(OPENING_RUNTIME_MARKER)) {
    for (const text of ['await initializeOpeningRuntime({ draft,', 'storageBrowserScripts(draft.helperScripts, { store: dispatchMarksProvider?.(), cardPath: draft.cardPath })', 'serverOwned: true', 'draft.initializationWorldbooks =', 'initializationWorldbookSources: copy(draft.initializationWorldbookSources)']) {
      if (!source.includes(text)) throw new Error('开局服务端标记存在但消费者不完整：' + text)
    }
    // 作者generate DI必须仍在接线名单里：被吞掉则准备页独立生成回落generateRaw，作者语义丢失。
    if (!source.includes('worldBooks, generate, generateRaw, readRuntimeExtensions, extensionSettings, dispatchMarksProvider, now = Date.now })')) {
      throw new Error('开局服务端标记存在但作者generate DI被吞：generate, generateRaw, readRuntimeExtensions')
    }
    // 本缝只允许在作者签名后追加 dispatchMarksProvider 一个DI；签名行必须恰好是我们合并后的形态
    // （作者源本就自带 createHelperGenerationTasks 等，故只以签名行判据，不做全串存在性判据）。
    if (source.split(OPENING_SIGNATURE_25_MERGED).length !== 2) {
      throw new Error('作者2.5 Helper生成消费面禁止在本缝内复刻：签名行必须保持作者形态')
    }
    return source
  }
  let next = "import { initializeOpeningRuntime } from './storage-opening-runtime.js'\nimport { createServerExecution, storageBrowserScripts } from './storage-server-execution.js'\n" + OPENING_RUNTIME_MARKER + '\n' + source
  // 2.5.0 起 createOpeningPreparation 的 DI 名单多了作者 generate（actor Helper 新 host generate）。
  // 本缝只授权标记与初始化，**必须原样传递作者 generate/generateRaw**，不透传、不吞参数、不复刻生成实现。
  next = once(next,
    OPENING_SIGNATURE_25,
    OPENING_SIGNATURE_25_MERGED, '共用动态脚本分类标记')
  next = once(next,
    '      draft.card = copy(card)',
    `      // 合并书仍保留各源 UID 映射，开场白 override 只覆盖主书，附加/全局 initvar 仍应加载。\n      draft.initializationWorldbookSources = settings.sourceChat?.openingWorldbookSnapshot?.initializationWorldbookSources\n        || record?.mergedSources?.map(book => ({ name: book.name, entryUids: book.entries.map(item => item.uid) }))\n      const projectedEntries = new Map((record ? projectTavernHelperWorldbook(record.view).entries : []).map(entry => [entry.uid, entry]))\n      draft.initializationWorldbooks = draft.initializationWorldbookSources?.map(book => ({\n        name: book.name, entries: book.entryUids.map(uid => {\n          const entry = projectedEntries.get(uid)\n          if (!entry) throw new Error('开局世界书来源映射缺少条目')\n          return entry\n        })\n      }))\n      draft.card = copy(card)`, '保留合并世界书来源')
  next = once(next,
    'libraryDigest: draft.libraryDigest, source: draft.source, document: draft.document }',
    'libraryDigest: draft.libraryDigest, source: draft.source, document: draft.document, initializationWorldbookSources: copy(draft.initializationWorldbookSources) }', '开局书来源随私有快照保留')
  next = once(next,
    '      drafts.set(draft.id, draft)\n      return present(draft)',
    `      // 此时只存在准备页私有草稿：不创建原生会话、不写资源原件。失败不发布半初始化结果。\n      if (draft.runtimeEnabled) {\n        await initializeOpeningRuntime({ draft, createServerExecution, cardScriptDispatchStore: dispatchMarksProvider?.(), worldbook: draft.document ? projectTavernHelperWorldbook(inspectWorldBookDocument(draft.document)) : null, generate, generateRaw,
          generationContext: (chat, signal) => ({ sessionId: draft.sourceSessionId, signal, chat, card: draft.card,
            worldBook: draft.document ? { view: inspectWorldBookDocument(draft.document) } : null,
            presetSnapshot: draft.presetSnapshot, characterVariables: draft.characterVariables,
            extensions: { globalRegexScripts: draft.regexScripts.global, characterRegexScripts: draft.regexScripts.character },
            history: helperGenerationHistory(chat) }) })\n        draft.helperScripts = storageBrowserScripts(draft.helperScripts, { store: dispatchMarksProvider?.(), cardPath: draft.cardPath })\n      }\n      drafts.set(draft.id, draft)\n      return present(draft)`, '发布准备草稿前初始化')
  next = once(next,
    "runtime: draft.runtimeEnabled ? { context: runtimeContext(draft), scripts: (draft.chat.mvu.enabled ? [{ id: '__dsh_official_mvu__', name: 'MVU', system: 'official-mvu', assetUrl: OFFICIAL_MVU_VERSION.assetUrl }] : []).concat(draft.helperScripts || []) } : null,",
    'runtime: draft.runtimeEnabled ? { context: runtimeContext(draft), scripts: draft.helperScripts || [], serverOwned: true } : null,', '浏览器只保留开局界面脚本')
  return next
}
