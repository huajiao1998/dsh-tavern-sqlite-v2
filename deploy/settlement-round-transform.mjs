// 新结算只能绑定同版本正文轮次；跨版本的显式重试走作者既有独立结算路径。
// 不改complete的CAS/round护栏，不改旧任务身份，不改真实存档。
const MARKER = '// [dsh-tavern-settlement-round:v1]'
const ORIGINAL = "    return latest !== undefined && ['pending', 'running', 'failed'].includes(str(object(latest.background).phase)) ? latest : undefined\n"
const PATCHED = `${MARKER}
    // 候选任务等可能已经推进剧情版本。旧正文轮次不能绑定到新版本的结算：
    // 否则新任务的basedOn与round.committedRevision从创建时就不一致，完成时必stale。
    // 不重写历史round或放宽完成护栏；不匹配时沿用作者未绑定round的独立结算语义。
    return latest !== undefined && Number(latest.committedRevision) === Number(chat.timeline.revision)
      && ['pending', 'running', 'failed'].includes(str(object(latest.background).phase)) ? latest : undefined
`
export function applySettlementRoundTransform(source) {
  const signature = 'function pendingSettlementBody(chat)'
  if (source.split(signature).length !== 2 || !source.includes('  ' + signature + ' {\n')) throw new Error('结算轮次接缝函数锚点未命中/不唯一')
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || source.split(PATCHED).length !== 2) throw new Error('结算轮次接缝标记存在但正文不完整/不唯一')
    return source
  }
  if (source.split(ORIGINAL).length !== 2) throw new Error('结算轮次接缝锚点未命中/不唯一')
  return source.replace(ORIGINAL, () => PATCHED)
}
