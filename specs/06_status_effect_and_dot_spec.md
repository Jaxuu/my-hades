# 06 · Status Effect & DoT Spec（修饰器注册表与持续伤害状态）

| Field | Value |
|---|---|
| Spec ID | `SPEC-06-STATUS-DOT` |
| Milestone | **M3 · 变异引擎**（T02） |
| Status | `accepted`（本文件为 M3-T02 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/modifiers/{ModifierRegistry,ZeusStrikeModifier,DionysusBlightModifier,index}.ts`（新）、`src/ecs/components/{StatusEffectComponent,ModifierComponent,index}.ts`、`src/ecs/systems/{StatusEffectSystem,ModifierSystem,pipeline,index}.ts`、`src/ecs/prefabs/spawn-helpers.ts`、`src/ecs/index.ts`、`tests/combat/status_effects.test.ts`（新）、`tests/combat/{boons,feedback,hit_detection}.test.ts`（管道顺序断言同步） |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/03_combat_hitbox_spec.md`（判定圆 / 圆碰撞 / 无敌帧消费）、`specs/04_combat_feedback_spec.md`（顿帧 / 硬直 / 击退 / 管道顺序）、`specs/05_boon_modifier_spec.md`（事件总线 / 修饰器挂载 / 防递归 / 1 Tick 延迟） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的
M3-T01 把「命中」提升为显式事实（`HitEvent`），并硬编码了一个修饰器 `zeus_strike` 作为管道的端到端验证载体
（spec 05 §10 取舍 5）。M3-T02 兑现那笔技术债，并在这条管道上落地**第二类注入形态**：

1. **数据驱动的修饰器注册表（Modifier Registry）**：修饰器效果从 `ModifierSystem` 的私有方法
   抽离为独立的 `IModifierHandler` 实现，按 id 注册进 `ModifierRegistry`；`ModifierSystem` 退化为
   **纯分发器**——只负责「排空事件 + 查表 + 调用钩子」。新增祝福 = 写一个 handler + 注册，
   **不改系统、不改管道**。
2. **状态异常容器（Status Effects）**：实体可同时挂载多种状态（毒 / 燃烧 / 易伤），每种状态自带
   **层数 / 层数上限 / 剩余持续 Ticks / 触发间隔 Ticks**，全部是整数 Tick，无墙钟、无随机。
3. **持续伤害（DoT）结算**：`StatusEffectSystem` 按间隔直接扣减 HP ——**不生成判定圆、不抛 `HitEvent`、
   不写顿帧 / 硬直 / 击退**。这是「真实伤害」的落地定义，也是本里程碑最重要的可断言事实。
4. **酒神打击（Dionysus Blight）**：`dionysus_strike` 作为**状态施加型**修饰器的参考实现——
   命中即施毒，再次命中即叠层并**刷新持续时间**，层数**熔断**在上限。

> 本 Spec 只定义**状态容器 + DoT 时钟 + 注册表分派**。状态的具体效果表（哪些祝福给哪些状态、
> 稀有度、前置、互斥、抗性）仍属后续里程碑；本里程碑只落地「毒」一种状态的完整闭环。

### 1.2 In Scope（做什么）
- **新增模块**：`src/ecs/modifiers/`（`ModifierRegistry` / `ZeusStrikeModifier` / `DionysusBlightModifier` / barrel）。
- **新增组件**：`StatusEffectComponent`（+ `StatusEffectSpec` / `StatusEffect` / 自由函数 / 常量）。
- **新增系统**：`StatusEffectSystem`（DoT 时钟）。
- **系统重构**：`ModifierSystem` 由「硬编码 zeus」改为「注册表分派」；防递归门序**一字不改**。
- **常量扩展**：`ModifierComponent` 增加 `DIONYSUS_BLIGHT_MODIFIER`。
- **管道扩展**：`pipeline.ts` 在 `CollisionSystem` 与 `ModifierSystem` 之间插入 `StatusEffectSystem`（第 10 段）。
- **预制体**：`spawnCombatant` 为每个战斗单位挂载一个空的 `StatusEffectComponent`。
- **测试同步**：`tests/combat/{boons,feedback,hit_detection}.test.ts` 的管道顺序断言 / 注释由 9 段扩为 10 段。

### 1.3 Out of Scope（显式排除）
- ❌ **状态配置表**：祝福池、稀有度、前置、互斥、等级、抗性、净化（dispel）全部不做。
- ❌ **除 `OnHit` 之外的钩子**：`OnKill` / `OnDash` / `OnDamageTaken` / `OnStatusTick` / `OnStatusExpire`
  等属后续里程碑。`EventQueue<T>` 的泛型与 `IModifierHandler` 的形态已为其留好位置。
- ❌ **除「毒」之外的状态行为**：`burn` / `vulnerable` 的 **id 与存储形态**已定义（AC-01 要求容器通用），
  但**没有任何祝福产生它们**，也没有任何系统消费它们（易伤不改伤害、燃烧不另开计时器）。
- ❌ **修饰器改变数值**（伤害 / 速度 / 血量上限 / 暴击）：本里程碑只有「注入实体」与「施加状态」两种形态。
- ❌ **状态的表现层**：中毒特效、跳字、音效、HUD 图标（渲染层职责，逻辑核不感知）。
- ❌ **死亡与实体销毁**：沿用 spec 03 §1.3；`hp` 可为 `0` 但实体不被销毁。
- ❌ **状态的伤害归属（击杀记功）**：DoT 不产生事件，因此不参与「谁击杀」的判定（见 §10 取舍 4）。
- ❌ 任何外部物理引擎、DOM / Canvas / 图形库（沿用 spec 00 C1）。

### 1.4 约束
- C1 **时间只来自 Tick**：一切计时以整数 Tick 计，**禁止**墙钟；积分取 `ctx.fixedDeltaSeconds`。
- C2 **确定性**：同输入序列 ⇒ 逐 Tick 同状态；遍历一律走 `World.query`（id 升序）；
  事件按**产生顺序 FIFO** 消费；修饰器按 `ModifierComponent.modifiers` 的**升序**分派；
  状态列表按 id **升序**保持唯一；字符串比较一律使用 **UTF-16 码元序**（`<` / `>`），
  **禁止 `localeCompare`**（其结果依赖 ICU / 语言环境，跨机器可能不同）。
