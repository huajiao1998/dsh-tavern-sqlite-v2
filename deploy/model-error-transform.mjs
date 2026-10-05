// 未注册是动态网关路由尚未可用，不要求用户给网关名字另写代码。
const MARKER = '// [dsh-tavern-model-route-error:v1]'
export function applyModelErrorTransform(source) {
  if (source.includes(MARKER)) return source
  const anchor = "  const message = String(error?.message ?? error ?? '')"
  if (source.split(anchor).length !== 2) throw new Error('模型错误展示接缝锚点不唯一')
  return source.replace(anchor, `${anchor}
  ${MARKER}
  if (error?.code === 'NO_ADAPTER' || /no adapter registered for provider/i.test(message)) {
    const route = message.match(/provider "([^"]+)"/)?.[1] || ''
    const result = new Error('模型网关' + (route ? '「' + route + '」' : '') + '尚未成为可用路由。请在模型设置中确认协议、地址和模型已保存，待路由出现后重试；网关名称不需要单独开发适配器。')
    result.code = 'NO_ADAPTER'
    return result
  }`)
}
