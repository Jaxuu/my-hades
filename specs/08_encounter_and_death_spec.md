# 08 · Encounter & Death Spec（死亡生命周期与房间波次调度）

| Field | Value |
|---|---|
| Spec ID | `SPEC-08-ENCOUNTER-DEATH` |
| Milestone | **M4 · 敌方智能**（T02） |
| Status | `accepted`（本文件为 M4-T02 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/DeadTagComponent.ts`（新）、`src/ecs/components/EncounterStateComponent.ts`（新）、`src/ecs/prefabs/EncounterFactory.ts`（新）、`src/ecs/systems/DeathSystem.ts`（新）、`src/ecs/systems/EncounterSystem.ts`（新）、`src/ecs/events.ts`（扩展 `EntityDeathEvent`）、`src/ecs/prefabs/spawn-helpers.ts`（`EnemySpawnOptions` 归位 + `assertNonNegativeInteger`）、`src/ecs/systems/{pipeline,AISystem,MovementSystem,DashSystem,StateSystem,CombatActionSystem,CollisionSystem,StatusEffectSystem,FreezeSystem,PlayerControllerSystem}.ts`（死亡门控）、`src/ecs/{components,systems,prefabs}/index.ts`、`tests/combat/death_and_encounter.test.ts`（新）、`tests/ai/enemy_fsm.test.ts` 与 `tests/combat/{boons,feedback,status_effects}.test.ts`（管道顺序断言同步） |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/02_dash_and_state_spec.md`（`ActionState` 状态机）、`specs/03_combat_hitbox_spec.md`（判定圆 / 圆碰撞 / `LifespanSystem`）、`specs/04_combat_feedback_spec.md`（意图解耦 / 顿帧 / 硬直 / 击退）、`specs/05_boon_modifier_spec.md`（`EventQueue` / 变异引擎 / 管道顺序）、`specs/06_status_effect_and_dot_spec.md`（DoT 相位）、`specs/07_enemy_ai_spec.md`（敌方 FSM / 意图生成段）、`docs/architecture/ADR-001-headless-ecs-foundation.md`（R1–R6 确定性铁律） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

M4-T01 让敌人**会打人**，但**打不死**——spec 07 §1.3 明确把「AI 的死亡 / 重生 / 波次」排除在里程碑之外，
spec 03 §1.3 则留下了一条更早的欠账：**`hp` 可以为 `0`，但实体不被销毁，也没有任何系统知道它死了**。
于是 `hp <= 0` 的实体仍然会移动、仍然会被判定圆反复命中、仍然会向 AI 输出意图。
这是本 Spec 要根除的**死物参与世界**问题。

M4-T02 落地两件事，且它们是**同一个契约的两半**：

1. **死亡生命周期（Death Lifecycle）**：把「死亡」从「一个数字恰好等于 0」升级为一个**全引擎公认的状态**
   （`DeadTagComponent`），并规定**从死亡的下一个 Tick 起，死物在世界里不存在**——
   不产生意图、不被位移、不出手、不被判定、不结算状态。
2. **房间波次调度（Encounter / Wave Scheduling）**：把「一波敌人」变成一个可配置、可观测、可断言的
   **有限状态机**（`IN_PROGRESS → WAVE_CLEAR → ROOM_CLEARED`），并让「这一波打完了」这件事
   **只依赖死亡标签**，而不是靠调用方数人头。

> 一句话总结本 Spec 的判据：**「死」是一个可被快照、可被逐 Tick 断言的状态；「房间清空」是这个状态的一个纯函数。**

### 1.2 In Scope（做什么）

- **新增组件**：`DeadTagComponent`（零字段死亡标记 + `markDead` / `isDead` 自由函数）。
- **新增组件**：`EncounterStateComponent`（+ `EncounterState` 枚举 + `EncounterWaveConfig` + `isWaveCleared` 自由函数）。
- **新增事件**：`EntityDeathEvent`（`tick` + `entityId`），挂在**独立**的 `EventQueue<EntityDeathEvent>` 上。
- **新增系统**：`DeathSystem`（死亡转移的唯一写入点 + 事件派发 + 意图中和）。
- **新增系统**：`EncounterSystem`（房间状态机 + 波次调度 + 延迟生成）。
- **新增预制体**：`EncounterFactory.spawn` + `resolveEncounterConfig`（加载期校验，含 dry-run 装配）。
- **死亡门控（关键交付）**：在 `AISystem` / `MovementSystem` / `DashSystem` / `StateSystem` /
  `CombatActionSystem` / `CollisionSystem` / `StatusEffectSystem` / `FreezeSystem` /
  `PlayerControllerSystem` 上各加一道「死了就跳过」的门（见 §4.2）。
- **反鞭尸（关键交付）**：`CollisionSystem` 三重门（攻击者死 → 跳过整个判定圆；目标死 → 跳过该目标；
  目标 `hp <= 0`（同 Tick 已被打死）→ 跳过该目标），见 §4.2。
- **管道扩展**：`pipeline.ts` 在 `ModifierSystem` 与 `LifespanSystem` 之间插入
  `DeathSystem` → `EncounterSystem`（第 12、13 段）。
- **装配词汇归位**：`EnemySpawnOptions` 从 `EnemyFactory.ts` 上移到 `spawn-helpers.ts` 并由工厂再导出，
  使 `components` 层可以描述一波敌人而**不反向依赖 `prefabs` 层的工厂实现**。
- **校验词汇补充**：`assertNonNegativeInteger`（`delayTicks = 0` 合法，故不能用 `assertPositiveInteger`）。

### 1.3 Out of Scope（显式排除）

- ❌ **实体销毁 / 对象池回收**：本里程碑**从不销毁战斗单位**（见 §10 取舍 1）。尸体保留全部组件，
  直到未来的「回收」里程碑显式处理。
- ❌ **掉落 / 击杀奖励 / 经验**：`EntityDeathEvent` 只承载事实，不承载任何奖励策略。
- ❌ **Boss 阶段机 / 多房间串联 / 关卡流程**：`ROOM_CLEARED` 只说明「这个房间打完了」，
  下一个房间、门、地图生成不做。
- ❌ **波次内的队形 / 生成点随机 / 权重抽取**：一波的成员是**显式列出的 `EnemySpawnOptions` 列表**，
  本里程碑无随机（沿用 spec 00 C1）。
