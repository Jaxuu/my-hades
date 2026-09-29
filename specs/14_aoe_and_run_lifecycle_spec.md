# 14 · AoE Hazards & Run Lifecycle Spec（延迟范围伤害与游戏重置循环）

| Field | Value |
|---|---|
| Spec ID | `SPEC-14-AOE-RUN-LIFECYCLE` |
| Milestone | **M8 · 收束与循环**（T01） |
| Status | `accepted`（本文件为 M8-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/HazardComponent.ts`（新）、`src/ecs/components/GameStateComponent.ts`（新）、`src/ecs/components/IntentComponent.ts`（`wantsToHazard`）、`src/ecs/components/index.ts`、`src/ecs/systems/HazardSystem.ts`（新）、`src/ecs/systems/index.ts`、`src/ecs/systems/pipeline.ts`（**第 16 段**）、`src/ecs/systems/AISystem.ts`（抬升 hazard 脉冲）、`src/ecs/systems/FreezeSystem.ts`（冻结清意图）、`src/ecs/systems/DeathSystem.ts`（中和意图 + RUN_FAILED）、`src/ecs/systems/PlayerControllerSystem.ts`（RUN_FAILED 压制）、`src/ecs/systems/EncounterSystem.ts`（RUN_FAILED 惰性）、`src/ecs/prefabs/spawn-helpers.ts`（`hazard` opt-in）、`src/ecs/prefabs/GameStateFactory.ts`（新）、`src/ecs/prefabs/index.ts`、`src/ecs/World.ts`（`clearEntities` / `reseed`）、`src/ecs/System.ts`（可选 `reset?`）、`src/core/Random.ts`（`reseed`）、`src/core/clock.ts`（`reset`）、`src/core/scheduler.ts`（`reset`）、`src/core/GameSimulator.ts`（`restartRun` / `runSetup`）、`client/GameRenderer.ts`（Hazard 预警）、`client/UIManager.ts`（死亡覆盖层 + R 键）、`client/main.ts`、`index.html`、`tests/combat/aoe_and_lifecycle.test.ts`（新） |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/03_combat_hitbox_spec.md`（判定圆 / `activeTicks` / `hitEntities` 护栏）、`specs/04_combat_feedback_spec.md`（顿帧 / 硬直 / 击退相位）、`specs/07_enemy_ai_spec.md`（意图脉冲先消费后门控 / AI 只输出意图）、`specs/08_encounter_and_death_spec.md`（`DeadTagComponent` 是死亡唯一权威 / 房间调度）、`specs/11_roguelike_loop_spec.md`（肉鸽循环 / 种子契约）、`specs/13_arena_and_projectiles_spec.md`（投射物 `hitstopTicks = 0` 的先例） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

到 M7-T01 为止，引擎里所有伤害都是**「谁挥的、谁挨的」**：判定圆要么贴身在攻击者身前生成（近战），要么沿直线飞行（投射物）。两者都缺同一件事——**伤害与「时间」的耦合**。动作肉鸽里最具辨识度的一类威胁恰恰是「地面先亮起来、过一会儿才炸」：它把「反应」拆成「读预警 → 走位 → 结算」三段，是唯一一种**不依赖敌人站位**的压力来源。

同时，整个引擎到 M7 为止都**没有「一局」这个概念**：玩家死亡和小怪死亡走的是同一条路径（挂 `DeadTagComponent`，世界继续跑）。世界没有任何「重启」入口——`World` 只会单调地长出实体，`World.nextId` 只增不减。

M8-T01 补上这两层：

1. **延迟范围伤害（AoE Hazard）**：新增 `HazardComponent`。它在 `delayTicks` 期间是**没有碰撞判定的纯预警**（无 `HitboxComponent`），倒计时结束当拍在原地生成一个**存活 1 Tick 的巨型判定圆**并自我销毁。
2. **一局的生命周期（Run Lifecycle）**：新增 `GameStateComponent` 单例与 `GameStatus`。玩家死亡不再等同于小怪死亡——它把整局推入 `RUN_FAILED`，并让 `GameSimulator.restartRun(newSeed?)` 成为把世界彻底洗回初始状态的唯一入口。

> 一句话判据：**Hazard 把「伤害」从空间维度扩展到时间维度；`restartRun` 把「世界」从单调增长变成可循环。**

### 1.2 In Scope（做什么）

