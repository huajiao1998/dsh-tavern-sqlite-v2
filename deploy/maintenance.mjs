#!/usr/bin/env node
// V2标准装卸入口：完整服务端卡VM/ESM/MVU；原有Node VM旗标是安装硬前提。
import {applyStandardSeams,checkStandardSeams,uninstallStandardSeams,maintenanceTargets} from './standard-seams.mjs'
import {uninstallAllSeams} from './apply-seams.mjs'
import {runCli} from './maintenance/runner.mjs'
export const maintenanceAdapter=Object.freeze({
 packageName:'dsh-tavern-sqlite-v2',line:'v2',execution:'server-vm-esm',requiresVmModules:true,
 ownedId:'dsh-tavern-storage-author-host-v2',hostMarker:'[dsh-tavern-core-host:v1]',otherHostMarker:'[dsh-tavern-v1-storage-host:v1]',
 targets:maintenanceTargets,applyStandardSeams,checkStandardSeams,uninstallStandardSeams,uninstallAllSeams,
})
runCli(import.meta.url,maintenanceAdapter)
