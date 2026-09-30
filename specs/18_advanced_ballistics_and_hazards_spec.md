# 18 · Advanced Ballistics & Hazards Spec（反弹、穿透与复合爆炸）

| Field | Value |
|---|---|
| Spec ID | `SPEC-18-ADVANCED-BALLISTICS` |
| Milestone | **M11 · 弹道与危险地形**（T01） |
| Status | `accepted`（本文件为 M11-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/core/math.ts`（`dotVec2` / `reflectVec2`）、`src/ecs/components/HitboxComponent.ts`（`pierceCount` / `damageFalloff`）、`src/ecs/components/ProjectileComponent.ts`（`bounceCount` + `spawnProjectileFromConfig`）、`src/ecs/components/HazardComponent.ts`（`onExplodeConfigId`）、`src/ecs/systems/CollisionSystem.ts`（穿透）、`src/ecs/systems/MovementSystem.ts`（反弹）、`src/ecs/systems/HazardSystem.ts`（连环雷）、`src/data/schemas.ts`（`ProjectileConfig` / `HazardConfig.onExplodeConfigId`）、`src/data/DataManager.ts`（两张新表 + 跨表校验 + 读取 API）、`src/data/bundled.ts`（五表引导）、`assets/data/projectiles.json`（新）、`assets/data/hazards.json`（新）、`tests/core/math.test.ts`、`tests/data/data_manager.test.ts` |
| Depends on | `specs/13_arena_and_projectiles_spec.md`（墙体解算 / `destroyOnWall` / `destroyOnHit` / 投射物装配）、`specs/14_aoe_and_run_lifecycle_spec.md`（`HazardComponent` 生命周期 / `detonate`）、`specs/16_data_driven_pipeline_spec.md`（形状/数值分离 / `DataManager` 原子替换 / 加载期大声抛）、`specs/17_encounters_hmr_spec.md`（`RawConfigTables` 可选表 / 跨表校验 / 按 id 键控注册表）、`specs/03_combat_hitbox_spec.md`（`hitEntities` 多段命中护栏 / `HitEvent`）、`specs/04_combat_feedback_spec.md`（反馈门 / 击退）、`specs/00_harness_spec.md`（确定性 / 无隐藏状态 / POD 组件 / barrel 契约） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境，`pool: 'threads'`）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

M7-T01（spec 13）给了竞技场两件事：静态几何（墙）与投射物。但两者的交互被刻意做成了**终结式**的——`destroyOnHit` 的投射物命中第一个目标即销毁（无穿透），`destroyOnWall` 的投射物被墙推出即销毁（不反弹）。于是：

1. **弹道只有一条直线**：投射物不会拐弯、不会弹墙、不会穿过第一个敌人去打第二个。空间互动止步于「直线飞行 + 撞到东西就消失」。
2. **危险地形是平的**：`HazardSystem.detonate` 一次爆炸就结束，没有「爆炸后留下余波 / 触发下一颗雷」的表达，AoE 无法组合。

M11-T01 把这两条「终结式」路径各打开一个受控的出口：

1. **反弹（AC-01）**：投射物撞墙时可**镜面反射**而不是销毁，把直线弹道变成可设计的台球式轨迹。
2. **穿透（AC-02）**：投射物命中目标时可**继续前进**而不是销毁，并对其后的目标按分数**衰减伤害**。
3. **复合爆炸（AC-03）**：一次爆炸可在原地**再生成一个次级 Hazard**，从而组合出连环雷 / 余波毒云。

三者共用一条主线：**把「一次性」的接触事件，变成可参数化的、有预算的行为**——而预算本身是**数据**。

### 1.2 In Scope（做什么）

- **纯数学**（AC-01）：`src/core/math.ts` 新增 `dotVec2` 与 `reflectVec2`（Householder 镜面反射）。
- **组件扩展**：`HitboxComponent.pierceCount` / `damageFalloff`（AC-02）；`ProjectileComponent` 由**零字段**改为持有 `bounceCount`（AC-01）；`HazardComponent.onExplodeConfigId`（AC-03）。
- **系统语义**：`MovementSystem.resolveWalls` 增加反弹分支；`CollisionSystem` 增加穿透分支；`HazardSystem.detonate` 增加复合生成分支。
- **数据管线**：`ProjectileConfig`（全字段可选）+ `assets/data/projectiles.json`；`HazardConfig.onExplodeConfigId` + `assets/data/hazards.json`；`DataManager` 的两张新注册表、跨表校验与读取 API；`bundled.ts` 五表引导。
- **Harness 断言**：`tests/core/math.test.ts`（`dotVec2` / `reflectVec2`）、`tests/data/data_manager.test.ts`（模板解析 + 跨表校验）。

### 1.3 Out of Scope（显式排除）

- ❌ **新增管道段。** 见 §6 与 §10 取舍 1：17 段硬契约**零改动**（反弹落在 `MovementSystem` 尾部，穿透落在 `CollisionSystem`，复合爆炸落在 `HazardSystem`）。
- ❌ **扫掠碰撞 / CCD。** 反弹与穿透都不引入连续碰撞检测；投射物每 Tick 只在其**落点**做一次离散检测（沿用 spec 13 §1.3）。
- ❌ **能量损耗 / 反弹速度衰减。** 反弹是**纯镜面**的，速度大小不变（`|V'| === |V|`）。能量保留率是一个独立玩法设计。
- ❌ **法线选择策略（墙角两面墙）。** 每实体每 Tick **只反射一次**，法线取本 Tick 累积推力的归一化方向（§4.1）。多次反射/角落收敛留待后续。
- ❌ **穿透的命中顺序策略。** 穿透沿目标循环的既有顺序（目标 id 升序），不引入「按距离排序」。
- ❌ **投射物专属词缀 / 充能 / 弹药。** 同 spec 13 §1.3。
- ❌ **`enemies.json` 的修改。** 既有敌人行为必须零变化（§10 取舍 4）；复合爆炸的**根**由代码/测试显式装配，不改任何既有敌人条目。
- ❌ **客户端表现层（反弹/穿透/连环雷的绘制）。** 逻辑层先落地，渲染留待后续。

