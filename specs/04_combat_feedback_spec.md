# 04 · Combat Feedback Spec（意图解耦、顿帧与受击反馈）

| Field | Value |
|---|---|
| Spec ID | `SPEC-04-COMBAT-FEEDBACK` |
| Milestone | **M2 · 基础战斗**（T02） |
| Status | `accepted`（本文件为 M2-T02 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/{IntentComponent,PlayerInputComponent,FreezeComponent,KnockbackComponent,HitboxComponent,StateComponent}.ts`、`src/ecs/systems/{PlayerControllerSystem,FreezeSystem,MovementSystem,DashSystem,StateSystem,CombatActionSystem,CollisionSystem,pipeline}.ts`、`src/ecs/prefabs/{spawn-helpers,PlayerFactory,EnemyFactory}.ts`、`eslint.config.mjs`、`package.json`、`.github/workflows/ci.yml`、`tests/combat/` |
| Depends on | `specs/00_harness_spec.md`（时钟/输入/ECS/Snapshot 契约）、`specs/01_character_controller_spec.md`、`specs/02_dash_and_state_spec.md`（动作状态机 / 无敌标签）、`specs/03_combat_hitbox_spec.md`（判定圆 / 圆碰撞 / 无敌帧消费） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的
在 M2-T01 的**战斗判定圆**之上，落地两项能力：
1. **意图解耦（Intent Decoupling）**：把"硬件输入"与"逻辑意图"拆成两层。所有玩法系统只读**意图**
   （`IntentComponent`），硬件快照（`PlayerInputComponent`）只属于玩家。这根治了 spec 03 §10 取舍 4
   的局限——"单一全局输入帧驱动所有持 `InputComponent` 的实体"，使敌人可以**不持有任何输入设备**
   而被 AI / 脚本驱动，也消除了测试中的交叉响应。
2. **受击反馈（Hit Feedback）**：命中时给**攻守双方**施加**顿帧（Hitstop）**，给**受击者**施加
   **受击硬直（HITSTUN）**与**强制击退（Knockback）**。

本 Spec 同时冻结 M2-T02 的一项技术债修复：把 CI 的 `grep` 纯逻辑门替换为 **ESLint AST 门**。

### 1.2 In Scope（做什么）
- 组件：`IntentComponent`（新）、`FreezeComponent`（新）、`KnockbackComponent`（新）。
- 更名：`InputComponent` → `PlayerInputComponent`（类名与文件同步；字段不变）。
- `StateComponent` 扩展：新增 `ActionState.HITSTUN` 与 `DEFAULT_HITSTUN_TICKS`。
- `HitboxComponent` 扩展：新增 `ownerEntityId` / `hitstopTicks` / `knockbackForce` 与两常量。
- 系统：`PlayerControllerSystem`（新，硬件→意图）、`FreezeSystem`（新，顿帧倒计时）。
- 系统重构：`MovementSystem` / `DashSystem` / `StateSystem` / `CombatActionSystem` 改为**只读意图**；
  `CollisionSystem` 增加**命中反馈写入**；`pipeline.ts` 首段扩展。
- 预制体：`spawnCombatant` 增加 `hardwareInput` 形参；敌人改为**意图驱动**。
- 技术债：CI 纯逻辑门由 `grep` 正则改为 ESLint AST 规则（`eslint.config.mjs`）。

### 1.3 Out of Scope（显式排除）
- ❌ 死亡 / 销毁实体 / 掉落 / 战利品（M3+）。
- ❌ 多段攻击、连招、攻击取消、冲刺攻击、技能位移。
- ❌ 受击音效 / 屏幕震动 / 命中特效等表现层（渲染层职责，逻辑核不感知）。
- ❌ 击退的墙体 / 碰撞阻挡（无物理引擎，沿用 spec 03 C6）。
- ❌ 按实体键位绑定（`dashKey` / `attackKey`）——本里程碑用"意图层"解耦，键位绑定仍全局单帧。
- ❌ 每武器的顿帧 / 击退调参组件（本里程碑用 `HitboxComponent` 字段 + 模块常量）。
- ❌ 任何外部物理引擎、DOM / Canvas / 图形库（沿用 spec 00 C1）。

### 1.4 约束
- C1 **时间只来自 Tick**：所有计时以整数 Tick 计，**禁止**墙钟；积分取 `ctx.fixedDeltaSeconds`。
- C2 **确定性**：同输入序列 ⇒ 逐 Tick 同状态；遍历一律走 `World.query`（id 升序）。
- C3 **类型安全**：禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- C4 **POD 契约**：组件为 `ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法
  （冻结 / 解冻以自由函数 `isFrozen` / `applyFreeze` 提供）。
