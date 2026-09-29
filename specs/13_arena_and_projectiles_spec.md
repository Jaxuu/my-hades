# 13 · Arena & Projectiles Spec（空间边界、投射物与撞墙机制）

| Field | Value |
|---|---|
| Spec ID | `SPEC-13-ARENA-PROJECTILES` |
| Milestone | **M7 · 空间与远程**（T01） |
| Status | `accepted`（本文件为 M7-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/core/math.ts`（`resolveCircleAABB`）、`src/ecs/components/WallComponent.ts`（新）、`src/ecs/components/ProjectileComponent.ts`（新）、`src/ecs/components/HitboxComponent.ts`（`destroyOnHit` / `destroyOnWall`）、`src/ecs/components/PlayerInputComponent.ts`（`CAST_KEY` / `buttonCast*`）、`src/ecs/components/IntentComponent.ts`（`wantsToCast`）、`src/ecs/components/index.ts`、`src/ecs/systems/MovementSystem.ts`（运动学积分 + 静态几何解算）、`src/ecs/systems/PlayerControllerSystem.ts`（派生 `wantsToCast`）、`src/ecs/systems/FreezeSystem.ts`（冻结清意图）、`src/ecs/systems/DeathSystem.ts`（中和意图）、`src/ecs/systems/CombatActionSystem.ts`（Cast 生成投射物）、`src/ecs/systems/CollisionSystem.ts`（`destroyOnHit`）、`tests/core/math.test.ts`（新）、`tests/physics/walls_and_projectiles.test.ts`（新） |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/01_character_controller_spec.md`（逐 Tick 位移 / `maxSpeed`）、`specs/03_combat_hitbox_spec.md`（判定圆 / `activeTicks` / 多段命中护栏）、`specs/04_combat_feedback_spec.md`（顿帧 / 硬直 / 击退相位）、`specs/07_enemy_ai_spec.md`（意图脉冲先消费后门控）、`specs/08_encounter_and_death_spec.md`（死亡门 / 尸体不位移）、`specs/12_armor_and_dash_boons_spec.md`（`applyDamageWithArmor` / 霸体豁免硬直） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

到 M6-T02 为止，竞技场是一个**无边界的平面**：实体可以走到任何坐标，坐标没有任何语义。这带来两个结构性缺口：

1. **空间没有约束** ⇒ 位移型玩法（冲刺 / 击退）没有「地形」这一层互动。一个被击飞的敌人只会无限滑走，「把它拍在墙上」这种动作游戏最基础的空间叙事无法表达。
2. **战斗只有近战** ⇒ 所有伤害都必须由攻击者「贴身」产生。判定圆是**静止的瞬时圆**（`CombatActionSystem` 在攻击者身前生成，`LifespanSystem` 到点销毁），引擎里没有任何「会自己飞」的伤害载体。

M7-T01 补上这两层：

1. **墙体与静态几何**：新增 `WallComponent`（AABB）+ 纯函数 `resolveCircleAABB`，让圆形动态实体每 Tick 移动后被静态几何**强制推出**；被击退的实体撞上墙时触发**撞墙补偿伤害**并刷新硬直（Wall-Slam）。
2. **投射物（Cast / Ranged）**：新增 `ProjectileComponent`，让「会自己飞的判定圆」成为一种独立实体——它拥有自己的 `VelocityComponent`，命中目标或撞到墙时自我销毁（无穿透）。

> 一句话判据：**「墙」把位移变成有代价的动作；「投射物」把伤害从「贴身」解放成「在空间里飞行的一段轨迹」。**

### 1.2 In Scope（做什么）

- **纯数学**：`src/core/math.ts` 新增 `resolveCircleAABB(cx, cy, radius, aabbX, aabbY, aabbW, aabbH) => [pushX, pushY]`（无第三方物理引擎，零运行时依赖）。
- **新组件**：`WallComponent`（`x` / `y` / `width` / `height`）+ 自由函数 `createWall` / `circleBodyRadius`；`ProjectileComponent`（零字段标记）+ 自由函数 `spawnProjectile` + 投射物调参常量。
- **组件扩展**：`HitboxComponent.destroyOnHit` / `destroyOnWall`；`PlayerInputComponent.CAST_KEY` / `buttonCast` / `buttonCastJustPressed`；`IntentComponent.wantsToCast`。
- **运动学积分**：`MovementSystem` 增加「无意图的自驱体」分支 —— 拥有 `ProjectileComponent` + `VelocityComponent` + `TransformComponent` 的实体按 `directionVector * maxSpeed` 自行飞行。
- **静态几何解算**：`MovementSystem` 在积分之后增加墙体解算 pass —— 逐墙 `resolveCircleAABB`、顺序推出、撞墙伤害、投射物撞墙自毁。
- **Cast 能力**：`CombatActionSystem` 消费 `wantsToCast`，生成投射物；`CollisionSystem` 支持 `destroyOnHit`（命中即销毁，无穿透）。

### 1.3 Out of Scope（显式排除）

- ❌ **任何第三方物理引擎**（Matter.js / Planck / Rapier 等）：本里程碑全部为**纯数学解析**，且必须保持确定性（ADR-001 R2）。
- ❌ **圆-圆实体间碰撞 / 实体堆叠 / 推挤**：本里程碑只做「圆 vs 静态 AABB」。实体之间依然可以重叠（这是既有契约）。
- ❌ **墙体遮挡视线 / 墙体挡伤害**：判定圆依然不受墙体遮挡（只有 `destroyOnWall` 的投射物会被墙挡下）。AI 的视线与近战判定圆都不查墙。
- ❌ **扫掠碰撞（swept collision / CCD）**：投射物每 Tick 只在其**落点**做一次离散检测。极高速投射物仍可能单 Tick 越过一个薄目标（已在 §11 登记为已知风险）。
- ❌ **旋转 AABB / 斜墙 / 多边形**：只有轴对齐矩形。
- ❌ **弹墙反弹（wall bounce）**：撞墙只做「推出 + 撞墙伤害 + 停止击退」，不做法线反射。
- ❌ **投射物专属词缀 / 充能 / 弹药 / 冷却**：Cast 是一个无冷却、无消耗的基础动作；调参留待后续里程碑。
- ❌ **墙体的渲染**：`client/` 只读逻辑层，本里程碑不新增墙的绘制（`WallComponent` 自带 AABB，表现层可自行读取）。

