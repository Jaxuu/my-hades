# 07 · Enemy AI Spec（敌方状态机 AI 与攻击预警）

| Field | Value |
|---|---|
| Spec ID | `SPEC-07-ENEMY-AI` |
| Milestone | **M4 · 敌方智能**（T01） |
| Status | `accepted`（本文件为 M4-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/AIControllerComponent.ts`（新）、`src/ecs/systems/AISystem.ts`（新）、`src/ecs/components/IntentComponent.ts`（扩展 `aimRadians`）、`src/ecs/systems/MovementSystem.ts`（消费 `aimRadians`）、`src/ecs/systems/pipeline.ts`（11 段）、`src/ecs/prefabs/{spawn-helpers,EnemyFactory}.ts`、`src/ecs/{components,systems}/index.ts`、`src/ecs/World.ts`（R6 确定性修复）、`tests/ai/enemy_fsm.test.ts`（新）、`tests/combat/{feedback,boons,status_effects}.test.ts`（管道顺序断言同步） |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/02_dash_and_state_spec.md`（`ActionState` 状态机 / 管道顺序）、`specs/03_combat_hitbox_spec.md`（判定圆 / 圆碰撞 / 攻击出手）、`specs/04_combat_feedback_spec.md`（意图解耦 / 顿帧 / 硬直 / 管道顺序）、`docs/architecture/ADR-001-headless-ecs-foundation.md`（R1–R6 确定性铁律） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的
M2-T02 把「硬件输入」与「逻辑意图」拆开，并明确留下了一条扩展路径：**敌人不持有 `PlayerInputComponent`，
其意图由 AI / 脚本直接写入 `IntentComponent`**（spec 04 §10 取舍 1）。M4-T01 就是兑现这条路径——
让敌人**自己**产生意图，而不是被测试脚本牵着走。

本里程碑落地三件事：

1. **意图复用（Intent Reuse）**：AI 的唯一输出是**意图**。AI 不移动实体、不生成判定圆、不改战斗数值，
   它只写 `IntentComponent`，由既有的 `MovementSystem` / `CombatActionSystem` 负责执行。这条纪律是
   「AI 与玩法逻辑正交」的结构保证——新增一种敌人行为**不需要**新增一套移动或战斗代码。
2. **有限状态机（FSM）**：`IDLE → CHASING → WINDUP → COOLDOWN` 四态闭环，全部计时以整数 Tick 计。
3. **攻击预警（Telegraphing）**：进入攻击距离后敌人**定身**并**锁定出手朝向**，用 `windupTicks`
   拍把「我要打了」明确地告诉玩家。预警期间被打断（硬直）或暂停（顿帧）都必须**可断言**。

> 本 Spec 只定义**单个敌人的状态机与预警契约**。仇恨表、群体协同、寻路 / 避障、巡逻点、
> 难度曲线、Boss 阶段机全部属于后续里程碑。

### 1.2 In Scope（做什么）
- **新增组件**：`AIControllerComponent`（+ `AIState` 枚举 + 默认常量）。
- **新增系统**：`AISystem`（意图生成段；FSM 推进 + 冻结 / 硬直门控 + 写 `IntentComponent`）。
- **组件扩展**：`IntentComponent` 增加 `aimRadians`（朝向意图）——AC-04 的「锁定出手朝向」由此**经意图层**表达。
- **系统扩展**：`MovementSystem` 在**静止**分支消费 `aimRadians`（保持「`facingRadians` 只有一个写入者」）。
- **预制体**：`spawn-helpers.ts` 增加 `AITuningOptions` / `resolveAITuning` 与**可选** AI 挂载；`EnemyFactory` 透传。
- **管道扩展**：`pipeline.ts` 在 `FreezeSystem` 与 `MovementSystem` 之间插入 `AISystem`（第 11 段）。
- **确定性技术债**：`World.listComponents` 的 `localeCompare` 换成 UTF-16 码元比较；ADR-001 追加 R6，
  并在 `eslint.config.mjs` 里加一条 **AST 门**（拦 `localeCompare` / `toLocale*` / `Intl`），让 R6 成为机器判据。

### 1.3 Out of Scope（显式排除）
- ❌ **群体 AI / 仇恨表**：多敌人协同、目标转移、仇恨衰减、包围站位。
- ❌ **寻路 / 避障 / 导航网格**：追击是「朝目标坐标的直线归一化向量」，撞墙绕行不做（本里程碑无地形）。
- ❌ **敌人冲刺 / 闪避**：`AISystem` 不写 `wantsToDash`（AI 的 `wantsToDash` 永远保持 `false`）。
- ❌ **多种敌人类型 / 技能表**：只有一种「近战追击 + 单次挥砍」原型；技能选择、连段、远程弹道不做。
- ❌ **AI 的死亡 / 重生 / 波次**：沿用 spec 03 §1.3——`hp` 可为 `0` 但实体不被销毁。
- ❌ **表现层**：预警特效、红光、音效、HUD（渲染层职责，逻辑核不感知；本 Spec 只保证「预警窗口可观测」）。
- ❌ **玩家侧的 AI**：`PlayerInputComponent` 与 `AIControllerComponent` 互斥（见 §4.1 / §8）。
- ❌ 任何外部物理引擎、DOM / Canvas / 图形库（沿用 spec 00 C1）。

### 1.4 约束
- C1 **时间只来自 Tick**：一切计时以整数 Tick 计（`windupTicks` / `cooldownTicks` / `ticksRemaining`），
  **禁止**墙钟；积分取 `ctx.fixedDeltaSeconds`。
- C2 **确定性**：同输入序列 ⇒ 逐 Tick 同状态；遍历一律走 `World.query`（id 升序）；
  自动索敌在等距时取**较小 id**；字符串比较一律 UTF-16 码元序（ADR-001 R6，**禁止 `localeCompare`**）。
