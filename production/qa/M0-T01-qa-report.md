# M0-T01 · QA 证据评审与测试门控报告

| Field | Value |
|---|---|
| Task | **M0-T01-E** 质量门（独立证据评审与测试门控） |
| 阶段 | Phase 3 · 技术搭建 收尾门 |
| 评审者 | 严守真（quality-lead）· **独立验证者（fresh eyes）** |
| 评审对象 | `engineering-lead` 的 M0-T01 交付（Headless Harness + 工程基座） |
| 工作区 | `D:/Project/Wkbd-project/my-hades` |
| 环境 | Windows + Git Bash，Node v22.22.2，npm（lockfileVersion 3） |
| 日期 | 2026-09-28 |

> **评审原则**：不采信自述，用独立断言证伪。所有结论均附真实命令输出。
> **未修改 `src/` 产品代码；未 git commit。**
>
> **修订记录（rev.2）**：经主理人决定性对照实验裁定（§11）并由本人独立复现，**初版 §6 行③「`npm ci` 不会失败」的判定错误，已撤回并更正为「成立」**；R1 为**真实缺陷**（engineering-lead 诊断正确）。C1/C2 均已关闭，最终判定由 CONCERNS 更正为 **PASS**。详见 §6、§7、§11。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| 自动测试（工程套件） | ✅ 5 文件 / 23 用例 全通过，退出码 0 |
| 自动测试（含独立套件） | ✅ 6 文件 / **42 用例** 全通过，退出码 0 |
| `npm run typecheck` | ✅ 零错误，退出码 0 |
| 独立对抗性测试（本报告新增） | ✅ 19 用例 全通过（**0 功能性缺陷**） |
| 静态审查（纯逻辑 / 类型 / 配置） | ✅ 无 DOM、无墙钟、无 `any` 逃逸、strict 全开、无 jsdom、运行时依赖为空 |
| 精度声明复核 | ✅ **实测成立**（严格相等，非容差） |
| R1（锁文件平台包缺口）复核 | ✅ **真实缺陷**，已由 engineering-lead 修复并经三重独立验证（见 §6、§11） |
| **质量门判定** | ✅ **PASS**（C1/C2 均已关闭；见 §7、§11） |
| 与工程成员汇报不符之处 | **1 处**（Q-1 流程项，见 §5）；R1 自述经复核**属实** |

**一句话**：M0 确定性内核经 19 条独立对抗性用例证伪**未发现任何功能性缺陷**，全部 AC 判定 ADEQUATE；R1 为真实缺陷且已修复并经三重独立验证；C1（评审窗口并发改写，主理人编排失误）由主理人裁定并关闭。**最终判定 PASS，可解锁 M1。**

---

## 1. 自动测试证据（真实输出）

### 1.1 工程套件（复跑）
```
$ npm run test
 ✓ tests/harness/input-timing.test.ts (6 tests) 19ms
 ✓ tests/harness/determinism.test.ts  (2 tests) 15ms
 ✓ tests/harness/snapshot.test.ts     (4 tests) 36ms
 ✓ tests/harness/ecs.test.ts          (5 tests) 20ms
 ✓ tests/harness/clock.test.ts        (6 tests) 28ms
 Test Files  5 passed (5)
      Tests  23 passed (23)
EXIT=0
```
→ **与 engineering-lead 自述「5 文件 / 23 用例全通过」一致。**

### 1.2 含独立套件（本报告新增）
```
$ npm run test
 ✓ ... 5 engineering files ...
 ✓ tests/harness/independent-verify.test.ts (19 tests) 49ms
 Test Files  6 passed (6)
      Tests  42 passed (42)
EXIT=0
```

### 1.3 类型检查
```
$ npm run typecheck   # tsc --noEmit
（无输出）
EXIT=0
```
→ **与自述「零错误」一致。**

### 1.4 Flaky 探测（随机顺序 × 3）
```
$ npx vitest run --sequence.shuffle   # seed 1790580361262 / 1790580xxxx
Tests  40 passed (40)   # 首次（含独立套件前）
Tests  40 passed (40)   # 第二次
Tests  40 passed (40)   # 第三次
```
→ 随机顺序下稳定全绿，**未观察到 flaky**（详见 §8）。

---

## 2. 独立对抗性测试结果

