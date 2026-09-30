# 19 · Room Topology & Tilemaps Spec（关卡拓扑、Tilemap 解析与静态场景装配）

| Field | Value |
|---|---|
| Spec ID | `SPEC-19-ROOM-TOPOLOGY` |
| Milestone | **M12 · 关卡与场景装配**（T01） |
| Status | `accepted`（本文件为 M12-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `assets/data/rooms.json`（新）、`assets/data/encounters.json`（新增 `roomId`）、`src/data/schemas.ts`（`RoomConfig` / `parseRoomConfig` / `parseRoomTable` / `EncounterRoomTemplate.roomId`）、`src/data/DataManager.ts`（`rooms` 注册表 + 跨表校验）、`src/data/bundled.ts`、`client/bundled.ts`（`rooms.json` 进 HMR 边界）、`src/ecs/components/EncounterStateComponent.ts`（`roomIds` / `enemySpawnPoints` / `SpawnPoint` / `currentRoomId`）、`src/core/LevelLoader.ts`（新）、`src/ecs/prefabs/EncounterFactory.ts`（`roomIds` 透传 / `descendEncounterRoom` 清空出生点）、`src/ecs/systems/EncounterSystem.ts`（出生点 PRNG 选取）、`src/ecs/systems/RewardSystem.ts`（过场装配）、`src/core/GameSimulator.ts`（`restartRun` 契约注释）、`client/main.ts`（`buildRun` 走 `LevelLoader`）、`client/GameRenderer.ts`（地板 / 墙体色块）、`tests/world/tilemap_and_topology.test.ts`（新） |
| Depends on | `specs/00_harness_spec.md`（时钟 / ECS / Snapshot / 零隐藏状态）、`specs/08_encounter_and_death_spec.md`（房间单例 / 三态 / `trackedEntityIds`）、`specs/11_roguelike_loop_spec.md`（`depth` 难度盘）、`specs/13_arena_and_projectiles_spec.md`（`WallComponent` / `resolveCircleAABB` / `MovementSystem` 静态几何解算）、`specs/15_economy_and_victory_spec.md`（多房间推进 / `isFinalRoom` / 终局）、`specs/16_data_driven_pipeline_spec.md`（`schemas` / `DataManager` / Bootstrap 异步加载）、`specs/17_encounters_hmr_spec.md`（按深度读房间表 / HMR 边界） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

到 M11-T01 为止，「房间」是**纯逻辑概念**：它只是一张波次表 + 一个状态机，**没有任何空间形态**。由此产生三个结构性缺口：

1. **房间没有形状** ⇒ 竞技场永远是同一片无限平面。墙体只能靠 `createWall` 手工摆放（`tests/physics/walls_and_projectiles.test.ts` 就是这么做的），**关卡不是数据**，无法用一张表描述「这一间是 10×10 的封闭斗室，那一间带四根柱子」。
2. **出生点是硬编码的** ⇒ 玩家永远从 `(0, 0)` 开始（`client/main.ts::buildRun` 写死），敌人永远落在 `formWaveRoster` 推导出的**居中等距线**上（`x = ±1, ±2 …`）。同一个房间的第 3 次进入和第一次完全一样，没有任何空间变化。
3. **过场没有清理** ⇒ `descendEncounterRoom` 只换配置、不换世界：上一间的投射物、未爆的 AoE、没捡的掉落物会**原样带进下一间**，而「墙」根本没有房间归属的概念。

M12-T01 补上这三层：

1. **网格契约（Tilemap）**：房间地形由 JSON 中的 2D 整数数组定义，每个格子对应逻辑空间中的 `1 × 1` 单位面积；`LevelLoader` 把「1」解析成带 `WallComponent` 的静态实体。
2. **确定性出生（Deterministic Spawn）**：玩家坐标被**硬重置**到 `2` 格的精确中心；敌人坐标从 `3` 格池中**用世界 PRNG 确定性选取**，取代中心点硬编码偏移。
3. **场景装配与清理（Level Building & Teardown）**：房间切换时（`ROOM_CLEARED` 推进 / `restartRun`）在**同一个 Tick 内**完成「清旧 + 建新 + 定位玩家 + 收集出生点」，不新增管道段、不新增每 Tick 系统。

> 一句话判据：**「网格」把房间从一张波次表升级成一块地形；`LevelLoader` 是这块地形唯一的装配点，而它只在房间边界被调用。**

### 1.2 In Scope（做什么）

