# ADR-004 · 采用 Seeded PRNG（Mulberry32）作为逻辑层唯一随机源

| 字段 | 值 |
|---|---|
| **ADR ID** | ADR-004 |
| **标题** | 确定性随机数：用 Seeded PRNG（Mulberry32）替换系统默认随机 |
| **状态** | ✅ **Accepted**（2026-09-29） |
| **决策者** | 游承峰（主理人）· 程基岩（技术负责人） |
| **相关 Spec** | `specs/11_roguelike_loop_spec.md`（本决策的落地规范）、`specs/00_harness_spec.md`（§4 输入 / §5 Snapshot / §6 ECS）、`docs/architecture/ADR-001-headless-ecs-foundation.md`（R1–R6 确定性铁律） |
| **影响面** | `src/core/Random.ts`（新）、`src/ecs/World.ts`（`rng` 字段 + `WorldOptions.seed`）、`src/core/GameSimulator.ts`（`GameSimulatorOptions.seed`）、`src/core/input.ts`（`SelectRewardEvent`）、`src/ecs/systems/EncounterSystem.ts`、`src/ecs/systems/RewardSystem.ts`（新） |
| **取代** | 无（补上 ADR-001 §8 中登记的候选 **ADR-004「确定性随机数」**） |

---

## 1. 背景与问题（Context）

ADR-001 R2 立下铁律：**`src/` 禁止墙钟与随机**，并由 `eslint.config.mjs` 的 `no-restricted-properties` 对 `Math.random` 做 AST 级强制。M0–M5 全程遵守了它——因为那六个里程碑**不需要**随机：移动、冲刺、命中、顿帧、DoT、敌方 FSM、房间波次，全部是确定性规则的纯函数。

M6 的肉鸽循环打破了这一点。一个 roguelike 的**核心**就是"每次不一样"：

- 房间通关要**掉落三选一**（本次抽到哪些词缀，直接影响后续 Build）；
- 下一关要**更强**（敌人数量/配置随深度增长）；
- 未来的关卡布局、商店、Boss 招式同样需要随机。

于是出现了一个看似矛盾的需求：**要随机，又要可回放。**

天真的做法是 `Math.random()`，但它会立刻摧毁三条既有保证：

1. **回放不可复现**：同一段输入脚本跑两次，抽到的词缀不同 → 后续状态分叉。
2. **测试不可断言**：`tests/combat/*` 全部依赖"逐 Tick 状态可精确预测"，一个不可控的随机数会让任何涉及掉落的断言变成 flaky。
3. **CI 不可复现**：本地绿、CI 红，且无法稳定复现。

> **核心问题**：如何让逻辑层获得"随机性"，同时让**同一段输入 + 同一个种子**在任何机器、任何时刻产生**逐位相同**的状态？

---

## 2. 决策驱动因素（Decision Drivers）

| # | 驱动因素 | 权重 |
|---|---|---|
| D1 | **确定性**：同种子 + 同抽取序列 ⇒ 逐位相同结果（跨机器、跨 Node 版本） | 最高 |
| D2 | **零环境污染**：不得引入 `Math.random` / 墙钟 / `Intl`；不得破坏 ADR-001 R1–R6 | 最高 |
| D3 | **种子是外部输入**：逻辑层不得自己"发明"种子（那等于偷偷读墙钟） | 最高 |
| D4 | **实现极小**：十几行、零依赖、无分配、可直接读懂 | 高 |
| D5 | **可测试**：给定种子可离线复算期望序列，测试不依赖"跑一遍看结果" | 高 |
| D6 | **质量够用**：通过基本均匀性/周期性检查即可，**不要求**密码学强度 | 中 |

---

## 3. 备选方案（Alternatives Considered）

### 方案 A：`Math.random()`
**否决。** 直接违反 ADR-001 R2，且它连"可复现"的边都摸不到——无法设种子、无法回放、无法断言。被 ESLint 门直接拦下。

### 方案 B：LCG（线性同余，`state = (a*state + c) mod 2^32`）
**否决（作为主算法）。** 代码同样短，但低比特位周期极短，`state % 2` 会高频交替（经典的"奇偶翻转"缺陷）。取模/除法也更容易引入浮点或大整数精度问题。作为"最简可用"是够的，但在本项目的抽样场景（`nextInt` 落在 `[0, len-1]`）上低比特质量直接暴露，得不偿失。