---

## 2. 术语与不变量

| 术语 | 定义 |
|---|---|
| **墙（Wall）** | 一个静态 AABB 包围盒，携带 `WallComponent` 的实体；AABB 即其几何本体 |
| **圆体（Circle body）** | 同时拥有 `TransformComponent` 与圆形体积（`HurtboxComponent` 或 `HitboxComponent`）的实体 |
| **动态圆体（Dynamic circle body）** | 圆体 **且** 拥有 `VelocityComponent` —— 即「会被位移的圆」，墙体解算的唯一目标集 |
| **穿透向量（Penetration vector）** | 把圆推出 AABB 所需的**最短**位移 `[pushX, pushY]`；无重叠时为 `[0, 0]` |
| **被击退（Being knocked back）** | `ActionState.HITSTUN` **且** 持有非零 `KnockbackComponent` |
| **撞墙（Wall-Slam）** | 被击退的实体在某 Tick 被墙推出，且推出方向**逆着**击退方向 ⇒ 额外的补偿伤害 + 刷新硬直 |
| **投射物（Projectile）** | 携带 `ProjectileComponent` + `VelocityComponent` + `HitboxComponent` 的自驱飞行实体 |
| **自驱（Kinematic）** | 不读 `IntentComponent`，直接由自己的 `VelocityComponent` 积分的运动方式 |

**不变量（必须始终成立）**

- **I1（解析性）**：`resolveCircleAABB` 是纯函数 —— 无 DOM、无墙钟、无随机、无 `Math.random`，同输入 ⇒ 逐位同输出。
- **I2（不重叠契约）**：解算后，动态圆体与每一面墙的圆心距 `>= radius`（即不再重叠）。容差 `1e-9`。
- **I3（顺序确定性）**：墙体解算按**实体 id 升序**、**墙 id 升序**，逐墙顺序推出（非求和），故同输入 ⇒ 同结果。
- **I4（撞墙只结算一次）**：一次撞墙接触**恰好**产生一次补偿伤害；撞墙时击退被墙吸收（速度清零），故同一接触不会在下一 Tick 重新结算。
- **I5（投射物无穿透）**：`destroyOnHit` 的投射物命中一个目标后**立即销毁**，同一投射物不可能对第二个目标造成伤害。
- **I6（投射物不穿墙）**：`destroyOnWall` 的投射物在撞墙的**当 Tick** 被销毁，且销毁发生在 `CollisionSystem` **之前**，故它不可能「穿过墙再打到墙后的目标」。
- **I7（零回归）**：没有墙、没有投射物时，`MovementSystem` 的行为与 M6-T02 **逐位相同**；`createDefaultSystems()` 仍返回**15 段**且顺序不变。
- **I8（管道不动）**：本里程碑**不新增、不重排**任何管道段；`LifespanSystem` 恒为最后一段。
- **I9（脉冲语义一致）**：`wantsToCast` 与 `wantsToDash` / `wantsToAttack` 同构 —— 单 Tick 脉冲、**先消费后门控**、门控拒绝也丢弃、绝不缓冲。
- **I10（尸体不动）**：`DeadTagComponent` 的实体不参与墙体解算（与「尸体不被位移」契约一致）。

---

## 3. 数据契约

### 3.1 `resolveCircleAABB`（`src/core/math.ts`）

```ts
function resolveCircleAABB(
  cx: number, cy: number, radius: number,     // 圆：圆心 + 半径
  aabbX: number, aabbY: number,               // AABB 左上角
  aabbW: number, aabbH: number,               // AABB 宽 / 高（> 0）
): [pushX: number, pushY: number];            // 无重叠 ⇒ [0, 0]
```

AABB 四边：`left = aabbX`、`top = aabbY`、`right = aabbX + aabbW`、`bottom = aabbY + aabbH`。

算法分三段：

1. **最近点**：`nx = clamp(cx, left, right)`、`ny = clamp(cy, top, bottom)`；`dx = cx - nx`、`dy = cy - ny`。
2. **无重叠 ⇒ `[0, 0]`**：`dx² + dy² >= radius²`（**严格小于**才算重叠，与 `CollisionSystem` 的圆-圆判据同构：贴边不算碰）。
3. **圆心在盒外**：`dist = hypot(dx, dy) > 0` ⇒ 沿 `(dx, dy)` 推到恰好贴边：`push = radius - dist`，返回 `(dx / dist * push, dy / dist * push)`。
4. **圆心在盒内（含恰好落在边界上）**：`dist === 0` ⇒ 取**最近的一面**推出。四个候选（`-x` / `+x` / `-y` / `+y`），推出量分别为
   `-(cx - left + radius)`、`(right - cx + radius)`、`-(cy - top + radius)`、`(bottom - cy + radius)`；
   取**绝对值最小者**，平手时按 `(-x, +x, -y, +y)` **先到先得**（确定性 tie-break）。

**退化输入**：`radius <= 0`、`aabbW <= 0`、`aabbH <= 0`、圆心或左上角**非有限**（`NaN` / `±Infinity`）⇒ 直接返回 `[0, 0]`（没有可解算的穿透）。该守卫让函数是**全函数**（对任意 `number` 输入都有定义），也让「宽度为 0 的墙」在数学层就不可能造成无限推出。

> **为什么圆心也必须查有限性**（而不是只查半径/尺寸）：圆心为 `NaN` 时最近点向量是 `NaN`，于是 `NaN >= radius²` 为 **`false`**，函数会掉进「包含」分支并返回 `NaN` —— 一个会静默污染它接触过的每一个坐标的毒值。这不是「多一道保险」，而是补上一个真实的可达漏洞（`tests/core/math.test.ts` M4 直接钉住）。

> **为什么放 `math.ts` 而不是新模块**：它与 `clamp` / `normalizeVec2` 同属「无状态纯函数」家族，且唯一的调用方（`MovementSystem`）已经在导入该模块。新增模块只会多一个 barrel 条目。

### 3.2 `WallComponent`（新，`src/ecs/components/WallComponent.ts`）

```ts
class WallComponent extends ComponentBase {
  public x: number;        // AABB 左上角 X
  public y: number;        // AABB 左上角 Y
  public width: number;    // > 0
  public height: number;   // > 0
  constructor(x = 0, y = 0, width = 1, height = 1)
}

interface WallSpawnOptions { x: number; y: number; width: number; height: number; }

function createWall(world, options): EntityId     // 校验 + 生成墙实体
function circleBodyRadius(world, id): number | undefined  // 动态实体的碰撞半径
```

