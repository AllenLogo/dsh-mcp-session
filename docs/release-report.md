# Release report — dsh-mcp-session

发布留痕(设计文档 §5.1「变更留痕 + 发布时构件 sha256」、§5.3「t4 发布门禁」)。
本文件描述**被发布的树**,使任何人 clone 后都能独立复现下述摘要。

- 版本:`0.1.0`
- 目标仓库:`https://github.com/AllenLogo/dsh-mcp-session`(自建实现,非 fork)
- 认证宿主:DSH `0.1.5-rc.1`,Node `22`

---

## 1. 构件身份(唯一口径)

```sh
cd plugins/dsh-mcp-session
find src lib -type f | sort | xargs sha256sum | sha256sum
```

= **`8921646477ff2a68458f966a158ccc1a66d07956d64cbaf31e91a48b6f7109e0`**(28 文件)

NUL 安全等价写法(同值):
`find src lib -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum`

运行时指纹(**非**身份,仅辅助):`find lib -name '*.js' | sort | xargs sha256sum | sha256sum`
= `31e0cbe5155c6e428a1f433eb1c2b30676b6350b66fecae8aa8e5b4a71a300bc`

> 口径要点:`sha256sum` 的输出**含路径** ⇒ 必须在插件根目录用**相对路径**、恰以 `src lib` 为操作数;
> 是「逐文件 sha256 → 排序 → 再对清单文本取 sha256」,**不是** `cat lib/*.js | sha256sum`;
> canonical **包含** `lib/**/*.js.map`,故必须在用本仓库 `tsconfig.json`(`outDir: lib`)构建的树上计算。
> `lib/index.js` 单独出现不得作为身份(580B wrapper)。

### 逐文件留痕

| 文件 | sha256 |
|---|---|
| `src/config.ts` | `f6c1da988ddfbe7832d6aee0a0dc7b63315bd8c4ccaa3bd606df2467797eea4b` |
| `src/hints.ts` | `db54e970ed5d534ffd6221e5586ec33ec559ee9326b4b179d295fcd1063bd4aa` |
| `src/index.ts` | `482874e30c4929cea5b58f6060900b0d6e2b2fa1086b0c23d5aaa93c7e475a3c` |
| `src/manager.ts` | `98da185ca2083ac1c53fd47b945590ed6228b03b5b33b25fef0c868e2d1cdf92` |
| `src/registry.ts` | `08e353dda2454b43e3d76e35bcf9b89e8af402b093163804e6c432f6c99c8998` |
| `src/tools.ts` | `9e869276a1ec38e32d889ed40420cde2926017def471cf9e29a467c8881989e7` |
| `src/types.ts` | `c80b75dd359ecb964a82f353b7c24426d4e0decf4b8fc7138f9a538c68b28e27` |
| `lib/config.js` | `3a5d48ad432c3dcb94817a02308672e76259b716c78769ebb46a48cac71fe54a` |
| `lib/config.js.map` | `eda632047e1b7b63057005734271f17f49ed59b3fbdbd31e60f73d82a9e09e82` |
| `lib/hints.js` | `df073632c3decc3a566aeeaae97002787e1a0d8848df0495ee30b8a5ba26df1d` |
| `lib/hints.js.map` | `41eba3b0cda6c4fa0050b5c83eaa8c53a1f315acc547a20fd4e2ea646596e7d7` |
| `lib/index.js` | `316dd5b6641108fbec213d056a2f2064d6108616de9f01ffdeef06c4215751b3` |
| `lib/index.js.map` | `4c3ae72257e99f3c2d33b5a123b8215e02da63424d46e2fef58b57209512a6da` |
| `lib/manager.js` | `ddc097e60f7d18a2b5aa7ca36f3cc6543c59226d7f520092540542e2a34d73e2` |
| `lib/manager.js.map` | `2f24bd00c60c5bd2f7a8fa67e4b1150894bbca9c1d4ca5410581ea650105621b` |
| `lib/registry.js` | `23e43327551501ac95f65fcee5b3cccca6380fe1a06c26fb9b3b70ce6a43322a` |
| `lib/registry.js.map` | `0097c035a08c1ddec8b8aea7203db8cef8dc37a4dcd7b022dd21eba39499be39` |
| `lib/tools.js` | `6a349766c6ee1356b995404293fe88d060d18ba4cb6302a0497c379a1ff7ed7e` |
| `lib/tools.js.map` | `4f4712dbf1056f083b652f415f6fc3867c3152493fd86b8e958db48442080538` |
| `lib/types.js` | `01ae2a5b120382f9a648ced7ee8507493a134f216d100fc61600c6c9738235d2` |
| `lib/types.js.map` | `a7de897b48fe57bf54d6f84169135ff2e89e2fc95ea0a0a815761cc29a41efee` |
| `lib/types/config.d.ts` | `f256edfe2726514e6e657824591b957cc36ed8c116ca40565ec4a703b0392ceb` |
| `lib/types/hints.d.ts` | `f67e10e767a3c0a310d28f1e6439e1de2769981d6778f08fa34c7bede299ac22` |
| `lib/types/index.d.ts` | `818da89eb9ba434705e348ac3fdee5a3537dc6fea1ec3e793af08615fd4302a2` |
| `lib/types/manager.d.ts` | `6c08f8ea6e84e7fdba907a22bc43e16bff1ab118a08cc3872a11d9cc6bd5bde9` |
| `lib/types/registry.d.ts` | `cd94f1c3a84d05484f1b89895deb26fc9967bc4580832116b5b0eb77e04044f1` |
| `lib/types/tools.d.ts` | `fc538bc218cb792b7ec77e06649c3d3345d151acb176c8e38650ab057c184521` |
| `lib/types/types.d.ts` | `e639d353dc9613318c763e3c5668a5850c2b439638207cd926a9f295371765e3` |

