// rc.2内存客户端增量缝：只复用逻辑follow，不触发connection/reset/reconnect。
import {ROLLBACK_INSTALLER} from './rollback-sync-install-transform.mjs'
import {applySessionCutSyncClientTransform} from './session-cut-sync-client-transform.mjs'
const KEY='$dsh-tavern/rollback-sync-v1'
const MARKER='// [dsh-tavern-rollback-sync-client:v1]'
function once(text,old,next){if(text.split(old).length!==2)throw Error('同连接客户端锚点漂移：'+old.slice(0,90));return text.replace(old,next)}
const METHOD=`waitForTavernRollbackSync(receipt) {
                if (receipt?.protocol !== 1 || typeof receipt.chatId !== "string" || typeof receipt.id !== "string" || !Number.isSafeInteger(receipt.revision)) return Promise.reject(new Error("回退缺少同连接同步回执"));
                const waiters = this.tavernRollbackWaiters ??= new Set();
                const check = () => {
                    const known = this.tavernRollbackReceipts?.get(receipt.chatId);
                    if (!known || known.revision < receipt.revision) return null;
                    if (known.revision > receipt.revision) return Promise.resolve(false);
                    if (known.id !== receipt.id) return Promise.reject(new Error("回退同步版本身份冲突"));
                    return known.task;
                };
                return new Promise((resolve, reject) => {
                    let settled = false;
                    const complete = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); waiters.delete(finish); if (error) reject(error); else resolve(value); };
                    const finish = () => { const task = check(); if (!task) return; waiters.delete(finish); task.then(value => complete(null, value), error => complete(error)); };
                    const timer = setTimeout(() => complete(new Error("回退已落盘，但同连接同步未到达或未完成；请重开页面")), 8000);
                    waiters.add(finish); finish();
                });
            }
            applyTavernRollbackSync(receipt) {
                if (receipt?.protocol !== 1 || typeof receipt.id !== "string" || !receipt.id || typeof receipt.chatId !== "string" || !Number.isSafeInteger(receipt.revision) || !Array.isArray(receipt.sessions) || !receipt.sessions.length) throw new Error("回退同步回执无效");
                const seen = this.tavernRollbackReceipts ??= new Map();
                const known = seen.get(receipt.chatId);
                if (known && receipt.revision < known.revision) return Promise.resolve(false);
                if (known && receipt.revision === known.revision) {
                    if (known.id !== receipt.id) throw new Error("回退同步版本身份冲突");
                    return known.task;
                }
                const ids = new Set();
                for (const row of receipt.sessions) {
                    if (typeof row.sessionId !== "string" || ids.has(row.sessionId) || !Number.isSafeInteger(row.asOfSeq) || row.asOfSeq < -1 || !row.values || typeof row.values !== "object" || !Array.isArray(row.queues) || !Array.isArray(row.jobs)) throw new Error("回退同步状态基线无效");
                    ids.add(row.sessionId);
                }
                if (!ids.has(receipt.sessionId)) throw new Error("回退同步缺少前台会话");
                const record = { id: receipt.id, revision: receipt.revision, task: null };
                seen.set(receipt.chatId, record);
                const tasks = [];
                for (const row of receipt.sessions) {
                    const store = this.projectionStore(row.sessionId);
                    store.tavernRollbackGeneration = (store.tavernRollbackGeneration ?? 0) + 1;
                    // 清掉所有水位，包括与新基线seq相等的旧值和新基线不再具有的键。
                    for (const key of [...store.rows.keys()]) { store.rows.delete(key); store.changed(key); }
                    store.seed({ asOfSeq: row.asOfSeq, values: row.values });
                    this.queues.set(row.sessionId, row.queues);
                    if (row.jobs.length) this.jobsBySession.set(row.sessionId, row.jobs); else this.jobsBySession.delete(row.sessionId);
                    this.recordMutation({ kind: "tavern-rollback", sessionId: row.sessionId, running: row.running, blank: row.blank });
                    const session = this.sessions.get(row.sessionId);
                    if (session) {
                        session.replaceControl(row.queues);
                        session.handleRunning(row.running); session.handleBlank(row.blank);
                        // 普通blank relay是单调的，回退完整基线允许由非空恢复为空。
                        session.blankBit = row.blank; session.firstPromptPendingTurn = false;
                        if (row.blank) session.promptAttempted = false;
                        tasks.push(session.resync());
                    }
                    const parent = row.parentSessionId;
                    if (parent) {
                         this.updateCatalogActivity(row.sessionId, false);
                         if (this.catalogInflight.has(parent)) this.catalogStale.add(parent);
                         else if (this.catalogs.has(parent)) this.scheduleCatalogRefresh(parent);
                     }
                }
                this.notifier.markDirty();
                record.task = Promise.all(tasks).then(() => seen.get(receipt.chatId) === record);
                try { this.tavernRollbackNotify?.(receipt); } catch (error) { record.task = record.task.then(() => { throw error; }); }
                for (const notify of this.tavernRollbackWaiters ?? []) notify();
                return record.task;
            }
            `