---

## 2. 术语

| 术语 | 定义 |
|---|---|
| **镜面反射（Mirror reflection）** | 速度向量关于「以法线为轴」的镜面对称：`V' = V - 2(V·N)N` |
| **法线（Normal, N）** | 单位化的**本 Tick 累积推力** `(pushX, pushY)`——墙把圆体顶出去的方向，即几何的外法线 |
| **反弹（Bounce）** | 带 `destroyOnWall` 的投射物在 `bounceCount > 0` 时，被墙推出后**不销毁**，而是镜面反射一次并扣 1 次额度 |
| **穿透（Pierce）** | 带 `destroyOnHit` 的命中圆在 `pierceCount > 0` 时，命中后**不销毁**，扣 1 次额度、衰减伤害，继续本 Tick 的目标循环 |
| **伤害衰减（Damage falloff）** | 每次穿透后 `damage *= (1 - damageFalloff)`，作用于**后续**目标 |
| **复合 / 连环爆炸（Composite explosion）** | `onExplodeConfigId` 非空的 Hazard 在爆炸后**原地**再生成一个次级 Hazard |
| **模板（Template）** | `projectiles` / `hazards` 表中的一条按 id 键控的配置；数值的默认由装配层兜底 |

---

## 3. 数据结构

### 3.1 `src/core/math.ts`（新增两个纯函数）

```ts
export function dotVec2(a: Vec2, b: Vec2): number;          // a.x*b.x + a.y*b.y
export function reflectVec2(v: Vec2, normal: Vec2): Vec2;   // V' = V - 2(V·N)N
```

`reflectVec2` 内部对 `normal` 调 `normalizeVec2`：**法线长度无关**（`(0,-1)` 与 `(0,-5)` 结果相同）。若归一化后为零向量（`|normal| === 0`），原样返回 `{ x: v.x, y: v.y }`——退化法线是**文档化的 no-op**，不是 `NaN` 毒值。两个函数均为**全函数**、无副作用、同输入逐位同输出（ADR-001 R1/R2）。

### 3.2 `HitboxComponent` 扩展（`pierceCount` / `damageFalloff`）

```ts
class HitboxComponent {
  // ...既有字段不变...
  public pierceCount: number;      // 剩余穿透次数；0 = 不穿透（历史行为）
  public damageFalloff: number;    // 每次穿透后伤害的分数衰减，[0, 1)
  constructor(
    radius, damage, activeTicks, faction, ownerEntityId,
    hitstopTicks = DEFAULT_HITSTOP_TICKS,
    knockbackForce = DEFAULT_KNOCKBACK_FORCE,
    hitEntities = [], sourceModifier = null,
    destroyOnHit = false, destroyOnWall = false,
    pierceCount = DEFAULT_HITBOX_PIERCE_COUNT,          // 追加在尾部
    damageFalloff = DEFAULT_HITBOX_DAMAGE_FALLOFF,      // 追加在尾部
  )
}
export const DEFAULT_HITBOX_PIERCE_COUNT = 0;
export const DEFAULT_HITBOX_DAMAGE_FALLOFF = 0;
```

两个新字段**追加在构造参数尾部**且默认 `0` ⇒ 既有 4 处 `new HitboxComponent(...)` 调用（`CombatActionSystem` / `ZeusStrikeModifier` / `PoseidonDashModifier` / `HazardSystem.detonate` / 测试）**逐字不变**，行为逐位不变。

### 3.3 `ProjectileComponent`：从零字段到持 `bounceCount`

```ts
class ProjectileComponent {
  public bounceCount: number;      // 剩余反弹次数
  constructor(bounceCount = DEFAULT_PROJECTILE_BOUNCE_COUNT)
}
export const DEFAULT_PROJECTILE_BOUNCE_COUNT = 0;
```

**这是本里程碑唯一一次「打破零字段」的组件改动**，理由与代价见 §10 取舍 2。其余一切仍由既有组件表达（位置在 `Transform`、速度在 `Velocity`、伤害/寿命在 `Hitbox`）。

`ProjectileSpawnOptions` 尾部追加三个可选字段，`spawnProjectile` 解析默认值并在 `world.createEntity()` **之前**校验：

| 字段 | 域 | 默认 |
|---|---|---|
| `bounceCount?` | 非负整数 | `0` |
| `pierceCount?` | 非负整数 | `0` |
| `damageFalloff?` | 有限且 `0 <= f < 1` | `0` |

另新增 `spawnProjectileFromConfig(world, configId, placement)`：从 `DataManager.getProjectileConfig(configId)` 取模板并合并进 `spawnProjectile` 选项（placement 只含 `x/y/directionRadians/faction/ownerEntityId`）。它引入 `src/ecs → src/data` 依赖——与 `EnemyFactory` 同源，无循环（`src/data` 从不 import `src/ecs`）。

### 3.4 `HazardComponent.onExplodeConfigId`

```ts
class HazardComponent {
  // ...既有字段不变...
  public onExplodeConfigId: string | null;   // 默认 null
  constructor(radius, damage, delayTicks, totalDelayTicks, faction, ownerEntityId,
              onExplodeConfigId = null)      // 追加第 7 个参数
}
interface HazardSpawnOptions { /* ...既有... */ readonly onExplodeConfigId?: string | null; }
```

`spawnHazard` 存储它：未传 = `null`；传非空字符串 = 校验其为非空字符串（否则 `RangeError`，在 `createEntity` 之前）；传 `null` = 合法。

### 3.5 `src/data/schemas.ts`（新增 / 扩展）

