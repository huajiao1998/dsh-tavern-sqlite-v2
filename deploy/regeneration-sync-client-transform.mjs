// 首次提交与补同步分开；补同步从服务端取当前基线，不缓存旧控制快照。
const MARKER='// [dsh-tavern-regeneration-client-sync:v2]'
const OLD_MARKER='// [dsh-tavern-regeneration-client-sync:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('重生成同步接缝缺失/不唯一：'+old.slice(0,90));return source.replace(old,next)}
export function applyRegenerationSyncClientTransform(source){
 if(source.includes(MARKER))return source
 const upgrading=source.includes(OLD_MARKER)
 const start=source.indexOf('async function submitBodyRegeneration('),end=source.indexOf('// A failed turn',start)
 if(start<0||end<start)throw Error('重生成同步函数接缝缺失')
 source=once(source,source.slice(start,end),`async function submitBodyRegeneration(sessionId, panel, guidance, sessions) {
            const syncOnly = panel.submitted === true;
            panel.operationId ||= "regen-" + Date.now() + "-" + Math.random().toString(36).slice(2);
            panel.submitted = true;
            const res = await rpc("regenBody", { guidance: String(guidance || "").trim(), syncOnly: syncOnly, operationId: panel.operationId }, sessionId);
            try {
                // push负责安装当前基线；直接wait让既有8秒超时覆盖消息重读。
                await sessions.waitForTavernRollbackSync(res.view.adopted.sync);
            } catch (error) {
                throw new Error("正文已替换，页面同步失败；可重试页面同步。" + String(error.message || error));
            }
            setCandidatePanel(null);
        }

        `)
 if(upgrading){
  source=once(source,OLD_MARKER,MARKER)
  source=once(source,'submitLabel: panel.sync ? "重试页面同步" : "生成并替换正文",','submitLabel: panel.submitted ? "重试完成同步" : "生成并替换正文",')
 }else{
  source=MARKER+'\n'+source
  source=once(source,'await submitBodyRegeneration(props.sessionId, panel, guide);','await submitBodyRegeneration(props.sessionId, panel, guide, props.sessions);')
  source=source.includes('submitLabel: "生成并替换正文",')
   ? once(source,'submitLabel: "生成并替换正文",','submitLabel: panel.submitted ? "重试完成同步" : "生成并替换正文",')
   : once(source,'onClick: generate }, "生成并替换正文")','onClick: generate }, panel.submitted ? "重试完成同步" : "生成并替换正文")')
  source=once(source,'React.createElement(RegenPanel, props)','React.createElement(RegenPanel, Object.assign({}, props, { sessions: ctx.sessions }))')
 }
 return source
}