export function applyRollbackSyncClientTransform(source){
 if(source.includes(MARKER)){if(source.split(MARKER).length!==2 || !source.includes(METHOD) || !source.includes('const rollbackGenerations = new Map(') || !source.includes('const generation = ++this.openGeneration;') || !source.includes('if (rollbackGeneration !== (this.projectionStore(parentSessionId).tavernRollbackGeneration ?? 0)) return;'))throw Error('同连接客户端标记不完整');return applySessionCutSyncClientTransform(source.includes(ROLLBACK_INSTALLER)?source:once(source,'return module.exports;',ROLLBACK_INSTALLER+'\nreturn module.exports;'))}
 let out=MARKER+'\n'+source
 out=once(out,'handleControlFrame(frame) {\n\t\t\t\tif (frame.type === "baseline")',`handleControlFrame(frame) {\n                if (frame.type === "projection" && frame.key === ${JSON.stringify(KEY)}) {\n                    try { this.applyTavernRollbackSync(frame.value).catch(error => console.error("回退后同连接同步失败", error)); } catch (error) { console.error("回退后同连接同步失败", error); }\n                    return;\n                }\n\t\t\t\tif (frame.type === "baseline")`)
 out=once(out,'\t\t\thandleControlFrame(frame) {\n\t\t\t\tthis.manager.handleControlFrame(frame);',`            waitForTavernRollbackSync(receipt) { return this.manager.waitForTavernRollbackSync(receipt); }\n\t\t\thandleControlFrame(frame) {\n\t\t\t\tthis.manager.handleControlFrame(frame);`)
 out=once(out,'\t\t\tprojectionStore(sessionId) {','            '+METHOD+'projectionStore(sessionId) {')
 out=once(out,'this.manager = new SessionManager(remote, restored.sessionId, restored.subagentAddress);','this.manager = new SessionManager(remote, restored.sessionId, restored.subagentAddress);\n                this.manager.tavernRollbackNotify = receipt => rootCtx.emit("tavern-storage/rollback-synced", receipt);')
 const old=`async resync() {
                if (this.openState === "cold") return;
                this.openGeneration++;
                const events = this.events;
                this.events = void 0;
                await events?.dispose();
                this.openPromise = null;
                this.openState = "cold";
                this.openError = null;
                this.baseSeq = SessionLogOffset(0);
                this.notifier.markDirty();
                await this.open();
            }`.replace(/^ {16}/gm,'\t\t\t\t').replace(/^ {12}\}/gm,'\t\t\t}')
 const next=`async resync() {
                if (this.openState === "cold" && !this.tavernResyncTask) return;
                const generation = ++this.openGeneration;
                const events = this.events;
                this.events = void 0;
                const previous = this.tavernResyncTask;
                const task = (async () => {
                    await events?.dispose();
                    await previous?.catch(() => {});
                    if (generation !== this.openGeneration) return;
                    this.openPromise = null; this.openState = "cold"; this.openError = null;
                    this.baseSeq = SessionLogOffset(0);
                    this.loadingOlder = false; this.jumpTargetSeq = null; this.jumpPromise = null;
                    this.notifier.markDirty();
                    await this.open();
                    if (generation === this.openGeneration && this.openState !== "open") throw this.openError ?? new Error("回退正文同步没有完成");
                })();
                this.tavernResyncTask = task;
                try { await task; } finally { if (this.tavernResyncTask === task) this.tavernResyncTask = null; }
            }`
 out=once(out,old,next)
 // 回退取消旧分页不是业务错误；旧finally也不能改掉新代的loading/jump状态。
 out=once(out,'async loadOlder() {\n\t\t\t\tif (this.openState','async loadOlder() {\n                const generation = this.openGeneration;\n\t\t\t\tif (this.openState')
 out=once(out,'} catch (error) {\n\t\t\t\t\tif (!(0, _deepseek_ai_dsh_api_gateway_client.isRemoteFailure)(error)) console.error("[session-controller] loadOlder failed:", error);','} catch (error) {\n                    if (generation !== this.openGeneration) return;\n\t\t\t\t\tif (!(0, _deepseek_ai_dsh_api_gateway_client.isRemoteFailure)(error)) console.error("[session-controller] loadOlder failed:", error);')
 out=once(out,'} finally {\n\t\t\t\t\tthis.loadingOlder = false;\n\t\t\t\t\tthis.notifier.markDirty();','} finally {\n                    if (generation === this.openGeneration) { this.loadingOlder = false; this.notifier.markDirty(); }')
 out=once(out,'} catch (error) {\n\t\t\t\t\t\tif (!(0, _deepseek_ai_dsh_api_gateway_client.isRemoteFailure)(error)) console.error("[session-controller] loadThrough failed:", error);','} catch (error) {\n                        if (generation !== this.openGeneration) return;\n\t\t\t\t\t\tif (!(0, _deepseek_ai_dsh_api_gateway_client.isRemoteFailure)(error)) console.error("[session-controller] loadThrough failed:", error);')
 out=once(out,'this.jumpTargetSeq = null;\n\t\t\t\t\t\tthis.jumpPromise = null;\n\t\t\t\t\t\tthis.loadingOlder = false;\n\t\t\t\t\t\tthis.notifier.markDirty();','if (generation === this.openGeneration) { this.jumpTargetSeq = null; this.jumpPromise = null; this.loadingOlder = false; this.notifier.markDirty(); }')
 // 正在路上的session.list读结果不得把回退前投影重新安装；列表元数据由mutation日志合并。
 out=once(out,'const mutations = [];\n\t\t\t\tthis.listMutations = mutations;','const mutations = [];\n                const rollbackGenerations = new Map([...this.projectionStores].map(([id, store]) => [id, store.tavernRollbackGeneration ?? 0]));\n\t\t\t\tthis.listMutations = mutations;')
 out=once(out,'const store = this.projectionStore(s.sessionId);\n\t\t\t\t\t\t\t\tconst values = block.values;','const store = this.projectionStore(s.sessionId);\n                                if ((rollbackGenerations.get(s.sessionId) ?? 0) !== (store.tavernRollbackGeneration ?? 0)) continue;\n\t\t\t\t\t\t\t\tconst values = block.values;')
 out=once(out,'switch (mutation.kind) {\n\t\t\t\tcase "upsert": {','switch (mutation.kind) {\n                case "tavern-rollback": return summaries.map(summary => summary.sessionId === mutation.sessionId ? { ...summary, running: mutation.running, blank: mutation.blank } : summary);\n\t\t\t\tcase "upsert": {')
 out=once(out,'const previous = this.catalogs.get(parentSessionId);','const previous = this.catalogs.get(parentSessionId);\n                const rollbackGeneration = this.projectionStore(parentSessionId).tavernRollbackGeneration ?? 0;')
 out=once(out,'const result = await this.remote.subagents.list(parentSessionId);','const result = await this.remote.subagents.list(parentSessionId);\n                        if (rollbackGeneration !== (this.projectionStore(parentSessionId).tavernRollbackGeneration ?? 0)) return;')
 return applySessionCutSyncClientTransform(once(out,'return module.exports;',ROLLBACK_INSTALLER+'\nreturn module.exports;'))
}
