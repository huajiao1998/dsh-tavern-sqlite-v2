// 最新一次发送的统一撤销目标（视图 overlay，合同 2026-10-13）。
//   目标函数由主实现：lib/latest-send.js → lib/clean-rollback.js re-export → 作者树 ./storage-rollback.js 垫片转出。
//   本接缝只做三件事：①补 import；②在 rollbackViewFields 包装里取「最新发送目标」；
//   ③覆盖 canRollback / canClearIncompleteReply=false / rollbackTarget。
//   不按终态、不按错误白名单、不在此处做静止门（静止与执行由主 clean-rollback 负责）。
import { parse } from '../lib/vendor/acorn/acorn.mjs'
const MARKER='// [dsh-tavern-latest-send-undo:v1]'
const LEGACY_OVERLAY=`    // [dsh-tavern-latest-send-undo:v1]
    // 最新一次发送（任意终态/无输出/部分输出/未知）都给出统一撤销目标；错误资格不再参与签发。
    const latestSend = latestSendTarget(chat, evidence, Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision)
    // legacy pending（进行中/重试中）保留原 base：不得把 canClearIncompleteReply 抹成 false 丢掉失败清理重试。
    // latestSend 为 null 时**不得**回落到更早一轮（原生有新轮但无基准 ⇒ 只能不可回退，由 base.reason 说明）。
    const withLatestSend = (base) => {
      const pendingLegacy = base !== null && typeof base === 'object' && base.rollbackPending === true
      // latestSend 为 null 时只认「严格 native-only 目标（最新空尾）」或 legacy pending；
      // 绝不让旧 body failureTarget 回落误选更早轮。
      const legacyNativeOnly = base !== null && typeof base === 'object' && base.failureTarget !== null && typeof base.failureTarget === 'object'
        && base.failureTarget.kind === 'native-only' ? base.failureTarget : null
      const keepLegacyTarget = pendingLegacy ? (base.failureTarget === undefined ? null : base.failureTarget) : legacyNativeOnly
      return { ...base,
        canRollback: latestSend !== null ? true : (pendingLegacy ? base.canRollback === true : (legacyNativeOnly !== null && base.canRollback === true)),
        canClearIncompleteReply: pendingLegacy ? base.canClearIncompleteReply === true : false,
        rollbackTarget: latestSend !== null ? latestSend : (pendingLegacy && base.rollbackTarget !== undefined ? base.rollbackTarget : null),
        // 旧错误入口读 failureTarget：统一 alias 到最新发送目标并清空失败清理原因；
        // null 时只保留严格 native-only / legacy pending，绝不 alias 旧 body 轮。
        failureTarget: latestSend !== null ? latestSend : keepLegacyTarget,
        failureCleanupReason: latestSend !== null ? '' : (keepLegacyTarget === null ? '' : base.failureCleanupReason),
        rollbackUnavailableReason: latestSend !== null ? '' : base.rollbackUnavailableReason }
    }
`
// 最后施缝时真正删除active旧helper，而不是仅用overlay遮住分类器。旧字符串只留在升级识别变换中。
function retireFailureEligibility(source) {
  const helpers=parse(source,{ecmaVersion:'latest',sourceType:'module'}).body.filter(node=>node.type==='FunctionDeclaration' && ['latestFailureTarget','latestFailureCleanupReason'].includes(node.id?.name))
  if(source.includes('// [dsh-tavern-latest-failure-view:v1]') && ['latestFailureTarget','latestFailureCleanupReason'].some(name=>helpers.filter(node=>node.id.name===name).length!==1))throw Error('统一撤销兼容helper缺失或不唯一')
  const bodies={
    latestFailureTarget:`function latestFailureTarget(chat, replayTarget, evidence) {
  void replayTarget
  const pending=chat.rollbackPending
  if(pending?.failureTarget)return {...pending.failureTarget,chatId:chat.id,sessionId:chat.sessionId,rollbackId:pending.id}
  return inspectNativeFailureTail(chat,evidence,Number.isSafeInteger(chat.windowRevision)?chat.windowRevision:chat._storageRevision)?.target || null
}`,
    latestFailureCleanupReason:`function latestFailureCleanupReason(chat, replayTarget, evidence) {
  void replayTarget
  if(chat.rollbackPending)return ''
  return inspectNativeFailureTail(chat,evidence,Number.isSafeInteger(chat.windowRevision)?chat.windowRevision:chat._storageRevision)?.reason || ''
}`,
  }
  for(const node of helpers.toReversed())source=source.slice(0,node.start)+bodies[node.id.name]+source.slice(node.end)
  return source
}
function once(source,old,next,label){
  if(source.split(old).length!==2)throw Error((label||'最新发送撤销视图锚点缺失/不唯一')+'：'+old.slice(0,110))
  return source.replace(old,next)
}
const IMPORT='import { latestSendTarget } from \'./storage-rollback.js\'\n'
const SIGNATURE_OLD='  function rollbackViewFields(chat, evidence, changes) {\n'
const SIGNATURE_NEW='  function rollbackViewFields(chat, evidence = evidenceOf(chat.sessionId), changes) {\n'
const VALUE_LINE='    const value = rollbackViewFieldsBase(chat, evidence, changes)\n'
const RETURN_LINE='    return { ...value, rollbackTarget }\n'
export function applyLatestSendViewTransform(source){
  const nativeMarker='// [dsh-tavern-native-repair-rollback-view:v1]'
  if(source.includes(nativeMarker))return source
  if(source.includes('const hasRound = hasRollbackMessages(chat.messages)')) {
    let start=source.indexOf('  function rollbackViewFields(chat, evidence, changes) {')
    // 已装旧overlay也沿同一真实作者包装升级，不再要求旧签名。
    if(start<0)start=source.indexOf('  function rollbackViewFields(chat, evidence = evidenceOf(chat.sessionId), changes) {')
    const end=source.indexOf('  function rollbackViewFieldsBase(',start)
    if(start<0 || end<start)throw Error('新版统一回退视图包装缺失')
    const body=`  ${nativeMarker}
  function rollbackViewFields(chat, evidence = evidenceOf(chat.sessionId), changes) {
    const value = rollbackViewFieldsBase(chat, evidence, changes)
    const rollbackTarget = latestSendTarget(chat, evidence)
    return { ...value, rollbackTarget, failureTarget: rollbackTarget,
      canRollback: rollbackTarget !== null, canClearIncompleteReply: false,
      rollbackTargetTurn: rollbackTarget?.turn ?? null,
      failureCleanupReason: '', rollbackUnavailableReason: '' }
  }
`
    let next=source.slice(0,start)+body+source.slice(end)
    // 原生是否可定位不再参与回退资格；重新生成/错误显示等其余能力仍由作者计算。
    const from=next.indexOf('    const rollbackState = Array.isArray(nodes) ? rollbackAvailability(')
    const to=next.indexOf('    const replayTarget = ',from)
    if(from>=0 && to>from)next=next.slice(0,from)+"    const rollbackState = {canRollback: false, canClearIncompleteReply: false, reason: ''}\n"+next.slice(to)
    return next.includes(IMPORT)?next:IMPORT+next
  }
  if(source.includes(MARKER)){
    if(!source.includes('latestSendTarget(chat, evidence,')||!source.includes('withLatestSend({ ...value, rollbackTarget })')||!source.includes(SIGNATURE_NEW))throw Error('最新发送撤销标记存在但消费者不完整')
    if(!source.includes('rollbackTargetTurn: latestSend?.turn ?? keepLegacyTarget?.turn')) {
      // 已装dev.1必须原位升级菜单资格/轮次字段，不能因旧marker直接返回而只修新装。
      let stripped=once(source,LEGACY_OVERLAY,'','最新发送旧overlay被修改或不完整，拒绝猜删')
      stripped=once(stripped,SIGNATURE_NEW,SIGNATURE_OLD)
      stripped=once(stripped,'    return withLatestSend({ ...value, rollbackTarget })\n',RETURN_LINE)
      return applyLatestSendViewTransform(stripped)
    }
    return retireFailureEligibility(source)
  }
  let next=source.includes(IMPORT)?source:IMPORT+source
  // evidence 可能被调用方以 undefined 传入（现包装没有默认值）：必须补默认值，否则取不到原生最新轮。
  next=once(next,SIGNATURE_OLD,SIGNATURE_NEW,'最新发送撤销 evidence 默认值锚点缺失/不唯一')
  next=once(next,VALUE_LINE,`${VALUE_LINE}    ${MARKER}
    // 最新一次发送（任意终态/无输出/部分输出/未知）都给出统一撤销目标；错误资格不再参与签发。
    const latestSend = latestSendTarget(chat, evidence, Number.isSafeInteger(chat.windowRevision) ? chat.windowRevision : chat._storageRevision)
    // legacy pending（进行中/重试中）保留原 base：不得把 canClearIncompleteReply 抹成 false 丢掉失败清理重试。
    // latestSend 为 null 时**不得**回落到更早一轮（原生有新轮但无基准 ⇒ 只能不可回退，由 base.reason 说明）。
    const withLatestSend = (base) => {
      const pendingLegacy = base !== null && typeof base === 'object' && base.rollbackPending === true
      // latestSend 为 null 时只认「严格 native-only 目标（最新空尾）」或 legacy pending；
      // 绝不让旧 body failureTarget 回落误选更早轮。
      const legacyNativeOnly = base !== null && typeof base === 'object' && base.failureTarget !== null && typeof base.failureTarget === 'object'
        && base.failureTarget.kind === 'native-only' ? base.failureTarget : null
      const keepLegacyTarget = pendingLegacy ? (base.failureTarget === undefined ? null : base.failureTarget) : legacyNativeOnly
      return { ...base,
        canRollback: latestSend !== null ? true : (pendingLegacy ? base.canRollback === true : (legacyNativeOnly !== null && base.canRollback === true)),
        canClearIncompleteReply: latestSend !== null ? false : (pendingLegacy ? base.canClearIncompleteReply === true : legacyNativeOnly !== null),
        rollbackTargetTurn: latestSend?.turn ?? keepLegacyTarget?.turn ?? (pendingLegacy ? base.rollbackTargetTurn : null),
        rollbackTarget: latestSend !== null ? latestSend : (pendingLegacy && base.rollbackTarget !== undefined ? base.rollbackTarget : null),
        // 旧错误入口读 failureTarget：统一 alias 到最新发送目标并清空失败清理原因；
        // null 时只保留严格 native-only / legacy pending，绝不 alias 旧 body 轮。
        failureTarget: latestSend !== null ? latestSend : keepLegacyTarget,
        failureCleanupReason: latestSend !== null ? '' : (keepLegacyTarget === null ? '' : base.failureCleanupReason),
        rollbackUnavailableReason: latestSend !== null ? '' : base.rollbackUnavailableReason }
    }
`,'最新发送撤销取值锚点缺失/不唯一')
  next=once(next,RETURN_LINE,'    return withLatestSend({ ...value, rollbackTarget })\n','最新发送撤销返回锚点缺失/不唯一')
  return retireFailureEligibility(next)
}