---

## 2. 本地证据(发布前复跑)

| 检查 | 结果 |
|---|---|
| `tsc -p tsconfig.json --noEmit`(CI 的 typecheck) | exit 0 |
| 可复现构建:把仓库复制到临时目录后 `tsc -p tsconfig.json`,与 `lib/` 逐字节比较 | **28/28 文件相同**(含 `.js.map` 与 `lib/types/**`),重建树的 canonical == 上式 64 位值 ⇒ `lib == f(src)` |
| `harness/run-smoke.sh` 连跑两次(私有 `DSH_HOME=/tmp/ms-eng-scratch`) | `85/0`、`85/0`,`externalConfigWrites=0`,stdout 0 字节(零模型调用) |
| `harness/install-scratch.sh` + `harness/bootstrap-profile.sh`(全新 `mktemp -d`,无共享基线) | 三步安装 exit 0;`profile composes: 90 top-level entries` |
| 反空洞变异(私有副本内 6/6,失败集合恰等于预期) | 记录于 `review/findings-r4.md` 与 `harness/README.md`(本轮未重跑) |
| verifier 独立认证(t10) | **CERTIFIED**;hash-stable;其 config `sha256 = 4b1b566347c72ec14b5a0a4eb1ce493c96d516931fb69fea17046ef2d66bc4d7` |
| reviewer 限缩再审(t11 / t13) | **pass**(0 blocker / 0 未闭合) |

认证运行模板(每次判定都必须留档):

```json
{
  "DSH_HOME": "/tmp/ms-eng-scratch",
  "mcpSessionConfigSha256": "4782a601ce552a411d52eb2b6e64f7ac0315ab93ac38969a9b740db0e8fb44c4",
  "canonical": "8921646477ff2a68458f966a158ccc1a66d07956d64cbaf31e91a48b6f7109e0",
  "driver": "dsh-ms-verify@r4 (agent/request parked; zero model calls)",
  "consecutiveRuns": ["85/0", "85/0"]
}
```

---

## 3. 发布门禁(设计 §5.3 九条)

