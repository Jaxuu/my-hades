# 17 · Encounters & Data HMR Spec（波次序列数据化与 JSON 热重载）

| Field | Value |
|---|---|
| Spec ID | `SPEC-17-ENCOUNTERS-HMR` |
| Milestone | **M10 · 数据驱动管线**（T02） |
| Status | `accepted`（本文件为 M10-T02 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `assets/data/encounters.json`（新）、`src/data/schemas.ts`（`EncounterWaveTemplate` / `EncounterRoomTemplate` / `parseEncounterTable` / `isEncounterTable`）、`src/data/DataManager.ts`（`RawConfigTables.encounters` + 房间表注册表 + 跨表校验 + `getEncounterWaves`）、`src/data/bundled.ts`（三表引导）、`src/ecs/prefabs/EncounterFactory.ts`（`formWaveRoster` / `toEncounterWaveConfigs` / `resolveEncounterWaves` / `descendEncounterRoom` / `spawnFromData`）、`src/ecs/systems/RewardSystem.ts`（下降收敛到共享助手）、`src/ecs/systems/EncounterSystem.ts`（文档对齐）、`src/core/GameSimulator.ts`（`currentSeed`）、`client/bundled.ts`（新：客户端配置源 + HMR 接缝）、`client/main.ts`（数据驱动 `buildRun` + HMR 接线）、`client/GameRenderer.ts`（`reset()`）、`tsconfig.client.json`（`vite/client` types）、`tests/data/encounters_hmr.test.ts`（新） |
| Depends on | `specs/16_data_driven_pipeline_spec.md`（形状/数值分离、`DataManager` 原子替换、加载期大声抛、`bootstrapData` 异步接缝）、`specs/08_encounter_and_death_spec.md`（房间三态、`delayTicks` 语义、`EncounterFactory` 的 dry-run 装配校验）、`specs/11_roguelike_loop_spec.md`（`depth` 难度盘、`buildWaveRoster`）、`specs/15_economy_and_victory_spec.md`（`roomWaves` 快照可见、终房即胜、`depth` ⟂ `currentRoomIndex`）、`specs/00_harness_spec.md`（确定性 / 无隐藏状态 / barrel 契约）、ADR-004（确定性 PRNG，种子只读不重播种） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境，`pool: 'threads'`）· ESLint 9（flat config）· Vite 5（dev server HMR） |

---

## 1. 目的与范围

### 1.1 目的

M10-T01 把**敌人类型与词缀**的数值搬进了 JSON，但**一局的形状**仍然写在代码里：`client/main.ts` 的 `buildRun` 手写了「两间房、每间两波、每波几个什么敌人、站在哪」，`EncounterFactory` 把这份字面量当成唯一来源。于是「这一局有几间房、第一间房第二波是什么」这个问题，答案在客户端源码里，而不在数据层——改一局的结构要改代码、重新评审、重新构建。

M10-T02 把**一局的形状**也交给数据，并顺手补上让这件事真正可用的开发回路：

1. **波次序列数据化**（AC-01）：房间的波次构成、`delayTicks`、敌人种类与数量全部来自 `assets/data/encounters.json`。
2. **动态扩容契约**（AC-02）：配置不是一张写死的房间列表，而是**按深度读取**的序列；超出已配置的最大深度时循环复用，而不是崩掉或静默重放最后一间。
3. **JSON 热重载**（AC-03）：开发模式下改一份数据表，重新校验、重新装载、并以**同一个种子**重开这一局——不刷新页面、不重启 dev server、不留下任何上一局的视觉残影。

三者共用一条主线：**引擎里不再有「一局的形状」这个概念的第二个答案。**

### 1.2 In Scope（做什么）