- **新数据表**：`assets/data/rooms.json`（id 键控的对象表），至少两个房间布局（`start_room` 10×10 开放斗室 / `arena_room` 12×10 带双柱竞技场）。
- **数据层**：`schemas.ts` 新增 `RoomConfig` + `parseRoomConfig` + `parseRoomTable` + `isRoomConfig`，以及 `EncounterRoomTemplate.roomId`（可选非空字符串）；`DataManager` 新增 `rooms` 静态注册表、`getRoomConfig` / `hasRoom` / `roomIds` / `getEncounterRoomId(depth)`，并在 `loadAll` 里做**跨表校验**（每个 `roomId` 必须解析到同一批次载入的房间）。
- **装配层**：新增 `src/core/LevelLoader.ts` —— 网格 → 世界坐标、墙体实体生成、动态实体清理、玩家位姿硬重置、出生点收集。
- **组件扩展**：`EncounterStateComponent` 新增 `roomIds`（与 `roomWaves` 同下标对齐）与 `enemySpawnPoints`（**当前房间**的敌人出生点池），并新增自由函数 `currentRoomId`。
- **调度器扩展**：`EncounterSystem.spawnWave` 在有出生点池时用 `world.rng` **确定性**选取落点；池为空时**逐位退回** `buildWaveRoster` 的中心线队形。
- **过场**：`RewardSystem` 在 `descendEncounterRoom` 之后调用 `LevelLoader.enterRoom`；`EncounterFactory.spawnFromData` 把 `roomId` 一并装配进房间单例。
- **表现层**：`GameRenderer` 增加极简的**地板色块 + 墙体色块**绘制（只读 `WallComponent`，不新增逻辑）。

### 1.3 Out of Scope（显式排除）

- ❌ **任何 Tile 美术 / 图集 / 自动贴图（auto-tiling）**：本里程碑只画色块，且只在 `client/`。
- ❌ **碰撞体合并（greedy meshing / 贪心合并相邻墙格）**：每格一个 `WallComponent`。理由是**确定性优先**（实体 id 与格子的行主序一一对应，可逐格断言），且 `resolveWalls` 是「实体 id × 墙 id 升序」的单次有限遍历（spec 13 I3），格子数量在真实房间尺度下微不足道。合并优化留待性能里程碑。
- ❌ **相机 / 视口跟随 / 世界原点重定位**：房间的世界原点就是网格左上角（§3.2），渲染不做任何居中或缩放。
- ❌ **斜墙 / 非 1×1 格 / 多格 Tile / 高度差**：只有轴对齐 `1 × 1` 方块。
- ❌ **地板寻路 / 连通性校验 / 可达性分析**：`parseRoomConfig` 只校验**形状**（尺寸、取值域、至少一个玩家出生点），不校验「玩家出生点是否被墙封死」。这是一个**已登记的已知风险**（§9 R1），由关卡作者负责。
- ❌ **尸体清理**：房间切换**不销毁尸体**（见 §4.4）。
- ❌ **跨房间的持久化地形状态**（可破坏墙 / 已开启的门）：墙是**静态且无状态**的。
- ❌ **新管道段**：管道仍是 **17 段**（§4.5）。

---

## 2. 术语与不变量

| 术语 | 定义 |
|---|---|
| **网格（Grid）** | 房间地形的二维整数数组；JSON 中可写成一维行主序或二维行数组（§3.1） |
| **格（Tile）** | 网格的一个单元，对应逻辑空间中的 `1 × 1` 单位面积 |
| **格坐标 `(col, row)`** | 列号 `col ∈ [0, width)`、行号 `row ∈ [0, height)` |
| **行主序索引** | `index = row * width + col`（内部一律归一化成这个一维形式） |
| **Tile 码** | `0` = 地板；`1` = 墙体 / 深渊障碍；`2` = 玩家出生点；`3` = 敌人刷新区 |
| **房间拓扑（Room Topology）** | 一个 `RoomConfig`：`id` + `width` + `height` + 归一化后的 `grid` |
| **静态几何** | 携带 `WallComponent` 的实体；**不挂 `TransformComponent`**（spec 13 §3.2），因此不可位移、不进 `TransformSnapshotSystem`、不参与渲染插值 |
| **动态实体（本里程碑口径）** | 房间切换时需要清掉的**瞬时**实体：投射物、判定圆（含近战挥击 / 词缀注入圆）、已布置的 AoE、掉落物，以及旧墙体 |
| **出生点池（Spawn Point Pool）** | 当前房间所有 `3` 格的**格中心**，按行主序升序排列 |

### 2.1 不变量（I1 – I12）

