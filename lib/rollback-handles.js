// 活动句柄必须与已提交SQLite长度对齐；异常向上传播，不以warning冒充成功。
export function rewindRollbackHandles(handles, id, eventCount) {
  if (!handles || typeof handles[Symbol.iterator] !== 'function') throw new Error('回退清理：缺少活动句柄注册表')
  if (!Number.isSafeInteger(eventCount) || eventCount < 0) throw new Error('回退清理：无效eventCount')
  for (const handle of handles) {
    if (handle?.id !== id) continue
    if (handle.access === 'write' && (!handle.state || typeof handle.state !== 'object')) throw new Error('回退清理：写句柄缺少游标状态')
    if (handle.state !== undefined) {
      handle.state.cursor = eventCount
      handle.state.primed = undefined
      handle.state.tornTruncateTo = undefined
      handle.state.recoveredTail = undefined
    }
    handle.observedLength = eventCount
    if (handle.observedLength !== eventCount || (handle.state !== undefined &&
      (handle.state.cursor !== eventCount || handle.state.primed !== undefined || handle.state.tornTruncateTo !== undefined || handle.state.recoveredTail !== undefined))) {
      throw new Error('回退清理：活动句柄回卷后置核对失败')
    }
  }
}