- **遭遇配置表**（AC-01）：`assets/data/encounters.json`；`EncounterWaveTemplate` / `EncounterRoomTemplate` 类型与运行时校验。
- **按深度读取 + 循环复用**（AC-02）：`DataManager.getEncounterWaves(depth)`；`depth >= n` 时按 `depth % n` 循环。
- **跨表校验**：`loadAll` 断言每一波引用的敌人 id 都存在于**同一次装载**的敌人表中——这是唯一一条需要两张表的规则，因此它只能在 `loadAll` 里。
- **工厂与系统重构**（AC-01）：`EncounterFactory.spawnFromData`（按深度装配整局房间表）、`resolveEncounterWaves`、`descendEncounterRoom`；`RewardSystem` 的下降改为调用共享助手。
- **客户端 HMR 接缝**（AC-03）：`client/bundled.ts` 持有原始 JSON 模块并接受 Vite 热更新；`DataManager.loadAll` 重新校验；`GameSimulator.restartRun(currentSeed)` 以同种子重开。
- **视图彻底清理**（AC-05）：`GameRenderer.reset()` 丢弃全部视图、跳字、特效与 retired 集合，杜绝重影。
- **只读种子访问器**：`GameSimulator.currentSeed`。
- **Harness 断言**（AC-06）：`tests/data/encounters_hmr.test.ts`。

### 1.3 Out of Scope（显式排除）

- **HMR 的浏览器端自动化测试。** 热重载的接缝是 `import.meta.hot`，它只在 Vite dev server 中存在，且按 AC-04 只允许出现在 `client/`。本里程碑用**单元测试钉住一次重载的整个数据半边**（重新 `loadAll` + `restartRun` 后新实体读到新数值），并在生产构建上验证死分支被消除；浏览器行为靠 `npm run dev` 手工核验。把它做成自动化需要引入一套浏览器测试运行时，属于独立里程碑。
- **`src/` 中的任何热重载。** 见 AC-04：确定性内核连「HMR 存在」都不需要知道。
- **运行中的部分替换（partial reload）。** `loadAll` 是**整体替换**语义（spec 16 I4 不变），因此热重载天然是「换一整套表」。局部合并需要先定义合并策略。
- **玩家侧与装配接缝的组件级默认常量。** 同 spec 16 §1.3：它们是兜底值，不是决策值。
- **深度难度盘的移除。** `buildWaveRoster(enemies, depth)`（spec 11 AC-04）**保留**：它是「同一份基础编成 + 深度追加」的第二层放大，与「按深度选房间」正交。见 §4.2 与 §8 取舍 1。
- **配置的可视化编辑器 / 生成器。**
- **把 JSON 变成真正的 IO。** 客户端读的仍是 ES 模块导入；异步只存在于接缝（spec 16 §8 取舍 1）。

---

## 2. 术语与不变量