- C3 **类型安全**：禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- C4 **POD 契约**：组件为 `ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法；
  一切增删改查以**自由函数**提供。
- C5 **无跨 Tick 隐藏状态**：`AISystem` 不得持有任何字段（`readonly name` 除外）。FSM 的全部状态
  （`state` / `ticksRemaining` / `lockedFacingRadians` / `targetEntityId`）**必须**落在组件上。
- C6 **不改时钟 / 步长 / `SystemContext`**：`FixedClock`、`GameSimulator.step`、`SystemContext` 的既有契约**不得改动**。
- C7 **不重排既有系统**：M1/M2 的六段相对顺序（`Movement .. Lifespan`）**一字不改**；`LifespanSystem` 仍为**最后一段**；
  `StatusEffectSystem` / `ModifierSystem` 的位置约束不变。`AISystem` 是**插入**而非重排（见 §5.2）。
- C8 **AI 只产生意图**：`AISystem` 不写 `TransformComponent.x/y`、不写 `VelocityComponent`、不创建实体、
  不调用 `applyDamage` / `applyFreeze`。唯一的例外是**朝向意图** `IntentComponent.aimRadians`（仍是意图层数据，
  由 `MovementSystem` 落到 `TransformComponent.facingRadians`——见 §3.3）。
- C9 **既有行为零回归**：**不挂** `AIControllerComponent` 的实体（含全部 M1–M3 用例里的敌人与玩家）
  行为**逐 Tick 逐位不变**。`AISystem` 对空查询是**严格无操作**；`aimRadians === null` 时
  `MovementSystem` 与改造前**完全等价**。
- C10 **AI 挂载是可选能力**：`EnemyFactory.spawn` **默认不挂** `AIControllerComponent`
  （既有测试用手写意图驱动敌人，默认挂载会当场污染它们）。要 AI 就必须显式传 `ai`（见 §3.5）。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **AI 控制器（`AIControllerComponent`）** | 挂在敌人身上、描述「这台 AI 现在处于什么状态、还剩几拍、瞄向哪里」的纯数据组件。 |
| **AI 状态（`AIState`）** | `IDLE` / `CHASING` / `WINDUP` / `COOLDOWN` 四态之一。**与 `ActionState` 正交**（见 §4.2）。 |
| **动作状态（`ActionState`）** | M1/M2 的通用动作状态机（`IDLE/MOVING/DASHING/ATTACKING/HITSTUN`），由 `StateSystem` 推进。 |
| **意图（`IntentComponent`）** | 逻辑意图层：`moveVector`（持久）/ `wantsToDash`·`wantsToAttack`（单 Tick 脉冲）/ `aimRadians`（朝向意图）。 |
| **意图生成段** | 管道最前端、只写意图不推进行为的一段系统：`PlayerControllerSystem`（硬件→意图）与 `AISystem`（AI→意图）。 |
| **视野半径（`sightRadius`）** | 敌人「发现」目标的距离。超出即脱战（回 `IDLE`）。 |
| **攻击半径（`attackRadius`）** | 敌人「决定出手」的距离。进入即起前摇。契约：`attackRadius ≤ sightRadius`。 |
| **前摇 / 预警（WINDUP）** | 出手前的定身窗口：不移动、朝向锁定，持续 `windupTicks` 拍。 |
| **冷却（COOLDOWN）** | 出手后的强制间隔，持续 `cooldownTicks` 拍。 |
| **朝向意图（`aimRadians`）** | `IntentComponent` 上的**持久**字段：非 `null` 时 `MovementSystem` 在**静止**分支把
`TransformComponent.facingRadians` 设为它；`null` 表示「本实体没有自己的朝向主张」。 |
| **锁定朝向（`lockedFacingRadians`）** | 进入 `WINDUP` 那一拍算出的、指向目标**当时**坐标的弧度值，前摇期间不再更新。 |
| **自动索敌（Auto-acquire）** | `targetEntityId` 为空或已失效时，取**最近的敌对存活实体**（等距取较小 id）。 |
| **硬直打断（Interrupt）** | 目标进入 `HITSTUN` 时，`AISystem` 把 FSM **硬重置**为 `IDLE`（计划作废），随后保持惰性。 |
| **顿帧暂停（Pause）** | 目标被顿帧（hitstop）时，FSM **不推进也不重置**——计时器原地冻结（「不吞帧」）。 |

---

## 3. 组件与类型契约

### 3.1 `AIState` — 状态枚举（新增）
```ts
export enum AIState {
  IDLE = 'IDLE',         // 待机：目标不可见（或不存在）
  CHASING = 'CHASING',   // 追击：目标在视野内、攻击距离外
  WINDUP = 'WINDUP',     // 前摇 / 预警：定身 + 朝向锁定
  COOLDOWN = 'COOLDOWN', // 冷却：出手后的强制间隔
}
```

### 3.2 `AIControllerComponent` — AI 控制器（新增）
```ts
export class AIControllerComponent extends ComponentBase {
  public state: AIState;                    // 当前 FSM 状态
  public targetEntityId: EntityId | null;   // 目标；null = 尚未锁定（会触发自动索敌）
  public sightRadius: number;               // 视野半径，> 0
  public attackRadius: number;              // 攻击半径，> 0 且 ≤ sightRadius
  public windupTicks: number;               // 前摇时长，正整数
  public cooldownTicks: number;             // 冷却时长，正整数
  public ticksRemaining: number;            // 当前状态剩余 Ticks（IDLE/CHASING 恒为 0）
  public lockedFacingRadians: number;       // 前摇期间锁定的出手朝向
}
```

| 契约 | 说明 |
|---|---|
| **`ticksRemaining` 语义** | **剩余**拍数。`WINDUP` / `COOLDOWN` 期间每拍减一，归零即触发转移；`IDLE` / `CHASING` 恒为 `0`。 |
| **`lockedFacingRadians` 在进入 `WINDUP` 的那一拍写入**，此后**不再更新**——这正是「锁定玩家当时的位置」。 |
| **`windupTicks` / `cooldownTicks` 落在组件上**（而非模块常量）：不同敌人应有不同的预警长度与出手节奏，
  与 `DashStatsComponent.durationTicks` / `cooldownTicks` 的处理一致。 |
| **装配唯一来源** | 与 `ModifierComponent` / `StatusEffectComponent` 不同，`AIControllerComponent` **不是**所有战斗单位的标配——
  它是**可选能力**，只在 `spawnCombatant` 收到 `ai` 调参时挂载（C10 / §3.5）。 |
| **构造顺序** | 位置参数依次为 `targetEntityId`、`sightRadius`、`attackRadius`、`windupTicks`、`cooldownTicks`、
  `state`、`ticksRemaining`、`lockedFacingRadians`（与 `HitboxComponent` 的多位置参数风格一致）。 |
| **构造不校验** | 与 `VelocityComponent` / `DashStatsComponent` 同规则：**装配层**（`resolveAITuning`）负责校验，组件只存数据。 |

### 3.3 `IntentComponent.aimRadians` — 朝向意图（扩展）
AC-01 要求「AI 的输出**仅仅是**修改 `IntentComponent`」，而 AC-04 要求「锁定出手朝向」。
攻击朝向的**唯一消费者**是 `CombatActionSystem`，它读的是 `TransformComponent.facingRadians`。
若让 `AISystem` 直接写 `TransformComponent`，就会出现**两个** `facingRadians` 写入者，且违反 AC-01。

因此本里程碑给意图层补上**朝向意图**：

```ts
// IntentComponent（扩展字段）
public aimRadians: number | null;   // 朝向意图；null = 本实体没有自己的朝向主张
```

- **语义**：`MovementSystem` 在**静止**分支（`moveVector` 为零）把 `facingRadians` 设为 `aimRadians`；
  移动时朝向仍由**移动方向**决定（M1 契约不变）。`null` ⇒ 完全不碰朝向。
- **为什么放在 `MovementSystem`**：它是 `TransformComponent.facingRadians` **唯一**的写入者，
  把朝向意图的落地也放在这里，「朝向只有一个写入者」这条不变量得以保持。
- **零回归**：M1–M3 的全部实体从不写 `aimRadians`（恒为 `null`），因此 `MovementSystem` 的改动
  对它们是**逐位等价**的（C9）。
- **`PlayerControllerSystem` 不写 `aimRadians`**：本里程碑玩家没有瞄准设备，其 `aimRadians` 恒为 `null`。
- **`FreezeSystem` 不清 `aimRadians`**：顿帧时 `MovementSystem` 整实体跳过，朝向不会被应用；
  恢复拍 `AISystem` 会重新写入。保持 `FreezeSystem` 一字不改（C7）。

### 3.4 默认常量（新增）
| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_AI_SIGHT_RADIUS` | `8` | 默认视野半径（世界单位） |
| `DEFAULT_AI_ATTACK_RADIUS` | `1.5` | 默认攻击半径；近战判定圆有效射程为 `0.75 + 1.0 + 0.5 = 2.25`，故 `1.5` 必然打得到 |
| `DEFAULT_AI_WINDUP_TICKS` | `30` | 默认前摇（30 Tick @60fps = 0.5 s） |
| `DEFAULT_AI_COOLDOWN_TICKS` | `60` | 默认冷却（60 Tick @60fps = 1 s） |