- C5 **无跨 Tick 隐藏状态**：系统不得持有隐藏状态（spec 00 §6.1）；计时一律落在组件字段上。
- C6 **纯数学**：击退方向只用向量归一化，不引入物理引擎、不引入随机。
- C7 **不改时钟 / 步长**：`FixedClock`、`GameSimulator.step`、`SystemContext` 的既有契约不得改动。
- C8 **硬件与逻辑分层**：`src/` 内玩法系统**禁止**直接读 `PlayerInputComponent`；只读 `IntentComponent`。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **硬件输入（Hardware Input）** | 设备快照（键盘 / 手柄）：`PlayerInputComponent`。**只有玩家**持有。 |
| **意图（Intent）** | 逻辑层"本 Tick 想做什么"：`IntentComponent`。**所有战斗单位**持有；玩法系统只读它。 |
| **意图脉冲（Intent Pulse）** | `wantsToDash` / `wantsToAttack`：**单 Tick** 上升沿，由消费方读取后置 `false`。 |
| **顿帧（Hitstop / Hit-freeze）** | 命中瞬间，攻守双方冻结数个 Tick：不位移、不推进状态机、不响应意图（AC-01）。 |
| **受击硬直（Hitstun）** | 受击者被强制进入的 `ActionState.HITSTUN`，持续 `DEFAULT_HITSTUN_TICKS` 后回到 `MOVING`/`IDLE`。 |
| **击退（Knockback）** | `HITSTUN` 期间的**强制位移速度**（世界单位/秒），由 `MovementSystem` 直接积分，不经 `VelocityComponent`。 |
| **击退方向** | 从**判定圆圆心**指向**受击者圆心**的单位向量（即"远离攻击者"）；退化时回退为判定圆 `facingRadians`。 |
| **冻结计数（remainingTicks）** | `FreezeComponent` 上的倒计时；`> 0` 表示本 Tick 被冻结。 |
| **规范管道** | 每 Tick 固定的系统执行顺序（硬契约，见 §5.2）。 |

---

## 3. 组件契约

组件均为 `ComponentBase` 子类（POD，无行为），字段为 `public` 可写数据。

### 3.1 `IntentComponent` — 逻辑意图（新增）
| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `moveVector` | `Vec2` | `(0, 0)` | **持久**：本 Tick 想往哪走（未归一化，`MovementSystem` 负责 clamp）。空输入帧保留旧值。 |
| `wantsToDash` | `boolean` | `false` | **脉冲**：本 Tick 想冲刺（单 Tick 上升沿；消费方读后置 `false`）。 |
| `wantsToAttack` | `boolean` | `false` | **脉冲**：本 Tick 想攻击（单 Tick 上升沿；消费方读后置 `false`）。 |

> 语义契约：`moveVector` 为**持久状态**（与旧 `InputComponent.moveVector` 一致）；两个 `wants*` 为
> **单 Tick 脉冲**，由消费方（`DashSystem` / `CombatActionSystem`）在评估门控后置回 `false`。
> 这样"按住冲刺键不会在冷却结束后自动连冲"的既有契约（spec 03 §4.3）得以保持。

### 3.2 `PlayerInputComponent` — 玩家硬件输入（由 `InputComponent` 更名）
| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `moveVector` | `Vec2` | `(0, 0)` | 原始摇杆向量（持久） |
| `keysHeld` | `string[]` | `[]` | 当前按住的键，**升序**（确定性） |
| `buttonDash` | `boolean` | `false` | **电平**：冲刺键是否按住 |
| `buttonDashJustPressed` | `boolean` | `false` | **上升沿**：本 Tick 刚按下冲刺键 |
| `buttonAttack` | `boolean` | `false` | **电平**：攻击键是否按住 |
| `buttonAttackJustPressed` | `boolean` | `false` | **上升沿**：本 Tick 刚按下攻击键 |

导出常量 `DASH_KEY = 'dash'` / `ATTACK_KEY = 'attack'` 保留（随文件更名迁移）。
**只有玩家实体持有它**（`PlayerFactory` 传 `hardwareInput = true`，`EnemyFactory` 传 `false`）。

### 3.3 `FreezeComponent` — 顿帧计数（新增）
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `remainingTicks` | `number` | `0` | 剩余冻结 Tick 数；`0` 为稳定静止值（**不**在归零时移除组件，避免快照抖动） |

自由函数：
| 函数 | 签名 | 语义 |
|---|---|---|
| `isFrozen` | `(world, id) => boolean` | 组件存在且 `remainingTicks > 0` |
| `applyFreeze` | `(world, id, ticks) => void` | 冻结 `ticks` 个**可观测** Tick；组件不存在则挂载；`remainingTicks = max(remainingTicks, ticks + 1)`；`ticks <= 0` 为 no-op |

> **为何写入 `ticks + 1`**：`FreezeSystem` 在**每个受冻结 Tick 的开头**自减 1，而所有消费方在其**之后**运行。
> 若写入 `ticks`，消费方在最后一个冻结 Tick 会读到 `0` 而不跳过，实际只冻结 `ticks - 1` 个 Tick。
> 因此计数**高配一格**，使可观测冻结窗口恰为 `ticks` 个 Tick（见 §6）。重复命中取 `max`，绝不缩短已有顿帧。

### 3.4 `KnockbackComponent` — 强制位移速度（新增）
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `velocity` | `Vec2` | `(0, 0)` | 世界单位/秒，沿击退方向（远离攻击者） |

语义：`HITSTUN` 期间的**强制位移速度**，由 `MovementSystem` 直接积分到 `TransformComponent`，
**不经过 `VelocityComponent`**、**不受 `maxSpeed` / `speedMultiplier` 影响**、**不响应移动意图**。