| ID | 不变量 | 为什么它是硬的 |
|---|---|---|
| **I1** | `assets/data/encounters.json` 是一段**有序序列**，条目 `k` 必须声明 `depth: k`。 | 这一条同时买到三件事：`depth` 字段不可能与自身位置不一致（不一致是加载错误，不是静默遮蔽）；房间顺序在文件里自上而下可读；「按深度读取」退化成一次数组下标，而「超出末尾」退化成一次取模。 |
| **I2** | 波次模板只声明敌人**类型 id**（字符串），不声明站位。 | 站位是**实例**事实（两个同类敌人站在不同位置），无法为**类型**写死——这正是 `EnemyConfig` / `EnemyPlacement` 已有的切分。把坐标写进文件还会让「把 2 改成 3」变成「重算二十个坐标对」。 |
| **I3** | 站位由 `formWaveRoster` **确定性**推导：以房间原点为中心的水平等距线，间距 `ENCOUNTER_FORMATION_SPACING_UNITS = 2`。 | 数据驱动的局必须可复现（spec 00 §6.2），且同一波的敌人不得生成在彼此体内（重叠 hurtbox 会让「多了一个敌人」在玩家和碰撞断言里都读成「还是一个」）。 |
| **I4** | 波次模板 → 调度词汇（`EncounterWaveConfig`）的转换**只有一处**：`toEncounterWaveConfigs`。 | 数据层不该知道站位，调度层不该知道 JSON。两处转换 = 两条会漂移的真相。 |
| **I5** | `RawConfigTables.encounters` **缺席**（合法，= 本包不提供房间）与**显式空数组**（非法）是两件事。 | 与 `loot: []` 同一条纪律（spec 15 §3.3）：缺席是一个决定，空数组是一个坏掉的声明。二者若同义，「我声明了一局但什么都没填」就永远不会被发现。 |
| **I6** | 每一波引用的敌人 id 必须在**同一次装载**的敌人表中存在；校验在 `loadAll`，不在叶子解析器。 | 这是唯一一条需要两张表的规则：`parseEncounterTable` 只看得见一张表。失败必须发生在**装载期**——否则它会在某一波到期时从 `step()` 内部抛出，而 `step()` 不允许中止（spec 08 AC-05）。 |
| **I7** | `getEncounterWaves(depth)` 在 `depth >= n` 时**循环**（`depth % n`），不钳制。 | 钳制会静默地永远重放最后一间房；循环则让深度盘每升一级都产出**不同**的房间。两种做法都受 `getEncounterRoomCount()` 约束，因此出厂配置下终房会在任何回绕可被观测之前结束这一局。 |
| **I8** | 房间的**整张深度表**在装配期就挂到组件上（`roomWaves`，spec 15 §3.5 不变），因此快照自带这一局的配置，重放不需要任何外部查表。 | 配置进入快照是「配置是一局的一部分」的必然结果（spec 16 I9）：同一个种子 + 同一份配置 ⇒ 逐位相同的快照。下降时按索引取下一间房是**快路径**；`DataManager` 按深度兜底只在该索引越界时才被触达。 |
| **I9** | `src/` 内**零** `import.meta`。HMR 只允许存在于 `client/` 或专门的构建入口。 | 确定性内核的每一条不变量（无墙钟、无随机、无 DOM）都建立在「它是一段纯逻辑」之上；把构建期的热更新接缝焊进 `src/`，等于让内核依赖它的宿主工具链。ESLint 的 `src/**` 纯逻辑门与 ADR-001 R1 是这条的机器可执行形式。 |
| **I10** | 热重载**保留种子**：`sim.restartRun(sim.currentSeed)`，不是 `restartRun()`。 | 改一份数据表是一次**配置变更**，不是一次免费重掷。若用 `restartRun()`（种子 +1），「我改了数值，看看手感」会同时改变随机流，观察到的差异无法归因（ADR-004）。 |
| **I11** | 重载失败**不带走会话**：`loadAll` 的原子性（spec 16 I4）保证被拒绝的编辑不改变正在运行的一局。 | 一次手误就杀掉 dev 会话的热重载，比没有热重载更糟——开发者会学会不信任它，然后关掉它。 |
| **I12** | 一次重载后**不得有上一局的视觉残影**。 | 实体视图会自愈（实体被销毁 ⇒ 离开 `query` ⇒ `recycleDestroyed` 回收），但**跳字**活在**真实时间**里、由 ticker 驱动，一个残留的 `-40` 会继续在新一局上飘最多一秒。这正是 `reset()` 存在的唯一理由。 |

---

## 3. 数据契约

### 3.1 `assets/data/encounters.json`（新）

一个**有序数组**，条目 `k` 声明 `depth: k`：

```json
[
  {
    "depth": 0,
    "waves": [
      { "delayTicks": 0,   "enemies": ["raider"] },
      { "delayTicks": 120, "enemies": ["raider", "bomber"] }
    ]
  },
  {
    "depth": 1,
    "waves": [
      { "delayTicks": 0,   "enemies": ["raider", "raider"] },
      { "delayTicks": 120, "enemies": ["raider", "bomber"] }
    ]
  }
]
```

| 字段 | 必填 | 域 | 说明 |
|---|---|---|---|
| 顶层 | ✅ | **非空**数组 | 一局的房间序列。空数组非法（I5）。 |
| `depth` | ✅ | 非负整数，且 **`=== 条目下标`** | 房间深度即其在序列中的位置（I1）。 |
| `waves` | ✅ | **非空**数组 | 该房间的波次，顺序即执行顺序。 |
| `waves[].delayTicks` | ✅ | 非负整数 | 该波变为 PENDING 后等待的拍数（spec 08 §3.4；`0` = 立即）。 |
| `waves[].enemies` | ✅ | **非空**字符串数组，元素非空 | 敌人**类型 id**，必须存在于 `enemies.json`（I2 / I6）。 |