- **新组件**：`HazardComponent`（`radius` / `damage` / `delayTicks` / `totalDelayTicks` / `faction` / `ownerEntityId`）+ 自由函数 `spawnHazard`；`HazardCasterComponent`（`radius` / `damage` / `delayTicks`，敌人 opt-in 开关）；`GameStateComponent`（`status`）+ `GameStatus` 枚举 + 自由函数 `findGameState` / `isRunFailed`。
- **新系统**：`HazardSystem`（**管道第 16 段**，插在 `AISystem` 之后、`MovementSystem` 之前）——播种预警 + 倒计时 + 爆破。
- **组件扩展**：`IntentComponent.wantsToHazard`（第四个单 Tick 脉冲，遵循既有脉冲契约）。
- **意图生产**：`AISystem` 在**前摇结束当拍**为携带 `HazardCasterComponent` 的敌人额外抬升 `wantsToHazard`（与 `wantsToAttack` 同拍，近战与 AoE 并存）。
- **装配**：`CombatantSpawnOptions.hazard` opt-in（同 `ai` / `armor` 的形状）。
- **RUN_FAILED**：`DeathSystem` 在标记玩家死亡的同一次调用里把 `GameStateComponent.status` 置为 `RUN_FAILED`；`PlayerControllerSystem` 与 `EncounterSystem` 读取该状态并停止响应。
- **世界重置**：`World.clearEntities()` / `World.reseed(seed)`、`Random.reseed(seed)`、`FixedClock.reset()`、`System.reset?()` 可选钩子、`Scheduler.reset()`、`GameSimulator.restartRun(newSeed?)` + `GameSimulatorOptions.runSetup`。
- **表现层**：`GameRenderer` 绘制 Hazard 预警（红色实心圆 + 线圈，透明度随倒计时递增、半径随时间收拢）；`UIManager` 渲染 `YOU DIED` 覆盖层并捕获 `R` 键；`main.ts` 接入 `runSetup` / `restartRun`。

### 1.3 Out of Scope（显式排除）

- ❌ **多阶段 Hazard（连环炸 / 移动预警 / 追踪预警）**：本里程碑只有「静止 → 单次爆破」。
- ❌ **Hazard 的堆叠 / 刷新 / 免疫**：同位置可以有多个 Hazard，各自独立倒计时，互不影响。
- ❌ **Hazard 走护甲 / DoT / 状态效果**：爆破走的是**标准判定圆结算路径**（`CollisionSystem` → `applyDamageWithArmor`），因此护甲**生效**；但 Hazard 本身不施加状态效果、不生成 `HitEvent` 之外的任何事实。
- ❌ **暂停整个管道**：`RUN_FAILED` 不冻结 `step()`。它压制**玩家意图**与**房间调度**，让世界进入「惰性」而非「停止」——见 §4.4。
- ❌ **存档 / 序列化 / 中途续跑**：`restartRun` 只在进程内重置。
- ❌ **`restartRun` 重置 `World.nextId`**：**刻意不做**，见 §4.5 与 §11 R2。
- ❌ **玩家投掷 Hazard**：`wantsToHazard` 只由 `AISystem` 抬升；玩家没有对应按键（`PlayerControllerSystem` 恒写 `false`）。

---

## 2. 术语与不变量

| 术语 | 定义 |
|---|---|
| **预警（Telegraph / Hazard）** | 携带 `HazardComponent` + `TransformComponent` 的实体。**没有** `HitboxComponent`、**没有** `HurtboxComponent`、**没有** `FactionComponent` |
| **爆破（Blast）** | Hazard 倒计时归零当拍在**同一坐标**生成的判定圆实体（`HitboxComponent`），存活 **1 Tick** |
| **倒计时（`delayTicks`）** | Hazard 剩余预警 Tick 数。**只由 `HazardSystem` 递减**，不受顿帧影响 |
| **播种（Plant）** | `HazardSystem` 消费 `wantsToHazard` 脉冲、在目标脚下生成一个新 Hazard 的动作 |
| **一局（Run）** | 从 `restartRun`（或首次装配）到 `RUN_FAILED` 之间的完整世界生命周期 |
| **`RUN_FAILED`** | 全局单例 `GameStateComponent.status` 的终态之一：整局失败，等待 `restartRun` |

**不变量**