- **I1 — 网格是唯一的地形真相。** 墙体的存在、位置与尺寸**只能**来自 `RoomConfig.grid`。`LevelLoader` 不读任何其它来源，`encounters.json` 不含坐标。
- **I2 — 一格一墙。** 每个 `1` 格恰好生成 **1 个** `WallComponent` 实体，AABB 为 `{ x: col, y: row, width: 1, height: 1 }`（世界单位）。因此「房间墙体实体数」== 「网格中 `1` 的个数」，是一个可以逐格断言的等式。
- **I3 — 墙是静态的，且零更新频率组件。** `WallComponent` 实体**只挂 `WallComponent`**：不挂 `TransformComponent`、不挂 `VelocityComponent`、不挂 `IntentComponent`、不挂 `HealthComponent`、不挂任何倒计时组件。任何系统都不会「每 Tick 推进」一堵墙；唯一读它的是 `MovementSystem.resolveWalls` 的静态几何解算 pass（spec 13 §4.1）。
- **I4 — 世界坐标契约。** 格 `(col, row)` 占据世界 AABB `[col, col + 1] × [row, row + 1]`；其**中心**为 `(col + 0.5, row + 0.5)`。房间左上角格 `(0, 0)` 的左上角就是世界原点 `(0, 0)`；`+x` 向右、`+y` 向下（与行序一致）。
- **I5 — 玩家出生点是硬重置，不是偏移。** 进入房间时玩家 `TransformComponent.(x, y)` 被**直接赋值**为出生格中心，同时 `PreviousTransformComponent` 被同步改写（否则渲染层会在两间房之间插值出一段「滑行」）。
- **I6 — 敌人落点必然落在池内。** 有出生点池时，每个敌人的初始坐标**精确等于**池中某一格的中心，**不做任何偏移**（包括 `depth` 追加的复制体）。
- **I7 — 出生点选取是确定性的。** 同 seed ⇒ 同落点分布；选取只走 `world.rng`，不在 `client/` 抽签（ADR-004）。
- **I8 — 过场在同一 Tick 内同步完成。** 清旧、建新、定位玩家、写出生点池四件事**全部**发生在触发过场的那个系统调用内（`RewardSystem.update`），不跨 Tick、不排期、不异步。
- **I9 — 过场不新增管道段，也不新增每 Tick 系统。** 管道恒为 17 段；过场是既有段内的一个**边界分支**。
- **I10 — 空池 = 无拓扑 = 逐位退回旧行为。** `enemySpawnPoints` 为空数组时，`EncounterSystem` 走 `buildWaveRoster` 的中心线队形；`roomIds` 在该下标无值时，`RewardSystem` **不调用** `LevelLoader`。因此所有 M1–M11 的手写房间（以及全部既有测试夹具）行为**逐位不变**。
- **I11 — 清理集是「瞬时实体」，不是「非玩家实体」。** 见 §4.4 的清单。尸体、敌人、玩家、房间单例、游戏状态单例**不在**清理集内。
- **I12 — 加载期大声抛，运行时零校验。** 网格的尺寸 / 取值域 / 出生点存在性、`roomId` 的可解析性**全部**在 Bootstrap 的 `DataManager.loadAll` 里校验并抛 `SchemaError`。`LevelLoader` 在 `step()` 内**只查表、不抛错**（spec 16 AC-03 的同一条纪律）。

---

## 3. 数据结构

### 3.1 `assets/data/rooms.json`

id 键控的对象表（与 `enemies.json` / `modifiers.json` / `projectiles.json` / `hazards.json` 同形），**不是**数组：房间没有天然顺序，顺序属于「一局要走哪些房间」，而那是 `encounters.json` 的职责（spec 17 §3.2）。

```json
{
  "start_room": {
    "width": 10,
    "height": 10,
    "grid": [
      [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      [1, 0, 0, 0, 0, 0, 0, 0, 0, 1],
      [1, 0, 3, 0, 3, 0, 3, 0, 0, 1],
      "…"
    ]
  }
}
```

**`grid` 接受两种书写形式，且两种都必须被接受：**

1. **二维行数组**（推荐，diff 友好）：`grid.length === height`，每行 `length === width`。
2. **一维行主序数组**：`grid.length === width * height`，`index = row * width + col`。

`parseRoomConfig` 把两者**归一化成同一个一维行主序数组**，所以下游（`LevelLoader` / 渲染层 / 测试）只面对一种形状，永远不必问「这是 2D 还是 1D」。**为什么允许两种**：一维是紧凑、可机械生成的形状（本任务给出的示例就是它），二维是人手编辑时唯一读得懂的形状；拒绝其中任何一种都只会把作者推向「先写二维再手工拍平」的中间脚本。

**Tile 码取值域**：`0` / `1` / `2` / `3`，且必须是**整数**。任何其它值（含 `1.5`、`"1"`、`null`、`4`）都在加载期被拒。

