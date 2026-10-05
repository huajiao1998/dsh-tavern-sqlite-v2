# 沙箱策略的薄缝（部署件）—— 把 ⑮b / ⑮c 的**内联逻辑**换成"取我们包"的调用

> 配套模块：[sandbox-policy](<../lib/sandbox-policy.js>)（`activityFor` / `wrapGenerateRaw` / `hookBudget`）。
> **2026-10-01当前适用边界**：下文是LAB旧adapter/node:vm方案的历史接线规格，不可照抄B锚点。B作者2.4现已本地通过 [标准统一入口](<standard-seams.mjs>)消费服务端runtime/policy：adapter读当前事务投影给generateRaw，Host注入作者generateHelperRaw/callModel；加载/派发strict、活动预算/取消资源与回程绑定均有定向断言。**现场未部署/未页面验收**，准确进度见 [PLG-008/013](<../../../docs/workstreams/plugin/TASKS.md>)。
> 基础 [S1/S2入口](<apply-seams.mjs>)单独执行仍不覆盖这条完整链；标准包装以新进程import前接入，不能从「LAB有整文件基线」推导可整份覆盖作者index。以下仅保留历史源码规格。

---

## 1. `lib/domain/tavern-script-host-adapter.js`

### 1.1 顶部加一条 import（新增缝）
```js
import { activityFor, wrapGenerateRaw } from 'dsh-tavern-storage-sqlite-v2/sandbox-policy'
```

### 1.2 原 ⑮b 的四处内联改动，改成下面这样

**① 删掉补丁加的这一行**（注册表移到我们包里）：
```js
  const sandboxActivities = new Map()   // [t3-generate-raw] cardPath → { pending }
```

**② 桩 → 薄调用**（原补丁的内联 async 函数体整体删除）：
```js
      generate: unsupportedApi('generate'),
      // [t3-generate-raw] 策略在 dsh-tavern-storage-sqlite-v2/lib/sandbox-policy.js
      generateRaw: wrapGenerateRaw({ bindingOf, options, activity, str }),
```

**③ 函数签名**（与补丁一致）：
```js
  function makeSandboxHostApi(cardPath, activity) {
```

**④ runtime 创建处**（与补丁一致）：
```js
    const activity = activityFor(cardPath)
    const runtime = getOrCreateRuntime(cardPath, sources, makeSandboxHostApi(cardPath, activity), 8000, onDomAccess, { awaitTimeoutMs: 180000 })
```
（原来的 `const activity = sandboxActivities.get(...)` / `if (!activity) { ... }` 两行由 `activityFor()` 取代。）

**行为等价性**：`wrapGenerateRaw` 的判据/错误文案/计数时机/字符串对齐与补丁内联版逐句一致
（历史自检回执13/13见 [装配沿革§27](<../../../issues/plugin-integration-plan.md>)；本包没有对应可复现policy测试文件，不能指test/说已入库。本轮未运行测试）。

---

## 2. `lib/domain/mvu/mvu-card-runtime.js`

### 2.1 顶部加一条 import（新增缝）
```js
import { hookBudget } from 'dsh-tavern-storage-sqlite-v2/sandbox-policy'
```

### 2.2 函数签名（与补丁一致）
```js
export function createCardScriptRuntime({ cardPath, sources, hostApi, timeoutMs = 8000, logger = console, onDomAccess, activity = null, awaitTimeoutMs = 180000 }) {
```

### 2.3 原来的"内联 unref 轮询 Promise"整体换成一行调用
**删掉**补丁插入的这一整段（`const budget = new Promise(...)` …），**改成**：
```js
          await Promise.race([
            e.handler(...args),
            hookBudget({ isSettled: () => settled, activity, timeoutMs, awaitTimeoutMs }),
          ])
```
（`settled` 是该处作用域里的作者局部变量 —— 以闭包传入，算法本身在我们包里。）

**行为等价性**：`hookBudget` 复刻原逻辑（默认 `timeoutMs`／在飞时 `awaitTimeoutMs`／每 250ms、在飞时 500ms 轮询／
定时器 `unref`／`settled` 早退／两种超时文案）；13/13只作历史自检回执，缺包内可复现文件，不是本轮或B实测。

---

## 3. 两个host数字已抽常量，但仍需接缝

[budgets模块](<../lib/budgets.js>)已集中scriptClaimMs=180000/serverTemplateMs=900000，规格见 [budgets接缝](<budgets.seams.md>)。撤回旧“刻意不抽/将来再集中”口径；集中不消灭作者锚点。本轮B仍30000/120000，没有读取BUDGETS，主入口未覆盖。浏览器③⑤⑭不在该host常量表，不能混称所有预算已集中。

---

## 4. 后续计划（不是执行许可）

先选B执行路线并核对接口/解析/资源释放，再决定是否纳入唯一apply/check/uninstall入口；本规格不自动改补丁链或启动服务。若获准适配LAB方案，需避免⑮b/c双重施加，并验证调用窗口/字符串返回/计数回收/活动预算、无生成防护与页面探针。现有13/13和副本8/8都不能替代目标E2E。