```ts
export interface HazardConfig {
  readonly radius: number;
  readonly damage: number;
  readonly delayTicks: number;
  readonly onExplodeConfigId?: string;   // 新增：指向 hazards 表模板，可为空
}

export interface ProjectileConfig {   // 全部字段可选
  readonly speed?: number;            // > 0 有限
  readonly radius?: number;           // > 0 有限
  readonly damage?: number;           // >= 0 有限
  readonly lifespanTicks?: number;    // 正整数
  readonly knockback?: number;        // >= 0 有限
  readonly bounceCount?: number;      // 非负整数
  readonly pierceCount?: number;      // 非负整数
  readonly damageFalloff?: number;    // 有限且 0 <= f < 1
}
export function parseProjectileConfig(id: string, data: unknown): ProjectileConfig;  // @throws SchemaError
export function isProjectileConfig(data: unknown): boolean;                          // 不抛版本
```

`parseProjectileConfig` 复用既有 `optional*` 原语（新增 `optionalNonNegativeInteger` / `optionalUnitInterval` / `optionalNonEmptyString` 三个）。**缺失字段一律保持缺失**（不是填默认值）：默认值属于装配层 `spawnProjectile`，正如 `EnemyConfig.dash` 的范式。`schemas.ts` **不 import `src/ecs`**，数据层保持自洽。

### 3.6 `DataManager`（扩展）

```ts
export interface RawConfigTables {
  readonly enemies: Readonly<Record<string, unknown>>;
  readonly modifiers: Readonly<Record<string, unknown>>;
  readonly encounters?: readonly unknown[];
  readonly projectiles?: Readonly<Record<string, unknown>>;   // 新（缺席 = 本包不提供）
  readonly hazards?: Readonly<Record<string, unknown>>;       // 新
}

export class DataManager {
  static loadAll(tables: RawConfigTables): void;   // 五表全绿才替换（原子）+ 两条跨表校验
  static getProjectileConfig(id: string): ProjectileConfig;   // @throws SchemaError
  static getHazardConfig(id: string): HazardConfig;           // @throws SchemaError
  static hasProjectile(id: string): boolean;
  static hasHazard(id: string): boolean;
  static get projectileIds(): readonly string[];   // 升序
  static get hazardIds(): readonly string[];       // 升序
  static get projectileCount(): number;
  static get hazardCount(): number;
  static clear(): void;                            // 同时清空两张新表
}
```

### 3.7 数据表（新增两张）

`assets/data/projectiles.json`：

```json
{
  "arrow": {},
  "bouncing_bolt": { "bounceCount": 2 },
  "piercing_dart": { "pierceCount": 1, "damageFalloff": 0.5 }
}
```

`assets/data/hazards.json`：

```json
{
  "poison_cloud": { "radius": 2.5, "damage": 8, "delayTicks": 10 }
}
```

**`enemies.json` 逐字未改**：复合爆炸的根由代码 / 测试显式装配（`spawnHazard({ ..., onExplodeConfigId })`），因此既有 4 种敌人的行为零变化。

---

## 4. 语义

### 4.1 AC-01 · 反弹（Wall Bounce）

`MovementSystem.resolveWalls` 的「后果 2」由「撞墙即销毁」变成一次分支：

```
if (hitbox.destroyOnWall) {
  if (projectile !== undefined && projectile.bounceCount > 0) {
    projectile.bounceCount -= 1;
    velocity.directionVector = reflectVec2(velocity.directionVector, normalizeVec2(vec2(pushX, pushY)));
  } else {
    world.destroyEntity(id);
  }
}
```

四条设计约束：

1. **法线 = 本 Tick 累积推力的归一化方向。** `resolveWalls` 已经为每个圆体逐墙累加了 `pushX/pushY`（spec 13 I3 的顺序推出）。这个累积推力**就是**几何把圆体顶出去的方向，即外法线——一次 `normalizeVec2` 即可，无需第二次几何查询，也无需为「哪面墙」做特判。
2. **绝不引入 `while` / 重试循环。** 每实体每 Tick **只反射一次**。解算 pass 是 `for (const id of ...)` 的单次有限遍历，因此一个弹墙投射物**不可能**在同一 Tick 内来回弹射（角落反复推挤也因此不可能自旋——见 §9 R2）。
3. **反射后不销毁**；`bounceCount === 0` 或非投射物 ⇒ 沿用旧的 `destroyOnEntity` 销毁路径（spec 13 AC-04 不变）。
4. **零回归**：`bounceCount === 0`（默认，所有既有投射物）时，分支不进入，行为逐位等价 M7。

反射公式 `V' = V - 2(V·N)N` 保长（`|V'| === |V|`）、保「入射角 = 反射角」（对法线**线**而言），且是**对合**的（反射两次回到原方向）——三条性质都由 `tests/core/math.test.ts` 直接钉住。

### 4.2 AC-02 · 穿透与衰减（Piercing）

`CollisionSystem` 的目标循环里，命中结算 + 反馈 + `HitEvent` **之后**、`destroyOnHit` 销毁**之前**，插入穿透分支：

```
if (hitbox.pierceCount > 0) {
  hitbox.pierceCount -= 1;
  hitbox.damage = hitbox.damage * (1 - hitbox.damageFalloff);
  continue;   // 下一个目标（hitEntities 已记录本目标，不会重复命中）
}
if (hitbox.destroyOnHit) { world.destroyEntity(hitboxId); break; }
```

四条设计约束：

1. **`HitEvent.damage` 是本次命中时的伤害**：衰减发生在其**后**，因此事件携带的是刚结算的、未衰减的值；衰减只作用于**后续**目标。
2. **去重靠 `hitEntities`**：命中后 `hitEntities.push(targetId)` 已在其上（既有 M2 多段命中护栏），所以 `continue` 后同一目标在后续 Tick 也不会被再次命中。
3. **有限循环**：目标循环是 Tick 开始时的有限数组（`world.query` 快照），且集合只可能因实体被销毁而收缩，每个目标都有 `hitEntities` 护栏 ⇒ **不存在一帧内无限循环**。
4. **零回归**：`pierceCount === 0`（默认）时，穿透分支不进入，逐位等价 M7 的「命中即销毁」。

