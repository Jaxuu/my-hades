# ADR-001 · 采用纯逻辑 Headless ECS + Fixed-Tick 作为架构基座

| 字段 | 值 |
|---|---|
| **ADR ID** | ADR-001 |
| **标题** | 纯逻辑 Headless ECS + Fixed-Tick 时钟 |
| **状态** | ✅ **Accepted**（2026-09-28） |
| **决策者** | 游承峰（主理人）· 程基岩（技术负责人） |
| **相关 Spec** | `specs/00_harness_spec.md`、`specs/01_character_controller_spec.md` |
| **影响面** | 全项目（自 M0 起）；所有后续里程碑必须遵守 |
| **取代** | 无 |

---

## 1. 背景与问题（Context）

我们要复刻《Hades》的核心玩法：动作肉鸽。这类游戏的本质特征是——

- **高速动作战斗**：判定必须精确、可复现，玩家会抱怨"我明明躲开了"。
- **肉鸽随机性**：房间、祝福、敌人组合由种子驱动，**同一种子必须得到同一局**。
- **数值平衡是核心工作**：需要能跑成千上万局自动对局来验证平衡，而不是靠人肉试玩。
- **长生命周期**：上线后要持续加内容（新武器、新祝福、新敌人），架构必须扛得住增量。

同时我们面对一个现实约束：**AI 辅助开发是主力工作流**。这意味着代码必须能被**机器自动验证**——
"能编译 + 能跑测试 + 结果确定" 是 AI 协作的前提。任何需要人眼盯着画面才能判断对错的架构，都会让自动化流水线失效。

**核心问题**：如何组织游戏代码，使得玩法逻辑既可被机器精确验证，又能在未来接上渲染层而不返工？

---

## 2. 决策驱动因素（Decision Drivers）

| # | 驱动因素 | 权重 |
|---|---|---|
| D1 | **确定性**：同输入 ⇒ 同输出，支持回放、回归比对、自动对局 | 最高 |
| D2 | **可自动化验证**：测试无需图形环境即可运行（CI 友好） | 最高 |
| D3 | **逻辑/渲染解耦**：渲染技术选型（Canvas / WebGL / 原生 / 编辑器）不得倒逼玩法重构 | 高 |
| D4 | **性能可预测**：不因 GC 抖动或帧率波动影响判定 | 高 |
| D5 | **增量扩展成本**：新增系统/组件不修改既有系统 | 中 |
| D6 | **上手成本**：新成员（含 AI）能快速理解数据流 | 中 |

---

## 3. 备选方案（Alternatives Considered）

### 方案 A：引擎内置方案（Unity / Godot / Unreal）
- ✅ 自带渲染、物理、编辑器、资产管线，起步快。
- ❌ **逻辑与渲染强耦合**：玩法逻辑活在 `MonoBehaviour` / `Node` 里，脱离引擎就无法运行，
  导致单测必须启动编辑器/运行时（慢、脆、CI 成本高）。
- ❌ 确定性难以保证：引擎的物理、浮点、更新顺序不完全可控；`Time.deltaTime` 是**可变步长**，回放会漂移。
- ❌ 与本项目「AI 主力开发 + 机器验证」的工作流冲突。
- **结论：否决。** 不是引擎不好，而是它与 D1/D2 直接冲突。

### 方案 B：浏览器内 ECS（JS + Canvas/WebGL 同进程）
- ✅ 实现直接、迭代快、调试直观。
- ❌ 逻辑与渲染同进程，容易顺手在系统里读 `document` / `requestAnimationFrame` / `performance.now()`，
  **确定性被墙钟污染**，回放失效。
- ❌ 单测需 jsdom 或浏览器环境，慢且脆弱。
- ❌ 渲染帧率与逻辑步长耦合，掉帧即改变模拟结果。
- **结论：否决。** 违反 D1/D2/D3。

### 方案 C（**采纳**）：纯逻辑 Headless 内核 + 固定步长时钟，渲染层作为只读消费者
- 玩法逻辑是**纯 Node.js 代码**，零 DOM、零图形依赖、零运行时依赖。
- 时间**只由 `step(ticks)` 手动推进**，绝不读墙钟；每 Tick 时长恒为 `1/fps`。
- ECS 承载状态；系统每 Tick 按注册顺序执行。
- 世界状态通过**深拷贝 + 冻结的只读 Snapshot** 对外暴露；渲染层只能读，不能写。

---

## 4. 决策（Decision）

