# 12 · Armor & Dash Boons Spec（精英霸体机制与冲刺词缀）

| Field | Value |
|---|---|
| Spec ID | `SPEC-12-ARMOR-DASH-BOONS` |
| Milestone | **M6 · 肉鸽循环**（T02） |
| Status | `accepted`（本文件为 M6-T02 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/ArmorComponent.ts`（新）、`src/ecs/components/ModifierComponent.ts`（Poseidon 常量 + id）、`src/ecs/components/index.ts`、`src/ecs/events.ts`（`DashEvent`）、`src/ecs/modifiers/ModifierRegistry.ts`（`onDash?`）、`src/ecs/modifiers/PoseidonDashModifier.ts`（新）、`src/ecs/modifiers/index.ts`、`src/ecs/systems/DashSystem.ts`（发 `DashEvent`）、`src/ecs/systems/ModifierSystem.ts`（消费 `DashEvent`）、`src/ecs/systems/CollisionSystem.ts`（护甲结算）、`src/ecs/systems/pipeline.ts`（`dashEvents` 注入）、`src/ecs/prefabs/spawn-helpers.ts`（`armor` 选项）、`src/ecs/prefabs/EnemyFactory.ts`（`spawnElite`）、`src/ecs/rewards/RewardPool.ts`（`poseidon_dash`）、`tests/combat/armor_and_dash.test.ts`（新） |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/02_dash_and_state_spec.md`（冲刺起手门控）、`specs/03_combat_hitbox_spec.md`（判定圆 / 寿命 / 多段命中护栏）、`specs/04_combat_feedback_spec.md`（顿帧 / 硬直 / 击退 / 逐 Tick 表）、`specs/05_boon_modifier_spec.md`（变异引擎 / `EventQueue` 注入范式 / 防递归）、`specs/06_status_effect_and_dot_spec.md`（handler 扩展点）、`specs/07_enemy_ai_spec.md`（前摇 = 可打断的计划）、`specs/08_encounter_and_death_spec.md`（死亡三道门 / 房间）、`specs/11_roguelike_loop_spec.md`（奖池 / 结算 / 管道第 14 段） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

到 M6-T01 为止，引擎的「难」只有一个旋钮：**更多的敌人**（`depth` 追加副本）。所有战斗单位都是同一种可被无限打断的纸片人——任何一次命中都会写 `HITSTUN` + 击退，于是「敌人正在蓄力」这件事在玩法上**没有重量**：玩家只需乱砍就能打断一切。

M6-T02 给引擎补上两个缺失的维度：

1. **霸体（Super Armor）**：一种**可击破的护盾**。护甲在时，敌人**吃伤害但不动如山**——前摇照走、位置照站；护甲被打破的**那一击**才开始真正打断它。于是「什么时候交爆发破甲」变成一个有代价的决策。
2. **冲刺词缀（Dash Boon）**：把修饰器引擎的**事件钩子从"命中"扩展到"动作"**。新增 `onDash` 钩子 + 海神冲刺（Poseidon Dash），让「冲刺」本身成为一个可被词缀改造的玩法动词。

> 一句话判据：**「护甲」是伤害的第二层账本 + 一条硬直豁免；「冲刺词缀」是动作事件进入同一条变异引擎流水线。**

### 1.2 In Scope（做什么）

- **新增组件**：`ArmorComponent`（`current` / `max`）+ 自由函数 `applyDamageWithArmor` / `isArmored`。
- **`CollisionSystem` 结算扩展**：伤害**先扣护甲、溢出再扣 HP**；护甲未被打破前**跳过 `HITSTUN` 与 `KnockbackComponent`**，但**依然 `applyFreeze`**。
- **精英怪**：`EnemyFactory.spawnElite`（挂 `ArmorComponent` + 更大受击盒 + 更高 HP）。
- **新事件类型**：`DashEvent`（`tick` / `entityId` / `position` / `direction`）。
- **修饰器钩子扩展**：`IModifierHandler.onDash?`；`DashSystem` 在**进入 `DASHING` 的那一拍**发 `DashEvent`；`ModifierSystem` 消费并分发。
- **新词缀**：`PoseidonDashModifier`（自心大半径 / 高击退 / 低伤害 / 单 Tick 生效的冲击波判定圆），注册进 `ModifierRegistry`。
- **奖池扩展**：`REWARD_POOL` 增加 `poseidon_dash`。
- **管道注入**：新增第三条 `EventQueue<DashEvent>`，由 `createDefaultSystems` 构造并同时注入 `DashSystem`（生产）与 `ModifierSystem`（消费）。

### 1.3 Out of Scope（显式排除）

