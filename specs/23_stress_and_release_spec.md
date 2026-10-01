# 23 · Stress & Release Spec（极限压测、无损性能优化与 1.0 收官）

| Field | Value |
|---|---|
| Spec ID | `SPEC-23-STRESS-RELEASE` |
| Milestone | **M15 · 极限压测与 1.0 收官**（T01） |
| Status | `accepted`（本文件为 M15-T01 验收基线） |
| Owner | engineering-lead（程基岩）· QA：quality-lead（严守真） |
| Applies to | `assets/data/rooms.json`（新增 `stress_room`）、`assets/data/encounters.json`（新增 `depth: 2`）、`assets/data/enemies.json`（新增 `gunner`）、`client/main.ts`（`?mode=stress` 后门 / run 边界补 `renderer.reset()`）、`client/GameRenderer.ts`（新增 `retiredCount` 观测）、`src/ecs/World.ts`（`query` 无损提速）、`src/ecs/systems/MovementSystem.ts`（`separateBodies` 无损提速）、`src/ecs/systems/CollisionSystem.ts`（目标侧预计算）、`tests/performance/stress.test.ts`（**新**，5 例）、`tests/performance/render_leak.test.ts`（**新**，3 例）、`package.json`（`1.0.0`）、`README.md`（**新**） |
| Depends on | `specs/00_harness_spec.md`（确定性 / `World.query` 升序契约）、`specs/19_room_topology_and_tilemaps_spec.md`（`LevelLoader.enterRoom` / 落点池 / R4 环绕降级）、`specs/20_engine_optimization_and_camera_spec.md`（`separateBodies` 语义 / I5–I10）、`specs/03_combat_hitbox_spec.md`（`CollisionSystem` 结算顺序）、`specs/08_encounter_and_death_spec.md` §4.4（死亡是状态不是删除）、`specs/09_renderer_bridge_spec.md`（渲染器缓存 / `reset`）、`specs/14_aoe_and_run_lifecycle_spec.md` I8（`EntityId` 永不复用）、`docs/architecture/ADR-001-headless-ecs-foundation.md`、`docs/architecture/ADR-004-deterministic-prng.md` |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境，`pool:'threads'`）· ESLint 9（flat config）· PixiJS 8.21 · howler 2.2 · Vite 5 |

---

## 1. 目的与范围

### 1.1 目的

M0–M14 把玩法、表现与数据管线全部打通，但**从未回答「它能扛多少人」**。M15-T01 是 1.0 收官前的最后一关，做四件事：

1. **构造一个数据驱动的极限场景**（AC-01 / AC-02）：一个 30×30 的超大房间 + 单波 150 敌（100 `grunt` + 50 `gunner` 远程精英），并且——这是关键——**场景本身是数据，不是测试里的字面量**。客户端用一个 URL 后门（`?mode=stress`）直接进入它。
2. **无头吞吐剖析 + 无损优化**（AC-03 / AC-05）：在 Node 下量 600 Tick 的纯逻辑耗时，**定位并消除 O(N²)**，且**逐位无损**——用快照摘要证明优化前后状态完全一致。
3. **内存泄漏防御**（AC-04）：表现层连跑 5 次 `restartRun()` 后不留 PixiJS 节点、不留 ticker 回调、不留 `retired` id；逻辑层连跑 10 个房间后墙体 / 掉落物被回收、实体数不无限膨胀。
4. **1.0 发布**（AC-06）：版本号 `1.0.0` + 根目录 `README.md`。

### 1.2 In Scope（做什么）