### 方案 C（**采纳**）：Mulberry32
32 位单字状态，周期 2³²，全部用 `Math.imul` + XOR + 移位实现（**纯整数运算，无浮点中间态**），单次抽取三次 `Math.imul` 加若干位运算，无分配。质量远超 LCG，代码量与 LCG 同级（约 5 行核心）。

```ts
state = (state + 0x6d2b79f5) >>> 0;
let t = state;
t = Math.imul(t ^ (t >>> 15), t | 1);
t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
return (t ^ (t >>> 14)) >>> 0;
```

### 方案 D：xorshift128 / PCG / Mersenne Twister
**否决（本阶段）。** 质量更好（更长周期、更好的统计性质），但：xorshift 需要 128 位状态（4 个字，跨 Tick 状态更大、序列化更麻烦）；PCG 需要 64 位乘法（JS 需 `BigInt` 或手工拆分，**破坏"纯 32 位整数、跨机器逐位一致"**）；MT19937 需要 624 字状态与一次初始化循环，对"一局游戏抽几十次"的用量是巨大浪费。**当用量和风险都低时，选最简且质量足够者**——如果未来做地图生成等大规模采样，再升级到 PCG32（本 ADR 预留该升级路径）。

---

## 4. 决策（Decision）

### 4.1 算法
采用 **Mulberry32**，封装为 `src/core/Random.ts` 的 `Random` 类，公开：
`nextUint32()` / `nextFloat()` / `nextInt(min, max)` / `pick(items)` / `sample(items, count)`。

- `nextUint32()` 是**唯一**的原始抽取，其余全部由它派生 ⇒ 只要它的序列确定，整个生成器的行为就完全确定。
- `nextFloat()` 返回 `[0, 1)`（**右开**）⇒ `Math.floor(nextFloat() * n) ∈ [0, n-1]`，天然不会越界。
- `nextInt(min, max)` **双端闭**（含 `max`）——"2 到 5 之间的整数"的自然读法；右开是"永远抽不到最后一个选项"的静默 off-by-one。
- `sample(items, count)` 用**部分 Fisher-Yates**（在私有副本上洗牌，不改调用方数组）保证 **count 个互不重复**——这正是"三选一不能出现三个相同词缀"所需要的**无放回抽样**。

### 4.2 挂载位置：`World.rng`（唯一实例）
`World` 持有一个 `public readonly rng: Random`。

- **为什么不放 `SystemContext`**：`SystemContext` 是**冻结的** harness 契约（spec 00 §6.1 / spec 05 C6），`ModifierContext extends SystemContext` 也依赖它逐字不变。往里塞字段会破坏既有扩展点，代价远超收益。
- **为什么不按系统各自注入**：随机性必须是**一条**流。两个各持一份同种子生成器的系统会抽出**相同**的数列——这不是隔离，而是**同一个 bug 发生两次**。集中到一个实例，谁先抽谁后抽由管道顺序唯一决定。
- **为什么不放模块级单例**：模块级单例会让两个 `GameSimulator` 共享状态，回放互相污染（与 `EventQueue` / `ModifierRegistry` 的"每次 `createDefaultSystems()` 新建"是同一条理由，spec 05 §5.3）。

> 说明：ADR-001 曾明确"引擎服务由构造函数注入、不挂 `World`"（`EventQueue` 即如此）。此处**刻意偏离**，因为两者性质不同：`EventQueue` 是**游戏概念**（命中事件），挂上去会污染通用 ECS 层；而**确定性 PRNG 是引擎级原语**（与 `nextId` 同级），它不属于任何游戏玩法，且必须被多个跨层系统共享。偏离已被记录为取舍（§5.2）。

### 4.3 种子来源：外部输入，逻辑层只读
- `World` 构造函数接受 `WorldOptions.seed`（默认 `DEFAULT_RANDOM_SEED = 0x12345678`）。
- `GameSimulator` 透传 `GameSimulatorOptions.seed`。
- **逻辑层永不重播种、永不生成种子**。真实一局由调用方传入（例如 UI 用一次外部熵算出种子），这样"随机"发生在**边界之外**，`src/` 依旧零墙钟（ADR-001 R2）。

固定默认种子是**确定性要求**而非便利：`new GameSimulator()` 在任何机器、任何测试里都必须行为一致。

### 4.4 奖励三选一走 PRNG（本决策的第一个消费者）
`EncounterSystem` 在房间转入 `ROOM_CLEARED` 时调用 `world.rng` 从全局奖池**无放回**抽 3 个，写入 `EncounterStateComponent.pendingRewards`。详见 `specs/11_roguelike_loop_spec.md`。