### 3.2 世界坐标（I4 的展开）

```
col →   0        1        2        3
      ┌────────┬────────┬────────┬────────┐
row 0 │ 墙     │ 墙     │ 墙     │ 墙     │   y ∈ [0, 1]
      ├────────┼────────┼────────┼────────┤
row 1 │ 墙     │ 地板   │ 地板   │ 墙     │   y ∈ [1, 2]
      ├────────┼────────┼────────┼────────┤
row 2 │ 墙     │ 地板   │ 出生点 │ 墙     │   y ∈ [2, 3]
      └────────┴────────┴────────┴────────┘
        x∈[0,1]  x∈[1,2]  x∈[2,3]  x∈[3,4]
```

- 格 `(2, 2)` 的中心 = `(2.5, 2.5)`。
- 玩家半径 `DEFAULT_HURTBOX_RADIUS = 0.5`，因此「站在格中心」时与四邻格的边界**恰好相切**——而 `resolveCircleAABB` 的契约是**贴边不算碰**（spec 13 §3.1），所以一个出生在格中心的玩家**不会被自己的格子边界推挤**。这条相切关系不是巧合，是网格边长 `1` 与半径 `0.5` 共同选定的。

### 3.3 `encounters.json` 增加 `roomId`

房间条目新增一个**可选**非空字符串 `roomId`，指向 `rooms.json` 的一个键：

```json
[
  { "depth": 0, "roomId": "start_room", "waves": [ "…" ] },
  { "depth": 1, "roomId": "arena_room", "waves": [ "…" ] }
]
```

- 它写在**房间条目**上，**不写在波次上**：地形是房间的属性，不是某一波敌人的属性。三波敌人共用同一块地形。
- **可选**（而非必填）是刻意的向后兼容决定：`EncounterRoomTemplate` 的既有夹具（`tests/data/encounters_hmr.test.ts` 的 `ENCOUNTERS`、以及一切手写房间）不声明 `roomId`，它们必须继续合法。缺席的语义是「这个房间没有拓扑」，与 `encounters` 缺席 = 「这个包不提供房间」、`loot` 缺席 = 「不掉落」是同一条 `absent ≠ empty` 纪律（spec 15 §3.3 / spec 17 §3.1）。
- **出厂的 `assets/data/encounters.json` 里每一间都声明 `roomId`** —— 「需要引用 roomId」由数据满足，而不是靠 schema 强加给所有调用方。

### 3.4 `RoomConfig`（解析后）

```ts
export interface RoomConfig {
  /** 表键，回填进结果，使 id 在文件中只出现一次。 */
  readonly id: string;
  readonly width: number;   // 正整数
  readonly height: number;  // 正整数
  /** 已归一化的一维行主序网格，长度恒为 width * height。 */
  readonly grid: readonly number[];
}
```

派生量（`wallTiles` / `playerSpawn` / `enemySpawnPoints`）**不**放在 `RoomConfig` 上，而是由 `LevelLoader` 的**纯函数**按需推导（§4.1）。理由：派生量一旦进配置对象，就会有「作者改了 `grid` 但派生字段没跟着变」的漂移面；纯函数不可能漂移。

### 3.5 `EncounterStateComponent` 的两个新字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `roomIds` | `readonly (string \| undefined)[]` | 与 `roomWaves` **同下标对齐**：`roomIds[k]` 是房间 `k` 的拓扑 id；`undefined` = 该房间无拓扑 |
| `enemySpawnPoints` | `readonly SpawnPoint[]` | **当前房间**的敌人出生点池；空数组 = 无拓扑 |

`SpawnPoint` 是 `{ readonly x: number; readonly y: number }`，声明在 `EncounterStateComponent.ts`（字段所在处），由 `LevelLoader` 生产。

**为什么用 `(string | undefined)[]` 而不是并行 `Map` 或把 id 塞进 `roomWaves`**：

- 塞进 `roomWaves` 会改变该字段的形状，而它的形状被 `tests/combat/economy_and_victory.test.ts` 以**引用同一性**（`expect(at(one.roomWaves, 0)).toBe(ROOM_A)`）钉死；
- 用 `Map` 会引入一个**非下标对齐**的查找结构，而房间推进的真相就是「下标 + 1」；
- `undefined` 是「无拓扑」的诚实表示，不需要哨兵字符串（空串 `''` 已被 `optionalNonEmptyString` 在配置层拒绝，不可能从数据来）。

