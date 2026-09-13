# 迁移与灰度 runbook — dsh-mcp-session

本文件是**上线操作手册**(不改线上环境的自动化脚本一律不在此仓库内执行)。
配套阅读:根 `README.md` / `README.zh.md`(能力、配置项、构件摘要命令、认证模板)。

---

## 0. 兼容性与版本声明

| 项 | 要求 |
|---|---|
| DSH | `engines.dsh = ">=0.1.5-rc.1"`(本插件认证所依据的版本:DSH `0.1.5-rc.1`) |
| Node | `>=22` |
| cordis(peer) | `@deepseek-ai/cordis ^4.0.2` |
| 其他 peer | `@deepseek-ai/dsh-agent ^0.1.5-rc.1`、`@deepseek-ai/dsh-tools ^0.1.5-rc.1` |
| 认证构件 | `canonical(src+lib) = 8921646477ff2a68458f966a158ccc1a66d07956d64cbaf31e91a48b6f7109e0`(28 文件;命令与 cwd 见 README「复现构件身份」) |

**已知耦合(必须在升级 DSH 后重跑验证)**:本插件依赖一个 DSH 未文档化的时序 ——
`agent/inbox/claimed` 必须早于 `systemPrompt.assemble()` 触发(否则揭示会晚一轮)。
升级 DSH 后请按 §5 复跑 harness;若该时序变化,表现为「关键词匹配了但本轮工具表里没有」。

---

## 1. 全新安装

1. **落地插件**:把本仓库放进 profile 可见的位置,或用
   `dsh plugin --profile <profile> add <本插件的本地路径或 tarball>`
   (本插件**未**发布到 npm,不要把 `dsh-mcp-session` 当成 registry 包名安装)。

   > ⚠️ **`dsh plugin --profile …` 必须带 `DSH_HOME`**。该命令不带 `DSH_HOME` 时会落在
   > **线上 `~/.dsh`** 上,并**重写 `~/.dsh/profiles/<name>/cordis.yml`**、必要时新建该 profile 目录
   > (2026-09-13 17:02:30 在本机实测发生过;当次内容逐字节一致,但属红线)。正确写法:
   > `DSH_HOME=/tmp/<you>-scratch dsh plugin --profile <profile> add <path>`;手动 `dsh` 调试同理,
   > 动手前先跑 `bash verification/install-verify.sh` / `bash harness/install-scratch.sh`。
2. **加挂载行**:在 profile 的 `cordis.patch.yml` 里插入(顺序在 MCP 连接插件之后):

   ```yaml
   - insert:
       - id: dsh-mcp-session
         name: dsh-mcp-session
         config: {}
   ```
3. **写配置**:`$DSH_HOME/mcp-session.json`(行内 `config:` 优先级更高,见 README 配置表):

   ```json
   {
     "defaultPolicy": "lazy",
     "keywordReveal": true,
     "proxyTool": true,
     "catalog": true,
     "hintScan": { "maxServers": 3 },
     "servers": {},
     "pins": { "default": [], "byWorkspace": {} }
   }
   ```
4. **重启 DSH**,然后调用一次 `mcp_status()`:未 pin 任何 server 时可见的 `mcp__*` 应为 **0**,
   五个助手工具(`mcp_call`/`mcp_pin`/`mcp_unpin`/`mcp_pins`/`mcp_status`)应齐全。

---

## 2. 从 `dsh-mcp-lazy` 迁移(同一时刻只允许一个可见性 owner!)

`dsh-mcp-lazy` 的 manager 也会调用 `tools.restrict()`;**两个 writer 写同一个 per-agent mask ⇒ 结果不可预测**。
因此灰度顺序是**强制的**:

> **先禁用 `mcp-lazy-manager`,重启并确认;再启用本插件。** 不要反过来,也不要两边同时启用。

步骤(每步都可回退):

1. **备份**:`cp <profile>/cordis.patch.yml <profile>/cordis.patch.yml.bak-$(date +%s)`;
   顺手记下当前构件摘要(见 §0)。
