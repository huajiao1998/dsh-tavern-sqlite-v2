// 有界等待只报告失败，绝不把超时当作静止；原任务未结算时屏障保持。
export async function awaitRollbackQuiescence(task, timeoutMs = 8000, timeoutMessage = '回退静止等待超时；未开始物理删除，原任务结束前继续禁止新任务') {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('回退静止超时参数无效')
  let timer
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}