- **墙不带 `TransformComponent`**：AABB 就是它的几何本体。这样墙既不会被 `MovementSystem` 的积分分支碰到，也不会被 `TransformSnapshotSystem` 快照，语义上「墙不是一个会动的东西」被结构表达出来。
- `createWall` 校验：`x` / `y` 必须有限；`width` / `height` 必须是**正有限数**，否则抛 `RangeError`（宽度为 0 的墙是配置 bug，不是合法输入）。
- `circleBodyRadius`：优先取 `HurtboxComponent.radius`（受击体积即身体体积），否则取 `HitboxComponent.radius`（投射物的身体就是它的判定圆），两者皆无 ⇒ `undefined`（「不是圆体」）。

### 3.3 `ProjectileComponent`（新，`src/ecs/components/ProjectileComponent.ts`）

```ts
class ProjectileComponent extends ComponentBase {}   // 零字段标记

const DEFAULT_CAST_PROJECTILE_SPEED  = 20;   // 飞行速度（世界单位/秒）
const DEFAULT_CAST_HITBOX_RADIUS     = 0.4;  // 判定圆半径
const DEFAULT_CAST_DAMAGE            = 8;    // 命中伤害
const DEFAULT_CAST_LIFESPAN_TICKS    = 60;   // 寿命（1 秒 @60fps）
const DEFAULT_CAST_HITSTOP_TICKS     = 0;    // 不顿帧（见 §4.4）
const DEFAULT_CAST_KNOCKBACK         = 6;    // 命中击退
const DEFAULT_CAST_SPAWN_OFFSET      = 0.5;  // 出生点沿朝向的前置偏移

interface ProjectileSpawnOptions {
  readonly x: number; readonly y: number;
  readonly directionRadians: number;
  readonly faction: Faction;
  readonly ownerEntityId: EntityId;
  readonly speed?: number; readonly radius?: number; readonly damage?: number;
  readonly lifespanTicks?: number; readonly knockback?: number;
}

function spawnProjectile(world, options): EntityId
```

**为什么是零字段标记**（与 `DeadTagComponent` 同构）：投射物的**一切**都由既有组件表达 —— 位置/朝向在 `TransformComponent`、速度在 `VelocityComponent`、伤害/寿命/护栏在 `HitboxComponent`。`ProjectileComponent` 的唯一职责是**身份**：它让 `MovementSystem` 能问「哪些实体是自驱的」而不必用「有速度但没有意图」这种**否定式**判据（否定式判据会在未来任何新增的无意图实体上悄悄放行）。

`spawnProjectile` 装配的组件集（**唯一装配点**）：

| 组件 | 值 |
|---|---|
| `TransformComponent` | `(x + cos(dir) * offset, y + sin(dir) * offset, dir)` |
| `VelocityComponent` | `maxSpeed = speed`、`currentSpeed = speed`、`directionVector = (cos dir, sin dir)` |
| `HitboxComponent` | `radius`、`damage`、`lifespanTicks`、`faction`、`ownerEntityId`、`hitstopTicks = 0`、`knockbackForce = knockback`、`hitEntities = []`、`sourceModifier = null`、`destroyOnHit = true`、`destroyOnWall = true` |
| `ProjectileComponent` | 标记 |

### 3.4 `HitboxComponent` 扩展（`destroyOnHit` / `destroyOnWall`）

```ts
class HitboxComponent {
  // ...既有字段不变...
  public destroyOnHit: boolean;    // 命中一个目标后立即自毁（无穿透）
  public destroyOnWall: boolean;   // 被墙推出后立即自毁（不穿墙）
  constructor(radius, damage, activeTicks, faction, ownerEntityId,
              hitstopTicks = DEFAULT_HITSTOP_TICKS,
              knockbackForce = DEFAULT_KNOCKBACK_FORCE,
              hitEntities = [], sourceModifier = null,
              destroyOnHit = false, destroyOnWall = false)   // 追加在尾部
}
```

- 两个新字段**追加在构造参数尾部**且默认 `false` ⇒ 既有的 4 处 `new HitboxComponent(...)` 调用（`CombatActionSystem` / `ZeusStrikeModifier` / `PoseidonDashModifier` / 测试）**逐字不变**，近战判定圆与词缀判定圆的行为**逐位不变**（默认不自毁）。
- 语义分工：`destroyOnHit` / `destroyOnWall` 描述「这个判定圆的生命周期如何被接触事件终结」，属于判定圆自身；`ProjectileComponent` 描述「这个实体自己会飞」。

### 3.5 输入 / 意图扩展

```ts
// PlayerInputComponent.ts
export const CAST_KEY = 'cast';
class PlayerInputComponent {
  public buttonCast: boolean;              // level（由 keysHeld 派生）
  public buttonCastJustPressed: boolean;   // edge（恰好一 Tick 宽）
  constructor(moveVector, keysHeld, buttonDash, buttonDashJustPressed,
              buttonAttack, buttonAttackJustPressed,
              buttonCast = false, buttonCastJustPressed = false)   // 追加在尾部
}

// IntentComponent.ts
class IntentComponent {
  public wantsToCast: boolean;   // 单 Tick 脉冲；消费者读后清零
  constructor(moveVector, wantsToDash, wantsToAttack, aimRadians,
              wantsToCast = false)                                  // 追加在尾部
}
```

追加式扩展 ⇒ 既有 `new IntentComponent()` / `new PlayerInputComponent()` 调用形状不变。

---

## 4. 语义

### 4.1 AC-01 · 墙体阻挡（Wall Collision）

`MovementSystem` 在**积分之后**追加一个墙体解算 pass。目标集 = 动态圆体：

```
world.query(TransformComponent, VelocityComponent)
  ∧ circleBodyRadius(world, id) !== undefined
  ∧ !isDead(world, id)
```

对每个目标，**按墙 id 升序**逐墙处理（**顺序推出**，不是把多面墙的推量求和）：

```
for (const wall of walls) {
  const [px, py] = resolveCircleAABB(t.x, t.y, radius, wall.x, wall.y, wall.width, wall.height);
  if (px !== 0 || py !== 0) { t.x += px; t.y += py; pushed = true; }
}
```