**我们采用方案 C：纯逻辑 Headless ECS + Fixed-Tick 时钟。**

具体固化为以下五条不可协商的规则（NON-NEGOTIABLE）：

| # | 规则 | 理由 |
|---|---|---|
| R1 | **`src/` 禁止任何 DOM / Canvas / WebGL / 图形库引用**（`document`、`window`、`HTMLCanvasElement`…） | 保证内核可在纯 Node 环境运行（D2/D3） |
| R2 | **时间只由 `step(ticks)` 推进**；禁止 `Date.now()`、`performance.now()`、`requestAnimationFrame`、`setInterval` | 确定性（D1）；墙钟会让回放漂移 |
| R3 | **每 Tick 时长恒为 `fixedDeltaSeconds = 1 / fps`**，由 `GameSimulator` 注入到 `SystemContext`；系统**禁止硬编码** `1/60` 或 `16.67ms` | 换 fps 后行为一致；避免 `60 × 16.67ms = 1000.2ms ≠ 1s` 这类精度事故 |
| R4 | **状态对外只读**：`snapshot()` 返回深拷贝 + 递归冻结的对象，与实时世界零引用共享 | 渲染层无法反向污染模拟（D3）；保证回放可信 |
| R5 | **系统执行顺序确定**：按注册顺序每 Tick 执行一次；实体遍历按 id 升序 | 确定性（D1） |
| R6 | **字符串排序 / 比较一律使用 UTF-16 码元序**（`a < b` / `a > b`，或 `sort()` 的默认比较）；**禁止 `localeCompare`** 及任何依赖语言环境 / ICU 数据 / 时区的比较 API | 确定性（D1）：`localeCompare` 的结果由**运行环境的 locale 与 ICU 数据**决定，同一份代码在两台机器（或不同 Node 构建）上可能排出不同顺序。它一旦出现在进入快照的排序路径上（如 `World.listComponents` 按组件类型名排序），回放比对就会跨机器失败 |

### 4.1 为什么 Fixed-Tick 而不是可变步长（Variable Timestep）？
可变步长（`dt = 本帧真实耗时`）写起来更省事，但它把**物理结果与硬件性能绑死**：
同一段输入在 60Hz 和 144Hz 机器上会得到不同轨迹，回放、平衡模拟、自动化测试全部失效。
Fixed-Tick 用"时间换确定性"：逻辑步长恒定，渲染可以自由插值——这是 D1 的唯一可行解。

### 4.2 为什么 Snapshot 要深拷贝 + 冻结，而不是直接暴露 World？
直接暴露 `World` 让渲染层读写会引入**隐式耦合**：某天某个渲染回调顺手改了 `transform.x`，
模拟就分叉了，而且这种 bug 极难定位。冻结 + 深拷贝把"只读"从**约定**变成**运行时强制**，
失败会立刻抛 `TypeError` 而不是静默产生错误状态。

### 4.3 为什么是 ECS 而不是 OOP 继承树？
《Hades》类游戏需要**高频组合**：一个实体可能同时是"可移动 + 可受伤 + 有 AI + 有碰撞"。
继承树会导致"钻石继承"或"上帝基类"；ECS 用组合替代继承，新增能力=新增组件+系统，
不改既有代码（D5），也天然契合"数据驱动 + 可序列化"（D1）。

---

## 5. 后果（Consequences）

### 5.1 正面
- ✅ **测试可在 CI 里秒级跑完**：纯 Node + Vitest，无需图形栈。当前 7 文件 / 54 用例约 1.2s。
- ✅ **确定性可被机器证明**：同输入序列跑两遍，Snapshot 逐 Tick `toEqual` 完全一致
  （`tests/harness/determinism.test.ts`、`tests/combat/movement.test.ts` AC-06）。
- ✅ **渲染层可随时替换**：只要消费 Snapshot，换成任何渲染技术都不触碰 `src/`。
- ✅ **平衡性可自动对局**：Headless 内核可以脱离实时帧率，以最大速度跑数十万局。
- ✅ **AI 协作友好**：任务可被精确描述为"让这组断言变绿"，无需人眼看画面。

### 5.2 负面 / 成本
- ⚠️ **需要自己造轮子**：没有引擎的渲染、物理、资产管线，全要自建（M2+ 的既定成本）。
- ⚠️ **渲染需插值**：Fixed-Tick 下渲染帧与逻辑帧不对齐，必须做状态插值，否则画面抖动。
- ⚠️ **前期投入前置**：M0 必须先搭 Harness 与契约，才能写第一行业务逻辑——短期"看不到画面"。
- ⚠️ **约束靠纪律维持**：`src/` 的纯逻辑红线若无人守，会慢慢被侵蚀 → 因此**用 CI 强制**（见 §6）。

