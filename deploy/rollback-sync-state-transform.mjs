// 作者2.5读所有权：reader使旧cursor失效；live沿作者现成refresh.replace撤销旧读，不另造世代层。
function once(s,a,b){if(s.split(a).length!==2)throw Error('回退状态锚点漂移：'+a.slice(0,80));return s.replace(a,b)}
export function applyRollbackViewReaderTransform(source){
 const marker='// [dsh-tavern-rollback-view-reader:v1]'
 const reset='begin.rebase = function (sessionId) { generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1); const owner = pending.get(sessionId); if (owner) owner.latest = null; sessions.delete(sessionId); };'
 const guard='if (generation !== (generations.get(sessionId) ?? 0)) throw new Error("回退前状态读已过期");'
 if(source.includes(marker)){if(source.split(marker).length!==2 || !source.includes(reset) || !source.includes(guard) || !source.includes('  return begin;'))throw Error('回退reader标记不完整');return source}
 let out=marker+'\n'+source
 out=once(out,'const sessions = new Map();','const sessions = new Map();\n  const generations = new Map();')
 out=once(out,'return function begin(sessionId) {','function begin(sessionId) {\n    const generation = generations.get(sessionId) ?? 0;')
 // 世代拒绝位于作者try/finally内，仍按其release归还在飞请求计数。
 out=once(out,'if (released) throw new Error("会话读取已取消");','if (released) throw new Error("会话读取已取消");\n        '+guard)
 out=once(out,'  };\n}\n\n// Weak array-version keys','  };\n  '+reset+'\n  return begin;\n}\n\n// Weak array-version keys')
 return out
}
export function applyRollbackLiveViewTransform(source){
 const marker='// [dsh-tavern-rollback-live-view:v1]'
 const reset=`\t\trebase: function (sessionId) {
\t\t\tconst record = recordFor(sessionId);
\t\t\trecord.refresh.replace();
\t\t\trecord.optimisticBusy = false;
\t\t\trecord.optimisticOwner = null;
\t\t\tif (record.listeners.size > 0) record.refresh.request();
\t\t},`
 if(source.includes(marker)){if(source.split(marker).length!==2 || !source.includes(reset) || !source.includes('if (!scope.isCurrent()) return;'))throw Error('回退live view标记不完整');return source}
 // 2.5本身拥有epoch/abort以及水合后scope.isCurrent守卫；只添加撤销并重读消费者。
 for(const required of ['function createRefresh(record)', 'return createSessionRefreshController({', 'if (!scope.isCurrent()) return;'])if(!source.includes(required))throw Error('作者2.5 live读所有权布局漂移：'+required)
 return once(marker+'\n'+source,'\t\tevict: evict,',reset+'\n\t\tevict: evict,')
}
