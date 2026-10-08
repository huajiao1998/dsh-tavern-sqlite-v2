// 只验有限恢复资产：pin字节可读、旧代目标集完整且新bridge为空、新代字节身份可核（不依赖tmp夹具、不联网）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  loadAuthorCleanImages, AUTHOR_IMAGES_SHA256, assertAuthorRecoveryCoverage,
  OPTIONAL_AUTHOR_TARGETS, OWNED_BRIDGE_TARGETS
} from '../deploy/maintenance/residual-uninstall.mjs'
import { OPTIONAL_IMAGE_TARGETS } from '../deploy/author-compatibility.mjs'
import { maintenanceTargets } from '../deploy/standard-seams.mjs'
const BRIDGE = 'tavern-plugin/lib/domain/storage-db-save.js'
const OLD = ['5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60', '9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544', '5c69907994df9f432b8898168ce5dff371929c2a', '8480f7deb9b645d396bfbd75092810a8b8ad70b2']
const B741 = 'b74135535ec0b37b11ed77f252dd034c3ce5e285', DD875 = 'dd8757c8b32c5f92152339bed2599c949752a5ce'
// storage-native-data.js 是本包自有桥（S2 起的受管目标），随包目录永不收录其键；不滤掉会 56!==57（2026-10-08 既有偏差，本轮修正口径）。
const NATIVE_DATA_REL = 'tavern-plugin/lib/domain/storage-native-data.js'
const ALLOWED = [...maintenanceTargets.filter(rel => rel.endsWith('.js') && rel !== NATIVE_DATA_REL), 'tavern-plugin/package.json']
// 0.3.4 新增的唯一 optional 受管目标：4 棵旧 tree 无该键（保持原 scope，不补 null key）
const GAME_REL = 'tavern-plugin/lib/domain/game-footprint.js'
const OLD_ALLOWED = ALLOWED.filter(rel => rel !== GAME_REL)
const GAME_SHA256 = '01e3c4e853ca2a16a44f71586e9eee60ff5ce430ccfc09a63e5688116b9f7c9a'
const ASSET_SHA256 = '03cebeef587c3d28b93c41bb71645aff590953bc8c2245c57bf6108d9b11203f'
const NEW_APP = '04bda78eaad25adfe6979cb211a17fd85d852393', NEW_MAIN = '68215e47516637e00c75d2b4bba3192679559425'
// 04bda78 官方 manifest(dsh-tavern-runtime.json @68215e47) 声明的变动 target 字节
const CHANGED_04 = {
  'tavern-plugin/lib/index.js': '933fb276598d57b75da37067f3bdc178f98c208f2d66d2ee8358662d3456d287',
  'tavern-plugin/lib/client.js': '574eac928f00a50eb6874f626b91197bf0d8e2b6f1169ea4ecedee57efb96b9c',
  'tavern-plugin/lib/background-agent-task.js': '6db9f4c90f4748495f277f9b29a92e5458ee643b0ee5614e1cdf18f6d778c86e'
}
// 旧树冻结指纹（compact JSON；本轮新增新代树不得改动它们）
const FROZEN = {
  '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60': 'b90166ce5ca352139a15dae9feb464e6783063c8c88441734d25168611324976',
  '9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544': '30c03f6916ecb5bfc6fc5898f89a51e0b6cf3d580fb88111ce44da9fe6f48c16',
  '5c69907994df9f432b8898168ce5dff371929c2a': '029ad200bf5dae3db37570eedd6fe2169e9437f3dcf568b0edba1f05f10b118d',
  '8480f7deb9b645d396bfbd75092810a8b8ad70b2': 'ccb9811c617c5b44a17f3491c98b6ad8f135dd062b29f67081d3356dfc7ac0f8',
  'b74135535ec0b37b11ed77f252dd034c3ce5e285': '2110c28515225a0f938b5a474976bedcacbd68bc7d26a3fde8d518d7ed873e37',
  'dd8757c8b32c5f92152339bed2599c949752a5ce': '2110c28515225a0f938b5a474976bedcacbd68bc7d26a3fde8d518d7ed873e37'
}
// 公开官方字节固定哈希（raw flizzywine/dsh-tavern b7413553 canonical，不依赖本地下载物）
const EXPECTED = {
  'tavern-plugin/lib/index.js': '4673eba20ffc362a75125b08cc42164792408f4ab631e0f510853643a6d100a7',
  'tavern-plugin/src/client/main.js': 'ef2123ad1454a52ba858e2cfd830966e65dcb1c18888a98b6ca693e18dfb9942',
  'tavern-plugin/lib/http/routes.js': '598ff75c391a5a72cfad27e6122348850c5215f69bfef0bf5b2242bba3dfdaff',
  'tavern-plugin/package.json': '5e6dc5961d202cfb165f16e824749f7650fea1b5615dd04654bcd0cc646884ea'
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
test('DB新桥接恢复资产各旧代完整且为空', () => {
  const catalog = loadAuthorCleanImages()
  assert.equal(catalog.version, 1); assert.equal(catalog.package, 'dsh-tavern-sqlite-v2')
  for (const commit of OLD) {
    const tree = catalog.trees.find(item => item.commit === commit)
    assert.ok(tree, '缺旧代 tree：' + commit)
    const keys = new Set(Object.keys(tree.files))
    for (const rel of OLD_ALLOWED) assert.ok(keys.has(rel), commit + ' 缺维护目标：' + rel)
    assert.equal(keys.size, OLD_ALLOWED.length, commit + ' 键数不等于旧代维护目标集')
    assert.equal(tree.files[BRIDGE], null, '旧代不存在的新bridge必须为空：' + commit)
    for (const rel of ['tavern-plugin/lib/domain/chat-sqlite-store.js', 'tavern-plugin/lib/domain/storage-package.js', 'tavern-plugin/lib/domain/legacy-view-seams.js']) assert.equal(tree.files[rel], null, '旧代官方不存在的shim必须为空：' + rel)
  }
})
test('DB最新b741恢复资产字节身份与来源完整', () => {
  assert.equal(AUTHOR_IMAGES_SHA256, ASSET_SHA256)
  const catalog = loadAuthorCleanImages()
  for (const commit of [B741, DD875]) {
    const tree = catalog.trees.find(item => item.commit === commit)
    assert.ok(tree, '缺新代 tree：' + commit)
    assert.equal(tree.authorVersion, '2.5.0')
    assert.equal(Object.keys(tree.files).length, ALLOWED.length)
    for (const rel of ALLOWED) assert.ok(Object.hasOwn(tree.files, rel), commit + ' 缺维护目标：' + rel)
    assert.equal(tree.files[GAME_REL]?.sha256, GAME_SHA256, commit + ' 新可选删局模块字节身份不符')
    for (const [rel, item] of Object.entries(tree.files)) {
      if (item === null) continue
      assert.equal(sha(Buffer.from(item.body, 'base64')), item.sha256, commit + ' 字节与摘要不符：' + rel)
    }
  }
  const b741 = catalog.trees.find(item => item.commit === B741), dd875 = catalog.trees.find(item => item.commit === DD875)
  for (const [rel, expected] of Object.entries(EXPECTED)) {
    assert.equal(b741.files[rel]?.sha256, expected, 'canonical 官方字节哈希不符：' + rel)
    assert.deepEqual(dd875.files[rel], b741.files[rel], 'dd875 与 b741 同字节身份不符：' + rel)
  }
  assert.equal(b741.files[BRIDGE], null, '本包新bridge在官方b741不存在，必须为空')
})
test('DB新代04bda78恢复资产字节身份与旧树冻结', () => {
  const catalog = loadAuthorCleanImages()
  const app = catalog.trees.find(item => item.commit === NEW_APP), main = catalog.trees.find(item => item.commit === NEW_MAIN)
  assert.ok(app && main, '缺新代 tree：' + NEW_APP + '/' + NEW_MAIN)
  for (const tree of [app, main]) {
    assert.equal(tree.authorVersion, '2.5.0')
    assert.equal(Object.keys(tree.files).length, ALLOWED.length)
    assert.equal(Object.values(tree.files).filter(item => item === null).length, 12)
    assert.equal(tree.files[GAME_REL]?.sha256, GAME_SHA256, tree.commit + ' 新可选删局模块字节身份不符')
  }
  const b741 = catalog.trees.find(item => item.commit === B741)
  assert.deepEqual(Object.keys(app.files).filter(rel => app.files[rel] === null), Object.keys(b741.files).filter(rel => b741.files[rel] === null), '新代 null 模式与 b741 不同')
  assert.deepEqual(app.files, main.files, '两新树 target 字节应相同（仅 pin 不同）')
  for (const [rel, item] of Object.entries(app.files)) {
    if (item === null) continue
    assert.equal(sha(Buffer.from(item.body, 'base64')), item.sha256, '新代字节与摘要不符：' + rel)
    if (CHANGED_04[rel]) assert.equal(item.sha256, CHANGED_04[rel], '变动 target 非官方新字节：' + rel)
    else assert.deepEqual(item, b741.files[rel], '未变 target 未复用 b741 已验证字节：' + rel)
  }
  for (const [commit, digest] of Object.entries(FROZEN)) {
    const tree = catalog.trees.find(item => item.commit === commit)
    assert.ok(tree, '缺旧树：' + commit)
    // 旧树原指纹：移除本轮新增的唯一 optional 键后再算（常量不替换、不洗历史）
    const original = Object.fromEntries(Object.entries(tree.files).filter(([rel]) => rel !== GAME_REL))
    assert.equal(sha(Buffer.from(JSON.stringify(original), 'utf8')), digest, '旧树指纹被改动：' + commit)
  }
})

// 3100d223（main seq 556）相对 68215e47 的全部变动受管 target；来源＝官方 runtime manifest @3100d223。
const MAIN_2 = '3100d223d9837a3fe78ab1aa4b8617b805309bcc'
const CHANGED_31 = {
  'tavern-plugin/lib/index.js': '5155cce6e0ace9a1c9d4e9109d0c17e87200010a586298089286b4fb4df5b351',
  'tavern-plugin/lib/client.js': 'e502213b72e6a6354a15cb5e670c001ae74b539351f2d363ea3e601e633697da',
  'tavern-plugin/lib/background-agent-task.js': '0888153bffe05ddad701357aa59b17e3fb03b67092be9db60afc28f3ff488b9d',
  'tavern-plugin/lib/background-agent-sessions.js': 'e2ddaa8019f1b36c58f935ebf8920f5182c5e12693f9a7227fd412d7ce6fffa1',
  'tavern-plugin/src/client/features/play-controls.js': '705353055ef1c39ae9884d59d33246ac7684a93e216fb8534f51ff22f01af79b',
  'tavern-plugin/lib/domain/turn-orchestration.js': '4b63bd5808eae0ce89f40b7a03df687ce3583272e5f35d3be6c660df58981890',
  'tavern-plugin/lib/domain/tavern-conversation-registry.js': '5f46d421a91e8065f594f1f0511f88dfced2b13a6ad4151aa2a2e68852ba8a75',
}
test('DB3100d223恢复资产追加树身份与七变动字节', () => {
  const catalog = loadAuthorCleanImages()
  const tree = catalog.trees.find(item => item.commit === MAIN_2)
  assert.ok(tree, '缺 3100d223 树')
  assert.equal(tree.authorVersion, '2.5.0')
  assert.equal(Object.keys(tree.files).length, ALLOWED.length, '键数必须等于维护目标集（不含自有桥）')
  assert.equal(Object.values(tree.files).filter(item => item === null).length, 12, 'owned null 键数与 68215e47 同')
  const main = catalog.trees.find(item => item.commit === NEW_MAIN)
  assert.ok(main, '缺 68215e47 对照树')
  for (const [rel, item] of Object.entries(tree.files)) {
    if (CHANGED_31[rel]) {
      assert.equal(item.sha256, CHANGED_31[rel], '变动 target 非官方新字节：' + rel)
      assert.equal(sha(Buffer.from(item.body, 'base64')), item.sha256, '字节与摘要不符：' + rel)
    } else {
      assert.deepEqual(item, main.files[rel], '未变 target 未复用 68215e47 已验证字节：' + rel)
    }
  }
  assert.equal(Object.keys(CHANGED_31).length, 7, '3100d223 相对 68215e47 恰七个变动受管 target')
})

// ══════════════════════════════════════════════════════════════════════════════════
// 目录覆盖门禁（0.3.5：防 TARGETS 新增后卸载破损）。校验路径＝真实卸载同一 trustedImages，
// 全部用**内存构造的目录副本**做负例：冻结 gz 的内容与字节都不动（下方断言以 gz 摘要固定）。
// ══════════════════════════════════════════════════════════════════════════════════
const GZ = new URL('../deploy/maintenance/author-clean-images.json.gz', import.meta.url)
const ADAPTER = () => ({ packageName: 'dsh-tavern-sqlite-v2', targets: maintenanceTargets })
const cloneCatalog = () => structuredClone(loadAuthorCleanImages())
const firstTree = catalog => catalog.trees[0]
/** 目录里第一条"必需受管目标"（非 optional/非自有桥、且首树确有该键）。 */
const requiredRelIn = tree => Object.keys(tree.files).find(rel => rel.endsWith('.js') && !OPTIONAL_AUTHOR_TARGETS.includes(rel) && !OWNED_BRIDGE_TARGETS.includes(rel))

test('目录覆盖门禁在真目录与真实维护目标集上通过', () => {
  const catalog = loadAuthorCleanImages()
  assert.equal(assertAuthorRecoveryCoverage({ catalog, adapter: ADAPTER() }), catalog.trees.length, '真目录必须整体通过覆盖门禁')
  // 声明一致（单一真相）：本模块 OPTIONAL 白名单必须与 author-compatibility 的声明逐字相同
  assert.deepEqual(OPTIONAL_AUTHOR_TARGETS, OPTIONAL_IMAGE_TARGETS, 'OPTIONAL 受管目标声明必须与 author-compatibility 一致')
  assert.deepEqual(OWNED_BRIDGE_TARGETS, ['tavern-plugin/lib/domain/storage-native-data.js'], 'OWNED 桥白名单必须只含本包自有桥')
  // 门禁参数守卫：缺 adapter/目标集即拒（不静默通过）
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog }), /缺少 adapter/, '缺 adapter 必须响亮失败')
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog, adapter: { packageName: 'dsh-tavern-sqlite-v2', targets: 'x' } }), /缺少 adapter/, 'targets 非数组必须响亮失败')
})