新增文件：`tests/harness/independent-verify.test.ts`（**19 用例，全部通过**）。
**断言全部由本人独立编写**，未复制工程成员的用例；测试内自带独立 fixture（`Pos`/`Vel`/`Mover`/`Spy`），不依赖 `fixtures.ts`。

| # | 攻击面 | 用例数 | 结果 | 关键断言 |
|---|---|---|---|---|
| 1 | 精度边界 | 5 | ✅ | `step(1)→elapsedSeconds===1/60`；`step(60)→===1.0`（**严格相等**）；`step(3600)→===3600*(1/60)===60`；乘法误差 **0** vs 朴素累加漂移 **2.12e-12**；常量 `===1000/60` |
| 2 | Snapshot 不可变攻击 | 3 | ✅ | `entities.push()`、`data.x=999`、`(snap).tick=1`、`component.type=…` **全部抛 TypeError**；攻击后图不变；旧 snapshot 不随 live world 变化 |
| 3 | 输入时序攻击 | 3 | ✅ | tick=10 事件在 tick 0–9 不可见、tick=10 恰好一次、tick 11–20 **不重复投递**；同 tick FIFO；当前 tick 注入为合法边界 |
| 4 | 非法输入矩阵 | 3 | ✅ | `step(-1)/(1.5)/(NaN)` 抛 RangeError；`step(0)` 合法 no-op；已过/负数/非整数 tick 注入抛 RangeError；`runTo` 回退抛错 |
| 5 | ECS 确定性 | 2 | ✅ | `listEntities/query` 升序稳定；销毁后从 query 与 snapshot 消失；同构造顺序跨实例一致 |
| 6 | 系统执行顺序（spec §6.3） | 2 | ✅ | 注册顺序每 tick 各执行一次（`0:A,0:B,0:C,1:A,1:B,1:C`）；重名系统拒绝注册 |
| 7 | 确定性回放 | 1 | ✅ | 两个独立 Simulator 实例逐 tick `toEqual` 完全一致 |

**发现的功能性缺陷：0。**

> 精度声明的独立复核（`node -e` 实测）：
> `60*(1/60) === 1.0 → true`；`3600*(1/60) === 60 → true`；`6000*(1/60) === 100 → true`。
> 朴素累加 3600 次误差 `2.12e-12`，本实现乘法误差 `0`。→ 自述的精度设计**属实**。

---

## 3. 逐项 AC 覆盖判定表

| AC | 验收项 | 是否有测试 | 判定 | 说明 |
|---|---|---|---|---|
| AC-01 | 时钟精度 60 tick = 1.0s | ✅ clock.test + **独立** | **ADEQUATE** | 独立套件以严格相等复核，强于容差断言 |
| AC-02 | Tick 换算 `1000/60` | ✅ clock.test + **独立** | **ADEQUATE** | 含 `tickDurationMs===fixedDelta*1000` |
| AC-03 | 输入时序（tick=10/20） | ✅ input-timing + **独立** | **ADEQUATE** | 独立覆盖「不早/恰好一次/不重复」三态 |
| AC-04 | 输入边界（tick=0 / 抛错） | ✅ input-timing + **独立** | **ADEQUATE** | 负数/非整数/已过 tick 全覆盖 |
| AC-05 | 同 Tick FIFO | ✅ input-timing + **独立** | **ADEQUATE** | |
| AC-06 | Snapshot 不可变 | ✅ snapshot + **独立** | **ADEQUATE** | 独立追加「攻击后图不变」+「零引用共享」 |
| AC-07 | 确定性回放 | ✅ determinism + **独立** | **ADEQUATE** | |
| AC-08 | ECS 基础 | ✅ ecs + **独立** | **ADEQUATE** | |
| AC-09 | 类型安全（typecheck 零错） | ⚠️ 过程门（非用例） | **ADEQUATE** | 实测退出码 0；`any` 逃逸静态审查通过 |
| AC-10 | 纯逻辑（无 DOM / node 环境） | ⚠️ 静态审查 | **ADEQUATE** | 见 §4 |

**无「规格写了但没测」的关键项**；唯一原缺口是 spec §6.3「系统执行顺序确定」原先无直接断言，已由本报告独立套件补齐（见 §2 #6）。