---

## 5. 后果（Consequences）

### 5.1 正面
- **回放逐位可复现**：同种子 ⇒ 同掉落 ⇒ 同后续状态。`tests/combat/roguelike_loop.test.ts` 直接断言"两次抽取严格一致"。
- **随机性可被测试**：种子上线后，掉落从"不可断言"变成"可离线复算的纯函数"。
- **零依赖、零分配、十几行**：不增加运行时依赖，不引入 GC 抖动。
- **一条流，顺序即语义**：抽取顺序由管道顺序唯一决定，不存在"谁先谁后"的歧义。
- **升级路径清晰**：若未来采样量暴增或统计质量不足，只需替换 `nextUint32()` 的内部实现（换成 PCG32），公开 API 与所有调用点不动。

### 5.2 负面 / 成本
- **`World` 多了一个非 ECS 字段**：通用 ECS 层因此持有"确定性原语"。这是刻意的架构取舍（§4.2 已记录理由），代价是 `World` 不再"纯 entity/component 注册表"。
- **PRNG 状态不进 Snapshot**：`snapshot()` 不含生成器状态。若某次抽取**没有被消费**，回放比较无法直接看出"随机数被多抽了一次"（详见 §5.3 与 §6 的缓解）。
- **质量上限明确**：Mulberry32 不是密码学安全的，也过不了严格的统计测试套件。本项目只需"不可预测到影响手感"，不需要抗攻击。

### 5.3 中性
- `nextInt` 采用 `floor(float * span)` 而非取模，避免取模偏差，但对极大区间（> 2²⁴）会有浮点精度损失——本项目的区间都是个位数到几十，无影响。
- 固定默认种子意味着"开箱即用的 demo 每局相同"。这是特性不是缺陷：要每局不同，传一个不同的 `seed`。

---

## 6. 合规与验证（Compliance & Verification）

| 铁律 | 强制手段 |
|---|---|
| 逻辑层不得用 `Math.random` | `eslint.config.mjs` 对 `src/**/*.ts` 的 `no-restricted-properties`（AST 级，已存在） |
| 逻辑层不得读墙钟 | 同上（`Date.now` / `new Date()`）；PRNG 只消费外部传入的 seed |
| 同种子 ⇒ 逐位一致 | `tests/combat/roguelike_loop.test.ts` 的 PRNG 确定性用例（同 seed 两跑 `toEqual`；`Random` 原始序列两次 `toEqual`） |
| 抽取顺序确定 | 只有 `EncounterSystem` 一个消费者，且在管道中位置唯一（`DeathSystem → EncounterSystem → RewardSystem → LifespanSystem`） |
| 无放回 | `Random.sample` 的 Fisher-Yates + `roguelike_loop.test.ts` 断言三选项互不相同 |
| 未引入新依赖 | `package.json` 的 `dependencies` 不变（仅 `pixi.js`，且只在 `client/`） |

**关于"PRNG 状态不进 Snapshot"的缓解**：任何抽取顺序的分歧，都会立刻表现为**它所产生的状态**的分歧（抽到不同词缀 ⇒ 玩家 `ModifierComponent` / `HealthComponent` 不同 ⇒ Snapshot 不同）。因此快照比较**仍然**是有效的回放守卫，只是守卫的是"随机性的结果"而非"随机性的内部游标"。这是有意的取舍：把生成器状态塞进每帧快照，只会让快照膨胀到一个没有任何断言应该去读的值。

---

## 7. 相关链接
- `specs/11_roguelike_loop_spec.md` — 本决策的落地规范（掉落三选一 / 暂停 / UI 隔离 / 结算转场）
- `specs/00_harness_spec.md` §4（输入契约）/ §5（Snapshot）/ §6（ECS）
- `docs/architecture/ADR-001-headless-ecs-foundation.md` — R1–R6 确定性铁律
- `src/core/Random.ts` — 实现
- `src/ecs/World.ts` / `src/core/GameSimulator.ts` — 装配点

## 8. 后续候选 ADR（已识别，未决）
- **ADR-005 · 种子分发策略**：真实一局如何取得种子（UI 熵 / 时间 / 手动输入），以及种子如何随存档一起持久化以支持"续玩同一局"。
- **ADR-006 · 关卡/地图生成**：若引入程序化房间布局，评估是否需要把 Mulberry32 升级为 PCG32（更长的周期与更好的多维分布）。