test('目录覆盖门禁拒绝未声明的新目标', () => {
  const catalog = cloneCatalog()
  const a = ADAPTER()
  assert.equal(assertAuthorRecoveryCoverage({ catalog, adapter: a }), catalog.trees.length, '前置：未加目标时通过')
  const declared = { packageName: a.packageName, targets: [...a.targets, 'tavern-plugin/lib/domain/never-declared.js'] }
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog, adapter: declared }), /有限目标不完整/, '新增未声明目标（目录全树缺该键）必须被拒')
})

test('目录覆盖门禁拒绝任一树缺必需键', () => {
  const catalog = cloneCatalog()
  const tree = firstTree(catalog)
  const rel = requiredRelIn(tree)
  assert.ok(rel, '夹具需至少一个必需受管目标键')
  delete tree.files[rel]
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog, adapter: ADAPTER() }), /有限目标不完整/, '任一树缺必需键必须被拒：' + rel)
  // 只缺一棵树也必须拒（不得只看首树）
  const catalog2 = cloneCatalog()
  const last = catalog2.trees.at(-1)
  delete last.files[requiredRelIn(last)]
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog: catalog2, adapter: ADAPTER() }), /有限目标不完整/, '末树缺必需键必须被拒')
})

test('目录覆盖门禁拒绝越界键', () => {
  const catalog = cloneCatalog()
  const body = Buffer.from('export const notATarget = 1\n', 'utf8')
  firstTree(catalog).files['tavern-plugin/lib/domain/not-a-target.js'] = { body: body.toString('base64'), sha256: sha(body) }
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog, adapter: ADAPTER() }), /越过有限作者目标/, '目录含不在 targets 的 .js 键必须被拒')
  // 字节摘要不符同样被拒（防止目录被改后仍放行）
  const catalog2 = cloneCatalog()
  const tree2 = firstTree(catalog2)
  const rel2 = requiredRelIn(tree2)
  tree2.files[rel2] = { body: tree2.files[rel2].body, sha256: 'f'.repeat(64) }
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog: catalog2, adapter: ADAPTER() }), /字节校验失败/, '摘要不符必须被拒：' + rel2)
})