**规格 ↔ 实现的自洽性（文档级 nit，非缺陷）**：
| # | 位置 | 现象 | 判定 |
|---|---|---|---|
| N1 | spec §6.1 | 规格称 `Entity = 整数 ID + 存活标记`；实现 `Entity` 仅含 `id`，存活标记在 `World` 内维护 | Minor（实现更合理，属规格措辞滞后） |
| N2 | spec §6.2 | 规格签名 `addComponent(...): void`；实现返回 `T`（更宽松的超集） | Minor |
| N3 | spec §4.2 | 规格提到 Simulator 侧 `enqueue(event)`；实现暴露 `inject(event)`（`InputQueue` 内部才有 `enqueue`） | Minor（API 命名漂移） |

---

## 4. 静态审查发现

### 4.1 浏览器 / 墙钟依赖（确定性杀手）
```
$ rg -n 'document|window|HTMLCanvasElement|requestAnimationFrame|performance\.now|Date\.now|setInterval|setTimeout|localStorage|navigator|globalThis' src/
(none)
```
→ **零命中**。`src/` 无任何 DOM / 墙钟 / 定时器依赖。✅ 符合 spec 约束 C1（纯逻辑）/ C2（确定性）。

### 4.2 `any` 逃逸 / `@ts-ignore` / 非空断言
```
$ rg --pcre2 -n '[A-Za-z0-9_\)\]]!(?![=])' src/        # 非空断言
(none)
$ rg -n 'any|@ts-ignore|@ts-expect-error|@ts-nocheck' src/
src/ecs/Component.ts:17:  * Declared with `never[]` params so any concrete constructor is assignable.  ← 注释，非类型
$ rg -n '\bas\b' src/
src/core/GameSimulator.ts:149:  const source = component as unknown as Record<string, unknown>;
src/core/snapshot-utils.ts:14/25/31:  as Record<string, unknown> / as Readonly<T>
src/ecs/World.ts:40/52:  as ComponentCtor / as T | undefined
src/ecs/Component.ts:12:  true as const
```
→ **无 `any`、无 `@ts-ignore/@ts-expect-error`、无非空断言 `!`**。
仅 1 处双重转换 `as unknown as Record<string, unknown>`（`GameSimulator.ts:149`，为读取任意组件字段的**有意**窄化，无 `any`），其余为安全的 `as const` / 结构窄化。✅ 符合 spec 约束 C3。

### 4.3 工具链配置
| 检查 | 实测 | 判定 |
|---|---|---|
| `tsconfig.strict` | `true` | ✅ |
| 额外严格开关 | `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`/`noImplicitOverride`/`noImplicitReturns`/`noUnusedLocals`/`noUnusedParameters`/`useUnknownInCatchVariables` 全开 | ✅ **强于「strict 全开」** |
| `lib` 是否含 DOM | `["ES2022"]`（**不含 DOM**） | ✅ |
| `types` | `["node","vitest/globals"]` | ✅ |
| `vitest.config.ts` 环境 | `environment: 'node'`，`pool: 'threads'` | ✅ 无 jsdom |
| `node_modules/jsdom` | 不存在 | ✅ |
| `package.json.dependencies` | `{}`（运行时依赖为空） | ✅ 符合 spec 约束 C4 |
| `devDependencies` | `@types/node`, `typescript`, `vitest` | ✅ 符合 spec 约束 C4 |

### 4.4 观察项（非缺陷，建议登记）
- **O1（Minor/Info）输入事件未深拷贝**：`inject(event)` 直接存引用，`ctx.input` 亦未运行时冻结（仅类型 `ReadonlyArray`）。系统理论上可改注入事件的嵌套 `vector` 对象，污染调用方持有的同一对象。规格未要求输入不可变，故**不判缺陷**，但 M1 若出现多消费者建议冻结/克隆输入帧。
- **O2（Info）`vitest.config.ts.timestamp-*.mjs` 临时文件**散落在根目录（已在 `.gitignore`），无害。

---

## 5. Bug 清单

**未发现功能性 Bug（Blocker/Critical/Major/Minor 均为 0）。**

以下为**流程**问题，非产品缺陷：