- C3 **类型安全**：禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- C4 **POD 契约**：组件为 `ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法；
  一切增删改查以**自由函数**提供（`applyStatusEffect` / `getStatusEffect` / `hasStatusEffect` /
  `removeStatusEffect`）。`StatusEffect` / `StatusEffectSpec` 是**普通数据记录**（interface），不是组件。
- C5 **无跨 Tick 隐藏状态**：系统不得持有隐藏状态（spec 00 §6.1）。DoT 的两个计数器
  （`remainingTicks` / `ticksUntilProc`）**必须落在组件字段上**；handler 除 `id` 外**不得**持有任何字段。
- C6 **不改时钟 / 步长 / `SystemContext`**：`FixedClock`、`GameSimulator.step`、`SystemContext`
  的既有契约**不得改动**。handler 通过 {@link ModifierContext}（`SystemContext` 的**结构化扩展**）
  拿到 `World`，而不是往 `SystemContext` 里加字段。
- C7 **不重排既有系统**：M1/M2 的六段相对顺序（`Movement .. Lifespan`）**一字不改**；
  `LifespanSystem` 仍为**最后一段**；`ModifierSystem` 仍在 `CollisionSystem` 之后、`LifespanSystem` 之前。
  `StatusEffectSystem` 是**插入**而非重排（见 §5.2）。
- C8 **事件只描述事实，不描述策略**（沿用 spec 05 C8）：`HitEvent` 不变；DoT **不产生任何事件**。
- C9 **既有行为零回归**：无祝福 / 无状态实体的一切既有行为（伤害 / 顿帧 / 硬直 / 击退 / 无敌帧消费 /
  判定圆寿命）必须**逐 Tick 逐位不变**。`ModifierSystem` 对空事件队列仍是**严格无操作**；
  `StatusEffectSystem` 对无状态实体仍是**严格无操作**。
- C10 **防递归不变**：`sourceModifier !== null` 的门**仍是分派链的第一道**，且在**任何 handler 调用之前**。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **修饰器处理器（`IModifierHandler`）** | 一个祝福行为的实现：`id` + `onHit(event, context)`。**无跨 Tick 状态**。 |
| **修饰器注册表（`ModifierRegistry`）** | `id -> handler` 的分派表。由 `createDefaultModifierRegistry()` 装配，`createDefaultSystems()` 每次调用建一份新实例。 |
| **分派（Dispatch）** | `ModifierSystem` 对一条 `HitEvent` 执行的固定三步链：防递归门 → 持有者遍历 → 查表调用。 |
| **状态（Status / `StatusEffect`）** | 挂在实体上、带自身计时器的一段持续效果实例：`stacks` / `maxStacks` / `remainingTicks` / `intervalTicks` / `ticksUntilProc` / `damagePerStack`。 |
| **状态规格（`StatusEffectSpec`）** | 状态的**定义**（不含运行时计数）；施加时把定义字段**拷贝**到实例上。 |
| **层数（Stacks）** | 同一状态的强度倍率。伤害型状态的每 Tick 伤害 = `damagePerStack × stacks`。 |
| **触发间隔（`intervalTicks`）** | 两次 DoT 结算之间的 Tick 数。 |
| **剩余持续（`remainingTicks`）** | 状态的剩余寿命；归零即摘除。 |
| **跳伤 / 结算（Proc）** | 一次 DoT 结算：直接扣减 HP，**不生成判定圆、不抛事件**。 |
| **真实伤害（True damage）** | 不经命中管道、不触发受击反馈（顿帧 / 硬直 / 击退）的伤害。 |
| **刷新（Refresh）** | 再次施加同一状态时，把 `remainingTicks` 与 `ticksUntilProc` **重置为规格值**（并从本次命中起重新计时）。 |
| **熔断（Cap）** | `stacks` 被钳制在 `maxStacks`；到顶后继续命中只刷新、不增层。 |

---

## 3. 组件与类型契约

### 3.1 `StatusEffectSpec` — 状态定义（新增）
```ts
export interface StatusEffectSpec {
  readonly id: string;            // 状态 id，实体范围内唯一
  readonly maxStacks: number;     // 层数上限，正整数
  readonly durationTicks: number; // 单次施加的寿命，正整数
  readonly intervalTicks: number; // 两次结算的间隔，正整数
  readonly damagePerStack: number;// 每层每 Tick 伤害；0 = 非伤害型状态
}
```
- **施加时拷贝**：`maxStacks` / `intervalTicks` / `damagePerStack` 会写进实例，因此**运行中的状态
  完全由快照可观测**，且中途改常量不会让在途状态「半新半旧」。
- **`damagePerStack = 0` 合法**：易伤 / 减速这类状态不结算伤害，但仍占用层数与计时器。
- **校验**：`maxStacks` / `durationTicks` / `intervalTicks` 必须为正整数，`damagePerStack` 必须为非负有限数，
  否则抛 `RangeError`（配置错误必须当场炸，不能静默变成「永不结算」）。

### 3.2 `StatusEffectComponent` / `StatusEffect` — 状态容器（新增）
```ts
export interface StatusEffect {
  readonly id: string;        // 键，施加后不变
  stacks: number;             // 1 .. maxStacks
  maxStacks: number;          // 施加时拷贝
  remainingTicks: number;     // 剩余寿命
  intervalTicks: number;      // 触发间隔（施加时拷贝）
  ticksUntilProc: number;     // 距下次结算的 Tick 数；每次结算后重载为 intervalTicks
  damagePerStack: number;     // 每层每 Tick 伤害（施加时拷贝）
}