### 4.3 AC-03 · 复合 / 连环爆炸（Composite Explosion）

`HazardSystem.detonate` 在**创建 blast 之后、`destroyEntity(hazardId)` 之前**插入：当 `onExplodeConfigId` 非空时，从 `hazards` 模板**原地**再生成一个次级 Hazard，并把它的 id **返回**给 `advanceHazards`：

```
if (hazard.onExplodeConfigId !== null) {
  const child = DataManager.getHazardConfig(hazard.onExplodeConfigId);
  childId = spawnHazard(world, {
    x: transform.x, y: transform.y,
    radius: child.radius, damage: child.damage, delayTicks: child.delayTicks,
    faction: hazard.faction, ownerEntityId: hazard.ownerEntityId,
    ...(child.onExplodeConfigId === undefined ? {} : { onExplodeConfigId: child.onExplodeConfigId }),
  });
}
world.destroyEntity(hazardId);
return childId;
```

`advanceHazards` 改用**工作队列排空**驱动（不再是 `world.query` 快照的单次遍历）：

```
const queue = [...world.query(HazardComponent)];   // Tick 开始时的全部 Hazard
let detonationsThisTick = 0;
for (let index = 0; index < queue.length; index += 1) {
  const id = queue[index];
  const hazard = world.getComponent(id, HazardComponent);
  const transform = world.getComponent(id, TransformComponent);
  if (hazard === undefined || transform === undefined) continue;
  if (hazard.delayTicks > 0) { hazard.delayTicks -= 1; continue; }   // 判减顺序不变：先判后减
  const childId = this.detonate(world, id, hazard, transform);
  detonationsThisTick += 1;
  if (childId !== null && detonationsThisTick < MAX_HAZARD_CHAIN_PER_TICK) queue.push(childId);
}
```

**唯一的行为增量**：在**相位 B 当拍**生成的 Hazard（即子雷）被**追加进同一个队列**，因此它的引信**从生成它的那一拍起算**（在本拍的排空过程中就被减 1）。相位 A（`plantHazards`）播种的 Hazard 本就在初始队列里，行为**逐位不变**。

于是「**在 Tick T 播种、`delayTicks = N` ⇒ 在 Tick T + N 爆炸**」这条规则**对相位 A 与相位 B 生成的 Hazard 一律成立**：

- **相位 A**：`plantHazards` 在 Tick T 种雷，`advanceHazards` 当拍排空时减 1。
- **相位 B**：`detonate` 在 Tick T 生成子雷，队列当拍排空时同样减 1。

四条设计约束：

1. **规则统一**：两个相位生成的 Hazard 共用同一套「T + N」算术。主雷 `delayTicks = 30` 在 Tick 30 炸、其子雷 `delayTicks = 10` 在 Tick 40 炸（`30 + 10`），**不是** 41。
2. **同拍排空有界**：`MAX_HAZARD_CHAIN_PER_TICK`（`256`）是**纵深防御**上限，只有畸形配置才可能触碰；触及后不再追加子雷，已生成的子雷仍以正常引信在后续 Tick 处理。
3. **配置图必须无环**：`onExplodeConfigId` 引用图在加载期被断言为 **DAG**（§4.4），这是「同拍排空可证明有限」的前提；有环则 `SchemaError` 并指名环路径。
4. **运行时零校验 / 相位与判减顺序不动**：`onExplodeConfigId` 的存在性由加载期跨表校验（§4.4）保证，故 `detonate` 里的 `getHazardConfig` 查找**不会抛错**；`plantHazards` → `advanceHazards` 的顺序、以及「先判定后递减」**逐位不变**。

### 4.4 跨表校验（只能在 `loadAll`）

收集所有 `onExplodeConfigId` 引用——来自 `hazards` 表自身，以及 `enemies` 各条目的 `hazard` 块——断言每个引用都能在**本次加载的** `hazards` 表中找到；否则 `SchemaError`，消息含完整路径（`hazards.poison_cloud.onExplodeConfigId` / `enemies.bomber.hazard.onExplodeConfigId`）并列出已加载的 hazard id。与 `assertEncounterEnemiesExist` 同风格、同理由：这是唯一一条需要「两张表都在手」的规则，因此只能在 `loadAll`；失败必须发生在**装载期**，而不是某一颗雷终于爆炸时从 `step()` 内部抛出。

**环检测（acyclicity）**：在存在性校验**之后**，把同一个引用图（节点 = `hazards.<id>` 与 `enemies.<id>.hazard`；边 = 每条 `onExplodeConfigId`）当作**有向图**，断言它是 **DAG**。有环则 `SchemaError`，消息**指名环路径**（例如 `hazards.a -> hazards.b -> hazards.a`；自引用 `hazards.x -> hazards.x` 也算）。遍历是**确定性**的：起始节点按 id 升序、每个节点至多一条出边（功能图），全程不依赖 `Map` 插入顺序、不用 `localeCompare`。这是「§4.3 的同拍排空可证明有限」的前提——见 §5 不变量 I11。存在性校验保留，且**先于**环检测运行（每条边此时都已指向一个已加载的 hazard id）。

---

## 5. 不变量（必须始终成立）