出厂表与 M9-T01 的演示局**逐波等价**（两间房 × 两波），只是站位改由 `formWaveRoster` 推导：`["raider"]` 站在 `x = 0`，`["raider","raider"]` 站在 `x = ±1`。

### 3.2 `src/data/schemas.ts`（新增）

```ts
export interface EncounterWaveTemplate {
  readonly delayTicks: number;
  readonly enemies: readonly string[];
}
export interface EncounterRoomTemplate {
  readonly depth: number;
  readonly waves: readonly EncounterWaveTemplate[];
}

export function parseEncounterWaveTemplate(data: unknown, label: string): EncounterWaveTemplate; // @throws SchemaError
export function parseEncounterRoomTemplate(data: unknown, index: number, label: string): EncounterRoomTemplate;
export function parseEncounterTable(data: unknown, label: string): readonly EncounterRoomTemplate[];
export function isEncounterTable(data: unknown): boolean;   // 不抛版本，实现于 parser 之上
```

错误信息带完整路径，例如：

- `encounters must be a non-empty array of room templates, received an object.`
- `encounters[0].depth (5) must equal its position in the table (0): the encounter table is an ordered sequence of rooms, so entry 0 is depth 0.`
- `encounters[0].waves[0].enemies[0] must be a non-empty enemy type id, received the string "".`

### 3.3 `src/data/DataManager.ts`（扩展）

```ts
export interface RawConfigTables {
  readonly enemies: Readonly<Record<string, unknown>>;
  readonly modifiers: Readonly<Record<string, unknown>>;
  readonly encounters?: readonly unknown[];   // 缺席 = 本包不提供房间（合法）
}

export class DataManager {
  static loadAll(tables: RawConfigTables): void;   // 三表全绿才替换（原子）；含跨表敌人 id 校验
  static getEncounterRoomCount(): number;          // 房间序列长度
  static get encounterDepths(): readonly number[]; // [0, 1, …, n-1]，构造即有序
  static getEncounterWaves(depth: number): readonly EncounterWaveTemplate[]; // AC-02，@throws SchemaError
  static clear(): void;                            // 同时清空房间表
}
```

`loadAll` 的顺序是契约：**先解析三张表，再跨表校验，最后一次性替换**。跨表校验对着**本次刚解析出来的**敌人表进行，而不是对着旧注册表——这正是「敌人表删掉了某个仍被房间表引用的类型」这一整包被拒绝、而不是被接受后在下一次 spawn 时才炸的原因。

### 3.4 `src/ecs/prefabs/EncounterFactory.ts`（扩展）

```ts
export const ENCOUNTER_FORMATION_SPACING_UNITS = 2;

export function formWaveRoster(enemyIds: readonly string[]): EnemySpawnOptions[];
export function toEncounterWaveConfigs(templates: readonly EncounterWaveTemplate[]): readonly EncounterWaveConfig[];
export function resolveEncounterWaves(depth: number): readonly EncounterWaveConfig[];  // = DataManager.getEncounterWaves(depth) + 转换
export function descendEncounterRoom(room: EncounterStateComponent): void;

export class EncounterFactory {
  static spawn(world: World, config: EncounterRoomConfig): EntityId;   // 手写房间，签名不变
  static spawnFromData(world: World): EntityId;                        // 数据驱动整局
}
```

- `spawn(world, config)` **保持不变**：既有 13 份测试与任何手搭房间的调用点逐字不变。
- `spawnFromData(world)` 遍历 `DataManager.encounterDepths`，逐深度调用 `resolveEncounterWaves`，再交给**同一个** `spawn`（因此享受同一套 dry-run 装配校验，spec 08 AC-05 不变）。
- `descendEncounterRoom(room)` 把 M9-T01 里写在 `RewardSystem` 内的七行状态写入收敛成**唯一一份**实现，并给出 AC-02 的兜底：`roomWaves[index] ?? resolveEncounterWaves(room.depth)`。

