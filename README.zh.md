# dsh-mcp-session

DeepSeek Harness(DSH)的 **MCP 会话级可见性**插件。
[English](README.md) | 中文

MCP 工具很贵:每个已连接服务器的 schema 会出现在**每一次**请求里,不管这轮对话
是否需要它。`dsh-mcp-session` 把默认成本压到 **零** —— 所有 `mcp__<server>__*`
工具默认隐藏,直到真的需要 —— 而且**从不**要求模型先"激活"服务器。

## 能力

| 能力 | 行为 |
|---|---|
| **默认零成本** | 没有任何触发时,不发送任何 MCP 工具 schema;只留插件自己的 5 个小工具和一段紧凑目录。 |
| **关键词自动揭示** | 本轮用户消息里出现 hint(如 `高德`/`地址`/`在哪`)→ 该服务器的原生工具**当轮**可用,零激活步骤。 |
| **会话级多 pin** | `mcp_pin("amap")` + `mcp_pin("xiaohongshu")` → 整个会话常驻,且**同时**在线;`mcp_unpin` 收回。 |
| **代理兜底** | `mcp_call("amap","maps_geo",{...})` 一次直达任意已注册 MCP 工具,即使该服务器从未被揭示。 |
| **子代理一等公民** | 子代理在**自己的作用域**里自取(`mcp_call` / `mcp_pin`);调度型父级完全不需要知道 MCP 的存在。 |
| **目录段落** | 每个服务器一行(别名、触发词、pin 状态、调用方式),模型永不靠猜。 |

## 安装

```sh
# 在 DSH profile 里(例如 ~/.dsh/profiles/web)
pnpm add dsh-mcp-session
```

包自带 `cordis.patch.yml`,加进 profile 的 bundles 即可。本地开发用 insert 行:

```yaml
- insert:
    - id: dsh-mcp-session
      name: dsh-mcp-session
      config: {}
```

### 与 `dsh-mcp-lazy` 的关系(必须二选一)

`dsh-mcp-lazy` 的 manager 同样调用 `tools.restrict()`;两个插件同时写同一个
per-agent 掩码,行为不可预测。迁移步骤:

1. 备份 `~/.dsh/profiles/web/cordis.patch.yml`(并留一个 undo 快照);
2. 加 `dsh-mcp-session` 的 insert 行,把 `mcp-lazy-manager` 置 `disabled: true`;
3. 重启后跑 `mcp_status()`:未 pin 时应看到 0 个 `mcp__*` 工具;
4. 回滚 = 恢复 patch 文件 + 重启。

**连接层不受影响**:MCP 工具仍由 `dsh-mcp-manager` / `dsh-mcp-client`
注册,关掉 lazy 的 manager 不会断开任何服务器。完整 runbook(灰度顺序、pin 迁移、
fail-open 与回退)见 [`docs/MIGRATION.md`](docs/MIGRATION.md)。

## 配置

`$DSH_HOME/mcp-session.json`(按 mtime 热更新);cordis 行上的 `config` 优先级更高。