- ❌ **重生 / 复活 / 无敌续命**：死亡是终态，没有反向转移。
- ❌ **表现层**：死亡特效、尸体淡出、房间 UI、音效（渲染层职责）。
- ❌ **玩家死亡的流程语义**（Game Over 界面、重开）：本 Spec 只保证「玩家死亡后同样不再参与世界」，
  流程语义属后续里程碑。
- ❌ 任何外部物理引擎、DOM / Canvas / 图形库（沿用 spec 00 C1）。

### 1.4 约束

- C1 **时间只来自 Tick**：一切计时以整数 Tick 计（`delayTicks` / `nextSpawnTick`），**禁止**墙钟。
- C2 **确定性**：同输入序列 ⇒ 逐 Tick 同状态；遍历一律走 `World.query`（id 升序）；
  波次成员按**配置顺序**生成；字符串比较一律 UTF-16 码元序（ADR-001 R6，**禁止 `localeCompare`**）。
- C3 **类型安全**：禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- C4 **POD 契约**：组件为 `ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法；
  一切增删改查以**自由函数**提供（`markDead` / `isDead` / `isWaveCleared`）。
- C5 **无跨 Tick 隐藏状态**：`DeathSystem` 除注入的事件总线外**零字段**；`EncounterSystem` **零字段**；
  房间状态机的全部状态（`state` / `currentWaveIndex` / `nextSpawnTick` / `trackedEntityIds`）落在组件上。
- C6 **不改时钟 / 步长 / `SystemContext`**：`FixedClock`、`GameSimulator.step`、`SystemContext` 的既有契约**不得改动**。
- C7 **不重排既有系统**：M1/M2 的六段相对顺序（`Movement .. Lifespan`）**一字不改**；`LifespanSystem` 仍为**最后一段**；
  `FreezeSystem` / `AISystem` / `StatusEffectSystem` / `ModifierSystem` 的位置约束不变。
  `DeathSystem` 与 `EncounterSystem` 是**插入**而非重排（见 §5.2）。
- C8 **死亡只有一个写入者**：`DeadTagComponent` **只能**由 `DeathSystem` 在 Tick 末尾挂载。
  造成伤害的系统（`CollisionSystem` / `StatusEffectSystem`）**绝不**自己标记死亡——
  这是「死亡转移恰好发生一次、恰好在一个可审计的点」的结构保证。
- C9 **事件不承载策略**：`EntityDeathEvent` 只说「谁死了、哪一拍死的」，
  不含阵营 / 坐标 / 死因 / 奖励。与 `HitEvent` 同一纪律（spec 05 C8）。
- C10 **既有行为零回归**：世界里**没有** `EncounterStateComponent` 时 `EncounterSystem` 是**严格无操作**；
  **没有实体死亡**时 `DeathSystem` 只做一次 `clear()`，不改变任何可观测状态。
  M1–M3 的全部逐 Tick 断言**不得**因本里程碑而改变数值。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **死亡标签（`DeadTagComponent`）** | 零字段组件。「这个实体已经死了」这件事的**唯一权威表达**，`world.query` 可直接命中。 |
| **尸体（Corpse）** | 已挂 `DeadTagComponent` 但仍 `world.isAlive` 的实体。本里程碑**不销毁**它。 |
| **死亡转移（Death Transition）** | `hp <= 0` 且无标签 → 挂标签 + 中和意图 + 派发事件。由 `DeathSystem` 在 Tick 末尾**恰好执行一次**。 |
| **死亡门控（Death Gate）** | 每个玩法系统开头的 `if (isDead(...)) continue;`。它是「死物不参与世界」的实现手段。 |
| **同 Tick 门（Same-tick Gate）** | `CollisionSystem` 里 `targetHealth.hp <= 0` 的判定。填补「标签要到 Tick 末尾才挂」造成的同 Tick 空隙。 |
| **房间（Encounter / Room）** | 一个挂 `EncounterStateComponent` 的**全局单例实体**。它没有位置、没有受击盒、没有寿命。 |
| **波次（Wave）** | 一组敌人规格 + 一个生成延迟（`delayTicks`）。 |
| **追踪列表（`trackedEntityIds`）** | 当前波次生成出的实体 id（升序，生成顺序）。**空列表 = 本波尚未生成**。 |
| **生成截止 Tick（`nextSpawnTick`）** | 待生成波次的**绝对**生成 Tick；`-1`（`ENCOUNTER_WAVE_UNSCHEDULED`）表示尚未排期。 |
| **波次清空（Wave Cleared）** | 追踪列表**非空**且其中每个 id 都已死（挂标签）或已被销毁。 |
| **`ROOM_CLEARED`** | 最后一波被检测清空的那一拍进入的终态。此后调度器完全惰性。 |
| **中和意图（Neutralise）** | `DeathSystem` 把尸体的 `moveVector` 置 `(0,0)`、脉冲置 `false`、`aimRadians` 置 `null`。 |

---

## 3. 组件与类型契约

### 3.1 `DeadTagComponent` — 死亡标记（新增）
```ts
export class DeadTagComponent extends ComponentBase {}          // 零字段

export function markDead(world: World, id: EntityId): void;     // 幂等；非存活 id 为 no-op
export function isDead(world: World, id: EntityId): boolean;    // isAlive(id) && hasComponent(id, DeadTag)
```

三条设计决定，都不是风格问题：

1. **用组件类型而不是 `TagComponent.tags` 里的字符串**。组件类型是**不可伪造的键**：
   没有任何别的代码能不小心把 `'Dead'` 当成风味标签写进 `TagComponent`，
   而 `world.query(DeadTagComponent)` 也**不可能**匹配到别的实体。反过来 `hasTag(world, id, 'Dead')`
   会因为未来某个恰好带这个字符串的实体而静默变真。死亡是全引擎必须达成共识的**唯一**状态，所以给它一等标记。
2. **用标签而不是销毁**。销毁后 `World.query` 不再产出该 id、组件全没了，
   于是「尸体已被回收」与「这个 id 从未存在」**不可区分**——而房间调度器（§4.3）的全部工作就是问
   「我这一波的成员是不是都没了」。所以死亡是**状态**（实体活着 + 有标签），销毁是**另一个**显式的、可选的决定。
3. **`isDead` 对已销毁 id 返回 `false`**（靠 `isAlive` 守卫）。这条是**载荷性**的：
   调用方必须把「已销毁」当成**自己独立的**跳过理由，**绝不能**把它折叠进「已死」。
   `isWaveCleared` 就是这么写的，`CollisionSystem` 的 owner 门也是这么写的
   （它因此保住了「判定圆可以比它的主人活得久」这条 M1–M3 契约）。

### 3.2 `EncounterStateComponent` — 房间状态（新增）

```ts
export enum EncounterState {
  IN_PROGRESS = 'IN_PROGRESS',   // 当前波次在场（或即将生成）：房间正在打
  WAVE_CLEAR  = 'WAVE_CLEAR',    // 当前波次死光，正在为下一波倒计时
  ROOM_CLEARED = 'ROOM_CLEARED', // 所有波次都死光：房间结束，调度器惰性
}