`enemySpawnPoints` **必须**由 `descendEncounterRoom` 清空（§4.3）：它描述的是「当前房间」，而推进的瞬间「当前房间」已经变了。忘记清空会让下一间房沿用上一间的落点——一个安静、且只在「有拓扑 → 无拓扑」的推进方向上出现的错误。

---

## 4. 语义

### 4.1 `LevelLoader` —— 唯一的场景装配点

`src/core/LevelLoader.ts` 是「房间拓扑 → 世界实体」的唯一转换器。全部方法都是**静态、无状态、无跨 Tick 隐藏状态**的（spec 00 §6.1）。

| 方法 | 语义 | 是否抛错 |
|---|---|---|
| `tileToWorldCentre(col, row)` | 纯函数：格坐标 → 格中心（I4） | 否 |
| `collectWallTiles(config)` | 纯函数：所有 `1` 格，**行主序升序** | 否 |
| `findPlayerSpawn(config)` | 纯函数：**行主序第一个** `2` 格的中心；无 `2` 格时 `undefined` | 否 |
| `collectEnemySpawnPoints(config)` | 纯函数：所有 `3` 格的中心，**行主序升序** | 否 |
| `loadRoom(world, roomId)` | 查表 → 生成该房间**全部**墙体实体，返回 `RoomLoadResult` | 否（表已在 Bootstrap 校验） |
| `clearRoomEntities(world)` | 销毁 §4.4 的清理集，返回销毁数量 | 否 |
| `resetPlayerPose(world, playerId, spawn)` | 把玩家**硬重置**到 `spawn`（I5） | 否（实体不存活 ⇒ 返回 `false`） |
| `enterRoom(world, options)` | **过场入口**：清旧 → 建新 → 定位玩家 → 写出生点池 | 否 |

`enterRoom` 的**顺序是契约**：

```
1. clearRoomEntities(world)          // 旧墙 + 投射物 + 判定圆 + AoE + 掉落物
2. loadRoom(world, roomId)           // 新墙（实体 id 必然大于被销毁的旧墙）
3. findPlayerSpawn / collectEnemySpawnPoints
4. resetPlayerPose(world, playerId, spawn)
5. encounter.enemySpawnPoints = points
```

**为什么「先清后建」不可交换**：新墙的实体 id 必须大于旧墙，否则「旧墙被彻底清理」与「新墙数量正确」这两件事会在同一个 id 区间里互相掩盖。先清后建让两个断言都可以**按 id** 独立成立。

**为什么 `playerSpawn` 缺省时退回房间中心而不是抛错**：`parseRoomConfig` 已经保证从数据来的房间**至少有一个** `2` 格（§5 AC-01）。能走到「无出生点」这条路的只有**手工构造的 `RoomConfig` 对象**（测试夹具）。对它们，「房间中心」是一个诚实且可预测的兜底，而抛错会让 `step()` 里出现一个只在畸形夹具下才触发的异常路径（违反 I12）。

### 4.2 确定性出生（Deterministic Spawn）

`EncounterSystem.spawnWave` 在装配完 `buildWaveRoster` 之后、调用 `EnemyFactory.spawn` 之前，插入一个**落点解析**步骤：

```
若 encounter.enemySpawnPoints 为空  →  逐位退回（I10，不抽签、不消费 PRNG）
否则：
  start = world.rng.nextInt(0, pool.length - 1)      // 恰好 1 次抽签
  enemy[i] 的落点 = pool[(start + i) % pool.length]
```

**这是「确定性轮转 + 随机起点」，而不是「逐个独立抽取」**，三个理由：

1. **不重叠**：`pool.length ≥ roster.length` 时，轮转保证每个敌人落在**不同**的格上。逐个 `pick`（有放回）会以正概率让两个敌人叠在同一个格中心——重叠的 hurtbox 在玩家眼里、在碰撞断言里都读作「一个敌人」。
2. **最小流扰动**：每波恰好消费 **1** 次 `nextFloat`，而不是 `roster.length` 次。PRNG 是全局单流（ADR-004），波次落点消耗的抽签次数会**平移后续所有抽签**（奖励三选一就在同一个流上）。把扰动固定成 1 次，让「落点」与「奖励」两条消费路径的相互影响可被精确推理。
3. **`depth` 复制体自动处理**：`buildWaveRoster` 追加的复制体走**同一条**轮转，池小于队伍时自然回绕——不需要第二套规则，也不会因为复制体而落到池外。

`depth` 追加复制体原本带 `x += DEPTH_SPAWN_SPACING_UNITS * (i + 1)` 的横向错位；**有拓扑时该偏移被整体覆盖**（I6 要求坐标精确等于池内点），错位由轮转本身提供。**无拓扑时该偏移逐位保留**（I10）。