| # | 门禁 | 状态 |
|---|---|---|
| 1 | 窗口纪律:认证窗口内无 `pnpm build` / 变异运行 | ✅ 认证后未再触碰 `src/`、`lib/`(mtime 停在认证前) |
| 2 | 构件身份:发布树上复算 == 认证摘要(完整 64 位)+ 逐文件值留痕 | ✅ 见 §1 |
| 3 | 验证:`run-all.sh` hash-stable 0 失败 + harness 两次一致 + 变异副本内 6/6 且失败集合恰等于预期 | ✅ t10 CERTIFIED;harness 85/0 ×2;变异见 §2 |
| 4 | 评审:verdict = pass,无未闭合 blocker/medium | ✅ t11 = pass、t13 = pass |
| 5 | 官方格式自检:`engines.dsh` / peer `cordis ^4.0.2` / `files` / `exports` / `lib/types/**` / 双语 README / LICENSE / CI / `.gitignore` | ✅ 见 §4 |
| 6 | 证据自证:`implementer-smoke.json` 内嵌 `driver`/`canonical`/`libDigest`/`generatedAt`;认证记录按模板 | ✅ 模板见 §2 |
| 7 | 推送一致性:推送内容 == 认证树;推送后核对远端 commit/tree 与本地摘要一致 | ✅ 经 `/tmp/t12-push.mjs`(显式 allowlist + **API 调用前** canonical 硬闸)推送到 `api.github.com` 的 Git Data API,推送后逐 blob 校验远端 tree == 本地发布树(结果与 `commit`/`tree` SHA 见该次交付回执;发布树全量清单与摘要见 §5) |
| 8 | 用户确认:push 前须用户显式确认 | ✅ 用户已选「认证完成后直接推送」;队长 `go:push` 是执行前置 |
| 9 | 迁移 runbook:pin 迁移 / 灰度顺序(先关 `mcp-lazy-manager`)/ fail-open 与回退 | ✅ `docs/MIGRATION.md` |

---

## 4. 官方格式自检

- `package.json`:`engines.dsh = ">=0.1.5-rc.1"`、`engines.node = ">=22"`、
  `peerDependencies["@deepseek-ai/cordis"] = "^4.0.2"`、`files`、`exports`(含 `./package.json`)、
  `dsh.bundle.patch = "./cordis.patch.yml"`、`main`/`types` 指向 `lib/index.js` / `lib/types/index.d.ts`;
- 声明文件布局:`lib/types/*.d.ts`(每个源模块一份,`types` 与 `exports["."].types` 均指向它);
- 双语 README(`README.md` / `README.zh.md`)+ `LICENSE`(MIT)+ `.gitignore` + `.github/workflows/ci.yml`;
- CI 等价检查(本地已跑):`pnpm install --frozen-lockfile` 的等价物是既有 `node_modules` 农场;
  `pnpm run typecheck` = `tsc -p tsconfig.json --noEmit` **exit 0**;
  `pnpm run build` 的等价检查见 §2「可复现构建」;CI 里另加两步:
  `git diff --exit-code -- lib`(提交的 `lib/` 不许陈旧)与打印 canonical/指纹。

---

## 5. 发布树定义与复现

**发布(=推送)清单**:`package.json`、`cordis.patch.yml`、`src/**`、`lib/**`(含 `.js.map` 与 `lib/types/**`)、
`tsconfig.json`、`pnpm-lock.yaml`、`README.md`、`README.zh.md`、`LICENSE`、`.gitignore`、
`.github/workflows/ci.yml`、`docs/**`、`harness/**`。

**不发布**:`verification/**`(验证者 V1–V8 矩阵)、`review/**`(评审 findings)、`node_modules/**`。

**一处已处置的发布面残留(如实记录)**:插件根目录**曾经**存在一个名实不符的文件 ——
文件名是当前认证摘要
`8921646477ff2a68458f966a158ccc1a66d07956d64cbaf31e91a48b6f7109e0`,内容却是一次参数写坏的
`NOT_CERTIFIED` 记录(验证侧 `certify.sh` 早期 `argv` 错位的产物,该 bug 已修)。它不在
`src`/`lib` 内,**不影响 canonical**。发布前已**归档到
`verification/legacy/stray-notcertified-record-1725.json`**(`verification/` 在 `.gitignore` 中,
不进公开树)**并删除根目录同名文件**;处置前后 canonical 未变 ⇒ 本发布树不含它。

**为什么连 `.js.map` 一起发布**:canonical 覆盖 `lib/**/*.js.map`。姊妹插件(`dsh-restart-button`)
的 `.gitignore` 忽略 map,那样 clone 下来**复现不出**上面的 64 位值;本仓库刻意不忽略,
以便「发布树 == 认证树」这条门禁可以被任何读者独立验证。