### 3.5 AI 调参与挂载（`spawn-helpers.ts` 扩展）
```ts
export interface AITuningOptions {
  readonly targetEntityId?: EntityId | null;  // 省略 / null ⇒ 运行期自动索敌
  readonly sightRadius?: number;
  readonly attackRadius?: number;
  readonly windupTicks?: number;
  readonly cooldownTicks?: number;
}

export interface ResolvedAITuning {
  readonly targetEntityId: EntityId | null;
  readonly sightRadius: number;
  readonly attackRadius: number;
  readonly windupTicks: number;
  readonly cooldownTicks: number;
}

export function resolveAITuning(options?: AITuningOptions): ResolvedAITuning;
```

| 契约 | 说明 |
|---|---|
| **校验**（`@throws RangeError`） | `sightRadius` / `attackRadius` 必须为正有限数；`windupTicks` / `cooldownTicks` 必须为正整数；
`attackRadius > sightRadius` ⇒ 抛错（「视野外还能出手」永远是配置 bug）。 |
| **挂载条件** | `CombatantSpawnOptions.ai !== undefined` 时才挂 `AIControllerComponent`（C10）。 |
| **互斥** | `ai` 与 `hardwareInput`（玩家）同时给出 ⇒ 抛 `RangeError`（一个实体不能既由硬件驱动又由 AI 驱动）。 |
| **装配位置** | 依旧只在 `spawnCombatant` 一处挂载，`EnemyFactory` 只是薄封装（沿用 spec 06 AC-10 的「装配唯一来源」纪律）。 |

---

## 4. 语义契约

### 4.1 意图复用（AC-01）
`AISystem` 每拍对每个 AI 实体执行且仅执行以下**写入**：

```
intent.moveVector    = 本拍决策的移动意图（追击时为指向目标的归一化向量；其余为 (0,0)）
intent.wantsToAttack = 本拍决策的出手脉冲（仅前摇结束的那一拍为 true，其余恒 false）
intent.aimRadians    = 前摇期间为 lockedFacingRadians，其余为 null
```

- **不写** `wantsToDash`（AI 不会冲刺）、**不写** `TransformComponent`、**不写** `VelocityComponent`、
  **不创建**实体、**不调用** `applyDamage` / `applyFreeze`（C8）。
- 敌人的移动与出手完全由既有系统执行：`MovementSystem` 积分位移与朝向，`CombatActionSystem`
  在读到 `wantsToAttack` 脉冲且 `ActionState` 允许时生成判定圆。
- **AI 是 AI 实体意图的独占作者**：每拍开头先归零（`moveVector = (0,0)`、`wantsToAttack = false`、
  `aimRadians = null`），再按 FSM 写回。手写意图对 AI 实体**无效**（这正是 AC-01 的判据）。
- **玩家不受影响**：玩家没有 `AIControllerComponent`，`AISystem` 的查询永远不会命中它。

### 4.2 FSM 转移表（AC-02）
`AISystem` 在**通过门控之后**（§4.6）按当前 `state` 分派。`dist` = 到目标的距离；
`target` = §4.5 解析出的目标（可能为 `null`）。

| 当前态 | 条件 | 动作 | 下一态 |
|---|---|---|---|
| `IDLE` | `target === null` | 无 | `IDLE` |
| `IDLE` | `dist ≤ attackRadius` | 起前摇（定身 + 锁定朝向） | **`WINDUP`** |
| `IDLE` | `dist ≤ sightRadius` | 无（**发现拍**：`IDLE` 不移动，§4.3） | **`CHASING`** |
| `IDLE` | 其它（超出视野） | 无 | `IDLE` |
| `CHASING` | `target === null` | 无 | `IDLE` |
| `CHASING` | `dist ≤ attackRadius` | 起前摇 | **`WINDUP`** |
| `CHASING` | `dist ≤ sightRadius` | `moveVector = normalize(target − self)` | `CHASING` |
| `CHASING` | 其它（跟丢） | 无 | **`IDLE`** |
| `WINDUP` | —（无条件） | `aimRadians = lockedFacing`；`ticksRemaining -= 1` | `WINDUP` |
| `WINDUP` | `ticksRemaining` 归零 | **`wantsToAttack = true`**；`ticksRemaining = cooldownTicks` | **`COOLDOWN`** |
| `COOLDOWN` | `ticksRemaining > 1` | `ticksRemaining -= 1` | `COOLDOWN` |
| `COOLDOWN` | `ticksRemaining` 归零 | `ticksRemaining = 0` | **`CHASING`**（`target` 在视野内）/ **`IDLE`** |

**起前摇（`enterWindup`）的三个动作，缺一不可**：
1. `state = WINDUP`；`ticksRemaining = windupTicks`；
2. `lockedFacingRadians = atan2(target.y − self.y, target.x − self.x)`（**目标当时**的坐标）；
3. 本拍不进入 `WINDUP` 分支 ⇒ `ticksRemaining` 在**进入拍不被递减**，前摇恰为 `windupTicks` 拍。

> **`AIState` 与 `ActionState` 正交**：前摇期间敌人的 `ActionState` 仍是 `IDLE`（它没在动，也没在挥砍）。
> 两者回答的是不同问题——`AIState` 说「我打算干什么」，`ActionState` 说「我身体现在在做什么」。
> 前摇结束的那一拍，`ActionState` 仍是 `IDLE`，因此 `CombatActionSystem` 的出手门（非 `DASHING` /
> `ATTACKING` / `HITSTUN`）必然放行。

