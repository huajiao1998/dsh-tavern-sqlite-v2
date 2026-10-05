// B作者2.4客户端正则契约：5742–5812、6113–6151；保存使用作者adapter的整份设置CAS。
// 只包装已预取的作者regexScripts投影，不猜raw regex_scripts；缺快照不能伪装空列表。
const copy = value => value === undefined ? undefined : structuredClone(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

function helperRegex(script, scope) {
  const placements = Array.isArray(script.placement) ? script.placement.map(Number) : []
  return {
    id: String(script.id || ''), script_name: String(script.name || script.scriptName || ''), enabled: script.enabled !== false,
    find_regex: String(script.findRegex || ''), trim_strings: copy(Array.isArray(script.trimStrings) ? script.trimStrings : []), replace_string: String(script.replaceString || ''),
    source: { user_input: placements.includes(1), ai_output: placements.includes(2), slash_command: placements.includes(3), world_info: placements.includes(5), reasoning: placements.includes(6) },
    destination: { display: script.markdownOnly === true, prompt: script.promptOnly === true }, run_on_edit: script.runOnEdit === true,
    min_depth: script.minDepth == null ? null : Number(script.minDepth), max_depth: script.maxDepth == null ? null : Number(script.maxDepth), scope,
  }
}
function internalRegex(regex) {
  const source = regex && regex.source || {}, destination = regex && regex.destination || {}
  return {
    id: String(regex && regex.id || ''), name: String(regex && (regex.script_name || regex.scriptName) || ''), enabled: !regex || (own(regex, 'enabled') ? regex.enabled !== false : regex.disabled !== true),
    findRegex: String(regex && (regex.find_regex || regex.findRegex) || ''), trimStrings: copy(regex && (regex.trim_strings || regex.trimStrings) || []), replaceString: String(regex && (regex.replace_string || regex.replaceString) || ''),
    placement: Array.isArray(regex && regex.placement) ? copy(regex.placement) : [source.user_input && 1, source.ai_output && 2, source.slash_command && 3, source.world_info && 5, source.reasoning && 6].filter(Boolean),
    markdownOnly: regex && regex.markdownOnly === true || destination.display === true, promptOnly: regex && regex.promptOnly === true || destination.prompt === true, runOnEdit: regex && (regex.runOnEdit === true || regex.run_on_edit === true),
    substituteRegex: 0, minDepth: regex && (regex.min_depth ?? regex.minDepth) == null ? null : Number(regex.min_depth ?? regex.minDepth), maxDepth: regex && (regex.max_depth ?? regex.maxDepth) == null ? null : Number(regex.max_depth ?? regex.maxDepth),
  }
}
function rawRegex(script) {
  return {
    id: String(script.id || ''), scriptName: String(script.name || ''), disabled: script.enabled === false,
    findRegex: String(script.findRegex || ''), trimStrings: copy(script.trimStrings || []), replaceString: String(script.replaceString || ''),
    placement: copy(script.placement || []), markdownOnly: script.markdownOnly === true, promptOnly: script.promptOnly === true,
    runOnEdit: script.runOnEdit === true, substituteRegex: script.substituteRegex == null ? 0 : script.substituteRegex,
    minDepth: script.minDepth == null ? null : script.minDepth, maxDepth: script.maxDepth == null ? null : script.maxDepth,
  }
}

/** readSnapshot(current)同步返回{extensionSettings,regexScripts:{global,character}}。
 * 两组regexScripts必须是作者投影；extensionSettings是原全设置，用于作者整份CAS。
 * 同一打开绑定内预取snapshot保持身份不变；成功写后的私有镜像不改注入快照，刷新snapshot会替换镜像。
 * saveExtensionSettings(sessionId,next,expected)必须接作者真方法，且父adapter在提交前拒绝结算跨资源写。
 */
export function createTavernRegexApi({ readSnapshot, readOpen, requireOpen, assertOpen, saveExtensionSettings } = {}) {
  for (const [name, value] of Object.entries({readSnapshot,readOpen,requireOpen,assertOpen,saveExtensionSettings})) {
    if (typeof value !== 'function') throw new TypeError('正则API依赖缺失：' + name)
  }
  const mirrors = new WeakMap()
  function loaded(current) {
    assertOpen(current)
    const source = readSnapshot(current)
    if (source && typeof source.then === 'function') throw new Error('正则API需要同步预取快照，不能返回Promise')
    if (!object(source?.extensionSettings) || !object(source?.regexScripts)
      || !Array.isArray(source.regexScripts.global) || !Array.isArray(source.regexScripts.character)) {
      throw new Error('酒馆正则快照未加载：需要extensionSettings与作者regexScripts全局/人物投影')
    }
    const saved = mirrors.get(current)
    return saved?.source === source ? saved : { source, extensionSettings: copy(source.extensionSettings), groups: copy(source.regexScripts) }
  }
  function getFrom(state, option) {
    const groups = state.groups, resolved = option && typeof option === 'object' ? option : {}
    let items = []
    if (resolved.type) {
      if (!own(groups, resolved.type)) throw new Error('不支持的酒馆正则类型: ' + resolved.type)
      items = groups[resolved.type].map(script => helperRegex(script))
    } else {
      const scope = resolved.scope || 'all', enabled = resolved.enable_state || 'all'
      if (!['all','global','character'].includes(scope)) throw new Error('无效的酒馆正则 scope: ' + scope)
      if (!['all','enabled','disabled'].includes(enabled)) throw new Error('无效的酒馆正则 enable_state: ' + enabled)
      if (scope === 'all' || scope === 'global') items.push(...groups.global.map(script => helperRegex(script, 'global')))
      if (scope === 'all' || scope === 'character') items.push(...groups.character.map(script => helperRegex(script, 'character')))
      if (enabled !== 'all') items = items.filter(script => script.enabled === (enabled === 'enabled'))
    }
    return copy(items)
  }
  function getTavernRegexes(option) { return getFrom(loaded(readOpen()), option) }
  async function replaceFor(current, state, regexes, option) {
    const resolved = option && typeof option === 'object' ? option : {}
    const items = Array.isArray(regexes) ? copy(regexes) : []
    if (resolved.type && resolved.type !== 'global') throw new Error('当前兼容层只允许脚本修改全局正则')
    if (!resolved.type && resolved.scope && !['all','global'].includes(resolved.scope)) throw new Error('当前兼容层只允许脚本修改全局正则')
    const globals = resolved.type === 'global' ? items : items.filter(item => item && item.scope === 'global')
    if (!resolved.type && (!resolved.scope || resolved.scope === 'all')) {
      const submittedCharacters = items.filter(item => item && item.scope === 'character')
      const currentCharacters = getFrom(state, {scope:'character',enable_state:'all'})
      if (JSON.stringify(submittedCharacters) !== JSON.stringify(currentCharacters)) throw new Error('当前兼容层不允许脚本修改人物卡内置正则')
    }
    const normalized = globals.map(internalRegex)
    const expected = copy(state.extensionSettings), next = copy(expected)
    next.regex = normalized.map(rawRegex)
    assertOpen(current)
    // parent的真实保存入口在这里必须强制跨资源权限与CAS，不能直接改预取设置。
    const result = await saveExtensionSettings(current.sessionId, next, expected)
    assertOpen(current)
    if (result?.stale || result?.updated !== true || !object(result.extensionSettings)) throw new Error('酒馆正则设置未确认保存（版本冲突或缺少作者保存回执）')
    mirrors.set(current, {source:state.source,extensionSettings:copy(result.extensionSettings),groups:{...copy(state.groups),global:normalized}})
  }
  async function replaceTavernRegexes(regexes, option) {
    const current = requireOpen()
    await replaceFor(current, loaded(current), regexes, option)
  }
  async function updateTavernRegexesWith(updater, option) {
    if (typeof updater !== 'function') throw new TypeError('酒馆正则更新器必须是函数')
    const current = requireOpen(), state = loaded(current), draft = getFrom(state, option)
    const updated = await updater(draft)
    assertOpen(current)
    await replaceFor(current, state, updated === undefined ? draft : updated, option)
    return getTavernRegexes(option)
  }
  function importRawTavernRegex() {
    readOpen()
    const error = new Error('服务端未支持 Tavern Helper API "importRawTavernRegex"：作者接口异步延后保存，尚未接入异步错误跟踪')
    error.code = 'DSH_TAVERN_SERVER_UNSUPPORTED_API'
    throw error
  }
  return Object.freeze({getTavernRegexes,replaceTavernRegexes,updateTavernRegexesWith,importRawTavernRegex})
}