| ID | 不变量 | 为什么它是硬的 |
|---|---|---|
| **I1** | `reflectVec2` 是**纯函数**：无 DOM / 墙钟 / 随机，同输入 ⇒ 逐位同输出；`|V'| === |V|`；对法线线保角；是对合（反射两次回原）。 | 弹道的确定性建立在反射是纯算术之上（ADR-001 R1/R2）；保长/保角/对合让「反射」在数学上就是反射，而不是某种近似。 |
| **I2** | 每实体每 Tick **至多反射一次**；反弹路径**不含** `while` / 重试。 | 单次遍历是「不可能一帧内死循环」的结构性保证；反射一次后位置已被推出，再次遍历不会重新重叠。 |
| **I3** | `pierceCount === 0 && bounceCount === 0`（默认）时，反弹/穿透路径**逐位等价** M7 行为。 | 零回归：既有物理套件（spec 13）全绿即为证据。 |
| **I4** | 穿透对同一目标**至多结算一次**；`HitEvent.damage` 是本次命中时的（未衰减）伤害。 | `hitEntities` 护栏保证去重；事件携带结算值，衰减只影响后续目标，语义不歧义。 |
| **I5** | `onExplodeConfigId` 引用的存在性由**加载期跨表校验**保证 ⇒ `detonate` 的运行时查找**不抛错**。 | 运行时零校验是 `src/` 的铁律；把校验推给 `loadAll` 是 spec 16/17 的既定纪律。 |
| **I6** | 「在 Tick T 播种、`delayTicks = N` ⇒ 在 Tick T + N 爆炸」对**相位 A 与相位 B**生成的 Hazard **一律成立**（工作队列排空）。 | 规则统一是 `advanceHazards` 工作队列的直接后果：子雷被追加进当拍队列，引信当拍起算；相位 A 播种路径逐位不变。 |
| **I7** | `createDefaultSystems()` 仍为 **17 段**，顺序不变，`TransformSnapshotSystem` 恒 idx0，`LifespanSystem` 恒 LAST。 | 管道是硬契约（spec 02/03/04/05/07/08/11/13/15 §6 的钉桩）。本里程碑**不新增、不重排**任何段。 |
| **I8** | 组件是 POD（禁方法）；操作用自由函数；系统无跨 Tick 隐藏状态。 | `bounceCount` / `pierceCount` / `onExplodeConfigId` 都活在组件上，随快照进出，重放逐位精确（spec 00 §6.1）。 |
| **I9** | `enemies.json` 逐字未改 ⇒ 既有敌人行为零变化。 | 复合爆炸的根显式装配，不藏在敌人配置里；既有回归面最小。 |
| **I10** | 单 Tick 内引爆数受 `MAX_HAZARD_CHAIN_PER_TICK`（`256`）约束 ⇒ 同拍排空**有界**。 | 纵深防御：合法（无环）配置永远达不到它；触及后不再追加子雷，已生成的子雷仍以正常引信在后续 Tick 处理。 |
| **I11** | `onExplodeConfigId` 引用图（`hazards` 表自身 + 各 `enemies.<id>.hazard` 块）必须是 **DAG**；有环 ⇒ 加载期 `SchemaError` 指名环路径。 | 这是「同拍排空可证明有限」的前提（I10 只是兜底）；把校验推给 `loadAll`，与 I5 同源、同为「两张表都在手才能判」。 |

---

## 6. Tick 契约

### 6.1 管道位置（17 段，**零改动**）

```
idx0  TransformSnapshotSystem
idx1  PlayerControllerSystem
idx2  FreezeSystem
idx3  AISystem
idx4  HazardSystem          ← 复合爆炸（AC-03）
idx5  MovementSystem        ← 反弹（AC-01）
idx6  DashSystem
idx7  StateSystem
idx8  CombatActionSystem
idx9  CollisionSystem       ← 穿透（AC-02）
idx10 StatusEffectSystem
idx11 ModifierSystem
idx12 DeathSystem
idx13 EncounterSystem
idx14 RewardSystem
idx15 PickupSystem
idx16 LifespanSystem        ← 恒 LAST
```

三处语义都落在**既有段**内，理由：

- **反弹在 `MovementSystem` 尾部（idx5）**：`resolveWalls` 已经是「本拍所有位移之后、`CollisionSystem` 之前」的唯一正确位置（spec 13 §5.2）。反弹是「被墙推出」的一个后果分支，天然属于这里。新增段会把 17 段变成 18 段并改动多处管道钉桩，零行为收益。
- **穿透在 `CollisionSystem`（idx9）**：命中结算的唯一点就是这里；穿透是「命中后是否销毁」的一个分支。
- **复合爆炸在 `HazardSystem`（idx4）**：`detonate` 是爆炸的唯一落点；child 在快照之后生成 ⇒ 次 Tick 才倒计时。

### 6.2 反弹逐 Tick（投射物 `(0,0)` 朝 `+x`，速度 `20`、半径 `0.4`、`bounceCount = 1`；墙 AABB = `x:4, y:-1, w:2, h:2`，左面 `x = 4`）

每拍前进 `20/60 = 1/3`；极限圆心 `x = 4 - 0.4 = 3.6`。

| Tick | 事件 | 投射物 `x` | `directionVector` | `bounceCount` |
|---|---|---|---|---|
| `0` | 生成于 `(0.5, 0)`（前置偏移）；`CollisionSystem` 当拍测试（无目标）；`LifespanSystem` 寿命 `60→59` | `0.5` | `(1, 0)` | `1` |
| `1..9` | 每拍 `+1/3`：`0.833 … 3.5`（距墙面 `> 0.4`） | `3.5` | `(1, 0)` | `1` |
| `10` | 前进到 `3.833`；与墙重叠（`3.833 + 0.4 > 4`）⇒ 推出回 `3.6`（`= 4 - 0.4`）⇒ 法线 `= normalize(-0.233, 0) = (-1, 0)` ⇒ **反射**：`V' = (1,0) - 2((1,0)·(-1,0))(-1,0) = (-1, 0)`；额度 `1→0` | `3.6` | `(-1, 0)` | `0` |
| `11+` | 每拍 `-1/3` 沿 `-x` 飞离；`bounceCount === 0` ⇒ 下次撞墙即销毁 | `3.267 …` | `(-1, 0)` | `0` |

⇒ 可观测判据：投射物在撞墙拍**仍存活**，`directionVector.x` 由 `+1` 翻为 `-1`，`bounceCount` 归零。