test('目录覆盖门禁放行optional与自有桥缺键且不修改目录', () => {
  const gzBytes = readFileSync(GZ)
  assert.equal(sha(gzBytes), AUTHOR_IMAGES_SHA256, '冻结目录 gz 摘要必须等于 pin（前置）')
  const catalog = loadAuthorCleanImages()
  const keySets = catalog.trees.map(tree => Object.keys(tree.files).sort().join(','))
  const gzBefore = sha(readFileSync(GZ))
  assert.equal(assertAuthorRecoveryCoverage({ catalog, adapter: ADAPTER() }), catalog.trees.length)
  // ① 未把 optional/自有桥"补 null"写回目录对象：键集逐树不变
  catalog.trees.forEach((tree, index) => assert.equal(Object.keys(tree.files).sort().join(','), keySets[index], '门禁不得改写目录键集：' + tree.commit))
  // ② 该 image 确实缺这些键的树，读出来仍是 undefined（没有 null 注入）
  for (const tree of catalog.trees) {
    for (const rel of [...OPTIONAL_AUTHOR_TARGETS, ...OWNED_BRIDGE_TARGETS]) {
      if (!keySets[catalog.trees.indexOf(tree)].split(',').includes(rel)) assert.equal(tree.files[rel], undefined, '缺键不得被归一成 null 写回：' + rel)
    }
  }
  // ③ 冻结 gz 字节未变
  assert.equal(sha(readFileSync(GZ)), gzBefore, '门禁不得改动冻结 gz 字节')
})