### 4.3 追击逻辑（AC-03）
- 触发条件：`attackRadius < dist ≤ sightRadius`。
- 输出：`intent.moveVector = normalizeVec2(target.position − self.position)`，即**归一化**向量（模长 1）。
- 目标位置**每拍重新读取**，因此玩家移动时追击方向**逐拍更新**（玩家绕圈，敌人绕圈）。
- 目标与自身坐标重合时 `normalizeVec2` 返回 `(0,0)`（既有工具函数的定义），敌人原地待机一拍，不产生 `NaN`。
- 敌人**不预测**玩家走位（无 leading），也**不避障**（§1.3）。
- **「发现」拍不移动**：自 `IDLE` 进入 `CHASING` 的那一拍**不输出移动向量**——`IDLE` 是待机态
  （`moveVector ≡ (0,0)`），追击从**下一拍**开始。这一拍是敌人的「反应延迟」，也是 `IDLE` 与 `CHASING`
  在行为上真正不同之处：若让 `IDLE` 也在发现拍追击，两个状态的行为将完全重合，`IDLE` 就退化成 `CHASING` 的别名。
  ⇒ **AC-03 的判据是「`CHASING` 状态下输出归一化向量」**；发现拍仍属 `IDLE` 的行为。
- **注意与攻击分支的区别**：`IDLE` 的 `dist ≤ attackRadius` 分支**没有**反应延迟——进入攻击距离即起前摇。
  两个分支的差异是刻意的：待机 → 追击是「注意到你」，待机 → 前摇是「你已经贴脸了」。

### 4.4 前摇预警与朝向锁定（AC-04）
- 进入条件：`dist ≤ attackRadius`（自 `IDLE` 或 `CHASING`）。
- 前摇期间：
  - `intent.moveVector ≡ (0,0)` ⇒ **定身**（`MovementSystem` 不动它）；
  - `intent.aimRadians = lockedFacingRadians` ⇒ `MovementSystem` 每拍把 `facingRadians` 写回锁定值 ⇒ **朝向锁定**；
  - `ticksRemaining` 逐拍递减。
- **锁定的是「进入前摇那一拍目标的坐标」**，不是「出手那一拍目标的位置」：玩家在前摇期间横向移动，
  敌人**不会**跟着转——这正是「预警可被走位躲开」的机制来源，也是 AC-04 的判据。
- **为什么锁定的是坐标而非实体**：锁定实体需要每拍重算朝向，那就不是预警而是跟踪了；
  锁定坐标让「预警」成为玩家可以反应的**确定性窗口**。

### 4.5 目标解析与自动索敌
`AISystem` 每拍解析一次目标：

```
target = (targetEntityId 非 null 且 存活) ? targetEntityId : 自动索敌()
```

- **自动索敌**：遍历 `world.query(TransformComponent, FactionComponent, HealthComponent)`（id 升序），
  跳过自己、跳过非敌对（`areHostile` 为假）、跳过已死（`isAlive` 为假），取**距离平方最小**者；
  等距时保留**先遇到的（较小 id）**。结果写回 `ai.targetEntityId`（**粘性**：锁定后不再改，除非目标失效）。
- **确定性**：`query` 升序 + 严格 `<` 比较 ⇒ 等距取较小 id，跨机器一致（C2）。
- **无目标**：没有任何敌对实体时返回 `null` ⇒ FSM 停在 `IDLE`。

### 4.6 冻结与硬直门控（战斗反馈必须影响 AI）
`AISystem` 每拍对每个 AI 实体按以下顺序门控：

| # | 条件 | 行为 | 理由 |
|---|---|---|---|
| 0 | 实体被**顿帧**（`isFrozen`） | **整段跳过**：不写意图、不推进 FSM、不重置状态 | 「顿帧暂停动作」必须对 AI 同样成立；此时 `FreezeSystem`（紧邻其前）已把意图归零，AI 不覆盖它 |
| 1 | `ActionState === HITSTUN` | `state = IDLE`；`ticksRemaining = 0`；写零意图；跳过 | **硬直打断**：前摇 / 冷却计划作废，恢复后**重新评估**（AC-05 派发要求） |
| 2 | 其它 | 正常 FSM（§4.2） | — |

- **顿帧 = 暂停（不吞帧）**：`ticksRemaining` 原地冻结，恢复后从原值继续 ⇒ 一次 4 拍顿帧让前摇**整体后移 4 拍**，
  而不是把前摇缩短 4 拍。
- **硬直 = 打断（作废）**：被打断的前摇**不会**在硬直结束后补触发。恢复后 FSM 从 `IDLE` 重新决策，
  若目标仍在攻击距离内则起**一次全新的** `windupTicks` 前摇。
- **门控顺序不可交换**：顿帧判定必须在硬直判定**之前**。顿帧期间 `ActionState` 可能已经写着 `HITSTUN`
  （同一次命中同时写入两者），若先判硬直，顿帧窗口内就会把 FSM 重置掉——「暂停」被降级成「打断」，
  §6.3 的「顿帧不吞帧」断言当场失败。

### 4.7 攻击与冷却（AC-05）
- **出手**：`WINDUP` 的 `ticksRemaining` 归零的那一拍，写 `wantsToAttack = true`（**单 Tick 脉冲**），
  同拍 `CombatActionSystem` 读后置 `false` 并生成判定圆——与玩家攻击走的是**同一条**出手管道。
- **冷却**：出手同拍进入 `COOLDOWN`，`ticksRemaining = cooldownTicks`。
- **冷却结束**：`ticksRemaining` 归零 ⇒ `CHASING`（目标在视野内）/ `IDLE`（目标丢失）。
  **冷却结束拍不直接进 `WINDUP`**——先回到决策态，下一拍由 §4.2 决定是否再起前摇。
- **出手周期** = `windupTicks + cooldownTicks + 1`（`+1` 即「冷却结束先切 `CHASING`、下一拍才决策」）。

---

## 5. 系统契约与管道顺序

### 5.1 各系统职责（M4-T01 变更点）
| 系统 | 变更 |
|---|---|
| `AISystem`（新） | 每拍遍历 `AIControllerComponent` 实体：门控（顿帧 / 硬直）→ 解析目标 → FSM 分派 → 写 `IntentComponent`。**不持任何字段**。 |
| `MovementSystem` | **静止**分支新增：`aimRadians !== null` 时写 `facingRadians`。移动 / 冲刺 / 硬直三条分支**一字不改**。 |
| `World.listComponents` | `localeCompare` → UTF-16 码元比较（ADR-001 R6）。 |
| `pipeline.ts` | 在 `FreezeSystem` 与 `MovementSystem` 之间插入 `AISystem`（11 段）。 |
| `spawn-helpers.ts` | 新增 `AITuningOptions` / `ResolvedAITuning` / `resolveAITuning`；`spawnCombatant` 按需挂 `AIControllerComponent`。 |
| `IntentComponent` | 新增字段 `aimRadians`（默认 `null`）。 |
| 其余系统 | **不变**。 |