export interface EncounterWaveConfig {
  readonly delayTicks: number;               // 非负整数；0 = 一旦待生成就立刻生成
  readonly enemies: readonly EnemySpawnOptions[];  // 非空
}

export class EncounterStateComponent extends ComponentBase {
  public waves: readonly EncounterWaveConfig[];
  public state: EncounterState;
  public currentWaveIndex: number;
  public nextSpawnTick: number;              // 绝对 Tick；-1 = 未排期
  public trackedEntityIds: EntityId[];
}

export const ENCOUNTER_WAVE_UNSCHEDULED = -1;

/** AC-03 判据。空列表**不是**「已清空」，而是「尚未生成」。 */
export function isWaveCleared(world: World, trackedEntityIds: readonly EntityId[]): boolean;
```

- **挂在一个全局单例「世界实体」上**，而不是空间实体：房间没有位置、没有受击盒、没有寿命，
  给它挂 `TransformComponent` 等于发明没有意义的数据。
- **配置整份挂在组件上**（而不是放模块级表）：整个房间——含配置——都进快照，
  重放不需要任何外部查表。这是「确定性」在本层的具体形状。
- **`enemies` 存完整 `EnemySpawnOptions` 而不是一个数量**：一波里每个敌人可以单独摆位、单独调参，
  而遭遇层**永不重新实现实体装配**（AC-05）。每个条目**原样**交给 `EnemyFactory.spawn`。
- **`nextSpawnTick` 存绝对 Tick 而不是倒计时**：倒计时无法在「上一波被检测清空的那一拍」启动而不产生差一
  （那一拍要么被计入 → 早生成一拍，要么被跳过 → 晚生成一拍）。绝对截止 Tick 对**每一波**都是精确的，
  包括第一波——这正是 AC-03 的「恰好 `delayTicks` 拍」可以被逐 Tick 断言的原因（§10 取舍 2）。
- **`trackedEntityIds` 在波次死光后不裁剪**：它只有「本波我该盯谁」这一个含义。
  **提升到下一波时**（`WAVE_CLEAR` 分支）清空——否则清空判定会对着错误的名单反复触发；
  **进入 `ROOM_CLEARED` 时保留**——因为空列表的含义是「尚未生成」，把它留空等于对一场**已经打完**的房间说谎。
- **空 `trackedEntityIds` 是「本波尚未生成」的标记**，因此**一波必须至少声明一个敌人**
  （否则「没敌人」与「没生成」不可区分，房间会永久卡在 `WAVE_CLEAR`，见 §3.4）。

### 3.3 `EntityDeathEvent` — 死亡事实（新增）

```ts
export interface EntityDeathEvent {
  readonly tick: number;      // 死亡被结算的 Tick（生产者的 SystemContext.tick）
  readonly entityId: EntityId; // 已死实体；**仍然存活**——死亡是状态，不是删除
}
```

- **由 `DeathSystem` 在挂标签的同一 Tick 派发**，即 `hp` 归零那一 Tick 的末尾。
  每个实体**有且只有一次**：生产者跳过已带标签的实体，且 `markDead` 幂等（AC-01 / AC-06）。
- **不承载策略**：不含阵营 / 坐标 / 死因。这些都能从尸体本身读到（而且本里程碑永不销毁它，§10 取舍 1），
  抄进事件就是可能漂移的冗余状态。载荷不含游戏类型，也是它能住在通用 ECS 层而不是组件旁边的原因。
- **独立的 `EventQueue<EntityDeathEvent>`，不与命中总线合并**：一条总线的消费者绝不该被迫去判别另一种事件。
  `createDefaultSystems(events?, deathEvents?)` 以**构造注入**提供（不塞 `SystemContext`、不挂 `World`，spec 05 C6）。
- **总线被限定在单 Tick 内**：与命中总线不同，死亡总线**没有强制消费者**，所以 `DeathSystem`
  在每次 `update` 的**开头** `clear()`。后果（且这就是契约）：`step()` 之后，总线上装的**恰好是刚处理的那一拍**的死亡，
  **永不**是积压（§6.1）。

### 3.4 `EncounterFactory` / `resolveEncounterConfig`（新增）

```ts
export interface EncounterRoomConfig { readonly waves: readonly EncounterWaveConfig[]; }

/** @throws RangeError */
export function resolveEncounterConfig(config: EncounterRoomConfig): readonly EncounterWaveConfig[];

