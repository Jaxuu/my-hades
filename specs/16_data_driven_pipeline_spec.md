# 16 · Data-Driven Pipeline Spec（JSON 配置抽取、类型安全加载与 ECS 工厂重构）

| Field | Value |
|---|---|
| Spec ID | `SPEC-16-DATA-DRIVEN-PIPELINE` |
| Milestone | **M10 · 数据驱动管线**（T01） |
| Status | `accepted`（本文件为 M10-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/data/schemas.ts`（新）、`src/data/DataManager.ts`（新）、`src/data/bundled.ts`（新）、`src/data/index.ts`（新）、`assets/data/enemies.json`（新）、`assets/data/modifiers.json`（新）、`src/index.ts`、`src/ecs/prefabs/EnemyFactory.ts`（重写）、`src/ecs/prefabs/spawn-helpers.ts`（`EnemyPlacement` / `EnemySpawnSpec`）、`src/ecs/prefabs/EncounterFactory.ts`（dry-run 装配）、`src/ecs/components/EncounterStateComponent.ts`（`EnemySpawnSpec`）、`src/ecs/components/ModifierComponent.ts`（删除 `DEFAULT_ZEUS_*` / `DEFAULT_POSEIDON_*`）、`src/ecs/modifiers/{ZeusStrikeModifier,PoseidonDashModifier,index}.ts`（构造期注入配置）、`src/ecs/systems/EncounterSystem.ts`（`spawn` 调用形态）、`client/main.ts`（异步 Bootstrap + 类型 id）、`vitest.config.ts`（`setupFiles`）、`tests/harness/setup-config.ts`（新）、`tests/harness/config-fixtures.ts`（新）、`tests/data/data_manager.test.ts`（新）、13 份既有测试的调用点迁移 |
| Depends on | `specs/00_harness_spec.md`（确定性 / 无隐藏状态 / 组件即 POD / barrel 契约）、`specs/05_boon_modifier_spec.md`（`IModifierHandler` / `ModifierRegistry` / 注入判定圆 `activeTicks ≥ 2` 的相位理由）、`specs/08_encounter_and_death_spec.md`（「在接缝处大声失败」的既有先例：`resolveDashTuning` / `resolveAITuning` / `resolveEncounterConfig`）、`specs/12_armor_and_dash_boons_spec.md`（精英 = 更大身体 + 常驻护甲 + 更大血量池）、`specs/15_economy_and_victory_spec.md`（`loot` opt-in 与 `resolveLootDrops` 的装配期校验纪律） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境，`pool: 'threads'`）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

到 M9-T01 为止，这个引擎的**行为**已经完全由契约定义，但它的**数值**散落在代码里。`EnemyFactory` 自己声明 `DEFAULT_ELITE_ARMOR = 60`；`ModifierComponent` 声明 `DEFAULT_ZEUS_STRIKE_DAMAGE = 20`；`client/main.ts` 又各写一份「演示敌人 40 血、36 拍抬手」。于是「一个 grunt 有多少血」这个问题，在仓库里有三个互不知情的答案。

M10-T01 把「形状」与「数值」拆开：

- **形状**留在代码里（`EnemyConfig` / `ModifierConfig` 的 TypeScript 类型 + 一份手写运行时校验器）；
- **数值**搬到 `assets/data/*.json`，成为唯一来源。

拆开之后，两件此前做不到的事成为可能：改平衡不需要改（也不需要重新评审）引擎源码；一个坏数值**在进程开始模拟之前**就会被拒绝，而不是在若干拍之后以一个不动血条的形式浮出水面。

### 1.2 In Scope（做什么）

- **Schema 契约**（AC-01）：`EnemyConfig` / `ModifierConfig` 的类型定义与运行时校验；`SchemaError`。
- **类型安全加载**（AC-02）：`parseEnemyConfig` / `parseModifierConfig`，缺字段、错类型、越界值一律在**加载期**大声抛错，绝不把 `undefined` / `NaN` 漏进运行时。
- **同步组装约束**（AC-03）：`DataManager` 静态注册表 + `bootstrapData()` 异步引导，早于 `GameSimulator` 构造；`step()` 内零 IO、零校验、零查表失败。
- **JSON 资产**：`assets/data/enemies.json`、`assets/data/modifiers.json`。
- **工厂重构**（AC-04）：`EnemyFactory.spawn(world, enemyId, placement?)` / `spawnElite(world, enemyId, placement?)`，不再接受任何数值覆盖参数。
- **词缀重构**（AC-05）：`createDefaultModifierRegistry()` 在构造期读取 JSON，把判定半径 / 伤害 / 顿帧 / 击退 / 寿命注入 handler。
- **调用点迁移**（AC-06）：13 份既有测试的 108 处 spawn 调用点迁移到新 API，394 条既有用例逐条语义不变。
- **Harness 断言**（AC-07）：`tests/data/data_manager.test.ts`。

### 1.3 Out of Scope（显式排除）

- **组件级 `DEFAULT_*` 常量。** `DEFAULT_ATTACK_DAMAGE`、`DEFAULT_HITSTOP_TICKS`、`DEFAULT_POISON_*`、`DEFAULT_PICKUP_RADIUS`、`HP_UP_AMOUNT`、`DEFAULT_CAST_*`、玩家侧 `DEFAULT_DASH_*` 等**不在**本次迁移范围。理由有两条，且是硬的：
  1. **它们不是「敌人类型」的属性。** 玩家攻击的伤害不属于任何 `EnemyConfig`；把它塞进敌人表会让「玩家砍一下多少血」变成敌人数据的函数，这比硬编码更糟。
  2. **它们是装配接缝的兜底值，不是决策值。** `spawnCombatant` / `resolveDashTuning` / `resolveAITuning` 仍然需要一个「调用方没给」时的默认值；M10 让敌人路径**永远**给满所有字段（配置必填），所以这些兜底在敌人路径上已经不可达。把玩家侧也搬进 JSON 是一次独立重构（需要新增 `PlayerConfig`、`AttackConfig`、`StatusEffectConfig` 等四到五张表），属于后续里程碑。
  交付标准里的「不再存在 `hp: 100, maxSpeed: 5` 等硬编码业务魔法数字」，据此解释为：**敌人类型与词缀的数值**已全部搬空，工厂与词缀实现中不再有任何业务字面量（见 §5 AC-08 的可执行判据）。
- **配置热重载。** `DataManager` 只支持「一次引导 + 之后只读」。运行中换表会让「同一个种子必然复现」失效，属于独立设计（需要先回答「重载发生在哪一拍」）。
- **多套配置（难度档 / 关卡包）。** `loadAll` 是**替换**语义，因此「同时装载两套」目前不成立；真要做得先定义合并策略。
- **配置的可视化编辑器 / 生成器。** 本里程碑只交付「读 + 校验 + 装配」。
- **把 JSON 变成真正的 IO。** 见 §4.3 的取舍 1。

---

## 2. 术语与不变量

| ID | 不变量 | 为什么它是硬的 |
|---|---|---|
| **I1** | `src/data` 是**唯一**知道 JSON 存在的层。`src/ecs` 只通过 `DataManager` 读取**已解析**的配置对象，任何地方都不得直接 `import` 一个 `.json`。 | 单点入口是「校验无法被绕过」的前提：只要有一个消费者能拿到原始 JSON，AC-02 就退化成「大多数路径是安全的」。 |
| **I2** | 引擎侧只读取**解析后**的对象。原始 JSON 对象从不被交给任何系统或工厂。 | 解析器返回的是逐字段重建的新对象，因此「字段缺失」在类型层面就不存在——`EnemyConfig.maxHp` 是 `number`，不是 `number \| undefined`。这是「不把 `undefined` / `NaN` 漏进运行时」的**结构性**保证，而不是靠调用方自觉。 |
| **I3** | `DataManager` 在 Bootstrap 之前**拒绝回答**，且错误信息必须点名「没有装载配置」而不是「未知 id」。 | AC-03 的失败模式是「忘了引导」，不是「id 打错了」。两种错误给同一句话会把读者引向错误的方向（去查拼写，而问题在启动顺序）。 |
| **I4** | `loadAll` 是**原子**的：两张表全部解析成功后才替换注册表。任何一条失败 ⇒ 旧表原封不动。 | 「一半配置生效」是最难调试的状态：一部分敌人能生成、一部分不能，且失败取决于装载顺序。 |
| **I5** | `EnemyFactory.spawn` / `spawnElite` 的签名里**没有任何数值参数**。类型层面就不存在「传一个 maxHp 进去」这条路。 | 这是 AC-01 的机器可执行形式。文档写「不要硬编码」没有用；签名里没有这个位置才有用。 |
| **I6** | `step()` 内**零** `DataManager` 读取。所有配置在**构造期**（工厂每次 spawn 会查一次表，这是允许的；但**系统**的每 Tick 循环不查）被解析成具体值。 | 一次可能抛错的查表放在每 Tick 的循环里，等于给模拟循环装了一个「会在某一拍突然中止」的开关。`ModifierRegistry` 因此在构造期就把配置读进 handler 字段。 |
| **I7** | 配置的**存在与否**就是能力开关：`armor` 缺席 ⇒ 不挂 `ArmorComponent`；`ai` 缺席 ⇒ 不挂 `AIControllerComponent`；`hazard` / `loot` 同理。解析器**不写**「存在但为 `undefined`」的键。 | 装配层用 `options.x !== undefined` 判断是否挂组件。若解析器把缺席字段填成 `undefined` 键，`'ai' in config` 会变成 `true`，能力开关就失灵了。 |
| **I8** | 词缀的 `lifespanTicks` **必须 ≥ 2**，由 schema 强制。 | 词缀注入的判定体在 `CollisionSystem` **之后**生成、由 `LifespanSystem` 在**同一拍末**老化，因此寿命 `1` 是一个**静默 no-op**（spec 05 §4.4）。这类错误在运行时完全不可见，只能在校验期拦住。 |
| **I9** | 一次运行的快照里包含 `enemyId` 字符串（它随 `EncounterStateComponent.roomWaves` 进入快照）。 | 这不是副作用，而是「配置是一局的一部分」的必然结果：同一个种子 + 同一份配置 ⇒ 逐位相同的快照。测试夹具因此必须为同一份配置返回**同一个** id（见 §6.2）。 |
| **I10** | 数值的确定性不依赖遍历顺序。`enemyIds` / `modifierIds` 返回 UTF-16 码元升序列表，错误报告按该顺序进行。 | 与仓库既有规则一致（禁 `localeCompare` / `toLocale*` / `Intl`）。配置表的遍历顺序若随插入顺序变化，错误信息就会随装载顺序变化。 |

---

## 3. 数据契约

### 3.1 `assets/data/enemies.json`（新）

一个**以 id 为键**的对象。键即 id，因此 id 在文件里只出现一次，不可能与自己不一致。

```json
{
  "grunt":  { "maxHp": 100, "maxSpeed": 5, "hurtboxRadius": 0.5 },
  "elite":  { "maxHp": 100, "maxSpeed": 5, "hurtboxRadius": 0.5,
              "elite": { "maxHp": 300, "hurtboxRadius": 0.8, "armor": 60 } },
  "raider": { "maxHp": 40, "maxSpeed": 5, "hurtboxRadius": 0.5,
              "ai": { "sightRadius": 14, "attackRadius": 1.6,
                      "windupTicks": 36, "cooldownTicks": 60 },
              "loot": [{ "kind": "gold", "amount": 5 }] },
  "bomber": { "...": "raider + hazard" }
}
```

字段与域约束：

| 字段 | 必填 | 域 | 落到 |
|---|---|---|---|
| `maxHp` | ✅ | 正有限数 | `HealthComponent.maxHp` |
| `maxSpeed` | ✅ | 正有限数 | `VelocityComponent.maxSpeed` |
| `hurtboxRadius` | ✅ | 正有限数 | `HurtboxComponent.radius` |
| `hp` | ✕ | 有限数，`0 ≤ hp ≤ maxHp`（缺席 = 满血） | `HealthComponent.hp` |
| `armor` | ✕ | 正有限数（缺席 = 不挂护甲；`0` 是配置错误） | `ArmorComponent` |
| `dash` | ✕ | `{speedMultiplier>0, durationTicks>0 整数, invulnerableTicks>0 整数 ≤ durationTicks, cooldownTicks>0 整数}` | `DashStatsComponent` |
| `ai` | ✕ | `{sightRadius>0, attackRadius>0 ≤ sightRadius, windupTicks>0 整数, cooldownTicks>0 整数}` | `AIControllerComponent` |
| `hazard` | ✕ | `{radius>0, damage≥0, delayTicks≥0 整数}` | `HazardCasterComponent` |
| `loot` | ✕ | **非空**数组，元素 `{kind: "gold"\|"heal", amount?>0, radius?>0, lifespanTicks?>0 整数}` | `LootComponent` |
| `elite` | ✕ | `{maxHp>0, hurtboxRadius>0, armor>0}` **三者皆必填** | `spawnElite` 的覆盖块 |

**`ai` 里没有 `targetEntityId`。** 它是 `EntityId`——一个**实例**事实，既不稳定跨 `restartRun`，也无法用 JSON 表达。它随 `EnemyPlacement` 走。

### 3.2 `assets/data/modifiers.json`（新）

```json
{
  "zeus_strike":   { "radius": 1, "damage": 20, "lifespanTicks": 2, "hitstopTicks": 0, "knockbackForce": 0 },
  "poseidon_dash": { "radius": 3, "damage": 5,  "lifespanTicks": 2, "hitstopTicks": 0, "knockbackForce": 40 }
}
```

| 字段 | 必填 | 域 | 落到 |
|---|---|---|---|
| `radius` | ✅ | 正有限数 | `HitboxComponent.radius` |
| `damage` | ✅ | `≥ 0` 有限数（`0` 合法） | `HitboxComponent.damage` |
| `lifespanTicks` | ✅ | **≥ 2** 整数（见 I8） | `HitboxComponent.activeTicks` |
| `hitstopTicks` | ✅ | `≥ 0` 整数（`0` = 纯伤害） | `HitboxComponent.hitstopTicks` |
| `knockbackForce` | ✅ | `≥ 0` 有限数 | `HitboxComponent.knockbackForce` |

**`dionysus_strike` 没有条目，也不该有。** 它不注入判定体，只盖一个状态；它的数值属于 `POISON_STATUS_SPEC`。为一张表补齐「不被读的条目」只会制造「改了没反应」的陷阱。

### 3.3 `src/data/schemas.ts`（新）

```ts
export class SchemaError extends Error {}

export interface EnemyConfig {
  readonly id: string; readonly maxHp: number; readonly maxSpeed: number;
  readonly hurtboxRadius: number; readonly hp?: number; readonly armor?: number;
  readonly dash?: DashConfig; readonly ai?: AIConfig; readonly hazard?: HazardConfig;
  readonly loot?: readonly LootDropConfig[]; readonly elite?: EliteVariantConfig;
}
export interface ModifierConfig {
  readonly radius: number; readonly damage: number; readonly lifespanTicks: number;
  readonly hitstopTicks: number; readonly knockbackForce: number;
}

export function parseEnemyConfig(id: string, data: unknown): EnemyConfig;   // @throws SchemaError
export function parseModifierConfig(id: string, data: unknown): ModifierConfig; // @throws SchemaError
export function isEnemyConfig(data: unknown): boolean;    // 不抛版本
export function isModifierConfig(data: unknown): boolean; // 不抛版本
```

- **`unknown` 而不是 `any`。** 仓库的 lint 禁止 `any`，而且 `unknown` 更强：它强迫每一个字段先被检查再被使用。任务书里的 `isEnemyConfig(data: any): boolean` 因此以更严格的形态落地。
- **`SchemaError extends Error`，不继承 `RangeError`。** 配置问题（改 JSON）与模拟问题（改代码）是两类失败，调用方需要能区分。`name` 在栈里显示为 `SchemaError`。
- **`isXxx` 实现于 `parseXxx` 之上**（`try/catch`），因此两者不可能漂移。
- **所有错误信息带完整路径**：`enemies.grunt.ai.attackRadius (99) must not exceed enemies.grunt.ai.sightRadius (8).`——启动失败必须直接指出要改哪个字段。

### 3.4 `src/data/DataManager.ts`（新）

```ts
export interface RawConfigTables {
  readonly enemies: Readonly<Record<string, unknown>>;
  readonly modifiers: Readonly<Record<string, unknown>>;
}

export class DataManager {
  static loadAll(tables: RawConfigTables): void;          // 原子替换，@throws SchemaError
  static registerEnemy(id: string, data: unknown): void;  // 增量，@throws SchemaError
  static registerModifier(id: string, data: unknown): void;
  static getEnemyConfig(id: string): EnemyConfig;         // @throws SchemaError
  static getModifierConfig(id: string): ModifierConfig;   // @throws SchemaError
  static hasEnemy(id: string): boolean;
  static hasModifier(id: string): boolean;
  static get enemyIds(): readonly string[];               // 升序
  static get modifierIds(): readonly string[];
  static get enemyCount(): number;
  static get modifierCount(): number;
  static get isLoaded(): boolean;
  static clear(): void;                                   // 仅测试用
}
```

**为什么是静态的，而不算「隐藏状态」。** 引擎的「禁跨 Tick 隐藏状态」规则（spec 00 §6.1）管的是**模拟状态**：任何能在同一局的两拍之间变化、且必须进快照才能复现的东西。配置相反——它在进程生命周期内**不可变**，对每一拍的每一局都相同，因此不是模拟可观察到的漂移。做成进程级正是 `createDefaultSystems()` 得以保持零参调用形态、`step()` 得以不含任何「可能失败的查表」的原因。

**`loadAll` 是替换语义**（见 §1.3：不支持多套并存），因此 `tests/data/data_manager.test.ts` 在每个用例后 `bootstrapData()` 还原出厂表。

### 3.5 `src/data/bundled.ts`（新）

```ts
export function bundledConfigTables(): RawConfigTables;                 // 原始 JSON，未校验
export type ConfigTableReader = () => Promise<RawConfigTables>;
export async function readBundledConfigTables(): Promise<RawConfigTables>;
export async function bootstrapData(read?: ConfigTableReader): Promise<void>;  // 默认读捆绑 JSON
```

`bootstrapData` 是**异步引导接缝**（AC-03）：它返回 `Promise`，因此调用方无法把它误当成同步副作用；它把**读取器**做成参数，因此「从磁盘 / 网络流式读配置」不需要改动 `src/ecs` 的任何一行。默认读取器本身是同步的（捆绑 JSON 在模块求值时已在内存），这一点在 §4.3 取舍 1 里明说。

### 3.6 `EnemyPlacement` / `EnemySpawnSpec`（`spawn-helpers.ts`）

```ts
export interface EnemyPlacement {
  readonly x?: number; readonly y?: number; readonly facingRadians?: number;
  readonly targetEntityId?: EntityId | null;
}
export interface EnemySpawnSpec extends EnemyPlacement { readonly enemyId: string; }
export type EnemySpawnOptions = EnemySpawnSpec;  // 旧名保留，同一份声明
```

`EnemyPlacement` 是「实例」那一半：站位、朝向、以及它追谁。三者都不是类型的属性——两个同类型敌人站在不同位置，而 `EntityId` 甚至无法用 JSON 表达。`EncounterWaveConfig.enemies` 的元素类型随之从 `EnemySpawnOptions`（旧的扁平数值包）变为 `EnemySpawnSpec`。

---

## 4. 语义契约

### 4.1 AC-01 · Schema 契约：数值只能来自数据源

`EnemyFactory` 与两个词缀 handler 中**不存在任何业务数值字面量**。`spawn` 与 `spawnElite` 的签名是：

```ts
EnemyFactory.spawn(world: World, enemyId: string, placement?: EnemyPlacement): EntityId
EnemyFactory.spawnElite(world: World, enemyId: string, placement?: EnemyPlacement): EntityId
```

`spawnElite` 把配置里的 `elite` 块折到基础配置之上（`maxHp` / `hurtboxRadius` / `armor` 三项覆盖，其余继承），再走**同一个** `spawnCombatant` 装配路径。因此：

- 精英不是「第二种配置」，而是同一份配置的一个变体——改基础敌人不会让精英悄悄失配。
- 一个类型若没声明 `elite` 块，`spawnElite` **抛 `SchemaError`**，绝不回退成普通敌人。这正是 M6-T02 的 `armor: 0 → RangeError` 想拦的那件事（「顶着精英之名的普通敌人」），只是提前到了装载期。

**能力开关保持不变**（I7）：`armor` / `ai` / `hazard` / `loot` 缺席即不挂对应组件，与 M6–M9 逐位等价。

### 4.2 AC-02 / AC-05 · 类型安全加载与词缀注入

`createDefaultModifierRegistry()` 在**构造期**读表：

```ts
registry.register(new ZeusStrikeModifier(DataManager.getModifierConfig(ZEUS_STRIKE_MODIFIER)));
registry.register(new DionysusBlightModifier());   // 不注入判定体，因此不读表
registry.register(new PoseidonDashModifier(DataManager.getModifierConfig(POSEIDON_DASH_MODIFIER)));
```

handler 把配置存进一个 `private readonly config` 字段。这满足 spec 00 §6.1 的「handler 对 Tick 无状态」（配置不可变，不是 Tick 之间的漂移），同时保证 `onHit` / `onDash` 里**没有**任何可能抛错的查表——一次命中发生在 `step()` 内部，而 `step()` 不允许中止。

**失败点前移。** 三种坏输入在三处被拦：

| 坏输入 | M9 之前 | M10 |
|---|---|---|
| `{ hurtboxRadius: 0 }` | 装配时 `RangeError`（实体已半建） | 注册配置时 `SchemaError`（**没有任何实体**） |
| `{ hp: "100" }` | 编译期看不出来 → 运行时 `NaN` 血条 | 注册配置时 `SchemaError`，信息点名字段与类型 |
| `{ ai: { attackRadius: 99 } }` | `resolveAITuning` 抛 `RangeError` | `parseAIConfig` 抛 `SchemaError`，路径为 `enemies.<id>.ai.attackRadius` |

### 4.3 AC-03 · 同步组装约束

顺序是契约：

```
异步：await bootstrapData()          ← 读源 + 校验 + 装载（唯一可能失败的地方）
异步：await app.init()               ← 表现层就绪
同步：new GameSimulator({...})       ← 此时表已就绪，构造不可能因配置失败
同步：buildRun(world) / sim.step(n)  ← 纯同步，零 IO、零校验、零查表失败
```

- 浏览器入口（`client/main.ts`）与测试入口（`tests/harness/setup-config.ts`，经 `vitest.config.ts` 的 `setupFiles`）都在**任何 `GameSimulator` 存在之前** `await bootstrapData()`。
- 测试侧用的是顶层 `await`：它挂起 setup 模块的求值，而 ESM 保证导入方会等待——这正是「某个测试文件在模块体里调用 `EnemyFactory.spawn` 也不会输给竞态」的原因。若写成 `void bootstrapData()`，第一个 `createDefaultSystems()` 就会与引导赛跑。
- `restartRun()` **不重新引导**：配置在一局之间不变，重开只重置模拟状态。

### 4.4 AC-04 / AC-06 · 工厂重构与调用点迁移

- `src/ecs/systems/EncounterSystem.ts` 的 `spawnWave` 从 `EnemyFactory.spawn(world, enemy)` 改为 `EnemyFactory.spawn(world, enemy.enemyId, enemy)`——调度层仍然不装配任何组件（spec 08 AC-05 不变）。
- `EncounterFactory.resolveRoomWaves` 的 dry-run 装配同理；「名册里写了一个不存在的类型」因此在装载期就失败。
- 13 份既有测试的 **108 处** `EnemyFactory.spawn/spawnElite` 调用点由一次性 codemod 迁移为 `EnemyFactory.spawn(world, ...testEnemy({...}))` 形态；`tests/harness/config-fixtures.ts` 负责把旧的扁平数值包拆成 `(enemyId, placement)`。**断言体一行未改**（除 §6.3 列出的四处错误类型），因此「394 条既有用例语义不变」是可核对的。

### 4.5 表现层契约

`client/main.ts` 只声明**类型 id 与位置**：

```ts
const RAIDER = 'raider';  const BOMBER = 'bomber';
const enemy  = (x, y) => ({ enemyId: RAIDER,  x, y });
const bomber = (x, y) => ({ enemyId: BOMBER, x, y });
```

演示战斗的数值（40 血、36 拍抬手、埋雷半径 2.5、掉落 5 金）全部在 `assets/data/enemies.json`。改演示手感是**数据改动**，不再需要重新评审客户端源码。

---

## 5. 验收标准

| ID | 验收标准 | 判据 |
|---|---|---|
| **AC-01** | 所有**敌人类型**与**词缀**的数值从 JSON 读取；`EnemyFactory` 与两个词缀 handler 中不存在业务数值字面量 | `grep -nE '[^A-Za-z_][0-9]+(\.[0-9]+)?' src/ecs/prefabs/EnemyFactory.ts src/ecs/modifiers/ZeusStrikeModifier.ts src/ecs/modifiers/PoseidonDashModifier.ts` 无业务数值命中（仅索引 / 文档引用除外） |
| **AC-02** | 缺字段 / 错类型 / 越界值在**加载期**抛 `SchemaError`，信息含完整字段路径；解析产物中不存在 `undefined` / `NaN` | `tests/data/data_manager.test.ts` G2（9 条）+ G3 的「no NaN / no undefined」遍历断言 |
| **AC-03** | 配置在**异步引导**阶段装载完成，早于 `GameSimulator` 构造；`step()` 内零 IO、零校验抛错 | `client/main.ts` / `tests/harness/setup-config.ts` 的 `await bootstrapData()`；`DataManager` 未引导时 `getEnemyConfig` 抛「no config tables are loaded」；G4 |
| **AC-04** | `spawn` / `spawnElite` 只接受 `enemyId` + 位姿；能力开关（`armor`/`ai`/`hazard`/`loot`）由配置决定 | G3 的「mounts exactly the capability components」；类型签名本身 |
| **AC-05** | `ModifierRegistry` 构造期读 JSON 设定半径 / 伤害 / 顿帧 / 击退 / 寿命 | `createDefaultModifierRegistry()`；G4 的出厂表断言 |
| **AC-06** | **394 条既有用例全部通过**，语义不变 | `npm run test` → 394 passed（新增 20 条数据层用例，合计 414） |
| **AC-07** | `tests/data/data_manager.test.ts` 覆盖有效加载 / 契约防御 / 工厂映射 | 该文件 20 条用例全绿 |
| **AC-08** | `npm run test` 与 `npm run lint` 100% 绿灯；`typecheck` / `typecheck:client` / `build` 亦绿 | 见 §7 |

---

## 6. 测试契约

### 6.1 三层断言（`tests/data/data_manager.test.ts`）

- **G1 有效加载**：合法字典 → `getEnemyConfig` 逐字段返回；可选块**缺席即缺席**（`Object.keys` 钉死，不含 `undefined` 键）；`registerEnemy` 增量不扰动其余；`isXxx` 与 parser 一致。
- **G2 契约防御**：缺字段、`hp: "100"`、`NaN`、`0`、`hp > maxHp`、未知 `loot.kind`、`ai.attackRadius > sightRadius`、空 `loot`、半声明 `elite`、`lifespanTicks: 1`、表不是对象——**每一条都断言错误信息里的字段路径**。另加两条结构性断言：**原子性**（失败装载不改变旧表）与**未知 id 报错列举已装载 id**。
- **G3 工厂映射**：mock 表用 137 / 111 / 2.5 / 0.42 这类**别处不出现**的数字，因此「值来自 JSON」与「值来自默认常量」不可能混淆；断言 `HealthComponent.maxHp/hp`、`VelocityComponent.maxSpeed`、`HurtboxComponent.radius` 逐字相等；能力组件「该有的有、不该有的没有」；`spawnElite` 折叠 `elite` 块且未覆盖字段继承；未知 id / 无 elite 变体抛错且**不留实体**；最后遍历全部组件，断言没有任何非有限数与 `undefined`。
- **G4 引导顺序**：`clear()` 后读取抛「no config tables are loaded」；出厂表含 `zeus_strike` / `poseidon_dash`（`createDefaultModifierRegistry` 依赖的两条）。

### 6.2 测试夹具（`tests/harness/config-fixtures.ts`）

`testEnemy(options)` / `testElite(options)` 返回 `[enemyId, placement]` 元组，供 `...spread` 进真实工厂；`testEnemyRef(options)` 返回名册条目。旧的扁平数值包被拆成：

- **配置**：`maxSpeed` / `maxHp` / `hp` / `hurtboxRadius` / `armor` / `dash` / `ai.{tuning}` / `hazard` / `loot`；
- **位姿**：`x` / `y` / `facingRadians` / `ai.targetEntityId`。

`ai: {}` / `hazard: {}` / `dash: {}` 的语义保持不变：夹具用组件默认常量补齐（`DEFAULT_AI_*` 等），复现 M9 之前 `resolveAITuning({})` 的行为。

**id 必须按配置记忆化**（I9）：同一份配置 → 同一个 id。理由不是性能，而是正确性——`enemyId` 随 `roomWaves` 进入快照，每次现造一个新 id 会让「同一脚本跑两遍」产出不同快照，从而以与模拟无关的理由打断所有确定性测试。

### 6.3 迁移中被有意改写的断言（4 条）

这四处断言的**意图**（「坏数值必须大声失败」）保留，**错误类型**从 `RangeError` 改为 `SchemaError`——因为失败点从装配接缝前移到了装载期：

| 文件 | 原断言 | 现断言 |
|---|---|---|
| `tests/combat/hit_detection.test.ts` | `spawn(..., {hurtboxRadius: 0})` → `RangeError` | `testEnemy({hurtboxRadius: 0})` → `SchemaError` |
| `tests/combat/aoe_and_lifecycle.test.ts` | `spawn(..., {hazard: {radius: -1}})` → `RangeError` | `testEnemy({hazard: {radius: -1}})` → `SchemaError` |
| `tests/combat/economy_and_victory.test.ts` | `spawn(..., {loot: []})` → `RangeError` | `testEnemy({loot: []})` → `SchemaError` |
| `tests/combat/armor_and_dash.test.ts` | `spawnElite(..., {armor: 0})` → `RangeError` | `testElite({armor: 0})` → `SchemaError` |

另有两处 encounter 校验断言（`death_and_encounter` G1、`economy_and_victory` G6）从「坏数值的敌人 spec」改为「**不存在的敌人类型**」，因为坏数值现在根本到不了 encounter 层。

### 6.4 被删除的常量与它们的替代

`DEFAULT_ELITE_MAX_HP` / `DEFAULT_ELITE_ARMOR` / `DEFAULT_ELITE_HURTBOX_RADIUS`（原 `EnemyFactory.ts`）与 `DEFAULT_ZEUS_STRIKE_*` / `DEFAULT_POSEIDON_DASH_*`（原 `ModifierComponent.ts`）全部删除。引用它们的测试改为在文件内**以字面量声明**（如 `const DEFAULT_ELITE_MAX_HP = 300;`）。

这不是权宜之计，而是**更严格**的做法：`expect(field).toBe(THE_CONSTANT_THAT_BUILT_IT)` 是恒真断言（恒真断言陷阱），数据改了这个断言也不会失败。写成字面量之后，重新调平衡会**打破**这些用例——那正是我们想要的信号。

---

## 7. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 忘记引导 | 引擎构造时 `SchemaError` | `DataManager` 未引导时给出**指名原因**的错误；测试侧由 `setupFiles` 保证；`client/main.ts` 在 `new Application()` 之前 `await` |
| 半装载的表 | 部分敌人可用、部分不可用 | `loadAll` 原子替换（I4），并有对应用例 |
| 配置漂移（JSON 改了但测试还按旧值断言） | 绿灯但语义已变 | 测试侧以**字面量**钉数值（§6.4），而不是引用常量 |
| `enemyId` 进入快照 | 确定性测试对夹具的 id 生成敏感 | 夹具按配置记忆化 id（§6.2 / I9） |
| 组件默认常量仍存在 | 「硬编码魔法数字」的判据被质疑 | §1.3 明确范围与理由；AC-01 的判据只针对敌人类型与词缀路径 |
| `resolveJsonModule` 的类型是「谎」 | 编译器不校验数据 | 这正是 AC-02 存在的理由；`isXxx` 与 parser 同源，无法漂移 |
| 静态注册表与「禁隐藏状态」的张力 | 评审质疑 | §3.4 给出区分：配置不可变，不是模拟状态 |

---

## 8. 已知取舍

1. **捆绑 JSON 的读取本身是同步的，异步只存在于接缝。** `bootstrapData` 返回 `Promise` 且接受自定义读取器，但默认读取器只是返回已经 import 进内存的对象。选择「让接缝异步、让读取同步」而不是「假装读取很慢」：引擎依赖的是**顺序**（引导早于构造），不是**耗时**；把捆绑读取包一层假 `await` 只会掩盖真正的契约在哪。
2. **`EnemyConfig.id` 由表键填充，不写在条目里。** 冗余字段一定会漂移；键即 id 让「id 与自己不一致」在结构上不可能。
3. **`loot.kind` 用小写字符串，不用 `PickupKind` 枚举。** JSON 无法引用 TS 枚举，而 `"GOLD"` 会是同一个东西的第二种拼法。映射只在 `EnemyFactory.toLootOptions` 一处发生。
4. **`elite` 是嵌套变体，不是第二张表。** 独立表会要求手工保持两份数值同步；嵌套变体让「精英 = 基础 + 三项覆盖」成为结构事实。
5. **`spawnElite` 拒绝没有 `elite` 块的类型，而不是回退成普通敌人。** 静默降级会让「这是精英」变成一句无法核实的断言。
6. **schema 校验的是**域**，不是**平衡**。它拦得住 `hp: -1`，拦不住「这个敌人强得离谱」——后者是设计评审的事，不是类型系统的事。
7. **组件级默认常量暂留。** 见 §1.3：它们是玩家侧与装配接缝的兜底值，搬迁需要新增四到五张表，属于后续里程碑。