export class StatusEffectComponent extends ComponentBase {
  public effects: StatusEffect[];   // 按 id 升序、id 唯一
}
```
| 契约 | 说明 |
|---|---|
| **一个组件装多种状态** | 实体常同时中毒 / 燃烧 / 易伤；一状态一组件会逼 ECS 层认识每个状态名。 |
| **升序且唯一** | `effects` 按 `id` 升序、每个 id 至多一条。**多样性由 `stacks` 表达，绝不由重复条目表达**，与 `TagComponent.tags` / `ModifierComponent.modifiers` 同契约（快照逐位可比）。 |
| **稳定形状** | 状态摘除后**不卸载组件**（可能留下空 `effects`），与 `FreezeComponent` / `TagComponent` 同规则，避免快照 churn。 |
| **装配唯一来源** | `spawnCombatant` 为**每个**战斗单位挂载一个空的 `StatusEffectComponent`（见 §3.4 / AC-10）。 |

### 3.3 酒神打击与毒的常量（新增）
| 常量 | 值 | 含义 |
|---|---|---|
| `DIONYSUS_BLIGHT_MODIFIER`（`ModifierComponent.ts`） | `'dionysus_strike'` | 酒神打击的修饰器 id |
| `POISON_STATUS_ID`（`StatusEffectComponent.ts`） | `'poison'` | 中毒状态 id |
| `BURN_STATUS_ID` | `'burn'` | 燃烧状态 id（容器通用性演示；**无祝福产生**） |
| `VULNERABLE_STATUS_ID` | `'vulnerable'` | 易伤状态 id（容器通用性演示；**无祝福产生**） |
| `DEFAULT_POISON_MAX_STACKS` | `5` | 中毒层数上限（AC-02 的「假设上限 5」） |
| `DEFAULT_POISON_DURATION_TICKS` | `120` | 中毒持续（120 Tick @60fps = 2 s） |
| `DEFAULT_POISON_INTERVAL_TICKS` | `30` | 结算间隔（30 Tick @60fps = 0.5 s） |
| `DEFAULT_POISON_DAMAGE_PER_STACK` | `4` | 每层每次结算伤害 |

> **`durationTicks` 必须是 `intervalTicks` 的整数倍**（此处 `120 = 4 × 30`）：一次施加恰好产生
> `duration / interval` 次结算，且**最后一次落在状态到期的那一拍**（§4.2）。这不是巧合，是契约。

### 3.4 状态自由函数（POD 契约 C4）
| 函数 | 签名 | 语义 |
|---|---|---|
| `applyStatusEffect` | `(world, id, spec) => void` | 施加或**叠加**：不存在则建（`stacks = 1`，两个计时器都取规格值）；已存在则 `stacks = min(stacks + 1, maxStacks)` 并**重置 `remainingTicks` 与 `ticksUntilProc`**。组件缺失时**惰性挂载**。实体已销毁 ⇒ **no-op**（不抛异常）。规格非法 ⇒ 抛 `RangeError`。 |
| `getStatusEffect` | `(world, id, statusId) => StatusEffect \| undefined` | 取运行中的状态实例。 |
| `hasStatusEffect` | `(world, id, statusId) => boolean` | 是否运行中；**组件缺失 ⇒ `false`**。 |
| `removeStatusEffect` | `(world, id, statusId) => void` | 摘除单个状态；无组件 / 未持有 ⇒ no-op；**不卸载组件**。 |

### 3.5 修饰器注册表契约（新增，`src/ecs/modifiers/`）
```ts
export interface ModifierContext extends SystemContext {
  readonly world: World;   // handler 需要读写世界
}

export interface IModifierHandler {
  readonly id: string;
  onHit(event: HitEvent, context: ModifierContext): void;
}

export class ModifierRegistry {
  register(handler: IModifierHandler): void;   // id 重复 ⇒ 抛 Error（配置 bug 必须当场炸）
  get(id: string): IModifierHandler | undefined;
  has(id: string): boolean;
  readonly size: number;
  readonly ids: readonly string[];             // 升序（码元序）
}

export function createDefaultModifierRegistry(): ModifierRegistry; // zeus_strike + dionysus_strike
```
| 契约 | 说明 |
|---|---|
| **`ModifierContext` 是扩展而非修改** | 它是 `SystemContext` 的**结构化超集**（`tick` / `elapsedSeconds` / `fixedDeltaSeconds` / `input` + `world`），因此 `SystemContext` 的既有契约与 `GameSimulator.step` **零改动**（C6）。签名在语义上仍是「`onHit(event, context)`」，`context` 就是本 Tick 的系统上下文。 |
| **handler 无状态** | 除 `id` 外不得有字段（C5）。一切需要跨 Tick 记忆的东西必须落在组件上。 |
| **注册表实例隔离** | `createDefaultSystems()` 每次调用建一份**新**注册表（同 `EventQueue` 的隔离规则），两个仿真器不可能共享 handler 实例。 |
| **未知 id 静默跳过** | 数据表可以引用本构建未附带的祝福；分派时 `registry.get(id)` 返回 `undefined` ⇒ 不做事、不报错。 |
| **`sourceModifier` 的唯一用途仍是防递归** | 沿用 spec 05 §3.4，不得复用作「是否纯伤害」等语义。 |

### 3.6 `ModifierSystem` 构造契约（变更）
```ts
constructor(events: EventQueue = new EventQueue(),
            registry: ModifierRegistry = createDefaultModifierRegistry())