**为什么顺序推出而不是求和**：求和会把「墙角」两面墙的推量相加，若两推量部分抵消就会留下残余穿透；顺序推出在每一面墙上都重新读一次**已更新**的坐标，因此墙角天然收敛。两方案都确定性，但顺序推出不需要迭代。

**为什么只算「动态」圆体**：静止的判定圆（近战 / Zeus / Poseidon）没有 `VelocityComponent`，它不会「走」进墙里，也就没有可解算的穿透；把它排除让解算集恰好等于「会被位移的东西」。

**为什么墙体解算不查冻结 / 硬直**：解算不是「动作」，而是**几何不变量**（I2）。而且冻结相位已经保证了「冻结中的实体不会新产生穿透」——`MovementSystem` 的冻结分支在积分之前就 `continue` 了，而击退只在解冻后才被积分。故不需要额外的门，少一道门就少一处可能掩盖测试空洞的冗余。

**尸体不参与**（I10）：与「尸体不被位移」契约一致 —— 撞死在墙里的尸体会保持穿模，这是刻意的（`DeadTagComponent` 是绝对跳过理由）。

### 4.2 AC-02 · 撞墙伤害（Wall-Slam）

同一次解算中，若某实体 `pushed === true` 且满足**被击退**判据，则结算一次撞墙：

```
被击退(id) := StateComponent.state === HITSTUN
            ∧ KnockbackComponent 存在
            ∧ (kb.velocity.x !== 0 || kb.velocity.y !== 0)
撞墙条件   := pushed ∧ 被击退(id) ∧ dot(push, kb.velocity) < 0
```

撞墙的三个后果（同一处、同一拍）：

1. `applyDamageWithArmor(world, id, DEFAULT_WALL_SLAM_DAMAGE)` —— **唯一的伤害入口**，与 `CollisionSystem` 的结算路径一致（先护甲、溢出再 HP）。
2. **刷新硬直**：`state.state = HITSTUN`、`state.ticksInState = 0`。
3. **墙吸收击退**：`kb.velocity = (0, 0)`。

**为什么需要 `dot(push, kb) < 0`（推出方向逆着击退）**：这是「被墙**阻挡**」的精确读法 —— 墙把你的运动**顶回去**了。若一个实体被击退着**贴着**墙面滑行，推出向量与击退速度垂直（`dot ≈ 0`），它并没有被墙「拍」到，不该吃撞墙伤害。

**为什么必须把击退清零（I4）**：`MovementSystem` 的 `HITSTUN` 分支每 Tick 都会积分 `kb.velocity`。若不清零，实体在硬直期间会**每一 Tick** 重新撞进墙里 ⇒ 每一 Tick 都结算一次撞墙伤害（8 拍 = 8 次），这显然不是「一次撞墙」。清零让「墙吸收击退」成为物理上最自然、也最省状态的表达（不需要额外的「已撞过」标记）。

**为什么刷新硬直用 `ticksInState = 0`（而不是 `CollisionSystem` 的 `1`）**：`MovementSystem` 排在 `StateSystem` **之前**，所以本拍写入的状态**会被本拍的 `StateSystem` 计入**（与 `DASHING` / `ATTACKING` 同相）。种 `0` 让本拍被 `StateSystem` 递增到 `1`，从而可观测硬直跨度恰好等于 `DEFAULT_HITSTUN_TICKS`（8 拍）。`CollisionSystem` 种 `1` 是因为它排在 `StateSystem` **之后**（进入拍不计入）—— 两处相位不同，故补偿不同，这不是不一致而是同一条相位规则的两个侧面。

**为什么撞墙走 `applyDamageWithArmor`**：与所有命中结算共用唯一入口，护甲语义（先扣护甲、溢出再 HP）自动生效，不需要第二条伤害路径。注意一个**已被既有契约决定**的推论：站立护甲会豁免 `HITSTUN`（spec 12 AC-01），而撞墙判据**要求** `HITSTUN` ⇒ 能吃到撞墙伤害的身体，其护甲必然已经破损（`current === 0`）。所以撞墙伤害在实践上总是落到 HP；`applyDamageWithArmor` 在这里是「语义正确的入口」而非「会产生吸收的入口」。

**不做顿帧**：撞墙只做「伤害 + 刷新硬直」，不写 `applyFreeze`。理由是撞墙的**打击感**由「硬直刷新 + 击退骤停」表达，再加一层顿帧会让连续撞墙的战斗节奏变得粘滞；且撞墙是 `MovementSystem` 内的几何后果，不是一次「命中」，不携带 `hitstopTicks` 这一概念。

### 4.3 AC-03 · 投射物（Cast）

- **输入**：`PlayerControllerSystem` 在 phase 1 从 `keysHeld` 派生 `buttonCast`（level）与 `buttonCastJustPressed`（edge，`cast` 键的释放→按下跃迁）；在 phase 2 把 edge 写进 `intent.wantsToCast`。抽奖压制（spec 11 AC-02）与冻结（`FreezeSystem`）、死亡（`DeathSystem`）都会把 `wantsToCast` 清零。
- **生成**：`CombatActionSystem` **先消费后门控** —— 无条件读并清零 `wantsToCast`，然后门控 `DASHING` / `ATTACKING` / `HITSTUN`（与 `wantsToAttack` 同一条门）。门控通过则调 `spawnProjectile`。
- **同拍双脉冲**：若 `wantsToAttack` 与 `wantsToCast` 在同一 Tick 都为真，**攻击优先**，Cast 脉冲已被消费 ⇒ 丢弃（一 Tick 一个动作）。两者都已被消费，故不会留到下一 Tick。
- **Cast 不改变 `ActionState`**：投射物是「放出去就不管」的异步伤害，不占用攻击承诺窗口。代价是 Cast 目前没有承诺成本（§10 取舍 2）。

### 4.4 AC-04 · 投射物生命周期

投射物有两套终结路径，**都是即时销毁**（`world.destroyEntity`）：

| 事件 | 处理点 | 行为 |
|---|---|---|
| 命中目标（`destroyOnHit`） | `CollisionSystem` | 结算伤害 + 反馈 + `HitEvent` 之后**立即销毁**，并 `break` 出目标循环 |
| 撞到墙（`destroyOnWall`） | `MovementSystem` 墙体解算 | 被墙推出的当拍**立即销毁** |

