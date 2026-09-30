# 21 · Hub & Meta Progression Spec（局外成长、持久化存档与营地状态）

| Field | Value |
|---|---|
| Spec ID | `SPEC-21-HUB-META` |
| Milestone | **M13 · 局外成长**（T01） |
| Status | `accepted`（本文件为 M13-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/core/SaveState.ts`（新）、`src/core/MetaProgression.ts`（新）、`src/core/GameSimulator.ts`（`initialSaveState` / `saveState` / `enterHub` / `purchaseMetaUpgrade` / `runSetup` 第二参数）、`src/core/index.ts`、`src/data/schemas.ts`（`MetaUpgradeConfig` / `parseMetaUpgradeTable` / `LootDropConfig.kind` 扩展）、`src/data/DataManager.ts`（`metaUpgrades` 表）、`src/data/bundled.ts`、`src/ecs/components/PickupComponent.ts`（`PickupKind.DARKNESS`）、`src/ecs/components/LootComponent.ts`、`src/ecs/components/InventoryComponent.ts`（`darkness`）、`src/ecs/components/GameStateComponent.ts`（`GameStatus.HUB` / `markRunHub` / `isInHub` / `isRunOver` 扩展）、`src/ecs/systems/PickupSystem.ts`、`src/ecs/prefabs/meta-bonuses.ts`（新）、`src/ecs/prefabs/PlayerFactory.ts`（`spawnWithMeta`）、`src/ecs/prefabs/spawn-helpers.ts`（`metaBonuses` opt-in）、`src/ecs/prefabs/EnemyFactory.ts`、`src/ecs/prefabs/index.ts`、`assets/data/meta_upgrades.json`（新）、`assets/data/enemies.json`、`client/SaveStore.ts`（新）、`client/UIManager.ts`（营地覆盖层）、`client/GameLoop.ts`（营地冻结）、`client/GameRenderer.ts`（暗影拾取物配色）、`client/bundled.ts`、`client/main.ts`、`index.html`、`tests/meta/meta_progression.test.ts`（新）、`tests/harness/config-fixtures.ts` |
| Depends on | `specs/00_harness_spec.md`（ECS / Snapshot / 无隐藏状态契约）、`specs/15_economy_and_victory_spec.md`（`LootComponent` / `InventoryComponent` / `PickupKind` / `PickupSystem` 槽位 / `isRunOver` 门控先例）、`specs/14_aoe_and_run_lifecycle_spec.md`（`GameStateComponent` / `restartRun` / `RUN_FAILED`）、`specs/16_data_driven_pipeline_spec.md`（`DataManager` / `SchemaError` / Bootstrap 时机）、`specs/09_renderer_bridge_spec.md`（表现层只读契约）、`specs/11_roguelike_loop_spec.md`（外部命令不走输入队列的先例）、`ADR-004`（确定性 PRNG） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

到 M12-T01 为止，这个引擎的一局是**完全自足**的：开局、打房间、掉落、终局、`restartRun` 重开。但「重开」意味着**一切都归零** —— 金币、装备、进度，全部随 `World.clearEntities()` 蒸发。于是两件事同时成立：

1. **一局没有遗产。** 玩得再好，下一局和第一局一模一样。玩家没有累积，因此也没有「再开一局」以外的理由。
2. **终局没有去处。** `RUN_FAILED` / `RUN_WON` 之后的唯一出口是 `restartRun`，即「立刻再开一局」。引擎里不存在「两次 Run 之间」这段时间，因此也不存在一个可以花钱、可以看进度、可以决定「我这局要玩什么流派」的地方。

M13-T01 补上这两件事：**局内拾取的「暗影」被带出局外，成为永久货币**（局外成长），以及 **Run 之间多出一个「营地」状态**（Hub State），玩家在这里花掉暗影、解锁永久天赋，然后才决定开始下一局。

### 1.2 In Scope（做什么）

- **持久化存档契约**：`SaveState`（`darkness` + `unlockedUpgrades`）独立于 `World` 存在，`restartRun` 不清空（AC-01）。
- **构造注入**：`GameSimulatorOptions.initialSaveState` 注入；`GameSimulator.saveState` 暴露；`src/` 对存储介质零知识（AC-01）。
- **序列化快照**：`SaveState.toJSON()` / `SaveState.from()` 是唯一的存档进出通道；`client/SaveStore.ts` 是唯一接触 `localStorage` 的地方（AC-01）。
- **局内掉落打通**：`PickupKind.DARKNESS` + `LootComponent` 默认值 + `assets/data/enemies.json` 配置（AC-02）。
- **结算写入**：`GameSimulator.enterHub()` 把本局wallet 的暗影搬进存档并清零（AC-02）。
- **营地状态**：`GameStatus.HUB`，`RUN_FAILED` / `RUN_WON` 结算后转入；`isRunOver` 覆盖 HUB（AC-03）。
- **局外天赋**：`assets/data/meta_upgrades.json` 表、`MetaUpgradeConfig` schema、`resolveMetaBonuses` 聚合、`PlayerFactory.spawnWithMeta` 垫高玩家数值（AC-04）。
- **营地 UI**：DOM 天赋加点界面（暗影数量 + 天赋列表 + 扣除解锁 + Start Escape 按钮）（AC-03）。
- **营地时间冻结**：`GameLoop` 在 HUB 状态推进 0 个逻辑 Tick。

### 1.3 Out of Scope（显式排除）

- **存档迁移 / 版本升级。** `SaveStore` 的 key 带 `.v1` 后缀；未来格式不兼容时换 key（旧档被忽略），而不是写一条没人测的迁移路径。
- **云存档 / 多档位 / 存档槽。** 本里程碑只有一个本地档。
- **天赋树的前置依赖 / 层级 / 重置。** 天赋目前是**扁平的独立条目**：每条「花 `cost` 得 `value`」，彼此不互斥、不依赖、不可退还。
- **「额外冲刺次数」这类需要新机制的天赋。** `META_UPGRADE_TYPES` 只收录**落在玩家已有组件上**的加成（`MAX_HP` / `MOVE_SPEED` / `DASH_COOLDOWN_REDUCTION`）。「多一次冲刺」需要先把单次冲刺改成充能制 —— 那是机制，不是数值，属于独立里程碑。
- **局内消费。** 金币（`GOLD`）依旧没有消费入口，仍然是分数；暗影也不在局内消费，只能在营地花。
- **营地的场景化表现。** 营地是**一个覆盖层**，不是一张地图、没有 NPC、没有对话。`World` 在 HUB 期间保留的是刚结束那一局的静止帧。
- **存档的加密 / 防篡改。** 存档是用户数据，不做完整性校验。

---

## 2. 术语与不变量

| ID | 不变量 | 为什么它是硬的 |
|---|---|---|
| **I1** | `src/**` **不得**接触任何存储介质（`localStorage` / 文件 / 网络）。存档的读写在 `client/`，通过 `SaveState` 的构造注入与序列化进出。 | 存储读是**带失败模式的同步 I/O**（配额、隐私模式、手改坏值），它没有资格出现在一个确定性模拟里；ESLint 的 `src/**` AST 门（禁 `window` / `document`）是这条不变量的机器可执行形式。 |
| **I2** | `SaveState` **不是** `World` 的组件，**不出现在** `snapshot()` 里，且 `restartRun` 不重建它。 | 「重开」的全部意义就是销毁 `World` 的实体 —— 存档若挂在组件上，就会被它必须存活的那个操作销毁。同时 `snapshot()` 保持逐位可比，两次同脚本回放的差异不会因为无关的进度而出现。 |
| **I3** | 一局在**存活期间**只把暗影写进 `InventoryComponent.darkness`（Run 内账本），**绝不**直接写 `SaveState`；唯一的跨界写点是 `GameSimulator.enterHub()`。 | 这让「一局的收入」是**快照可见、可回放**的模拟状态（spec 00 §6.1），同时把「影响局外进度」收敛到一个运行边界事件上 —— 一局被放弃（`restartRun` 而不结算）就不会半途入账。 |
| **I4** | `HUB` 是**终局态**：`isRunOver` 为 `true`，所有既有惰性门控（`EncounterSystem` / `PickupSystem` / `PlayerControllerSystem`）**无需改动**即对营地生效。 | 若 HUB 不在 `isRunOver` 里，进入营地会**重新打开** `RUN_FAILED` 关掉的每一道门：调度器会在尸体上刷波次，拾取会继续结算。这正是 AC-06 禁止的「游戏继续下去」。 |
| **I5** | `enterHub()` **幂等**：第二次调用入账 `0`。 | 入账会先把 Run 账本清零（`bankRunDarkness`）。没有这个清零，营地被进出两次就会把同一局发两次钱。 |
| **I6** | `HUB` 是**状态**，不是系统：M13-T01 **不新增任何管道段**，17 段硬契约不变。 | 营地是一个「这局不再做决策」的标记，不是每个 Tick 都要跑的职责。新增一段会牵动 9 处管道钉桩与 5 处段数钉桩，而收益为零。 |
| **I7** | 局外加成在**装配期**（`runSetup`）被解析成**纯数字**（`MetaBonuses`）；`step()` 内**零**配置查表、零校验抛错。 | 沿用 M10 的「加载期大声抛，运行期不查表」纪律。`spawnCombatant` 是被 `step()` 间接调用的（`EncounterSystem` → `EnemyFactory.spawn`），它内部不能有任何可能抛出的 id 查找。 |
| **I8** | 局外加成是**加性**的，且 `hp` 默认跟随**加成后的** `maxHp`。 | `{ maxHp: 50 }` 的意思是「比上面那些数字多 50」，不是「一共 50」。而 `hp` 默认等于最终上限，所以带 `thick_skin` 的一局是从**满血**开始的，而不是 100/150。 |
| **I9** | 存档里一个**已不存在**的天赋 id 被**跳过**（不生效、不报错）；`DataManager` 里一个**不存在**的天赋 id 在**购买**时被拒绝（返回 `false`）。 | 存档比构建活得久，配置改名是**正常事件**而非损坏。抛错会让一次改名变成所有买过它的玩家的启动失败。 |
| **I10** | 购买是**营地操作**，不是 `step()` 输入：它走 `sim.purchaseMetaUpgrade()`，**不**经输入队列。 | 与 `restartRun` 同源：运行边界操作不是 Tick 对齐的模拟输入。`GameSimulator` 因此**不**校验当前是否在 HUB —— 那道门天然存在于「只有营地 UI 会提供购买」这件事里，在引擎里再写一遍是冗余的第二份真相。 |
| **I11** | `thick_skin` 的**发货价是 30**（任务书 §Task 2 的示例写作 `cost: 100`，§Task 4 的验收断言写作「花费 30 宝石…剩余 20」）。 | 两条要求互相矛盾时以**可执行的验收断言**为准：`50 - 30 = 20` 必须成立。§Task 2 的 100 是示例值，不是契约。 |
| **I12** | `GameLoop` 在 HUB 状态推进 **0** 个逻辑 Tick，且丢弃累积器。 | 营地是菜单：`sim.tick` 不该在菜单里爬升；离开营地也不该「补算」菜单期间的时间 —— 菜单不是暂停键，它是**从未存在过的时间**。 |

---

## 3. 数据契约

### 3.1 `SaveState` / `SaveStateData`（新，`src/core/SaveState.ts`）

```ts
interface SaveStateData {                 // 序列化形态：纯数据，可 JSON.stringify
  readonly darkness: number;              // 局外货币，非负有限数
  readonly unlockedUpgrades: readonly string[];  // 已解锁天赋 id，升序
}

class SaveState {
  darkness: number;                       // 公开可写字段
  get unlockedUpgrades(): readonly string[];   // 每次调用返回新的、已排序的数组
  hasUpgrade(id: string): boolean;
  unlockUpgrade(id: string): boolean;     // false = 本来就已解锁
  addDarkness(amount: number): number;    // 钳在 0，返回新总额
  toJSON(): SaveStateData;
  static empty(): SaveState;
  static from(data: unknown): SaveState;  // 严格校验，坏值抛 TypeError / RangeError
}
```

- 内部用 `Set<string>` 存解锁集合（去重 + O(1) 查询），对外只经 `unlockedUpgrades` getter 读。
- 升序按 **UTF-16 码元**（禁 `localeCompare`，ADR-001 R6），所以同一份进度永远序列化成同样的字节。
- `from()` 是**严格**的：这是数据来自进程之外的唯一入口，类型错了就报错，不做强制转换 —— 与 `src/data/schemas.ts` 对 JSON 配置的态度一致。**由调用方决定坏档意味着什么**：`SaveStore` 的答案是「从头开始」，不是崩溃。

### 3.2 `MetaUpgradeConfig` + `assets/data/meta_upgrades.json`（新）

```ts
type MetaUpgradeType = 'MAX_HP' | 'MOVE_SPEED' | 'DASH_COOLDOWN_REDUCTION';
const META_UPGRADE_TYPES: readonly string[];

interface MetaUpgradeConfig {
  readonly id: string;        // 表 key
  readonly cost: number;      // 正整数（暗影价）
  readonly type: MetaUpgradeType;
  readonly value: number;     // 正有限数
  readonly label?: string;    // 可选显示名；省略则 UI 显示 id
}
```

发货表（三条，覆盖三种类型）：

```json
{
  "thick_skin":     { "cost": 30, "type": "MAX_HP",                 "value": 50, "label": "厚皮 · 生命上限 +50" },
  "swift_boots":    { "cost": 40, "type": "MOVE_SPEED",             "value": 1,  "label": "疾行靴 · 移速 +1" },
  "adrenal_gland":  { "cost": 60, "type": "DASH_COOLDOWN_REDUCTION", "value": 10, "label": "肾上腺 · 冲刺冷却 -10 tick" }
}
```

- `type` 是**大写字符串**而非 TS 枚举：JSON 无法命名枚举，写第二遍拼写就是一次静默漂移（同 `LootDropConfig.kind`）。
- 空表**合法**（一个不发售局外成长的 bundle 是正当形态），与 `rooms` / `enemies` 的「缺席 ≠ 空」一致。
- `DataManager` 侧：`getMetaUpgradeConfig` / `hasMetaUpgrade` / `metaUpgradeIds` / `metaUpgradeCount`；`clear()` 与 `loadAll()` 一并维护，安装仍为**原子**。

### 3.3 `MetaBonuses` + `resolveMetaBonuses`（新，`src/ecs/prefabs/meta-bonuses.ts`）

```ts
interface MetaBonuses {
  readonly maxHp: number;                     // 加到 HealthComponent.maxHp
  readonly moveSpeed: number;                 // 加到 VelocityComponent.maxSpeed
  readonly dashCooldownReductionTicks: number; // 从 DashStatsComponent.cooldownTicks 里减，地板 1
}
const NO_META_BONUSES: MetaBonuses;           // 冻结的全零常量

function resolveMetaBonuses(unlockedUpgrades: readonly string[]): MetaBonuses;
```

- 去重（`new Set`）：手搓的重复 id 不能把同一个加成买两遍。
- 未知 id **跳过**（I9）。**只**对畸形配置表抛 `SchemaError`。
- 只在 `runSetup` 里调用一次 —— 每次 Run 一次，不在 Tick 里。

### 3.4 `PickupKind.DARKNESS` + `InventoryComponent.darkness`（扩展）

```ts
enum PickupKind { GOLD = 'GOLD', HEAL = 'HEAL', DARKNESS = 'DARKNESS' }
const DEFAULT_DARKNESS_AMOUNT = 10;
function defaultPickupAmount(kind: PickupKind): number;   // PickupComponent 内，total

class InventoryComponent {
  gold: number;
  darkness: number;   // 本局暗影账本；随 Run 一起被重建
}
function addDarkness(world, id, amount): boolean;
function readDarkness(world): number;   // HUD 读侧；无钱包 → 0
```

- `LootDropConfig.kind` 扩展为 `'gold' | 'heal' | 'darkness'`；`LootComponent.defaultLootAmount` **委托** `defaultPickupAmount`，所以「一颗暗影值多少」只有一个答案。
- `EnemyFactory.toPickupKind` 是数据层小写字符串与枚举的**唯一**交汇点。
- `assets/data/enemies.json`：`raider` 掉 `gold 5 + darkness 10`；`bomber` 掉 `gold 10 + heal 15 + darkness 15`。

### 3.5 `GameStatus.HUB`（扩展）

```ts
enum GameStatus { PLAYING, RUN_FAILED, RUN_WON, HUB }

function isInHub(world): boolean;    // status === HUB
function markRunHub(world): void;    // 唯一写点：GameSimulator.enterHub
function isRunOver(world): boolean;  // RUN_FAILED || RUN_WON || HUB
```

`HUB` 是**终局态**（I4），不是第三个「判决」：它从 `RUN_FAILED` 或 `RUN_WON` **任一**进入，而判决只能二选一。`PLAYING` 是唯一「未结束」的状态。

### 3.6 `GameSimulator` API（扩展）

```ts
interface GameSimulatorOptions {
  readonly runSetup?: (world: World, saveState: SaveState) => void;  // 第二参数，加性
  readonly initialSaveState?: SaveState;                             // 注入；省略 = 全新空档
}

class GameSimulator {
  readonly saveState: SaveState;                     // 注入实例的**引用**，restartRun 不重建
  enterHub(): void;                                  // 入账 + status = HUB；无 game state → no-op
  purchaseMetaUpgrade(upgradeId: string): boolean;    // 真买了才 true；永不抛
}
```

`runSetup` 的第二参数是**加性**的：所有既有的单参数 `runSetup` 继续通过类型检查、继续行为不变。

### 3.7 `CombatantSpawnOptions.metaBonuses`（新 opt-in）

```ts
interface CombatantSpawnOptions {
  // ...既有字段
  readonly metaBonuses?: MetaBonuses;   // 省略 = 完全按原样装配
}
```

在 `spawnCombatant` 里**最先**校验（负值 / 非有限 → `RangeError`），然后：

```
maxSpeed = (options.maxSpeed ?? DEFAULT_COMBATANT_MAX_SPEED) + meta.moveSpeed
maxHp    = (options.maxHp    ?? DEFAULT_MAX_HP)              + meta.maxHp
hp       = options.hp ?? maxHp
dashCooldownTicks = max(1, resolvedDash.cooldownTicks - meta.dashCooldownReductionTicks)
```

### 3.8 `SaveStore`（新，`client/SaveStore.ts`）

```ts
const SAVE_STORAGE_KEY = 'my-hades.save.v1';
function loadSaveState(storage: Storage | null): SaveState;      // 任何失败 → SaveState.empty()
function persistSaveState(storage: Storage | null, state: SaveState): void;  // 失败静默
```

**全部尽力而为，永不致命。** 读不到 / 解不开 / 写不进，一律退化成「从头开始」，而不是从启动序列里抛出去 —— 这与数据层的规则（畸形 `assets/data/*.json` **必须**中止启动）**刻意相反**：一个是开发者控制的构建产物，一个是可能被一百种外部原因弄坏的玩家数据。

---

## 4. 语义契约

### 4.1 AC-01 · 持久化存档契约与依赖注入

- `SaveState` 独立于 `World`：不是组件、不在 `snapshot()` 里、`restartRun` 的 6 步（`clearEntities` / `reseed` / `input.clear` / `scheduler.reset` / `clock.reset` / `runSetup`）**没有任何一步碰它**。
- 唯一注入点：`new GameSimulator({ initialSaveState })`。省略则 `SaveState.empty()` —— 每个 M1–M12 的调用方与测试都拿到一个全零的空档，行为与之前一致。
- 唯一序列化通道：`toJSON()` / `from()`。`SaveStore` 负责介质，`resolveStorage()`（在 `main.ts`）负责「有没有介质」。
- `sim.saveState` 返回**注入实例本身**（不是副本），所以调用方自己持有的句柄能看到每一次变化。

### 4.2 AC-02 · 局内掉落与结算写入

时间线（一次 Run 的一生）：

```
拾取 DARKNESS  →  InventoryComponent.darkness += amount     （PickupSystem，Tick 内）
死亡 / 通关    →  GameStatus = RUN_FAILED / RUN_WON          （DeathSystem / EncounterSystem）
enterHub()     →  bankRunDarkness: wallet.darkness → SaveState.darkness，wallet.darkness = 0
               →  GameStatus = HUB
```

- `PickupSystem` 的 `DARKNESS` 分支**只**写钱包，与 `GOLD` 分支同构：不写顿帧、不写硬直、不写击退、不发事件（spec 15 I1 不因新 kind 改变）。
- 入账**发生在结算**（`enterHub`），不是拾取瞬间 —— 这样「一局的收入」是快照可见的模拟状态（I3），而「影响局外进度」只有一个人一个时刻。
- **代价被显式接受**：若一局被 `restartRun` 直接放弃（未结算），本局暗影**丢失**。这正是「只有把这一局打完才能把钱带出去」的 roguelike 语义。

### 4.3 AC-03 · 营地状态与天赋购买

状态流转（终局两条路径 + 唯一回头路）：

```
PLAYING ──死亡──▶ RUN_FAILED ──R──▶ HUB ──Start Escape──▶ PLAYING（新一局）
PLAYING ──清空终房──▶ RUN_WON ──R──▶ HUB ──Start Escape──▶ PLAYING（新一局）
```

- `R` 键（`HUB_KEY_CODE = 'KeyR'`）在**两个**终局覆盖层上行为一致，都调 `onEnterHub` → `sim.enterHub()`。
- 营地覆盖层（`#ui-layer.is-visible.is-hub`）展示：暗影总数、天赋列表（`DataManager.metaUpgradeIds` 升序，显示 `label ?? id` 与 `cost`）、已拥有项（`disabled` + `is-owned`）、买不起的项（`disabled` + `is-locked`）、以及**唯一的出口** `Start Escape` 按钮。
- 点击天赋 → `onPurchase(id)` → `sim.purchaseMetaUpgrade(id)`；返回 `true` 才持久化。
- **可购性只是提示，不是门控。** `disabled` 属性不是安全边界，真正的判定在 `tryPurchaseMetaUpgrade`（未知 id / 已拥有 / 钱不够 → `false`，永不抛）—— 因为唯一的调用方是 DOM 按钮，会抛的点击处理器就是会弄坏页面的点击处理器。
- `GameLoop` 在 HUB 期间推进 0 个 Tick 并丢弃累积器（I12）。

### 4.4 AC-04 · 局外天赋加成

```
SaveState.unlockedUpgrades
   └─ resolveMetaBonuses()            （runSetup 期，一次）
        └─ MetaBonuses { maxHp, moveSpeed, dashCooldownReductionTicks }
             └─ PlayerFactory.spawnWithMeta(world, saveState, options)
                  └─ spawnCombatant(..., { metaBonuses })   （唯一的加成应用点）
```

- 加成是**加性**的（I8）；`hp` 默认跟随加成后的 `maxHp`。
- `PlayerFactory.spawn`（无 meta）与 `spawnWithMeta`（有 meta）是**两个入口**：前者装配它被要求的身体，后者额外折叠存档。这样「这次调用知道局外进度」是**调用点**的性质，而不是「每一个玩家」的性质 —— 既有的 100+ 处 `spawn` 调用点因此**可证**不受本里程碑影响。
- 存档是加成的**权威**：`spawnWithMeta` 会覆盖调用方显式传入的 `metaBonuses`。
- 天赋**跨局继承**：加成不是身体的属性，是存档的属性。死亡 → 结算 → 重开，增益依然存在。

### 4.5 表现层契约（只读 + 单向）

- `UIManager.sync(world, meta?)` 是**唯一**新增的参数。`meta` 是结构性类型 `MetaProgressionView { darkness, unlockedUpgrades }`，`SaveState` 天然满足它 —— UI 因此不依赖 `SaveState` 这个类，只依赖「我要画的那两样东西」。
- 营地是**唯一**读 `World` 之外东西的界面，所以它显式地拿到存档，而不是让存档变成组件、或让渲染层去摸模拟器。
- 渲染顺序（硬契约）：HUD → 终局覆盖层 → 营地 → 三选一。任意时刻**最多一个**覆盖层在屏：营地只能从终局覆盖层进入，而终局之后调度器已惰性，不可能再滚出三选一。
- 重绘以**渲染键**去抖：营地键 = `darkness | unlockedUpgrades.join(',')`；HUD 键 = 文本本身；三选一键 = id 列表。空闲帧是严格 no-op。

---

## 5. 验收标准

| AC | 断言 | 落点 |
|---|---|---|
| **AC-01** | `SaveState` 独立于 `World`；`restartRun` 后不清空；`snapshot()` 形态不变；`initialSaveState` 注入生效；`src/**` 无存储调用 | `tests/meta/meta_progression.test.ts` G0 + `npm run lint`（AST 门） |
| **AC-02** | 拾取 50 暗影 → 触发死亡 → 进入 HUB → `SaveState.darkness === 50`；`DARKNESS` 写入钱包而非存档；入账幂等；未结算则不入账；`enemies.json` 真掉落 | G2 |
| **AC-03** | `HUB` 使 `isRunOver === true` 且调度器惰性；购买 `thick_skin` 花费 30 → 剩余 20；重复 / 未知 / 买不起均被拒且不抛；`restartRun` 从 HUB 回到 `PLAYING` | G3 |
| **AC-04** | 新局玩家 `HealthComponent.maxHp` **精确**等于 `DEFAULT_MAX_HP + 50`；三种类型分别落到对应组件；再次死亡重启后增益仍在；无天赋时玩家与 M13 前逐字段一致 | G4 |
| **AC-05** | 管道仍为 **17 段**，无 `Hub*` / `Meta*` 系统，`TransformSnapshotSystem` 仍 idx0、`LifespanSystem` 仍 LAST | G5 |
| **AC-06** | 无 game state 的世界仍读作 `PLAYING`；`enterHub` 对其为严格 no-op；无 meta 的 Run 逐 Tick 零回归 | G5 / G2 |
| **AC-07** | 存档 schema 在加载期大声抛（`cost` 非正整数 / 未知 `type` / `value` 非正）；`loadAll` 原子性保持 | G1 |
| **AC-08** | `SaveState.from` 拒绝畸形输入（非对象 / 负货币 / 非数组解锁项 / 空字符串 id） | G0 |
| **AC-09** | `npm run test` / `npm run lint` / `npm run typecheck` / `npm run typecheck:client` / `npm run build` 五道闸门全绿 | 见 §6.7 |

---

## 6. 逐 Tick 时序契约（QA 可钉）

### 6.1 拾取暗影（AC-02）

`PickupSystem` 槽位不变（idx 15，`RewardSystem` 之后、`LifespanSystem` 之前）。拾取物在生成它的**同一个 Tick** 内可被拾取，被拾取的拾取物在**同一个 Tick** 末被销毁。`DARKNESS` 与 `GOLD` 的区别只在写入哪个字段。

### 6.2 死亡与入账（AC-02）

- `DeathSystem`（idx 12）在玩家 `hp <= 0` 的 Tick 末写 `RUN_FAILED`；**此时不入账**。
- 入账**不在** `step()` 内，只在 `sim.enterHub()` 被调用时发生。因此「`step(n)` 之后 `SaveState` 变化」这件事**永远不会**发生。

### 6.3 营地（AC-03）

- `enterHub()` 之后：`isRunOver === true`、`isInHub === true`、`isRunFailed === false`。
- 连续 `step(30)`：`entityCount` 不变（调度器惰性）、玩家意图被压制。
- `restartRun()`：clock 归零、世界清空重建、`GameStatus` 回到 `PLAYING`、`SaveState` **不变**。

### 6.4 购买（AC-03）

购买是**同步的、Tick 之外的**：调用返回时 `saveState.darkness` 与 `unlockedUpgrades` 已经更新，下一次 `restartRun` 的 `runSetup` 立刻看得到。

### 6.5 加成落地（AC-04）

- `runSetup` 内：`resolveMetaBonuses(saveState.unlockedUpgrades)` → `spawnCombatant` 折叠。
- `DEFAULT_MAX_HP = 100`、`thick_skin.value = 50` ⇒ 新局玩家 `maxHp === 150`、`hp === 150`（LITERAL 钉桩，不用「构造它的那个常量」自证 —— 恒真断言陷阱）。
- `swift_boots` ⇒ `VelocityComponent.maxSpeed === 6`；`adrenal_gland` ⇒ `DashStatsComponent.cooldownTicks === 20`。

### 6.6 零回归（AC-05 / AC-06）

- `createDefaultSystems()` 的 17 个名字逐项不变（本文件 G5 全文钉桩，另有 9 份既有测试钉桩）。
- `snapshot()` 顶层键仍为 `['tick', 'elapsedSeconds', 'entities']`；`unlockedUpgrades` 永不出现在快照里。
- 无 `GameStateComponent` 的世界：`isRunOver === false`、`isInHub === false`、暗影照常进钱包（钱包不依赖 Run 存在）。
- 无 meta 的 Run：`sim.world.entityCount` 逐 Tick 不变、`maxHp === 100`、`readGold === 0`、`readDarkness === 0`、`saveState.darkness === 0`。

### 6.7 五道闸门

```
npm run test             # 612 passed (33 files)：578 既有 + 34 新增
npm run lint             # eslint .  —— 含 src/** AST 门（禁 window/document/Math.random/Date.now/localeCompare/Intl/pixi.js/client）
npm run typecheck        # tsc --noEmit（src + tests）
npm run typecheck:client # tsc --noEmit -p tsconfig.client.json（client/）
npm run build            # vite build —— 812 modules transformed
```

---

## 7. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 存档被外部改名 / 手改坏 | 启动失败 | `SaveStore` 全部尽力而为，任何失败 → `SaveState.empty()`；`resolveMetaBonuses` 跳过未知 id（I9） |
| `HUB` 漏进 `isRunOver` | 营地期间调度器复活，尸体上刷怪 | I4 明确纳入；G5 / G3 各有断言 |
| `enterHub` 被调用两次 | 同一局发两次钱 | 入账即清零 Run 账本（I5）；G2 有幂等断言 |
| 加成在 Tick 内查表抛错 | 模拟中途崩溃 | 加成在 `runSetup` 期解析成纯数字（I7）；`spawnCombatant` 只做算术与校验 |
| 天赋价与验收断言不一致 | AC-04 算术失败 | 发货价按**可执行断言**定（I11）：`thick_skin = 30`，`50 - 30 = 20` |
| `localStorage` 在隐私模式抛异常 | 启动崩溃 | `resolveStorage()` 捕获并返回 `null`；`SaveStore` 接受 `Storage \| null` |
| 玩家在营地停留时 `sim.tick` 爬升 | 快照/回放语义含糊 | `GameLoop` 在 HUB 推进 0 Tick 并丢弃累积器（I12） |
| 新增 `PickupKind` 漏改某个映射 | 暗影显示成金币 / 掉成金币 | 三处映射全部显式：`EnemyFactory.toPickupKind`、`GameRenderer.pickupColor`、`config-fixtures.toJsonLootKind` |

---

## 8. 已知取舍

1. **入账放在结算而不是拾取瞬间。** 代价是「中途放弃的一局会丢钱」。换来的是「影响局外进度」只有一个写点、一个时刻，且 Run 内收入仍是快照可见的模拟状态（I3）。
2. **`GameSimulator` 因此多了两个游戏概念**（`enterHub` / `purchaseMetaUpgrade`）。它的类注释原本写着「模拟器不知道什么是玩家、房间或游戏状态」。诚实地记下这次放宽：运行边界操作必须能被调用方**对着模拟器**发出（同 `restartRun` 的理由）；替代方案是「调用方自己持有存档、背着模拟器改」，那会让「谁在什么时候入账」有多个答案。
3. **`runSetup` 多了一个参数。** 加性，所以既有调用方零改动；但它确实把「装配器可能想看存档」写进了 `src/core` 的公开契约。
4. **天赋是扁平的。** 没有前置依赖、没有层级、没有重置。这让 `MetaUpgradeConfig` 保持四个字段，代价是天赋树无法表达「必须先买 A 才能买 B」。
5. **`META_UPGRADE_TYPES` 只收录落在已有组件上的加成。** 「额外冲刺次数」被明确排除（§1.3）—— 那需要先把冲刺改成充能制。新增一个**数值型**天赋是一行枚举 + 一行 switch；新增一个**机制型**天赋是一个独立里程碑。
6. **营地把刚结束的一局静止帧留在身后。** 没有清空 `World`、没有换场景。这让 `enterHub` 与 `restartRun` 的职责保持分离（前者结算，后者重建），代价是营地的背景是上一局的残局 —— 而 `GameLoop` 已经保证它是**静止的**。