```
- 形参均可选 ⇒ 既有 `new ModifierSystem(events)` 调用**无需改动**（既有测试与 `createDefaultSystems` 均不受影响）。

---

## 4. 语义契约

### 4.1 酒神打击契约（AC-02）
当一次**触发命中**（`sourceModifier === null`）的攻击者持有 `dionysus_strike` 时，
`DionysusBlightModifier.onHit` 对 `event.targetId` 施加中毒：

| 情形 | 结果 |
|---|---|
| 目标**没有** `poison` | 新建：`stacks = 1`，`remainingTicks = 120`，`ticksUntilProc = 30` |
| 目标**已有** `poison` 且未到上限 | `stacks += 1`，`remainingTicks = 120`，`ticksUntilProc = 30` |
| 目标**已有** `poison` 且已到上限 | `stacks` **保持 5**，`remainingTicks` / `ticksUntilProc` **照常刷新** |

- **刷新是纯收益**：持续时长从**最近一次命中**起重新计算；结算倒计时也一并重置，
  因此持续命中的目标会被不断推迟下一次跳伤。
- **上限只钳制层数，不钳制刷新**：到顶后继续命中不会「浪费」，仍延长状态寿命。
- **施加不产生任何可观测的即时伤害**：命中当 Tick 的伤害来自基础攻击本身，DoT 从下一 Tick 才开始计时。

### 4.2 DoT 结算契约与相位核算（AC-03，**本 Spec 的核心**）
`StatusEffectSystem` 排在 `ModifierSystem` **之前**（§5.2），因此：

```
命中 Tick T ── ModifierSystem 施加状态 ──▶ 该 Tick 的状态时钟【尚未走】
Tick T+1 起 ── StatusEffectSystem 每 Tick 倒计时 ──▶ 归零即结算
```

**逐 Tick 语义**（对每个 `remainingTicks > 0` 的状态）：

```
remainingTicks -= 1
ticksUntilProc -= 1
if (ticksUntilProc <= 0) { 扣血 damagePerStack * stacks; ticksUntilProc = intervalTicks }
if (remainingTicks  <= 0) { 摘除该状态 }
```

⇒ **可断言的闭式结论**：
| 量 | 取值 |
|---|---|
| 第 k 次结算的 Tick | `T + k × intervalTicks`（k = 1, 2, 3, …） |
| 摘除的 Tick（Tick 末） | `T + durationTicks` |
| 一次施加的结算次数 | `durationTicks / intervalTicks`（`120 / 30 = 4`） |
| 单次结算伤害 | `damagePerStack × stacks` |

- **结算先于到期判定**：当 `durationTicks` 恰为 `intervalTicks` 的整数倍时，最后一次结算与摘除
  **落在同一拍**（先扣血、后摘除）。若把两个 `if` 交换，第 4 次结算会静默消失。
- **为什么必须排在 `ModifierSystem` 之前**（§10 取舍 1）：若排在之后，施加当 Tick 就会走一次倒计时，
  于是「首次结算在 `T + 30`」会变成 `T + 29`、摘除会变成 `T + 119` ——
  **本 Spec 的每一个数字都会静默少 1**。这与 spec 05 §4.4 的判定圆相位问题是同一类陷阱，
  但此处用**管道位置**（而非 `+1` 补偿）解决，好处是常量值与字段值**字面一致**（`ticksUntilProc` 就是 `intervalTicks`），
  快照断言不需要心算偏移。

### 4.3 DoT 是「真实伤害」（AC-03）
一次结算**只做一件事**：`applyDamage(world, targetId, damagePerStack * stacks)`。

| 不允许发生 | 原因 |
|---|---|
| 生成 `HitboxComponent` 实体 | 那会把它交给 `CollisionSystem`，重新走命中判定 |
| 抛 `HitEvent` | 那会让修饰器管道**对 DoT 二次响应**（例如中毒触发雷击），并且无法为 DoT 定义合法的 `attackerId` |
| 写顿帧（`applyFreeze`） | 会**延长**中毒者身上正在进行的顿帧，破坏 spec 04 §6 的时序表 |
| 进入 `HITSTUN` | 会让持续伤害变成**永久硬直锁**（每 30 Tick 一次，硬直 8 Tick 且被反复续期） |
| 写 `KnockbackComponent` | 它是**覆盖写**（spec 04 §4.4），会**清零**基础命中写下的击退 |
| 消耗 / 检查无敌帧 | 状态伤害不是一次「命中」；已经生效的中毒不会因为目标翻滚而暂停 |

- **`StatusEffectSystem` 不做冻结门控**：顿帧压制的是**动作**（移动 / 冲刺 / 状态机 / 攻击），
  而状态是**持续存在的世界事实**。若让 4 Tick 的顿帧重排中毒计数器，DoT 时序就会依赖
  与之无关的战斗事件（§10 取舍 2）。
- **`StatusEffectSystem` 不产生事件**，因此**不存在**「DoT → 事件 → 修饰器 → 再注入」的路径；
  管道是单向的（spec 05 §4.1）。

### 4.4 注册表分派（AC-04）
`ModifierSystem` 对 `drain()` 得到的**每一个**事件，按**固定顺序**执行：

1. **防递归门（最高优先级）**：`event.sourceModifier !== null` ⇒ **直接返回**。
   不查组件、不查注册表、**不调用任何 handler**。
2. **持有者遍历**：取 `event.attackerId` 的 `ModifierComponent`；缺失 ⇒ 返回。
   否则**按 `modifiers` 的升序**逐条处理（`addModifier` 保证升序）。
3. **查表分派**：`registry.get(modifierId)`；未注册 ⇒ 静默跳过；已注册 ⇒ `handler.onHit(event, context)`。

- **门序不可交换**：第 1 步必须在第 2/3 步之前（沿用 spec 05 §4.2）。否则雷击命中会再次满足持有者判定，
  形成 `1→2→4→…` 的指数爆炸。
- **多祝福同时生效**：一个攻击者持有多个祝福时，一次命中会**依次触发全部**已注册 handler，
  顺序由 id 升序唯一确定（AC-04 断言 zeus + dionysus 双持时两种效果都发生）。
- **空队列严格无操作**（C9）：`drain()` 为空时**连 `ModifierContext` 都不构造**，直接返回。

---

## 5. 系统契约与管道顺序

### 5.1 各系统职责（M3-T02 变更点）
| 系统 | 变更 |
|---|---|
| `StatusEffectSystem`（新） | 每 Tick 遍历 `StatusEffectComponent`，倒计时；到期即结算（直接扣血）；`remainingTicks` 归零即摘除。**不生成实体、不抛事件、不做冻结门控**。 |
| `ModifierSystem` | 由「硬编码 zeus 效果」改为「注册表分派」。构造新增可选 `registry` 形参。防递归门序、全量 `drain`、空队列无操作**一字不改**。 |
| `ModifierRegistry`（新） | `id -> handler` 表；`createDefaultModifierRegistry()` 注册 `zeus_strike` 与 `dionysus_strike`。 |
| `pipeline.ts` | 在 `CollisionSystem` 与 `ModifierSystem` 之间插入 `StatusEffectSystem`（10 段）。 |
| `spawn-helpers.ts` | `spawnCombatant` 挂载空 `StatusEffectComponent`。 |
| 其余系统 | **不变**。 |

### 5.2 规范管道（硬契约，M3-T02 扩展）
```
PlayerControllerSystem -> FreezeSystem -> MovementSystem -> DashSystem -> StateSystem
  -> CombatActionSystem -> CollisionSystem -> StatusEffectSystem -> ModifierSystem
  -> LifespanSystem
