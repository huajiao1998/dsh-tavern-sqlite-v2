// 回归闸：并发装配者对 INSTALLED 守卫的抢占（2026-09-30 洁净实例事故）
//
// 事故原始形态：cordis 并发 apply 各条 entry（Promise.allSettled），作者那条
// dsh-tavern-plugin 与我们这条 host-patch 都会调 installHostSessionPatch，两边的
// 幂等守卫都在函数**末尾**才 defineProperty ⇒ 双方都通过守卫，后到者抛
//   TypeError: Cannot redefine property: Symbol(dsh-tavern.host-session-patch.v1)
// ⇒ plugin tree failed to load ⇒ 酒馆起不来。
//
// 本闸只依赖 node 内置（不需要宿主 @deepseek-ai 包），可在任何机器上跑：
//   node test/claim-guard.test.mjs
import assert from 'node:assert/strict'
import { claimHostSessionPatch, SESSION_PATCH_VERSION } from '../lib/domain/host-session-patch.js'

const INSTALLED = Symbol.for('dsh-tavern.host-session-patch.v1')

// 1) 首次同步占位：必须是**句柄形状**
const persistence = {}
const first = claimHostSessionPatch(persistence)
assert.equal(first.ok, true, '空实例上应能占位')
assert.equal(first.claim, persistence[INSTALLED], '占位对象必须就是守卫值')
const claim = persistence[INSTALLED]
assert.equal(typeof claim.view, 'function', '作者 entry 早返回后会调 view()')
assert.equal(claim.view().status, 'pending')
assert.equal(claim.view().hostVersion, SESSION_PATCH_VERSION, 'hostVersion 必须真实上报，否则作者的旧档迁移会被跳过')
assert.equal(typeof claim.dispose, 'function')

// 2) 作者的早返回分支会往占位上挂 loadSessionCatalog ⇒ 占位必须可扩展
claim.loadSessionCatalog = async () => ({})
assert.equal(typeof claim.loadSessionCatalog, 'function', '占位对象必须可扩展')

// 3) 守卫属性必须可配置：否则对手那句 defineProperty 就是原事故的 "Cannot redefine property"
assert.equal(Object.getOwnPropertyDescriptor(persistence, INSTALLED).configurable, true, '守卫必须 configurable:true')

// 4) 我们自己重复占位：认作自己人（幂等，不误判成"别人装了"）
assert.equal(claimHostSessionPatch(persistence).ok, true, '自己的占位应被识别')

// 5) 别人已装真句柄：必须让位（不重复安装、不抛、不覆盖）
const foreign = { view: () => ({ status: 'ready', hostVersion: SESSION_PATCH_VERSION }), dispose() {} }
const other = { [INSTALLED]: foreign }
const taken = claimHostSessionPatch(other)
assert.equal(taken.ok, false, '已有真句柄时不应再装')
assert.match(taken.reason, /已安装/)
assert.equal(taken.existing, foreign)
assert.equal(other[INSTALLED], foreign, '不能覆盖别人的句柄')

// 6) 拿不到服务：让位而不是抛
assert.equal(claimHostSessionPatch(undefined).ok, false)
assert.equal(claimHostSessionPatch(null).ok, false)

console.log('claim-guard: 6 组断言全部通过')