### 6.3 穿透逐 Tick（投射物 `(0,0)` 朝 `+x`，速度 `20`、半径 `0.4`、`damage = 10`、`pierceCount = 1`、`damageFalloff = 0.5`；靶 `A(3,0)`、`B(6,0)`，受击盒 `0.5`，均静止无 AI）

命中判据 `dist < 0.4 + 0.5 = 0.9`。

| Tick | 事件 | 投射物 `x` | `A.hp` | `B.hp` | `pierceCount` | `damage` |
|---|---|---|---|---|---|---|
| `0` | 生成于 `(0.5, 0)`；当拍测试（距 `A` 为 `2.5 > 0.9`，未命中） | `0.5` | `100` | `100` | `1` | `10` |
| `1..4` | 每拍 `+1/3`：`0.833 … 1.833`（距 `A` 仍 `> 0.9`） | `1.833` | `100` | `100` | `1` | `10` |
| `5` | 前进到 `2.167`；距 `A` 为 `0.833 < 0.9` ⇒ **命中 `A`**：`A.hp -= 10`；`HitEvent.damage = 10`；`pierceCount 1→0`、`damage 10→5`、`continue`；同拍距 `B` 为 `3.833 > 0.9` ⇒ 未命中 | `2.167` | `90` | `100` | `0` | `5` |
| `6..13` | 继续飞行；`A` 已在 `hitEntities` ⇒ 不重复命中；距 `B` 仍 `> 0.9` | `2.5 … 4.833` | `90` | `100` | `0` | `5` |
| `14` | 前进到 `5.167`；距 `B` 为 `0.833 < 0.9` ⇒ **命中 `B`**：`B.hp -= 5`；`HitEvent.damage = 5`；`pierceCount === 0` ⇒ `destroyOnHit` ⇒ **销毁** | — | `90` | `95` | — | — |

⇒ 严格断言：`A.hp === 90`、`B.hp === 95`（`10 × (1 - 0.5)`）、投射物在命中第二个目标拍销毁、`HitEvent` 的两次 `damage` 分别为 `10` / `5`。

### 6.4 复合爆炸逐 Tick（根 `delayTicks = 30`、`onExplodeConfigId = 'poison_cloud'`；child 模板 `radius 2.5 / damage 8 / delayTicks 10`）

| Tick | 事件 |
|---|---|
| `T` | 根 Hazard 存在（直接 `spawnHazard` 或由 `plantHazards` 种下），`delayTicks = 30`。`advanceHazards` 排空：`30 → 29` |
| `T+1 … T+29` | 每拍减 1；到 `T+29` 时 `delayTicks` 由 `1 → 0`，仍未爆 |
| `T+30` | `delayTicks === 0` ⇒ **根 `detonate`**：先生成 blast（`radius 2 / damage 25 / activeTicks 1`），再 `spawnHazard(child, delayTicks 10)`（子雷被**追加进本拍队列**），再销毁根 |
| `T+30`（同拍排空继续） | 子雷在**生成它的这一拍**被减 1：`delayTicks 10 → 9` |
| `T+31 … T+39` | 子雷每拍减 1；到 `T+39` 时由 `1 → 0`，仍未爆 |
| `T+40` | 子雷 `delayTicks === 0` ⇒ **子雷爆炸**（`poison_cloud` 无 `onExplodeConfigId` ⇒ 链到此终止） |

⇒ 关键断言：根在 Tick `T+30` 炸、子雷在 Tick `T+40` 炸（`30 + 10`）；子雷**不在** `T+39` 炸、也**不在** `T+41` 炸；child 的半径/伤害来自模板（`2.5 / 8`）而非根（`2 / 25`）。

---

## 7. 验收标准

| ID | 验收标准 | 判据 |
|---|---|---|
| **AC-01** | `dotVec2` / `reflectVec2` 存在且为纯函数（I1）；带 `destroyOnWall` 的投射物在 `bounceCount > 0` 时撞墙**反射不销毁**，扣 1 次额度，`bounceCount === 0` 时沿用旧销毁路径（I2/I3） | `tests/core/math.test.ts` 的 `M11` 组；`specs/18` §6.2 |
| **AC-02** | 带 `destroyOnHit` 的命中圆在 `pierceCount > 0` 时命中后**不销毁**，扣额度、衰减 `damage` 并继续目标循环；`HitEvent.damage` 为本次未衰减值；`pierceCount === 0` 逐位等价旧行为（I3/I4） | `specs/18` §6.3；既有 `tests/physics/walls_and_projectiles.test.ts` 全绿（零回归） |
| **AC-03** | `HazardComponent.onExplodeConfigId` 非空时，`detonate` 爆炸后**原地**再生成一个次级 Hazard；「在 Tick T 播种、`delayTicks = N` ⇒ 在 T + N 爆炸」对相位 A 与相位 B **一律成立**（I6）；存在性由加载期跨表校验、引用图无环由加载期环检测保证（I5/I10/I11） | `specs/18` §6.4；`tests/combat/aoe_and_lifecycle.test.ts` 的 `G6` 组（主雷 30 拍 / 次雷 40 拍逐拍钉桩）；`tests/data/data_manager.test.ts` 的 `G5` 组（跨表校验 + 环拒绝） |
| **AC-04** | `ProjectileConfig`（全字段可选）+ `assets/data/projectiles.json`；`HazardConfig.onExplodeConfigId` + `assets/data/hazards.json`；`DataManager` 提供两张表的读取 API 与跨表校验；`createDefaultSystems()` 仍 **17 段**且顺序不变；`enemies.json` 未改（I7/I9） | `tests/data/data_manager.test.ts` 的 `G5` 组；`tests/physics/walls_and_projectiles.test.ts` G7（17 段钉桩）；`git diff --stat assets/data/enemies.json` 为空 |

---

## 8. 测试计划

**扩展 `tests/core/math.test.ts`（新增 `M11` 组，9 条）**：