### Q-1（Major · 流程）评审期间产物被并发改写
- **现象**：评审开始时 `package-lock.json` 为 **620 行 / 15553 字节**（`ls -la` 实测），且其 `packages` 段**不含**任何 `node_modules/@esbuild/*`、`node_modules/@rollup/*` 解析条目；评审中该文件变为 **1475 行 / 47470 字节**（mtime 15:29），并补齐全部平台二进制条目。
- **证据**：npm 调试日志显示 15:30–15:31（本地）存在 **cwd = 项目根** 的非本人命令（`run test`、`run typecheck`）及一个本人未创建的 `.tmp/citest` 目录（`ci --dry-run`）。本人的所有 npm 命令均在隔离的 `.tmp/r1-*` 子目录运行，**不可能**写项目根 lockfile。
- **根因**：主理人在评审窗口内**并行派单** engineering-lead 修复锁文件（**主理人编排失误**，非工程成员问题，见 §11）。
- **影响**：QA 无法对一个「评审中自变的产物」给出冻结签收。
- **处置**：见 §7 C1（已 CLOSED）。

### Q-2（已撤销 · 主理人裁定）R1 自述**属实**，非误报
本报告初版曾判定 R1 自述「`npm ci` 会失败」不成立。经主理人决定性对照实验（§11）及**本人独立复现**（94/92 包对照，见 §11.3），该判定**被推翻并撤回**：`npm ci` 严格由锁文件驱动，缺失的 optional 平台包会被**静默跳过**（不报错），导致原生二进制缺失。**engineering-lead 的 R1 诊断为真实且正确。** 详见 §6。

---

## 6. R1 复核结论（独立诊断，rev.2 已更正）

> 原自述：首次 `npm install` 因 Windows esbuild EBUSY 中断，导致 `@rollup/rollup-win32-x64-msvc` 与 `@esbuild/win32-x64` 未进入 lockfile 常规解析路径；换机 / `npm ci` 会失败。

**逐条核实（当前产物 + 独立实验）：**

| 命题 | 结论 | 证据 |
|---|---|---|
| ① 两个平台包**不在** lockfile 解析树内 | **评审开始时成立，现已修复** | 开始时 lockfile 620 行，`rg 'node_modules/@esbuild' package-lock.json` 无命中；现 lockfile 1475 行，含 `node_modules/@esbuild/win32-x64`(L393)、`node_modules/@rollup/rollup-win32-x64-msvc`(L770) |
| ② 现 lockfile 是否健康 | **健康** | `npm install --package-lock-only` 重新生成的 lockfile 与现有 lockfile **逐字节相同**（`diff` 无差异） |
| ③ 换机 / `npm ci` 是否会失败 | **✅ 是（自述成立；初版「否」的判定已撤回）** | 隔离对照实验（主理人提出 + **本人独立复现**，见 §11）：`complete/` → `npm ci --dry-run` 计划安装 **94 包**（含 `@esbuild/win32-x64`、`@rollup/rollup-win32-x64-msvc`）；`stripped/`（仅删这两条 `packages` 条目）→ **92 包，两包双双消失**。`npm ci` 严格由锁文件驱动，缺失条目被**静默跳过**（退出码仍为 0、不报错），原生二进制缺失 → Windows 上 vitest 启动即 `MODULE_NOT_FOUND` |
| ④ 本次环境 `npm ci` 报错的性质 | **沙箱环境产物（与 ③ 的锁文件缺陷并存，互不冲突）** | 真实 `npm ci` 在 esbuild `postinstall` 阶段失败（`install.js` spawn `esbuild --version`，`pid:0/signal:null`），且 npm cleanup 被注入的 `node-safe-delete-shim.cjs` 拦截；而**项目内**同一 esbuild 二进制可正常 spawn。此为独立的环境事实，与 ③ 不冲突 |

**R1 最终判定**：**真实缺陷，已由 engineering-lead 修复，并经三重独立验证**。
- engineering-lead 的 R1 诊断（两平台包未进入 lockfile 解析路径 → `npm ci` 会失败）**完全正确**，非误报。
- **三重独立验证**：
  1. **本人**：修复后的 lockfile 与 `npm install --package-lock-only` 重新生成结果**逐字节相同**（`diff` 无差异）；
  2. **engineering-lead**：修复后 `npm ci --dry-run` 退出码 0、完整安装；
  3. **主理人 + 本人复现**：`complete/`(94 包) vs `stripped/`(92 包) 对照，证明缺失条目被**静默跳过**（§11）。