### 3.5 `client/bundled.ts`（新）——客户端配置源与 HMR 接缝

```ts
export function clientConfigTables(): RawConfigTables;
export async function bootstrapClientData(): Promise<void>;   // DataManager.loadAll(clientConfigTables())
export interface DataHotReloadOptions { readonly onReload: () => void; }
export function installDataHotReload(options: DataHotReloadOptions): void;
```

**为什么客户端自己 import JSON，而不是调 `src/data/bundled.ts` 的 `bootstrapData()`。**
Vite 的热更新是**沿 import 图传播**的：`assets/data/x.json` → `src/data/bundled.ts` → `src/data/index.ts` → `client/main.ts`。如果只有 JSON 这一层被 accept，传播仍会到达一个没有边界的入口模块，Vite 的答案就是**整页刷新**——画布被拆掉、这一局丢失，AC-03 要的「以新数据重开同一局」根本不会发生。

因此 Vite 入口**自己**导入这三份 JSON，并在 `client/bundled.ts` 里 accept 它们：这一层成为 Vite 停下的边界，而 `src/` 完全不必知道 HMR 存在（I9）。表仍然走**同一个** `DataManager.loadAll`（同一套校验），只是入口换成了构建期能热替换的那一个。生产构建里 `import.meta.hot` 是 `undefined`，整段逻辑被摇掉——已核验：产物中不含 `data-hmr` 字符串。

---

## 4. 语义契约

### 4.1 AC-01 · 波次配置化

一局的形状**只有一个来源**：`assets/data/encounters.json`。具体地——

- **房间数量** = 表的长度（`maxRooms`）。
- **每间房的波次构成 / `delayTicks` / 敌人类型 / 数量** = 该深度条目的字段。
- `client/main.ts` 的 `buildRun` 不再声明任何波次或敌人：它只保留数据表达不了的两件事（玩家的出生点、`GameStateComponent` 单例）。
- 加一间房、加一波、把一个敌人改成两个，**都是数据编辑**。

`EncounterSystem` 与 `RewardSystem` 的行为契约不变：前者仍是「每拍一个决定」的纯调度器，后者仍是「结算并下降」；变的只是它们的**输入来自哪里**。`RewardSystem` 的下降收敛到 `descendEncounterRoom`，其兜底分支按**当前深度**向 `DataManager` 取模板（AC-02）。

### 4.2 AC-02 · 动态扩容契约

**按深度读取。** 房间 `d` 就是表的条目 `d`（`depth === index`，I1），没有第二份列表需要保持同步，引擎里也不存在「房间表」这个概念——只有「配置，按深度」。

**超界循环复用。** `depth >= n` 时取 `table[depth % n]`（I7）。测试同时钉住引擎侧：一个 `maxRooms` 超过自身 `roomWaves` 长度的手搭房间，连续下降两次会依次得到深度 1 与深度 0（回绕）的波次，**永远不会**得到 `undefined`。

**深度盘（第二层放大）保留。** `buildWaveRoster(enemies, depth)`（spec 11 AC-04）继续在**两种模式**下一致生效：它是在「按深度选到的房间」之上追加 `depth` 个复制体，因此实际数量 = `表内数量 + depth`。这是一个**已存在的、正交的**难度机制，本里程碑不动它——移除它需要重写 spec 11 的整套钉桩，且与 AC-02 无关。取舍见 §8 取舍 1。

### 4.3 AC-03 · HMR 契约

```
Vite 侦测到 assets/data/*.json 变化
  └─ client/bundled.ts 的 accept 回调收到新模块
       ├─ 1. DataManager.loadAll(新三表)     ← 同一套 schema 校验；失败则 catch + 报告 + 保留旧表（I11）
       └─ 2. onReload()                      ← client/main.ts 提供：
              sim.restartRun(sim.currentSeed)   ← 同种子（I10）：只换配置，不重掷
              renderer.reset()                  ← 丢掉视图 / 跳字 / FX / retired（I12）
```

