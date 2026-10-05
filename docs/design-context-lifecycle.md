# MCP 上下文生命周期管理 — 设计方案(v2)

> 目标:让 MCP 工具的**模型可见性**具备真正的生命周期管理 —— 用到才出现、不用就回收、
> 回收不丢能力。当前实现(按轮揭示 + 会话常驻)只做到了"延迟加载",没做到"生命周期"。
>
> 本文的事实基础全部来自本机实测(DSH 0.2.0-rc.2),不依赖推测。


> ## ⚠️ v3 修订(优先读这一节)
>
> 复核官方协议后发现:**DSH 早已实现"用到才加载"的工具协议,只是 MCP 桥没用它。**
> 这改变了方案的杠杆顺序 —— 机制层应当优先用官方协议,而不是插件自己管可见性。
>
> | 官方设施 | 事实(实测) |
> | --- | --- |
> | `ToolSchema.deferLoading?: true` | 注释原文:"Requests deferred loading of the tool definition into model context … **Uses Anthropic's defer_loading terminology**"。在 `dsh-tools` 的 `ToolDefinition` 上同样存在 |
> | 适配器透传 | `dsh-llm-deepseek` 组包时 `...tool.deferLoading === true ? { defer_loading: true } : {}`,并发送 `mid-conversation-tool-changes-2026-07-01` beta 头 |
> | 中途增删不破缓存 | `ToolUpdate = 'in-history' \| 'addition-only'`;`deepseek-flash` 路由声明 `toolUpdate: "addition-only"`;**`dsh-agent-loop` 自己会发 `tool-addition` 块** |
> | 会话校验 | `dsh-session` 校验 addition 块必须指向 header 中已声明的完整定义,且 `deferLoading` 若存在必须为 `true` |
> | 声明 ≠ 激活 | `dsh-llm` README:"Explicitly deferred baseline tools remain deferred until their first retained addition block;**declaring a deferred tool does not activate it**" |
> | 无支持时的降级 | 无 `toolUpdate` 的路由:剥离标记全量下发(`dsh-llm` L789);**`dsh-llm-pi-ai` 遇到该标记直接抛 `LlmError("Deferred tool loading is not supported yet")`** |
> | 可查询 | `LlmResolvedModelInfo.toolUpdate?: ToolUpdate`(`dsh-llm` types L387),经 `ctx.llm.resolveModel(provider, model)` 取得;`pi-ai` 不声明 `toolUpdate` ⇒ **用"是否存在 `toolUpdate`"门控即可安全避开它的硬报错** |
> | MCP 现状 | `dsh-mcp-client` 的 835 行 bundle 里 **0 处 `deferLoading`** —— 协议在,桥没用 |
>
> ⇒ **首选杠杆:`deferLoading`(协议级,provider 负责"不加载")**;插件级的 `restrict`+shadow(下文 §2)降为**不支持该协议的路由的兜底**;热集冷却策略(§2.2/§2.3)保留为策略层,但在协议级生效时,它的收益从"省 token"降级为"省工具表噪声与缓存压力"。详见 **附录 A**。

---

## 0. 官方现状:0.2.0-rc.2 没有解决这个问题

**结论:官方在 rc.1 → rc.2 之间对 MCP / 工具注册表 / agent 循环零改动。**

实测方式与结果(字节级比对):

| 包 | rc.1 vs rc.2 |
| --- | --- |
| `@deepseek-ai/dsh-tools` | 类型面 + 实现 **完全一致**(`lib/types` 全量哈希 `cf0bccbe0f71`,`lib/index.js` `403a343fc905`) |
| `@deepseek-ai/dsh-agent` | 完全一致(`30d8c526c241` / `23b1fc1cc5ed`) |
| `@deepseek-ai/dsh-mcp-client` | 完全一致(`eb0897ee78e9`,从 npm 取 rc.1 tarball 比对) |
| `@deepseek-ai/dsh-mcp-resources` | 完全一致(`f27ceb64a5f7`) |

官方的定位仍然是:`dsh-mcp-client` = 一个 server 一个实例,连上就把**全部**工具注册进
`ctx.tools`(`mcp__<serverName>__<rawName>`),生命周期只跟着 effect 走(dispose 才注销)。
没有任何按需可见、过期、驱逐、预算的概念。

### 官方**已经提供**的原语(方案建立在这些之上,不发明新机制)