- **初版错误根因（自我复盘）**：本人验证「`npm ci` 不失败」时使用了**修复后**的锁文件（混淆变量），据此否定「修复前会失败」在逻辑上不成立；且错误地推断「`npm ci` 会从 registry 重新解析 `optionalDependencies`」——实测证明该推断**错误**，`npm ci` 是严格锁文件驱动的。
- **修复建议**：无需 `rm -rf` 或重装；R1 已随锁文件补全关闭（见 §7 C1）。

---

## 7. 质量门判定

> ### ✅ PASS
> M0 确定性内核经 19 条独立对抗性用例证伪**未发现功能性缺陷**，全部 AC 判定 ADEQUATE；R1 真实缺陷已修复并经三重独立验证；C1/C2 均已关闭。**可解锁 M1。**

**关注项状态（均已关闭）：**

| ID | 严重度 | 关注项 | 状态 |
|---|---|---|---|
| **C1** | Major（流程） | 评审期间 `package-lock.json` 被并发改写（Q-1），签收无法绑定冻结版本 | ✅ **CLOSED** — 主理人裁定：根因为主理人在评审窗口内并行派单（编排失误，非工程成员问题）；冻结窗口已关闭，最终锁文件冻结于 `sha256=03ecd9eb…f9fe737`；实验 A 证明冻结后 `npm ci --dry-run` 退出码 0、完整安装 94 包（含两个 Windows 原生二进制） |
| **C2** | Minor | 初版误判 R1 自述不成立（Q-2） | ✅ **CLOSED** — 原自述**成立**，R1 为**真实问题**；本项无需工程方更正，已改为记录主理人裁定证据（§11） |

**无 Blocker / Critical。** 最终门控判定：**PASS**。

---

## 8. Flaky 风险评估：**低**

- 3 次随机顺序（`--sequence.shuffle`）全绿；套件无随机数、无定时器、无网络、无文件 IO、无并发共享状态。
- `pool: 'threads'` + `environment: 'node'`，无 jsdom/全局污染。
- 唯一理论风险：`World` 用 `Map`/`Set` 迭代（`listComponents`/`query`），但输出均**显式排序**（`listComponents` 按 `constructor.name`，`query`/`listEntities` 按 id 升序），跨实例稳定；独立套件已复核顺序确定性。
- 结论：**无需隔离的 flaky 测试**。

---

## 9. 签收基线（Artifact Hashes）

| 文件 | md5 / sha256 |
|---|---|
| `package-lock.json` | md5 `a7d4f3a08f28bcc3ffd4d14eae1d02b2` · **sha256 `03ecd9eba479ddc5b697420a9c6f493515df80fe3b6e4703c37fd66b1f9fe737`（冻结基线）** |
| `package.json` | `bf2b5e6f30154843f3cccea69d9a443f` |
| `tsconfig.json` | `6e599a8b2d8181a6bc2af26f7a138664` |
| `vitest.config.ts` | `5ddc26a4b803f66b410efdbe53066682` |
| `specs/00_harness_spec.md` | `61407110d8b1029bff5452247b9a989a` |
| `src/core/GameSimulator.ts` | `01a55718dd34c83e214bb3f19f1f2ba2` |
| `src/core/clock.ts` | `fb41ff511181ccbf0a89598394c30366` |
| `src/core/input.ts` | `2c89cac58a129a5ca7ccee9e11902d50` |
| `src/core/snapshot-utils.ts` | `2bdad45549159250cf84672ea3931018` |
| `src/ecs/World.ts` | `550be7c2be1a04711b9c7ee2dbddc343` |
| `tests/harness/independent-verify.test.ts` | `3efe29fa62f89e7607224ef34103449a` |

> ⚠️ 若任一 `src/` 或 lockfile 在上表哈希之外发生变更，本门结论**自动失效**，需重跑。

**评审产生的临时目录（已在 `.gitignore`，可安全手动删除）**：`.tmp/r1-check`、`.tmp/r1-fresh`、`.tmp/r1-regen`、`.tmp/qa-repro`（本人的隔离诊断副本；未触碰项目 `node_modules`）。`.tmp/citest`、`.tmp/adjudicate` 非本人创建。