### 4.3 过场的两个调用点

| 路径 | 调用者 | 时机 |
|---|---|---|
| **初始房间** | `runSetup(world)`（构造期选项） | `GameSimulator` 构造后首次运行，以及**每一次** `restartRun` |
| **房间推进** | `RewardSystem.update` | 玩家选定奖励、`descendEncounterRoom` 之后，**同一 Tick 内** |

**`GameSimulator` 保持游戏无关（这是刻意的设计决定，而不是遗漏）。** `GameSimulator` 不知道什么是「房间」、什么是「玩家」——它只知道「构造期可以给我一个 `runSetup` 回调，`restartRun` 会在清空世界、重播种、清输入、重置系统总线、回拨时钟之后调用它」（spec 14 §4.5 的六步契约）。

因此 **AC-02 在 `restartRun` 路径上的实现方式是**：`runSetup` 本身走 `LevelLoader.enterRoom(world, { roomId: <房间 0>, playerId, encounter })`，于是 `restartRun` 的第 6 步**必然**重载房间 0 的拓扑并把玩家钉在出生格中心。这条契约由 `tests/world/tilemap_and_topology.test.ts` 的 G2 直接断言（`restartRun` 后墙体数量 == 房间 0 的 `1` 格数，玩家坐标 == 房间 0 出生格中心）。

给 `GameSimulator` 加一个 `initialRoomId` 选项会更「字面」，但会把一个游戏概念塞进一个**刻意保持游戏无关**的类里，而换来的只是把同一段装配从 `runSetup` 搬到构造函数——收益为零，代价是 `src/core` 从此认识「房间」。

**推进路径的 `descendEncounterRoom` 签名保持不变**（`(room) => void`）：它只做**纯状态转移**（下标 +1、`depth` +1、换 `waves` 引用、重置调度器、清空 `trackedEntityIds` 与 `enemySpawnPoints`），因为它是 `tests/data/encounters_hmr.test.ts` 以单参数调用的公开 API。场景装配是**它之后**的独立一步，由 `RewardSystem` 调用 `LevelLoader.enterRoom`——「换配置」与「换世界」是两件事，分开写让它们各自可测。

### 4.4 清理集（AC-04 的口径）

`clearRoomEntities` 销毁**恰好**下列组件的实体，按组件逐个 `query`（升序）收集后统一销毁：

| 组件 | 代表什么 | 为什么属于清理集 |
|---|---|---|
| `WallComponent` | 旧房间的静态几何 | 地形属于房间，不跟着玩家走 |
| `HitboxComponent` | 在飞 / 待判定的伤害圆 | 近战挥击、词缀注入圆、**投射物**（投射物同时拥有 `HitboxComponent`，是它的子集） |
| `HazardComponent` | 已布置、未爆的 AoE | 引信属于上一间房的战斗节奏 |
| `PickupComponent` | 未拾取的掉落物 | 掉落物属于上一间房的战利品 |

**显式不在清理集内**（并且是刻意的）：

- **尸体**（`DeadTagComponent`）。`死亡是状态不是删除`（spec 08 §4.4）是引擎的既有铁律，`GameRenderer.retired` 也建立在「尸体永不销毁」之上。过场销毁尸体会让「尸体留在原地」这条被三个里程碑依赖的契约出现一个例外。代价是旧房间的尸体留在新房间里（视觉上的小瑕疵），收益是零例外。**已登记为已知风险 R2。**
- **敌人**。推进到下一间房的前提是**本波已被清空**（`isWaveCleared`），所以清理集里本就不该有活着的敌人；而「顺手把所有 `HealthComponent` 实体删掉」会在未来某个「带随从进下一间房」的设计里变成静默的 bug。
- **玩家 / 房间单例 / 游戏状态单例**。

**为什么 `HitboxComponent` 而不是 `ProjectileComponent`**：投射物只是「会飞的判定圆」这一大类中的一种。近战挥击（`CombatActionSystem`）与词缀注入圆（`ModifierSystem`）同样是**瞬时**的伤害载体，同样不该跨房间存活。按 `HitboxComponent` 清理得到的是**完整的**「本次战斗的残留」，按 `ProjectileComponent` 清理只得到其中一类。而 `HitboxComponent` **不可能**挂在战斗单位上（战斗单位只有 `HurtboxComponent`），所以这个口径不会误伤。

### 4.5 管道与渲染

