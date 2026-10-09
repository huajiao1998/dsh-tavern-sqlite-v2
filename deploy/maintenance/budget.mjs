// 包已就绪后的成功路径共用一份预算；失败恢复独立计时，不冒报成功。
//
// 预算按**宿主形态**分档：Windows 桌面版一次源码接缝预演实测约 37 秒（反病毒扫描 + 逐文件读写 +
// 逐文件 `node --check` 子进程）；0.3.8 注释区块机制预检/预演/施缝三轮全量解析，2026-10-09 188
// 真机实测合计约 75–85 秒，旧 60 秒经验值会顶穿正常路径，POSIX/CLI 放宽到 180 秒。
import { performance } from 'node:perf_hooks'
export const SUCCESS_BUDGET_MS = { default: 180000, desktop: 240000 }
export function successBudgetMs(host) {
  return host === 'desktop' ? SUCCESS_BUDGET_MS.desktop : SUCCESS_BUDGET_MS.default
}
export function maintenanceBudget({ milliseconds = SUCCESS_BUDGET_MS.default, elapsed = 0, now = () => performance.now() } = {}) {
  const start = now() - elapsed
  return {
    elapsed: () => Math.max(0, now() - start),
    remaining(limit = Infinity) {
      const left = milliseconds - (now() - start)
      if (left <= 0) throw new Error('安装/卸载超过成功预算 ' + Math.round(milliseconds / 1000) + ' 秒；不冒报成功，若已修改则进入安全恢复')
      return Math.max(1, Math.floor(Math.min(limit, left)))
    },
  }
}
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