- **压测数据**：`rooms.json` 新增 `stress_room`（30×30，116 面墙合并为 4 个 AABB，1 个玩家点，36 个刷怪点）；`encounters.json` 新增 `depth: 2` 单波 150 敌；`enemies.json` 新增 `gunner`（远程精英：`attackRadius` 12 的 AoE 掷弹手）。
- **客户端后门**：`?mode=stress` ⇒ `runSetup` 换成 `buildStressRun`，单房间 run，直接进 `stress_room`，跳过房间推进循环。
- **无损提速**（`src/` 内部实现，契约不变）：
  - `World.query`：把 `stores.get(ctor)` 提到实体循环外；去掉对**已升序**结果数组的冗余 `sort`。
  - `MovementSystem.separateBodies`：把每对的 6 次 `getComponent` 降为 0（槽位表预解析；位置**仍就地改写组件**，故无写回步骤、无漂移可能）。
  - `CollisionSystem`：把目标侧的 4 次 `getComponent` + `isDead` 预计算成每 Tick 一次。
- **测试**：`tests/performance/stress.test.ts`（吞吐 / 次二次缩放 / 逻辑层回收）、`tests/performance/render_leak.test.ts`（渲染层泄漏）。
- **发布**：`package.json` → `1.0.0`；根目录 `README.md`。

### 1.3 Out of Scope（显式排除）

- ❌ **不达标也如实记录**：M15 原文要求「600 Tick < 100ms」。**该目标未达成**（实测 ~430ms，见 §7 T1），本规格把**实测值**写进基线而不是把阈值调成能过。理由与量化见 §7。
- ❌ **不改任何契约**：管道恒 **17 段**、顺序不变；`World.query` 仍返回**新建的、按 id 升序的**数组；`World.getComponent` / `hasComponent` / `snapshot` 语义逐字不变；组件仍是 POD、系统仍无跨 Tick 隐藏状态。
- ❌ **不重写 `World` 存储**：把 `Map<EntityId, Component>` 换成按 id 索引的稀疏数组确实能把 `getComponent` 砍半，但它让**内存与「历史最大 id」成正比**——与 AC-04 的内存目标直接冲突（id 永不复用），故明确拒绝。
- ❌ **不引入空间网格**：`separateBodies` 的剩余成本是纯双循环迭代（数组化后 ~10ns/对）。在 n≈150、30×30 房间下，网格的 9 次邻域查找比双循环更贵；且网格要求「位置在本 pass 内不变」，而本 pass 是**就地松弛**（位置逐对更新），要保逐位等价需增量重建网格，复杂度远超收益。数组化已把该瓶颈的**主导项**（6 次查表/对）清零。
- ❌ **不做 Web Worker / 多线程**：纯逻辑仍在主线程，单 Tick 预算见 §7。
- ❌ **不改任何既有测试断言**：634 例逐字不动。

---

## 2. 术语与不变量

| 术语 | 定义 |
|---|---|
| **压测房间（stress room）** | `rooms.json` 里 30×30 的 `stress_room`：116 面墙合并为 4 个矩形，1 个 `2` 玩家点，36 个 `3` 刷怪点 |
| **压测波次（stress wave）** | `encounters.json` 的 `depth: 2`：单波 100 `grunt` + 50 `gunner` |
| **远程精英（gunner）** | 有 `armor` + `ai(attackRadius=12)` + `hazard` 的敌人：站在 12 单位外朝玩家掷延迟 AoE，即本引擎「会射击」的形态 |
| **吞吐预算（throughput budget）** | 600 Tick 纯逻辑墙钟上限，见 §5 |
| **次二次缩放（sub-quadratic scaling）** | `time(150 敌) / time(50 敌) < 4`（线性≈3，二次≈9） |
| **无损（lossless）** | 优化前后，同一 seed 跑同一脚本得到的**快照摘要逐位相同** |
| **快照摘要（digest）** | 遍历 `listEntities()` × `listComponents()`，把 `id:组件名:字段=值` 拼串后过 FNV-1a 得到的 32 位哈希 |

### 2.1 不变量（I1 – I12）