- ❌ **护甲再生 / 修复 / 护甲条 UI**：`current` 只减不增，`current === 0` 即永久破损；渲染层的护甲条留给后续里程碑。
- ❌ **护甲穿透 / 破甲加成 / 护甲类型**：没有 `armorPen` 字段，也没有「真实伤害无视护甲」这一档（DoT 仍然只走 `applyDamage`，见 §4.2 注）。
- ❌ **更多冲刺词缀**（Athena 反弹 / Zeus 落雷冲刺等）：本里程碑只落地一个参考实现 `poseidon_dash`；新增第二个只需「写 handler + 注册 + 加奖池条目」。
- ❌ **`onDash` 之外的新钩子**（`onKill` / `onRoomClear` / `onTakeDamage`）：`EventQueue` 的泛型参数就是扩展点，但本里程碑不铺开。
- ❌ **玩家自带护甲 / 护甲词缀**：`armor` 是装配选项，任何战斗单位都能带，但奖池里没有「+护甲」奖励。

---

## 2. 术语与不变量

| 术语 | 定义 |
|---|---|
| **护甲（Armor）** | `ArmorComponent.current`，位于 HP **之前**的一层可耗尽伤害缓冲 |
| **吸收（Absorbed）** | 本次伤害被护甲吃掉的部分：`min(current, damage)` |
| **溢出（Spill）** | 本次伤害穿透护甲、落到 HP 的部分：`damage - absorbed` |
| **破甲（Break）** | `current` 被某一次命中打到 `0`。**破甲当击**本身正常结算硬直与击退 |
| **霸体（Armor-through）** | 护甲在本次命中**之前**就 > 0，且本次命中**之后仍 > 0** ⇒ 该单位免疫硬直与击退 |
| **冲刺事件（DashEvent）** | 「某实体在本 Tick 进入了 `DASHING`」这一纯事实 |
| **冲击波（Blast）** | Poseidon Dash 注入的自心判定圆：大半径 / 高击退 / 低伤害 / 单 Tick 生效 |

**不变量（必须始终成立）**

- **I1（伤害守恒）**：对任意一次命中，`absorbed + spill === damage`，**逐位精确**。伤害不得被吞掉，也不得被凭空放大。
- **I2（护甲单调）**：`ArmorComponent.current` 单调不增，且恒在 `[0, max]`；`current === 0` 是永久破损（本里程碑无再生）。
- **I3（霸体只豁免硬直）**：护甲**从不**阻止伤害、**从不**阻止顿帧（`applyFreeze`）。它只阻止 `HITSTUN` 与 `KnockbackComponent` 的写入。
- **I4（无护甲 = 逐位等价）**：实体没有 `ArmorComponent`，或 `current === 0` 时，`CollisionSystem` 的结算与 M6-T01 **逐位相同**。
- **I5（一次冲刺一个事件）**：每次进入 `DASHING` **恰好**发一个 `DashEvent`；`DASHING` 不可重入，故不可能多发。
- **I6（事件总线是线，不是状态）**：两条事件总线（命中 / 冲刺）在**每个 Tick 边界都为空**（`ModifierSystem` 全量 `drain()`）。
- **I7（管道不动）**：本里程碑**不改变** 15 段管道的顺序与数量；`LifespanSystem` 恒为最后一段。
- **I8（确定性）**：`DashEvent` 的生产顺序 = 实体 id 升序（`World.query`），消费顺序 = FIFO + 持有者 `modifiers` 升序 ⇒ 同种子 / 同输入 ⇒ 逐位相同。

---

## 3. 数据契约

### 3.1 `ArmorComponent`（新，`src/ecs/components/ArmorComponent.ts`）

```ts
export const DEFAULT_ARMOR = 50;

class ArmorComponent extends ComponentBase {
  public current: number;   // 剩余护甲，单调不增
  public max: number;       // 护甲上限（仅供表现层 / 快照，逻辑层不读）
  constructor(current = DEFAULT_ARMOR, max = DEFAULT_ARMOR)
}
```

**POD**：零方法。伤害路由由自由函数完成：

```ts
interface ArmorDamageResult {
  readonly absorbed: number;        // 被护甲吃掉的部分
  readonly spill: number;           // 落到 HP 的部分
  readonly armoredThrough: boolean; // 命中前有护甲 且 命中后仍有 ⇒ 应豁免硬直/击退
}
function applyDamageWithArmor(world, id, amount): ArmorDamageResult
function isArmored(world, id): boolean   // current > 0；无组件 ⇒ false
```

`applyDamageWithArmor` 语义（**唯一的伤害入口**，`CollisionSystem` 不再直接调 `applyDamage`）：

| 前置 | 行为 | 返回 |
|---|---|---|
| 无 `ArmorComponent`，或 `current <= 0` | `applyDamage(world, id, amount)` | `{ absorbed: 0, spill: amount, armoredThrough: false }` |
| `current > 0` | `absorbed = min(current, amount)`；`current -= absorbed`；`applyDamage(world, id, spill)` | `{ absorbed, spill, armoredThrough: current > 0 }` |

