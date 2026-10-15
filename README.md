# DSH Tavern SQLite V2

**服务端 MVU 与卡脚本、SQLite 增量存档、历史按需读取，以及正文和状态一起回退。**

这是面向 [DSH Tavern](https://github.com/flizzywine/dsh-tavern) 的存储与服务端执行插件。保留酒馆界面，把聊天、会话事件和 MVU 变量历史交给 SQLite 管理；计算类脚本由服务端执行，浏览器保留界面职责。

[下载最新版](https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest) · [一键安装](#一键安装) · [原档继续使用](#原档怎么继续使用) · [详细安装说明](deploy/INSTALL.md) · [更新日志](CHANGELOG.md)

## 功能亮点

| 特点 | 为你解决什么问题 |
|---|---|
| **服务端 MVU 与卡脚本执行** | MVU 结算、卡脚本 VM / ESM 与 Helper 计算在服务端执行，减少对浏览器作为执行端的依赖；Windows 桌面版采用 Worker 适配，Linux CLI 保留原进程内执行路径。 |
| **SQLite 增量存档** | 聊天头字段、消息楼层分开存储，局部更新只处理变化部分，避免为了追加或修改一楼反复重写全部历史。会话事件由 SQLite 事务与 WAL 管理。 |
| **历史按需读取** | 消息窗口、指定楼层、结算检查点按范围读取；显示、后台配置与场景各取所需字段，不为取少量信息先复制整档。 |
| **MVU 变量历史瘦身** | 正文与变量归档使用同库、同连接事务；旧变量树先归档再退出热状态，近期楼层保留热窗口，查看旧楼按楼层和 swipe 补回并复用缓存。 |
| **真正的物理尾部回退** | 不是隐藏气泡：截断被撤销的事件尾部，回拨运行轮次和写句柄，重建内存投影并清理对应派生状态。 |
| **错误提示与失败轮次干净清理** | 失败轮有明确提示和清理入口。清理时恢复到该轮开始前的正文、变量与进度，并清掉对应的事件和运行状态；只处理当前最新失败轮，保留此前成功内容。 |
| **前后台同步恢复** | 同步受影响会话的状态、队列与任务基线，隔离旧任务、旧租约和迟到写入，避免撤销内容被重新写回。 |
| **原档保留，独立分叉继续玩** | 原档保持只读；用户主动创建新的聊天与原生会话身份，在 SQLite 新分叉中继续，源档及源链接保留。 |
| **一键安装，也能安全卸载** | Windows 解压后运行菜单，Linux 复制一条命令，默认自动识别酒馆。卸载按现场完整注释区块撤除本包注入（半截区块、归属不明、双源一律明确拒绝），保留原档与 SQLite 数据库，不把数据库档转回 JSON。 |

### 为什么不只是“换个数据库”？

- **少写**：头字段与楼层分别更新，只提交最终变化部分，减少无意义的全档比较和序列化。
- **少读、少复制**：按消费者需要投影数据，旧楼变量补数走有界缓存；不是把上下文砍短来换速度。
- **变量与正文一起提交**：同库同事务，归档失败整笔回滚，避免正文已经保存、变量却没跟上的半态。
- **回退到一致状态**：同时处理本档剧情、变量、进度与被撤销轮的运行数据；资源库原件和独立手工编辑不跟着剧情回退撤销。

以上是已实现的机制，不是“所有场景快几倍”的性能保证；冷读、新 revision 或显式全量读取仍可能处理较多历史，页面体验以实际环境为准。

## 一键安装

**已发布版本 0.4.13：适配酒馆上游 main `d189da12`（完整提交 `d189da122a8651c53ffc55ff465913f2e7f49d75`，Tavern **2.7.0**）。** 支持**最新一次发送的统一撤销**：不论该次发送成功、报错、被中断或只留下部分产物，都由你主动回退到发送前状态。 目标适配版本以对应 [Releases 更新说明](https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases)为准；其他未适配版本可能运行报错，请更新到标注的酒馆版本或自行适配插件。安装检查通过不代表运行期功能兼容。


已有兼容酒馆即可使用，**主命令无需填写版本或目录**。

### Windows 桌面版

1. 从 [Releases](https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest) 下载 `-win.zip`，解压到酒馆目录内。
2. 从托盘完全退出酒馆，进入解压出的插件文件夹，双击 [run-install.cmd](deploy/run-install.cmd)，选择安装。
3. 完成后重新启动酒馆。

更新、卸载、只读检查都在同一个菜单中；使用最新版安装器处理旧代。独立桌面包未额外安装 Node 时，安装器可复用它自带的运行时。

**0.3.0 也为“先装 DSH Desktop，再装酒馆”的形态提供适配**：仍是同一套安装器，用 `-TavernHome` 与 `-DesktopApp` 指明 home 和宿主安装根目录；维护需 PATH 或既有工具缓存中的 Node，建议 Node.js 24。菜单与进度实时显示，启动器不会因日志缺失重复执行。此形态已做源码及隔离验证，实机启动/页面仍待使用者确认；[预检与安装用法](deploy/INSTALL.md)。

### Linux CLI

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- install
```

默认从 `DSH_TAVERN_CLI_HOME`、`DSH_HOME`、当前工作目录和 `~/.dsh-tavern` 的已有 profile 自动识别酒馆。**找到唯一实例就直接继续，只有没找到或多个实例才提示人工选择**；不是正常安装必须手填路径，也不是全盘搜索任意自定义目录。

非默认位置可从酒馆 home 工作目录执行；systemd 启动参数准备、多实例选择及离线用法放在[详细安装说明](deploy/INSTALL.md)，不混进主命令。

## 读缓存控制

`DSH_TAVERN_SQLITE_CACHE_MAX_MB`（默认64MiB）和`DSH_TAVERN_SQLITE_MAX_CACHED_CHATS`（默认8）控制完整态及timeline行缓存的软预算和档数。任一设为0时关闭这些读缓存与投影缓存；非法值回落默认。单个超大档可以独占一个缓存槽，以保留长历史档的热读收益，因此软预算不是整个进程的RSS硬上限；完整态、投影和行缓存分别记账，连接行缓存不会同时保留多个超预算档。连接关闭、删档或dispose释放对应行缓存。

本store写入仍按实际写集精确失效；另一连接提交后，通过SQLite的`data_version`清理本档旧读取状态，避免新revision配旧timeline。使用多个store或连接读取同档时也遵守此规则。

## 原档怎么继续使用？

1. 安装后打开旧存档，以只读方式查看。
2. 由用户点击面板中的数据库分叉动作，生成新的 chatId 和原生 sessionId。
3. 在 SQLite 新分叉中继续对话和回退，原档不被自动迁移或覆盖。

人物卡、世界书资源库原件和独立用户配置不因为剧情回退撤销。

## 卸载与更新

Linux 一键卸载：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall
```

Windows 使用新包菜单的卸载/更新功能。**卸载保留原档与 SQLite 数据库，不把数据库档偷偷转回 JSON，也不代表原版可直接游玩插件的新分叉档。**

**现行卸载口径**：按现场完整注释区块撤除本包注入（依据 `BEGIN/END` 与 owner/id 归属），保留块外用户与作者修改，写入失败恢复本次快照；**半截区块、归属不明或双源装配一律明确拒绝**，不从历史官方源码覆盖、不删除酒馆目录与存档数据库。**不承诺“坏旧包/半装残留”自动兜底**：这类现场会被拒绝并给出处理提示，不做猜测性清理（旧 residual 兜底分支当前未接入维护入口）。

程序依赖已随包提供，完整性与恢复材料随发行包一起交付；不用为四个解析器另补 npm 依赖。

## 兼容与使用须知

- **当前版本 0.4.13：适配酒馆上游 main `d189da12`（完整提交 `d189da122a8651c53ffc55ff465913f2e7f49d75`，Tavern **2.7.0**）**；适配范围以对应 Release 为准。Linux / WSL2 定位目录、一次命中全部必需接缝后直接注入和复制插件，不做隔离预演、文件一致性、宿主版本/解析/VM或原启动参数检查；原运行恢复、原停止保持，不改原unit/argv/cwd/env。Windows/macOS保留各自维护流程。不要求源码匹配runtime manifest或冻结作者树；原代码现场只加一层注释，块外用户修改保留。标准维护**保留用户其他配置，仅管理本包确切启动行**，用户显式配置冲突仍零写拒绝；同包重接可补齐确切缺失入口。标准目录维护不调用包管理器装卸本包。详见[安装说明](deploy/INSTALL.md)。
- Windows 支持桌面版及原生 Windows CLI；隔离装配与维护证据不代替实际宿主、页面及玩法验收。
- **V1 / V2 不可在同一实例共装**，V2 是服务端计算版本线。
- UI 脚本仍保留浏览器职责；不承诺所有 DOM 脚本、所有卡或所有 SillyTavern API 都兼容。
- 这是对作者存储与执行链的修改版，升级作者程序需要核适配；未知布局不无条件覆盖。
- 自动化、源码检查与基础健康不替代现场页面、连续回退或 Linux 实机全链验收。
- **计算唯一由上游服务端运行时执行，客户端不参与**：本包不再自带 MVU / 卡脚本 / Helper / VM 实现，也不保留旧引擎或浏览器回落分支。卡脚本在上游 `server-script-worker` 的 jsdom 子进程内运行，其结果经上游 Host 事务草稿与 effect/CAS 落我方 SQLite；服务端不可用时任务保留并明确失败/等待，不转交页面、不切旧引擎。因此本包**不宣称也不提供**对不可信代码的安全隔离——jsdom 与 Node 子进程仍与宿主同机同用户权限，请只运行你信任的人物卡与脚本。
- 公开导出（`package.json` 的 `exports`，46 项）的兼容与退役策略见 [PUBLIC-API-COMPATIBILITY.md](PUBLIC-API-COMPATIBILITY.md)：默认保留、标注 deprecated 只做注记不改运行时行为；**例外**是计算重构按用户明确授权彻底删除的自有计算导出（`./sandbox-policy`、`./mvu-card-runtime`、`./mvu-script-sandbox`、`./mvu-update-core`、`./card-script-dispatch-store`、`./server-execution`、`./server-dependencies`、`./opening-server-init`、`./esm-module-loader`、`./tavern-helper-api`、`./tavern-regex-api`），不留垫片、不留兼容分支。

## 源码与构建

```sh
node scripts/build-release.mjs --out ./dist --repository huajiao1998/dsh-tavern-sqlite-v2
```

生成完整 TGZ、Windows ZIP、固定版本安装 SH 与摘要文件，不自动发布或操作服务。构建、安装参数及报错日志位置详见[安装说明](deploy/INSTALL.md)。

构建输出的 `dist/install.sh` 才是公开发布使用的安装入口（固定版本 URL/SHA，Release 资产与公网根副本同源）；源码树 `install.sh` 与 `deploy/install.sh` 是**本地 wrapper**（只读当前 `package.json` 与 `deploy/bootstrap.mjs`，不固定版本/地址，可离线装卸），包内二入口由同一渲染器生成（带具体版本，URL/SHA 保持占位，避免内嵌本次 tgz 摘要自引用）。

## 来源与许可证

基于 [DSH Tavern](https://github.com/flizzywine/dsh-tavern) 适配，保留原来源声明与 [GNU AGPL v3 许可](LICENSE)。本项目是独立修改版，不是上游官方发行；随包官方恢复字节的许可及对应源码入口也保留。