- **I1** 管道恒 **17 段**，顺序不变；`TransformSnapshotSystem` 恒 idx0，`LifespanSystem` 恒 LAST。
- **I2** `World.query(...ctors)` 返回**新建**数组，元素按 **id 升序**；空 `ctors` 返回 `[]`。
- **I3** 优化后的 `World.query` **不调用 `sort`**：`alive` 是 `Set`，`createEntity` 是唯一写入者且 id 单调递增，`destroyEntity` 只删不改序，`clearEntities` 不重置计数器 ⇒ 迭代序**已升序**。契约（升序）不变，由 `tests/harness/ecs.test.ts` 钉住。
- **I4** `separateBodies` 的**逐对比对顺序、同阵营门控、严格 `<` 重叠判定、对称半重叠修正量**逐字不变；每对的 6 次组件读取被**预解析为槽位**（`SeparationBody`），但位置**仍就地改写 `TransformComponent`**——没有「先算后写回」的两份状态，因此不可能漂移。
- **I5** `separateBodies` 的 `factions` 必须是**字符串数组**，**不得**用 `Int32Array`：`Faction` 是字符串枚举，数值化会把 `'Player'` / `'Enemy'` 都变成 `0`，令玩家与敌人互相分离。
- **I6** `CollisionSystem` 预计算的 `targetDead` 在**本 pass 内**不变（本系统不写死亡标签，`DeathSystem` 在管道更后段）；`HealthComponent` 只缓存**引用**，`hp` 仍**实时读**（同 Tick 结算门控）。
- **I7** `stress_room` 的 `roomId` 必须能在**同一次 `loadAll`** 里解析到（跨表校验）。
- **I8** 150 敌的落点池只有 36 个 `3` 格 ⇒ **环绕共享**（spec 19 R4），首 Tick 存在重叠，这正是分离相位要做真实工作的原因。
- **I9** 压测玩家必须**活着**跑完 600 Tick：玩家死亡会触发 `isRunOver`，令 `EncounterSystem` / `PickupSystem` 惰性化，场景静默退化成非压测。
- **I10** `GameRenderer.reset()` 后场景图恒为 `stage -> camera -> root -> fxLayer`（3 个 `Container`），`Graphics` / `Text` 计数为 **0**，`retired` 为空。
- **I11** `retired` 是渲染器**唯一无界**结构（id 永不复用 ⇒ 只增不减）；run 边界**必须**调 `reset()` 释放它。
- **I12** 房间切换只回收 `WallComponent` / `HitboxComponent` / `HazardComponent` / `PickupComponent`；**尸体永不销毁**（spec 08 §4.4），是唯一合法增长。

---

## 3. 数据结构

### 3.1 `assets/data/rooms.json` · `stress_room`

30×30 网格：外圈 `1`（116 格，贪心合并为 4 个矩形），`(15,15)` 为 `2`，列/行 ∈ {4,8,12,16,20,24} 的 36 个交点为 `3`。

### 3.2 `assets/data/encounters.json` · `depth: 2`

```json
{ "depth": 2, "roomId": "stress_room",
  "waves": [ { "delayTicks": 0, "enemies": [ "grunt" x100, "gunner" x50 ] } ] }
```

### 3.3 `assets/data/enemies.json` · `gunner`

```json
"gunner": { "maxHp": 60, "maxSpeed": 5, "hurtboxRadius": 0.5, "armor": 40,
  "ai":     { "sightRadius": 20, "attackRadius": 12, "windupTicks": 30, "cooldownTicks": 90 },
  "hazard": { "radius": 2.5, "damage": 20, "delayTicks": 30 },
  "loot":   [ { "kind": "gold", "amount": 8 }, { "kind": "darkness", "amount": 12 } ] }
```

`attackRadius = 12` 是「会射击」的全部机制：AI 在 12 单位处停下起手，`wantsToHazard` 脉冲由 `HazardSystem` 在**玩家脚下**落地。**不新增任何 AI 能力**（`wantsToCast` 仍只由玩家硬件驱动），因为那属于改核心逻辑。

### 3.4 `client/main.ts` · 后门