**读者复现**:`git clone` 后在仓库根执行 §1 的两条命令(注意 `cwd` 即仓库根,操作数恰为 `src lib`),
应得到 `8921646477ff2a68458f966a158ccc1a66d07956d64cbaf31e91a48b6f7109e0`。

**发布树身份(全量清单 + 摘要,与 §1 的构件身份并列——后者只覆盖 `src`+`lib`,前者覆盖整个发布内容)**:
对发布清单取「排序后逐文件 sha256、再把清单文本 sha256」。本仓库有**两次提交**,各有一对数字:

| 提交 | 内容 | 全量 | `releaseTreeDigest`(不含本文件) |
|---|---|---|---|
| **第一次** `192fb431da663adbae89c359b9ce2654a3f299b0`(root) | 首次发布;`harness/mutate-and-check.sh` = 18:34 版 | 48 文件 / **402,387** 字节 | **`831ea26718ec1dc7b512a4cfbbec030315e06fec918aae68350ea4b30453512e`**(47 文件) |
| **第二次**(本提交,HEAD) | 落地 harness 收敛补丁(`harness/mutate-and-check.sh` + `harness/README.md`)并修正本文数字 | 48 文件 | **`70a2224b0870b46e142389830a89a238fd973763dc5fe929fbd8871d2ac277e0`**(47 文件 / **392,802** 字节) |

> **为什么第二次不写"全量字节数"**:全量含本文件自身,而本文每次编辑都会改变它 ⇒ 该数字**不可自洽地稳定书写**
> (写进去就变)。故第二次只给**可稳定复算**的口径:47 文件子集(392,802 字节)+ 上面的摘要值。
> 历史勘误:第一次提交时本文曾写"48 文件 / 400,151 字节",那是更早的测量值,实际为 **402,387** 字节。

该摘要值**刻意不覆盖本文件自身**(`docs/release-report.md`),覆盖范围 = 发布清单里除本文件外的 **47 个文件**;
因此在本文中写入它不会改变它,任何人可稳定复算,用于核对"仓库内容是否被后续改动"。复算方式(仓库根、原样执行):

```sh
find . -type f -not -path './node_modules/*' -not -path './review/*' -not -path './verification/*' \
  -not -path './.git/*' -not -name '*.log' -not -path './docs/release-report.md' \
  | sort | xargs sha256sum | sha256sum
```

> 与 §1 的区别:`canonical` 是**构件身份**(只在 `src`+`lib`、用于与认证运行比对);`releaseTreeDigest`
> 是**发布内容身份**(覆盖 README/package.json/docs/CI 等)。两者互补,缺一不可 —— 只锚前者时,
> 文档或包元数据被改将无人可查。

**harness 收敛补丁:已在第二次提交落地(如实记录)**:第一次提交里的 `harness/mutate-and-check.sh` 是 18:34 版;
其收敛补丁 —— self-proof 文件名按分支区分(`<label>.<branch>.selfproof.json`,收口评审预登记闸门 `gate 3b`)、
`$MS_MUT_DIR/delivered-tree.json`(L5 机器可读记录)、README 的 INCONCLUSIVE 六类枚举与命名文案同步、旧命名引用清零 ——
已在**第二次提交**落地,落地后两文件逐字节等于被审 artifact:
`harness/mutate-and-check.sh` = `3265045d46b2842ba7865747744fca708cba44465161426c508f94bc7bd97bc8`(20,058 B)、
`harness/README.md` = `6a7daf4a91c410ee4ebc6c847f63d215ea72d629e0100d6e54bd21bbf09b89e0`(25,916 B)。
该补丁只改 `harness/**`,**`src`+`lib` 的 canonical 全程不变**(仍为 `89216464…`)。

**推送方式**:本机 `github.com:443` 不可达,故走 `api.github.com` 的 Git Data API
(`blob → tree → commit → ref`),与 `dsh-restart-button` / `dsh-software-tools` 相同的账号与通道;
推送后核对远端 `commit`/`tree` 与本地逐文件 sha256 清单一致,远端 SHA 记入交付回执。