三条性质是**刻意**的：

1. **仅开发模式。** `import.meta.hot` 在生产包里是 `undefined`，函数立即返回；已核验构建产物中不含该分支的任何字符串。
2. **失败软着陆。** 坏编辑被 `try/catch` 接住并报告，正在运行的一局继续使用旧表（`loadAll` 原子，I11）。
3. **保留种子。** 见 I10。

### 4.4 AC-05 · 视图彻底清理

`GameRenderer.reset()` 与 `destroy()` 的区别是**生命周期**：`destroy()` 拆掉渲染根，渲染器随之作废；`reset()` 只丢**属于上一局的表现层状态**，循环、`Application`、画布全部保留（重建 app 意味着重挂画布，那是一次可见的闪屏，而不是重载）。

必须清掉的三样东西，以及为什么：

| 状态 | 为什么必须显式清 |
|---|---|
| `views` | 实体视图本会自愈，但 `restartRun` 与 `reset` 之间会有一帧窗口；显式清掉是零成本且确定的。 |
| `floatingTexts` | **I12**：跳字由 ticker 的真实时间驱动、不随世界销毁。残留的 `-40` 会在新一局上继续飘最多一秒——这就是「重影」。 |
| `retired` | 它按设计**从不裁剪**（spec 09 §4.4），跨每次重载累积。id 永不复用，因此清空不可能复活尸体，不清则是一个慢性泄漏。 |
| `fxLayer` 子节点 | 兜底清扫：今天 `spawnFloatingText` 是唯一写入者，但将来某个忘记登记的 FX 会静默逃过重置。 |

调用点只有一个：`installDataHotReload` 的 `onReload`，紧随 `restartRun`。**在**运行中的一局上调用 `reset()`（不重启）会清掉 `retired`，让尸体视图被重建——这正是该集合要阻止的事，因此 `reset()` 是**运行边界**操作。

---

## 5. 验收标准

| ID | 验收标准 | 判据 |
|---|---|---|
| **AC-01** | 房间的波次构成、`delayTicks`、敌人种类与数量全部来自 `assets/data/encounters.json`；`client/main.ts` 不再声明任何波次 | `buildRun` 只调 `EncounterFactory.spawnFromData`；`tests/data/encounters_hmr.test.ts` G1 + G3 的「follows the table when the table changes」 |
| **AC-02** | 配置按房间深度读取；超出最大深度时循环复用 / 兜底生成 | G1 的「CYCLES past the end」；G3 的「falls back to the table BY DEPTH」；`getEncounterWaves` 对负数 / 小数抛 `SchemaError` |
| **AC-03** | 开发模式下 JSON 变更 → 重新 `loadAll` → 立刻 `restartRun(currentSeed)` | `client/bundled.ts::installDataHotReload` + `client/main.ts` 的 `onReload`；`GameSimulator.currentSeed`；数据半边由 G4 三条用例钉住 |
| **AC-04** | HMR 代码只存在于 `client/`；`src/` 零 `import.meta` | `grep -rn "import.meta" src/` 无命中；生产构建产物不含 `data-hmr` |
| **AC-05** | 触发重置时旧 PixiJS 视图（含跳字、特效）被彻底清理，不出现重影 | `GameRenderer.reset()` 清 `views` / `floatingTexts` / `fxLayer` / `retired`；调用点紧随 `restartRun` |
| **AC-06** | **414 条既有用例全部通过，语义不变** | `npm run test` → 414 passed（新增 22 条，合计 **436**） |
| **AC-07** | `tests/data/encounters_hmr.test.ts` 覆盖波次解析 + 数据原子刷新 | 该文件 22 条用例全绿 |
| **AC-08** | `test` / `lint` / `typecheck` / `typecheck:client` / `build` 五道门 100% 绿灯 | 见 §7 |

---

## 6. 测试契约

### 6.1 四组断言（`tests/data/encounters_hmr.test.ts`，22 条）

