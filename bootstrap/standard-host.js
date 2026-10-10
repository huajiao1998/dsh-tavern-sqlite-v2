// 正常启动只验安装时保存的区块；持久模式退出不撤缝，完整卸载由维护入口负责。
export { apply } from '../lib/standard-host.js'
// 等本次启动的同一 SQLite 后端与宿主补丁就绪；无需用户每次安装或执行额外命令。
export const inject = ['loader', 'sessionPersistence', 'tavernStorageBootstrapReady']
