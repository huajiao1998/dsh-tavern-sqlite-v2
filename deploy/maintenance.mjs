#!/usr/bin/env node
// V2注释块接缝装卸入口：完整服务端卡VM/ESM/MVU；原有Node VM旗标是安装硬前提。
// adapter 只暴露块机制四件套 + 有限 targets：**无 uninstallAllSeams**——旧 legacy 施缝链不再由本入口消费。
import {applyStandardSeams,checkStandardSeams,uninstallStandardSeams,inspectStandardSeamsPlan,maintenanceTargets} from './standard-seams.mjs'
import {runCli} from './maintenance/runner.mjs'
export const maintenanceAdapter=Object.freeze({
 packageName:'dsh-tavern-sqlite-v2',line:'v2',execution:'server-vm-esm',requiresVmModules:true,
 ownedId:'dsh-tavern-storage-author-host-v2',hostMarker:'[dsh-tavern-core-host:v1]',otherHostMarker:'[dsh-tavern-v1-storage-host:v1]',
 targets:maintenanceTargets,applyStandardSeams,checkStandardSeams,uninstallStandardSeams,inspectStandardSeamsPlan,
})
runCli(import.meta.url,maintenanceAdapter)