### 5.2 规范管道（硬契约，M4-T01 扩展）
```
PlayerControllerSystem -> FreezeSystem -> AISystem -> MovementSystem -> DashSystem -> StateSystem
  -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem -> ModifierSystem -> LifespanSystem
```

**扩展规则（不得违反）**：
1. **M1/M2 六段相对顺序一字不改**（`MovementSystem .. LifespanSystem`），`LifespanSystem` 仍是**最后一段**。
2. `AISystem` **必须**排在 `FreezeSystem` **之后**。这是**相位契约**，不是风格问题：
   `FreezeSystem` 每拍先递减 `remainingTicks`，其后的所有系统（`Movement` / `Dash` / `State` / `CombatAction`）
   都按**递减后**的值判断「本拍是否被冻结」。`AISystem` 必须看到**同一个判据**，否则会出现「实体本拍已解冻、
   AI 却还在暂停」的一拍错位（顿帧恢复拍白丢一拍）。若把 `AISystem` 放到 `FreezeSystem` **之前**，
   它读到的是**递减前**的值，恢复拍必然与运动系统错开一拍（见 §10 取舍 1）。
3. `AISystem` **必须**排在所有**推进型**系统（`Movement` 及其后）**之前**：它是意图**生产者**，
   消费者必须在本拍读到已经写好的意图（与 `PlayerControllerSystem` 同样的职责）。
4. `AISystem` **不得**排在 `LifespanSystem` 之后或与任何系统互换；它只做插入，不改既有相对顺序（C7）。

### 5.3 `AISystem` 的无状态契约
- `AISystem` 除 `readonly name = 'AISystem'` 外**零字段**（C5）。所有 FSM 状态落在 `AIControllerComponent` 上。
- 对**空查询**（世界里没有 AI 实体）严格无操作：不构造任何临时对象、不产生任何副作用（C9）。

---

## 6. 时序硬契约（逐 Tick，QA 将逐 Tick 断言）

> **Tick 编号约定**：本节所有 Tick 编号都是**被处理的 Tick 序号**（`SystemContext.tick`）。
> `sim.step(n)` 处理 Tick `0 .. n-1`，处理完第 `p` 拍后 `sim.tick === p + 1`。
> 写断言前必须先把「step 几次 = 处理到哪一拍」算清（spec 06 §6 的同一陷阱）。

### 6.1 基准场景 · 纯 FSM 时序（无命中）
`fps = 60`；敌人 `(0, 0)`，AI：`sightRadius = 8`、`attackRadius = 3.0`、`windupTicks = 30`、`cooldownTicks = 60`，
`targetEntityId` = 玩家；玩家 `(2.5, 0)` **静止**。

**为什么这个场景没有命中**：近战判定圆中心在攻击者前方 `0.75`、半径 `1.0`，受击圆半径 `0.5`，
故有效射程 `0.75 + 1.0 + 0.5 = 2.25 < 2.5` ⇒ 敌人的每一刀都**落空**。因此整段脚本**零顿帧、零硬直**，
观测到的就是**纯粹的 FSM 时序**。

| 处理 Tick `p` | `state` | `ticksRemaining` | `IntentComponent` | 说明 |
|---|---|---|---|---|
| **0** | `IDLE` → **`WINDUP`** | `30` | `moveVector (0,0)`，`aimRadians 0` | `dist 2.5 ≤ 3.0` ⇒ 起前摇；`lockedFacing = atan2(0, 2.5) = 0` |
| 1 | `WINDUP` | `29` | 同上 | 逐拍递减 |
| … | `WINDUP` | … | 同上 | |
| 29 | `WINDUP` | `1` | 同上 | **前摇最后一拍** |
| **30** | **`COOLDOWN`** | `60` | `wantsToAttack = true`（本拍脉冲） | 前摇归零 ⇒ 出手；同拍生成判定圆（落空） |
| 31 | `COOLDOWN` | `59` | `(0,0)` / `null` / `false` | |
| … | `COOLDOWN` | … | | |
| 89 | `COOLDOWN` | `1` | | |
| **90** | **`CHASING`** | `0` | | 冷却归零 ⇒ `dist 2.5 ≤ 8` ⇒ 切回 `CHASING` |
| **91** | **`WINDUP`** | `30` | `aimRadians 0` | 决策拍：`dist 2.5 ≤ 3.0` ⇒ 第 2 次前摇 |
| … | `WINDUP` | … | | |
| **121** | **`COOLDOWN`** | `60` | `wantsToAttack = true` | 第 2 次出手 |

**由该表派生的可断言事实（MUST）**：
1. **`WINDUP` 观测集恰为 Tick `0 .. 29`**（`windupTicks = 30` 拍）；`ticksRemaining` 在 Tick `0` 为 `30`、
   在 Tick `29` 为 `1`——**进入拍不递减**，前摇不会被多算或少算一拍。
2. `wantsToAttack` 在 Tick `29` 为 `false`、在 Tick `30` 为 `true`（**只在归零那拍为真**）。
3. 前摇期间 `moveVector ≡ (0,0)`，且 `TransformComponent` 的 `x` / `y` **逐拍不变**（定身）。
4. `aimRadians` 在 Tick `0 .. 29` 恒为 `0`；玩家在 Tick `10` 被移到 `(0, 2.5)` 后仍为 `0`（**朝向锁定**）。
5. 出手周期 = `30 + 60 + 1 = 91` 拍：Tick `30` 与 Tick `121` 各一次。
6. Tick `30` 的判定圆 `ownerEntityId` = 敌人，其中心为 `(0.75, 0)`（沿锁定朝向 `0` 前方偏移），
   且在 Tick `31` **仍然存在**（寿命 `15` 拍）。

### 6.2 硬直打断（AC-05 派发要求）
敌人 `(1.0, 0)`，AI：`sightRadius = 10`、`attackRadius = 4.0`、`windupTicks = 30`、`cooldownTicks = 60`；
玩家 `(0, 0)`、`facingRadians = 0`，在**处理 Tick `5`** 注入 `keyDown('attack')`。

几何：玩家判定圆中心 `(0.75, 0)`、半径 `1.0`；敌人 `(1.0, 0)`、受击圆 `0.5` ⇒ 距离 `0.25 < 1.5` ⇒ **命中**。