- `dotVec2` 的标量积正确性（正交为 0、自点为 `|v|²`）。
- 垂直入射 `(0,-1)` 对法线 `(0,-1)` 反射为 `(0,1)`。
- `(1,1)/√2` 对法线 `(0,-1)` 反射为 `(1,-1)/√2`。
- 保角：入射角 = 反射角（用 `acos(|V·N|/(|V||N|))` 对法线**线**验证）。
- 法线长度无关（`(0,-1)` / `(0,-5)` / `(0,0.0001)` 同结果）。
- 零法线原样返回。
- 保长（`|V'| === |V|`，容差 `1e-9`）。
- 对合（反射两次回原）。
- 纯函数（两次调用逐位相同）。

**扩展 `tests/combat/aoe_and_lifecycle.test.ts`（新增 `G6` 组，1 条）**：

- **连环雷时序**：主雷 `delayTicks = 30`、`onExplodeConfigId = 'poison_cloud'`（模板 `delayTicks = 10`）；用**静止假人**（`Transform + Hurtbox + Faction + Health`，无 `Intent`/`State`，避免击退位移）逐拍钉桩：主雷在第 30 拍引爆、次雷在第 40 拍引爆（`30 + 10`），且断言次雷**不在**第 39 拍、也**不在**第 41 拍引爆；次雷半径/伤害来自模板（`2.5 / 8`）。

**扩展 `tests/data/data_manager.test.ts`（新增 `G5` 组，11 条）**：

- `projectiles` 表解析：`{}` 合法、缺省字段保持缺省、`bounceCount` / `pierceCount` / `damageFalloff` 读回、`projectileIds` 升序。
- 越域字段拒绝：`bounceCount: -1` / `pierceCount: 1.5` / `damageFalloff: 1` / `-0.1` / `speed: 0` ⇒ `SchemaError` 带完整路径。
- `hazards` 表解析：字段读回、`onExplodeConfigId` 透传、缺省保持缺省、`hazardIds` 升序。
- 空字符串 `onExplodeConfigId` ⇒ `SchemaError`。
- **跨表校验**：`hazards` 表自引用缺失 id ⇒ `SchemaError`（路径 `hazards.<id>.onExplodeConfigId`）；`enemies.<id>.hazard` 块引用缺失 id ⇒ `SchemaError`（路径 `enemies.<id>.hazard.onExplodeConfigId`）。
- **环检测**：自引用 `hazards.a -> hazards.a`、二元环 `hazards.a -> hazards.b -> hazards.a` ⇒ `SchemaError` 且消息含环路径；无环图（含以 `enemies.bomber.hazard` 为根）被接受。
- 未知 projectile / hazard id 报错并列出已加载 id。
- `isProjectileConfig` 与 parser 一致。
- `parseHazardConfig` / `parseProjectileConfig` 的直接用例。
- 出厂 bundle 引导后含 M11 模板。

**夹具纪律**：`DataManager` 是进程级全局（vitest `pool:'threads'`，同文件共享模块）⇒ 该套件的 `afterEach(bootstrapData())` 会还原出厂表，包括两张新表。

**（验收 harness 归属 quality-lead）** 真实 `GameSimulator` + 17 段管道 + 真实预制体的逐 Tick 集成断言（`tests/physics/advanced_ballistics.test.ts`）由 QA 拥有；本里程碑的集成几何提示见回传报告。

**变异测试（门控类改动的必做步骤）** —— 关键点各做一次变异，应全部被捕获：

| # | 变异 | 预期被捕获于 |
|---|---|---|
| M1 | `reflectVec2` 去掉法线归一化（直接用 `normal`） | `math.test.ts` M11「法线长度无关」 |
| M2 | `reflectVec2` 零法线时返回 `NaN` | `math.test.ts` M11「零法线原样返回」 |
| M3 | `CollisionSystem` 穿透分支用 `break` 而非 `continue` | §6.3（第二个目标不被命中） |
| M4 | `CollisionSystem` 在衰减**之前**发 `HitEvent` | §6.3（事件 `damage` 变成衰减值） |
| M5 | `MovementSystem` 反射后仍 `destroyEntity` | §6.2（弹墙投射物消失） |
| M6 | `HazardSystem` 的 child 复制**根**的 `radius` / `damage`，而非读模板 | §6.4（child 半径/伤害应为 `2.5 / 8` 而非根的 `2 / 5`） |
| M7 | `DataManager` 跳过跨表校验 | `data_manager.test.ts` G5 跨表用例 |
| M8 | `DataManager` 跳过环检测（`assertHazardGraphAcyclic`） | `data_manager.test.ts` G5「环状 `onExplodeConfigId` 被拒绝」用例 |
| M9 | `advanceHazards` 退回「快照单次遍历」（不排空工作队列） | `aoe_and_lifecycle.test.ts` G6（次雷落在第 41 拍而非第 40 拍） |

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **R1 自引用 / 环状配置导致无界链**：`hazards.x.onExplodeConfigId = 'x'`，或 `a -> b -> a` | 同拍排空遇到环，可能在一帧内爆炸无界 | **加载期拒绝**：`onExplodeConfigId` 引用图必须为 DAG（§4.4，I11），有环即 `SchemaError` 并指名环路径（`hazards.a -> hazards.b -> hazards.a`）；**纵深防御**：`MAX_HAZARD_CHAIN_PER_TICK`（`256`）限制单帧引爆数，只有绕过了加载期校验的畸形配置才可能触碰（I10，§4.3） |
| **R2 反弹角点反复推挤**：投射物卡在墙角，两面墙的推力交替 | 若同一 Tick 内反复反射，可能自旋或抖动 | 每实体每 Tick **只反射一次**，法线取**累积**推力的归一化方向（I2，§4.1）；单次遍历 ⇒ 一帧内不可能死循环。角落的多次反射留待后续（§1.3 显式排除） |
| **R3 `ProjectileComponent` 从零字段变有字段的设计取舍** | 「组件零字段」的既有论证被打破，读者可能困惑 | §10 取舍 2 完整记录：`bounceCount` 是**模拟状态**，必须在组件上（spec 00 §6.1）；放在 `ProjectileComponent` 而非 `HitboxComponent` 是为了**作用域**（反弹是投射物的属性，不是通用伤害圆的属性） |
| **R4 新增 `HitboxComponent` / `HazardComponent` 字段改变快照形状** | 既有快照断言失败 | 既有快照用例均为**同代码两跑对比**（非固定字面量），故自动保持绿；已验证含反弹/穿透/连环雷的两次同脚本运行 `snapshot()` 相等 |
| **R5 `damageFalloff` 越界（`>= 1` 或负）** | `1` 会让后续命中归零、负值会**放大**伤害 | 装配缝（`spawnProjectile`）与加载期（`parseProjectileConfig`）**双重**校验 `[0, 1)`；两处都有用例 |
| **R6 跨表引用拼错** | 运行时 `getHazardConfig` 抛错，从 `step()` 内部炸 | 加载期跨表校验（I5，§4.4），装载失败即中止；运行时查找被证明不会抛 |
| **R7 管道被误改** | 破坏 spec 02/03/04/05/07/08/11/13/15 的钉桩 | 不新增、不重排任何段（I7）；`walls_and_projectiles.test.ts` G7 的 `toHaveLength(17)` 与 `toEqual([...])` 原样通过 |
| **R8 `enemies.json` 被顺手改** | 既有敌人行为回归 | 本里程碑不改它（I9）；`git diff --stat assets/data/enemies.json` 为空 |

