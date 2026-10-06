// vm 能力选路：决定卡脚本运行时跑在**本进程**还是**Worker 线程**。
//
// 背景（2026-10-06 真机实测）：Windows 桌面版酒馆的 harness 是 Electron `utilityProcess`
// （打包应用），其 `vm.SourceTextModule` 为 undefined，且两条外部注入路线都被 Electron
// 的 node_bindings 白名单挡死：①环境变量 `NODE_OPTIONS`（官方报错 "Most NODE_OPTIONs are
// not supported in packaged apps"）；②给 `utilityProcess.fork` 缝 `execArgv`（flag 到达子进程
// argv 但不生效，探针实锤）。
//
// 唯一可行路径：Node `worker_threads` 的 `execArgv` 是**纯 Node API**，不经 Electron 过滤
// ——实测 Worker 内 `vm.SourceTextModule`/`SyntheticModule` 可用，且完整 link+evaluate+
// 顶层 await + 合成模块 + 宿主函数注入全部通过。
//
// 因此：**有 vm 走原路（Linux/macOS/Windows CLI 版，今天验证过的进程内路径，行为零变化）；
// 没 vm 才走 Worker**。本模块只做判定，不引入任何行为变化。
import vm from 'node:vm'

/** Node 启动参数名：服务端 ESM 卡脚本所需的实验旗标 */
export const VM_MODULES_FLAG = '--experimental-vm-modules'

/** 本进程是否具备服务端 ESM 所需的 vm 能力（缺一则必须走 Worker） */
export function hasInProcessVmModules() {
  return typeof vm.SourceTextModule === 'function' && typeof vm.SyntheticModule === 'function'
}

/**
 * 选路：返回 'in-process' 或 'worker'。
 * 判定只看**本进程真实能力**，不看平台/宿主名（能力驱动，不猜环境）。
 */
export function selectRuntimeHost() {
  return hasInProcessVmModules() ? 'in-process' : 'worker'
}
