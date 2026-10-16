// 工作台沿作者原有改卡流程；游玩前像、发送顺序与物理回退不接管它。
function once(source, from, to) {
  if (source.split(from).length !== 2) throw Error('工作台分流接缝未命中或不唯一：' + from.slice(0, 90))
  return source.replace(from, () => to)
}
export function applyWorkbenchTurnTransform(source) {
  const marker = '// [dsh-tavern-workbench-turn:v1]'
  if (source.includes(marker)) return source
  let next = once(source, 'function assertRollbackBodyPreparation(chat) {', `function assertRollbackBodyPreparation(chat) {
  if (chat.mode === 'card') return`)
  next = once(next, "    if (chat.rollbackPending) throw new Error('物理回退未完成，请先重试回退，禁止继续生成')", "    if (mode !== 'card' && chat.rollbackPending) throw new Error('物理回退未完成，请先重试回退，禁止继续生成')")
  const capture = 'timeline.captureBusiness ? timeline.captureBusiness(chat) : captureRollbackBusinessState(chat)'
  next = once(next, '    const rollbackBusinessBefore = ' + capture, "    const rollbackBusinessBefore = mode === 'card' ? null : (" + capture + ')')
  next = once(next, '    const rollbackSendAnchor = (function () {', `    const rollbackSendAnchor = (function () {
      if (mode === 'card') return null`)
  // 旧作者代没有模板恢复助手及该插入行；不向不存在的能力施缝。
  if (source.includes('function restoreTemplateInput(chat)')) next = once(next, "    // [dsh-tavern-template-before-rollback-capture:v1]\n    if (chat.promptTemplateInput && chat.promptTemplateInput.turn !== turn) restoreTemplateInput(chat)", "    // [dsh-tavern-template-before-rollback-capture:v1]\n    if (mode !== 'card' && chat.promptTemplateInput && chat.promptTemplateInput.turn !== turn) restoreTemplateInput(chat)")
  return marker + '\n' + next
}
