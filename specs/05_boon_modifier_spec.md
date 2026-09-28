# 05 · Boon Modifier Spec（变异引擎与事件拦截管道）

| Field | Value |
|---|---|
| Spec ID | `SPEC-05-BOON-MODIFIER` |
| Milestone | **M3 · 变异引擎**（T01） |
| Status | `accepted`（本文件为 M3-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/events.ts`（新）、`src/ecs/components/{ModifierComponent,HitboxComponent}.ts`、`src/ecs/systems/{CollisionSystem,ModifierSystem,pipeline,index}.ts`、`src/ecs/prefabs/spawn-helpers.ts`、`src/ecs/index.ts`、`tests/combat/boons.test.ts`（新）、`tests/combat/feedback.test.ts`（G4 顺序断言同步） |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/03_combat_hitbox_spec.md`（判定圆 / 圆碰撞 / 无敌帧消费）、`specs/04_combat_feedback_spec.md`（顿帧 / 硬直 / 击退 / 管道顺序） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的
在 M2 的**战斗判定圆 + 受击反馈**之上，落地「变异（Boon / Modifier）」能力的第一块地基：

1. **事件钩子（Event Hooks）**：把「命中」从 `CollisionSystem` 的内部副作用，提升为一个**显式事实**
   （`HitEvent`），经**逐 Tick 事件总线**广播，使任何后续系统都能在关键生命周期上挂载行为。
2. **修饰器挂载（Modifier Component）**：实体可以拥有一个**祝福列表**（`ModifierComponent`），
   修饰器通过**消费事件 + 向世界注入新行为**来生效，而不需要修改 `CollisionSystem` 本身。
3. **宙斯普攻（Zeus Strike）**：本里程碑的**第一个硬编码修饰器**，作为事件拦截管道的**端到端验证载体**
   —— 攻击者持有 `zeus_strike` 时，其基础攻击命中目标后，会在**目标当前坐标**额外生成一个
   **无延迟、无方向性的雷击判定圆**，造成固定额外伤害。
4. **防死循环（Anti-Recursion）**：雷击判定圆必须携带 `sourceModifier` 标记，
   使**修饰器派生出的命中不再触发修饰器**，从根上排除无限嵌套。

> 本 Spec 是「变异引擎」的**管道层**（plumbing），不是配置表。修饰器效果**硬编码**在
> `ModifierSystem` 中，配置表（数据驱动的祝福池 / 稀有度 / 前置条件）属后续里程碑。

### 1.2 In Scope（做什么）
- 事件总线：`src/ecs/events.ts`（新）—— `HitEvent` 事实类型 + `EventQueue` 逐 Tick 队列。
- 组件：`ModifierComponent`（新）、`HitboxComponent` 扩展（新增 `sourceModifier`）。
- 系统：`ModifierSystem`（新，事件消费者 / 行为注入者）。
- 系统重构：`CollisionSystem` 命中后**抛出 `HitEvent`**；命中反馈写入改为**按需门控**。
- 管道扩展：`pipeline.ts` 在 `CollisionSystem` 与 `LifespanSystem` 之间插入 `ModifierSystem`，
  并允许调用方注入自己的 `EventQueue`（可观测性）。
- 预制体：`spawnCombatant` 为每个战斗单位挂载一个空的 `ModifierComponent`。

### 1.3 Out of Scope（显式排除）
- ❌ **配置表 / 数据驱动祝福池**：祝福的稀有度、前置、互斥、等级、词条全部不做（本里程碑硬编码）。
- ❌ **除 `OnHit` 之外的钩子**：`OnKill` / `OnDash` / `OnDamageTaken` / `OnRoomClear` 等属后续里程碑。
  `EventQueue<T>` 已预留泛型，扩展时只需新增事件类型，不改队列。
- ❌ **修饰器改变数值（伤害 / 速度 / 血量上限）**：本里程碑只有「注入新实体」这一种注入形态。
- ❌ **祝福的获取 / 掉落 / 商店 / UI 展示**（渲染层与元循环职责）。
- ❌ **死亡与实体销毁**：沿用 spec 03 §1.3；`hp` 可为 0 但实体不被销毁。
- ❌ **雷击的视觉 / 音效 / 屏幕震动**（表现层，逻辑核不感知）。
- ❌ **随机化的雷击目标选择 / 连锁弹射**：雷击**只作用于触发它的那一个目标**，无扩散、无随机。
- ❌ 任何外部物理引擎、DOM / Canvas / 图形库（沿用 spec 00 C1）。

### 1.4 约束
- C1 **时间只来自 Tick**：一切计时以整数 Tick 计，**禁止**墙钟；积分取 `ctx.fixedDeltaSeconds`。
- C2 **确定性**：同输入序列 ⇒ 逐 Tick 同状态；遍历一律走 `World.query`（id 升序）；
  事件按**产生顺序 FIFO** 消费；注入的新实体获得**单调递增** id。