### 3.5 `StateComponent`（扩展）
`ActionState` 新增第五值 `HITSTUN = 'HITSTUN'`。
新增导出常量 `DEFAULT_HITSTUN_TICKS = 8`（@60fps ≈ 0.133 s；与 `DEFAULT_ATTACK_DURATION_TICKS` 并列，
沿用 spec 03 §10 取舍 3 的"用模块常量而非组件字段"的先例）。

### 3.6 `HitboxComponent`（扩展）
新增导出常量：
| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_HITSTOP_TICKS` | `4` | 命中时对**攻守双方**施加的顿帧 Tick 数 |
| `DEFAULT_KNOCKBACK_FORCE` | `12` | 击退速度（世界单位/秒） |

新增字段（放在 `hitEntities` 之前）：
| 字段 | 类型 | 说明 |
|---|---|---|
| `ownerEntityId` | `EntityId` | 攻击者实体 id（生成时快照；判定圆是独立实体，不跟随攻击者，故需显式记录以回写顿帧） |
| `hitstopTicks` | `number` | 命中时双方冻结 Tick 数（默认 `DEFAULT_HITSTOP_TICKS`） |
| `knockbackForce` | `number` | 击退速度（默认 `DEFAULT_KNOCKBACK_FORCE`） |

构造签名：`constructor(radius, damage, activeTicks, faction, ownerEntityId, hitstopTicks = DEFAULT_HITSTOP_TICKS, knockbackForce = DEFAULT_KNOCKBACK_FORCE, hitEntities = [])`。
`ownerEntityId` 可能指向**已被销毁**的实体，故消费方须先 `world.isAlive(...)` 再使用。

---

## 4. 语义契约

### 4.1 硬件 → 意图（`PlayerControllerSystem`）
每 Tick 顺序执行两阶段：
1. `bindHardwareInput`：把本 Tick 的输入帧绑定到**玩家**的 `PlayerInputComponent`（仅 `query(PlayerInputComponent)`）。
   `move` 覆盖摇杆向量；`keyDown` / `keyUp` 维护升序 `keysHeld`；每 Tick 无条件重算电平与上升沿：
   ```
   buttonDash              = keysHeld 含 DASH_KEY
   buttonDashJustPressed   = dashHeld   && !wasDashHeld
   buttonAttack            = keysHeld 含 ATTACK_KEY
   buttonAttackJustPressed = attackHeld && !wasAttackHeld
   ```
2. `deriveIntent`：对同时拥有 `PlayerInputComponent` + `IntentComponent` 的实体（即玩家）：
   ```
   intent.moveVector   = input.moveVector
   intent.wantsToDash  = input.buttonDashJustPressed
   intent.wantsToAttack= input.buttonAttackJustPressed
   ```
> 敌人只有 `IntentComponent`，无 `PlayerInputComponent`，故其意图由 AI / 脚本直接写入，不被本阶段覆盖。

### 4.2 顿帧（AC-01）
- 命中结算（`CollisionSystem`）后，对**受击者**与**攻击者**分别 `applyFreeze(..., hitbox.hitstopTicks)`。
- `FreezeSystem` 每 Tick 对 `remainingTicks > 0` 的实体自减 1；自减后仍 `> 0`（即本 Tick 消费方会跳过）
  时，**清零该实体的意图**——防止"冻结期间按下的按键脉冲在解冻后补触发"。
- 冻结期间：`MovementSystem` / `DashSystem` / `StateSystem` / `CombatActionSystem` 一律 `continue`。

### 4.3 无缝恢复（AC-02）
- 冻结**不重置**也不**跳过**状态机：`ticksInState` 在冻结期间不变，解冻后从冻结前的值继续 `+1`。
- 关键实现细节：`FreezeSystem` 的清零条件是**自减后的值**（与消费方一致）。若按自减**前**的值清零，
  解冻那一 Tick 的意图会被误清零，导致实体以空意图恢复（见 §8 失败模式）。

### 4.4 受击硬直与击退（AC-03）
命中且**实际生效**（非无敌帧）时，`CollisionSystem` 追加：
1. `applyFreeze(target, hitstopTicks)`（受击者冻结）。
2. 攻击者冻结：`hitbox.ownerEntityId` 存在且 `world.isAlive(...)` 时 `applyFreeze(owner, hitstopTicks)`。
3. 受击者进入硬直：取 `StateComponent`，置 `state = HITSTUN; ticksInState = 1`（缺组件则跳过）。
   **为何种入 1 而非 0**：`HITSTUN` 由 `CollisionSystem` 写入，而 `CollisionSystem` 排在 `StateSystem`
   **之后**，故命中 Tick `T` 不会被状态机计数。种入 1（对齐 `ATTACKING` 的进入语义——`CombatActionSystem`
   排在 `StateSystem` **之前**，其进入 Tick 会被计数）使 `HITSTUN` 的**可观测跨度恰为
   `DEFAULT_HITSTUN_TICKS`**（否则会因相位差多出 1 个 Tick；见 §8 失败模式）。
4. 击退方向 `dir = normalize(targetPos - hitboxPos)`；若退化（长度 0）回退为 `hitbox.facingRadians` 的方向。
   然后 `world.addComponent(target, new KnockbackComponent(scaleVec2(dir, hitbox.knockbackForce)))`
   （已存在则覆盖，保证"同一 Tick 内最后一次命中决定击退"）。
- `HITSTUN` 期间 `MovementSystem` 施加 `transform += knockback.velocity * fixedDeltaSeconds`，
  **不 clamp、不看意图、不写 facing**，并置 `velocity.currentSpeed = 0`。
- **不改变**既有的 4 条碰撞 skip 顺序（多段守卫 / 同阵营 / 圆相交 / 无敌帧），尤其是"无敌帧整次忽略"契约：
  无敌帧命中**不写入** `hitEntities`，也**不产生**顿帧 / 硬直 / 击退。

### 4.5 纯逻辑门 ESLint 化（技术债修复）
- 旧 CI 用 `grep -rnE '\b(window\.|document\.|Date\.now\(\)|Math\.random\(\))' src/`，会误伤注释里的普通英文名词
  （如句末的 `window.`）。
- 新方案：`eslint.config.mjs`（flat config）对 `src/**/*.ts` 启用
  - `no-restricted-globals`：禁 `window`、`document`；
  - `no-restricted-properties`：禁 `Math.random`、`Date.now`；
  - `no-restricted-syntax`：禁 `new Date()`（`NewExpression[callee.name="Date"]`）。
- ESLint 基于 **AST 节点**，注释永不可能触发；四条纯逻辑限制**绝不放宽**。

---

## 5. 系统契约与管道顺序

### 5.1 各系统职责（M2-T02 变更点）
| 系统 | 变更 |
|---|---|
| `PlayerControllerSystem`（新） | 首段：硬件→意图（§4.1）。原 `MovementSystem.bindInput` 整段迁入，逻辑一字不改，仅 query 改为 `PlayerInputComponent`。 |
| `FreezeSystem`（新） | 顿帧倒计时 + 冻结期间清零意图（§4.2）。 |
| `MovementSystem` | 删除 `bindInput`，只剩 `integrate`；query 改为 `(IntentComponent, VelocityComponent, TransformComponent)`；新增 `isFrozen` 跳过、`HITSTUN` 击退分支；方向源改为 `intent.moveVector`。 |
| `DashSystem` | query `InputComponent`→`IntentComponent`；触发条件 `buttonDashJustPressed`→`intent.wantsToDash`（**无条件**读后置 `false`，再评估门控）；新增 `isFrozen` 跳过；**起手门控：仅允许自 `IDLE`/`MOVING` 进入**——`HITSTUN`/`ATTACKING` 不可被打断，脉冲被消费后**丢弃**（见 §8 F1/F2）。 |
| `StateSystem` | `moving` 改读 `intent.moveVector`；新增 `HITSTUN` 分支（最高优先级中断）；新增 `isFrozen` 跳过。 |
| `CombatActionSystem` | query `InputComponent`→`IntentComponent`；触发条件改为 `intent.wantsToAttack`（读后置 `false`）；门控增加 `HITSTUN`；生成 Hitbox 时传 `ownerEntityId = id`；新增 `isFrozen` 跳过。 |
| `CollisionSystem` | 命中后追加顿帧 / 硬直 / 击退写入（§4.4）；4 条 skip 顺序不变。 |
| `LifespanSystem` | **不变**：判定圆不因攻击者冻结而延长寿命（spec 03 AC-05 依赖 15 Tick 精确寿命）。 |

### 5.2 规范管道（硬契约）
`src/ecs/systems/pipeline.ts::createDefaultSystems()` 返回**新实例数组**，顺序固定：

```
PlayerControllerSystem -> FreezeSystem -> MovementSystem -> DashSystem -> StateSystem
  -> CombatActionSystem -> CollisionSystem -> LifespanSystem