- **管道恒为 17 段**，不新增段、不重排。过场发生在 `RewardSystem`（idx 14）内部，落在既有段里。三条被依赖的时序契约不受影响：`RewardSystem` 仍在 `EncounterSystem` 之后（本 Tick 的 `ROOM_CLEARED` 已确定）、仍在 `LifespanSystem` 之前（LAST 不变）。被销毁的 `HitboxComponent` / `PickupComponent` 实体在随后的 `PickupSystem`（idx 15）与 `LifespanSystem`（idx 16）里**不再出现在 `query` 结果中**，这是 `destroyEntity` 的正常语义。
- **过场是「1 Tick 内同步完成」的**（I8）：`RewardSystem.update` 返回时，新房间的墙体已在世界里、玩家已在出生格中心、`enemySpawnPoints` 已写入。`EncounterSystem` 在本 Tick 已经跑过，因此新房间的第一波在**下一 Tick** 被调度——这正是 spec 08 §6 的既有「1 Tick 相位」，不是新的延迟。
- **渲染层**：`GameRenderer` 新增 `syncStaticGeometry(world)`，把 `WallComponent` 画成色块，并按**所有墙体的包围盒并集**画一块地板底色。墙体没有 `TransformComponent`，所以它们**不能**走既有的 `createMissingViews` 路径（那条路径以 `query(TransformComponent)` 为入口）。静态几何层被**惰性挂到 `stage` 的索引 0**（仅在「世界存在至少一堵墙」时创建），因此：
  - `stage.children[0]` 仍是 render root（M5 冻结渲染测试的契约）；
  - `root.children[0]` 仍是第一个实体视图、`root.children[last]` 仍是 `fxLayer`（同样被冻结）；
  - 一个**没有墙**的世界（所有 M1–M11 夹具）看到与之前**完全相同**的场景图。

---

## 5. 验收标准

| ID | 验收标准 | 证据 |
|---|---|---|
| **AC-01** | 网格契约：房间地形由 JSON 中的 2D 整数数组定义（`0` 地板 / `1` 墙 / `2` 玩家出生点 / `3` 敌人刷新区），每格对应 `1 × 1` 单位面积；一维与二维两种书写形式都被接受并归一化；尺寸不一致、非整数、越域取值、缺玩家出生点**全部**在加载期抛 `SchemaError` | G0 |
| **AC-02** | 场景装配：进入新房间（`ROOM_CLEARED` 推进**或** `restartRun`）时 `LevelLoader` 解析网格，为**每一个** `1` 生成一个 `WallComponent` 静态实体；墙体实体数 == 网格中 `1` 的个数 | G1 / G2 |
| **AC-03** | 确定性出生：玩家坐标被硬重置到 `2` 格的精确中心（并同步 `PreviousTransformComponent`）；敌人坐标从 `3` 格池中用 `world.rng` 确定性选取，取代中心点硬编码偏移；同 seed ⇒ 同分布 | G1 / G3 |
| **AC-04** | 场景清理：离开房间时旧房间的**全部** `WallComponent` 实体被销毁，同时清理投射物 / 判定圆 / AoE / 掉落物；尸体不在清理集内 | G2 |
| **AC-05** | 静态几何：`WallComponent` 实体**不挂** `TransformComponent` / `VelocityComponent`，且没有任何系统每 Tick 推进它们 | G0 |
| **AC-06** | 管道不变：恒为 17 段、顺序不变；`LifespanSystem` 仍为 LAST | G4 |
| **AC-07** | 零回归：无拓扑的房间（`roomIds` 空 / `enemySpawnPoints` 空）行为与 M11 逐位一致；`descendEncounterRoom` 单参数签名不变 | G4 |
| **AC-08** | 表现层：`GameRenderer` 画出地板色块与墙体色块，且不破坏 M5 的 `stage` / `root` 子节点契约 | G5（+ `vite build` / `typecheck:client`） |

---

## 6. 测试契约

`tests/world/tilemap_and_topology.test.ts`（新增），分组：

| 组 | 内容 |
|---|---|
| **G0** | 网格解析与校验：一维 / 二维归一化一致；尺寸不一致抛错；非整数 / 越域抛错；缺玩家出生点抛错；`DataManager` 注册表与跨表 `roomId` 校验；`WallComponent` 实体不挂 `TransformComponent` / `VelocityComponent` |
| **G1** | 物理拓扑：3×3 封闭房间（四周墙、中心玩家出生点），玩家向上注入持续移动输入，断言被顶部墙体正确阻挡、坐标不再变化 |
| **G2** | 过场清理与重建：打通房间 0 推进到房间 1，断言旧墙实体**全部**销毁、新墙数量与 `rooms.json` 中该房间 `1` 格数**绝对一致**、玩家坐标 == 新房间出生格中心；`restartRun` 后同样成立 |
| **G3** | 出生点分布：5 个出生点的房间生成 3 个敌人，断言 3 个坐标**全部**落在池内且互不相同；同 seed 两次运行分布完全一致，不同 seed 可给出不同起点 |
| **G4** | 契约守卫：17 段管道；`descendEncounterRoom` 清空 `enemySpawnPoints`；无拓扑时退回中心线队形且**不消费 PRNG**（用「观察生成器下一个值」证明，不用「结果是 null」） |
| **G5** | 表现层：无墙时 `stage` 只有 render root、`wallViewCount === 0`；加载房间后 `wallViewCount === 1` 格数，静态层位于 `stage` 索引 0（在 root **之下**）；清理后静态层随之消失、场景图回到 M12 之前的形状 |