- **命中即销毁（I5）**：`break` 出目标循环 + 实体已销毁 ⇒ 同一投射物**不可能**命中第二个目标，也不需要 `hitEntities` 护栏来防穿透（护栏仍然写入，作为「这一拍到底打了谁」的审计痕迹）。
- **撞墙即销毁（I6）**：解算在 `MovementSystem`（管道 index 4），`CollisionSystem` 在 index 8 —— 所以撞墙的投射物**在当拍的碰撞测试之前**就已消失，物理上不可能「穿过墙再打到墙后的目标」。
- **`hitstopTicks = 0`（§4.4 的关键取舍）**：`CollisionSystem` 的反馈门是 `hitstopTicks > 0 || knockbackForce > 0`。投射物取 `hitstopTicks = 0`、`knockbackForce = 6` ⇒ 门开、**受击者**进入 `HITSTUN` 并被推开，而**施法者**不会被 `applyFreeze(owner, 0)` 冻住（`applyFreeze` 对 `<= 0` 是 no-op）。若投射物带顿帧，远处放一枪就会把施法者原地冻住 —— 那是一个明确的 bug 而不是手感。
- **寿命兜底**：投射物带 `HitboxComponent`，故 `LifespanSystem`（恒 LAST）会每拍递减 `activeTicks`；什么都没碰到时它在 `DEFAULT_CAST_LIFESPAN_TICKS` 拍后自然消亡。

---

## 5. 管道位置

### 5.1 硬契约（**15 段**，本里程碑**零改动**）

```
TransformSnapshotSystem → PlayerControllerSystem → FreezeSystem → AISystem
  → MovementSystem → DashSystem → StateSystem → CombatActionSystem
  → CollisionSystem → StatusEffectSystem → ModifierSystem → DeathSystem
  → EncounterSystem → RewardSystem → LifespanSystem
```

**本里程碑不新增管道段**（I8）。任务书允许「`MovementSystem` 或紧随其后的 `PhysicsResolutionSystem`」两种落法；本 Spec 选择**扩展 `MovementSystem`**，理由见 §10 取舍 1。

### 5.2 为什么扩展 `MovementSystem` 就够

- 墙体解算**必须**发生在「本拍所有位移之后、`CollisionSystem` 之前」。位移的唯一写者是 `MovementSystem`（含它的新自驱分支），而 `CollisionSystem` 在 index 8 —— 所以「`MovementSystem` 的尾部」恰好是唯一的、且是正确的位置。
- 撞墙伤害发生在 index 4，早于所有伤害来源，故 `DeathSystem`（index 11）依然看到本拍**最终**的 `hp`：撞死在墙上与被打死走同一条死亡路径，不需要特殊处理。
- 投射物的自驱积分也放在 `MovementSystem`（同一个「推进位置」的语义边界内），于是「移动」这件事依然只有一个系统、一个相位。

### 5.3 副作用（已在 §10 登记的代价）

`MovementSystem` 现在承担三件事：① 意图驱动的战斗单位积分（M1 既有）；② 无意图的自驱体积分；③ 静态几何解算及其后果（撞墙 / 投射物撞墙）。这是把「位置推进」这一个**相位**完整地收在一个系统里，代价是这个系统变长。

---

## 6. 逐 Tick 契约

### 6.1 墙体阻挡（玩家自 `(0, 0)` 持续向 `+x` 输入；墙 AABB = `x:3, y:-5, w:2, h:10`）

玩家 `maxSpeed = 5` ⇒ 每拍 `5/60 ≈ 0.0833`；玩家受击盒半径 `0.5` ⇒ 极限圆心 `x = 3 - 0.5 = 2.5`。

| Tick | 事件 | `transform.x` |
|---|---|---|
| `0..29` | 自由前进（`30 × 0.0833 = 2.5`） | `0 → 2.5` |
| `30` | 走到 `2.5`，恰好贴住（`dist === radius`，**不算重叠**） | `2.5`（不再增长） |
| `31+` | 每拍尝试前进 `0.0833` 后被推出 `0.0833` | `2.5`（恒定） |

⇒ 可观测判据：`x` 单调不减、上界恒为 `2.5`，且**从未**出现 `x > 2.5`（无穿模）。

### 6.2 海神壁咚（Poseidon Wall-Slam）

几何：玩家 `(0, 0)` 朝 `+x`，带 `poseidon_dash`；精英（`armor = 3`、`maxHp = 300`、受击盒 `0.8`）在 `(2, 0)`；墙 AABB = `x:3, y:-5, w:2, h:10`。冲击波半径 `3`、伤害 `5`、击退 `40`、顿帧 `0`。

| Tick | 事件 | 精英 `armor` | 精英 `hp` | 精英 `ActionState` | 精英 `x` |
|---|---|---|---|---|---|
| `0` | 冲刺起手；`ModifierSystem` 在 `(0,0)` 注入冲击波（`activeTicks 2→1`） | `3` | `300` | `IDLE` | `2` |
| `1` | 冲击波唯一一次碰撞测试：`2 < 3 + 0.8` ⇒ 命中。吸收 `3`、溢出 `2`；**破甲当击** ⇒ 写 `HITSTUN`(`ticksInState=1`) + 击退 `(40, 0)`；冲击波 `1→0` ⇒ 销毁 | `0` | `298` | `HITSTUN` | `2` |
| `2` | `MovementSystem` 积分击退：`2 + 40/60 ≈ 2.667` ⇒ 与墙重叠（右缘 `3.467 > 3`）⇒ 推出回 `2.2`（`= 3 - 0.8`）⇒ **撞墙**：`applyDamageWithArmor(12)`（护甲已 0 ⇒ 全落 HP）、刷新 `HITSTUN`(`ticksInState=0`→`StateSystem` 递增为 `1`)、击退清零 | `0` | `286` | `HITSTUN` | `2.2` |
| `3..9` | 硬直续走（击退已清零 ⇒ 不再位移，不再重复撞墙）；`ticksInState` 从 `2` 走到 `8` | `0` | `286` | `HITSTUN` | `2.2` |
| `10` | `ticksInState >= 8` ⇒ 硬直结束（可观测跨度恰为 8 拍：`2..9`） | `0` | `286` | `IDLE` | `2.2` |

⇒ 严格断言：`absorbed = 3`、`spill = 2`、`absorbed + spill === 5`（spec 12 I1）、`hp === 300 - 2 - 12`、`armor === 0`、撞墙伤害**恰好一次**。