---

## 10. 已知取舍

1. **不新增管道段，把三处语义塞进既有段（`HazardSystem` / `MovementSystem` / `CollisionSystem`）。**
   收益：17 段硬契约与全部管道钉桩测试**零改动**，回归面最小；三处都恰好是各自语义的**唯一正确位置**（反弹是「被墙推出」的后果，穿透是「命中后是否销毁」的分支，复合爆炸是 `detonate` 的尾巴）。
   代价：三个既有系统各变宽一点。
   接受理由：为了「一个更短的系统」去改多处 QA 钉桩、把 17 段变成 18 段，是拿最大的回归风险换最小的可读性收益（与 spec 13 §10 取舍 1 同一论证）。

2. **`bounceCount` 放在 `ProjectileComponent`（打破其零字段），而不是 `HitboxComponent`。**
   收益：**作用域正确**。反弹是**投射物**的属性，不是通用伤害圆的属性——近战判定圆是静止的、没有 `VelocityComponent`、从不参与墙体解算（`resolveWalls` 只访问「会动的圆体」），把 `bounceCount` 放在 `HitboxComponent` 上会让它在**几乎所有** hitbox 上都是一个**惰性字段**（死数据），且每个未来的 hitbox 作者都要记住「这个字段对我没意义」。放在 `ProjectileComponent` 上，使「会反弹」与「是投射物」由构造决定为同一集合，正如 `destroyOnWall` 放在 hitbox 上是因为「不穿墙」是墙体解算所访问对象的属性。
   代价：投射物的调参现在横跨**两个**组件（`bounceCount` 在 `ProjectileComponent`，`pierceCount` / `damageFalloff` 在 `HitboxComponent`）；`ProjectileComponent` 不再是「纯身份标记」，「零字段」的既有论证（spec 13 §3.3）被打破，必须改写而非自相矛盾。
   接受理由：`bounceCount` 是**会变化的模拟状态**，按 spec 00 §6.1 **必须**活在组件上（否则快照无法重放）。在两个候选组件里选作用域更贴切的一个，胜过把它塞进一个「字段对多数实例无意义」的组件。`pierceCount` / `damageFalloff` 留在 hitbox，是因为穿透对**任何**命中圆都可能有意义（词缀注入的圆也可以穿透），与反弹不同。

3. **`ProjectileConfig` 全字段可选 + 装配层兜底。**
   收益：与 `EnemyConfig.dash` 同范式——schema 只描述「合法的投射物**是什么形状**」，默认值留在装配层（`spawnProjectile` 用 `DEFAULT_CAST_*` 兜底）。因此 `{}` 是合法模板（一把普通 Cast），`{ "bounceCount": 2 }` 是「一把还会弹两次的 Cast」。数据层**不 import `src/ecs`**，保持自洽。
   代价：读者要跳到装配层才知道缺省值。
   接受理由：若把默认值搬进 schema，数据层就要知道引擎的 `DEFAULT_CAST_*` 常量，违反「形状/数值分离」（spec 16）与分层自洽。

4. **复合爆炸的**根**显式装配，不改 `enemies.json`。**
   收益：既有 4 种敌人的行为**零变化**，回归面最小；复合爆炸是一条可被代码/测试直接驱动的能力，不被「某个敌人恰好会放连环雷」绑架。
   代价：出厂配置里暂时没有「会放连环雷的敌人」。
   接受理由：任务书显式要求「不得修改 `enemies.json`」；把一个新玩法钩子挂到既有敌人身上，等于同时改变既有行为与回归基线，属于独立里程碑。

5. **反弹是纯镜面、无能量损耗；法线取累积推力。**
   收益：`reflectVec2` 是纯函数且保长/保角/对合，行为完全由几何决定、可单测、可复现；无需「哪面墙」的特判，也无需能量保留率这一新参数。
   代价：没有「越弹越慢」的观感，也没有角落多次反射的精细处理。
   接受理由：能量保留率与角落策略都是**新的玩法设计**；AC-01 只要求「撞墙反射而非销毁」。

6. **穿透不按距离排序，沿既有目标循环顺序（id 升序）。**
   收益：确定性最强（id 升序是引擎既有契约），实现是一行 `continue`。
   代价：命中顺序由 id 决定而非几何距离。
   接受理由：既有 `CollisionSystem` 的目标循环本就是 id 升序的确定性遍历；为穿透单独引入距离排序会让「谁先被扣血」依赖浮点距离，反而削弱可复现性。