### 5.3 中性
- 组件采用**类式**（`class X extends ComponentBase`）而非纯数据 SoA。
  理由：M1 规模下可读性优先；若 M3 性能剖析显示缓存不友好，再评估迁移（已登记为候选 ADR）。

---

## 6. 合规与验证（Compliance & Verification）

本 ADR 的每条规则都必须有**机器可执行的判据**，否则只是口号：

| 规则 | 强制手段 | 位置 |
|---|---|---|
| R1 无 DOM / 图形库 | CI 静态门：`grep` 命中即 fail | `.github/workflows/ci.yml` |
| R2 无墙钟 | 同上静态门（含 `Date.now` / `performance.now` / `requestAnimationFrame`） | `.github/workflows/ci.yml` |
| R3 步长来自时钟 | `tsconfig` 的 `lib` **不含 DOM**；AC-05 断言 `fps=30` 与 `fps=60` 位移一致 | `tests/combat/movement.test.ts` |
| R4 只读状态 | Snapshot 不可变性 + 零引用共享断言 | `tests/harness/snapshot.test.ts`、`tests/harness/independent-verify.test.ts` |
| R5 顺序确定 | 系统执行顺序 + 实体遍历顺序断言 | `tests/harness/independent-verify.test.ts` |
| R6 无环境依赖比较 | CI 静态门（ESLint AST）：`localeCompare` / `toLocale*` 方法调用 / `Intl` 构造在 `src/` 内命中即 fail；另有码元序回归断言 | `eslint.config.mjs`、`tests/harness/ecs.test.ts` |
| 全局确定性 | 同输入两遍 Snapshot 深度相等 | `tests/harness/determinism.test.ts` |

### 6.1 测试套件构成（当前基线）
| 文件 | 用例 | 归属 | 覆盖 |
|---|---|---|---|
| `tests/harness/clock.test.ts` | 6 | M0 实现 | 时钟精度、Tick 换算 |
| `tests/harness/input-timing.test.ts` | 6 | M0 实现 | 输入 Tick 对齐、FIFO、边界 |
| `tests/harness/snapshot.test.ts` | 4 | M0 实现 | 快照不可变 |
| `tests/harness/determinism.test.ts` | 2 | M0 实现 | 确定性回放 |
| `tests/harness/ecs.test.ts` | 5 | M0 实现 | ECS 基础行为 |
| `tests/harness/independent-verify.test.ts` | 19 | **QA 独立验证** | 对抗性攻击面（精度/篡改/时序/非法输入/顺序/回放） |
| `tests/combat/movement.test.ts` | 12 | M1 实现 | AC-01…AC-06 |
| **合计** | **54** | | |

> **QA 独立套件已纳入常规门控**：`vitest.config.ts` 的 `include: ['tests/**/*.test.ts']` 天然覆盖
> `independent-verify.test.ts`，且 CI 执行 `npm run test` 即包含它——因此**每次提交都会跑独立验证**，
> 不存在"独立套件只在评审时手动跑"的漏洞。该套件由 QA（严守真）以**自写断言 + 自带 fixture** 编写，
> 不复用实现方的测试夹具，属于结构性独立。

---

## 7. 相关链接
- `specs/00_harness_spec.md` — 时钟 / 输入 / ECS / Snapshot 契约（本 ADR 的落地规范）
- `specs/01_character_controller_spec.md` — 首个业务 Spec（移动控制）
- `production/qa/M0-T01-qa-report.md` — M0 质量门报告（判定 PASS）
- `.github/workflows/ci.yml` — R1/R2 的强制门

---

## 8. 后续候选 ADR（已识别，未决）
| 候选 | 触发条件 |
|---|---|
| ADR-002 · 渲染层插值与帧同步策略 | M2 接入首个渲染层时 |
| ADR-003 · ECS 存储布局：类式组件 vs 纯数据 SoA | M3 性能剖析显示 GC / 缓存压力时 |
| ADR-004 · 随机数体系：种子派生与可回放 RNG | 首个程序化生成系统（房间/祝福）落地时 |
| ADR-005 · 系统执行顺序的显式声明（拓扑排序 vs 注册顺序） | 系统数超过 ~10 个、隐式顺序开始出错时 |