- **`armoredThrough` 的判定是「命中后 `current > 0`」**，不是「命中前」。这精确对应 AC-02：**把护甲打到 0 的那一击不算霸体**，它正常触发硬直与击退。
- **`amount` 未做正数校验**：它是 `HitboxComponent.damage`，由装配层约束。`amount = 0` 时 `absorbed = spill = 0`，`armoredThrough = current > 0`，无副作用。

### 3.2 装配扩展（`spawn-helpers.ts` / `EnemyFactory.ts`）

`CombatantSpawnOptions` 增加一个 **opt-in** 字段：

| 字段 | 类型 | 语义 |
|---|---|---|
| `armor` | `number \| undefined` | 存在时挂 `ArmorComponent(armor, armor)`；**缺省时完全不挂**（M6 之前的所有战斗单位逐位不变） |

- `spawnCombatant` 对 `armor` 做 `assertPositiveFinite(armor, 'armor')`；`0` 抛 `RangeError`（"精英护甲为 0" 是配置 bug，不是合法输入）。
- 该字段与 `ai` 一样是**能力开关**：组件集仍由 `spawnCombatant` 一处定义，`PlayerFactory` / `EnemyFactory` 不各自装配。

`EnemyFactory.spawnElite(world, options: EnemySpawnOptions = {})` —— 精英怪：与 `spawn` 同组件集，外加：

| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_ELITE_ARMOR` | `60` | 默认护甲 |
| `DEFAULT_ELITE_MAX_HP` | `300` | 默认血量上限（普通敌人 `100` 的 3 倍） |
| `DEFAULT_ELITE_HURTBOX_RADIUS` | `0.8` | 默认受击盒半径（普通 `0.5`，即「更大体积」） |

三者都是**默认值**：`options` 里显式给的一律优先（`maxHp` / `hp` / `hurtboxRadius` / `armor`）。实现上是「填默认后转调 `EnemyFactory.spawn`」，**不复制装配逻辑**。

### 3.3 `DashEvent`（`src/ecs/events.ts` 扩展）

```ts
interface DashEvent {
  readonly tick: number;      // 冲刺起手那一拍的 Tick
  readonly entityId: EntityId;// 进入 DASHING 的实体
  readonly position: Vec2;    // 起手瞬间的世界坐标（冲击波以此为心）
  readonly direction: Vec2;   // 锁定的冲刺方向（单位向量）
}
```

**为什么是独立的第三条总线，而不是把 `HitEvent | DashEvent` 塞进同一条**：与 M4-T02 把死亡拆成 `EventQueue<EntityDeathEvent>` 的理由同构——**一个消费者不该被迫判别它不关心的载荷**。`EventQueue<T>` 的泛型参数就是扩展点（spec 05 §3.2 已预告 `OnDash`），第三条总线是它的第一次兑现。

`direction` 直接携带 `DashSystem` 刚写进 `VelocityComponent.directionVector` 的**锁定方向**，消费者无需重新从 `facingRadians` 推导——这也让「朝向 → 方向」的换算在引擎里只有一处。

### 3.4 `IModifierHandler.onDash?`（`ModifierRegistry.ts` 扩展）

```ts
interface IModifierHandler {
  readonly id: string;
  onHit(event: HitEvent, context: ModifierContext): void;       // 既有，仍为必选
  onDash?(event: DashEvent, context: ModifierContext): void;    // 新增，可选
}
```

- **`onHit` 保持必选**（不动既有 handler 的契约）。因此只关心冲刺的词缀（如 `poseidon_dash`）必须提供一个**显式 no-op** 的 `onHit`，并在注释里写明原因。
- `onDash` 可选 ⇒ 既有 `ZeusStrikeModifier` / `DionysusBlightModifier` **逐字不变**。

### 3.5 Poseidon Dash（`ModifierComponent.ts` 常量 + `PoseidonDashModifier.ts`）

```ts
export const POSEIDON_DASH_MODIFIER = 'poseidon_dash';