- **G1 · 波次配置化（6 条）**：按深度逐字段返回模板；超出末尾**循环**（`2→0`、`3→1`、`7→1`）；非法深度（`-1` / `1.5`）抛错；无表时按**原因**报错（`no encounter config is loaded`）而不是返回空；`formWaveRoster` 的三种编队（1 / 2 / 3 个敌人 → `x = 0` / `±1` / `-2,0,2`）与幂等；`resolveEncounterWaves` 的模板→调度词汇转换（延迟与站位都对）。
- **G2 · 契约防御（6 条）**：非数组 / 空数组 / `depth` 与下标不符 / 空 `waves` / 空 `enemies` / 小数 `delayTicks` / 空字符串 id —— 每条断言**错误信息里的完整路径**；**跨表未知敌人 id** 单独一条（含「已装载的 id 列表」）；`isEncounterTable` 与 parser 一致；**原子性**：失败装载不改变旧表。
- **G3 · 按深度装配（6 条）**：`spawnFromData` 建出整张深度表（`maxRooms`、`waves`、`roomWaves[1]` 逐项）；换一张表 → 房间数随之变化（证明布局不是硬编码）；真 `GameSimulator` 上按 `delayTicks` 逐拍验证首波在**第 7 拍**生成（第 6 拍还没有）；`descendEncounterRoom` 换到**深度 1 的波次**并复位调度状态；手搭房间越界时按深度兜底 + 回绕；同一张表两次装配逐位相同。
- **G4 · 数据原子刷新（3 条）**：把 `mock_grunt` 的 `maxHp` 从 **137 改成 500** → `loadAll` → `restartRun(currentSeed)` → **新实体**读到 500，且种子不变、实体 id 不复用（钉住 `clearEntities` 不重置 `nextId` 这条 P0）；房间表整体替换后 `maxRooms` 由 2 变 4；被拒绝的重载不改变运行中的一局。
- **兜底回归（1 条）**：单房间两波的表，真管线里逐波验证**配置的数量**（1 → 2）与**各自的 `delayTicks`**（7 / 5），并确认每个存活敌人都是走工厂装配出来的（拥有 hurtbox）。

### 6.2 夹具纪律

- **出厂的词缀表被原样复用**（`bundledConfigTables().modifiers`）。这不是图省事：`createDefaultSystems()` 在构造期就通过 `createDefaultModifierRegistry()` 读 `zeus_strike` / `poseidon_dash`，一张被清空的词缀表会让流水线**根本构造不出来**，测试量到的就不是它想量的事了。
- **敌人表与房间表完全 mock**，数值取 `7 / 11 / 137 / 500` 这类**别处不出现**的数字，因此「值来自表」与「值来自默认常量」不可能混淆。
- **存活敌人判定必须过滤尸体**：尸体永不销毁（spec 08 §4.4），裸 `query(HealthComponent)` 会把尸体一直算进去，「这一波生成了 2 个」会读成 3。
- **`afterEach` 用 `bootstrapData()` 还原出厂表**：恢复路径就是生产路径，且这让出厂 `encounters.json` 成为其他所有套件的基线。

### 6.3 有意未覆盖的部分

热重载的 `import.meta.hot` 接缝**没有**单测，理由见 §1.3：它只在 Vite dev server 中存在、且按 AC-04 只能出现在 `client/`。可测的是它的**数据半边**——`loadAll` + `restartRun` 之后新实体读到新数值——G4 三条用例完整覆盖了这条链。浏览器侧靠 `npm run dev` 手工核验，并以「生产产物不含 `data-hmr`」作为死分支被消除的证据。

---

