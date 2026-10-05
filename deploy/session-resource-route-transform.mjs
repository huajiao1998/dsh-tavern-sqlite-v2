// 当前资源不缓存HTTP结果；403仅带安全原因码，不记录cap、URL、chat或载荷。
const M='// [dsh-tavern-v1-resource-route:v1]'
const A="            res.writeHead(200, headers); res.end(json)\n          } catch (_) {\n            res.writeHead(403, {...headers, 'Cache-Control':'no-store'})\n            res.end(JSON.stringify({error:'Resource unavailable; refresh the session'}))"
const B=`            ${M}
            res.writeHead(200, {...headers,'Cache-Control':'no-store'}); res.end(json)
          } catch (error) {
            res.writeHead(403, {...headers, 'Cache-Control':'no-store'})
            const reason = error?.code === 'DSH_TAVERN_REVISION_NOT_FOUND' ? 'RESOURCE_REVISION_UNAVAILABLE'
              : error?.message === 'Invalid resource capability' ? 'RESOURCE_CAPABILITY_INVALID' : 'RESOURCE_UNAVAILABLE';
            res.end(JSON.stringify({error:'资源不可用，请刷新会话',errorCode:reason}))`
export function applySessionResourceRouteTransform(s){
 if(s.includes(M)){if(s.split(B).length!==2)throw Error('资源路由标记不完整');return s}
 if(s.split(A).length!==2)throw Error('资源路由锚点缺失/不唯一');return s.replace(A,B)
}