---

## 10. 待用户审批项 / 下一步建议

**待用户审批：**
1. 是否接受 **PASS** 判定并解锁 M1。
2. 是否批准将 `tests/harness/independent-verify.test.ts`（19 用例）**并入常驻回归网**。

**下一步建议：**
1. 后续 M1：把 `independent-verify.test.ts` 纳入 CI 常规门控；对输入帧不可变性（O1）在出现多消费者时补冻结/克隆。
2. 建立「QA 评审冻结窗口」约定：评审期间禁止其它 agent 改写受审产物，避免 Q-1 复现（本次 C1 根因）。
3. 换机 / CI 前，用 `sha256` 校验 `package-lock.json` 与 §9 冻结基线一致，防止再次出现 R1 类锁文件缺口。

---

## 11. 主理人裁定记录

### 11.1 裁定事项
主理人裁定：本报告初版 §6 行③「换机 / `npm ci` 是否会失败 → 否」及由此衍生的「C2 事实纠正」**判定错误**，需更正。

### 11.2 主理人决定性实验（原文摘录）
在工作区构造两份对照：
- `complete/`：现锁文件原样
- `stripped/`：从现锁文件中**仅删除** `node_modules/@esbuild/win32-x64` 与 `node_modules/@rollup/rollup-win32-x64-msvc` 两个 `packages` 条目（其余不动），复现「修复前」形态

`npm ci --dry-run` 输出：
```
A) complete  → add @rollup/rollup-win32-x64-msvc 4.63.5
               add @rollup/rollup-win32-x64-gnu   4.63.5
               add @esbuild/win32-x64             0.21.5
               added 94 packages   EXIT=0

B) stripped  → add @rollup/rollup-win32-x64-gnu   4.63.5   ← 只剩这一个
               （无 @rollup/rollup-win32-x64-msvc，无 @esbuild/win32-x64）
               added 92 packages   EXIT=0
```

主理人结论：
1. `npm ci` 确实**不报错**（退出码 0），不存在 `Missing: ... from lock file` 硬失败；
2. 但 `npm ci` **不会**从 registry 重新解析 `optionalDependencies`——它**严格锁文件驱动**，锁文件里没有解析条目就**静默跳过**（实验 B 包数 94→92、两包消失即为铁证）；
3. 修复前锁文件下，Windows 机器 `npm ci` 后原生二进制缺失 → vitest 启动即 `MODULE_NOT_FOUND`。**engineering-lead 的 R1 诊断正确且真实**；
4. 初版验证被**混淆变量**误导（使用了修复后的锁文件）。

### 11.3 本人独立复现（QA 复核，未采信权威、亲自复跑）
```
$ sha256sum package-lock.json
03ecd9eba479ddc5b697420a9c6f493515df80fe3b6e4703c37fd66b1f9fe737   ← 与主理人冻结值一致

# stripped/ 仅删除两个 packages 条目（node 脚本，其余不动）
stripped node_modules/@esbuild/win32-x64            present_before= true
stripped node_modules/@rollup/rollup-win32-x64-msvc present_before= true

=== A) complete ===
add @rollup/rollup-win32-x64-msvc 4.63.5
add @rollup/rollup-win32-x64-gnu 4.63.5
add @esbuild/win32-x64 0.21.5
added 94 packages in 2s
EXIT=0

=== B) stripped ===
add @rollup/rollup-win32-x64-gnu 4.63.5
added 92 packages in 2s
EXIT=0
```
→ **本人独立复现与主理人实验逐字一致**。裁定成立：`npm ci` 严格锁文件驱动、缺失 optional 平台包被静默跳过；**R1 为真实缺陷**；本报告初版 §6 行③ 判定错误，已撤回并更正（见 §6、§5 Q-2、§7 C2）。

### 11.4 C1 处置（主理人认领）
主理人确认 C1 根因为其**在评审窗口内并行派单**修复锁文件（编排失误，非工程成员问题）；现冻结窗口已关闭，最终锁文件冻结于 `sha256=03ecd9eb…f9fe737`，并以实验 A 证明冻结后 `npm ci --dry-run` 退出码 0、完整安装 94 包。**满足 §7 为 C1 设定的关闭条件 → C1 CLOSED。**