| 处理 Tick `p` | 事件 | 敌人 `ActionState` | 敌人 `AIState` | `ticksRemaining` |
|---|---|---|---|---|
| 0 | `dist 1.0 ≤ 4.0` ⇒ 起前摇 | `IDLE` | **`WINDUP`** | `30` |
| 1..5 | 逐拍递减（Tick 5 玩家出手并命中） | `IDLE` → **`HITSTUN`**（Tick 5 末） | `WINDUP` | `25` |
| 6..9 | **顿帧窗口**（`hitstopTicks = 4`） | `HITSTUN` | `WINDUP`（**暂停，不重置**） | **`25` 恒定** |
| **10** | 解冻拍 ⇒ 门控 #1 命中 | `HITSTUN` | **`IDLE`**（**打断**，计划作废） | `0` |
| 10..17 | 硬直 + 击退（`HITSTUN` 观测集 `5..16`，退场于 Tick `17`；击退位移发生在 Tick `10..17`，`8 × 0.2 = 1.6` ⇒ 敌人停在 `x = 2.6`） | `HITSTUN` | `IDLE` | `0` |
| **18** | 硬直结束后的**决策拍** | `IDLE` | **`WINDUP`**（全新前摇） | `30` |
| … | 前摇 | `IDLE` | `WINDUP` | 递减 |
| **48** | 前摇归零 ⇒ **第一次真正出手** | `ATTACKING` | `COOLDOWN` | `60` |

**由该表派生的可断言事实（MUST）**：
1. **前摇被打断**：`AIState` 观测序列在 Tick `0..9` 为 `WINDUP`，在 Tick `10..17` 为 `IDLE`，在 Tick `18` 起回到 `WINDUP`。
2. **顿帧不吞帧**：Tick `6..9` 的 `ticksRemaining` 恒为 `25`（与 Tick `5` 结束时相同）——
   顿帧**暂停** FSM，而不是把它清零或让它继续跑。
3. **硬直作废计划**：Tick `30`（原定出手拍）世界里**没有**敌人的判定圆；敌人第一次出手发生在 Tick `48`。
4. **恢复后重新评估**：Tick `18` 的 `WINDUP` 是**全新**的一次（`ticksRemaining` 从 `30` 重新开始），
   不是「续上被打断的那一次」（被打断时只剩 `25` 拍）。

### 6.3 顿帧暂停（含真实命中，全管道驱动）
敌人 `(0, 0)`、玩家 `(1.5, 0)`，AI：`sightRadius = 8`、`attackRadius = 3.0`、`windupTicks = 30`、`cooldownTicks = 60`。

本次敌人的攻击**命中**玩家（判定圆 `(0.75, 0)` 与受击圆 `(1.5, 0)` 距离 `0.75 < 1.5`），
于是 `CollisionSystem` 在 Tick `30` 同时冻结**攻守双方**——**敌人自己被顿帧，但不会进入 `HITSTUN`**
（`HITSTUN` 只写给受击者）。这正是「纯顿帧」的管道级来源。

| 处理 Tick `p` | 敌人是否被冻结 | 敌人 `AIState` | `ticksRemaining` |
|---|---|---|---|
| 30 | 否（本拍末才被冻结） | `COOLDOWN`（出手同拍） | `60` |
| 31..34 | **是**（`hitstopTicks = 4`） | `COOLDOWN`（暂停） | **`60` 恒定** |
| 35 | 否（解冻拍） | `COOLDOWN` | `59` |
| … | 否 | `COOLDOWN` | 逐拍递减 |
| **94** | 否 | `CHASING` / `IDLE` | `0` |

**可断言事实**：冷却从 Tick `30` 起算，但被顿帧**整体后移 4 拍**（`90 → 94`）；
Tick `31..34` 的 `ticksRemaining` 恒为 `60`——**前摇 / 冷却都不会被顿帧吞掉**。

### 6.4 发现拍与脱战分支
**发现拍**（`IDLE` → `CHASING`）：目标在 Tick `p` 进入视野时，Tick `p` 的 `state` 变为 `CHASING`，
但 `moveVector` 仍为 `(0,0)`（§4.3）；自 Tick `p+1` 起才输出归一化追击向量。

**脱战**：目标在 `CHASING` 期间移出视野（`dist > sightRadius`）⇒ 下一拍 `IDLE`
（`ticksRemaining = 0`，`moveVector = (0,0)`）。`COOLDOWN` 期间目标移出视野不影响冷却计时；
冷却结束拍按**当时**距离决定 `CHASING` 还是 `IDLE`（§4.7）。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 验收项 | 判据 | 优先级 |
|---|---|---|---|
| **AC-01** | 意图复用 | 敌方实体通过 `AIControllerComponent` + `IntentComponent` 参与逻辑；`AISystem` 的输出**只有** `IntentComponent`（`moveVector` / `wantsToAttack` / `aimRadians`）；位移与出手由 `MovementSystem` / `CombatActionSystem` 执行；手写意图对 AI 实体无效 | 必达（派发要求） |
| **AC-02** | 有限状态机 | `AIState` 至少含 `IDLE` / `CHASING` / `WINDUP` / `COOLDOWN` 四态；转移严格遵循 §4.2 转移表；`ticksRemaining` 落在组件上 | 必达（派发要求） |
| **AC-03** | 追击逻辑 | `attackRadius < dist ≤ sightRadius` 时输出**归一化**移动向量指向目标坐标，且随目标移动**逐拍更新** | 必达（派发要求） |
| **AC-04** | 前摇预警 | 到达攻击距离后 `moveVector ≡ (0,0)`（定身）并进入 `WINDUP`；前摇恰 `windupTicks` 拍；`lockedFacingRadians` 取**进入拍**目标坐标且此后不再更新（目标移动不改变朝向） | 必达（派发要求） |
| **AC-05** | 攻击与冷却 | 前摇归零那拍写 `wantsToAttack = true`（单 Tick 脉冲），同拍生成判定圆；随后进入 `COOLDOWN`（`cooldownTicks` 拍）；冷却结束切回 `IDLE` 或 `CHASING` | 必达（派发要求） |
| **AC-06** | 冻结 / 硬直门控 | 顿帧**暂停** FSM（`ticksRemaining` 原地冻结，恢复后整体后移）；`HITSTUN` **打断** FSM（重置 `IDLE`，恢复后重新评估，被作废的前摇不补触发） | 必达（战斗反馈必须影响 AI） |
| **AC-07** | 管道顺序硬契约 | `createDefaultSystems()` 顺序 = `… PlayerController, Freeze, AISystem, Movement, … Lifespan`（11 段）；`AISystem` 在 `FreezeSystem` 之后、`MovementSystem` 之前；M1/M2 六段相对顺序不变，`LifespanSystem` 仍最后 | 保障门 |
| **AC-08** | 既有行为零回归 | 不挂 `AIControllerComponent` 的实体（M1–M3 的全部玩家 / 敌人）行为逐 Tick 逐位不变；M1–M3 的 165 用例全绿；`AISystem` 对空查询严格无操作 | 保障门 |
| **AC-09** | 确定性回放 | 含「玩家走位 + 敌人追击 + 前摇 + 出手 + 命中 + 硬直打断」的完整脚本，在两个独立 `GameSimulator` 上逐 Tick `snapshot()` `toEqual` 一致 | 保障门 |
| **AC-10** | 类型安全 / 纯逻辑 / 无环境依赖比较 | `npm run typecheck` 零错误；无 `any` / 非空断言 / `@ts-ignore`；`npm run lint` 0 error 0 warning；`src/` 内无 DOM / 墙钟 / 随机，且 **AST 门**拦住 `localeCompare` / `toLocale*` / `Intl`（ADR-001 R6） | 保障门 |