- **I1** —— 预警期间 Hazard **不可能**造成伤害：它没有 `HitboxComponent`，`CollisionSystem` 的目标集是 `(Transform, Hitbox)`，因此它在结构上无法参与命中结算。
- **I2** —— Hazard **不挂 `FactionComponent`**：阵营存在 `HazardComponent.faction` 里（爆破时透传给判定圆）。这样 `CollisionSystem` 的**目标查询**（要求 `FactionComponent`）不会把预警本身当成可被攻击的对象，也不会让它出现在 AI 的索敌集里。
- **I3** —— Hazard **不挂 `VelocityComponent`** ⇒ `MovementSystem.resolveWalls` 的目标集（`Transform + Velocity`）不含它 ⇒ 预警不会被墙体推走。爆破圆同样不挂 `VelocityComponent`。
- **I4** —— `HazardSystem` **不读** `isFrozen` / `isDead`（对 Hazard 实体而言）。预警是**环境的**倒计时：怪物被顿帧不阻止炸弹爆炸，被冻结的 Hazard 也照常爆。
- **I5** —— `HazardSystem` 对**施法者**（而非 Hazard）查死亡门，且门在**读取并清除脉冲之前**（与 `CombatActionSystem` 完全同构）。
- **I6** —— `GameStateComponent` 是**全局单例**：世界最多存在一个（`GameStateFactory.spawn` 是唯一装配点）。缺失时一律按 `PLAYING` 解释（opt-in 语义，与 `AIControllerComponent` / `ArmorComponent` / 房间单例一致）。
- **I7** —— `RUN_FAILED` 是**单调**的：`DeathSystem` 只写 `PLAYING → RUN_FAILED`，从不由任何系统写回。唯一的复位路径是 `restartRun`（它重建整个世界）。
- **I8** —— `restartRun` 之后 `World.nextId` **严格大于**重启前的最大值 ⇒ `EntityId` 永不复用（`GameRenderer.retired` 依赖此性质，spec 10 §4.5）。

---

## 3. 数据契约

### 3.1 `HazardComponent`（新）

| 字段 | 类型 | 语义 |
|---|---|---|
| `radius` | `number` | 爆破判定圆半径（世界单位）。**必须** `> 0` 且有限 |
| `damage` | `number` | 爆破伤害。**必须** `>= 0` 且有限（`0` 合法：纯位移陷阱） |
| `delayTicks` | `number` | **剩余**预警 Tick 数。只由 `HazardSystem` 递减 |
| `totalDelayTicks` | `number` | 初始预警长度（**只读**）。存在理由见下 |
| `faction` | `Faction` | 爆破判定圆的阵营（透传，用于 `areHostile` 判定） |
| `ownerEntityId` | `EntityId` | 施法者 id（**只作诊断/审计**；见 §4.3 为何爆破的 owner 不是它） |

`totalDelayTicks` 不是冗余：表现层需要**进度**（`1 - delayTicks / totalDelayTicks`）来驱动预警的透明度与半径。没有它，渲染层必须自己记住每个 Hazard 的初始值——那是**渲染层持有逻辑状态**，违反 spec 09 AC-01 的单向只读契约。把它放在组件上，快照即可完整重放预警的视觉进度。

### 3.2 `HazardCasterComponent`（新，opt-in）

| 字段 | 类型 | 语义 |
|---|---|---|
| `radius` | `number` | 该敌人投掷的 Hazard 的爆破半径 |
| `damage` | `number` | 爆破伤害 |
| `delayTicks` | `number` | 预警长度（**正整数**） |

携带它的敌人 = **「会埋雷的敌人」**。它是一个**能力开关**，形状与 `ArmorComponent` / `AIControllerComponent` 完全一致：`spawnCombatant` 只在 `options.hazard !== undefined` 时挂载它；不传 ⇒ 组件集逐字不变 ⇒ 所有 M1–M7 战斗单位行为逐位等价。

**没有独立冷却字段**：脉冲由 AI 的前摇结束抬升，而前摇受 `windupTicks + cooldownTicks + 1` 的周期约束（spec 07 §6.1）。再加一层冷却只会产生第二个必须与之同步的时钟。

### 3.3 `GameStateComponent`（新，全局单例）