```

顺序理由（**不得重排**）：
1. `PlayerControllerSystem` 取代原 `MovementSystem.bindInput` 成为**首段**（硬件→意图），
   使后续系统读到本 Tick 已填充的 `IntentComponent`。
2. `FreezeSystem` **紧随其后**，必须在所有"逐实体推进"的系统之前——顿帧在**任一**推进系统之前生效，
   从而抑制整 Tick。**M1/M2 的六段相对顺序一字不改**（`Movement .. Lifespan`）。
3. `MovementSystem` 按**上一 Tick 决定的状态**积分 → 本 Tick 启动的冲刺从下一 Tick 开始位移（spec 02 §6）。
4. `DashSystem` → `StateSystem`：使无敌窗口与冲刺前段对齐、冲刺恰在第 `durationTicks` 退出。
   **注意：因 `DashSystem` 早于 `StateSystem`，`StateSystem` 的 `HITSTUN` 分支无法拦截冲刺**起手**路径**
   （冲刺会先把状态改写成 `DASHING`）——故 `DashSystem` **自身**必须门控 `IDLE`/`MOVING`（§5.1 / §8 F1/F2）。
5. `CombatActionSystem` 在状态机之后、碰撞之前：本 Tick 的攻击门控准确，且本 Tick 生成的判定圆本 Tick 可命中。
6. `CollisionSystem` 在 `DashSystem` 之后，读到本 Tick 更新过的无敌标签（spec 03 §4.4）；
   它同时是**命中反馈写入点**——顿帧 / 硬直 / 击退均在 Tick 末尾写入，故从**下一 Tick**起生效。
7. `LifespanSystem` **最后**：判定圆在被销毁前完成本 Tick 碰撞检测，寿命为完整 `activeTicks`。

---

## 6. 时序硬契约（逐 Tick，QA 将逐 Tick 断言）

### 6.1 顿帧的精确边界
设命中发生在 Tick `T`（`CollisionSystem` 在该 Tick **末尾**执行 `applyFreeze(..., N)`，`N = hitbox.hitstopTicks`）。
`FreezeSystem` 在 Tick `k` 先判 `remainingTicks > 0`（是否冻结），再自减 1：

| Tick 范围 | `FreezeSystem` 行为 | 消费方（Movement/Dash/State/CombatAction） |
|---|---|---|
| `T` | 顿帧尚未写入（在 `CollisionSystem` 才写） | 正常运行 |
| `T+1 .. T+N` | 每 Tick 自减 1，且自减后仍 `> 0` ⇒ **清零意图** | **全部跳过**：`ticksInState` 不推进、坐标不变、不读意图 |
| `T+N+1` 起 | `remainingTicks` 已归 0，不再自减、不再清零 | **恢复**：正常读取本 Tick 意图 |

⇒ **冻结覆盖 Tick `T+1 .. T+N`（恰好 `N` 个 Tick），Tick `T+N+1` 起恢复。**
（默认 `N = DEFAULT_HITSTOP_TICKS = 4` ⇒ 冻结 `T+1..T+4`，第 `T+5` Tick 恢复。）

> 实现注记：因 `FreezeSystem` 在消费方**之前**自减，`applyFreeze` 将计数**高配一格**（写入 `N+1`），
> 使消费方在 `T+1..T+N` 均读到 `> 0`；`remainingTicks` 于 `T+N+1` 读到 `0`。这样可观测窗口恰为 `N`。

### 6.2 受击者硬直 / 击退的精确边界
| Tick | 受击者 `StateComponent` | 受击者坐标 | 说明 |
|---|---|---|---|
| `T`（末） | `state = HITSTUN`、`ticksInState = 1`（**种入 1**，见 §4.4），挂 `KnockbackComponent` | 不变 | 硬直与击退在命中 Tick 末尾写入 |
| `T+1 .. T+N` | 冻结：`ticksInState` 保持 `1` | **不变** | 被顿帧跳过，击退尚未积分 |
| `T+N+1 .. T+N+DEFAULT_HITSTUN_TICKS` | 仍在 `HITSTUN`；`StateSystem` 令 `ticksInState` 从 `1` 继续 `+1`（`2, 3, …, DEFAULT_HITSTUN_TICKS`） | 每 Tick `+= knockback.velocity * fixedDeltaSeconds`（**不 clamp、不看意图**） | 恢复后由 `MovementSystem` 积分击退；本区间的**每个** Tick 都计入击退位移 |
| 该区间**末 Tick**（`T+N+DEFAULT_HITSTUN_TICKS`） | `ticksInState >= DEFAULT_HITSTUN_TICKS` ⇒ 回到 `moving ? MOVING : IDLE`、`ticksInState = 0` | 本 Tick **仍**施加击退（`MovementSystem` 早于 `StateSystem`） | `HITSTUN` 恰持续 `DEFAULT_HITSTUN_TICKS` 个 Tick 后退出 |

⇒ **击退位移覆盖 `T+N+1 .. T+N+DEFAULT_HITSTUN_TICKS`（恰 `DEFAULT_HITSTUN_TICKS` 个 Tick），
`HITSTUN` 在该区间末 Tick 退出。**（默认 `T=0`、`N=4` ⇒ 击退 `T+5..T+12` 共 8 个 Tick，退出于 Tick 12。）

### 6.3 验收场景（`fps = 60`，`maxSpeed = 5`，默认常量）
- 玩家：(0, 0)，`facingRadians = 0`；Tick 0 注入 `keyDown('attack')`。
- 玩家判定圆：圆心 **(0.75, 0)**、半径 **1.0**（寿命 15 Tick）。
- 敌方：(1.5, 0)，受击圆半径 **0.5** ⇒ 命中判据 `圆心距离 < 1.5`（`0.75 < 1.5`）。
- 命中 Tick `T = 0` ⇒ `N = 4`，`knockbackForce = 12` ⇒ 击退方向 `+x`。

| Tick | 玩家 `ticksInState` | 玩家 x | 敌方 `state` | 敌方 `ticksInState` | 敌方 x | 说明 |
|---|---|---|---|---|---|---|
| 0 | 0（ATTACKING） | 0 | HITSTUN | 1 | 1.5 | 命中；写入顿帧 / 硬直 / 击退（`ticksInState` 种入 1） |
| 1 | 0（冻结） | 0 | HITSTUN（冻结） | 1 | 1.5 | 冻结 |
| 2 | 0（冻结） | 0 | HITSTUN（冻结） | 1 | 1.5 | 冻结 |
| 3 | 0（冻结） | 0 | HITSTUN（冻结） | 1 | 1.5 | 冻结 |
| 4 | 0（冻结） | 0 | HITSTUN（冻结） | 1 | 1.5 | 冻结（第 `N` 个） |
| 5 | 1（恢复） | 0 | HITSTUN（恢复） | 2 | **1.7** | 恢复：双方状态机 `+1`；敌方击退 `12/60 = 0.2` |
| … | … | 0 | HITSTUN | … | … | 击退每 Tick `+0.2` |
| 11 | 7 | 0 | HITSTUN | 8 | 2.9 | 击退第 `DEFAULT_HITSTUN_TICKS − 1` 个 Tick |
| **12** | 8 | 0 | **IDLE**（退出硬直） | 0 | **3.1** | 击退区间末 Tick：本 Tick 仍施加击退，`StateSystem` 随后退出 `HITSTUN` |
| 13 | 9 | 0 | IDLE | 0 | 3.1 | 击退已停止 |

**由该表派生的可断言事实（MUST）**：
1. 顿帧恰覆盖 `T+1..T+4` 共 4 个 Tick；`T+5` 恢复。
2. 顿帧期间攻守双方 `ticksInState` **不增加**、坐标**不变**、**不读意图**。
3. 解冻后玩家 `ticksInState` 从冻结前的值**继续**（不重置、不跳过）。
4. 敌方在 `T+5` 起沿 **+x**（远离攻击者）位移，步长 `knockbackForce * fixedDeltaSeconds`，
   与 `maxSpeed` **无关**；此期间将敌方 `intent.moveVector` 设为 `-x` 也**不产生额外位移**。
5. **击退位移发生在 `T+N+1 .. T+N+DEFAULT_HITSTUN_TICKS` 共 `DEFAULT_HITSTUN_TICKS` 个 Tick**
   （默认 `T+5..T+12` 共 8 个；总位移 `8 × 0.2 = 1.6`，末值 `x = 3.1`）；`HITSTUN` 在该区间
   **最后一个 Tick 末退出**（默认 Tick 12），随后回到 `MOVING`/`IDLE`。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 验收项 | 判据 | 优先级 |
|---|---|---|---|
| **AC-01** | 顿帧（Hitstop） | 命中时**攻击者与受击者**都进入冻结状态数个 Tick（默认 4）；冻结期间动画 / 状态机暂停推进，且**不响应意图** | 必达（派发要求） |
| **AC-02** | 顿帧后无缝恢复 | 顿帧结束后，状态机从**顿帧前的进度继续**推进（不重置、不跳过） | 必达（派发要求） |
| **AC-03** | 受击硬直与击退 | 受击者扣血后进入 `HITSTUN`，并在数个 Tick 内沿攻击方向**反向强制位移**；位移**无视 `maxSpeed`**、**不响应移动意图**；`HITSTUN` **不可被冲刺取消**（`DashSystem` 起手门控 `IDLE`/`MOVING`，见 §5.1 / §8 F1） | 必达（派发要求） |
| **AC-04** | 确定性回放 | 同输入序列跑两个独立 `GameSimulator`，逐 Tick `snapshot()` `toEqual` 一致（含顿帧 / 硬直 / 击退路径） | 保障门 |
| **AC-05** | 纯逻辑门 ESLint 化 | `src/**/*.ts` 经 ESLint AST 门禁：禁 `window` / `document` / `Math.random` / `Date.now` / `new Date()`；注释不误伤；`npm run lint` **0 error 0 warning** | 保障门 |
| **AC-06** | 意图解耦不破坏既有契约 | 既有 86 用例全部重构通过；敌人无 `PlayerInputComponent`；冲刺 / 攻击上升沿触发、无敌帧消费、判定圆寿命等 M1/M2 契约不变 | 保障门 |
| **AC-07** | 管道顺序硬契约 | `createDefaultSystems()` 顺序 = `PlayerControllerSystem, FreezeSystem, MovementSystem, DashSystem, StateSystem, CombatActionSystem, CollisionSystem, LifespanSystem` | 保障门 |
| **AC-08** | 类型安全 | `npm run typecheck` 零错误；无 `any` / 非空断言 / `@ts-ignore` 逃逸；Vitest 为 node 环境 | 保障门 |

> **AC-01 / AC-02 / AC-03 为任务派发明确要求**；**AC-04 … AC-08 为保障前三条可信而设的补充门**。
> AC-01…AC-03 由 `tests/combat/feedback.test.ts` 断言；AC-06 由既有 `tests/combat/*` 与 `tests/harness/*` 断言；
> AC-05 由 `eslint.config.mjs` + `npm run lint` 覆盖；AC-08 由 `npm run typecheck` + Vitest 配置覆盖。

---

## 8. 失败模式（Failure Modes）

| 模式 | 后果 | 缓解 |
|---|---|---|
| 玩法系统直读 `PlayerInputComponent` | 解耦失效；敌人无输入设备则无法行动 | C8：玩法系统只读 `IntentComponent`；`EnemyFactory` 不挂硬件组件 |
| 敌人仍持 `PlayerInputComponent` | 单一全局输入帧再次驱动所有实体（交叉响应回归） | `spawnCombatant(hardwareInput=false)` 只给玩家挂硬件组件 |
| `FreezeSystem` 按**自减前**的值清零意图 | 解冻那一 Tick 意图被误清零，实体以空意图恢复 | §4.3：清零条件取**自减后**的值（与消费方一致）；`feedback.test.ts` G1 断言冻结期间状态机与坐标均不变、解冻后继续推进 |
| `HITSTUN` 进入时 `ticksInState` 置 `0` | 因"`CollisionSystem` 晚于 `StateSystem`"的相位差，实际多硬直 / 多击退 1 个 Tick，spec 表与实际不符 | §4.4：进入时**种入 1**，使可观测跨度恰为 `DEFAULT_HITSTUN_TICKS`；§6.3 表以探针实测核对（8 个击退 Tick / 末值 3.1 / Tick 12 退出） |
| `applyFreeze` 写入 `ticks` 而非 `ticks + 1` | 可观测冻结只有 `ticks - 1` 个 Tick，边界用例差一 Tick | §6.1 实现注记；G0 断言冻结恰 `N` 个 Tick |
| 归零时移除 `FreezeComponent` | Snapshot 形状在冻结前后抖动，破坏逐 Tick 比对 | §3.3：保留 `remainingTicks = 0`，不移除组件 |
| 冻结期间不清零意图脉冲 | 冻结中按下的冲刺 / 攻击在解冻瞬间"补触发" | §4.2：`FreezeSystem` 在受冻结 Tick 清零意图 |
| 击退经 `VelocityComponent` / 受 `maxSpeed` 影响 | 击退位移随实体速度漂移，手感不一致 | §4.4：`KnockbackComponent` 独立通道，`MovementSystem` 直接积分，不 clamp |
| `HITSTUN` 未列为最高优先级中断 | 受击者继续冲刺 / 攻击，硬直失效 | `StateSystem` 的 `HITSTUN` 分支置于 `DASHING`/`ATTACKING` 之前；**且** `DashSystem` 起手门控 `IDLE`/`MOVING`（§5.1）——**仅靠 `StateSystem` 不足以拦截冲刺路径**（`DashSystem` 早于 `StateSystem`，见 §5.2） |
| **F1**：`DashSystem` 未门控 `HITSTUN` | 受击者可用冲刺**逃出**硬直，硬直当场失效（本表上一条缓解名不副实） | §5.1：`DashSystem` 起手**仅允许自 `IDLE`/`MOVING` 进入**，脉冲无条件消费后丢弃；`feedback.test.ts` G6 F1 回归断言（`HITSTUN` 期间冲刺脉冲被消费并丢弃；跨 Tick 13 回到 `IDLE` 后新脉冲才生效） |
| **F2**：`DashSystem` 未门控 `ATTACKING` | 冲刺可**打断攻击承诺**（攻击取消 cancel 属 spec 03 §1.3 Out of Scope） | 同 F1（**同一处门控**）；`feedback.test.ts` G6 F2 回归断言（`ATTACKING` 期间冲刺脉冲被消费并丢弃；Tick 17 退出后 `keyUp@18`/`keyDown@19` 新脉冲才生效） |
| 击退方向退化（圆心重合）未回退 | 归一化得零向量，无位移 | §4.4：退化时回退判定圆 `facingRadians` |
| 命中反馈在无敌帧命中时也写入 | 无敌帧被"惩罚"（被冻 / 被击退） | §4.4：反馈仅在**实际生效**的命中后追加；无敌帧整次忽略 |
| 顿帧延长判定圆寿命 | spec 03 AC-05 的 15 Tick 精确寿命被破坏 | `LifespanSystem` 不感知冻结，**不改动** |
| 管道首段 / `FreezeSystem` 位置错置 | 顿帧不能抑制整 Tick；硬件→意图时序错乱 | §5.2 硬契约；AC-07 断言顺序 |
| ESLint 门正则化残留 | 注释里的普通英文名词再次误伤 CI | §4.5：AST 门取代 `grep`；门禁探测注释零误报 |

---

## 9. 追溯（Traceability）

- **本 Spec → 测试**：
  - `tests/combat/feedback.test.ts`（AC-01 / AC-02 / AC-03 / AC-04 / AC-07）：G0 顿帧边界、G1 冻结暂停与恢复、
    G2 硬直 + 击退、G3 确定性回放、G4 管道顺序、**G6 不可生效脉冲的消费与丢弃（含 F1 `HITSTUN` / F2 `ATTACKING` 门控回归）**。**覆盖边界**：G1 断言"冻结期间状态机与坐标不变 + 解冻后继续推进"，
    未单独断言"解冻后意图重新生效"（该覆盖由 QA 套件补充）。
  - `tests/combat/hit_detection.test.ts`（AC-06：命中判定 / 无敌帧消费重构后仍通过；G2 改为驱动敌人 `IntentComponent`）。
  - `tests/combat/{movement,dash}.test.ts`（AC-06：移动 / 冲刺 / 状态机重构后仍通过）。
  - `tests/harness/*`（AC-06：Harness 独立夹具不受影响，仍全绿）。
  - AC-05 由 `eslint.config.mjs` + `npm run lint` 覆盖；AC-08 由 `npm run typecheck` 覆盖。
- **本 Spec → 实现**：
  - 组件（新增）：`src/ecs/components/{IntentComponent,FreezeComponent,KnockbackComponent}.ts`
  - 组件（更名 / 扩展）：`src/ecs/components/{PlayerInputComponent,HitboxComponent,StateComponent}.ts`、`src/ecs/components/index.ts`
  - 系统（新增）：`src/ecs/systems/{PlayerControllerSystem,FreezeSystem}.ts`
  - 系统（扩展）：`src/ecs/systems/{MovementSystem,DashSystem,StateSystem,CombatActionSystem,CollisionSystem,pipeline,index}.ts`
  - 预制体：`src/ecs/prefabs/{spawn-helpers,PlayerFactory,EnemyFactory}.ts`
  - 工程基建：`eslint.config.mjs`（新）、`package.json`（`lint` 脚本）、`.github/workflows/ci.yml`（grep 门 → `npm run lint`）
- **契约依赖登记**：spec 03 §10 取舍 4（"输入仍是全局帧"）由本 Spec §4.1 根治；spec 03 §4.4（无敌帧消费）
  与 AC-05（寿命）在本 Spec 下**保持不变**。
- 变更本 Spec 须同步更新测试与实现。

---

## 10. 已知取舍（Known Trade-offs）

1. **意图层解耦，但键位绑定仍全局单帧**：本里程碑引入 `IntentComponent` 作为硬件与逻辑之间的缝，
   玩法系统只读意图，敌人由 AI 写意图——根治了"同一按键驱动所有实体"。但**玩家的键位仍是全局的**
   （`DASH_KEY` / `ATTACK_KEY`），尚不支持"不同玩家不同键位"。多玩家 / 重映射需在 `PlayerInputComponent`
   上增加按实体的键位字段；本里程碑刻意不做，以保持派发范围。
2. **`HITSTUN` 时长用模块常量而非组件字段**：与 `DEFAULT_ATTACK_DURATION_TICKS` 同理（spec 03 §10 取舍 3），
   代价是"不同武器不同硬直"无法表达。当 M3 需要时，应抽出 `HitstunStatsComponent` 并让 `StateSystem` 读取。
3. **顿帧 / 击退参数放在 `HitboxComponent` 上而非独立组件**：判定圆是攻击的载体，其字段随攻击生成而快照，
   与 `faction` / `damage` 同源，便于"不同攻击不同顿帧"。代价是 `HitboxComponent` 字段增多。
4. **两处"相位差补偿"（同一根因的两面）**：`FreezeSystem` 排在消费方**之前**、`CollisionSystem` 排在
   `StateSystem` **之后**，这两处顺序都会让"写入的计数"与"可观测跨度"相差一拍，故做了两处补偿：
   - **顿帧**：`applyFreeze(..., ticks)` 将 `remainingTicks` **高配一格**（挂载瞬间读数为 `ticks + 1`），
     使可观测冻结窗口恰为 `ticks` 个 Tick（§6.1）。
   - **硬直**：进入 `HITSTUN` 时把 `ticksInState` **种入 1**（而非 0），使其可观测跨度恰为
     `DEFAULT_HITSTUN_TICKS`（§4.4 / §6.2），与 `ATTACKING` 的进入计数语义对齐。
   两处都是内部实现细节，但会让直接读 `remainingTicks` / `ticksInState` 的观察者看到 +1；读数应以 §6 的可观测表为准。
5. **击退无墙体阻挡 / 无衰减**：`KnockbackComponent` 是恒定速度，`HITSTUN` 结束时停止；不引入摩擦 / 阻挡 / 反弹。
   动作游戏通常需要"击退撞墙"手感，本里程碑不做（无物理引擎，spec 03 C6）。
6. **命中反馈不区分伤害类型**：顿帧 / 硬直 / 击退对任何命中一视同仁，不因伤害大小 / 暴击而变化。
   伤害类型 / 抗性 / 暴击仍在 spec 03 §1.3 的 Out of Scope。
7. **冻结用整数 Tick 而非秒**：与全项目一致（C1），fps 无关且回放精确；代价是无法表达"半 Tick 顿帧"。

---

## 11. 修订记录（Revision History）

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| rev.1 | 2026-09-28 | 程基岩 | 初版（M2-T02）：意图解耦（`IntentComponent` / `PlayerInputComponent`）、顿帧（`FreezeComponent`）、受击硬直与击退（`HITSTUN` / `KnockbackComponent`）；CI 纯逻辑门 ESLint 化；AC-01…AC-08 |
| rev.2 | 2026-09-28 | 程基岩 | 复核修复：`HITSTUN` 进入时 `ticksInState` 由 `0` 改为**种入 1**（消除"`CollisionSystem` 晚于 `StateSystem`"的相位差，使硬直 / 击退跨度恰为 `DEFAULT_HITSTUN_TICKS`）；同步 §4.4 / §6.2 / §6.3（新增退出行与实测数字：8 个击退 Tick、末值 x=3.1、Tick 12 退出）/ §8 / §9 / §10 |
| rev.3 | 2026-09-28 | 程基岩 | QA 对抗验证修复（F1/F2，**修实现不改规格方向**）：`DashSystem` 起手门控 `IDLE`/`MOVING`（`HITSTUN`/`ATTACKING` 不可被打断；脉冲**无条件**消费后丢弃，不缓冲）；同步 §5.1（DashSystem 行）/ §5.2（顺序理由点 4）/ §7（AC-03 增补"`HITSTUN` 不可被冲刺取消"）/ §8（重写 `HITSTUN` 缓解 + 新增 F1/F2 失败模式）；`feedback.test.ts` 新增 2 条 G6 回归（F1/F2）；`hit_detection.test.ts` G3 冲刺改为合法时机（Tick 18）；套件 114 → **116** |