> **AC-01 … AC-05 为任务派发明确要求**；**AC-06 … AC-10 为保障前五条可信而设的补充门**。
> AC-01 … AC-07 与 AC-09 由 `tests/ai/enemy_fsm.test.ts` 断言；
> AC-08 由既有 `tests/combat/*` 与 `tests/harness/*`（165 用例）断言；AC-10 由 `npm run lint` + `npm run typecheck` 覆盖。

---

## 8. 失败模式（Failure Modes）

| 模式 | 后果 | 缓解 |
|---|---|---|
| `AISystem` 排在 `FreezeSystem` **之前** | 它读到的是**递减前**的 `remainingTicks`，顿帧**恢复拍**被误判为「仍冻结」⇒ AI 比运动系统晚一拍恢复，白丢一拍 | §5.2 规则 2；G6 断言「恢复拍即刻推进」 |
| 顿帧判定与硬直判定**顺序颠倒** | 顿帧窗口内（`ActionState` 已是 `HITSTUN`）直接把 FSM 重置 ⇒ 「暂停」降级为「打断」，前摇被吞 | §4.6 门控顺序不可交换；§6.2 断言 Tick `6..9` 仍为 `WINDUP` |
| 硬直时**只暂停不重置** | 前摇在硬直结束后「续上」并补触发一次攻击 ⇒ 玩家明明打断了却还是被打 | §4.6：硬直 = **打断**（重置 `IDLE`）；§6.2 断言 Tick `30` 无判定圆、首次出手在 Tick `48` |
| 顿帧时**重置** `ticksRemaining` | 顿帧变成「白送一次前摇重置」或「白吞几拍」，预警时长随命中次数漂移 | §4.6：顿帧 = **暂停**（不重置）；§6.3 断言 `ticksRemaining` 恒定 |
| 进入前摇的那一拍**也递减** `ticksRemaining` | 前摇实际只有 `windupTicks − 1` 拍，预警比配置短一拍 | §4.2 起前摇的 3 个动作 + `break`；§6.1 断言 Tick `0` 为 `30`、Tick `29` 为 `1` |
| 前摇期间**每拍重算**朝向 | 预警变成跟踪，玩家无法用走位躲开；AC-04 的「锁定」语义丢失 | §4.4：只在进入拍写 `lockedFacingRadians`；§6.1 断言移动目标后朝向不变 |
| `AISystem` 直接写 `TransformComponent.facingRadians` | 出现**两个** `facingRadians` 写入者（与 `MovementSystem` 冲突），且违反 AC-01「输出只有意图」 | §3.3：走 `IntentComponent.aimRadians`，由 `MovementSystem` 落地 |
| `AISystem` 写 `wantsToDash` | 敌人出现未定义行为（会冲刺），且与本 Spec 的 FSM 无关 | §4.1：AI 不写 `wantsToDash` |
| 未命中 `wantsToAttack` 脉冲被**缓冲** | 若 AI 在不可出手的状态（`DASHING`/`ATTACKING`/`HITSTUN`）置脉冲，`CombatActionSystem` 会读后置 `false` 丢弃 ⇒ 前摇白跑 | §4.6：硬直期间不写脉冲；`CombatActionSystem` 的「先消费后门控」语义保持 |
| 冷却结束**直接进 `WINDUP`** | 与 AC-05「切回 `IDLE` 或 `CHASING`」不符；出手周期少一拍 | §4.7：冷却结束只回决策态；§6.1 断言 Tick `90` 为 `CHASING` |
| 敌人**默认**挂 `AIControllerComponent` | M1–M3 的 165 个用例用手写意图驱动敌人，AI 会当场把意图覆写 ⇒ 大面积回归 | C10 / §3.5：AI 是**可选能力**，必须显式传 `ai` |
| `ai` 与 `hardwareInput` 同时给出 | 玩家被 AI 覆写意图，硬件输入静默失效 | §3.5：抛 `RangeError` |
| `attackRadius > sightRadius` | 「视野外仍能出手」的配置 bug，行为违反直觉 | §3.5：`resolveAITuning` 抛 `RangeError` |
| 自动索敌用**非升序**遍历或 `<=` 比较 | 等距目标的选取依赖遍历顺序 ⇒ 跨机器快照不一致 | §4.5：`query` 升序 + 严格 `<` |
| `ticksRemaining` 放在**系统字段**上 | 跨 Tick 隐藏状态；两个实体互相污染；回放失败 | C5：全部状态落在组件上 |
| 用 `localeCompare` 排序（组件名 / 状态 id / 修饰器 id） | 排序结果依赖 ICU / 语言环境，跨机器快照不一致 | ADR-001 **R6**：一律 UTF-16 码元序 |
| `AISystem` 在冻结时**覆盖** `FreezeSystem` 清空的意图 | 冻结实体恢复时会带着「冻结期间攒下的意图」行动（缓冲输入） | §4.6 门控 #0：冻结时**整段跳过**，不写意图 |

---

## 9. 追溯（Traceability）

- **本 Spec → 测试**（`tests/ai/enemy_fsm.test.ts`）：
  - `G0` 组件与调参契约：`AIState` 四态、`resolveAITuning` 默认值与校验（非正数 / `attackRadius > sightRadius` 抛错）、
    可选挂载（不传 `ai` 则不挂）、`ai` + `hardwareInput` 互斥（AC-02 / AC-08）
  - `G1` 意图复用与独占：AI 覆写手写意图、非 AI 敌人意图不被触碰、玩家不受影响（AC-01）
  - `G2` FSM 状态流转：视野外 `IDLE`、视野内 `CHASING`、攻击距离内 `WINDUP`、出手后 `COOLDOWN`、
    冷却结束回 `CHASING` / `IDLE`、脱战回 `IDLE`（AC-02 / AC-05）
  - `G3` 纯追击：归一化向量指向目标，且随目标移动逐拍更新（AC-03）
  - `G4` 完整攻击循环时序：进入距离即 `moveVector` 归零、前摇恰 `windupTicks` 拍、归零拍脉冲为 `true`、
    同拍生成判定圆（下一拍仍在）、`aimRadians` 锁定不被目标移动改变（AC-04 / AC-05）
  - `G5` 硬直打断：前摇期间被打 ⇒ 顿帧窗口内 FSM 暂停（不吞帧）⇒ 解冻后打断（计划作废）⇒
    硬直结束重新评估 ⇒ 首次出手推迟到「重评估 + `windupTicks`」拍（AC-06）
  - `G6` 顿帧暂停（真实命中）：冷却被自身命中顿帧整体后移 `hitstopTicks` 拍（AC-06）
  - `G7` 管道顺序 11 段 + `AISystem` 位置约束（AC-07）
  - `G8` 确定性回放：完整脚本在两个 `GameSimulator` 上逐 Tick 一致（AC-09）