```

**扩展规则（不得违反）**：
1. **M1/M2 六段相对顺序一字不改**（`MovementSystem .. LifespanSystem`），`LifespanSystem` 仍是**最后一段**。
2. `StatusEffectSystem` **必须**排在 `CollisionSystem` **之后**——施加状态的那次命中必须已结算完毕。
3. `StatusEffectSystem` **必须**排在 `ModifierSystem` **之前**——这是 §4.2 相位契约的**唯一**实现手段。
4. `ModifierSystem` 仍**必须**排在 `CollisionSystem` 之后（读本 Tick 事件）、`LifespanSystem` 之前
   （注入的判定圆需被判定过才销毁，spec 05 §5.2）。
5. 不得把 `StatusEffectSystem` 放到 `LifespanSystem` 之后——`LifespanSystem` 的末位是硬契约。

---

## 6. 时序硬契约（逐 Tick，QA 将逐 Tick 断言）

### 6.1 基准场景
`fps = 60`；玩家 `(0, 0)`、`facingRadians = 0`、持有 `dionysus_strike`；敌人 `(1.5, 0)`（受击圆半径 `0.5`）；
Tick `0` 注入 `keyDown('attack')`。基础判定圆圆心 `(0.75, 0)`、半径 `1.0`、伤害 `10`、寿命 `15`、顿帧 `4`、击退 `12`。
毒规格：`maxStacks = 5`、`durationTicks = 120`、`intervalTicks = 30`、`damagePerStack = 4`。

### 6.2 单次命中（`T = 0`）
| Tick | `StatusEffectSystem` | `ModifierSystem` | 敌方 hp | 中毒 |
|---|---|---|---|---|
| **`T = 0`** | （状态尚不存在） | 基础命中 ⇒ 伤害 `10`；施毒（`stacks = 1`，`remaining = 120`，`untilProc = 30`） | `90` | 1 层 |
| `T+1` | `120→119`、`30→29` | 队列空 ⇒ 无操作 | `90` | 1 层 |
| `T+29` | `92→91`、`2→1` ⇒ **尚未结算** | 无操作 | `90` | 1 层 |
| **`T+30`** | `untilProc 1→0` ⇒ **结算 `4`**，重载 `30`；`remaining = 90` | 无操作 | **`86`** | 1 层 |
| `T+60` | 结算 `4`；`remaining = 60` | 无操作 | **`82`** | 1 层 |
| `T+90` | 结算 `4`；`remaining = 30` | 无操作 | **`78`** | 1 层 |
| **`T+120`** | `untilProc 1→0` ⇒ 结算 `4`；`remaining 1→0` ⇒ **摘除** | 无操作 | **`74`** | 0（已摘除） |
| `T+121` 起 | 无状态 ⇒ 严格无操作 | 队列空 ⇒ 无操作 | `74` 恒定 | 0 |

**由该表派生的可断言事实（MUST）**：
1. **恰好 4 次结算**，落在 Tick `30 / 60 / 90 / 120`，间隔**恰好 30**。
2. 总伤害 `4 × 4 = 16`，终值 `hp = 100 − 10 − 16 = 74`。
3. **`T+30` 之前零伤害**、**`T+120` 之后零伤害**（到期即停，永不再跳）。
4. **零反馈**：顿帧窗口仍是 `T+1..T+4`；`HITSTUN` 仍是 Tick `0` 进入、Tick `12` 退出；
   击退位移仍是 `8 × 0.2 = 1.6`（`x` 停在 `3.1`）。四次结算**都不改变**其中任何一项。
5. **零注入**：Tick `14` 之后世界里**不存在任何判定圆**，`entityCount` 恒为 `2`。
6. **零事件**：整段脚本在事件总线上**只有 1 条 `HitEvent`**（Tick `0` 的基础命中）。

> `T+29` 一行是**倒计时的最后一个未结算观测点**：`ticksUntilProc` 此时为 `1`，因此 `T+30` 才归零并结算。
> 它同时是 QA 用来钉住「`T+30` 之前零伤害」的那一拍（§7 AC-03 / G4）。

### 6.3 叠层与刷新（第 2 次命中在 `T2 = 17`）
> `T2 = 17` 是真实管道的产物：攻击承诺 12 个非冻结 Tick，命中当 Tick 的顿帧再冻结攻击者 4 个 Tick
> （第 5 Tick 恢复），故状态机在 Tick `16` 计满 12，Tick `17` 交还控制权 ⇒ 第二次攻击可在 Tick `17` 出手。

| Tick | 状态时钟（进 ModifierSystem 前） | `ModifierSystem` | 敌方 hp | 中毒 |
|---|---|---|---|---|
| `0` | — | 命中 1 ⇒ `stacks = 1`，`remaining = 120`，`untilProc = 30` | `90` | 1 层 |
| `17` | `untilProc 13→12`、`remaining 103→102` | 命中 2 ⇒ `stacks = 2`，**两个计时器都重置**为 `120` / `30` | `80` | 2 层 |
| `47` | `untilProc 1→0` | 无操作 | **`72`**（−8） | 2 层 |
| `77` | 同上 | 无操作 | **`64`**（−8） | 2 层 |
| `107` | 同上 | 无操作 | **`56`**（−8） | 2 层 |
| `137` | 结算 `8` 后 `remaining 1→0` | 无操作 | **`48`**（−8），状态摘除 | 0 |
| `138` 起 | — | — | `48` 恒定 | 0 |

**可断言事实**：单次结算伤害由 `4` **翻倍为 `8`**；结算节奏为 `17 + k × 30`；
**状态在 Tick `130` 仍然存活**（若未刷新，单次施加会在 Tick `120` 到期）⇒ 刷新真实生效。

### 6.4 上限熔断（6 次命中，`T = 0, 17, 34, 51, 68, 85`）
| 命中序号 | Tick | 施加后 `stacks` |
|---|---|---|
| 1 | `0` | 1 |
| 2 | `17` | 2 |
| 3 | `34` | 3 |
| 4 | `51` | 4 |
| 5 | `68` | **5** |
| 6 | `85` | **5**（熔断：`min(6, 5)`） |

**可断言事实**：`stacks` 停在 `5`；Tick `85` 之后的下一次结算（`85 + 30 = 115`）单次伤害为
`5 × 4 = 20`（等于上限 × 每层伤害）。

### 6.5 无敌帧分支
沿用 spec 03 §4.4：受击者持 `INVULNERABLE_TAG` 时命中被**整次忽略** ⇒ 无伤害、无反馈、**无 `HitEvent`**
⇒ 修饰器管道拿不到事件 ⇒ **不会中毒**。无敌帧因此对状态系统完全透明。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 验收项 | 判据 | 优先级 |
|---|---|---|---|
| **AC-01** | 状态容器 | 实体可挂 `StatusEffectComponent` 并**同时**存储多种状态（`effects` 按 id 升序唯一）；每种状态记录**当前层数 / 层数上限 / 剩余持续 Ticks / 触发间隔 Ticks**（另含 `ticksUntilProc` / `damagePerStack`） | 必达（派发要求） |
| **AC-02** | 酒神打击契约 | 命中后给目标施加「中毒」；每次叠加**刷新持续时间**；层数**不超过上限**（`maxStacks = 5`），到顶后继续命中只刷新不增层 | 必达（派发要求） |
| **AC-03** | DoT 结算契约 | 每隔 `intervalTicks` 对目标造成 `固定伤害 × 层数` 的**真实伤害**：**不生成判定圆、不抛 `HitEvent`、不触发受击硬直（HITSTUN）与顿帧（Hitstop）**；`remainingTicks` 归零即摘除 | 必达（派发要求） |
| **AC-04** | 数据驱动注册表 | 存在 `IModifierHandler`（含 `onHit(event, context)`）与 `ModifierRegistry`；`zeus_strike` 逻辑已抽离为 `ZeusStrikeModifier` 并注册；`ModifierSystem` 仅做「遍历事件 + 遍历攻击者 modifiers + 查表分派」，不含任何具体祝福逻辑；**防递归门仍在最前** | 必达（派发要求） |
| **AC-05** | 既有契约零回归 | 无祝福 / 无状态实体的行为逐 Tick 逐位不变：M1/M2 的 143 用例全绿；`CollisionSystem` 四条 skip 顺序、无敌帧消费、判定圆 15 Tick 寿命、击退 `8 × 0.2 = 1.6`、顿帧 4 Tick 均不变 | 保障门 |
| **AC-06** | 确定性回放 | 含施毒 + 叠层 + 雷击注入的完整脚本，在两个独立 `GameSimulator` 上逐 Tick `snapshot()` `toEqual` 一致（注入实体 id 亦一致） | 保障门 |
| **AC-07** | 总线 Tick 边界为空 | 任意 Tick 结束时 `EventQueue.size === 0`；DoT 结算**不产生**新事件（150 Tick 内仅 1 条 `HitEvent`） | 保障门 |
| **AC-08** | 管道顺序硬契约 | `createDefaultSystems()` 顺序 = `… CollisionSystem, StatusEffectSystem, ModifierSystem, LifespanSystem`（10 段）；M1/M2 六段相对顺序不变，`LifespanSystem` 仍最后 | 保障门 |
| **AC-09** | 类型安全与纯逻辑 | `npm run typecheck` 零错误；无 `any` / 非空断言 / `@ts-ignore`；`npm run lint` 0 error 0 warning（`src/` 无 DOM / 墙钟 / 随机） | 保障门 |
| **AC-10** | 装配唯一来源 | `StatusEffectComponent` 与 `ModifierComponent` 一样**只**在 `spawn-helpers.ts::spawnCombatant` 装配，玩家 / 敌人组件集不可能漂移 | 保障门 |

> **AC-01 … AC-04 为任务派发明确要求**；**AC-05 … AC-10 为保障前四条可信而设的补充门**。
> AC-01 … AC-04 与 AC-06 … AC-08 由 `tests/combat/status_effects.test.ts` 断言（22 用例）；
> AC-05 由既有 `tests/combat/*` 与 `tests/harness/*` 断言（合计 **165 用例全绿**）；
> AC-09 由 `npm run lint` + `npm run typecheck` 覆盖。

---

## 8. 失败模式（Failure Modes）

| 模式 | 后果 | 缓解 |
|---|---|---|
| `StatusEffectSystem` 排在 `ModifierSystem` **之后** | 施加当 Tick 即被倒计时 ⇒ 首次结算变 `T+29`、摘除变 `T+119`；本 Spec 全部数字静默少 1 | §4.2 / §5.2 规则 3；AC-08 断言顺序 + G4 断言「Tick 30 才掉血」 |
| 结算与到期两个 `if` 顺序颠倒 | `duration = k × interval` 时第 `k` 次结算**静默消失**（总伤害少一份） | §4.2：结算**先于**到期判定；G4 断言「恰好 4 次」 |
| 用 `remainingTicks % intervalTicks === 0` 推导结算 | 刷新后相位被破坏，叠层场景的结算节奏全错 | §3.2：**显式** `ticksUntilProc` 字段，刷新即重置 |
| 刷新时**只**重置 `remainingTicks`、不重置 `ticksUntilProc` | 叠层后首次结算仍按旧相位落点，与「从第 2 次命中起重新计算」不符 | §4.1：**两个计时器都重置**；G2 断言 47/77/107/137 |
| 叠层**不钳制**在 `maxStacks` | 连击可在数秒内堆出无上限 DoT，数值崩坏 | §4.1：`min(stacks + 1, maxStacks)`；G3 断言 6 次命中后仍为 5 |
| 层数用**重复条目**表达（同一 id 多条） | 快照顺序依赖施加顺序，确定性回放失败 | §3.2：**升序唯一**，多样性走 `stacks`；G0 断言 |
| 用 `localeCompare` 排序 id | 排序结果依赖 ICU / 语言环境，跨机器快照不一致 | C2：一律用 UTF-16 码元序（`<` / `>`） |
| DoT 通过**生成判定圆**造成伤害 | ① 走 `CollisionSystem` 会重新判定命中；② 每次结算都触发 `HitEvent` ⇒ 修饰器对 DoT 二次响应；③ 带默认反馈会**续期顿帧**并**清零击退** | §4.3：**直接 `applyDamage`**；G5 断言无判定圆、无新实体、无新事件 |
| DoT **抛 `HitEvent`** | 事件缺少合法 `attackerId`；中毒会触发雷击等一切 `OnHit` 效果 | §4.3 / §8 上行；G5 断言 150 Tick 内仅 1 条事件 |
| DoT 写 `HITSTUN` | 每 30 Tick 一次、每次 8 Tick ⇒ **硬直锁**，玩家永久无法行动 | §4.3；G5 断言 `HITSTUN` 观测集恰为 Tick `1..11` |
| DoT 写 `KnockbackComponent` | 覆盖写会**清零**基础命中的击退，静默破坏 spec 04 §4.4 | §4.3；G5 断言位移恰为 `1.6`（`x = 3.1`） |
| DoT 走冻结门控（`isFrozen` 就跳过） | 时序依赖无关战斗事件；顿帧内的结算被永久丢弃 | §4.3：状态是**世界事实**，不做冻结门控 |
| DoT 检查 / 消耗无敌帧 | 翻滚中的目标「免疫」已生效的中毒，与「真实伤害」语义矛盾 | §4.3：状态伤害不是一次命中 |
| 状态计时器放在**系统字段**上（跨 Tick 隐藏状态） | 回放不一致；两个实体互相污染 | C5：计数器**必须**落在组件上 |
| `StatusEffectSystem` 摘除状态后**卸载组件** | 快照形状在到期前后突变，`toEqual` 回放断言炸 | §3.2：组件保持挂载，允许空 `effects` |
| 修饰器效果仍留在 `ModifierSystem` 里 | 注册表形同虚设；新增祝福必须改系统，管道与效果重新耦合 | AC-04：`ModifierSystem` **不得**含任何具体祝福逻辑 |
| `ModifierSystem` 先判持有者、后判 `sourceModifier` | 雷击命中再次满足持有者判定 ⇒ 指数爆炸 `1→2→4→…` | §4.4 门序不可交换；AC-04 + G6 断言带标记事件不达 handler |
| 注册表**全局单例** | 两个仿真器共享 handler；未来 handler 一旦有状态即互相污染 | §3.5：`createDefaultSystems()` 每次建新实例；G6 断言实例独立 |
| 未知 modifier id 时**抛异常** | 数据表引用未来祝福即崩服 | §3.5：`get()` 返回 `undefined` ⇒ 静默跳过；G6 断言 |
| `ModifierContext` 直接改 `SystemContext` | 改动 `GameSimulator.step` 与通用仿真核契约（C6） | §3.5：**扩展**（`extends`）而非修改 |
| handler 持有字段（如缓存 target） | 跨 Tick 隐藏状态，回放不一致 | §3.5：handler 除 `id` 外**零字段** |
| `StatusEffectComponent` 装配散落在工厂里 | 玩家 / 敌人组件集漂移 | §3.2 / AC-10：只在 `spawn-helpers.ts` 一处装配 |
| `durationTicks` 不是 `intervalTicks` 的整数倍 | 结算次数非整数 ⇒ 最后一次结算落在到期之后，被静默丢弃 | §3.3：`120 = 4 × 30`；G4 断言 |

---

## 9. 追溯（Traceability）

- **本 Spec → 测试**（`tests/combat/status_effects.test.ts`，22 用例）：
  - `G0` 组件语义：惰性挂载、多状态并存与升序唯一、叠层与熔断、摘除不卸载、非法规格抛错、
    已销毁实体 no-op、战斗单位默认挂载（AC-01 / AC-10）
  - `G1` 酒神打击：命中当 Tick 施毒且两个计时器取初值；攻击者不持有 ⇒ 不施毒（AC-02）
  - `G2` 叠层与刷新：`stacks = 2`、单次结算翻倍（`4 → 8`）、结算落点 `47/77/107/137`、
    状态活过 Tick `120`（刷新真实生效）、Tick `137` 摘除（AC-02）
  - `G3` 上限熔断：6 次命中后 `stacks = 5`，Tick `115` 单次伤害 `20 = 5 × 4`（AC-02）
  - `G4` DoT 时序：结算落点恰为 `30/60/90/120`、总伤害 `16`、终值 `74`、Tick `121` 后恒定；
    逐 Tick 倒计时与结算后重载（AC-03）
  - `G5` 真实伤害：顿帧观测集恰为 `1..4`、`HITSTUN` 观测集恰为 `1..11`、结算 Tick 不冻结不硬直、
    位移恰为 `1.6`、零判定圆、零新增实体、150 Tick 内仅 1 条 `HitEvent`（AC-03 / AC-07）
  - `G6` 注册表契约：`ids` 升序、重复注册抛错、实例隔离、handler 收到事件 + 含 `world` 的 context、
    防递归门在最前、未知 id 静默跳过、空队列严格无操作、双持时两种效果都发生（AC-04）
  - `G7` 管道顺序 10 段 + `StatusEffectSystem` 位置约束；含施毒 / 叠层 / 雷击的脚本逐 Tick 一致（AC-08 / AC-06）
- **本 Spec → 实现**：
  - 模块（新增）：`src/ecs/modifiers/{ModifierRegistry,ZeusStrikeModifier,DionysusBlightModifier,index}.ts`
  - 组件（新增）：`src/ecs/components/StatusEffectComponent.ts`
  - 组件（扩展）：`src/ecs/components/ModifierComponent.ts`（`DIONYSUS_BLIGHT_MODIFIER`）、`components/index.ts`
  - 系统（新增）：`src/ecs/systems/StatusEffectSystem.ts`
  - 系统（重构）：`src/ecs/systems/ModifierSystem.ts`；`pipeline.ts`（10 段）；`systems/index.ts`
  - 预制体：`src/ecs/prefabs/spawn-helpers.ts`；barrel：`src/ecs/index.ts`
  - 测试同步：`tests/combat/feedback.test.ts` G4 与 `tests/combat/boons.test.ts` G7 的管道顺序断言
    由 9 段扩为 10 段（`hit_detection.test.ts` 仅同步头注）
- **对既有 Spec 的扩展登记**：
  - spec 05 §5.2 的 9 段绝对顺序由本 Spec §5.2 **扩展**为 10 段；
    **六段相对顺序、`ModifierSystem` 的两条位置约束与 `LifespanSystem` 末位全部不变**（C7）。
  - spec 05 §4.2 的分派链由本 Spec §4.4 **泛化**为「注册表分派」；
    防递归门、持有者语义与门序**完全等价**（AC-05 以全量回归证明）。
  - spec 05 §3.4 的 `sourceModifier` 语义**不变**，且未被新代码复用作其他用途。
  - spec 03 §4.4（无敌帧消费）在本 Spec 下**保持不变**，并额外保证「无敌帧命中 ⇒ 不施毒」（§6.5）。
- 变更本 Spec 须同步更新测试与实现。

---

## 10. 已知取舍（Known Trade-offs）

1. **用「管道位置」而非「`+1` 补偿」解决 DoT 相位**：另一种写法是把 `StatusEffectSystem` 放在
   `ModifierSystem` 之后，再在**施加时**把两个计数器种成 `值 + 1`（`applyFreeze` / `HITSTUN` 用的
   正是这种补偿手法）。代价是：① 补偿只能出现在**首次施加**，结算后的重载值必须回到 `intervalTicks`，
   规则不对称、极易写错；② 组件字段的值**永远不等于**常量，快照断言与代码阅读都需要心算偏移。
   把系统提前一段则让「字段值 == 常量值」「第 k 次结算 = `T + k × interval`」同时成立，
   代价只是必须把这条位置约束写进硬契约并由 AC-08 守住。
2. **DoT 不被顿帧暂停**：让顿帧也暂停 DoT 计数器，可以让「一次 4 Tick 的顿帧」完全不影响状态时序，
   但会让 DoT 的总时长依赖攻击者命中次数（战斗事件反过来改状态节奏），且与「状态是持续世界事实」的
   直觉相悖。本里程碑选择**不暂停**，并把「DoT 与顿帧正交」写成可断言事实（G5）。
3. **状态摘除后保留空组件**：与 `FreezeComponent` / `TagComponent` 一致，换来快照形状稳定；
   代价是「是否有状态」必须用 `effects.length === 0` 判断，不能靠组件是否存在。
4. **DoT 无伤害归属**：DoT 不抛事件，因此击杀统计 / 掉落归属 / `OnKill` 钩子都看不到 DoT 的贡献。
   这是 AC-03「不触发命中事件」的直接推论。若后续要做击杀归属，正确做法是**新增
   `DamageSourceEvent`**（含 `attackerId`）并让 `StatusEffectSystem` 发它，而不是复用 `HitEvent`
   —— 那会把「真实伤害」重新拖进命中管道。
5. **状态伤害不检查无敌帧**：翻滚中的目标仍会吃到已经生效的中毒。这是「真实伤害」的自然语义，
   也与 Hades 原作一致；若后续要支持「无敌可净化」，应作为**显式的状态属性**（如
   `pausedWhileInvulnerable`）加进 `StatusEffectSpec`，而不是在 `StatusEffectSystem` 里硬编码一个 tag 检查。
6. **`ModifierContext` 用结构化扩展而非改 `SystemContext`**：`SystemContext` 里加一个 `world`
   对所有系统都「顺手」，但会改动 `GameSimulator.step` 与通用仿真核的既有契约（C6），
   并把 `World` 变成「上下文的一部分」而非「系统的操作对象」。扩展类型的代价是 handler 签名多了一个
   自定义类型；收益是零契约变更 + 类型上仍是一个 `SystemContext`。
7. **`ModifierSystem` 对每个事件重新查组件（不缓存）**：单 Tick 事件数极少（战斗单位数十级），
   缓存带来的跨 Tick 状态风险（C5）远大于收益。同理，注册表用 `Map` 而非预计算数组：
   注册是启动期一次性行为，查询是每事件一次 `Map.get`。
8. **状态规格在施加时拷贝到实例**：让在途状态完全由快照可观测，且中途调常量不会让状态「半新半旧」；
   代价是同一状态的两个实例可能携带不同规格（旧实例保留旧参数）——这在「热更新祝福数值」的场景下
   反而是期望行为。
9. **`burn` / `vulnerable` 只有 id、没有行为**：AC-01 要求容器**通用**，因此定义它们的 id 并让
   `StatusEffectSpec` 支持 `damagePerStack = 0`；但本里程碑不附带任何产生 / 消费它们的祝福，
   以免把未验证的行为混进验收面。

---

## 11. 修订记录（Revision History）

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| rev.1 | 2026-09-28 | 程基岩 | 初版（M3-T02）：修饰器注册表（`IModifierHandler` / `ModifierContext` / `ModifierRegistry` / `ZeusStrikeModifier`）、状态容器（`StatusEffectComponent` / `StatusEffectSpec` / 自由函数）、DoT 时钟（`StatusEffectSystem`）、酒神打击（`DionysusBlightModifier`）、管道扩为 10 段；AC-01…AC-10 |