export const DEFAULT_POSEIDON_DASH_RADIUS = 3;         // 大
export const DEFAULT_POSEIDON_DASH_DAMAGE = 5;         // 低
export const DEFAULT_POSEIDON_DASH_KNOCKBACK = 40;     // 高
export const DEFAULT_POSEIDON_DASH_HITSTOP_TICKS = 0;  // 不顿帧（冲刺不能被自己冻住）
export const DEFAULT_POSEIDON_DASH_LIFESPAN_TICKS = 2; // 见 §4.4：恰好一次碰撞测试
```

`PoseidonDashModifier`（`src/ecs/modifiers/PoseidonDashModifier.ts`）：

- 在 `onDash` 里以 `event.position` 为心建一个**独立判定圆实体**：
  - `TransformComponent(position.x, position.y, atan2(direction.y, direction.x))`
  - `HitboxComponent(radius, damage, lifespan, faction, event.entityId, hitstopTicks, knockbackForce, [], POSEIDON_DASH_MODIFIER)`
- `faction` 取自冲刺者（继承阵营；同阵营不误伤，复用 AC-01 门）。
- `sourceModifier = 'poseidon_dash'` ⇒ 冲击波自己打出的命中**不会**回流进修饰器分发（spec 05 AC-04 防递归门原样生效）。
- `facingRadians` 由**锁定冲刺方向**推得（而非写死 `0`）：冲击波效果上是无向的，但这让 `CollisionSystem` 在「受击者与圆心重合」的退化情形下，把击退方向回退到**冲刺方向**而不是任意 `0`。

### 3.6 奖池扩展（`RewardPool.ts`）

`REWARD_POOL` 追加一项（**顺序固定**，便于复算）：

| id | label | 结算效果 |
|---|---|---|
| `poseidon_dash` | `Poseidon Dash` | 挂载 `poseidon_dash` 修饰器（handler 已注册） |

**`RewardSystem` 与 `grantReward` 无需任何改动**：`poseidon_dash` 是「词缀类奖励」，走 `grantReward` 末尾的通用分支（`addModifier`）。这正是 M6-T01 §10 取舍 4 预留的形状——新增词缀奖励 = 加一个池条目（§10 取舍 1）。

---

## 4. 语义

### 4.1 AC-01 · 霸体机制（Super Armor）

`CollisionSystem` 对每个 `(hitbox, target)` 命中对，伤害结算顺序改为：

1. `const result = applyDamageWithArmor(world, targetId, hitbox.damage)` —— **先护甲、溢出再 HP**；
2. `hitbox.hitEntities.push(targetId)` —— 多段命中护栏照旧（**被护甲吸收也是一次"已命中"**）；
3. **顿帧（无条件）**：`applyFreeze(target, hitstopTicks)`；攻击者同样 `applyFreeze`；
4. **硬直 + 击退（受 `result.armoredThrough` 门控）**：仅当 `armoredThrough === false` 时才写 `ActionState.HITSTUN`（`ticksInState = 1`）与 `KnockbackComponent`；
5. `HitEvent` 照常发布（`damage` = **判定圆原始伤害**，不是 spill）——命中确实发生了，只是第一层账本被护甲吃掉了。

**为什么顿帧不进门（I3）**：顿帧是**打击感**（spec 04 AC-01），不是**受击反应**。霸体敌人「被打得纹丝不动」是设计意图；「打上去毫无手感」不是。所以 `applyFreeze` 留在门外，与是否霸体无关。

**为什么 `HitEvent` 仍然发**：`HitEvent` 是「命中已发生」这一**事实**，不是「HP 掉了」的代理。挂在攻击者身上的词缀（Zeus / Dionysus）因此对精英怪照常生效——这与「护甲是伤害账本」正交。

### 4.2 AC-02 · 伤害溢出契约（Spillover）

- `absorbed = min(current, damage)`，`current -= absorbed`，`spill = damage - absorbed`，`applyDamage(world, id, spill)`。
- **破甲当击**（`current` 被打到 `0` 的那一击）：`armoredThrough === false` ⇒ **正常触发** `HITSTUN` 与 `KnockbackComponent`。
- **`damage === current` 也算破甲**（护甲归零即破），此时 `spill === 0`、HP 不变，但硬直与击退**照常**。
- **已破甲的实体**（`current === 0`）：`absorbed = 0`、`spill = damage`，此后每一击都与无护甲实体**逐位相同**（I4）。

> **DoT 与护甲**：`StatusEffectSystem` 走 `applyDamage`，**不经过护甲**（spec 06 的 DoT 契约是「真实伤害」，只调 `applyDamage`）。这是刻意的：本里程碑把护甲定义在**命中结算**这一条路径上，不把它下沉成 `applyDamage` 的全局钩子——否则「DoT 无视护甲」这条既有契约会被悄悄改写。若要支持「DoT 也被护甲吸收」，那是一次**显式**的语义变更，需要独立的 AC。

### 4.3 AC-03 · `onDash` 钩子

- `DashSystem` 在 `startDash`（状态翻成 `DASHING` 的同一处、同一拍）**发一个 `DashEvent`**。
- `DashSystem` 排在 `ModifierSystem` **之前**（管道 index 5 vs 10），所以 `DashEvent` **在同一 Tick 内**就送达消费者——不需要跨 Tick 缓冲。
- `ModifierSystem` 的消费链（与 `onHit` 同构）：

  1. `drain()` 冲刺总线；
  2. 取 `event.entityId` 的 `ModifierComponent`（无 ⇒ 跳过）；
  3. 按 `modifiers` 升序遍历，`registry.get(id)?.onDash?.(event, context)`。

- **不需要防递归门**：`DashEvent` 不携带 `sourceModifier` 溯源，因为它**不可能**由判定圆产生——判定圆没有 `IntentComponent`，永远进不了 `DASHING`。修饰器注入的实体只可能是判定圆，故 `onDash` 的嵌套深度恒为 1。
- **分发顺序**：先冲刺事件、后命中事件。理由是**忠实回放本 Tick 的管道顺序**（`DashSystem` 早于 `CollisionSystem`）。两条循环都是全量 `drain()`，故 Tick 边界两条总线都为空（I6）。

### 4.4 AC-04 · 海神冲刺（Poseidon Dash）

拥有 `poseidon_dash` 的实体**进入 `DASHING` 的那一拍**，在**自身位置**（`event.position`）生成一个冲击波判定圆：

| 属性 | 值 | 意图 |
|---|---|---|
| 半径 | `3`（默认近战判定圆 `1` 的 3 倍） | 「大半径」——一次冲刺清一小片 |
| 伤害 | `5`（默认攻击 `10` 的一半） | 「低伤害」——位移手段，不是输出手段 |
| 击退 | `40`（默认击退 `12` 的 3 倍以上） | 「高击退」——把人推走才是收益 |
| 顿帧 | `0` | 冲刺不能被自己的词缀冻住 |
| 寿命 | `2` Tick | 恰好一次碰撞测试（见下） |

**「只存在 1 个 Tick」的精确落地**：`ModifierSystem` 排在 `CollisionSystem` **之后**，所以本拍注入的判定圆**本拍不可能**被碰撞测试；`LifespanSystem`（恒 LAST）在**本拍末尾**先减 1。于是：

| 拍 | 事件 | `activeTicks`（拍末） |
|---|---|---|
| `T`（冲刺起手） | `DashSystem` 发事件 → `ModifierSystem` 注入冲击波 | `2 → 1` |
| `T+1` | `CollisionSystem` **恰好一次**碰撞测试 → 伤害 + 击退 | `1 → 0` ⇒ 销毁 |
| `T+2`+ | 不存在 | — |

`lifespan = 1` 会让它**在从未被测试前**就被销毁（静默 no-op）；`2` 是"单 Tick 生效窗口"在**本管道相位下的唯一正确写法**——与 Zeus 落雷完全同构（spec 05 §4.4）。

**击退为什么需要 `HITSTUN`**：`MovementSystem` 只在 `ActionState.HITSTUN` 分支里积分 `KnockbackComponent`（spec 04 AC-03）。冲击波 `knockbackForce > 0` ⇒ `CollisionSystem` 的反馈门打开 ⇒ 受击者进入 `HITSTUN` 并被击退。这是「把人推开」的实现路径，不是副作用。

**冲刺者不被自己的冲击波命中**：判定圆的 `faction` 继承冲刺者 ⇒ `areHostile` 为假 ⇒ 同阵营门直接跳过（spec 03 AC-01）。冲刺者身上还挂着冲刺无敌帧（`INVULNERABLE_TAG`），双重保险。

---

## 5. 管道位置

### 5.1 硬契约（**15 段**，本里程碑**零改动**）

```
TransformSnapshotSystem → PlayerControllerSystem → FreezeSystem → AISystem
  → MovementSystem → DashSystem → StateSystem → CombatActionSystem
  → CollisionSystem → StatusEffectSystem → ModifierSystem → DeathSystem
  → EncounterSystem → RewardSystem → LifespanSystem