```ts
export enum GameStatus {
  PLAYING = 'PLAYING',
  RUN_FAILED = 'RUN_FAILED',
}
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `status` | `GameStatus` | 整局状态。唯一写者：`DeathSystem`（→ `RUN_FAILED`）与 `GameStateFactory`（→ `PLAYING`） |

**只读侧唯一入口**：

- `findGameState(world)` ⇒ 返回持有 `GameStateComponent` 的实体上的组件（id 升序第一个），无则 `undefined`。
- `isRunFailed(world)` ⇒ `findGameState(world)?.status === GameStatus.RUN_FAILED`。

三个消费方（`DeathSystem` / `PlayerControllerSystem` / `EncounterSystem`）与表现层共用这两个自由函数，让「哪一个是本局的单例、什么算失败」这条规则只有一个家——与 `findRewardDraft` 同构。

### 3.4 `IntentComponent.wantsToHazard`（扩展）

第四个单 Tick 脉冲，与 `wantsToDash` / `wantsToAttack` / `wantsToCast` **逐条同契约**：

- 只由意图生产者抬升（本里程碑：`AISystem`；玩家恒 `false`）；
- 由消费者（`HazardSystem`）**读取并清除**，且清除发生在**任何门控之前** ⇒ 被拒绝的脉冲被**丢弃**，绝不缓冲；
- `FreezeSystem`（冻结期清空全部脉冲）与 `DeathSystem`（中和尸体意图）**一并清零它**——否则一个冻结/死亡实体手里会留着一颗待爆的雷。

---

## 4. 语义契约

### 4.1 AC-01 · Hazard 的逐 Tick 契约

**倒计时（`HazardSystem` 相位 B）**

```
if (hazard.delayTicks > 0) { hazard.delayTicks -= 1; continue; }
detonate(hazard);
```

**为什么是「先判后减」而不是「先减后判」**：`delayTicks = N` 必须读作 **「N 个 Tick 的预警」**。

- 「先判后减」：tick `T` 播种的 Hazard 在 tick `T` 被减一次（见 §4.2 相位顺序），tick `T+N-1` 减到 `0`，tick `T+N` 引爆 ⇒ **恰好 N 拍预警 + 第 N+1 拍爆破**。
- 「先减后判」：同一颗雷会在 `T+N-1` 引爆 ⇒ 只有 N-1 拍预警，`delayTicks` 比字面意思少一拍。

`N = 0` 是该规则的合法极限：**同拍立即引爆**（`T+0`）。没有「至少等一拍」的特例——算术直接读出「现在」。

**爆破（`detonate`）**

1. 在 Hazard **当前坐标**生成判定圆实体：`TransformComponent(x, y, 0)` + `HitboxComponent(radius, damage, 1, faction, hazardEntityId, hitstop=0, knockback>0)`。
2. 销毁 Hazard 实体本身。

**为什么 `activeTicks = 1` 就够了**（与 Zeus 落雷 / Poseidon 冲击波要求的 `2` 相反）：`HazardSystem` 排在 `CollisionSystem` **之前**，所以爆破圆在**生成当拍**就会被碰撞检测一次；`LifespanSystem`（恒 LAST）当拍末把它减到 `0` 并销毁。`1` ⇒ 恰好一次检测，正是 AC-01 的「存活 1 Tick」。

**为什么爆破圆的 `ownerEntityId` 是 Hazard 自己、而不是施法者**：`CollisionSystem` 的 **owner 门**会跳过「owner 已死」的判定圆（spec 08 §4.2）。若 owner 是那个敌人，那么「敌人前摇完成 → 埋雷 → 敌人在 30 拍预警期内被玩家打死」就会让这颗**已经埋好的雷彻底失效**——这恰好是 AoE 最需要成立的场景。把 owner 设为 Hazard 自身（爆破后立即被销毁 ⇒ `isDead` 对已销毁 id 返回 `false`）让 owner 门**结构上不可能**退役它。这与「判定圆独立于攻击者」的既有设计一脉相承（spec 03 §3.4）。

**为什么 `hitstopTicks = 0` + `knockbackForce > 0`**：与投射物同一条理由（spec 13 §3.3）——`CollisionSystem` 会**同时**冻结命中双方，而非零顿帧会去冻结施法者。`knockbackForce > 0` 保持反馈门打开，使受害者仍然进入 `HITSTUN` 并被真正推开（spec 04 AC-03）。

**为什么预警不吃顿帧**（I4）：`HazardSystem` 不查 `isFrozen`。顿帧是「打击感」的一部分，它暂停的是**动作**；预警是**环境**。让一个被顿帧的怪物顺带延长炸弹的引信，会把两个正交的时间轴错误地耦合在一起。

**预警与 `LifespanSystem` 无关**：Hazard 没有 `HitboxComponent`，`LifespanSystem` 的查询是 `query(HitboxComponent)` ⇒ 它永远不会被寿命系统提前回收。Hazard 的生命周期**只**由 `HazardSystem` 的两条路径决定：倒计时归零，或世界被清空。

### 4.2 AC-01 · `HazardSystem` 的两相位与相位顺序

`HazardSystem.update()` 依次执行：

1. **相位 A · 播种（`plantHazards`）** —— 遍历 `(IntentComponent, HazardCasterComponent, TransformComponent, FactionComponent)`：

   a. **死亡门**：`isDead` ⇒ `continue`（**在读取脉冲之前**，与 `CombatActionSystem` 同构 —— 尸体的手写脉冲既不被执行也不被缓冲）。

   b. **读取并清除** `intent.wantsToHazard`（无条件，先于任何其他门）。

   c. 解析落点：施法者的 **AI 锁定目标**（`AIControllerComponent.targetEntityId`，且目标仍存活且有 `TransformComponent`）的坐标；否则退化为施法者自身坐标。

   d. `spawnHazard(world, { x, y, radius, damage, delayTicks, faction, ownerEntityId: casterId })`。

2. **相位 B · 倒计时与爆破（`advanceHazards`）** —— 遍历 `(HazardComponent, TransformComponent)`，执行 §4.1 的倒计时/爆破。

**为什么 A 在 B 之前**：B 必须能看见 A 这一拍刚播种的 Hazard，否则「tick `T` 埋雷 ⇒ tick `T+N` 引爆」会漂成 `T+N+1`。A→B 让**播种当拍即计入第一拍预警**，与「直接 `spawnHazard` 后再 `step()`」的时序**完全一致**——这正是 AC-01 的时序断言能在两条路径上给出同一个答案的原因。

**落点为什么读 AI 的目标**：`AIControllerComponent.targetEntityId` 是引擎里**唯一**「一个敌人在瞄谁」的权威表示。让 `HazardSystem` 复用它可以避免在 `IntentComponent` 里再造一个位置字段（那会让意图层持有空间数据，与「意图是纯逻辑」的契约冲突）。没有 AI（或被脚本驱动的埋雷者）时退化为自身坐标，是一个明确、可测的兜底而不是意外。

### 4.3 AC-01 · 管道位置（**第 16 段**）

新管道（16 段）：

```
TransformSnapshot → PlayerController → Freeze → AI → Hazard → Movement → Dash → State
  → CombatAction → Collision → StatusEffect → Modifier → Death → Encounter → Reward → Lifespan