- C3 **类型安全**：禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- C4 **POD 契约**：组件为 `ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法
  （修饰器增删以自由函数 `addModifier` / `removeModifier` / `hasModifier` 提供）。
- C5 **无跨 Tick 隐藏状态**：系统不得持有隐藏状态（spec 00 §6.1）。事件总线是**逐 Tick 连线**：
  每个 Tick 由 `ModifierSystem` **全量 drain**，因此**在每个 Tick 边界上队列恒为空**——
  它不是"隐藏状态"，而是同一 Tick 内两个系统之间的**管道**（见 §4.1 与 §5.2）。
- C6 **不改时钟 / 步长 / `SystemContext`**：`FixedClock`、`GameSimulator.step`、`SystemContext`
  的既有契约**不得改动**（总线以构造注入而非塞进 `SystemContext`，见 §10 取舍 1）。
- C7 **不重排既有系统**：M1/M2 的六段相对顺序（`Movement .. Lifespan`）**一字不改**；
  `LifespanSystem` 仍为**最后一段**。`ModifierSystem` 是**插入**而非重排（见 §5.2）。
- C8 **事件只描述事实，不描述策略**：`HitEvent` 只回答"谁在何时打中了谁、命中点在哪"；
  "因此该发生什么"一律属于 `ModifierSystem`。新增钩子不得把策略写进 `CollisionSystem`。
- C9 **基础攻击语义不变**：无祝福实体的一切既有行为（伤害 / 顿帧 / 硬直 / 击退 / 无敌帧消费 /
  判定圆寿命）必须**逐 Tick 逐位不变**——`ModifierSystem` 对空事件队列必须是**严格无操作**。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **事件（Event）** | 一个已发生的**事实**快照（本里程碑只有 `HitEvent`）。不可变（`readonly`），不承载策略。 |
| **事件总线（Event Bus / `EventQueue`）** | 生产者（`CollisionSystem`）`emit`、消费者（`ModifierSystem`）`drain` 的**逐 Tick FIFO 队列**；Tick 边界恒为空。 |
| **命中事件（`HitEvent`）** | 一次**实际生效**的命中（非无敌帧）结算完成后广播的事实。 |
| **修饰器 / 祝福（Modifier / Boon）** | 挂在实体上、**监听事件并注入行为**的标识符（`string`）。本里程碑硬编码 `'zeus_strike'`。 |
| **修饰器派生命中（Modifier-sourced hit）** | `HitboxComponent.sourceModifier !== null` 的判定圆所产生的命中，即由修饰器注入的判定圆。 |
| **雷击（Zeus Strike）** | `zeus_strike` 注入的判定圆：位于**目标当前坐标**、**无方向性**、**无击退 / 无顿帧**、造成固定额外伤害。 |
| **触发命中（Triggering hit）** | 引发雷击的那一次**基础**攻击命中（`sourceModifier === null`）。 |
| **防递归（Anti-Recursion）** | 修饰器派生命中**不**再次进入修饰器分派，杜绝无限嵌套。 |
| **注入（Injection）** | 修饰器向世界添加新实体的动作（本里程碑：生成雷击判定圆）。 |

---

## 3. 组件与类型契约

### 3.1 `HitEvent` — 命中事实（新增，`src/ecs/events.ts`）
```ts
export interface HitEvent {
  readonly tick: number;                 // 该命中被结算的 Tick（= ctx.tick）
  readonly attackerId: EntityId;         // 攻击者实体（判定圆 ownerEntityId 的快照）
  readonly targetId: EntityId;           // 受击者实体
  readonly hitboxEntityId: EntityId;     // 产生本次命中的判定圆实体
  readonly position: Vec2;               // 命中点 = 判定圆圆心（世界坐标）
  readonly damage: number;               // 本次结算的实际伤害值
  readonly sourceModifier: string | null;// 判定圆来源标记（null = 基础攻击）
}
```
- **只读**：全部字段 `readonly`；事件一旦 `emit` 便不可变。
- **不含策略**：不含"是否应该触发雷击"之类的判断结果（C8）。
- **`position` 的语义**：**命中点（判定圆圆心）**，不是受击者坐标。雷击需要的是**受击者坐标**，
  由 `ModifierSystem` 从 `targetId` 的 `TransformComponent` 现场读取（§4.3）。

### 3.2 `EventQueue<T = HitEvent>` — 逐 Tick 事件总线（新增）
| 成员 | 签名 | 语义 |
|---|---|---|
| `emit` | `(event: T) => void` | 追加到队尾（FIFO）。生产者可多次调用。 |
| `drain` | `() => T[]` | 返回**当前全部事件的新数组**（FIFO 顺序）并**清空**队列。调用方持有的是副本，改动它不影响总线。 |
| `size` | `readonly number` | 当前待处理事件数（可观测性 / 断言用）。 |
| `clear` | `() => void` | 丢弃全部待处理事件（仅供测试与异常恢复；生产路径不使用）。 |

**契约**：
- **FIFO**：`drain` 必须按 `emit` 顺序返回（C2）。
- **Tick 边界为空**：`ModifierSystem` 每 Tick 全量 `drain`，故任意 Tick 结束时 `size === 0`（C5）。
- **泛型默认 `HitEvent`**：`new EventQueue()` 即 `EventQueue<HitEvent>`；新增钩子时直接复用，不改队列。

### 3.3 `ModifierComponent` — 祝福列表（新增）
| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `modifiers` | `string[]` | `[]` | 实体当前拥有的修饰器标识符；**升序且去重**（与 `TagComponent.tags` 同契约，保证快照逐位可比） |

自由函数（POD 契约 C4）：
| 函数 | 签名 | 语义 |
|---|---|---|
| `addModifier` | `(world, id, modifier) => void` | 追加修饰器；组件不存在则**惰性挂载**；已存在则 no-op（幂等） |
| `removeModifier` | `(world, id, modifier) => void` | 移除修饰器；无组件或不持有则 no-op |
| `hasModifier` | `(world, id, modifier) => boolean` | 是否持有；**组件缺失 ⇒ `false`** |

导出常量（本里程碑的"硬编码配置表"，后续迁移到数据表）：
| 常量 | 值 | 含义 |
|---|---|---|
| `ZEUS_STRIKE_MODIFIER` | `'zeus_strike'` | 宙斯普攻的修饰器 id |
| `DEFAULT_ZEUS_STRIKE_DAMAGE` | `20` | 雷击固定额外伤害 |
| `DEFAULT_ZEUS_STRIKE_RADIUS` | `1` | 雷击判定圆半径（世界单位） |
| `DEFAULT_ZEUS_STRIKE_LIFESPAN_TICKS` | `2` | 雷击判定圆寿命（Tick）；**必须 ≥ 2**，理由见 §4.4 |

> `spawnCombatant` 为**每个**战斗单位挂载一个空的 `ModifierComponent`，与 `TagComponent` 同理：
> 组件的装配只存在于 `spawn-helpers.ts` 一处，玩家 / 敌人不会漂移（M2-T01 既有不变量）。

### 3.4 `HitboxComponent`（扩展）
新增字段（**追加为构造函数的第 9 个形参**，避免破坏既有位置调用）：
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `sourceModifier` | `string \| null` | `null` | 判定圆的来源修饰器 id；`null` = 基础攻击。**唯一用途**是防递归（§4.5），不得复用作其他语义 |

构造签名：
```ts
constructor(radius, damage, activeTicks, faction, ownerEntityId,
            hitstopTicks = DEFAULT_HITSTOP_TICKS,
            knockbackForce = DEFAULT_KNOCKBACK_FORCE,
            hitEntities = [],
            sourceModifier: string | null = null)