export class EncounterFactory {
  public static spawn(world: World, config: EncounterRoomConfig): EntityId;
}
```

`resolveEncounterConfig` 的规则（全部 `@throws RangeError`）：
1. 至少一波；
2. 每个 `delayTicks` 是**非负整数**（`assertNonNegativeInteger`，因为 `0` 合法）；
3. 每波**至少一个**敌人规格（理由见 §3.2）；
4. 每个敌人规格本身合法。

第 4 条**不在这里重复实现**：实现方式是**在一个一次性 `World` 上把每个敌人规格装配一遍再丢弃**，
于是「生成时 `spawnCombatant` 会执行的规则」就是「加载时执行的规则」。抄一遍那些规则会制造第二个真相源，
而装配逻辑一改就会静默漂移；一次性世界不会漂移。

**校验必须发生在加载期**，因为 `EncounterSystem` 是在 `step()` **内部**调用 `EnemyFactory.spawn` 的：
一个坏规格如果在生成时才暴露，就会在 Tick 中途打断模拟。放在这里则是在**任何一拍跑起来之前**就中断加载——
与 `resolveDashTuning` / `resolveAITuning` 建立的「在接缝处大声失败」同一纪律（AC-05）。

`EncounterFactory.spawn` 只做两件事：创建单例实体、挂上**初始状态**
（`IN_PROGRESS` / 波次 `0` / 未排期 / 追踪列表空）。**它不生成第一波**——
生成是**逐 Tick 的决定**，属于 `EncounterSystem`（§4.3）。后果（且这是文档化契约）：
第一波出现在**第一个被处理的 Tick**（`waves[0].delayTicks = 0`），
所以调用方**必须至少 `step()` 一次**，房间才会有敌人。

---

## 4. 语义契约

### 4.1 死亡转移（AC-01）

对每个 `hp <= 0` 且**尚未**挂 `DeadTagComponent` 的实体（按 id 升序），`DeathSystem` 依次：

1. `markDead(world, id)`（幂等）；
2. **中和意图**：`moveVector = (0,0)`、`wantsToDash = false`、`wantsToAttack = false`、`aimRadians = null`；
3. 派发 `EntityDeathEvent { tick, entityId }`。

第 2 步**不是装饰**。所有意图生产者（`PlayerControllerSystem` / `AISystem`）从本里程碑起都跳过死物（§4.2），
这恰恰是「尸体不产生意图」成立的原因——但它同时意味着**再也不会有人写尸体的意图**，
于是它死亡那一刻持有的值会被**永久冻结**在快照里。在这里清零，把 AC-01 的「不再输出意图」
变成**可直接观测的事实**（四个字段都是确定值），而不是一个测试只能靠「没人写」去反推的缺失。

**`hp` 已经由 `applyDamage` 夹在 `0`**，所以 `hp <= 0` 就是精确的「血打光了」谓词，没有负血边界要处理。

### 4.2 死亡门控（AC-01 的「次 Tick 起」）

AC-01 的措辞是**「HP 归零的当 Tick 末尾进入死亡状态，次 Tick 起不再产生碰撞，不再输出意图」**。
「当 Tick 末尾」与「次 Tick 起」都是**硬契约**，不是近似：

**为什么是 Tick 末尾。** `DeathSystem` 排在**所有伤害来源之后**（`CollisionSystem`、`StatusEffectSystem` 都在它上游），
也排在 `ModifierSystem` 之后。所以它运行时 `hp` 对本 Tick 已是终值，赐福也已经对「本 Tick 落地的命中」反应完毕。
⇒ **死亡只被裁决一次，且裁决在一个已结算的值上**；同时，一个在死亡那一拍还打中了人的实体**照样算数**
（Tick 的结算是原子的，同归于尽是两次同时命中，不是鞭尸，见 §8）。

**为什么是次 Tick 起。** 标签在 Tick 末尾才挂，所以**本 Tick 之内**标签还不存在。
这是为什么 `CollisionSystem` 需要**三道**门而不是两道：

| # | 门 | 位置 | 拦住什么 |
|---|---|---|---|
| a | **owner 门** | 每个判定圆一次，在目标循环**之前** | 死者挥出的判定圆整颗失效：不结算伤害、不写反馈、不发事件。 |
| b | **target 门** | 每个目标一次，在组件取用与几何测试**之前** | 尸体**根本不是命中目标**：不重复结算、不产生连环顿帧、不在 `hitEntities` 里留痕。 |
| c | **同 Tick 门** | 取到 `HealthComponent` 之后 | 本 Tick 早些时候已被打到 `hp <= 0`、但标签还没挂的实体——否则两颗判定圆会在同一 Tick 都对它结算，第二颗会写一次多余（且可能长得多的）顿帧。**一实体一 Tick 只结算一次。** |

**故意不加门的地方**：owner 门以**死亡标签**为键，**不是** `world.isAlive`。
主人被**销毁**的判定圆仍然有效——这是 M1–M3 的契约（判定圆快照了阵营，是独立实体，
正是为了在主人消失后继续飞完）。只有**死亡**会让一次挥砍作废，因为死亡是全引擎共识的那一个状态。

其余系统的门（顺序即优先级）：

| 系统 | 门 | 语义 |
|---|---|---|
| `PlayerControllerSystem` | 两个阶段各一道 | 阶段 1 不更新设备快照；阶段 2 **不把摇杆向量重新推导到意图上**（否则「死了还在走」会持续到下一拍）。 |
| `FreezeSystem` | 一道 | 尸体的冻结计数**停在原地**，不排空到 0。安全，因为 `isFrozen` 的每个消费者也都跳过死物。 |
| `AISystem` | **Gate -1，最优先** | 尸体**不写任何东西**。它必须在 `isFrozen` / `HITSTUN` 两道门之前：死亡是唯一**永不失效**的门。 |
| `MovementSystem` | **第 0 优先级** | 尸体**完全不被位移**，连在飞的击退也不行。死亡**高于**顿帧与硬直——后两者依赖计数器的相位，死亡不依赖。 |
| `DashSystem` | 一道（在冻结门之前） | 尸体不能起冲刺、不能持无敌标签、不能继续跑冷却。 |
| `StateSystem` | 一道（在冻结门之前） | 尸体的动作状态机**结束**；`ticksInState` 停在原地（**包括它死时所处的 `HITSTUN`**）。 |
| `CombatActionSystem` | 一道（在冻结门之前） | 尸体**不生成判定圆**。放在「读并清除脉冲」之前是刻意的：脉冲是意图生产者与消费者之间的单 Tick 导线，而尸体的意图已被中和，没东西可消费也没东西可缓冲。 |
| `StatusEffectSystem` | 一道 | 尸体**不再持续受伤**。这是**语义**选择而非数值选择：`applyDamage` 夹在 `0`，让尸体的毒继续跳不会改变任何血量；跳过它是因为「死亡终止一切进行中的过程」是本引擎其余部分实现的契约，而一个还在跑的异常时钟会是这条契约唯一可见的泄漏口。 |
| `LifespanSystem` | **故意不加** | 判定圆不是战斗单位、没有 `HealthComponent`。尸体在飞的挥砍仍按原计划老化，保住完整的 `activeTicks` 窗口。死者挥砍的退役由 owner 门在**使用点**执行；在这里提前过期反而会把「寿命」耦合到游戏概念上，并破坏 spec 03 §6 钉住的「判定圆恰好活 `activeTicks` 拍」契约（§10 取舍 3）。 |

**门控顺序不可交换**（这是本 Spec 最容易踩的地方）：`AISystem` 内部，
死亡门必须在冻结门与硬直门**之前**——顿帧是**暂停**（计时原地冻结，不吞帧），
硬直是**打断**（重置 `IDLE`，作废的前摇不补触发），而死亡是**终止**。把死亡排在三者之后，
一次同时写入「顿帧 + 硬直」的命中会把「终止」降级成「暂停」或「打断」。

### 4.3 房间状态机与波次推进（AC-02 / AC-03）

`EncounterSystem` 对每个房间实体（按 id 升序；通常恰好一个）**每 Tick 只做一个决定**：

1. `ROOM_CLEARED` → **惰性**：不生成、不清空判定、不做状态抖动。
2. 当前波次**尚未生成**（`trackedEntityIds` 为空）→ **待生成分支**：首次看见时排期
   （`nextSpawnTick = now + delayTicks`），然后一旦 `ctx.tick >= nextSpawnTick` 就生成。
3. 当前波次**在场**（`trackedEntityIds` 非空）→ **推进分支**：`isWaveCleared` 为真时，
   有下一波则提升为待生成（`WAVE_CLEAR`），无下一波则结束房间（`ROOM_CLEARED`）。

**分支 2 先于分支 3 且 `continue`**，所以**生成永远不会与「检测到清空」发生在同一拍**：
房间先承认「这一波结束了」，然后才排期。这就是 `delayTicks = 0` 对第 `k > 0` 波意味着
**「下一拍」**而不是「同一拍」的原因，也让两个决定不会交织。

**波次清空的定义（AC-03）**：`isWaveCleared` 为真当且仅当追踪列表**非空**且其中**每个** id 都已「消失」——
`!world.isAlive(id) || isDead(world, id)`。两个跳过理由**保持独立**，不折叠成一个标志。

- **空列表不是「已清空」**。它是「本波尚未生成」；把它报成清空会让调度器推进一个它从未打过的波次。
- **`ROOM_CLEARED` 在最后一波被检测清空的那一拍**——房间不是「在等一个永远不会来的波次」，它**结束了**。
- **提升到下一波时** `advance` 把 `trackedEntityIds` **清空**（而不是留着死 id），
  这样下一拍自然进入待生成分支；**进入 `ROOM_CLEARED` 时保留**最后一波的名单
  （理由见 §3.2：空列表 = 尚未生成，对已打完的房间是错误描述）。

### 4.4 尸体保留 vs 销毁

本里程碑**永不销毁战斗单位**。`DeathSystem` 挂标签、中和意图、发事件，然后停手。
理由是 §3.1 第 2 条：房间调度器必须能区分「我的波次成员死了」与「这个 id 从未存在过」，
而只有尸体保留组件才做得到。回收是**另一个**可选的、属于后续里程碑的关注点。

### 4.5 装配复用（AC-05）

`EncounterSystem.spawnWave` 按**配置顺序**逐个调用 `EnemyFactory.spawn(world, enemy)`，
并把返回的 id 收集成新的追踪名单。**它不碰任何组件**——新增一种敌人变体不需要改这个系统。
这与 `PlayerFactory` / `EnemyFactory` / `spawnCombatant` 的「装配只在一个地方」的纪律同源。

---

## 5. 系统契约与管道顺序

### 5.1 各系统职责（M4-T02 变更点）

| 系统 | 变更 |
|---|---|
| `PlayerControllerSystem` | 新增死亡门（两个阶段各一道） |
| `FreezeSystem` | 新增死亡门 |
| `AISystem` | 新增死亡门（**Gate -1**，最优先） |
| `MovementSystem` | 新增死亡门（**第 0 优先级**，高于冻结） |
| `DashSystem` | 新增死亡门（在冻结门之前） |
| `StateSystem` | 新增死亡门（在冻结门之前） |
| `CombatActionSystem` | 新增死亡门（在冻结门之前） |
| `CollisionSystem` | 新增**三道**门（owner / target / 同 Tick） |
| `StatusEffectSystem` | 新增死亡门 |
| `ModifierSystem` | **无变更**（它不跳过冻结实体，也不跳过死物——顿帧与命中同 Tick 写入，跳过会让祝福永不触发；死亡实体的命中不会出现在总线上，因为 `CollisionSystem` 的 target 门已经拦掉了） |
| `DeathSystem` | **新增**（第 12 段） |
| `EncounterSystem` | **新增**（第 13 段） |
| `LifespanSystem` | **无变更**（故意不加死亡门，§4.2） |

### 5.2 规范管道（硬契约，M4-T02 扩展为 13 段）

```
PlayerControllerSystem → FreezeSystem → AISystem → MovementSystem → DashSystem
  → StateSystem → CombatActionSystem → CollisionSystem → StatusEffectSystem
  → ModifierSystem → DeathSystem → EncounterSystem → LifespanSystem