```

`HazardSystem` 位于 **index 4**（`AISystem` 之后、`MovementSystem` 之前）。三条槽位理由：

1. **必须在 `AISystem` 之后**：`wantsToHazard` 由 AI 在**本拍**抬升，消费者必须在同一拍看到它。
2. **必须在 `CollisionSystem` 之前**：爆破圆要在**生成当拍**就能命中——这是 `activeTicks = 1` 成立的前提（§4.1）。
3. **在 `MovementSystem` 之前是刻意的**：落点读的是目标**本拍移动前**的坐标。预警的幻想是「**你现在站的这块地**会炸」，所以落点取「施法决策时你所在之处」，随后这一拍的位移就是玩家的走位空间。若排在 `MovementSystem` 之后，落点会取到「本拍移动后」的坐标——同样可玩，但它把玩家的**走位**从「闪避」降级成「追击后仍被锁定」，与延迟 AoE 的设计意图相反。

**这是一次显式的管道契约变更。** 它打散 6 处 `toEqual` 名数组钉桩（`tests/combat/{feedback,boons,status_effects,death_and_encounter,armor_and_dash}.test.ts` + `tests/ai/enemy_fsm.test.ts`），这 6 处**必须**同步更新为 16 段。M7-T01 之所以选择「不加段」（把物理相位挂进 `MovementSystem` 尾部），是因为那里新增的是**同一实体的位移相位**；而 Hazard 拥有**独立的生命周期与独立的事件源（意图脉冲）**，把它塞进任何既有系统的尾部都会制造一个职责不明的「杂项分支」。加段是这里更诚实的代价。

### 4.4 AC-02 · 玩家死亡拦截与 `RUN_FAILED`

**判定与写入（`DeathSystem`）**

`DeathSystem` 在**标记玩家死亡的同一次循环迭代**里执行：

```
markDead(world, id);
neutraliseIntent(world, id);
this.events.emit({ tick, entityId: id });
if (world.hasComponent(id, PlayerInputComponent)) {
  const state = findGameState(world);
  if (state !== undefined) state.status = GameStatus.RUN_FAILED;
}
```

- **玩家判据 = `PlayerInputComponent`**（spec 01 §3.3：它挂在玩家身上**且只挂在玩家身上**）。不用 `Faction.Player`，因为阵营是可被未来玩法改写的标签，而「拥有硬件输入设备」在引擎里是结构性的唯一性。
- **同拍写入**：玩家在第 `T` 拍被打空 HP ⇒ `DeathSystem`（index 12）在第 `T` 拍末尾挂 `DeadTagComponent` **并**置 `RUN_FAILED`。测试只需 `step(1)` 即可观察到状态变化（`step(n)` 处理 tick `0..n-1`）。
- **`RUN_FAILED` 的读侧只加两道门，不加第三道**：

  | 门 | 位置 | 效果 |
  |---|---|---|
  | ① **玩家意图压制** | `PlayerControllerSystem.deriveIntent` | 与「抽奖期压制」共用同一个 `suppressed` 布尔（同一个 choke point，一次判定，不可能半生效） |
  | ② **房间调度惰性** | `EncounterSystem` 循环首行 | `RUN_FAILED` ⇒ `continue`：不生成新波、不推进波次、不掷奖励草稿 |

  **为什么不在每个系统都加门**：`DeadTagComponent` 已经是「尸体不产出意图 / 不被位移 / 不参与命中」的权威（spec 08 §4.2），尸体门已经覆盖了「玩家不再响应输入」。①② 的价值是**局级的**：① 让「本局的输入已死」在**意图生成点**成立（而不是依赖某个下游系统恰好也查了死亡标签），② 让「本局不再推进」成立——否则玩家死后房间仍会在 30 拍后刷出下一波，那才是真正的「像小怪死亡那样继续运转」。

- **为什么缺失 `GameStateComponent` 时一切照旧**：`findGameState` 返回 `undefined` ⇒ ①② 都不触发 ⇒ 所有 M1–M7 测试逐位不变。这是刻意的 **opt-in** 语义：`RUN_FAILED` 是「一局」的属性，只有装配了一局的调用方（`main.ts` / M8 测试）才拥有它。

**`RUN_FAILED` 不冻结 `step()`**：世界继续走 Tick（尸体 FX、敌人回到 `IDLE`、`LifespanSystem` 继续回收），但玩家无意图、房间无推进。把「失败」实现成「暂停仿真」会让 `step()` 的语义依赖于一个游戏概念，并让「重放一段包含死亡的输入脚本」变成不可能。

### 4.5 AC-03 · `restartRun` 世界重置

```ts
public restartRun(newSeed?: number): void
```

执行顺序（每一步都有理由，**不得重排**）：

1. `this.world.clearEntities()` —— 销毁**全部**实体（含玩家、房间、尸体、预警、在飞投射物、未爆判定圆、残留词缀持有者）。
2. `this.world.reseed(newSeed ?? this.world.rng.seed + 1)` —— 换种子。
3. `this.input.clear()` —— 丢弃**已排期但未消费**的输入事件（例如玩家死亡当拍已入队的 `move`/`keyDown`）。不清空的话，新一局的第一拍会收到**上一局的输入**，这是重放污染，不是「残留」而是「串味」。
4. `this.scheduler.reset()` —— 调用每个系统的可选 `reset?()`，让**持有 Tick 级总线的系统**丢弃其内容（`DeathSystem` 的死亡总线、`ModifierSystem` 的命中/冲刺总线）。tick 边界上这些总线按不变量本应为空，但 `DeathSystem` 的总线刻意保留「刚处理那一拍的死亡」（spec 08 §3.3）——重启后它引用的是**已销毁**的 id，必须显式丢弃。
5. `this.clock.reset()` —— `totalTicks → 0`。新一局从 tick `0` 开始；`elapsedSeconds` 是 `totalTicks × fixedDeltaSeconds` 的纯函数，因此自动归零（铁律 2）。
6. `this.runSetup?.(this.world)` —— 由**调用方**提供的「一局怎么装」回调，重建玩家 / 房间 / `GameStateComponent`。

**`newSeed` 的语义**：显式给值 ⇒ 用它；省略 ⇒ `当前种子 + 1`。**递增而非随机**是确定性的要求（ADR-004）：`restartRun()` 在同一进程里对同一初始种子必须产出**同一个**新种子，因此「重开两局」是可重放的。种子依然**不是**由逻辑层凭空发明的——它要么来自调用方，要么是已有种子的纯函数。

**`World.nextId` 刻意不重置**（I8）：`GameRenderer.retired` 是一个「这些 id 的死亡 FX 已经播完，永远不要再建视图」的集合，它**依赖 id 永不复用**（spec 10 §4.5）。若 `clearEntities` 把 `nextId` 归零，重启后的玩家会拿到一个已在 `retired` 里的 id ⇒ **玩家在画面上永久隐身**。这是一条 P0，且它在逻辑层测试里**不可见**——所以必须写成不变量而不是靠记忆。

**`World.rng` 的实例身份保持稳定**：`reseed()` 原地改写生成器的 32 位状态，而不是替换 `World.rng` 对象。任何在装配期捕获了 `world.rng` 引用的代码（测试、未来的存档层）在重启后依然指向**当前**的生成器。

**`runSetup` 是构造期选项而非 `restartRun` 的参数**：任务要求的签名是 `restartRun(newSeed?)`，而「一局长什么样」是**装配**知识（`src/` 不知道什么是玩家、什么是房间）。把它放进 `GameSimulatorOptions` 让 `GameSimulator` 在**不知道任何游戏概念**的前提下拥有「重建一局」的能力——与 `createDefaultSystems` 把「管道长什么样」交给调用方是同一种分工。

### 4.6 AC-03 · 表现层契约（只读）

- `GameRenderer` 的 `ViewKind` 增加 `'hazard'`。分类顺序变为 **hazard → hitbox → faction**：Hazard 没有 `FactionComponent`，若不先判它就会被 `createView` 当作「无视觉契约的实体」（如房间单例）静默跳过。
- 预警的视觉进度 = `1 - delayTicks / totalDelayTicks`（clamp `[0,1]`，`totalDelayTicks <= 0` 时取 `1`）。它驱动 **alpha 递增**（0.45 → 1.0）与**半径收拢**（scale 0.8 → 1.0），即「随着倒计时收束的红色实心圆 + 线圈」。选择 alpha/scale 而非逐帧重绘线宽，是为了避免每帧重建 `Graphics` 几何。
- `UIManager` 观测 `isRunFailed(world)` ⇒ 渲染死亡覆盖层（`YOU DIED` + 按键提示），并在**显示期间**注册 `keydown` 监听捕获 `R` 键；**隐藏时立即移除**监听。死亡覆盖层优先于奖励草稿（两者不可能同时成立，但优先级必须是确定的）。
- 表现层依然**只读**：`UIManager` 不调用 `restartRun`，它只调用注入的 `onRestart` 回调；组合根（`main.ts`）才是调用 `sim.restartRun()` 的地方（spec 09 AC-01）。

---

## 5. 验收标准

| ID | 标准 | 覆盖测试 |
|---|---|---|
| **AC-01** | `delayTicks = N` 的 Hazard：tick `T` 播种，tick `T+1 .. T+N-1` 无伤害，tick `T+N` 结算**确切**伤害，tick `T+N+1` 前 Hazard 实体已被清理；爆破圆存活恰好 1 Tick | `G1` |
| **AC-02** | 预警期间 Hazard 无 `HitboxComponent`（I1），不参与命中结算，不进入 AI 索敌集（I2） | `G0` / `G1` |
| **AC-03** | Hazard 的倒计时**不受顿帧影响**：对 Hazard 施加长冻结，它仍按时引爆 | `G1` |
| **AC-04** | 被冻结/死亡的实体手中不会留下待爆脉冲：`FreezeSystem` / `DeathSystem` 一并清零 `wantsToHazard` | `G2` |
| **AC-05** | 玩家 HP 归零 ⇒ 同一拍内 `status` 变为 `RUN_FAILED`；`RUN_FAILED` 后玩家意图恒零（移动与攻击都不再发生） | `G3` |
| **AC-06** | `RUN_FAILED` 后房间不再推进：未排期的下一波永不生成 | `G3` |
| **AC-07** | `restartRun()` 后：`tick === 0`、实体数回到初始装配量、旧 id 全部销毁、`status === PLAYING`、死亡总线为空、废弃判定圆与预警全部消失 | `G4` |
| **AC-08** | `restartRun(newSeed)` 换种子；`restartRun()` 递增种子；两次相同种子的重启产生**逐字相同**的快照序列 | `G4` |
| **AC-09** | `restartRun` 后 `World.nextId` 严格大于重启前的最大值（I8，`retired` 不变量的机器可验证形式） | `G4` |
| **AC-10** | 管道为 16 段且顺序固定；`HazardSystem` 在 `AISystem` 之后、`CollisionSystem` 之前 | 6 处钉桩 + `G5` |
| **AC-11** | 未装配 `GameStateComponent` 的世界零回归：`RUN_FAILED` 两道门都不触发 | `G5` |

---

## 6. 逐 Tick 时序契约（QA 可钉）

**记号**：`sim.step(n)` 处理 tick `0 .. n-1`，之后 `sim.tick === n`。

### 6.1 直接播种的 Hazard（`delayTicks = 30`，玩家站在落点）

| 处理到的 tick | `delayTicks`（拍末） | 玩家 HP | Hazard 存活 |
|---|---|---|---|
| `0` | 29 | 100 | ✅ |
| `1` | 28 | 100 | ✅ |
| … | … | 100 | ✅ |
| `28` | 1 | 100 | ✅ |
| `29` | 0 | 100 | ✅ |
| **`30`** | —（已销毁） | **75** | ❌ |
| `31` | — | 75 | ❌ |

爆破圆：tick `30` 生成 → tick `30` 被 `CollisionSystem` 检测并结算 → tick `30` 末被 `LifespanSystem` 销毁。**在 tick `31` 观察时它已不存在。**

### 6.2 AI 埋雷（前摇结束当拍）

敌人在 tick `T` 的前摇结束（`AISystem` 同拍抬升 `wantsToAttack` 与 `wantsToHazard`）：

- tick `T`：`HazardSystem` 相位 A 消费脉冲，在**目标 tick `T` 起始坐标**生成 Hazard（`delayTicks = 30` → 拍末 29）；近战判定圆同拍由 `CombatActionSystem` 生成。
- tick `T+30`：爆破（同上表）。

### 6.3 玩家死亡

| 处理到的 tick | 事件 |
|---|---|
| `T` | 某次结算把玩家 HP 打到 `0`；`DeathSystem`（index 12）末尾挂 `DeadTagComponent` + `status = RUN_FAILED`；`EncounterSystem`（index 13）本拍已读到 `RUN_FAILED` 而惰性 |
| `T+1` 起 | `PlayerControllerSystem` 的 `suppressed` 为真 ⇒ 玩家意图恒零；即使按住摇杆 / 按下攻击键也不产生位移与判定圆 |

### 6.4 `restartRun()`

- 调用后 `sim.tick === 0`，`world.listEntities()` 只含 `runSetup` 新建的实体，`status === PLAYING`。
- `step(1)` 后实体数 == 「同种子全新构造 + `step(1)`」的实体数（逐字相同）。

---

## 7. 风险登记

| ID | 风险 | 影响 | 缓解 |
|---|---|---|---|
| **R1** | 新增第 16 段打散 6 处管道钉桩 | 中 | 已同步更新 6 个测试文件；`HazardSystem` 的槽位由 AC-10 显式钉住（`AISystem` 之后、`CollisionSystem` 之前），而不是只靠数组顺序 |
| **R2** | `clearEntities` 若重置 `nextId` ⇒ `GameRenderer.retired` 永久隐藏新玩家 | **P0** | I8 + AC-09：`clearEntities` 不碰 `nextId`，并由测试机器验证 |
| **R3** | 爆破圆 owner 若指向施法者 ⇒ 施法者先死则雷失效 | 高 | 爆破圆 owner = Hazard 自身（§4.1），owner 门结构上不可能退役它 |
| **R4** | Hazard 若挂 `FactionComponent` ⇒ 被 AI 索敌、被判定圆命中 | 中 | I2：阵营存在 `HazardComponent.faction`，不挂 `FactionComponent` |
| **R5** | `wantsToHazard` 若不清零 ⇒ 冻结/死亡实体留下待爆脉冲 | 中 | `FreezeSystem` / `DeathSystem` / `AISystem` 三处同步清零，AC-04 钉桩 |
| **R6** | `RUN_FAILED` 门若加得过宽 ⇒ 变成隐藏测试空洞的冗余门 | 中 | 只加 2 道（玩家意图 / 房间调度），各自都有**独立的**行为断言（AC-05 / AC-06） |
| **R7** | 缺失 `GameStateComponent` 的世界被误判为失败 | 低 | `findGameState` 返回 `undefined` ⇒ 恒非失败；AC-11 零回归钉桩 |
| **R8** | 极端情况：Hazard 在 `delayTicks = 0` 时被播种 ⇒ 同拍立即爆破 | 低 | 明确契约（§4.1 先判后减 + `N = 0` 极限）；`spawnHazard` 允许 `delayTicks = 0` |

---

## 8. 已知取舍

1. **Hazard 不参与 AI 索敌，也不被玩家攻击**（I2）。想「打掉地上的雷」需要一个 `HurtboxComponent`，那会让它进入 `CollisionSystem` 的目标集与 AI 的索敌集——两个都需要额外的排除门。本里程碑选择「预警只能躲」。
2. **爆破不吃 `destroyOnHit`**：AoE 必须能命中半径内的**所有**敌对目标，所以 `destroyOnHit = false`（默认）。
3. **`RUN_FAILED` 不暂停仿真**（§4.4）：换来的是「含死亡的输入脚本可重放」。
4. **`restartRun` 不保留任何跨局状态**（连 `depth` 都归零，因为房间实体被销毁后由 `runSetup` 重建）：一局就是一次干净的装配。
