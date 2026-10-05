// V2 浏览器界面脚本（browser-ui）的窗口寿命门禁转换。
//
// 为什么 V2 仍需要这一组：V2 是**服务端执行**线，但 server-execution 的分类器把 DOM/浏览器
// façade 脚本判为 'browser-ui' —— 这类脚本**不在服务端执行**，命中即落 card-script-dispatch
// 标记并在下次分派时交回浏览器（见 lib/server-execution.js L45/L121-143）。因此 V2 **确实**
// 保留 browser-ui 的 iframe 脚本窗口；官方 MVU 计算核心不在该窗口运行。
// 只要该窗口存在，「窗口已销毁后旧微任务仍回写 UI/flush」就是真实缺陷 → 本组转换对 V2 同样成立。
//
// client-seams 同时装入 built 和确切 source include 的 bootstrap/runtime。
// V2 不装入官方 MVU loader 的 jQuery Proxy，也不搬 V1 浏览器计算计时器机制。
//
// 注意（本次同步的取用边界）：`REPLACE_BOOK` 那一条**不是浏览器专用**，它是 current 资源的
// 配套守卫（current 令牌下 token 相等不代表值相同）。该条已单独提取进
// session-current-resource-transform.mjs 的 applyCurrentResourceBookGuardTransform，
// 本文件仍按 V1 原样保留在 pairs 里，以维持与 V1 的同源可对账性。

const BOOT='// [dsh-tavern-ui-lifetime-bootstrap:v1]',RUNTIME='// [dsh-tavern-ui-lifetime-runtime:v1]'
function once(s,a,b){if(s.split(a).length!==2)throw Error('UI生命周期锚点缺失/不唯一：'+a.slice(0,90));return s.replace(a,b)}
const STATE='\t\t\tlet state = initialContext && typeof initialContext === "object" ? initialContext : {};'
const LIFETIME=`            ${BOOT}
            let helperUiDisposed = false;
            const mountedVueApps = new Set();
            function uiRuntimeIsActive() { return !helperUiDisposed && !window.closed; }
            function uiRuntimeEnded() { const error = new Error("人物卡脚本窗口已销毁，取消旧界面任务"); error.code = "TAVERN_SCRIPT_RUNTIME_DISPOSED"; return error; }
            function disposeScriptRuntime() {
                if (helperUiDisposed) return;
                helperUiDisposed = true;
                for (const app of Array.from(mountedVueApps)) { try { app.unmount(); } catch (_) {} }
                mountedVueApps.clear();
                initializationTiming.dispose();
            }
            window.__dshTavernDisposeScriptRuntime = disposeScriptRuntime;
            window.__dshTavernUiLifetime = {run:factory=>withScript("__dsh_official_mvu__",factory)};
            window.addEventListener("pagehide", disposeScriptRuntime, { once: true });
            window.addEventListener("unload", disposeScriptRuntime, { once: true });
            // 官方bundle拿的是这个iframe的Vue；只拦销毁，不掩盖活窗口挂载错误。
            if (window.Vue && typeof window.Vue.createApp === "function") {
                const createApp = window.Vue.createApp;
                window.Vue.createApp = function (...args) {
                    if (!uiRuntimeIsActive()) throw uiRuntimeEnded();
                    const app = createApp.apply(this, args), mount = app.mount, unmount = app.unmount;
                    app.mount = function (...values) {
                        if (!uiRuntimeIsActive()) throw uiRuntimeEnded();
                        const result = mount.apply(this, values); mountedVueApps.add(app); return result;
                    };
                    app.unmount = function (...values) { try { return unmount.apply(this, values); } finally { mountedVueApps.delete(app); } };
                    return app;
                };
            }
${STATE}`
const RES='            const resources = modules.createResourceReader();',RES_NEXT='            const resources = modules.createResourceReader({isActive:uiRuntimeIsActive});'
const WS='\t\t\tasync function withScript(scriptId, factory) {',WS_NEXT=WS+'\n                if (!uiRuntimeIsActive()) return undefined;'
const AWAIT='                    const result = await initializationTiming.wait("script-callback", pending, ownerId); if (facade) await facade.flushVariables(ownerId); await initializationTiming.wait("prompt-drain", drainPromptWrites(ownerId), ownerId); return result; }'
const AWAIT_NEXT='                    const result = await initializationTiming.wait("script-callback", pending, ownerId); if (!uiRuntimeIsActive()) return undefined; if (facade) await facade.flushVariables(ownerId); if (!uiRuntimeIsActive()) return undefined; await initializationTiming.wait("prompt-drain", drainPromptWrites(ownerId), ownerId); return result; }'
const CATCH='                catch (error) {\n                    // Keep the innermost owner, including failures after await and',CATCH_NEXT='                catch (error) {\n                    if (!uiRuntimeIsActive() || error?.code === "TAVERN_SCRIPT_RUNTIME_DISPOSED") return undefined;\n                    // Keep the innermost owner, including failures after await and'
const REPLACE_BOOK='                    if (state.worldbook?.resourceAccess?.token === access.token) state.worldbook = copy(book);',REPLACE_BOOK_NEXT='                    if (!access.current && state.worldbook?.resourceAccess?.token === access.token) state.worldbook = copy(book);'
const pairs=[[STATE,LIFETIME],[RES,RES_NEXT],[WS,WS_NEXT],[AWAIT,AWAIT_NEXT],[CATCH,CATCH_NEXT],[REPLACE_BOOK,REPLACE_BOOK_NEXT]]
export function applyBrowserUiLifetimeBootstrapTransform(s){
 if(s.includes(BOOT)){if(pairs.some(([,b])=>s.split(b).length!==2))throw Error('UI生命周期bootstrap标记不完整');return s}
 for(const[a,b]of pairs)s=once(s,a,b);return s
}
const REMOVE='\t\t\t\trecord.frame.remove();',REMOVE_NEXT=`                ${RUNTIME}
                // 同源受信窗口先unmount再移除；opaque窗口由window.closed门禁兜住旧微任务。
                try { record.frame.contentWindow?.__dshTavernDisposeScriptRuntime?.(); } catch (_) {}
${REMOVE}`
const LOAD='\t\t\tif (scriptId === "__dsh_official_mvu__") source = "const $ = window.jQuery;\\n" + source;'
const LOAD_NEXT=`            // [dsh-tavern-ui-lifetime-loader:v1]
            // 受信模式切成宿主jQuery会越过bootstrap.fn.ready包装；官方ready仍回本窗口寿命门禁。
            if (scriptId === "__dsh_official_mvu__") source = "const __jq = window.jQuery, __life = window.__dshTavernUiLifetime; const $ = new Proxy(__jq,{apply(target,receiver,args){if(typeof args[0]===\\\"function\\\"){const callback=args[0];return Reflect.apply(target,receiver,[function(...values){return __life.run(()=>callback.apply(this,values));},...args.slice(1)]);}return Reflect.apply(target,receiver,args);}});\\n" + source;`
export function applyBrowserUiLifetimeLoaderTransform(s){
 if(s.includes('// [dsh-tavern-ui-lifetime-loader:v1]')){if(s.split(LOAD_NEXT).length!==2)throw Error('UI生命周期loader标记不完整');return s}
 return once(s,LOAD,LOAD_NEXT)
}
export function applyBrowserUiLifetimeRuntimeTransform(s){
 if(s.includes(RUNTIME)){if(s.split(REMOVE_NEXT).length!==2)throw Error('UI生命周期runtime标记不完整');return s}
 return once(s,REMOVE,REMOVE_NEXT)
}