```

---

## 4. 语义契约

### 4.1 事件生命周期（AC-01）
每 Tick 的事件流是**单向、同 Tick 内闭环**的：

```
CollisionSystem  ──emit(HitEvent)──▶  EventQueue  ──drain()──▶  ModifierSystem  ──▶  世界（注入新实体）
      ▲                                                              │
      └──────────── 注入的判定圆在「下一 Tick」由 CollisionSystem 再次判定 ◀┘
```

- **生产点**：`CollisionSystem`，**仅**在一次**实际生效**的命中结算完成后（扣血 + 记账 + 反馈写入之后）。
- **消费点**：`ModifierSystem`，紧随 `CollisionSystem` 之后、`LifespanSystem` 之前。
- **无敌帧命中不产生事件**：沿用 spec 03 §4.4 的"整次忽略"契约——无伤害、无记账、无反馈、**无事件**。
  因此"打无敌帧"既不会触发雷击，也不会给修饰器任何可乘之机（§6.4 断言）。
- **同 Tick 闭环**：`ModifierSystem` 注入的实体**不会**在本 Tick 被判定（`CollisionSystem` 已经跑过），
  而是在**下一 Tick** 进入判定。这是本里程碑「雷击晚 1 个 Tick 生效」的**根因**，也是天然的一层防递归。

### 4.2 修饰器分派（AC-02）
`ModifierSystem` 对 `drain()` 得到的**每一个**事件，按**固定顺序**执行分派：

1. **防递归门（最高优先级）**：`event.sourceModifier !== null` ⇒ **直接返回**，不做任何查询、不注入任何实体。
2. **持有者判定**：`hasModifier(world, event.attackerId, ZEUS_STRIKE_MODIFIER)` 为假 ⇒ 返回。
3. **注入**：执行该修饰器的注入逻辑（§4.3）。

> **门序不可交换**：第 1 步必须在第 2 步**之前**。若先判持有者，一次雷击会再次满足"持有者判定"，
> 从而在下一 Tick 生成第二发雷击，形成 1→2→4→… 的指数爆炸（§8 失败模式）。

### 4.3 宙斯普攻契约（AC-03）
当一次**触发命中**的攻击者持有 `zeus_strike` 时，`ModifierSystem` 注入一个雷击判定圆：

| 属性 | 取值 | 理由 |
|---|---|---|
| 生成位置 | **受击者（`targetId`）当前坐标**（读 `TransformComponent`） | "在目标位置"；`MovementSystem` 早于 `CollisionSystem`，故此处读到的是**本 Tick 移动后**的当前坐标 |
| `facingRadians` | `0` | **无方向性**：雷击不依赖攻击者朝向，且 `0` 是确定性占位值（不引入随机） |
| 半径 | `DEFAULT_ZEUS_STRIKE_RADIUS = 1` | 判定圆复用 spec 03 的圆相交测试 |
| 伤害 | `DEFAULT_ZEUS_STRIKE_DAMAGE = 20` | **固定**额外伤害，不随攻击者的攻击力变化 |
| `activeTicks` | `DEFAULT_ZEUS_STRIKE_LIFESPAN_TICKS = 2` | 见 §4.4（必须 ≥ 2） |
| `faction` | 与**触发命中所在判定圆**相同 | 雷击继承引发它的那一击的阵营，不会误伤同阵营 |
| `ownerEntityId` | `event.attackerId`（祝福持有者） | 正确的来源归属（本里程碑 `hitstopTicks = 0`，暂无可观测影响） |
| `hitstopTicks` | `0` | **纯伤害**：雷击不施加顿帧（§4.6） |
| `knockbackForce` | `0` | **纯伤害**：雷击不施加击退（§4.6） |
| `sourceModifier` | `ZEUS_STRIKE_MODIFIER` | 防递归标记（AC-04） |

**跳过条件（任一满足即不注入，且不报错）**：
- 事件 `sourceModifier !== null`（防递归）；
- 攻击者不持有 `zeus_strike`；
- 受击者已无 `TransformComponent`（实体已被销毁）；
- 触发命中的判定圆已不存在（`hitboxEntityId` 查不到 `HitboxComponent`）。

### 4.4 为何 `activeTicks` 必须 ≥ 2（Tick 相位核算）
`ModifierSystem` 排在 `CollisionSystem` **之后**，故本 Tick 注入的判定圆**本 Tick 不会被判定**。
而 `LifespanSystem` 排在 `ModifierSystem` **之后**、于每 Tick 末自减 `activeTicks`：

| `activeTicks` | Tick `T` 末 | Tick `T+1` | 结果 |
|---|---|---|---|
| `1` | `1 → 0` ⇒ **当场销毁** | 不存在 | ❌ **雷击永远不判定** |
| `2` | `2 → 1` ⇒ 存活 | 判定一次 ⇒ 末 `1 → 0` 销毁 | ✅ 恰好 **1 个判定 Tick** |

⇒ 取 `2` 使雷击获得**恰好一次**判定机会，落在 `T+1`。这与既有 `DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS = 15`
的相位算法同源（`CollisionSystem` 早于 `LifespanSystem`，故 15 的寿命给出 15 个判定 Tick）。

### 4.5 防递归（AC-04）
- 雷击判定圆的 `sourceModifier = ZEUS_STRIKE_MODIFIER`；`CollisionSystem` 把它**原样搬进** `HitEvent`。
- `ModifierSystem` 的**第一道门**即 `sourceModifier !== null ⇒ 返回`。
- ⇒ 雷击命中敌人时**不会**再生成雷击；嵌套深度恒为 **1**（基础命中 → 1 发雷击）。
- **不用"深度计数"也不用"时间冷却"**：来源标记是**幂等**的，天然可重入安全，且不引入跨 Tick 状态（C5）。

### 4.6 雷击是"纯伤害"（零副作用）
`CollisionSystem` 的**命中反馈写入块**改为**按需门控**：

```
if (hitbox.hitstopTicks > 0 || hitbox.knockbackForce > 0) { 顿帧 / 硬直 / 击退 }
```

- 雷击两项皆为 `0` ⇒ **整块跳过**：不施顿帧、不进 `HITSTUN`、**不写 `KnockbackComponent`**。
- 最后一条是关键：`KnockbackComponent` 是**覆盖写**（spec 04 §4.4 "同一 Tick 内最后一次命中决定击退"）。
  若雷击也写它，`T+1` 的雷击会把 `T` 基础命中写下的击退**清零**，静默破坏 M2 的击退契约。
- **与既有契约兼容**：M2 的 G7 用例（`hitstopTicks = 0` 或 `knockbackForce = 0` 二者之一为 0）中，
  另一个字段仍 `> 0` ⇒ 反馈块照常执行 ⇒ 既有断言逐条不变（§7 AC-05）。

### 4.7 空队列严格无操作（C9）
`ModifierSystem` 对空事件队列必须是**零副作用**：不查询、不注入、不改任何组件。
⇒ **无祝福实体（即 M1/M2 的全部既有场景）的行为逐 Tick 逐位不变**，这是本里程碑"不破坏确定性"的硬保障。

---

## 5. 系统契约与管道顺序

### 5.1 各系统职责（M3-T01 变更点）
| 系统 | 变更 |
|---|---|
| `CollisionSystem` | 构造注入 `EventQueue`；命中结算完成后 `emit(HitEvent)`（含 `sourceModifier`）；命中反馈写入改为**按需门控**（`hitstopTicks > 0 \|\| knockbackForce > 0`）。**四条 skip 顺序一字不改**（多段守卫 / 同阵营 / 圆相交 / 无敌帧）。 |
| `ModifierSystem`（新） | 每 Tick `drain()` 事件队列并逐条分派修饰器；本里程碑硬编码 `zeus_strike`（§4.2 / §4.3）。**不跳过冻结实体**（见下）。 |
| `pipeline.ts` | `createDefaultSystems(events?)`：创建（或接收）**一个** `EventQueue`，注入 `CollisionSystem` 与 `ModifierSystem`；在两者之间建立管道。 |
| `spawn-helpers.ts` | `spawnCombatant` 挂载空 `ModifierComponent`。 |
| 其余系统 | **不变**。 |

> **`ModifierSystem` 为什么不能跳过冻结实体**：命中发生在 Tick `T` 的 `CollisionSystem`，
> 而顿帧正是**在同一处**写入的——到 `ModifierSystem` 运行时，攻击者与受击者**都已经处于冻结状态**。
> 若按 `isFrozen` 跳过，**宙斯普攻永远不会触发**。修饰器是**事件驱动**而非**动作驱动**，
> 与 `Movement` / `Dash` / `State` / `CombatAction` 的冻结门控语义不同，不得照抄。

### 5.2 规范管道（硬契约，M3-T01 扩展）
```
PlayerControllerSystem -> FreezeSystem -> MovementSystem -> DashSystem -> StateSystem
  -> CombatActionSystem -> CollisionSystem -> ModifierSystem -> LifespanSystem
