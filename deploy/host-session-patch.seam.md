# host-session-patch 接线缝——拆作者安装点，改调共享安装器

> 2026-10-01对照 [实际工具](<apply-legacy-view-seams.mjs>)更正文档：旧“删调用/删文件”不是现行实施方案。由 [主入口](<apply-seams.mjs>)统一预检/记录/检查/卸载，本文只说明设计，不提供新的施缝/重启许可。

## 为什么不能保留作者自己的安装调用

作者树 `lib/index.js:19` 有：
```js
import { installHostSessionPatch } from './domain/host-session-patch.js'
```
（并在其 `apply` 里调用它）。我们已把该补丁**整份搬进本包**（`lib/domain/host-session-patch.js` + 入口 `host-patch.js`，由 `cordis.patch.yml` 的第二条 row 装配）。

**为什么不留垫片转出**：补丁安装器自带幂等守卫 —— `installHostSessionPatch()` 内部以 `persistence[INSTALLED]`（`Symbol.for('dsh-tavern.host-session-patch.v1')`）判重。
若作者树那份**仍在先安装**，我们插件里那次调用就变成 **no-op**（补丁仍由作者树那份提供）⇒ **"改文件即回退"。
⇒ 要让补丁真正由**我们的包**拥有，必须拆掉作者自己的安装调用；但作者仍要真实sessionPatch句柄，不能只删调用。现行工具**不删除作者同名文件**，它已不再由主入口import/安装。

## 现行接线

1. [legacy变换器](<apply-legacy-view-seams.mjs>)移除主入口旧import，添加legacy/shared installer桥；原调用替换为 `const sessionPatch = await installAuthorHostSessionPatch(ctx)`。
2. 桥调包的 [共享入口](<../lib/host-session-install.js>)，与 [host-patch row](<../host-patch.js>)同步claim并await同一ready promise；两消费者拿真实句柄。接管owned-seams通过全局注册表钉回，不靠代理REASSERT救覆盖。
3. 工具拥有四个作者模块和一个新shim，不拥有/删除作者host-session-patch文件；apply/check/uninstall与manifest范围见 [PLG审计§3](<../../../docs/workstreams/plugin/AUDIT-2026-10-01.md>)。单次安装/同句柄/代理/失败撤销仍需独立定向断言，设计不等于已测试。

## 验证

1. 起服后看日志：应出现我们的入口打的
   `[dsh-tavern-storage-sqlite-v2] 宿主会话补丁：ready`（或 `skipped`/`failed` + 原因）；
2. **限定作者主入口**检查：旧 `installHostSessionPatch(` 调用与 `from './domain/host-session-patch.js'` import均退役，shared bridge在。不要全树搜安装器名称判失败：未删除的作者模块仍会有定义，包内真实实现也应存在；`installAuthorHostSessionPatch`不是旧调用名的子串。
3. 只说明安装器就绪，不等于回退消费者已接。B当前软隐藏链缺口见 [PLG-011](<../../../docs/workstreams/plugin/TASKS.md>)；后续回退测试另授权，须整链L1/L1.5/L1.6/L1.7/L4与UI判据，不在本文自动运行。