**测试纪律**（沿用仓库既有约定）：真实 `GameSimulator` + 真实 `createDefaultSystems()`，不 mock；`step(1)` 逐 Tick 钉时序；浮点容差 `1e-9`；断言值一律写成**字面量**（`3×3` / `5` / `3` / `36` / `48`），不得与「构造它的那个常量」比较（恒真陷阱）。

---

## 7. 兼容性与迁移

| 既有行为 | M12-T01 后 |
|---|---|
| 手写房间（`EncounterFactory.spawn(world, { waves })`） | **不变**。`roomIds` 默认 `[]`、`enemySpawnPoints` 默认 `[]` ⇒ 不装配地形、不抽签、队形逐位一致 |
| `descendEncounterRoom(room)` | **签名不变**，只多清空 `enemySpawnPoints` |
| `EncounterFactory.spawnFromData` | 多装配一个 `roomIds`；`roomWaves` 形状不变 |
| `DataManager.getEncounterWaves(depth)` | **不变**（`roomId` 在房间条目上，不在波次上） |
| `encounters.json` 夹具不写 `roomId` | **仍然合法**（`roomId` 可选） |
| 无 `rooms` 表的 bundle | **仍然合法**（`rooms` 可选）；只有在**声明了** `roomId` 却查不到时才是错误 |
| 渲染层 | `stage` / `root` 子节点契约不变；新增的静态层只在有墙时出现 |

---

## 8. 已知风险与缓解

| ID | 风险 | 缓解 |
|---|---|---|
| **R1** | 网格**不校验连通性**：一个把玩家出生点封死在墙里的房间是合法配置，玩家会立刻卡住 | 明确登记为关卡作者的责任（§1.3）；`parseRoomConfig` 的职责边界是「形状」而非「可玩性」。G1 用一个**故意的**封闭房间证明「被墙封住 ⇒ 坐标不再变化」正是本里程碑期望的物理行为 |
| **R2** | 房间切换**不清理尸体**，旧房间的尸体会留在新房间里 | 刻意的取舍（§4.4）：`死亡是状态不是删除` 是三条既有契约的基础。若未来需要，正确做法是给渲染层一个「房间代际」标记，而不是在逻辑层为尸体开一个例外 |
| **R3** | 一格一墙 ⇒ 一个大房间会产生数百个 `WallComponent`，`resolveWalls` 是 `O(实体 × 墙)` | 真实房间尺度（10×10 ~ 12×10 ⇒ 36~48 堵墙）下可忽略；已在 §1.3 登记为后续性能里程碑的贪心合并优化项 |
| **R4** | 出生点池小于队伍（`depth` 复制体）时敌人会**回绕**到已用的格上 | 这是刻意的降级（§4.2）：回绕比「落到池外」或「静默丢弃复制体」都更诚实。关卡作者可以通过增加 `3` 格来避免 |
| **R5** | 渲染层不做相机跟随，房间固定在画布左上角 | 「极简色块」是本里程碑对表现层的全部要求（§1.3）；相机是独立里程碑 |

---

## 9. 参考

- `specs/00_harness_spec.md` §6（ECS / 零隐藏状态 / Snapshot）
- `specs/08_encounter_and_death_spec.md` §3.2 / §4.3 / §6（房间单例、三态、1 Tick 相位）
- `specs/13_arena_and_projectiles_spec.md` §3.1 / §3.2 / §4.1（`resolveCircleAABB`、`WallComponent`、静态几何解算）
- `specs/15_economy_and_victory_spec.md` §3.5 / §4.4 / §4.5（房间表、终房判据、推进）
- `specs/16_data_driven_pipeline_spec.md` §3 / §4.3（schemas、DataManager、异步 Bootstrap）
- `specs/17_encounters_hmr_spec.md` §3.1 / §3.2 / §4.3（按深度读房间表、HMR 边界）
- `docs/architecture/ADR-004-deterministic-prng.md`（单流 PRNG、种子只读不重播种）