## 7. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| 忘了引导就装配一局 | `EncounterFactory.spawnFromData` 抛 `SchemaError` | 错误信息点名「no encounter config is loaded」并要求先跑 Bootstrap；测试侧由 `setupFiles` 保证；`client/bundled.ts` 在 `new Application()` 之前 `await` |
| 房间表引用了不存在的敌人类型 | 会在某一波到期时从 `step()` 内部抛出 | `loadAll` 跨表校验（I6），装载期大声抛；G2 有专门用例 |
| 热重载导致整页刷新（HMR 边界丢失） | AC-03 的「同种子重开」失效，画布被拆 | Vite 入口**自己**导入 JSON 并在 `client/bundled.ts` accept（§3.5）；`src/` 不参与该图 |
| 热重载把坏数据灌进正在运行的一局 | dev 会话被杀 | `loadAll` 原子 + `try/catch` + 保留旧表（I11），G2/G4 各有用例 |
| 重载顺带重掷了随机流 | 「改了数值看手感」无法归因 | `restartRun(sim.currentSeed)`（I10）；G4 断言 `currentSeed` 不变 |
| 上一局的跳字残影 | 观感上的「重影」，正是 AC-05 要拦的 | `GameRenderer.reset()` 显式清 `floatingTexts` / `fxLayer` / `retired`（I12） |
| `depth === index` 的约束过严 | 不能跳号声明房间 | 这是刻意的：跳号会让「按深度读取」需要排序或映射，从而引入第二份真相；需要空房间就写一个占位波次 |
| 深度盘与深度表**叠加**放大难度 | 「表里写 3 个，实际生成 3 + depth 个」可能让配置作者意外 | §4.2 明写；`buildWaveRoster` 是 spec 11 的既有契约，本里程碑不动它（取舍见 §8） |
| `src/` 被误引入 `import.meta` | 内核依赖宿主工具链 | AC-04 + `grep` 判据；ESLint 的 `src/**` 纯逻辑门继续生效 |

---

## 8. 已知取舍

1. **深度盘保留，房间表叠加在它之上。** `buildWaveRoster` 是 M6-T01 建立的、与「按深度选房间」正交的难度机制，且被 spec 11 的多条钉桩用例锁住。AC-02 要的是「配置按深度读取」，而**按深度选房间**正是它的实现；把深度盘也搬进 JSON 会需要重写 spec 11 的整套契约，且不会让「一局的形状」多出任何一个新答案。代价是配置作者要知道「表内数量 + depth」这一层，已在 §4.2 与风险登记中明写。
2. **波次模板只写类型 id，不写坐标。** 见 I2/I3。代价是站位无法逐敌微调；换来的是「把 2 改成 3」是一处编辑，且编队规则是纯函数、可单测、可复现。将来若需要手工摆位，正确的做法是给 `enemies` 元素加一种「对象形态」（`{ enemyId, x, y }`）而不是把整张表改成坐标。
3. **`encounters` 在 `RawConfigTables` 里是可选的，缺席与空数组语义不同。** 见 I5。这让 spec 16 的 15 处 `loadAll({ enemies, modifiers })` 调用点逐字不变，同时保留「声明了却什么都没填」的失败模式。
4. **`RewardSystem` 的下降被抽成 `descendEncounterRoom`，而不是让系统自己去查 `DataManager`。** 系统的每一拍都不该读配置（spec 16 I6）；下降是一次**房间边界**操作，读表是允许的，但把它放在与装配同源的地方（`EncounterFactory`）比放在系统里更符合「装配只在一处」。快路径（`roomWaves[index]`）优先，是因为配置进入快照是 spec 15 §3.5 的硬不变量。
5. **客户端不再从 `src/data/index` 取 `bootstrapData`，而是自带 `client/bundled.ts`。** 这不是分层改动（表仍然走同一个 `DataManager.loadAll`），而是**构建关注点**：HMR 需要一个能停下传播的边界，而 `src/` 不允许成为它（I9）。代价是「客户端配置源」这一概念有了两个名字（`src/data/bundled.ts` 供 Node/测试/程序化引导，`client/bundled.ts` 供 Vite 入口）；收益是内核完全不知道 HMR 存在。
6. **热重载是整表替换，不是局部合并。** 沿用 `loadAll` 的替换语义（spec 16 §1.3）。局部合并需要先回答「两份配置如何相加」，那是一个独立设计。
7. **`GameRenderer.reset()` 而不是 `destroy()` + `init()`。** 见 §4.4：重建 `Application` 意味着重挂画布，那是一次可见的闪屏；`reset()` 让热重载真正是「就地」的。
