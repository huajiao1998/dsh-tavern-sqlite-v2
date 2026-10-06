const jsonrepair = jsonrepairModule.default ?? jsonrepairModule.jsonrepair ?? jsonrepairModule
const JSON5 = JSON5Module.default ?? JSON5Module

// 宽容解析链（移植自 MagVarUpdate util/common.ts parseString）：YAML(merge) → JSON5 → JSON(jsonrepair) → YAML
// 依赖来自包内 vendor（**安装零外部依赖**，见 lib/vendor/VENDOR.md）：桌面版宿主离线装包时
// pnpm 没有这些包的元数据，只有把运行时依赖打进包内才能保证任何宿主都能离线安装。
import YAML from '../vendor/yaml/dist/index.js'
import * as JSON5Module from '../vendor/json5/index.mjs'
import * as jsonrepairModule from '../vendor/jsonrepair/esm/index.js'

export function parseString(content) {
    const jsonFirst = /^[[{]/s.test(content.trimStart())
    try {
        if (jsonFirst) throw Error('expected error')
        return YAML.parseDocument(content, { merge: true }).toJS()
    } catch (yamlError1) {
        try {
            return JSON5.parse(content)
        } catch (json5Error) {
            try {
                return JSON.parse(jsonrepair(content))
            } catch (jsonError) {
                try {
                    if (!jsonFirst) throw Error('expected error')
                    return YAML.parseDocument(content, { merge: true }).toJS()
                } catch (yamlError2) {
                    throw new Error(
                        `无法解析内容：YAML(${yamlError2?.message}) / JSON5(${json5Error?.message}) / JSON(${jsonError?.message})`
                    )
                }
            }
        }
    }
}