| 原语 | 语义 | 约束(实测) |
| --- | --- | --- |
| `agent.ctx.tools.restrict({allow,deny})` | 按作用域过滤**全局**工具 | 必须传 `agent.ctx`;全局 restrict 会屏蔽所有 agent(直接抛错)。不能命中 `run_code`(保留传输名),名字需在 `restrictableNames` 内。返回 disposer |
| `agent.ctx.tools.register(def)` | 作用域注册:**shadow 同名全局工具**,且**豁免祖先 restriction**,立即可派发 | 返回 disposer。这是"揭示"的机制 |
| `ctx.tools.schemas(scope?)` | 取该作用域当前将呈现的 schema 表 | **可测量** → 预算计量的事实来源 |
| `agent.ctx.tools.presentAs('native'\|'ptc'\|'both')` | 整个作用域的呈现方式 | **每作用域只能选一种**,与已声明的 `mode` 冲突即抛错;PTC 会把 schema 表换成 `run_code` + 生成 SDK 提示段 |
| 事件 `tools/pre-execute` / `tools/post-execute` / `tools/result` / `tools/change` | 调用前 / 调用后 / 结算 / 注册表变更 | `tools/result` 带 `exec.name` 与 `result` → **使用证据**的来源 |
| 事件 `agent/inbox/claimed` / `agent/turn-stopping` / `agent/created` / `agent/disposed` | 轮开始 / 轮结束 / agent 生命周期 | 回收只能发生在轮边界 |

### 成本实测(为什么值得做)

本机 `dianping` MCP server 实测:`tools/list` 返回 3 个工具,**序列化 JSON 3,292 字节**,
约 **540–680 token**(4 B/token ≈ 541,3.2 B/token ≈ 677)。其中单个
`dianping_category_rank` 就占 2,342 字节(入参 schema 里枚举了城市/分类/商圈)。

> 常驻一个 server = 每一轮都重复付这笔 token。多 server 部署时这是纯浪费。

---

## 1. 缺口:`pin` 是永久意图,`revealed` 按轮但无冷却

现有实现的账本(`src/types.ts`):

- `revealed: Set<server>` — 关键词命中或 `mcp_call` 取用时加入,**`agent/turn-stopping` 会清空并回收 shadow**;
- `pinned: Set<server>` — `mcp_pin` 加入,**会话级永久**,且向下物化到每个子 agent;
- `effectiveServers = pinned ∪ revealed ∪ 祖先 pinned`。

⇒ **按轮回收其实已经存在**。真正让工具"用过就一直在"的是:

1. `pin` 只由"意图"驱动,没有任何自动回收;模型一旦 `mcp_pin`,到会话结束都不释放;
2. 没有"使用证据"这个客观量 —— 无法回答"这个 server 最近真的在用吗";
3. 预算以 **server 个数**(`maxRevealServers`)计,没有成本计量,也不知道自己占了多少字节;
4. 目录段落只讲"怎么取用",不讲"什么时候会消失",模型无从预期。

---

## 2. 新方案:三层披露 + 热集冷却(Hot-Set with Decay)

核心思想:**能力永不失联,有成本的是 schema。**

### 2.1 三层披露(对齐 skill 的渐进披露)

| 层 | 内容 | 成本 | 何时存在 |
| --- | --- | --- | --- |
| **L0 目录** | 每 server 一行:名字 + 一句话能力 + 触发词 + 当前状态 | 恒定、极小 | **永远** |
| **L1 直达代理** | `mcp_call(server, tool, args)` | 零 schema 成本 | **永远**(`proxyTool=true`) |
| **L2 原生工具** | 该 server 的真实 schema 进入可见集 | 实测数百 token/server | **只在热窗口内** |

模型永远可以用 L1 做任何事;L2 只是为了省掉"多一次代理调用"的便利。

### 2.2 状态机(每个 agent × 每个 server 一份)

```
cold ──触发──▶ hot ──真实调用刷新──▶ hot ──idleTurns 内无调用──▶ cold
```

- **进入 hot 的触发**(可配置,任一命中):本轮用户文本命中触发词 / 模型显式 `mcp_load` /
  子代理委派提示词点名 / 上一轮的续用窗口(`idleTurns`)未过期。
- **热窗口刷新**:每次**真实**调用(`tools/result` 观察到 `mcp__<server>__<tool>`)刷新
  `lastUsedTurn`。
- **退出 hot**:`turn - lastUsedTurn > idleTurns`(默认 1–2)或 `hotTtlMs` 超时 → 回收 shadow。
- **hard pin** 保留为显式意图(`mcp_pin`),但新增 `pinIdleTurns`:`0` = 旧行为(永久),
  `>0` = 连续 N 轮无调用也释放。推荐默认 `0` 以保持向后兼容,把"自动回收"交给 hot 窗口。

### 2.3 每轮决策函数

```ts
retain(agent, server) :=
     hardPinned(server, agent)
  || inFlight(server, agent) > 0            // 有正在执行的调用:绝不在调用中回收
  || (currentTurn - lastUsedTurn(server, agent)) <= idleTurns
  || keywordHit(currentTurnText, server)     // 本轮提到 → 本轮必须在

visible(agent) := 按优先级排序取子集,直到 schemaBudgetBytes 用尽
优先级 = inFlight > 最近使用(轮次新近) > 关键词命中 > 目录顺序
```