- **本 Spec → 实现**：
  - 组件（新增）：`src/ecs/components/AIControllerComponent.ts`
  - 组件（扩展）：`src/ecs/components/IntentComponent.ts`（`aimRadians`）、`components/index.ts`
  - 系统（新增）：`src/ecs/systems/AISystem.ts`；`systems/index.ts`；`pipeline.ts`（11 段）
  - 系统（扩展）：`src/ecs/systems/MovementSystem.ts`（静止分支消费 `aimRadians`）
  - 确定性（修复）：`src/ecs/World.ts`（`compareComponentTypeName`）；`eslint.config.mjs`（R6 的 AST 门）
  - 预制体：`src/ecs/prefabs/spawn-helpers.ts`（`resolveAITuning` + 按需挂载）、`EnemyFactory.ts`
  - 测试同步：`tests/combat/{feedback,boons,status_effects}.test.ts` 的管道顺序断言由 10 段扩为 11 段
- **对既有 Spec 的扩展登记**：
  - **`specs/04_combat_feedback_spec.md` §3.1** 的 `IntentComponent` 字段表由本 Spec §3.3 **扩展**一个
    `aimRadians`（默认 `null`）。该字段是**纯增量**：既有实体恒为 `null`，`MovementSystem` 的既有分支
    行为**逐位不变**（AC-08 以全量回归证明）。
  - **`specs/04 §5.2`** 的 10 段绝对顺序由本 Spec §5.2 **扩展**为 11 段；
    **六段相对顺序、`StatusEffectSystem` / `ModifierSystem` 的位置约束与 `LifespanSystem` 末位全部不变**（C7）。
  - **`specs/02 §5` / `specs/03 §5`** 的 `MovementSystem` 契约不变：本 Spec 只在**静止**分支增加朝向意图的落地。
  - **`docs/architecture/ADR-001`** 追加 **R6**（禁止环境依赖的比较 API），并修正 `World.listComponents`
    的 `localeCompare`（技术债，与本里程碑的功能改动相互独立）。
- 变更本 Spec 须同步更新测试与实现。

---

## 10. 已知取舍（Known Trade-offs）

1. **`AISystem` 排在 `FreezeSystem` 之后（而非「极前端」的第一段）**：任务书要求「位于管道的极前端」。
   它确实位于**意图生成段**（仍在所有推进型系统之前），但选择紧跟 `FreezeSystem` 而非最前，
   是因为**冻结判据的相位**：`FreezeSystem` 每拍先递减、其后的所有系统按递减后的值判断本拍是否冻结。
   `AISystem` 若排在它之前，读到的就是递减前的值，于是顿帧**恢复拍**会出现「运动系统已经恢复、AI 还在暂停」
   的一拍错位（敌人比玩家晚一拍响应）。代价是本段与 `PlayerControllerSystem` 不再对称；收益是
   顿帧语义在整条管道上**只有一种解释**。若未来需要「极前端」的对称性，正确做法是给
   `SystemContext` 注入一个统一的 `isFrozenThisTick` 判据，而不是让 `AISystem` 去猜递减时机。
2. **朝向意图走 `IntentComponent.aimRadians`，而不是让 AI 直接写 `TransformComponent`**：
   直接写更省事，但会产生两个 `facingRadians` 写入者，并违反 AC-01「AI 的输出仅仅是修改 `IntentComponent`」。
   走意图层的代价是 `IntentComponent` 多一个字段（快照形状变化）与 `MovementSystem` 静止分支多两行；
   收益是「朝向只有一个写入者」这条不变量保持成立，且 AI 与玩法的解耦不被削掉一个口子。
3. **`windupTicks` / `cooldownTicks` 放在组件上（而非模块常量）**：与 `StateComponent` 的
   `DEFAULT_ATTACK_DURATION_TICKS`（模块常量）路线不同，这里选择组件字段，因为「不同敌人有不同预警长度」
   是设计上的必然需求，而攻击承诺窗口在本里程碑只有一种。代价是每个敌人多两个字段；收益是调参不需要改代码。
4. **硬直「打断」而非「暂停」前摇**：另一种做法是像顿帧一样只暂停，恢复后把剩下的 `windupTicks` 跑完。
   那会让「打断」名不副实——玩家打中了却还是被砍。本里程碑选择**作废计划 + 重新评估**，
   并把「顿帧暂停 / 硬直打断」这一对差异写成 §6.2 / §6.3 的可断言事实。
5. **AI 挂载是可选能力，`EnemyFactory` 默认不挂**：默认挂载会让 M1–M3 里所有「手写敌人意图」的用例当场失效
   （AI 每拍覆写意图）。代价是「新敌人默认没有 AI」，需要显式传 `ai`；收益是零回归且能力边界显式
   （与 `ModifierComponent` / `StatusEffectComponent` 的「标配空组件」路线不同，那两个是**数据容器**，
   不挂也不会有人写它；AI 是**主动覆写者**，默认挂载就是行为变更）。
6. **AI 不写 `wantsToDash`**：敌人不会冲刺。这让 AI 的意图面收窄到 `moveVector` + `wantsToAttack` + `aimRadians`，
   便于断言；代价是敌人无法用冲刺规避，也没有「AI 冲刺突进」这种压迫感。属后续里程碑。
7. **自动索敌是「最近敌对实体」而非仇恨表**：实现简单、确定性强（升序 + 严格 `<`）。
   代价是无法表达「优先打治疗者」「被打才仇恨」这类策略，且目标**粘性**（锁定后不换），
   多敌人时可能全部扑向同一个最近目标。
8. **追击是直线归一化向量，无寻路**：本里程碑无地形，直线追击在语义上就是完整解；
   一旦引入墙体 / 障碍，`moveVector` 就需要换成「下一个路径点方向」，`AISystem` 的其余部分不受影响——
   这正是「AI 只产生意图」带来的可替换性。
9. **`AISystem` 每拍全量重算目标与距离**：不做缓存。战斗单位是数十级、AI 是 O(实体数²) 的最坏情形，
   但本里程碑的实体规模下代价可忽略；缓存带来的跨 Tick 状态风险（C5）远大于收益。
10. **`aimRadians` 只在静止时生效**：移动实体的朝向仍由移动方向决定（M1 契约不变）。
    代价是「边跑边瞄」不支持；收益是 `facingRadians` 的语义保持单一，且 M1–M3 行为零回归。

---

## 11. 修订记录（Revision History）

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| rev.1 | 2026-09-28 | 程基岩 | 初版（M4-T01）：`AIControllerComponent` / `AIState`、`AISystem`（意图生成段第 3 段）、`IntentComponent.aimRadians` 朝向意图、`MovementSystem` 静止分支消费、`resolveAITuning` 与可选挂载、管道扩为 11 段；ADR-001 追加 R6（禁止环境依赖比较）并修复 `World.listComponents` 的 `localeCompare`；AC-01…AC-10 |