```

**扩展规则（不得违反）**：
1. **M1/M2 六段相对顺序一字不改**（`MovementSystem .. LifespanSystem`），`LifespanSystem` 仍是**最后一段**。
2. `ModifierSystem` **必须**排在 `CollisionSystem` **之后**——否则读不到本 Tick 的事件（§4.1）。
3. `ModifierSystem` **必须**排在 `LifespanSystem` **之前**——否则它注入的判定圆会在被判定前被寿命系统销毁
   （这正是 §4.4 的相位问题；把 `ModifierSystem` 放到 `LifespanSystem` 之后会让 `activeTicks` 语义反转）。
4. `ModifierSystem` **不得**排在 `CombatActionSystem` 之前（那样基础攻击判定圆尚未生成，事件更无从谈起）。

### 5.3 事件总线的装配（依赖注入）
```ts
export function createDefaultSystems(events: EventQueue = new EventQueue()): readonly System[] {
  return [ /* …M1/M2 八段… */, new CollisionSystem(events), new ModifierSystem(events), new LifespanSystem() ];
}
```
- 每次调用创建**独立的** `EventQueue` ⇒ 两个 `GameSimulator` 之间**不可能**串流（C2）。
- 形参可选，既有调用 `createDefaultSystems()` **无需改动**；测试可传入自己的队列以观测总线（§6.5）。
- **不把总线塞进 `SystemContext`**：那会改动 `GameSimulator.step` 与 `SystemContext` 的既有契约（C6）。

---

## 6. 时序硬契约（逐 Tick，QA 将逐 Tick 断言）

### 6.1 基准场景
`fps = 60`；玩家 `(0, 0)`、`facingRadians = 0`、持有 `zeus_strike`；敌人 `(1.5, 0)`（受击圆半径 `0.5`）；
Tick `0` 注入 `keyDown('attack')`。基础判定圆圆心 `(0.75, 0)`、半径 `1.0`、伤害 `10`、寿命 `15`、顿帧 `4`、击退 `12`。

### 6.2 逐 Tick 表（`T = 0`）
| Tick | `CollisionSystem` | `ModifierSystem` | 敌方 hp | 存活雷击判定圆 |
|---|---|---|---|---|
| **`T = 0`** | 基础判定圆命中 ⇒ 伤害 `10`；记账；写顿帧 / 硬直 / 击退；**抛 `HitEvent(基础, sourceModifier = null)`** | `drain` ⇒ 分派：`sourceModifier === null` 且攻击者持有 `zeus_strike` ⇒ 在 `(1.5, 0)` 注入雷击（`activeTicks = 2`） | `90` | `1`（`2 → 1`） |
| **`T+1 = 1`** | 基础判定圆被 `hitEntities` 拦截（不重复伤害）；**雷击命中 ⇒ 伤害 `20`**；抛 `HitEvent(雷击, sourceModifier = 'zeus_strike')` | `drain` ⇒ **防递归门拦截**（`sourceModifier !== null`）⇒ 不注入任何实体 | **`70`** | `0`（`1 → 0` 销毁） |
| `T+2` 起 | 无命中 | 队列为空 ⇒ 严格无操作 | `70` | `0` |

**由该表派生的可断言事实（MUST）**：
1. **两次伤害结算**：`100 → 90`（Tick `0`）→ `70`（Tick `1`），**恰好两段**，间隔**恰好 1 个 Tick**。
2. **雷击恰有 1 个判定 Tick**：雷击判定圆在 Tick `0` 末存在（`activeTicks = 1`）、Tick `1` 末销毁。
3. **嵌套深度恒为 1**：`T+1` 末**不存在**任何雷击判定圆；Tick `2` 起 hp 恒为 `70`。
4. **雷击零副作用**：敌方 `HITSTUN` / 击退时间线与**无祝福**基线**逐位相同**——
   冻结仍覆盖 `T+1..T+4`，击退仍覆盖 `T+5..T+12`（共 8 Tick、每 Tick `0.2`），Tick `12` 末 `x = 3.1` 并退出 `HITSTUN`。
5. **无祝福基线**：敌人 hp 恒为 `90`，全程**零**雷击判定圆。

### 6.3 事件时序（`EventQueue`）
| 时刻 | 队列状态 |
|---|---|
| Tick `0` 的 `CollisionSystem` 之后 | `size === 1`（基础命中） |
| Tick `0` 的 `ModifierSystem` 之后 | `size === 0`（全量 drain） |
| Tick `1` 的 `CollisionSystem` 之后 | `size === 1`（雷击命中） |
| Tick `1` 的 `ModifierSystem` 之后 | `size === 0` |
| 任意 Tick **边界** | **恒为 `0`**（C5：总线不是跨 Tick 状态） |

### 6.4 无敌帧分支
受击者持有 `INVULNERABLE_TAG` 时（spec 03 §4.4）：
| Tick | `CollisionSystem` | `ModifierSystem` | hp |
|---|---|---|---|
| `T = 0` | 圆相交但**整次忽略**：无伤害、**不记账**、无反馈、**不抛事件** | `drain` ⇒ 空 ⇒ 无操作 | `100` |

⇒ 无敌帧既不触发雷击，也不给修饰器留下任何可观测痕迹。

### 6.5 事件事实断言（可观测性）
传入自定义 `EventQueue` 并把一个"探针系统"排在 `CollisionSystem` 之后，即可断言 `HitEvent` 的**逐字段**取值：

| 字段 | Tick `0` 的取值 |
|---|---|
| `tick` | `0` |
| `attackerId` / `targetId` | 玩家 id / 敌人 id |
| `hitboxEntityId` | 基础判定圆实体 id |
| `position` | `(0.75, 0)`（命中点 = 判定圆圆心） |
| `damage` | `DEFAULT_ATTACK_DAMAGE = 10` |
| `sourceModifier` | `null` |

---

## 7. 验收标准（Acceptance Criteria）

| ID | 验收项 | 判据 | 优先级 |
|---|---|---|---|
| **AC-01** | 事件钩子 | 系统在关键生命周期（`OnHit`）派发事件：一次**实际生效**的命中结算完成后，向事件总线抛出 `HitEvent`（含 `attackerId` / `targetId` / `hitboxEntityId` / `position`）；**无敌帧命中不抛事件** | 必达（派发要求） |
| **AC-02** | 修饰器挂载 | 实体可挂载**多个**修饰器（`ModifierComponent.modifiers`，升序去重）；修饰器通过**消费事件 + 注入行为**生效，`CollisionSystem` 本身不感知任何具体祝福 | 必达（派发要求） |
| **AC-03** | 宙斯普攻契约 | 攻击者持有 `zeus_strike` 时，基础攻击命中后于**目标当前坐标**生成**无延迟、无方向性**的雷击判定圆，造成**固定额外伤害**；基础命中与雷击合计**两次伤害结算**，间隔恰 `1` 个 Tick | 必达（派发要求） |
| **AC-04** | 防死循环 | 雷击判定圆携带 `sourceModifier = 'zeus_strike'`；雷击命中**不再**触发雷击；嵌套深度恒为 `1`，hp 收敛于 `maxHp − 10 − 20` | 必达（派发要求） |
| **AC-05** | 既有契约零回归 | 无祝福实体的行为逐 Tick 逐位不变：M2 的 116 用例全绿（含 G4 管道顺序断言同步为 9 段）；`CollisionSystem` 四条 skip 顺序、无敌帧消费、判定圆 15 Tick 寿命、击退 `8 × 0.2 = 1.6` 均不变 | 保障门 |
| **AC-06** | 确定性回放 | 含雷击注入的完整脚本，在两个独立 `GameSimulator` 上逐 Tick `snapshot()` `toEqual` 一致（注入实体的 id 亦一致） | 保障门 |
| **AC-07** | 总线 Tick 边界为空 | 任意 Tick 结束时 `EventQueue.size === 0`；`drain()` 返回 FIFO 副本且不影响后续 | 保障门 |
| **AC-08** | 管道顺序硬契约 | `createDefaultSystems()` 顺序 = `… CollisionSystem, ModifierSystem, LifespanSystem`；M1/M2 六段相对顺序不变，`LifespanSystem` 仍最后 | 保障门 |
| **AC-09** | 类型安全与纯逻辑 | `npm run typecheck` 零错误；无 `any` / 非空断言 / `@ts-ignore`；`npm run lint` 0 error 0 warning（`src/` 无 DOM / 墙钟 / 随机） | 保障门 |

> **AC-01 … AC-04 为任务派发明确要求**；**AC-05 … AC-09 为保障前四条可信而设的补充门**。
> AC-01 … AC-08 由 `tests/combat/boons.test.ts` 断言；AC-05 由既有 `tests/combat/*` 与 `tests/harness/*` 断言；
> AC-09 由 `npm run lint` + `npm run typecheck` 覆盖。

---

## 8. 失败模式（Failure Modes）

| 模式 | 后果 | 缓解 |
|---|---|---|
| `ModifierSystem` 排在 `CollisionSystem` **之前** | 读不到本 Tick 事件，宙斯普攻永不触发（或延迟一个 Tick 才生成） | §5.2 规则 2；AC-08 断言顺序 |
| `ModifierSystem` 排在 `LifespanSystem` **之后** | 注入的判定圆先被寿命系统扣减，`activeTicks` 语义反转，雷击可能永不判定 | §5.2 规则 3；§4.4 相位核算 |
| 雷击 `activeTicks = 1` | 注入当 Tick 即被 `LifespanSystem` 销毁 ⇒ **雷击一次都不判定**（静默失效，最隐蔽） | §4.4 表；AC-03 断言"两次结算" |
| **防递归门序颠倒**（先判持有者、后判 `sourceModifier`） | 雷击命中再次满足"持有者判定"⇒ 指数爆炸 `1→2→4→…` | §4.2 门序不可交换；AC-04 断言 `T+1` 末雷击数为 `0` 且 hp 收敛 |
| 雷击未标记 `sourceModifier` | 同上，无限嵌套 | §4.3 表（`sourceModifier = ZEUS_STRIKE_MODIFIER`）；AC-04 |
| 雷击携带默认 `hitstopTicks` / `knockbackForce` | ① 雷击在 `T+1` 重新 `applyFreeze` ⇒ 顿帧被**延长 1 Tick**；② `KnockbackComponent` 被**覆盖为零** ⇒ M2 击退契约静默失效 | §4.6：反馈块按需门控；雷击两项皆 `0`；AC-03 事实 4 断言"零副作用" |
| 反馈门控写成"二者**皆**为 0 才跳过"之外的形式（如只看 `hitstopTicks`） | 既有 G7 用例（`knockbackForce = 0`）行为改变 | §4.6：门控条件为 `hitstopTicks > 0 \|\| knockbackForce > 0`；AC-05 全量回归 |
| `ModifierSystem` 跳过冻结实体 | 顿帧与命中同 Tick 写入 ⇒ 攻击者 / 受击者均已冻结 ⇒ **宙斯普攻永不触发** | §5.1 注记：修饰器为**事件驱动**，不做冻结门控 |
| 事件总线成为跨 Tick 状态（未全量 drain） | 上一 Tick 的事件在下一 Tick 被二次消费 ⇒ 重复注入 / 回放不一致 | §3.2 契约 + AC-07：Tick 边界 `size === 0` |
| 总线全局单例（跨 `GameSimulator` 共享） | 两个仿真实例互相串流，确定性回放失败 | §5.3：每次 `createDefaultSystems()` 创建独立队列；AC-06 |
| 无敌帧命中抛事件 | 无敌帧被"惩罚"（触发雷击），spec 03 §4.4 契约破坏 | §4.1：事件只在**实际生效**的命中后抛出；§6.4 |
| `ModifierComponent` 装配散落在工厂里 | 玩家 / 敌人组件集漂移 | §3.3：只在 `spawn-helpers.ts::spawnCombatant` 装配一处 |
| `sourceModifier` 被复用作"是否纯伤害"等其他语义 | 语义耦合，后续新增修饰器时互相干扰 | §3.4：`sourceModifier` **唯一用途**是防递归；反馈由 `hitstopTicks` / `knockbackForce` 表达 |
| 雷击位置读**攻击者**坐标或**命中点**坐标 | 雷击落在错误的点（可能完全打空） | §4.3：读 `targetId` 的 `TransformComponent`（当前坐标） |
| 雷击朝向取攻击者 `facingRadians` | 违反"无方向性"，且引入不必要的耦合 | §4.3：`facingRadians = 0`（确定性占位） |

---

## 9. 追溯（Traceability）

- **本 Spec → 测试**（`tests/combat/boons.test.ts`）：
  - `G0` 组件语义：`addModifier` / `removeModifier` / `hasModifier`、升序去重、惰性挂载、战斗单位默认挂载（AC-02）
  - `G1` 事件钩子：探针系统断言 `HitEvent` 逐字段取值；无敌帧命中**零事件**（AC-01）
  - `G2` 宙斯普攻：基础命中 → 雷击注入的位置 / 半径 / 伤害 / 寿命；**两次结算的精确 Tick**（AC-03）
  - `G3` 防死循环：`T+1` 末雷击数为 `0`、hp 收敛、嵌套深度恒为 `1`（AC-04）
  - `G4` 无祝福对照：仅一段伤害、零雷击（AC-03 / C9）
  - `G5` 雷击零副作用：`HITSTUN` / 击退时间线与基线**逐位相同**（Tick `12` 末 `x = 3.1`）（AC-03）
  - `G6` 总线契约：`emit` / `drain` / FIFO / 副本 / Tick 边界恒空（AC-07）
  - `G7` 管道顺序：9 段顺序 + `ModifierSystem` 位置（AC-08）
  - `G8` 确定性回放：含注入的脚本逐 Tick 一致（AC-06）
- **本 Spec → 实现**：
  - 类型（新增）：`src/ecs/events.ts`（`HitEvent` / `EventQueue`）、`src/ecs/components/ModifierComponent.ts`
  - 组件（扩展）：`src/ecs/components/HitboxComponent.ts`（`sourceModifier`）、`src/ecs/components/index.ts`
  - 系统（新增）：`src/ecs/systems/ModifierSystem.ts`
  - 系统（扩展）：`src/ecs/systems/{CollisionSystem,pipeline,index}.ts`
  - 预制体：`src/ecs/prefabs/spawn-helpers.ts`；barrel：`src/ecs/index.ts`
  - 测试同步：`tests/combat/feedback.test.ts` 的 `G4` 管道顺序断言由 8 段扩为 9 段
- **对既有 Spec 的扩展登记**：
  - spec 04 §5.2 的 8 段绝对顺序由本 Spec §5.2 **扩展**为 9 段；**六段相对顺序与 `LifespanSystem` 末位不变**（C7）。
  - spec 04 §4.4 的"命中反馈写入"由本 Spec §4.6 **加装门控**；语义在 `hitstopTicks > 0 || knockbackForce > 0`
    的全部既有配置下**完全等价**（AC-05 以全量回归证明）。
  - spec 03 §4.4（无敌帧消费）在本 Spec 下**保持不变**，并额外保证"无敌帧不产生事件"（§4.1）。
- 变更本 Spec 须同步更新测试与实现。

---

## 10. 已知取舍（Known Trade-offs）

1. **总线用构造注入，而非塞进 `SystemContext`**：`SystemContext` 里放一个事件队列对所有系统都"顺手"，
   但会改动 `GameSimulator.step` 与 `SystemContext` 的既有契约（C6），并把游戏概念（`HitEvent`）
   推进到通用仿真核里。构造注入的代价是**新增生产者必须显式接线**（多一个形参），
   换来的是零契约变更 + 可注入观测（§6.5）。后续若钩子种类暴增，可再评估提升为 `SystemContext` 成员。
2. **总线是"逐 Tick 连线"而非"世界资源"**：把 `EventQueue` 挂到 `World` 上（Bevy 式 Events 资源）
   可免除接线，但会让 `World` 承载游戏概念，破坏"`World` 保持通用、游戏组装留在 prefab 层"的既有不变量。
   本里程碑选择保持 `World` 干净，代价是接线在 `createDefaultSystems` 内集中一处。
3. **雷击固定延迟 1 个 Tick，而非"同 Tick 判定"**：`CollisionSystem` 生产事件的**同一 Tick**，
   它已经跑完，任何后置系统注入的判定圆都不可能在本 Tick 被判定（除非把 `ModifierSystem` 提到
   `CollisionSystem` 之前，但那会让它读不到本 Tick 事件，变成同样延迟一个 Tick —— 净收益为零）。
   ⇒ **"1 Tick 延迟"是本架构的固有属性**，不是实现缺陷。若要真正的"零延迟"，
   需要"判定圆在本 Tick 内二次判定"的补跑机制（复杂度高、破坏 `LifespanSystem` 相位），本里程碑不做。
4. **雷击纯伤害（无顿帧 / 无击退）**：AC-03 只要求"额外固定伤害"，且"无延迟、无方向性"的措辞
   指向**最小副作用**。更重要的是：让雷击携带默认反馈会**延长顿帧 1 Tick** 并**清零击退**
   （§4.6 / §8），静默破坏 M2 契约。若后续要"雷击也带手感"，正确做法是**先修 `KnockbackComponent` 的覆盖语义**
   （改为取模较大者），再给雷击开反馈——本里程碑不做。
5. **修饰器效果硬编码在 `ModifierSystem`**：派发要求如此（"后期再做配置表"）。
   代价是新增祝福要改代码；收益是本里程碑能把**管道**（事件 / 挂载 / 防递归 / 相位）单独验证干净。
   `EventQueue<T>` 与 `ModifierComponent` 的形态已为数据驱动留好位置：配置表落地时，
   `ModifierSystem` 内部的分派 switch 换成"按 `modifiers` 查表 + 执行 effect 描述符"即可，管道不动。
6. **`ModifierSystem` 对每个事件重新查组件（不缓存）**：修饰器查询走 `world.getComponent`，
   单 Tick 事件数极少（战斗单位数十级），缓存带来的跨 Tick 状态风险（C5）远大于收益。
7. **`HitEvent` 不含 `faction`**：阵营可从触发命中的判定圆读取（`hitboxEntityId`），
   或从攻击者读取；不把两者都塞进事件，避免"同一事实两个来源"的漂移风险。
8. **`EventQueue` 泛型默认 `HitEvent`**：`new EventQueue()` 即命中事件总线，读起来最省事；
   新增钩子（`OnKill` 等）时显式写成 `EventQueue<KillEvent>`，队列实现零改动。

---

## 11. 修订记录（Revision History）

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| rev.1 | 2026-09-28 | 程基岩 | 初版（M3-T01）：事件总线（`HitEvent` / `EventQueue`）、修饰器组件（`ModifierComponent`）、事件拦截管道（`ModifierSystem`）、宙斯普攻（`zeus_strike`）与防递归（`sourceModifier`）；`CollisionSystem` 抛事件 + 反馈按需门控；管道扩为 9 段；AC-01…AC-09 |
