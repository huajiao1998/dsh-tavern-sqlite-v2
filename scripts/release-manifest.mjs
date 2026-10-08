// 发行产物 manifest（canonical 共享纯函数，供 build-release 与契约测试共用，不另造发布流程）。
//
// 背景（188 实证）：`file:` 安装走 pnpm 目录打包时，**不在 manifest.files 里的根文件会被丢弃**
// （0.3.1 因此漏掉根 `INSTALL.zh-CN.md`），且 pnpm 重写的 package.json 不带末尾换行，
// 导致维护入口 `samePackage()` 判定“安装后包字节不是选定本地代”。
// 因此：①产物 manifest.files 必须显式包含根安装指南（源 package.json 不能加——源根没有该文件，
// `packageFiles(root)` 会直接 throw）；②产物 JSON 用 JSON.stringify(...,null,2) 且**不加末尾换行**，
// 与 pnpm 目录打包的实际字节一致（Unicode 转义行为也按 JS 引擎，不用 Python 侧再规范化）。
export const RELEASE_GUIDE = 'INSTALL.zh-CN.md'

export function makeReleaseManifest(pkg) {
  if (!pkg || typeof pkg !== 'object' || !Array.isArray(pkg.files)) throw new Error('发行 manifest 需要源 package.json 的 files 数组')
  const files = pkg.files.filter(rel => rel !== 'test/**')
  if (!files.includes(RELEASE_GUIDE)) files.push(RELEASE_GUIDE)
  return { ...pkg, files }
}

export function releaseManifestJson(pkg) {
  return JSON.stringify(makeReleaseManifest(pkg), null, 2)
}