```

`DeathSystem` 与 `EncounterSystem` 是**插入**，M1/M2 六段相对顺序与既有的三个插入点**一字不改**，
`LifespanSystem` 仍是最后一段。两个新槽位都是**被迫**的：

- **`DeathSystem` 在 `ModifierSystem` 之后**：本 Tick 的命中已被完整反应（赐福、注入的判定圆）之后才收尸。
  「Tick 先完整播完，再清点死者」是 AC-01「当 Tick 末尾」的字面读法。
- **`DeathSystem` 在 `LifespanSystem` 之前**：`LifespanSystem` 必须保持**最后**
  （spec 05 C7）——排在它之后会让判定圆在**从未被判定过**的情况下被销毁，把每个 `activeTicks` 窗口悄悄减一。
- **`EncounterSystem` 在 `DeathSystem` 之后**：它的**全部输入**就是死亡标签，而标签由 `DeathSystem` 在 Tick 末尾写。
  排早一拍会让**每一次**波次转移都晚一拍，`delayTicks` 的每个数字都会静默少 1。
- **`EncounterSystem` 在 `LifespanSystem` 之前**：后者必须最后。

**该槽位的后果**（文档化，不是意外）：在 Tick `T` 生成的波次，其成员**首次行动**在 `T+1`——
因为本 Tick 的所有逐实体系统都已经跑过了。这与引擎其余部分对待的「1 Tick 相位」是同一条架构属性。

### 5.3 `DeathSystem` / `EncounterSystem` 的无状态契约

- `DeathSystem` 的唯一字段是注入的死亡总线，且它**每次 `update` 开头清空**，因此总线不可能跨 Tick 累积。
  死亡裁决本身读自 `HealthComponent.hp` + `DeadTagComponent`——都是组件数据。
- `EncounterSystem` 除 `readonly name` **零字段**。它拥有的唯一东西就是自己的名字。

---

## 6. 时序硬契约（逐 Tick，QA 将逐 Tick 断言）

> **Tick 编号铁律**：`sim.step(n)` 处理的是 processed-tick `0 .. n-1`，之后 `sim.tick === n`。
> 下文一切以 **processed tick `p`** 索引，即「`frames[p]` = 处理完 tick `p` 之后的状态」。
> 全新 sim 要看到 tick `p`，需要 `step(p + 1)`（或 `runTo(p + 1)`）。

### 6.1 死亡转移逐 Tick 表

场景：玩家在 tick `p` 出手，敌人 `maxHp = hp = 10`（`DEFAULT_ATTACK_DAMAGE = 10`），两者贴身。

**tick `p`（致死拍）**

| # | 系统 | 发生了什么 |
|---|---|---|
| 1 | `PlayerControllerSystem` | 读到 `ATTACK_KEY` 上升沿 → `intent.wantsToAttack = true` |
| 2 | `FreezeSystem` | — |
| 3 | `AISystem` | —（本场景敌人非 AI 驱动） |
| 4 | `MovementSystem` | 正常积分 |
| 5 | `DashSystem` | — |
| 6 | `StateSystem` | `ticksInState += 1` |
| 7 | `CombatActionSystem` | 消费脉冲 → `ATTACKING`，生成判定圆 `H`（`activeTicks = 15`） |
| 8 | `CollisionSystem` | `H` 命中敌人：`hp 10 → 0`；`H.hitEntities += 敌人`；双方 `applyFreeze(4)`（写入 `5`）；敌人 `HITSTUN`（`ticksInState = 1`）；写 `KnockbackComponent`；发 `HitEvent` |
| 9 | `StatusEffectSystem` | — |
| 10 | `ModifierSystem` | `drain()` 本 Tick 的命中事件 |
| 11 | **`DeathSystem`** | `hp <= 0` 且无标签 → `markDead`；**中和意图**；发 `EntityDeathEvent { tick: p, entityId }` |
| 12 | **`EncounterSystem`** | 看到标签 → 若这是本波最后一个成员，**本拍**推进（§6.2） |
| 13 | `LifespanSystem` | `H.activeTicks: 15 → 14` |

**tick `p+1`（第一个「已死」拍）—— AC-01 的「次 Tick 起」**

| # | 系统 | 发生了什么 |
|---|---|---|
| 1 | `PlayerControllerSystem` | 跳过尸体（阶段 1 与阶段 2 各一道门） |
| 2 | `FreezeSystem` | 跳过 → `remainingTicks` **停在 `5`**，不排空 |
| 3 | `AISystem` | 跳过（Gate -1） |
| 4 | `MovementSystem` | 跳过 → **位置完全不变**，连在飞的击退也不位移 |
| 5 | `DashSystem` | 跳过 |
| 6 | `StateSystem` | 跳过 → `ActionState` 停在 `HITSTUN`、`ticksInState` 停在 `1` |
| 7 | `CombatActionSystem` | 跳过 → 不生成新判定圆 |
| 8 | `CollisionSystem` | `H` 的 **target 门**跳过尸体（**同 Tick 门**亦命中 `hp <= 0`）→ 不结算、不写反馈、不发事件、`H.hitEntities` **不增长** |
| 9 | `StatusEffectSystem` | 跳过 → 状态时钟停摆 |
| 10 | `ModifierSystem` | —（总线上没有指向尸体的命中） |
| 11 | `DeathSystem` | 已带标签 → 跳过（**不发第二个事件**） |
| 12 | `EncounterSystem` | —（房间已在本拍或更早推进） |
| 13 | `LifespanSystem` | `H` 照常老化 |

**可观测结论**：`p+1` 起，尸体的 `TransformComponent`、`IntentComponent`、`ActionState`、
`FreezeComponent.remainingTicks`、`StatusEffectSystem` 的计数器**全部冻结**，
`hp` 保持 `0`，且 `H.hitEntities` 不再变化。

### 6.2 波次调度逐 Tick 表

房间配置（在 tick `0` 之前加载）：

```
waves = [
  { delayTicks: 0,  enemies: [A] },     // 第 0 波
  { delayTicks: 30, enemies: [B, C] },  // 第 1 波
]
```

| processed tick | `EncounterSystem` 的决定 | 之后的状态 |
|---|---|---|
| `0` | 追踪列表空 → 首次排期：`nextSpawnTick = 0 + 0 = 0`；`0 >= 0` → 生成 `A` | `IN_PROGRESS`，`tracked = [A]`，`nextSpawnTick = -1` |
| `1` | `A` 已在 tick `1` 被 `DeathSystem` 打上标签 → 追踪列表非空但已清空 → `advance`：有第 1 波 → `WAVE_CLEAR`，`idx = 1`，`nextSpawnTick = 1 + 30 = 31`，`tracked = []` | `WAVE_CLEAR` |
| `2 … 30` | 追踪列表空 → 待生成分支：`nextSpawnTick = 31`，`tick < 31` → **等待** | `WAVE_CLEAR` |
| `31` | 追踪列表空 → 待生成分支：`31 >= 31` → 生成 `B`、`C` | `IN_PROGRESS`，`tracked = [B, C]`，`nextSpawnTick = -1` |
| `q` | `B`、`C` 都死 → `advance`：**没有第 2 波** → `ROOM_CLEARED`（追踪名单**保留** `[B, C]`） | `ROOM_CLEARED` |
| `q+1 …` | 惰性，什么都不做 | `ROOM_CLEARED` |

**一般公式**

- **第 0 波**：在**第一个被处理的 Tick** `p₀` 惰性排期，生成于 `p₀ + delayTicks`（`delayTicks = 0` ⇒ **同一拍**）。
- **第 `k > 0` 波**：设第 `k-1` 波被**检测清空**的拍为 `q`，则生成于 `q + delayTicks`（`delayTicks = 0` ⇒ `q + 1`）。
- **清空判定与死亡同拍**：因为 `DeathSystem` 排在 `EncounterSystem` 之前，最后一击落下的那一拍
  就同时完成了「打上标签」与「检测到清空」。⇒ **从最后一击到下一波生成恰好 `delayTicks` 拍**。
- **`delayTicks = 0` 的不对称**是分支结构的**文档化后果**（§4.3）：第 0 波同拍，后续波次下一拍。
  断言 `delayTicks >= 1` 的波次时，实际间隔**精确等于** `delayTicks`。

### 6.3 尸体不产生意图（AC-01 第二半）

| 场景 | tick `T`（致死拍） | tick `T+1` 及以后 |
|---|---|---|
| **AI 敌人**（死亡前处于 `CHASING`，`moveVector` 非零） | `AISystem` 正常写意图 → 随后 `DeathSystem` 中和 → `moveVector = (0,0)`、`aimRadians = null` | `AISystem` 被 Gate -1 跳过 → 四个字段**保持中和值**，`AIControllerComponent.ticksRemaining` 原地冻结 |
| **玩家**（死亡时摇杆仍被按住） | `PlayerControllerSystem` 阶段 2 把 `(1,0)` 推到意图上 → `DeathSystem` 中和 → `(0,0)` | `PlayerControllerSystem` 两道门都跳过 → **不会**被重新推导回 `(1,0)` |

若 `AISystem` / `PlayerControllerSystem` **没有**这道门，意图会在 `T+1` 被重新写满，
AC-01 的「不再输出意图」将**只维持一拍**。所以这道门不是「AI 恰好没写」，
而是让这条契约对**手写意图**也成立的唯一手段。

### 6.4 陷阱清单（写断言前必读）

1. **`step(n)` 处理的是 tick `0..n-1`**。写逐 Tick 断言前先算清「step 几次 = 处理到哪一拍」。
2. **不要用 `ActionState` 作为「尸体没被打」的证据**。尸体死时若处于 `HITSTUN`，它的 `ActionState`
   **永远停在 `HITSTUN`**（`StateSystem` 跳过），且 `ticksInState` 停在 `1` 不再前进。
   要看「没被打」就去看 `hp` / `hitEntities` / `HitEvent` / 位置。
3. **尸体的 `FreezeComponent.remainingTicks` 停在死时的值**（典型是 `hitstopTicks + 1 = 5`），
   它**不是**「还被冻着」的证据——`isFrozen` 对死物已无意义（每个消费者都跳过）。
4. **不要等命中之后再取判定圆**：判定圆可能在命中同一拍末被 `LifespanSystem` 销毁。
   需要坐标就在**上一拍**快照。
5. **`isDead` 对已销毁实体返回 `false`**。「消失」有两个独立理由（死 / 销毁），不要合并。
6. **owner 门以死亡标签为键**：主人被**销毁**的判定圆仍然有效。不要用「主人没了」来断言挥砍作废。
7. **`delayTicks = 0` 对第 0 波是同一拍、对后续波是下一拍**（§6.2 一般公式）。
8. **波次清空与死亡同拍**：不要以为要「等下一拍」才推进——`DeathSystem` 在 `EncounterSystem` 之前。
9. **`createDefaultSystems(events?, deathEvents?)`** 的第二个参数才是死亡总线；
   不传就是一个私有队列（调用方观察不到死亡）。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 陈述 | 判据 |
|---|---|---|
| **AC-01** | **死亡契约**：`hp` 归零的**当 Tick 末尾**进入死亡状态；**次 Tick 起**不再产生碰撞、不再输出意图、不被位移、不出手。 | `DeadTagComponent` 在致死拍末存在；`p+1` 起 `CollisionSystem` 不再对该实体结算、`hitEntities` 不增长、无 `HitEvent`；四个意图字段保持中和值；`Transform` 逐位不变。 |
| **AC-02** | **房间状态**：系统能加载 `waves: [{ delayTicks, enemies: [...] }]`；房间有 `IN_PROGRESS` / `WAVE_CLEAR` / `ROOM_CLEARED` 三态。 | `EncounterFactory.spawn` 加载配置并返回单例 id；初始态 `IN_PROGRESS` / 波次 `0` / 未排期 / 追踪空；三态均可在模拟中被观测到。 |
| **AC-03** | **波次推进**：`IN_PROGRESS` 且当前波次**全部**成员带 `DeadTagComponent`（或已销毁）时推进；无下一波则 `ROOM_CLEARED`。 | 清空判定与最后一击**同拍**；下一波生成于「清空拍 + `delayTicks`」；末波清空当拍进入 `ROOM_CLEARED` 且此后惰性。 |
| **AC-04** | **死亡门控全覆盖**：每个玩法系统对死物都是绝对跳过，且门的**相对顺序**正确（死亡 > 冻结 > 硬直）。 | `AISystem` 死亡门在冻结 / 硬直门之前；`MovementSystem` 死亡门在冻结门之前；`DashSystem`/`StateSystem`/`CombatActionSystem` 同。 |
| **AC-05** | **装配与校验复用**：遭遇层**不重新实现**实体装配，只调用 `EnemyFactory.spawn`；坏配置在**加载期** `RangeError`。 | `EncounterSystem` 不直接 `addComponent`；`resolveEncounterConfig` 对空波次 / 负延迟 / 非整数延迟 / 空敌人列表 / 坏敌人规格全部抛 `RangeError`。 |
| **AC-06** | **尸体保留 + 死亡事件恰好一次**：战斗单位永不被 `DeathSystem` 销毁；每个实体恰好发一次 `EntityDeathEvent`。 | 死亡后实体仍 `isAlive` 且组件齐全；多跑若干拍后死亡总线内容不再变化。 |
| **AC-07** | **管道顺序**：13 段，`DeathSystem` 在所有伤害来源与 `ModifierSystem` 之后、`EncounterSystem` 之前、`LifespanSystem` 之前；`LifespanSystem` 仍最后。 | `createDefaultSystems().map(s => s.name)` 逐项相等。 |
| **AC-08** | **确定性重放**：同脚本（含多波次与击杀）两遍运行，逐 Tick 快照一致。 | 两个 `GameSimulator` 的 `snapshot()` 逐 Tick 深比较相等。 |
| **AC-09** | **零回归**：无 `EncounterStateComponent` 时 `EncounterSystem` 严格无操作；无死亡时 `DeathSystem` 不改变可观测状态。 | 空世界跑 N 拍，实体数与快照不变；M1–M3 全部既有断言数值不变。 |
| **AC-10** | **事件总线 Tick 边界**：死亡总线在每拍开头被清空，`step()` 之后装的恰好是刚处理那一拍的死亡。 | 连续多拍各死一个实体时，每拍读到的 `size` 恰为当拍死亡数，不累积。 |

---

## 8. 失败模式（Failure Modes）

| 失败模式 | 症状 | 本 Spec 的防线 |
|---|---|---|
| **鞭尸多段伤害** | 尸体被仍在飞的判定圆反复结算，`hp` 一直停在 0 但 `hitEntities` 疯长 | `CollisionSystem` target 门（b） |
| **连环顿帧** | 同一 Tick 两颗判定圆都命中同一目标，第二颗写一次更长的 hitstop | `CollisionSystem` 同 Tick 门（c） |
| **死物位移** | 尸体带着在飞的击退滑过竞技场 | `MovementSystem` 第 0 优先级死亡门 |
| **死物出招** | 尸体在死后仍生成判定圆并打死人 | `CombatActionSystem` 死亡门 + `CollisionSystem` owner 门 |
| **意图复活** | 死亡后意图在下一拍被重新写满（AI 重写 / 摇杆重推导） | `AISystem` Gate -1 + `PlayerControllerSystem` 两道门 + `DeathSystem` 中和 |
| **死亡重复派发** | 同一实体发多次 `EntityDeathEvent` | `markDead` 幂等 + `DeathSystem` 跳过已带标签者 |
| **房间卡死** | 某波 `enemies` 为空 ⇒ 追踪列表永远为空 ⇒ 永远「尚未生成」 | `resolveEncounterConfig` 强制每波至少一个敌人 |
| **房间提前通关** | 空追踪列表被当成「已清空」 | `isWaveCleared` 对空列表返回 `false` |
| **生成时序错位** | 下一波比 `delayTicks` 早或晚一拍 | 绝对 `nextSpawnTick`（§10 取舍 2）+ `EncounterSystem` 排在 `DeathSystem` 之后 |
| **Tick 中途崩溃** | 坏敌人规格在 `step()` 内部才暴露 | 加载期 dry-run 校验（§3.4） |
| **判定圆窗口缩短** | 判定圆在从未被判定过的情况下被销毁 | `LifespanSystem` **不加**死亡门且保持最后（§10 取舍 3） |
| **同归于尽被误判为鞭尸** | 双方同 Tick 互杀时，先死的一方不再命中 | 刻意允许：Tick 结算是原子的，AC-01 只约束「次 Tick 起」（§4.2） |
| **异常时钟泄漏** | 尸体的毒还在跳 | `StatusEffectSystem` 死亡门（语义性，非数值性） |

---

## 9. 追溯（Traceability）

| 来源 | 本 Spec 的落地 |
|---|---|
| spec 03 §1.3「`hp` 可为 0 但实体不被销毁」 | AC-06 尸体保留 + §4.4 |
| spec 04 §10 取舍 1「敌人不持有硬件输入」 | 死亡门同时覆盖玩家与敌人两条意图生成路径（§4.2） |
| spec 05 C5 / C6 / C8（总线 Tick 边界 / 构造注入 / 事件不含策略） | `EntityDeathEvent` 独立总线 + `clear()` 限定单 Tick（§3.3） |
| spec 05 §5.2、spec 06 §5.2、spec 07 §5.2（插入而非重排） | §5.2 的 13 段管道 |
| spec 06 §4.2（DoT 相位靠管道位置解决） | `StatusEffectSystem` 的死亡门（§4.2） |
| spec 07 §1.3「AI 的死亡 / 重生 / 波次」排除项 | 本 Spec 的 AC-01 / AC-02 / AC-03 |
| spec 07 §4.6（冻结 / 硬直门控不可交换） | §4.2 的「死亡 > 冻结 > 硬直」顺序契约 |
| ADR-001 R6（禁用 `localeCompare`） | `trackedEntityIds` 按 id 升序、按配置顺序生成；无字符串排序 |
| 任务派发 M4-T02 Task 1 / 2 / 3 / 4 | AC-01 / AC-02+AC-03 / AC-04..AC-06 / `tests/combat/death_and_encounter.test.ts` |

---

## 10. 已知取舍（Known Trade-offs）

1. **尸体保留，不销毁**。代价：世界里的实体数只增不减，长跑会累积尸体。
   收益：房间调度器（以及未来的击杀奖励 / 死亡特效）可以**区分**「死了」与「从未存在」，
   而这是 `isWaveCleared` 能成立的前提。回收留给后续里程碑，且必须走一个**显式**的、可审计的路径。

2. **`nextSpawnTick` 用绝对 Tick，不用倒计时**。代价：组件里多存一个「绝对量」，
   且它必须在加载期被初始化成哨兵值 `-1`（因为 `EncounterFactory` 拿不到 Tick）。
   收益：**每一波**（含第一波）的生成拍都精确可断言，没有差一。
   倒计时方案在「上一波被清空的那一拍」启动时，那一拍必然要么被计入、要么被跳过，二者都会错一拍。

3. **`LifespanSystem` 不加死亡门**。代价：死者挥出的判定圆会**继续存在**到寿命耗尽
   （只是被 owner 门在判定时跳过）。收益：保住「判定圆恰好活 `activeTicks` 拍」这条被 spec 03 §6 钉死的契约，
   并让「寿命」保持为一个与游戏概念无关的纯机制。退役死者的挥砍是**使用点**的责任，不是**寿命**的责任。

4. **`delayTicks = 0` 对第 0 波与后续波次语义不同**（同拍 vs 下一拍）。
   代价：配置作者需要知道这个不对称。收益：分支结构保持单一决定、生成永不与清空判定同拍，
   从而消除「同一拍既推进又生成」这一类难以推理的交织状态。
   **`delayTicks >= 1` 的语义是完全对称且精确的**，推荐配置使用 `>= 1`。

5. **同 Tick 互杀被允许**。代价：`CollisionSystem` 的 owner 门不能阻止「在被打死的那一拍仍然打中别人」。
   收益：Tick 结算是原子的，AC-01 的字面契约就是「**次 Tick 起**」；
   若在 Tick 中途改判，会引入「同一 Tick 内行为依赖系统顺序」的隐性耦合，比允许同归于尽危险得多。

6. **`EnemySpawnOptions` 归位到 `spawn-helpers.ts`**。
   代价：`EnemyFactory.ts` 多一行再导出。收益：`components` 层（`EncounterStateComponent`）
   可以描述一波敌人而**不反向依赖** `prefabs` 层的工厂实现，依赖方向保持单向。

7. **死亡事件不携带死因 / 坐标 / 阵营**。代价：消费者（未来的击杀奖励）需要自己去读尸体。
   收益：载荷不含游戏类型（可住在通用 ECS 层），且不可能与尸体本身漂移。

---

## 11. 修订记录（Revision History）

| 版本 | 里程碑 | 变更 | 状态 |
|---|---|---|---|
| `v1.0` | M4-T02 | 初版：死亡生命周期（`DeadTagComponent` / `DeathSystem` / `EntityDeathEvent` / 九道死亡门 + `CollisionSystem` 三重门）、房间波次调度（`EncounterStateComponent` / `EncounterSystem` / `EncounterFactory`）、13 段管道、AC-01 .. AC-10。 | `accepted` |