```json
{
  "defaultPolicy": "lazy",
  "keywordReveal": true,
  "proxyTool": true,
  "catalog": true,
  "hintScan": { "maxServers": 3 },
  "servers": {
    "amap":        { "label": "高德地图", "hints": ["高德", "地图", "导航", "地址", "位置", "路线", "天气", "周边"] },
    "xiaohongshu": { "label": "小红书",   "hints": ["小红书", "笔记", "攻略", "种草"] }
  },
  "pins": { "default": [], "byWorkspace": { "/home/me/travel": ["amap"] } }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `defaultPolicy` | `lazy` | `lazy` 隐藏全部 MCP 工具;`eager` 不隐藏任何东西(插件只提供会话工具)。 |
| `keywordReveal` | `true` | 按关键词当轮揭示。 |
| `proxyTool` | `true` | 把**五个**助手工具(`mcp_call` / `mcp_pin` / `mcp_unpin` / `mcp_pins` / `mcp_status`)注册进每个 agent 自己的层;置 `false` 会**释放全部五个(含 `mcp_status`)** —— 插件此时只做 deny + 关键词揭示 + 目录,不存在"半个工具面自检与事实相反"的状态。热更新:`mcp-session.json` 被监听(目录 watcher + 1s 轮询兜底),变化会**直接对每个存活 agent 重新生效**,不等 dispatch/装配。目录段落按**事实**渲染,置 `false` 时绝不会点名已释放的工具。 |
| `catalog` | `true` | 注入紧凑目录段落。 |
| `hintScan.maxServers` | `3` | 单轮揭示的服务器上限。命中按 **hint 质量**排序(显式配置优先于自动派生、长 hint 优先于短 hint),位置只在同质量时作末位 tie-break —— 这样"碰巧出现在句首"的派生词不会挤掉显式配置的服务器。被上限截断的服务器会在目录段落与 `mcp_status()` 里报告。 |
| `servers.<name>.label` | – | 目录里显示的中文别名。 |
| `servers.<name>.hints` | 自动派生 | 触发词(子串匹配)。未配置的服务器**只从 serverName 与工具名**派生触发词 —— **绝不**从工具描述里抽词(描述是散文,例如 "Search for a place by address…",其用词会让无关服务器被任意英文句子命中)。派生 token 至少 4 个字符,按 `_`/`-`/`.`/驼峰切分,并过滤内置英文停用词表(函数词 **与** 泛化动词/名词:`for`/`the`/`search`/`get`/`read`/`list`/`send`/`create`/`status`/`data` …)。词面确实是散文的服务器请显式配置 hints。 |
| `pins.default` | `[]` | 每个新根会话默认常驻的服务器。 |
| `pins.byWorkspace` | `{}` | 会话 cwd 前缀 → 该目录下默认常驻的服务器。 |

### 账本卫生

`mcp_status()` / `mcp_pins()` **按 agent** 汇报,并且绝不宣称一个注册表里已不存在的服务器:服务器消失后,它会立即从 `visible` / `revealed` / `truncated` 中移除。
`pinned` 是持久意图,**故意保留**,但会显示为「常驻但当前未注册」,并在服务器重连后自动恢复。

截断信息刻意报两处:**按 agent**(每个 agent 自己的当轮,与其刚产出的装配同源 —— 账本不可能与工具表矛盾),以及一处**明确标注的全局并集**(仅供概览)。

## 五个工具

| 工具 | 作用 |
|---|---|
| `mcp_pin(server)` | 本会话常驻(可多选),下一步生效。 |
| `mcp_unpin(server)` | 收回常驻;同时把继承自父级的 pin 从存活子代理上显式撤下。 |
| `mcp_pins()` | 常驻 / 本轮揭示 / 继承 / 当前可见。 |
| `mcp_status()` | 全量诊断:已注册服务器、工具数、每个存活 agent 的账本(可见/常驻/本轮揭示/截断、助手工具注册状态)。助手工具的治愈是**入口点驱动、逐 agent** 的:注册失败会在**该 agent 自己**的下一个工具调用或装配时重试,因此读另一个 agent 的 status 不会顺带治愈它。 |
| `mcp_call(server, tool, arguments)` | 揭示 + 派发一个原生 MCP 工具,一次调用完成。 |

## 实现机制

1. **Registry 观察** —— 从 `ctx.tools.schemas()` / `ctx.tools.get()` 镜像全局
   `mcp__<server>__<tool>` 工具面,订阅 `tools/change`:后到的服务器会被补上,
   服务器重连(定义对象换新)会**重建 shadow**。
2. **会话状态** —— `agent/created`(子代理同样触发)为每个 agent 建一条状态:
   pin 集合、本轮揭示集合、shadow 注册表。
3. **可见性控制** —— 在 agent 作用域 `restrict({ deny: [全部 mcp__* 名] })`
   隐藏默认面;**揭示 = 把该服务器的真实定义注册进这个 agent 自己的层**
   (遮蔽全局,且豁免一切祖先 restriction)。两个方向都是 per-agent,限制不会反向污染。
4. **触发三件套** —— 本轮已 claim 的用户文本关键词命中、显式 pin、`mcp_call`,
   以及委派提示词命中(`subagent` / `subagent_fork` / `workflow` / `ralph`)。
5. **提示层** —— `systemPrompt.section` 按 scope 解析,渲染本会话的 pin 状态。

任何环节出错都 **fail-open**:`restrict` 抛错时不隐藏任何工具,`mcp_status()`
会报告 fail-open 状态。

### 子代理语义(设计 §2.5.4,源码级修正)

父级的 `restrict()` **不会**作用到子代理:真实子代理的 scope 父键是父代理的
**agent-preset standing mount**,不是父代理的 agent 键;父级没有 preset 时子代理
**根本没有父 scope**。所以子代理不是"被父级收窄",而是**从来没有被限制过** ——
它默认能派发**全部** `mcp__*` 工具。这是"默认零成本"承诺的最大漏洞,必须显式处理:

1. **逐 agent 物化** —— `agent/created` 对子代理同样触发,插件为**每一个** agent
   在**它自己的层**里安装 `restrict({ deny: [全部 mcp__* 名] })` 和助手工具。
2. **pin 是"物化"而非"继承"** —— 新建 agent 时会按会话 pin 集合显式施加
   (子代理通过 `session.header.parentSession` 关联);`mcp_unpin` 对**每个存活
   agent**重新施加,包括已经在跑的子代理(父级 shadow 继承只是创建时快照)。
3. **助手工具只注册进各 agent 自己的层** —— 绝不注册到插件全局层,因为只有
   own-layer 注册才豁免祖先 restriction(否则一个 allow-filter 组合会把插件自己的
   逃生通道也挡掉)。
4. 以上全部发生在 `agent/created` handler 的**同步段**:监听器返回的 Promise
   不被 await,任何 `await` 都会让该 agent 的第一轮装配抢跑。

### 触发时点(相对设计稿的偏差,已实测)

设计稿 §2.5.3 提出在 per-agent 的 `systemPrompt.tools(provider)` 里做揭示。
该钩子**无法**让它所在的那次装配看见新注册的工具:`dsh-tools` 在自己的服务构造时
(早于任何插件)就注册了 registry provider,而装配是"先把所有 provider 的 schema
收集完,再调用下一个 provider"。因此在更晚的 provider 里注册,只会在**下一次**
装配生效 —— 恰好在这个功能要避免的场景里多一次往返。
`harness/verify` 的 **S11** 步骤用可复现的证据复现了这个顺序。

因此实现改为在 **`agent/inbox/claimed`** 上揭示:agent loop 在
`systemPrompt.assemble()` **之前**同步发出该事件;provider 钩子保留为幂等的
安全网(pin、重连)。架构没有变:同样的 per-agent scoped shadow、同样的模块划分;
只是把触发点前移到设计 Q3 自己要求的"早于工具面装配的时点"。

**未文档化耦合(已知并接受的风险)**:关键词揭示依赖 `agent/inbox/claimed` 的
payload 形状 `{ agent, message, turn }` 以及 `message.content` 的文本块。该事件是
官方既有扩展点(`dsh-acp`、`dsh-goal-round-driver`、`dsh-subagent` 都在用),但 DSH
并未把它作为稳定的插件契约写进文档。**适用版本范围**:该形状是在 DSH `0.1.5-rc.1`
(`dsh --version`)+ `0.1.5-rc.2` 包线上实测确认的,也就是 `engines.dsh: ">=0.1.5-rc.1"`
覆盖的范围;它**没有**兼容性保证,上游若改变该事件,插件可能需要同步更新。若真发生,
插件是**安静降级而非危险降级**:handler 是 total 的(对 `agent` 做保护,匹配空文本只是
"本轮不揭示"),所以字段缺失只会让该轮的关键词揭示失效,`mcp_pin` / `mcp_call` /
目录段落仍可用,且走日志而非抛错。插件其余部分不依赖任何未文档化内部结构。

## 验证 harness

`harness/` 在**一次性**宿主里跑插件(每个成员一个 `DSH_HOME`,绝不碰线上 `~/.dsh`,
也不碰 3080 端口),配假 MCP 工具面,且**零模型调用**:

```sh
cd plugins/dsh-mcp-session
pnpm build                                                    # 或:tsc -p tsconfig.json
DSH_HOME=/tmp/ms-eng-scratch bash harness/install-scratch.sh  # 引导宿主 + 挂插件
bash harness/run-smoke.sh                                     # 85 条断言,零模型调用
bash harness/mutate-and-check.sh                              # 反空洞:6/6 变异,在私有副本内
```

`install-scratch.sh` 会调用独立可用的 `harness/bootstrap-profile.sh`:它创建 profile 骨架、
修复 module farm、并自证 profile 可组合 —— 因此 `/tmp` 被清空(或换新机器)时**无需任何手工步骤**;
重跑这两个脚本**就是**恢复流程。独立的 V1–V8 矩阵放在 `verification/`(由独立验证者维护),
其中的 `install-verify.sh` 会把插件+探针装进一次性 profile `vtest`。

### 复现构件身份

本插件的身份是**一个**数:对 `src/` **与** `lib/` 取摘要,必须在**插件根目录**、用**相对路径**:

```sh
cd plugins/dsh-mcp-session
find src lib -type f | sort | xargs sha256sum | sha256sum                 # canonical(64 位十六进制)
find src lib -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum   # NUL 安全等价写法,同值
```

即「逐文件算 sha256 → 把 `<hash>  <path>` 清单排序 → 对这份文本再算 sha256」,**不是**
`cat lib/*.js | sha256sum`(那是另一个值);也**不要**用绝对路径、**不要**省掉 `sort`。
**工作目录本身就是算法的一部分**:同一棵树在别的目录下算会得到不同的字符串。
`lib/**/*.js.map` 也在摘要内,而 source map 会记录输出路径,所以必须在用本仓库
`tsconfig.json`(`outDir: lib`)构建出的树上计算。发布树可复现:把仓库复制一份后
`tsc -p tsconfig.json`,能得到与 `lib/` **逐字节相同**的全部文件。`lib/index.js` 单独
(一小段接线 wrapper)**不得**作为身份。

### 认证运行模板

任何声称"判定某个 revision"的运行,都必须记录齐下列字段:

```json
{
  "DSH_HOME": "/tmp/<member>-scratch",
  "mcpSessionConfigSha256": "<$DSH_HOME/mcp-session.json 的 sha256>",
  "canonical": "<src+lib 的 64 位值,命令与 cwd 见上>",
  "driver": "<驱动标识 + sha256,例如 dsh-ms-verify@r4(agent/request 挂起)>",
  "consecutiveRuns": ["85/0", "85/0"]
}
```

且只有满足这两条才算数:运行**前后 canonical 完全一致**(hash-stable),并且宿主是用上面的脚本装出来的 ——
旧探针副本残留的 profile 会静默改变结果,这正是「手工调 `dsh` 之前必须先跑
`verification/install-verify.sh`」这条纪律的由来(`verification/run-all.sh` 内部先跑它,再做 hash-stable 认证)。

## 致谢与范围

本项目是**自建实现,不是 fork**。它参考并刻意对比了
[`mcp-lazy`(leaforbook/dsh-mcp-lazy)](https://github.com/leaforbook/dsh-mcp-lazy),
特别是它 issue #1 的"显式 server 常驻"语义:`dsh-mcp-lazy` 每个 agent 只保留一个
selected server 且每轮清空;本插件保留**每会话集合**,在 claim 时揭示(所以本轮工具表
里本来就有它),并允许每个子代理独立自取。**未复制任何代码**;两者共用的词汇只是 DSH 自身
文档里的 cordis 插件 API(`tools.restrict`、scoped `tools.register`、`systemPrompt`)。

## License

MIT