- **预算是字节不是个数**:用 `ctx.tools.schemas(agent.ctx)` 实测每 server 的 schema 字节,
  逐 server 累加直到 `schemaBudgetBytes`(默认 6000 B ≈ 1.5–2k token)。
  可再按 `contextWindow` 缩放上界(如 `min(6000, contextWindow × 0.002)`),但**容量的实时用量
  当前不可得**(`dsh-session`/`dsh-llm` 只暴露 `contextWindow` 容量,无逐轮 token 用量),
  所以预算以固定字节为主,窗口容量只作上界。
- 溢出的 server 降级到 L1,并在 L0 目录里**明确写出"未加载,可 mcp_call 直达"**。

### 2.4 安全约束(必须遵守,否则会踩实测过的坑)

1. `restrict()` 只能用 `agent.ctx`;绝不全局。
2. `restrict()` 不能命中 `run_code`;先过滤 `restrictableNames`,未知名字直接跳过。
3. 回收**只在轮边界**执行,且 `inFlight == 0`。
4. `presentAs('ptc')` 是**整 agent** 的选择,不能按 server 混用;若启用了 PTC,L2 的成本
   本就大幅下降(`run_code` + SDK 段取代逐工具 schema),此时应把 `schemaBudgetBytes` 放大、
   让"过期回收"退居次要 —— 两者是互补而非叠加的杠杆。
5. 保留现有 fail-open:restrict/register 失败绝不隐藏能力,宁可多花 token。
6. `pinned` 的向下物化(子 agent 创建时快照)保持现状,但**快照应当是"当时的热集"**,
   子 agent 自己的 hot 窗口独立冷却(它已有独立 `revealed`)。

### 2.5 提示词层:让"过期"成为可预期事实

`mcp-session` 段落增加三行事实(与 `mcp_status` 共用同一账本,延续现有 R3-1 单一事实源原则):

```
已加载(本轮可见,按使用自动过期):dianping(距上次调用 0 轮)
未加载(可用 mcp_call 直达):comfyui, xiaohongshu, amap
释放策略:连续 2 轮无调用即释放;需要时 mcp_call 直达或点名触发
```

模型因此不会把"工具不见了"误判成能力缺失 —— 这是"真生命周期"能否被模型正确使用的关键。

### 2.6 与连接生命周期解耦(可选进阶)

- **上下文可见性 ≠ 进程连接**:回收可见性**不断开** server(重连成本高,`dianping` 依赖
  playwright,冷启可能秒级)。
- 可选 `idleDisconnectTurns`:连续 N 轮 cold 且无 in-flight → 请 `dsh-mcp-manager` 断开
  (省 RAM),下次 `mcp_call` 触发懒连接。该能力依赖 manager 暴露连接接口,**当前不具备**
  (`dsh-mcp-manager@0.6.0` 的 spawn/销毁是它自己的内部路径),故列为后续项。

### 2.7 配置面(新增,向后兼容)

```json
{
  "lifecycle": {
    "mode": "decay",            // decay(新) | turn(仅按轮,=旧的 revealed 语义) | session(旧行为)
    "idleTurns": 2,             // 连续多少轮无真实调用即释放 L2
    "hotTtlMs": 900000,
    "schemaBudgetBytes": 6000,  // L2 的 schema 预算上界
    "pinIdleTurns": 0,          // 0 = hard pin 永久(旧行为)
    "idleDisconnectTurns": 0    // 0 = 不断连接
  }
}
```

`mode: "session"` 完整复现今天的语义 ⇒ 可平滑迁移、可灰度。

### 2.8 实现落点(按现有代码结构)

| 文件 | 改动 |
| --- | --- |
| `src/types.ts` | `AgentState` 增加 `lastUsedTurn: Map<server, number>`、`uses: Map<server, {count, lastAt, errors}>`、`inFlight: Map<server, number>` |
| `src/manager.ts` | 新增 `onToolResult`(`tools/result`)记录使用证据与 in-flight 计数;`onTurnStopping` 从"直接清 revealed"改为"推进轮次 → 运行 retain 决策";`applyVisibility` 基于 retain 集合 + 预算裁剪,并记录 `schemas(agent.ctx)` 实测字节用于状态输出 |
| `src/hints.ts` | 目录段落改造为 L0(目录+状态)+ 释放策略说明;`mcp_status` 输出加入"距上次调用轮数""占用字节" |
| `src/config.ts` | 新增 `lifecycle` 组,保留全部旧键 |

建议先把 `retain`/`visible` 写成**纯函数**(输入:账本快照 + 当前轮 + 配置 → 输出:可见集合),
单测覆盖:in-flight 不回收、hard pin、预算溢出、关键词命中、server 断连重连、mode=session 兼容。

### 2.9 验收指标(可测量)