```ts
const STRESS_DEPTH = 2; const STRESS_ROOM_ID = 'stress_room';
function isStressMode(): boolean;          // ?mode=stress
function buildStressRun(world, saveState): void;
// start(): const runSetup = isStressMode() ? buildStressRun : buildRun;
```

### 3.5 观测缝

`GameRenderer.retiredCount`（新增 getter）：暴露 `retired` 的**大小**而非集合本身，让 AC-04 能断言它，同时不给调用方改写它的能力。

---

## 4. 语义（AC）

### 4.1 AC-01 / AC-02 —— 数据驱动的极限场景 + 客户端后门

- 房间、波次、远程精英**全部**来自 `assets/data/*.json`；测试与客户端都**只引用 id 与 depth**，不重述任何数值。
- `?mode=stress` 把 `runSetup` 换成 `buildStressRun`：单房间 run ⇒ 清空即结束（spec 15 AC-04），**不进入房间推进循环**。
- 除 `runSetup` 外，其余接线（管道、存档、事件桥、渲染器、UI）**全是生产接线**——这才是这个房间算「真压测」的原因。

### 4.2 AC-03 —— 无头吞吐剖析

- 场景：150 敌 + 玩家（`maxHp = 1e9`，保证活满 600 Tick）+ 30×30 房间 + 4 面合并墙，共 ~174 实体。
- 过程：`step(1)` 让首波生成，再计 `step(600)` 的墙钟。
- 断言：`elapsed < THROUGHPUT_BUDGET_MS`，且**结束时仍是 150 活敌**（防「场景静默失效」）。
- 缩放守卫：`time(300) / time(50) < 9`（6x 兵力：线性≈6、二次≈36）。

### 4.3 AC-04 —— 内存泄漏防御

**表现层**（`tests/performance/render_leak.test.ts`）：
1. 5 × (`restartRun` + `step(1)` + `syncWorld` + 掉血 + `syncWorld` + `reset`)：每轮**先证有**（`viewCount > 0`、`wallViewCount > 0`、`Graphics > 0`、`Text > 0`），再证 `reset()` 后 `Graphics = Text = 0`、`viewCount = wallViewCount = sparkCount = retiredCount = 0`、场景图恰 3 节点。
2. 不调 `reset()` 连跑 5 轮并让死亡 FX 播完 ⇒ `retiredCount > 0`（**证明泄漏真实存在**）；`reset()` 后归零（**证明修复有效**）。
3. 5 × `start()` / `stop()` ⇒ ticker 回调集合恒 0/1 交替，最终为 0。

**逻辑层**（`tests/performance/stress.test.ts` G3）：
1. 10 次房间切换，每次先播下 hazard / pickup / projectile：断言旧墙**按 id** 全灭、新墙数 == 该房间 `wallCount`、瞬态组件计数全 0、`entityCount == 2 + wallCount`（**完全持平**）。
2. 10 次切换，每次先杀 3 个敌人：断言尸体存活、瞬态归零、`ΔentityCount == 3 + ΔwallCount`（增长被**完全解释**）。

### 4.4 AC-05 —— 无损优化

三处改动全部**只改 `src/` 内部实现**，契约不动。**判据**：对同一 seed 跑同一 601-Tick 脚本，`listEntities()` × `listComponents()` 的 FNV-1a 摘要与优化前**逐位相同**（基线 `2309042484`，174 实体）。

### 4.5 AC-06 —— 1.0 发布

`package.json.version = "1.0.0"`；根目录 `README.md` 概述架构（Headless ECS / PixiJS / SDD / Determinism）。

---

## 5. 验收标准