2. **阶段 A — 关旧**:把 `mcp-lazy-manager` 行置 `disabled: true`(**不要**卸载 `dsh-mcp-manager` /
   `dsh-mcp-client`:它们负责把工具注册进 registry,关掉会真的断连)。重启,确认 MCP 工具仍在 registry
   (例如 `mcp_status()` 的注册列表非空),此时可见性由 lazy 的 deny 残留决定是预期现象。
3. **阶段 B — 开新**:插入本插件行(§1.2),重启。
4. **阶段 C — pin 迁移**:`dsh-mcp-lazy` 的语义是「每 agent 一个 selected server、每轮清空」;本插件是
   **每会话集合**、且 pin 要**逐 agent 显式物化**。迁移做法:
   - 常驻需求写进 `pins.default`(新建 root 会话自动 pin)或 `pins.byWorkspace["<cwd 前缀>"]`;
   - 会话内临时常驻用 `mcp_pin("<server>")`(可多个);
   - 子代理不会继承父层的 pin(设计 §2.5.4),需要给子代理用就在父 turn 里 `mcp_pin`,或让子代理自己 pin。
5. **核对**:`mcp_status()` 应显示:可见列表 == 你期望的集合;截断提示按 agent 归属;
   账本里没有已卸载的 server(移除后自动清理,`pinned` 会标注「常驻但当前未注册」)。

**回退**:恢复步骤 1 的备份文件 → 重启。回退不涉及任何外部状态(本插件只写 `$DSH_HOME/mcp-session.json`)。

---

## 3. 灰度顺序(推荐)

| 阶段 | 环境 | 动作 | 通过判据 |
|---|---|---|---|
| 0 | 一次性 profile(如 `mcptest`) | 跑 harness | `harness/run-smoke.sh` = 85/0(零模型调用) |
| 1 | 真实 profile | `defaultPolicy: lazy` + `proxyTool: true`,先不开 `catalog` | 未 pin ⇒ 可见 `mcp__*` == 0;`mcp_status()` 正常 |
| 2 | 同上 | 打开 `keywordReveal` / `catalog` | 关键词命中 ⇒ 本轮工具表出现该 server;目录段落与事实一致 |
| 3 | 同上 | 关闭 `mcp-lazy-manager`(§2 阶段 A 已完成则跳过) | 只有一个可见性 owner |
| 4 | 同上 | 打开 `pins.default` | 新会话自动常驻;`mcp_unpin` 可撤 |

任何阶段失败 ⇒ 走 §2 的回退,并保留 `mcp_status()` 输出作为证据。

---

## 4. fail-open 与回退

| 场景 | 行为 |
|---|---|
| 助手工具本身要"全放" | `proxyTool: false` ⇒ **五个助手工具全部释放**(含 `mcp_call`),此时仍保留 deny + 关键词揭示 + 目录;不会出现"半放行"导致自检与事实矛盾 |
| 关键词揭示误判 | `keywordReveal: false` ⇒ 不做文本揭示,只靠 pin 与 `mcp_call` |
| 完全不隐藏(应急) | `defaultPolicy: "eager"` ⇒ 不隐藏任何 MCP 工具(插件退化为仅有助手工具 + 目录) |
| 配置热更 | 配置文件按 mtime 热读(目录 watcher + 1s 轮询兜底),改动会**重施到所有存活 agent**,无需等下一轮 dispatch |
| 插件整体回退 | 恢复 profile patch 备份 + 重启;重启后不留任何残留状态 |

**边界**:本插件不建立/断开任何 MCP 连接,不写 profile 之外的文件,不发网络请求。

---

## 5. 迁移后复验(留痕)

1. 构件身份(在插件根目录):
   `find src lib -type f | sort | xargs sha256sum | sha256sum` → 应 == §0 的 64 位值;
2. harness 两次:`bash harness/run-smoke.sh` ×2(应 85/0);
3. 认证记录按模板留档:`{DSH_HOME, sha256($DSH_HOME/mcp-session.json), canonical, 驱动标识, 连续两次结果}`;
4. 把上述四项写进你的变更记录(发布留痕见 `docs/release-report.md`)。