### 6.3 投射物飞行、命中与撞墙

几何：玩家 `(0, 0)` 朝 `+x`；投射物速度 `20`（每拍 `1/3`）、半径 `0.4`、伤害 `8`、击退 `6`、寿命 `60`。

**用例 A — 命中敌人即销毁（无穿透）**：敌人 `A` 在 `(3, 0)`、敌人 `B` 在 `(6, 0)`（都静止、无 AI）。

| Tick | 事件 | 投射物 | `A.hp` | `B.hp` |
|---|---|---|---|---|
| `0` | 按 Cast；`CombatActionSystem` 生成投射物于 `(0.5, 0)`；`CollisionSystem` 当拍测试（距离 `2.5 > 0.4 + 0.5` ⇒ 未命中）；`LifespanSystem` 寿命 `60→59` | 存活 | `100` | `100` |
| `1..4` | 每拍前进 `1/3`：`0.833 → 1.833`（距离 `A` 仍 `> 0.9`） | 存活 | `100` | `100` |
| `5` | 前进到 `2.167`；距离 `A` 为 `0.833 < 0.9` ⇒ **命中** ⇒ `A.hp -= 8`、`A` 进 `HITSTUN` + 击退 `(6, 0)`；`destroyOnHit` ⇒ 投射物**立即销毁** | **销毁** | `92` | `100` |
| `6..25` | 投射物已不存在（若无护栏，它会在 Tick `14` 前后抵达 `B`） | — | `92` | `100` |

⇒ 关键断言：投射物在命中拍消失；`B.hp` 全程 `100`（**无穿透**）；`A` 恰好被扣一次 `8`；施法者**未**被顿帧（`hitstop = 0`）。

**用例 B — 撞墙即销毁（不穿墙）**：墙 AABB = `x:4, y:-5, w:2, h:10`；无敌人。

| Tick | 事件 | 投射物 `x` | 投射物 |
|---|---|---|---|
| `0` | 生成于 `(0.5, 0)` | `0.5` | 存活 |
| `1..9` | 每拍 `+1/3` ⇒ `0.833 … 3.5`（距离墙面 `0.5 > 0.4`） | `3.5` | 存活 |
| `10` | 前进到 `3.833`；与墙重叠（`3.833 + 0.4 > 4`）⇒ 推出回 `3.6`（`= 4 - 0.4`）⇒ `destroyOnWall` ⇒ **立即销毁** | — | **销毁** |

⇒ 关键断言：投射物在撞墙拍消失；若把它改成 `destroyOnWall = false`（测试用的观测装置），它的落点**恒**为 `3.6`，**从未**越过墙面（`tests/physics/walls_and_projectiles.test.ts` G6 用这种方式直接钉住「不穿墙」）。

---

## 7. 验收标准

| ID | 判据 | 断言位置 |
|---|---|---|
| **AC-01** | `WallComponent`（AABB）+ `resolveCircleAABB` 存在；动态圆体每 Tick 移动后与所有墙解算，重叠时按最短穿透向量被推出；持续输入下坐标停在「圆边刚好贴住 AABB」处，**无穿模**（I2） | `walls_and_projectiles.test.ts` G1；`math.test.ts` |
| **AC-02** | 被击退（`HITSTUN` + 非零 `KnockbackComponent`）且被墙推出（`dot(push, kb) < 0`）⇒ 结算 `DEFAULT_WALL_SLAM_DAMAGE`（走 `applyDamageWithArmor`）并刷新 `HITSTUN`；击退被清零 ⇒ 一次接触**只结算一次**（I4） | `walls_and_projectiles.test.ts` G2 / G3 |
| **AC-03** | `PlayerInputComponent.buttonCastJustPressed` / `IntentComponent.wantsToCast` 存在；`CombatActionSystem` 消费 `wantsToCast` 并生成带 `Transform` + `Velocity` + `Hitbox` + `ProjectileComponent` 的飞行实体；自驱飞行（无 `IntentComponent`）；脉冲先消费后门控、不缓冲（I9） | `walls_and_projectiles.test.ts` G4 / G5 |
| **AC-04** | 命中目标（`destroyOnHit`）或撞到墙（`destroyOnWall`）⇒ **当 Tick 立即销毁**；命中只对**单个**目标造成一次伤害（无穿透，I5）；撞墙销毁发生在 `CollisionSystem` 之前（I6） | `walls_and_projectiles.test.ts` G5 / G6 |
| **AC-05** | `resolveCircleAABB` 的**完备单元测试**：四边、四角、包含关系、无重叠、贴边不算碰、退化输入、平手 tie-break（I1） | `math.test.ts`（独立套件） |
| **AC-06** | 无墙 / 无投射物时行为与 M6-T02 **逐位一致**（I7）；`createDefaultSystems()` 仍为 15 段且顺序不变（I8） | `walls_and_projectiles.test.ts` G7 |

---

## 8. 校验与错误处理

| 场景 | 行为 |
|---|---|
| `createWall` 的 `width` / `height` 非正有限数 | `RangeError`（装配期失败，不生成实体） |
| `createWall` 的 `x` / `y` 非有限数 | `RangeError` |
| `spawnProjectile` 的 `speed` / `radius` / `lifespanTicks` / `knockback` 非法 | `RangeError`（`speed` / `radius` 正有限；`lifespanTicks` 正整数；`knockback` 非负有限） |
| `resolveCircleAABB` 的 `radius <= 0` / `aabbW <= 0` / `aabbH <= 0` / 任一 `NaN` | 返回 `[0, 0]`（退化输入，无穿透可解） |
| 圆体与墙**恰好贴边**（`dist === radius`） | 不算重叠，返回 `[0, 0]`（与圆-圆判据同构） |
| 实体带 `KnockbackComponent` 但**不在** `HITSTUN`（陈旧击退） | **不**触发撞墙（「被击退」判据要求 `HITSTUN`） |
| 实体在 `HITSTUN` 但击退速度为 `(0, 0)` | **不**触发撞墙（判据要求非零速度） |
| 击退方向与推出方向**垂直**（贴墙滑行） | **不**触发撞墙（`dot < 0` 不成立） |
| 动态圆体没有 `HurtboxComponent` 也没有 `HitboxComponent` | 不参与墙体解算（不是圆体） |
| 投射物在命中同拍被销毁后，`LifespanSystem` 再次处理它 | 不可能：实体已从世界移除，`World.query` 不再产出它 |
| 投射物的 `ownerEntityId` 已被销毁 | `CollisionSystem` 的 owner 门读 `isDead`（对已销毁 id 返回 `false`）⇒ 投射物**照常工作**（既有契约：判定圆独立于其所有者） |