test('目录覆盖门禁拒绝自有桥伪装作者字节', () => {
  const catalog = cloneCatalog()
  const tree = firstTree(catalog)
  // 把本包自有桥的字节（含 owned 标记）塞进目录并配正确摘要 ⇒ 必须被认作插件接管代码而拒
  const bridgeBody = Buffer.from("// [dsh-tavern-standard-owned:v1]\nexport const bridge = true\n", 'utf8')
  tree.files[OWNED_BRIDGE_TARGETS[0]] = { body: bridgeBody.toString('base64'), sha256: sha(bridgeBody) }
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog, adapter: ADAPTER() }), /插件接管代码/, '自有桥不得伪装成作者字节')
  // 同名键塞入插件包名字样同样被拒（ownCode 判据覆盖包名形态）
  const catalog2 = cloneCatalog()
  const injected = Buffer.from("export const x = 'dsh-tavern-sqlite-v2'\n", 'utf8')
  firstTree(catalog2).files[OWNED_BRIDGE_TARGETS[0]] = { body: injected.toString('base64'), sha256: sha(injected) }
  assert.throws(() => assertAuthorRecoveryCoverage({ catalog: catalog2, adapter: ADAPTER() }), /插件接管代码/, '含插件包名字样的前像同样必须被拒')
})