```

### 5.2 为什么不需要动管道

- `DashSystem`（index 5）已经在 `ModifierSystem`（index 10）之前 ⇒ `DashEvent` 同 Tick 可达（§4.3）。
- `ModifierSystem` 已经在 `CollisionSystem`（index 8）之后 ⇒ 本拍注入的判定圆本拍不参与碰撞（§4.4 的相位表）。
- 因此**6 处管道钉桩测试全部不动**（spec 11 §5.3 登记的那 6 处），本里程碑只需新增 `tests/combat/armor_and_dash.test.ts` 里的相邻性断言。

### 5.3 构造函数注入（唯一的结构性改动）

`createDefaultSystems` 增加**第三个可选参数**：

```ts
createDefaultSystems(
  events: EventQueue = new EventQueue(),
  deathEvents: EventQueue<EntityDeathEvent> = new EventQueue<EntityDeathEvent>(),
  dashEvents: EventQueue<DashEvent> = new EventQueue<DashEvent>(),
): readonly System[]
```

- `dashEvents` 同时交给 `DashSystem`（生产）与 `ModifierSystem`（消费），与 `events` 交给 `CollisionSystem` / `ModifierSystem` 的形状一致（spec 05 §5.3）。
- 两条既有调用形状（`createDefaultSystems()`、`createDefaultSystems(hitEvents, deathEvents)`）**逐字不变**。
- `ModifierSystem` 的构造参数**追加**在尾部（`(events, registry, dashEvents)`），因为 `tests/combat/status_effects.test.ts` 已在用 `(events, registry)` 两参形状。
- `DashSystem` 的构造参数是新增的可选首参（`new DashSystem()` 仍然合法）。

---

## 6. 逐 Tick 契约

### 6.1 霸体（玩家在 Tick `5` 挥砍精英怪，精英怪自 Tick `0` 起进入前摇）

几何：玩家 `(0,0)` 朝向 `+x`；近战判定圆心 `(0.75, 0)` 半径 `1.0`；精英受击盒半径 `0.8` ⇒ 有效距离 `2.55`；精英在 `(1.5, 0)`。

**用例 A — 未破甲（`armor = 40`，单次伤害 `10`）**

| Tick | 事件 | `armor.current` | `hp` | `ActionState` | `AIState` / `ticksRemaining` |
|---|---|---|---|---|---|
| `0` | 距离 `1.5 ≤ attackRadius` ⇒ 进入前摇（进入拍不递减） | `40` | `300` | `IDLE` | `WINDUP` / `30` |
| `1..4` | 前摇递减 | `40` | `300` | `IDLE` | `WINDUP` / `29..26` |
| `5` | `AISystem` 递减到 `25`；`CollisionSystem` 命中 ⇒ 吸收 `10`、溢出 `0`；**顿帧照写**；**硬直/击退被豁免** | `30` | `300` | `IDLE` | `WINDUP` / `25` |
| `6..9` | 顿帧 4 拍：所有逐实体系统跳过（**前摇被暂停而非作废**） | `30` | `300` | `IDLE` | `WINDUP` / `25`（冻结不动） |
| `10` | 顿帧结束，前摇**从暂停处继续** | `30` | `300` | `IDLE` | `WINDUP` / `24` |

⇒ 「前摇未被打断」的可观测判据：`AIState` 全程 `WINDUP`、`ticksRemaining` 单调不增、且**从不**回到 `0`。

**用例 B — 破甲当击（`armor = 6`，单次伤害 `10`）**

| Tick | 事件 | `armor.current` | `hp` | `ActionState` |
|---|---|---|---|---|
| `5` | 吸收 `6`、**溢出 `4` 落到 HP**；`armoredThrough = false` ⇒ 写 `HITSTUN` + 击退 | `0` | `296` | `HITSTUN`（`ticksInState = 1`） |
| `6..9` | 顿帧：`HITSTUN` 计数不动 | `0` | `296` | `HITSTUN` |
| `10` | 顿帧结束，`AISystem` 看到 `HITSTUN` ⇒ **作废前摇**，重置 `IDLE` | `0` | `296` | `HITSTUN` |

⇒ 严格断言：`absorbed = 6`、`spill = 4`、`absorbed + spill === 10`（I1）、`hp === 300 - 4`。

### 6.2 海神冲刺（玩家在 Tick `0` 按冲刺键，敌人静止于 `(2, 0)`）

| Tick | 事件 | 冲击波 | 敌人 `hp` | 敌人 `ActionState` |
|---|---|---|---|---|
| `0` | `DashSystem` 进 `DASHING` 并发 `DashEvent`；`ModifierSystem` 注入冲击波于 `(0,0)` | 存在，`activeTicks 2→1` | `100` | `IDLE` |
| `1` | `CollisionSystem` **唯一一次**测试：距离 `2 < 3 + 0.5` ⇒ 命中 | `1→0` ⇒ 销毁 | `95` | `HITSTUN`（击退已写入） |
| `2` | `MovementSystem` 积分击退：`x += 40/60` | — | `95` | `HITSTUN` |

关键相位：**冲击波在冲刺当拍生成，在下一拍生效**（§4.4）。全程**无需按攻击键**。

---

## 7. 验收标准

| ID | 判据 | 断言位置 |
|---|---|---|
| **AC-01** | 有 `ArmorComponent` 且命中前 `current > 0`、命中后仍 `> 0` ⇒ 伤害先扣护甲（HP 不变），**跳过 `HITSTUN` 与 `KnockbackComponent`**，但**仍写顿帧**；被豁免的敌人 `AIState` 保持 `WINDUP`、`ticksRemaining` 单调不增 | `armor_and_dash.test.ts` G1 / G0 |
| **AC-02** | 单次伤害 ≥ 剩余护甲 ⇒ 护甲归零、**溢出部分精确扣 HP**（`absorbed + spill === damage`，逐位断言）；**破甲当击正常触发** `HITSTUN` + 击退，且 `AIState` 前摇被作废（重置 `IDLE` / `ticksRemaining = 0`） | `armor_and_dash.test.ts` G2 / G0 |
| **AC-03** | `IModifierHandler.onDash?` 存在；`DashSystem` 在**进入 `DASHING` 那一拍**发 `DashEvent`（`tick` / `entityId` / `position` / `direction` 精确）；`ModifierSystem` 消费并分发给**持有该词缀**的实体；总线在每个 Tick 边界为空；无冲刺 ⇒ 无事件 | `armor_and_dash.test.ts` G3 / G4 |
| **AC-04** | 持有 `poseidon_dash` 的实体冲刺瞬间，在**自身位置**生成大半径 / 高击退 / 低伤害 / 单 Tick 生效的独立判定圆；下一拍对邻近敌人造成伤害与击退；**无需按攻击键**；`sourceModifier = 'poseidon_dash'`（不回流） | `armor_and_dash.test.ts` G3 |
| **AC-05** | 管道仍为 15 段、顺序不变，`LifespanSystem` 仍最后；`ModifierSystem` 在 `DashSystem` 之后 | `armor_and_dash.test.ts` G5 |
| **AC-06** | 无 `ArmorComponent` / `current === 0` / 无冲刺词缀时，行为与 M6-T01 **逐位一致**（I4）；两条事件总线在 Tick 边界为空（I6） | `armor_and_dash.test.ts` G5 / G4 |

---

## 8. 校验与错误处理

| 场景 | 行为 |
|---|---|
| `armor` 非正有限数（含 `0`、`NaN`、`Infinity`） | `RangeError`（`assertPositiveFinite`，装配期失败） |
| `applyDamageWithArmor` 的实体无 `HealthComponent` | 护甲照常扣减；`applyDamage` 静默 no-op（既有契约） |
| `applyDamageWithArmor` 的实体无 `ArmorComponent` | 退化为纯 `applyDamage`，`absorbed = 0` |
| `amount = 0` | `absorbed = spill = 0`；`armoredThrough` 仍按 `current > 0` 判定 |
| `onDash` 的持有者无 `ModifierComponent` | 静默跳过（与 `onHit` 的持有者门同构） |
| `registry.get(id)` 无 handler，或 handler 未实现 `onDash` | 静默跳过（`?.` 可选调用） |
| `DashEvent` 的 `entityId` 无 `FactionComponent`（异常装配） | handler 静默返回，不注入任何实体 |
| 冲刺被门控拒绝（`HITSTUN` / `ATTACKING` / 冷却中 / 冻结） | **不发 `DashEvent`**——事件只描述"真的进入了 `DASHING`"，与脉冲是否被丢弃无关 |

---

## 9. 测试计划

新增 `tests/combat/armor_and_dash.test.ts`（全程**真实** `GameSimulator` + 15 段管道 + 真实预制体，**不 mock**，逐 Tick 推进）：

- **G0** 护甲原语：`applyDamageWithArmor` 的吸收 / 溢出 / 破甲 / 已破甲 / 无组件五条路径；**逐位断言 `absorbed + spill === amount`**；`damage === current` 的边界。
- **G1** 霸体（AC-01）：护甲下降、HP 不变、无 `HITSTUN`、无 `KnockbackComponent`、**顿帧照写**；`AIState` 全程 `WINDUP` 且 `ticksRemaining` 单调不增。
- **G2** 破甲（AC-02）：`absorbed` / `spill` 严格断言、HP 精确扣减、`HITSTUN` 进入、击退写入、前摇被作废。
- **G3** 海神冲刺（AC-03 / AC-04）：冲刺当拍注入冲击波（几何 / 伤害 / 半径 / 击退 / 顿帧 0 / 寿命 / 阵营 / 溯源）；下一拍造成伤害 + 击退 + `HITSTUN`；再下一拍被位移；**未按攻击键**。
- **G4** `DashEvent` 总线契约（AC-03 / I6）：字段精确、一次冲刺一个事件、长按不重复、无冲刺零事件、Tick 边界为空。
- **G5** 管道与零回归（AC-05 / AC-06）：15 段名数组 + 相邻性；无护甲实体吃满伤害；无词缀冲刺零注入。

**变异测试（门控类改动的必做步骤）**：本 Spec 的 4 处关键门各做一次变异，全部被捕获：

| 变异 | 被捕获于 |
|---|---|
| 把 `armoredThrough` 改成「命中**前** `current > 0`」（即破甲当击也霸体） | G2（`HITSTUN` 未进入） |
| 去掉 `applyDamageWithArmor` 里的 `applyDamage(spill)`（吞掉溢出伤害） | G2（`spill` 断言 + HP 精确值） |
| 把护甲门同时套在 `applyFreeze` 上（霸体也免顿帧） | G1（顿帧断言） |
| 把 `DEFAULT_POSEIDON_DASH_LIFESPAN_TICKS` 改成 `1` | G3（冲击波从未生效，HP 不变） |

---

## 10. 取舍（Trade-offs）

1. **`poseidon_dash` 只改奖池，不改 `RewardSystem` / `grantReward`**。
   收益：零改动就获得一条完整的新词缀奖励路径，且不可能与既有奖励逻辑漂移。
   代价：任务描述里点名的两个文件**没有 diff**。接受理由：M6-T01 已把「词缀类奖励 = 挂 `ModifierComponent`」做成**通用分支**，在此再插一个 `if` 只会制造一条与通用分支语义相同的死代码；「奖池条目 = 新词缀奖励」正是那张表存在的意义（§3.6）。

2. **`onHit` 保持必选，只把 `onDash` 设为可选**。
   收益：既有两个 handler 逐字不变，接口变更面最小，且 `ModifierSystem` 的 `onHit` 分发行不动。
   代价：只关心冲刺的词缀必须写一个显式 no-op `onHit`。接受理由：把 `onHit` 也改成可选会放松一个**已被两个实现遵守**的契约，为省一行 no-op 不值得。

3. **护甲不做成 `applyDamage` 的全局钩子，而是 `CollisionSystem` 的一条显式结算路径**。
   收益：DoT「真实伤害」的既有契约（spec 06）保持逐字不变；护甲的语义边界清楚（只作用于命中结算）。
   代价：`applyDamage` 的调用者不再统一——护甲实体必须走 `applyDamageWithArmor`。接受理由：DoT 无视护甲是**刻意的设计选择**（§4.2 注），把它藏进全局钩子只会让这条选择变得不可见。

4. **新增第三条 `EventQueue<DashEvent>`，而不是把命中/冲刺并成一条联合载荷总线**。
   收益：消费者不必判别自己不该关心的载荷；`onHit` 的防递归门与 `onDash` 的无门逻辑各自独立、互不污染；与 M4-T02 拆死亡总线的先例一致。
   代价：`createDefaultSystems` 多一个参数，`ModifierSystem` 多一个依赖。接受理由：泛型参数是既有的扩展点（spec 05 §3.2 已预告 `OnDash`），第三条总线是它的第一次兑现，不是新的架构。

5. **`spawnElite` 通过 `spawnCombatant` 的 `armor` opt-in 字段实现，而非自己装配组件**。
   收益：组件集仍只有一处定义，「玩家与敌人预制体不可能漂移」这条不变量继续成立。
   代价：`CombatantSpawnOptions` 多一个字段（玩家理论上也能带护甲）。接受理由：与 `ai` 完全同构——一个**能力开关**，而不是精英专属的私有通道；`EnemyFactory.spawnElite` 才是"精英"这个名字的归属地。

6. **冲击波 `hitstopTicks = 0`、`knockbackForce = 40`**。
   收益：冲刺不被自己的词缀冻住（冲刺词缀不该吃掉自己的机动性），同时 `knockbackForce > 0` 使反馈门打开 ⇒ 受击者进入 `HITSTUN` 并被真正推开。
   代价：受击者身上没有顿帧这一层「打击感」。接受理由：一个位移向的低伤害词缀，手感应由**位移**表达；顿帧留给重攻击。

---

## 11. 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| 精英怪护甲过高 ⇒ 玩家永远打不出硬直，战斗变成站桩对拼 | 护甲是**固定值**而非比例（`DEFAULT_ELITE_ARMOR = 60`），高伤 / 多段攻击能迅速破甲；破甲后**永久**失效，故战斗一定进入"可打断"阶段 |
| `armoredThrough` 误写成「命中前」判定 ⇒ 破甲当击被吞掉硬直 | G2 直接断言 `HITSTUN` 已进入（并列为变异测试第 1 项） |
| 溢出伤害被吞（护甲吃满全部伤害） | G0/G2 逐位断言 `absorbed + spill === damage`（并列为变异测试第 2 项） |
| 霸体连顿帧一起豁免 ⇒ 打击手感消失 | G1 断言命中后 `isFrozen(target) === true`（并列为变异测试第 3 项） |
| 冲击波寿命写成 `1` ⇒ 从未生效（静默 no-op） | G3 断言下一拍 HP 精确下降（并列为变异测试第 4 项） |
| `DashEvent` 跨 Tick 泄漏（未 drain） | G4 每拍断言 `dashEvents.size === 0`（I6） |
| 新增奖池条目改变同种子抽奖结果 ⇒ 既有 M6-T01 回放断言失败 | 既有回放用例均为**同代码两跑对比**（非固定字面量），故自动保持绿；`REWARD_POOL.length` 只被断言为 `≥ 3` |