---

## 9. 测试计划

**新增 `tests/core/math.test.ts`** —— `resolveCircleAABB` 的独立纯函数套件（AC-05）：

- **M0** 无重叠：圆在墙的左侧 / 右侧 / 上方 / 下方，距离大于半径 ⇒ `[0, 0]`；恰好贴边 ⇒ `[0, 0]`。
- **M1** 四边：从四个方向各推进 `radius - ε` ⇒ 推出向量恰好把圆推到贴边（`|push| === radius - dist`，方向正确）。
- **M2** 四角：从四个角外侧重叠 ⇒ 推出沿对角方向，推出后 `hypot(dx, dy) === radius`。
- **M3** 包含关系（圆心在盒内）：中心 / 偏向四面的各点 ⇒ 沿**最近面**推出，推出后圆心距该面 `=== radius`。
- **M4** 退化输入：`radius = 0` / 负 / `NaN`；`aabbW = 0` / 负；`aabbH = 0` ⇒ 全部 `[0, 0]`。
- **M5** 平手 tie-break：圆心恰在盒中心（四边等距）⇒ 恒取 `-x`（先到先得，确定性）；同一输入重复调用 ⇒ 逐位相同。

**新增 `tests/physics/walls_and_projectiles.test.ts`** —— 全程**真实** `GameSimulator` + 15 段管道 + 真实预制体，**不 mock**，逐 Tick 推进（AC-01 .. AC-04 / AC-06）：

- **G0** `WallComponent` / `createWall` / `circleBodyRadius` 原语与校验；`DEFAULT_WALL_SLAM_DAMAGE` 的**字面量**钉桩。
- **G1** 运动阻挡（AC-01）：持续输入 ⇒ 坐标停在 `wallLeft - radius`；断言 `x <= 上限 + 1e-9` 全程成立且单调不减；无墙时 `x = maxSpeed`（零回归）；背向墙不阻挡；向左对称阻挡。
- **G2** 海神壁咚（AC-02）：`armor = 3` 精英贴墙；断言破甲溢出精确（`absorbed = 3` / `spill = 2`）、撞墙伤害恰好一次、`HITSTUN` 被刷新（`ticksInState = 1`，跨度 8 拍）、击退被清零、施法者未被自己的词缀伤害；冲刺者撞同一面墙但**不**被撞墙（无击退通道）。
- **G3** 撞墙判据的边界（AC-02）：① 无 `KnockbackComponent` 的普通撞墙 ⇒ 无伤害；② 陈旧击退（不在 `HITSTUN`）⇒ 无伤害；③ 击退与推出垂直（贴墙滑行）⇒ 无伤害且击退**未被吸收**；④ 孤立的正向用例（`HITSTUN` + 逆向击退）⇒ 恰好一次伤害。
- **G4** Cast 装配（AC-03）：投射物的组件集 / 字段精确（速度 / 半径 / 伤害 / 寿命 / 击退 / 顿帧 0 / `destroyOnHit` / `destroyOnWall` / `sourceModifier === null` / 阵营 / 所有者）；出生点带前置偏移；沿朝向飞行；**无 `IntentComponent`**；调参**字面量**钉桩；近战攻击**不**生成投射物。
- **G5** 飞行与命中（AC-03 / AC-04）：自驱飞行逐拍位移；命中敌人 ⇒ 伤害一次 + 投射物销毁；远处第二个敌人 `hp` 不变（**无穿透**）；施法者**未**被顿帧；无目标时按寿命自然消亡。
- **G6** 撞墙（AC-04）：投射物撞墙当拍销毁；把 `destroyOnWall` 关掉后落点恒为 `wallLeft - radius`（**直接钉住不穿墙**）；墙后的敌人全程满血（撞墙销毁先于碰撞测试）。
- **G7** 管道与零回归（AC-06）：15 段名数组 + 相邻性；无墙无投射物时 `MovementSystem` 逐位等价（同输入两跑快照相等）；Cast 脉冲门控（冲刺中 / 硬直中按下 ⇒ 丢弃不缓冲）。

**变异测试（门控类改动的必做步骤）**：本 Spec 的 7 处关键点各做一次变异，**全部被捕获**（实测记录）：

| # | 变异 | 被捕获于（失败断言数） |
|---|---|---|
| M1 | `resolveCircleAABB` 把 `distSq >= radius²` 改成 `>`（贴边也算碰） | `math.test.ts` M0（贴边断言 `[0,0]`）· 2 |
| M2 | 去掉撞墙时的 `knockback.velocity = (0,0)`（不吸收击退） | G2（撞墙伤害每拍重复结算）· 2 |
| M3 | 去掉 `dot(push, kb) < 0` 守卫 | G3③（贴墙滑行被误判撞墙）· 1 |
| M4 | `CollisionSystem` 不处理 `destroyOnHit`（允许穿透） | G5（第二个敌人也被扣血）· 1 |
| M5 | 把 `DEFAULT_CAST_HITSTOP_TICKS` 改成 `4` | G4 调参钉桩 + G5（施法者被自己的投射物冻住）· 3 |
| M6 | 把 `DEFAULT_WALL_SLAM_DAMAGE` 改成 `11` | G0 调参钉桩 + G2（HP 精确值）· 2 |
| M7 | 把 `DEFAULT_CAST_PROJECTILE_SPEED` 改成 `21` | G4 调参钉桩 + G5（逐拍位移）· 2 |

> **M5 的第一轮实测是「未被捕获」，这是一次真实发现**：最初的 G4 断言写成 `hitbox.hitstopTicks === DEFAULT_CAST_HITSTOP_TICKS` —— 用**构造该字段的同一个常量**去校验它，是一条恒真断言（重调常量时组件和断言一起变）。修正方式是把调参以**字面量**单独钉住（`DEFAULT_CAST_* === [20, 0.4, 8, 60, 0, 6, 0.5]`、`DEFAULT_WALL_SLAM_DAMAGE === 12`），并补上「施法者未被自己的投射物冻住」这条**行为**断言。这正是变异测试存在的理由：它抓到的不是实现 bug，而是一条掩盖空洞的测试。