| # | 判据 |
|---|---|
| AC-01 | `stress_room` / `depth 2` / `gunner` 均在数据表中；`loadAll` 跨表校验通过 |
| AC-02 | `?mode=stress` 时 `runSetup === buildStressRun`；单房间 run；`typecheck:client` + `vite build` 通过 |
| AC-03 | 600 Tick < `THROUGHPUT_BUDGET_MS = 2000`（实测 ~460ms 单跑 / ~860ms 全量并发）；结束仍 150 活敌；**300/50 缩放比 < 9（实测 ~5.1；仅回退分离相位时为 ~19）** |
| AC-04 | 渲染层 3 例 + 逻辑层 2 例全绿；`retired` 泄漏被显式证明并修复 |
| AC-05 | 摘要逐位相同；**634 例既有测试零改动全绿** |
| AC-06 | `version === '1.0.0'`；`README.md` 存在且含四要素 |
| 全局 | `npm test` 642 例全绿（634 + 8）；`npm run typecheck` / `typecheck:client` / `lint` 零告警；`npm run build` 成功 |

---

## 6. 测试契约

### 6.1 `tests/performance/stress.test.ts`（新增，5 例）

- G1-a 首波恰 150 敌，且全部落在房间 30×30 内（落点池 36 格 ⇒ 环绕共享）。
- G1-b 600 Tick 在预算内，结束仍 150 活敌（`console.log` 记录实测）。
- G2 300/50 缩放比 < 9（O(N²) 回归守卫；**仅回退分离相位时为 ~19**）。
- G3-a 10 次切换：实体数持平 + 墙体/掉落物按 id 回收。
- G3-b 10 次切换：增长被「尸体 + 墙数差」完全解释。

### 6.2 `tests/performance/render_leak.test.ts`（新增，3 例）

见 §4.3。全部走**真实** `GameRenderer` + **鸭子类型** `Application`（`{ stage: new Container(), ticker }`），无需 jsdom。

### 6.3 既有套件（**零改动**）

`tests/harness/ecs.test.ts`（`query` 升序契约）、`tests/physics/soft_collision*.test.ts`（分离相位语义）、`tests/render/*`（场景图冻结契约）、`tests/combat/*`（结算顺序）——全部逐字未改，全部通过。

### 6.4 变异实验（必做）

对 AC-05 的「无损」结论，做**反向验证**：临时把 `factions` 改回 `Int32Array`（I5 的陷阱），摘要**立刻**从 `2309042484` 变成 `2992069332`（实体数 174 → 198）——证明摘要对照**能**抓到行为漂移，而不是一个恒真的形式。备份还原后摘要复现。

---

## 7. 已知取舍（Known Trade-offs）

### T1 —— 「600 Tick < 100ms」**未达成**（实测 ~430ms）

这是本里程碑最重要的一条，如实记录：

| 阶段 | 600 Tick × 150 敌 | 300/50 缩放比 | 说明 |
|---|---|---|---|
| M15 前（三处皆未优化） | ~2160ms | — | 分离相位双循环内 6 次 `getComponent`/对 ⇒ ~34k 查表/Tick |
| **仅回退分离相位**（变异实验） | 1137ms | **18.98** | 证明缩放守卫**真的**能抓到 O(N²)，不是恒真断言 |
| 三处无损优化后（本文件单跑） | **~460ms** | **~5.1** | 快 ~5x；快照摘要逐位不变 |
| 三处无损优化后（全量 37 文件并发） | ~860ms | — | 线程池争抢 CPU，读数上浮 |
| **目标** | **100ms** | — | 差 **~4.6x** |

**为什么剩下的不是算法问题**：优化后每 Tick 仍有 ~26 次 `World.query`（每次遍历全部 `alive`）与 ~5.5k 次 `World.getComponent`（每次 2 次 `Map` 查找）。这是 17 段管道 × ~174 实体的**固定每实体开销**。要压到 100ms 必须重写 `World` 的组件存储（按 id 索引的数组 / 查询缓存）并改写每个系统的读取方式——那**改的是核心逻辑与测试契约**，正是本里程碑明令禁止的。

**为什么空间网格也被否决**：见 §1.3。槽位化已消掉该瓶颈的主导项（1187ms → ~65ms），剩余是纯迭代；n≈150 时网格的邻域查找反而更贵，且与就地松弛的逐位等价性冲突。

