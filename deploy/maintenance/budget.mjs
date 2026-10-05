// 包已就绪后的成功路径共用60秒；失败恢复独立计时，不冒报成功。
import { performance } from 'node:perf_hooks'
export function maintenanceBudget({ milliseconds = 60000, elapsed = 0, now = () => performance.now() } = {}) {
  const start = now() - elapsed
  return {
    elapsed: () => Math.max(0, now() - start),
    remaining(limit = Infinity) {
      const left = milliseconds - (now() - start)
      if (left <= 0) throw new Error('安装/卸载超过60秒成功预算；不冒报成功，若已修改则进入安全恢复')
      return Math.max(1, Math.floor(Math.min(limit, left)))
    },
  }
}
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