---

## 10. 取舍（Trade-offs）

1. **扩展 `MovementSystem` 而不是新增 `PhysicsResolutionSystem` 段**。
   收益：15 段硬契约（I8）与 6 处管道钉桩测试（`feedback` / `boons` / `status_effects` / `death_and_encounter` / `armor_and_dash` / `enemy_fsm` 的 `toEqual` 名数组）**零改动**，回归面最小；且「本拍位移的尾部」本来就是解算的唯一正确位置。
   代价：`MovementSystem` 从「积分」变成「积分 + 解算」，职责变宽（§5.3）。
   接受理由：管道顺序在本工程是**硬契约**（记忆中的铁律），为了「一个更短的系统」去改 6 处 QA 钉桩并把 15 段变成 16 段，是拿最大的回归风险换最小的可读性收益。任务书本身也把这条路径列为首选。

2. **Cast 不占用 `ActionState`、无冷却、无消耗**。
   收益：投射物是异步伤害，不写状态机就不会污染「攻击承诺窗口」这条既有相位契约（`ATTACKING` 的 12 拍语义保持单一含义）。
   代价：玩家可以「贴脸连点 Cast」而无成本。
   接受理由：本里程碑的 AC 只要求「能生成并飞行、命中即销毁」。加承诺窗口需要一个新的 `CastStatsComponent` 与一条新的状态分支，属于**独立**的玩法设计（并会再次牵动状态机相位），不该塞进 T01。

3. **撞墙伤害走 `applyDamageWithArmor`，而不是绕过护甲的「真伤」**。
   收益：与所有命中结算共用唯一入口，护甲语义自动一致，不需要第二条伤害路径。
   代价：字面上「真实伤害」暗示无视护甲，而这里会被护甲吸收 —— 但由于 `HITSTUN` 已被站立护甲豁免，撞墙判据的**前提**就排除了「有站立护甲」的实体，所以实际结果与「真伤」相同（§4.2）。
   接受理由：任务书显式指定 `applyDamageWithArmor`；且共用入口比「为撞墙再造一条伤害路径」更不容易漂移。

4. **`ProjectileComponent` 是零字段标记，而不是把速度/寿命放进去**。
   收益：不重复表达既有数据（位置在 `Transform`、速度在 `Velocity`、伤害/寿命在 `Hitbox`），不可能与它们漂移；`MovementSystem` 的自驱判据是**肯定式**的（「有 `ProjectileComponent`」）而不是否定式的（「有速度但没意图」）。
   代价：多一个组件类型、多一条 barrel 导出。
   接受理由：与 `DeadTagComponent` 同构的先例；否定式判据会在未来任何新增的无意图实体上悄悄放行，那才是真正的风险。

5. **撞墙时把击退清零，而不是反射（bounce）**。
   收益：一次接触只结算一次（I4），不需要额外的「已撞过」标记；确定性最强；「被拍在墙上」的叙事由「硬直刷新 + 击退骤停」表达。
   代价：没有弹墙位移，少了一层动作观赏性。
   接受理由：反射需要选择法线（墙角的两面墙怎么办？）、需要决定能量保留率，都是**新的玩法设计**；T01 的 AC 只要「额外伤害 + 刷新硬直」。

6. **墙体解算按顺序逐墙推出，而不是把多面墙的推量求和后一次施加**。
   收益：墙角天然收敛（每面墙都读到已更新的坐标），不需要迭代，也不需要「重叠墙」的额外约定。
   代价：结果依赖墙的**遍历顺序**（已固定为 id 升序，故确定）。
   接受理由：确定性由 id 升序保证（I3），而求和方案在墙角会留下残余穿透。

7. **投射物不参与圆-圆实体间碰撞，墙也不遮挡判定圆**。
   收益：本里程碑的语义边界清晰 —— 墙只与**动态圆体**互动，判定圆只与**受击盒**互动。
   代价：敌人可以「隔墙被打到」（只要判定圆够大）；实体之间可以重叠。
   接受理由：两者都是**既有契约**（spec 03 从无遮挡概念；实体不互推是 spec 01 以来的设定）。改写它们属于独立里程碑，且会牵动所有既有的命中测试。

---

## 11. 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| 高速投射物单 Tick 越过一个薄目标（离散检测，无 CCD） | `DEFAULT_CAST_PROJECTILE_SPEED = 20` 远低于「最小目标直径 / 单 Tick 时长」（`0.333 < 2 × 0.5`）；测试断言逐拍位移，若未来提速需先引入扫掠检测（§1.3 显式排除） |
| 撞墙伤害在硬直期间重复结算 | 撞墙时清零击退（I4）+ G2 断言「恰好一次」（并列为变异测试第 2 项） |
| 贴墙滑行被误判为撞墙 | `dot(push, kb) < 0` 守卫 + G3③ 断言（并列为变异测试第 3 项） |
| 投射物穿透多个敌人 | `destroyOnHit` 命中即销毁 + `break` + G5 断言第二个敌人满血（并列为变异测试第 4 项） |
| 投射物「穿墙」打到墙后的目标 | 撞墙销毁发生在 `MovementSystem`（index 4）< `CollisionSystem`（index 8）⇒ 当拍不可能被测试（I6）+ G6 断言撞墙拍无伤害 |
| 投射物顿帧把施法者冻住 | `DEFAULT_CAST_HITSTOP_TICKS = 0` + `knockbackForce > 0` 开门（§4.4）+ G4/G5 断言（并列为变异测试第 5 项） |
| 尸体在墙内穿模（死在墙里的尸体不被推出） | 刻意的：`DeadTagComponent` 是绝对跳过理由（I10），与「尸体不被位移」契约一致；渲染层可自行选择不绘制贴墙尸体 |
| 新增 `HitboxComponent` 字段改变 Snapshot 形状 ⇒ 既有快照断言失败 | 既有快照用例均为**同代码两跑对比**（非固定字面量），故自动保持绿 |
| `MovementSystem` 变胖 ⇒ 未来的位移写者忘记在此解算 | §5.3 已把「位移的尾部就是解算点」写成契约；新增位移写者必须在 `MovementSystem` 之前（管道 index ≤ 4），否则 G1 会失败 |