**实际可用性**：~1300-1400 逻辑 Tick/s（单跑）⇒ 60Hz 下约 **22x 实时余量**。对一款同屏 150 敌的动作肉鸽，这个余量是够用的；100ms（6000 Tick/s，100x 余量）是**未经验证的高目标**，本规格不假装达到。

### T2 —— 压测房间成为正式 run 的第 3 间

`encounters.json` 是**按 depth 索引的序列**，`spawnFromData` 读**全部** depth，所以新增 `depth: 2` 会让正常 run 变成 3 间房，第 3 间即 150 敌压测房。这是数据模型的直接后果，记录在案而非掩盖：`?mode=stress` 是它的**唯一正当入口**（单房间 run），正常 run 的第 3 间则是该模型下的既定形状。

### T3 —— `?mode=stress` 是 URL 后门而非构建开关

选 URL 参数是因为它必须在**评审者手上已有的产物**上可用（`vite dev` 或 `vite preview`），无需重新构建、无需环境变量。代价是它随生产包一起发布——对一个演示项目可接受，且它只换 `runSetup`，不降低任何确定性。

### T4 —— 分离相位仍是 O(N²)（常数项极小）

槽位化后 ~10ns/对；150 体 ~11k 对/Tick ⇒ ~65ms/600Tick。**没有**改成网格（见 T1）。若将来实体数上到 1000+，这里会重新成为主导项——届时**必须**用空间划分，且要先解决就地松弛的等价性。

---

## 8. 失败模式（Failure Modes）

| 症状 | 根因 | 处置 |
|---|---|---|
| 压测房间首波不是 150 敌 | 落点池 `placeRoster` 用 `depth` 展开 | 断言前先 `step(1)`；`depth` 由单房间 run 归零 |
| 600 Tick 中途玩家死亡 | 玩家 HP 太小 ⇒ `isRunOver` 令系统惰性 | 压测玩家 `maxHp = 1e9`（I9） |
| 摘要对照「通过」却行为已变 | 摘要脚本本身没覆盖到该状态 | 先做**变异实验**（§6.4）证明摘要**能**抓到漂移 |
| `retired` 无界增长 | run 边界没调 `reset()` | `onStartRun` 补 `renderer.reset()`（I11） |
| 分离相位同阵营判定失效 | 用数值 typed array 存字符串枚举 | 用 `Faction[]`（I5） |
| 房间切换后实体数膨胀 | 瞬态组件漏回收 / 误回收尸体 | 断言瞬态计数归零 + 增长**完全解释**（I12） |

---

## 9. 追溯表（Traceability）

| AC | 产物 | 测试 |
|---|---|---|
| AC-01 | `assets/data/{rooms,encounters,enemies}.json` | `stress.test.ts` G1-a |
| AC-02 | `client/main.ts` | `typecheck:client` + `vite build` |
| AC-03 | `src/ecs/World.ts` / `MovementSystem.ts` / `CollisionSystem.ts` | `stress.test.ts` G1-b / G2 |
| AC-04 | `client/GameRenderer.ts` / `client/main.ts` | `render_leak.test.ts` ×3 + `stress.test.ts` G3 ×2 |
| AC-05 | 同上三处 `src/` | 快照摘要对照 + §6.4 变异实验 |
| AC-06 | `package.json` / `README.md` | 人工核验 |

---

## 10. 参考

- `specs/00_harness_spec.md` §6（`World.query` 契约 / 确定性）
- `specs/20_engine_optimization_and_camera_spec.md` §3.3（`separateBodies` 语义与 I5–I10）
- `specs/19_room_topology_and_tilemaps_spec.md` §4.2 / R4（落点池与环绕降级）
- `specs/09_renderer_bridge_spec.md` §10 trade-off 4（渲染器缓存可丢弃）
- `docs/architecture/ADR-001-headless-ecs-foundation.md`（headless / 单向依赖 / 确定性）
- `docs/architecture/ADR-004-deterministic-prng.md`（单 PRNG 流）