1. **稳态**:一轮完全不提 MCP 时,工具段字节数回落到 baseline(仅 L0 目录)。
2. **冷启上界**:一轮内为 MCP 增加的 schema 字节 ≤ `schemaBudgetBytes`。
3. **不退化**:命中触发词的当轮可用性与今天一致;`mcp_call` 直达成功率不变。
4. **模型不困惑**:过期后模型仍能(通过 L0+L1)完成同一任务。

---

## 3. 附:实测方法与复现

```bash
# 1) 官方是否改过(字节级)
npm pack @deepseek-ai/dsh-mcp-client@0.2.0-rc.1 && tar xzf *.tgz
# 比对其 lib 与安装版 rc.2 的 lib 全量哈希

# 2) 一个 MCP server 的真实 schema 成本
python3 - <<'PY'
# 对 stdio server 走 initialize → notifications/initialized → tools/list
# 统计 json.dumps(tools) 的字节数与 token 估算
PY
```

实测样本(dianping):`tools=3`,`schema=3292 B` ≈ 540–680 token/轮。

---

## 附录 A(v3):协议级延迟加载 —— 首选杠杆

### A.1 官方管线(`dsh-agent-loop` ↔ `dsh-llm` ↔ adapter ↔ session)

1. 工具定义可以带 `deferLoading: true`(`ToolDefinition` / `ToolSchema` 都接受)。
2. `dsh-system-prompt` 组装时把该字段透传给 `ToolSchema`(`lib/index.js` L328)。
3. 会话中途活跃工具集变化时,**`dsh-agent-loop` 自己发出 `developer/message` + `tool-addition` / `tool-removal` 块**(L1233),引用 header 里已声明的工具名。
4. `dsh-session` 校验这些块(必须命中 header 中恰好一个、且定义完整;`deferLoading` 存在时必须为 `true`)。
5. adapter 把块与 `defer_loading` 一起发给 provider(DeepSeek Messages 需 `mid-conversation-tool-changes-2026-07-01` beta 头)⇒ **增删工具不重写声明列表、不破坏缓存前缀**。

⇒ 结论:**"声明便宜、按需加载、中途增删不破缓存"三件事官方全都有**;MCP 只是从未声明 `deferLoading`。

### A.2 两条落地路径

**路径 1(最干净,改上游一行级):`dsh-mcp-client` 注册时给 schema 加 `deferLoading: true`**,并按路由能力门控(见 A.3)。适合提 upstream PR/issue。

**路径 2(不改上游,本插件可做):在 `dsh-mcp-session` 的 shadow 注册里补标记。**
插件已经在用 `agent.ctx.tools.register(definition)` 注册 shadow —— 把 definition 换成
`{ ...definition, deferLoading: true }` 即可让该 agent 看到的这份 schema 走延迟加载:

```ts
// applyVisibility() 内,注册 shadow 时
const deferred = this.deferredSupported(agent) ? { ...definition, deferLoading: true } : definition
shadow.lifts.set(tool, agent.ctx.tools.register(deferred))
```

**必须门控**(见 A.3),否则不支持的适配器会硬报错。

### A.3 门控(硬约束,不做会炸)

```ts
async deferredSupported(agent): Promise<boolean> {
  const route = /* agent 当前 provider/model,可由 request/header 事件缓存 */
  const info = await this.ctx.llm.resolveModel(route.provider, route.model)
  return info.toolUpdate !== undefined      // pi-ai 无声明 ⇒ 自动排除
}
```

- `toolUpdate === undefined`:不设标记(否则 `dsh-llm` 会剥离、`pi-ai` 会抛错)。
- 结果按 (provider, model) 缓存,避免每轮 resolve。
- 判据是**保守**的:`toolUpdate` 存在只说明支持中途变更块;若某路由声明了 `toolUpdate` 却仍拒绝 `defer_loading`,应再加白名单/配置开关兜底。

### A.4 与 §2 策略层的关系

| 路由 | 机制 | 策略 |
| --- | --- | --- |
| 支持 `toolUpdate` | **`deferLoading`**(provider 侧不加载定义) | 热集冷却用于收敛工具表噪声;`idleTurns` 可放宽 |
| 不支持 | `restrict({deny})` + scoped shadow(§2.4) | 热集冷却 + `schemaBudgetBytes` 预算(这是唯一的成本闸门) |

两种情况下 §2.5 的"提示词层讲清释放策略"都必须保留 —— 它是模型不误判能力缺失的前提。

### A.5 验收指标增补

5. 协议级生效时:请求体的 `tools[]` 中 MCP 项均带 `defer_loading: true`,且**未使用时上下文 token 不计入**(用 provider 侧 usage 比对同 prompt 的有/无标记两轮)。
6. 不支持的路由:绝不出现 `defer_loading` 字段(断言),且 MCP 能力不退化。
