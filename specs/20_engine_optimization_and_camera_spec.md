# 20 · Engine Optimisation & Camera Spec（贪心网格合并、软碰撞分离与表现层摄像机）

| Field | Value |
|---|---|
| Spec ID | `SPEC-20-ENGINE-OPT` |
| Milestone | **M12 · 关卡与场景装配**（T02） |
| Status | `accepted`（本文件为 M12-T02 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/core/LevelLoader.ts`（`mergeWallRects` / `spawnWalls` / `RoomLoadResult`）、`src/ecs/systems/MovementSystem.ts`（新增 `separateBodies` 相位 + 导出 `separationAngle`）、`client/GameRenderer.ts`（`camera` 容器 / `syncCamera` / `CAMERA_LERP_FACTOR`）、`tests/world/tilemap_and_topology.test.ts`（G1/G2/G5 断言同步）、`tests/render/renderer_bridge.test.ts`、`tests/render/interpolation.test.ts`、`tests/render/juice-verify.test.ts`（`renderRoot` 助手穿透 camera）、`tests/physics/soft_collision.test.ts`（新）、`tests/render/camera_follow.test.ts`（新） |
| Depends on | `specs/19_room_topology_and_tilemaps_spec.md`（网格契约 / `WallComponent` 一格一墙 / 清理集 / 静态几何渲染）、`specs/13_arena_and_projectiles_spec.md`（`resolveCircleAABB` / `MovementSystem` 静态几何解算 / 墙解算顺序契约）、`specs/09_renderer_bridge_spec.md`（`stage` / `root` 子节点契约）、`specs/10_render_juice_spec.md`（`fxLayer` 恒为 root 最后子节点 / 插值）、`specs/00_harness_spec.md`（零隐藏状态 / 确定性）、`docs/architecture/ADR-001-headless-ecs-foundation.md`、`docs/architecture/ADR-002-render-interpolation.md`、`docs/architecture/ADR-004-deterministic-prng.md` |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

M12-T01 让「房间」第一次有了形状，但它留下了三处**已知的、登记在案的**缺口（spec 19 §1.3 / §8 R3 / §8 R5），M12-T02 逐一收口：

1. **一格一墙 ⇒ 解算规模与瓦片数成正比。** spec 19 I2 刻意选择「每个 `1` 格恰好一个 `WallComponent`」以换取确定性（实体 id 与格子行主序一一对应），代价是 `resolveWalls` 是 `O(动态实体 × 墙数)`，而一面 10 格的墙被拆成 10 个 AABB。真实房间尺度下（36~48 堵墙）尚可忽略，但它是**唯一一处「房间越大、物理越慢」的线性增长**。M12-T02 在**加载期**把连续的墙格贪心合并成尽可能少的大 AABB，把解算从 `O(N_tile)` 降到 `O(N_rect)`，**且不改变任何一次推出的结果**。
2. **同阵营的存活动态实体会互相穿透。** 出生点轮转（spec 19 §4.2）保证一波敌人落在**不同**的格上，但它只保证**出生那一刻**不重叠：敌人向同一个玩家追击时会收敛到同一条直线上，多个 hurtbox 叠在一起，玩家（和碰撞断言）读作「一个敌人」。M12-T02 增加一个**纯数学、确定性**的软碰撞分离相位，让同阵营的重叠实体沿重叠深度方向彼此推开。
3. **房间固定在画布左上角，玩家会走出视野。** spec 19 §1.3 显式排除了相机（R5）。M12-T02 在**表现层**引入一个 Camera 概念：世界（地板 / 墙体 / 角色 / 特效）全部挂在一个每帧被平移的 `Container` 下，玩家被 Lerp 居中，而静态 HUD 仍是 DOM、天然固定在屏幕上。

> 一句话判据：**「合并」让墙的几何等价于逐格、但解算更快；「分离」让同阵营的身体不再叠在一起、但绝不把身体推进墙里；「相机」让世界跟随玩家、但逻辑层毫不知情。**

### 1.2 In Scope（做什么）

- **加载期贪心合并**：`LevelLoader.mergeWallRects(config)` —— 经典 2D 贪心矩形合并（先横向扩展、再纵向扩展，行主序扫描 + `visited` 标记），返回合并后的 AABB 列表；`spawnWalls` 改为对合并矩形调用 `createWall`；`RoomLoadResult` 的 `wallCount` 语义改为「合并后的 AABB 数」，并新增 `wallTileCount`（网格中 `1` 的个数）以支撑「面积守恒」断言。
- **软碰撞分离**：`MovementSystem` 新增 `separateBodies` 相位（**不新增管道段**），对「`Transform` + `Velocity` + `Hurtbox` + `Faction` 且**同阵营**」的存活实体两两（`i<j` 升序）做基于重叠深度的对称斥力位移；完全重合时用基于 `EntityId` 的确定性方向规则。导出纯函数 `separationAngle(a, b)` 供测试直接钉桩。
- **表现层摄像机**：`GameRenderer` 引入 `camera` 容器，场景图变为 `stage → camera → { staticLayer, root }`；每帧 `syncCamera` 用 Lerp 趋近「屏幕中心 − 玩家渲染坐标」；跳字（世界坐标）随相机平移；静态 HUD 保持 DOM。

### 1.3 Out of Scope（显式排除）

- ❌ **不新增 / 不重排管道段**：管道恒为 **17 段**（§4.4）。软碰撞是 `MovementSystem`（idx 5）尾部的一个新相位，不是第 18 段。
- ❌ **不做空间划分 / 宽相位（broad-phase）**：合并后矩形数是常数级（≤ 十几），两两检测足够；四叉树 / 网格哈希是后续性能里程碑的事。
- ❌ **不做「不同阵营也分离」**：AC-02 只要求**同阵营**。玩家与敌人刻意不分离（§4.2 给出完整理由），这是为了避免把 `status_effects` / `walls_and_projectiles` 的既有夹具打散。
- ❌ **不做墙体之间的合并之外的几何化简**：不合并地板、不生成导航网格、不计算凸包。
- ❌ **相机不做缩放 / 旋转 / 边界钳制 / 平滑回弹**：只有一个轴对齐平移 + 一阶 Lerp。房间边界钳制是独立里程碑（避免「房间比屏幕小」这类新失败面）。
- ❌ **不做屏幕空间容器**：HUD 是 DOM（`#hud` / `#gold`），天然固定在屏幕上（§4.3）。
- ❌ **不改 `resolveCircleAABB` / `WallComponent` / `createWall` 的任何契约**：合并只改变喂给解算器的**形状数量**，不改变解算器本身。

---

## 2. 术语与不变量

| 术语 | 定义 |
|---|---|
| **贪心合并（Greedy Meshing）** | 把网格中连续的同值格合并为尽可能少的大矩形；本 spec 指对 `1` 格做「先横向、再纵向」的矩形扩张 |
| **合并矩形（Merged Rect）** | 一次合并产出的 AABB；其**几何并集**必须与逐格 AABB 的并集完全相等（面积守恒） |
| **瓦片数（Tile Count）** | 网格中 `1` 的个数；`wallTileCount` |
| **矩形数（Rect Count）** | 合并后的 AABB 个数；`wallCount` |
| **同阵营（Same Faction）** | 两个实体的 `FactionComponent.faction` 相等 |
| **重叠深度（Overlap Depth）** | 两个圆形 hurtbox 的 `minDist − dist`，其中 `minDist = rA + rB`；严格 `<` 才算重叠 |
| **分离相位（Separation Phase）** | `MovementSystem` 内、`integrateKinematic` 之后、`resolveWalls` 之前的一个 pass |
| **摄像机（Camera）** | 表现层的一个 `Container`；世界内容的公共父节点，每帧被平移，使玩家居中 |
| **屏幕尺寸（Screen Size）** | `app.screen.width / height`；在**假 `Application`**（只有 `{ stage, ticker }`）下缺失，读取时降级为 `0` |

### 2.1 不变量（I1 – I14）

- **I1 — 合并的几何等价（面积守恒）。** `mergeWallRects(config)` 产出的矩形**两两不重叠**，且其**并集**恰好等于「所有 `1` 格 AABB 的并集」。等价的可断言形式：矩形面积之和 == `wallTileCount`（每格面积 `1`）。
- **I2 — 合并的解算行为等价。** 对**任何**输入位置，用合并后的矩形集合跑 `resolveWalls`，与用逐格矩形集合跑，得到的**推出后位置**逐位一致。对「贴边」与「内部」两类位置成立（贴边 ⇒ 无推出；内部 ⇒ 按最近面推出，而最近面在合并前后是同一个面）。
- **I3 — 合并顺序是行主序的左上角序。** 扫描是行主序（`row` 外层、`col` 内层），矩形在其**左上角格**被首次遇到时产出，因此输出顺序 == 各矩形左上角的行主序。确定性可逐位断言。
- **I4 — 加载期不抛错。** `mergeWallRects` 是**纯函数、无状态**，只在 `enterRoom`（`step()` 内）被调用，绝不抛错（spec 19 I12 的同一条纪律）。加载期的形状校验仍在 `DataManager.loadAll`。
- **I5 — 分离只作用于「同阵营的存活动态圆体」。** 目标集 = `query(Transform, Velocity, Hurtbox, Faction)` 且 `!isDead`；配对条件 = `faction` 相等。不同阵营**绝不**分离。
- **I6 — 分离是纯数学、零熵。** 分离只读 `Transform` / `Hurtbox` / `Faction` / `EntityId`，只写 `Transform.x/y`。禁 `Math.random`、禁 `Date`、禁任何熵源；完全重合时的方向是 `EntityId` 的**纯函数**（`separationAngle`）。
- **I7 — 分离严格 `<`。** 当 `distSq >= minDist²`（相切或分离）⇒ 跳过。谓词与 `CollisionSystem` / `PickupSystem` 的圆-圆重叠谓词逐字一致。
- **I8 — 分离位移不乘 `fixedDeltaSeconds`。** 它是**位置修正**（把身体推离），不是**速度积分**；乘 `dt` 会让「一帧修不完、下一帧继续修」，破坏「相切即稳定」。位移量 = `overlap * 0.5`，两侧各一半。
- **I9 — 相位顺序：`integrate → integrateKinematic → separateBodies → resolveWalls`。** 分离**先跑**、墙解算**后跑** ⇒ 几何永远拥有最终发言权（分离不可能把身体推进墙里）。顺序不可交换。
- **I10 — 分离早退保护。** 目标集 `ids.length < 2` ⇒ 直接 `return`。单实体世界的分离相位是**逐位零操作**。
- **I11 — 相机只平移，不改变世界坐标。** 实体视图 / 墙体视图的 `x/y` 仍是**世界像素**（`world * PX_PER_UNIT`）；只有 `camera.x/y` 被写。相机是纯粹的呈现变换。
- **I12 — 相机对缺失屏幕尺寸安全。** `screenWidth()` / `screenHeight()` 在 `app.screen` 缺失（假 `Application`）或非有限时返回 `0`，**绝不**读 `app.renderer.*`、绝不抛错。`screen === 0` ⇒ 目标 = `-playerPx`，仍是确定、可断言的值。
- **I13 — 场景图冻结契约。** `root` 恒为 `camera` 的**最后一个**子节点；`camera` 恒为 `stage` 的**唯一**子节点；`fxLayer` 恒为 `root` 的**最后一个**子节点。静态层（仅「世界有墙」时存在）恒为 `camera` 的**索引 0**。
- **I14 — 相机是表现层独有。** `src/` 不含任何相机概念；相机只在 `client/GameRenderer.ts`，单向只读 `World`（spec 09 AC-01）。

---

## 3. 数据结构

### 3.1 `LevelLoader.mergeWallRects(config): readonly WallSpawnOptions[]`

返回合并后的 AABB 列表，每个元素是 `WallSpawnOptions`（`{ x, y, width, height }`，与 `createWall` 同一形状，因此可以**逐字**喂给 `createWall`）。顺序 = 每个矩形**左上角**的行主序（I3）。

算法（行主序扫描 + `visited`）：

```
visited = 与 grid 同形的布尔数组，全 false
for row in 0..height-1:
  for col in 0..width-1:
    if grid[row][col] != 1 or visited[row][col]: continue
    // 1. 横向扩展：向右吃同行的连续未访问 1 格
    w = 1
    while col+w < width and grid[row][col+w] == 1 and not visited[row][col+w]: w += 1
    // 2. 纵向扩展：向下吃「整行 [col, col+w) 都是未访问 1 格」的行
    h = 1
    while row+h < height and rowFullyWall(col, w, row+h): h += 1
    // 3. 标记 + 产出
    mark visited over [row, row+h) x [col, col+w)
    emit { x: col, y: row, width: w, height: h }
```

**为什么「先横后纵」而不是「先纵后横」**：两种都是合法的贪心合并，产出的矩形数可能不同，但**几何并集与解算行为都相同**（I1 / I2）。选横向优先是因为它把「一行墙」这类最常见的地形（房间顶边 / 底边）合并成单条矩形，读起来与人类对「一堵墙」的直觉一致，也让 `box_3x3` 这类小房间的矩形列表便于人工核对。

**为什么需要 `visited`**：没有它，纵向扩展会与后续行主序扫描重复覆盖同一批格子，产出重叠矩形——那会让「面积之和 == 瓦片数」（I1 的可断言形式）失败，并让 `resolveWalls` 对同一堵墙推两次。

### 3.2 `RoomLoadResult` 的两个计数字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `wallCount` | `number` | **合并后的 AABB 数**（= 实际生成的 `WallComponent` 实体数）。语义在 M12-T02 从「`1` 格数」**变更为**「矩形数」 |
| `wallTileCount` | `number` | 网格中 `1` 的个数（= 逐格口径的墙数）。**新增**，使 I1 的「面积守恒」可断言 |

**为什么保留两个字段而不是只留一个**：`wallCount` 是**世界状态**（世界里到底有几个墙实体），`wallTileCount` 是**几何真相**（地形到底占了多少格）。AC-01 的「等价」正是「这两个数之间隔着一次合并」的陈述：`wallCount ≤ wallTileCount`，且 `mergeWallRects` 的面积之和 == `wallTileCount`。只留一个数就无法把「合并正确」与「合并过头」区分开。

### 3.3 `separationAngle(a: EntityId, b: EntityId): number`

```ts
/** 16 个等分方向槽；id 混合后用 `Math.imul` 保证跨平台确定性。 */
const SEPARATION_DIRECTION_SLOTS = 16;

export function separationAngle(a: EntityId, b: EntityId): number {
  const mixed = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;
  return ((mixed % SEPARATION_DIRECTION_SLOTS) / SEPARATION_DIRECTION_SLOTS) * Math.PI * 2;
}
```

- **纯函数**：同 `(a, b)` ⇒ 同角度，逐位一致；无状态、无熵。
- **值域 `[0, 2π)`**：`mixed % 16 ∈ [0, 15]` ⇒ 角度是 `k * π/8`，`k ∈ [0, 15]`。
- **`Math.imul`**：32 位整数乘法，避免 `a * 常量` 在超过 2^53 时丢精度——这是跨平台确定性（ADR-004 的同一纪律）在整数混合上的体现。
- **对称性不是需求**：`separationAngle(a, b)` 与 `separationAngle(b, a)` **不要求相等**。两个完全重合的实体只需被推向**某两个相反**的方向（A 沿 `−n`、B 沿 `+n`），方向本身选哪个槽不重要——重要的是「同一个 id 对每次都给同一个方向」（I6 / §4.2）。

### 3.4 `CAMERA_LERP_FACTOR`

```ts
export const CAMERA_LERP_FACTOR = 0.2;
```

每帧相机向目标移动 `20%` 的剩余距离。这是一个**纯表现常数**，不参与逻辑、不进快照、不被 `src/` 读取。它决定了「相机追上玩家的速度」：`0.2` 在 60fps 下约 3~4 帧走完 50%、约 20 帧走完 99%，足够「跟随」而不至于「黏死在玩家身上」。

---

## 4. 语义

### 4.1 AC-01 —— 贪心网格合并

`spawnWalls` 的**契约变更**：

```
旧：对每个 `1` 格调用 createWall ⇒ 返回 `1` 格数
新：对每个合并矩形调用 createWall ⇒ 返回矩形数
```

`enterRoom` 的其余步骤（清旧 → 建新 → 导出生点 → 重置玩家位姿 → 写出生点池）**顺序不变**（spec 19 §4.1）。`loadRoom` / `clearRoomEntities` / `resetPlayerPose` 的契约不变。

**为什么行为逐位等价（I2）**：`resolveCircleAABB` 对「圆 vs 若干互不重叠、并集等于 `W` 的 AABB」的结果，与对「圆 vs 单个 AABB `W`」的结果相同，因为：

- 圆与**并集**的最近点，必然落在**某一个**成员 AABB 上（并集是成员之并，最近点属于并集 ⇒ 属于某成员）；
- 若最近点所在成员 AABB 不重叠圆，则其余成员（不重叠、且不与它重叠）更不可能把圆包住，返回 `[0,0]`；
- 若最近点所在成员重叠圆，则推出方向 = 「该成员的最近面」，而合并**不会把一个面切成两段**（合并的矩形边缘始终落在原网格的格线上），所以最近面在合并前后是同一条几何边。

**已知取舍（§7 T1）**：「墙数 ≠ 瓦片数」是一个**语义变更**——任何以「墙实体数 == `1` 格数」为不变量的外部断言（正是 spec 19 I2）都必须改为「墙实体数 == 矩形数 ∧ 面积守恒」。这是本 spec 明确登记、并由测试同步兑现的代价。

**已验证的期望值**（字面量钉桩；测试必须自己确认）：

| 房间 | `1` 瓦片数 | 合并后矩形数 | 矩形列表 |
|---|---|---|---|
| `box_3x3` | 8 | **4** | `(0,0,3,1)`、`(0,1,1,2)`、`(2,1,1,2)`、`(1,2,1,1)` |
| `room_a` | 11 | **4** | `(0,0,4,1)`、`(0,1,1,3)`、`(3,1,1,3)`、`(2,3,1,1)` |
| `room_b` | 12 | **4** | `(0,0,4,1)`、`(0,1,1,3)`、`(3,1,1,3)`、`(1,3,2,1)` |
| `spawn_five` | 3 | **1** | `(0,2,3,1)` |

### 4.2 AC-02 —— 软碰撞分离

`separateBodies` 相位，插入在 `integrateKinematic` 与 `resolveWalls` 之间（I9）。

```
ids = query(Transform, Velocity, Hurtbox, Faction)        // id 升序
if ids.length < 2: return                                  // I10 早退
for i in 0..ids.length-1:
  if isDead(ids[i]): continue                              // 尸体不参与
  for j in i+1..ids.length-1:
    if isDead(ids[j]): continue
    if faction[i] != faction[j]: continue                  // 只同阵营
    minDist = r[i] + r[j]
    distSq = (xj-xi)^2 + (yj-yi)^2
    if distSq >= minDist^2: continue                        // 严格 <（I7）
    if distSq == 0:
      (nx, ny) = (cos(θ), sin(θ)) where θ = separationAngle(id[i], id[j])
      overlap = minDist
    else:
      dist = sqrt(distSq); (nx, ny) = ((xj-xi)/dist, (yj-yi)/dist)
      overlap = minDist - dist
    half = overlap * 0.5
    transform[i] -= (nx, ny) * half                         // 不乘 dt（I8）
    transform[j] += (nx, ny) * half
```

**为什么相位顺序是「分离先、墙后」（I9）**：`resolveWalls` 是**几何的最终裁决**。若分离在墙解算之后跑，它可能把两个身体一起推进墙里（分离只关心身体之间的距离，不知道墙），而这一帧内没有任何后续 pass 会把它们推回来——身体就会穿墙。反过来，墙解算在分离之后跑，最坏情况是「分离推开了一点、墙又推回来一点」，结果是**身体仍在墙外**，即几何永远赢。

**为什么位移不乘 `fixedDeltaSeconds`（I8）**：这是**位置修正**（把重叠消除），不是**速度积分**（时间 × 速度）。乘 `dt` 会让「本帧只修掉 `dt` 比例的重叠、下帧继续修」，使两个身体在接触后**每拍抖动**若干帧才稳定。不乘 `dt` 则一次修正到位：完全重合 ⇒ 一步推到相切；之后 `distSq >= minDist²` ⇒ 稳定不动。这也是「相切即稳定」这条测试断言能成立的前提。

**为什么只同阵营（I5）**：AC-02 的字面要求就是「同阵营」。更重要的是一条**爆炸半径**考量（M12-T01 记录在案的 R4）：`tests/combat/status_effects.test.ts` 与 `tests/physics/walls_and_projectiles.test.ts` 的既有夹具会让**玩家与敌人**在很近甚至重合的位置共处（例如挥击判定、击退），如果分离作用于**跨阵营**，这些夹具里「敌人被推离玩家 0.5 单位」会静默改变它们的期望坐标，把一次局部优化变成全仓回归。同阵营约束把爆炸半径限制在「同阵营重叠」这一新场景内——而那正是 M12-T01 的出生点轮转留下的唯一缺口。

**完全重合的确定性方向（I6）**：`distSq === 0` 时「从 A 到 B 的单位向量」没有定义（除零）。用 `separationAngle(a, b)` 从 `EntityId` 派生一个固定方向，保证：同一对 id 每次分离都沿同一方向（可复现），且不同 id 对分布到多个方向槽（避免所有重合实体被推向同一方向而叠成一条线）。**禁**任何熵源（`Math.random` 在 `src/` 被 ESLint AST 门拒绝，ADR-001 R2）。

**为什么目标集要求 `Velocity`**：分离的是**动态**圆体——一个会动的身体才有「被挤开」的语义。静态判定圆（近战挥击 / 词缀注入圆）没有 `Velocity`，不参与；这与 `resolveWalls` 的目标集口径（spec 13 §4.1）一致。

### 4.3 AC-03 —— 表现层摄像机

**新场景图（I13）**：

```
app.stage
 └─ camera (Container)              // 每帧被平移
     ├─ staticLayer (Container)     // 惰性；地板 + 墙体色块（camera 索引 0）
     └─ root (Container)            // 实体视图… + fxLayer（fxLayer 恒为 root 最后子节点）
         ├─ view[0..n]
         └─ fxLayer
```

- `init()`：`stage.addChild(camera)`，再 `camera.addChild(root)`（`camera` 恒为 stage 唯一子节点，`root` 恒为 camera 最后子节点）。
- `ensureStaticLayer()`：`camera.addChildAt(layer, 0)` —— 静态层在 `camera` 索引 0，永远画在实体之下。
- `syncCamera(world)`：在 `syncWorld` 里 **`syncTransforms` 之后**调用（必须读**插值后**的渲染坐标）：

```
取 kind === 'player' 且 !isDying 的视图，读 container.x/y（已是世界像素）
targetX = screenWidth() / 2 - playerPxX
targetY = screenHeight() / 2 - playerPxY
camera.x += (targetX - camera.x) * CAMERA_LERP_FACTOR     // y 同理
无玩家视图 ⇒ 直接 return（相机原地不动，不抛错）
```

**为什么读插值后的坐标**：相机的目标是「让玩家在屏幕上居中」，而玩家**看到**的是插值后的位置（ADR-002）。读 `Transform` 的原始坐标会让相机与玩家视图错开半帧，产生抖动。读 `container.x/y` 是「相机跟随所见」的直接实现。

**为什么屏幕尺寸从 `app` 读、且对假 `Application` 安全（I12）**：既有渲染测试的替身只有 `{ stage, ticker }`，**没有 `renderer` 也没有 `screen`**。`screenWidth()` / `screenHeight()` 用可选/降级读取 + 有限性校验，缺失时返回 `0`；**绝不**读 `app.renderer.*`（那会在测试里抛错）。`screen === 0` 时相机把玩家居中到屏幕原点（目标 = `-playerPx`），仍然确定、可断言。

**跳字（`floatingTexts`）与 HUD**：跳字挂在 `fxLayer`（在 `camera` 树内），其坐标是**世界坐标**，因此随相机一起平移，**无需改动**。HUD 是 DOM（`#hud` / `#gold`），天然固定在屏幕上，因此 Pixi 侧**不需要**独立的屏幕空间容器——这正是「HUD 不做成 Pixi 节点」的回报。

**`reset()` / `destroy()`**：`reset()` 把 `camera.x/y` 归零（运行边界 = 忘记上一局）；`destroy()` 必须显式拆掉 `camera`（它现在挂在 stage 上，`root.destroy()` 够不到它）。

### 4.4 管道与契约

- **管道恒为 17 段**（spec 00 §2 / spec 19 I9）。软碰撞是 `MovementSystem`（idx 5）内的**新相位**，不是新段——与 M7-T01 的 `integrateKinematic` / `resolveWalls` 落法一致：**同实体位移 / 物理相位挂 `MovementSystem` 尾部；只有「独立生命周期 + 独立事件源」才新增段**（`INVARIANTS.md` §2）。软碰撞两者皆无 ⇒ 必须是相位。
- **`MovementSystem` 四相位顺序**：`integrate → integrateKinematic → separateBodies → resolveWalls`。对既有的三相语义：`integrate` / `integrateKinematic` / `resolveWalls` **逐字不变**；`separateBodies` 是纯插入。
- **渲染契约**：`stage.children[0]` 由 `root` 变为 **`camera`**（且 `camera` 恒为唯一 stage 子节点）；`root` 恒为 `camera` 最后一个子节点；`fxLayer` 恒为 `root` 最后一个子节点；静态层恒为 `camera` 索引 0（仅「世界有墙」时存在）。因此三个 M5 冻结断言（`root.children[0]` = 首个实体视图、`root.children[last]` = `fxLayer`、`stage.children[0]` = 渲染根）中，前两条**零改动**，第三条的「渲染根」语义升级为「camera（其最后子节点为 root）」。

---

## 5. 验收标准

| ID | 验收标准 | 证据 |
|---|---|---|
| **AC-01** | 贪心合并：加载期把连续墙体合并为尽可能少的大 AABB，`resolveWalls` 从 `O(N_tile)` 降到 `O(N_rect)`；合并后几何并集与逐格**完全等价**（面积守恒：矩形面积之和 == `wallTileCount`）；解算行为对贴边/内部两类位置**逐位不变**；矩形顺序 = 左上角行主序 | G1 / G2（`tests/world/tilemap_and_topology.test.ts`）+ 变异实验① |
| **AC-02** | 软碰撞分离：`Transform` + `Velocity` + `Hurtbox` 且**同阵营**的存活动态实体若重叠，产生基于重叠深度的对称斥力位移；**纯数学确定性**；完全重合时用基于 `EntityId` 的确定性方向规则（无熵）；不同阵营不分离；尸体不参与；单实体世界零操作；不消费随机 | `tests/physics/soft_collision.test.ts` + 变异实验② |
| **AC-03** | 表现层摄像机：`client/` 维持一个 `camera` 概念，墙体/角色/特效全部挂其下；每帧 Lerp 趋近「屏幕中心 − 玩家渲染坐标」使玩家居中；跳字跟随世界坐标；静态 HUD 固定屏幕；假 `Application` 无 `screen` 时降级为 `0` 且不抛错；`reset()` 归零 | `tests/render/camera_follow.test.ts` + 四个既有渲染套件同步 + 变异实验③ |
| **AC-04** | 管道不变：恒为 17 段、顺序不变；`MovementSystem` 三相语义逐字不变 | `tests/world/tilemap_and_topology.test.ts` G4 / 九个钉桩套件 |
| **AC-05** | 零回归：无拓扑 / 无墙 / 不同阵营 / 单实体场景行为与 M12-T01 逐位一致 | 既有 500 用例全绿 |

---

## 6. 测试契约

### 6.1 `tests/world/tilemap_and_topology.test.ts`（同步既有断言）

| 位置 | 变更 |
|---|---|
| 文件头注释 | 「一格一墙」措辞改为「合并后的矩形」 |
| G1 首个用例 | 用例名/注释改为「合并后矩形数」；`result.wallCount` `8 → 4`；`wallIds(sim)` 长度 `8 → 4`；`entityCount` `8 → 4`；`boxes` 改为 4 个矩形字面量；**新增** `result.wallTileCount === 8` |
| G1「tolerates a room with no player」 | `result.wallCount` `12 → 4`（并断言 `wallTileCount === 12`） |
| G2 首个用例 | `oldWalls` 长度 `11 → 4`；新房间 `wallIds(sim)` 长度 `12 → 4` |
| G2「restartRun rebuilds room 0」 | `wallIds(sim)` 长度 `11 → 4` |
| G1 物理断言（贴面停住 / 坐标不变 / 无撞墙伤害） | **不变**，继续通过 —— 这是 AC-01「行为等价」的证据 |
| G5 | 整段重写（§6.2） |

### 6.2 `tests/world/tilemap_and_topology.test.ts` G5（重写）

- 无墙：`stage.children` 长度 1（= camera）；`camera.children` 长度 1（= root）；`renderer.viewCount === 1`；`root.children` 长度 2（玩家视图 + fxLayer）。
- 有墙：`renderer.wallViewCount` `8 → 4`；`result.wallCount` `8 → 4`；`camera.children` 长度 2 且 `camera.children[1] === root`、`camera.children[0] !== root`；`PX_PER_UNIT === 10` 保留。
- 拆房后：`wallViewCount === 0`；`camera.children` 长度 1；`camera.children[0] === root`。

### 6.3 渲染套件的 `renderRoot` 助手（同步）

`tests/render/renderer_bridge.test.ts`、`tests/render/interpolation.test.ts`、`tests/render/juice-verify.test.ts` 的 `renderRoot` / `rootOf` 助手改为「穿透 camera 取最后一个子节点」。

### 6.4 `tests/physics/soft_collision.test.ts`（新增）

真实 `GameSimulator` + `createDefaultSystems()`，不 mock：

1. **核心 AC**：两个 `raider` 生成在完全相同的 `(0,0)`，注入 0 输入，`step(n)` 后两者坐标**不再相等**，且间距 ≈ `2 * hurtboxRadius`（相切即稳定，不会每拍抖动）。用 `toBeCloseTo(..., 9)`。
2. **确定性**：同种子重跑两次，逐拍快照 `toEqual`；且「重合分离方向」对同一对 id 恒相同。
3. **同阵营才分离**：一个玩家 + 一个敌人放在同一点 ⇒ **都不动**（对抗性证据：若实现退化成「全体分离」必失败）。
4. **不分离即不位移**：两个同阵营敌人相距 > 半径和 ⇒ 坐标逐位不变。
5. **不消费随机**：分离运行后，`sim.world.rng.nextUint32()` == `new Random(SEED).nextUint32()`（观察生成器下一个值）。
6. **尸体不参与**：`isDead` 的尸体与活体同点不产生分离。
7. **单实体世界**：只有一个玩家 ⇒ 零位移。
8. **`separationAngle` 纯函数单测**：纯函数性、值域 `[0, 2π)`、不同 id 对分布 > 1 个槽、`Number.isNaN` 为 false。

### 6.5 `tests/render/camera_follow.test.ts`（新增）

真实 `GameSimulator` + 真实 `GameRenderer` + 鸭子类型 `Application`（`{ stage: new Container(), ticker: { deltaMS: 20, add(){}, remove(){} } }`）：

1. 场景图：`stage.children[0]` 是 camera（唯一子节点），`camera.children[last]` 是 root，`root.children[last]` 是 fxLayer。
2. **Lerp 存在性**：第一帧 `camera.x` ≠ 精确居中值（证明是插值而非硬切）；连续 `syncWorld` N 帧（≥40）后收敛到 `screenWidth/2 - playerPxX`（假 app 无 screen ⇒ 目标即 `-playerPxX`），`toBeCloseTo(..., 6)`。
3. **跟随**：把玩家 `Transform.x` 改到另一处再同步若干帧，`camera.x` 朝新目标收敛。
4. 墙体 / 实体视图坐标不受相机影响（视图 `x/y` 仍是世界像素；只有 camera 被平移）。
5. 无玩家视图时 `syncWorld` 不抛错且 `camera.x/y` 不变。
6. 跳字跟随世界坐标：`fxLayer.parent === root`，且 `fxLayer` 不在 stage 直挂。

**测试纪律**（沿用仓库既有约定）：真实 `GameSimulator` + 真实 `createDefaultSystems()`，不 mock；`step(1)` 逐 Tick 钉时序；浮点容差 `1e-9`；断言值一律写成**字面量**；「不消费随机」必须观察生成器下一个值。

---

## 7. 已知取舍（Known Trade-offs）

| ID | 取舍 | 后果 / 缓解 |
|---|---|---|
| **T1** | **合并后「墙数 ≠ 瓦片数」是语义变更** | spec 19 I2 的「一格一墙」等式不再成立。缓解：`RoomLoadResult` 同时暴露 `wallCount`（矩形数）与 `wallTileCount`（瓦片数），把「合并正确」与「合并过头」都变成可断言的等式（面积守恒） |
| **T2** | **软碰撞只作用于同阵营 ⇒ 玩家穿敌人仍可能发生** | 这是刻意的（§4.2）：跨阵营分离会打散 `status_effects` / `walls_and_projectiles` 的既有夹具。玩家与敌人重叠仍读作「贴在一起」，但不会把敌人挤开。若未来需要，正确做法是给碰撞层一个「可分离阵营掩码」，而不是无条件全体分离 |
| **T3** | **相机 Lerp 带来恒定滞后** | `CAMERA_LERP_FACTOR = 0.2` 意味着一阶滞后：玩家高速移动时相机永远落后一段固定距离。这是「跟随」与「硬锁」之间的取舍——硬锁（`camera = target`）会让画面抖动且无速度感。缓解：常数可调；不做预测 / 死区是刻意留白（避免新增失败面） |
| **T4** | **假 `Application` 无 `renderer` / `screen` 的降级路径** | `screenWidth()/screenHeight()` 缺失时返回 `0`，相机把玩家居中到屏幕原点。这是为了让既有渲染测试（只有 `{ stage, ticker }`）**零改动**地继续运行；代价是测试里 `camera` 的目标值不是真实屏幕中心，而是 `-playerPx`。缓解：新增的 `camera_follow.test.ts` 显式钉桩这一降级语义 |
| **T5** | **合并是行主序贪心，非最优解** | 贪心合并不保证**最少**矩形（那是矩形覆盖的 NP-hard 变体）。它保证的是「确定性 + 几何等价 + 常见地形下足够少」。真实房间（矩形边框）下贪心接近最优 |
| **T6** | **分离不处理「三方以上完全重合」的连锁** | 两两循环是单遍的：三个完全重合的实体，A-B 分离、A-C 分离、B-C 分离依次执行，结果依赖 id 顺序（确定），但**不保证**一步到位两两相切。缓解：下一帧继续收敛；确定性由 id 升序保证。这是「单遍有限遍历」（与 `resolveWalls` 同一纪律）的代价 |
| **T7** | **分离相位不设冻结 / 硬直门** | 与 `resolveWalls` 同论据：分离与墙解算同属**几何不变量**，不是动作（`INVARIANTS.md` M7）。quality-lead 用三类探针（`applyFreeze` 的冻结体 / 真实近战碰撞打出的 `HITSTUN` 体 / 直接写 `HITSTUN` 且无击退的隔离体）确认：三者**都仍会被同阵营伙伴推开**，且多拍后收敛到相切、不再抖动。⚠️ **登记一处不对称**：`resolveWalls` 下冻结体不可能「新穿透」（冻结相位已保证 `integrate` 不位移），而分离**能**推动一个冻结体。判定为可接受 —— hitstop 的语义是「不响应输入与积分」，不是「不可被几何修正」 |

---

## 8. 失败模式（Failure Modes）

| ID | 失败模式 | 为何不会发生 / 如何被捕获 |
|---|---|---|
| **F1** | 合并产出**重叠**矩形 ⇒ 面积守恒失败、同一墙推两次 | `visited` 标记覆盖整个已产出矩形（含纵向扩展区）；测试断言 `boxes` 逐字面量 + `wallTileCount` |
| **F2** | 合并**漏格** ⇒ 某格墙消失 ⇒ 身体穿墙 | 纵向扩展要求「整行 `[col, col+w)` 都是未访问 `1` 格」；`mergeWallRects` 覆盖所有 `1` 格（每格要么作为某矩形左上角、要么被某矩形标记）；面积守恒 + 物理断言（贴面停住）捕获 |
| **F3** | 分离把身体推进墙里 | 相位顺序 `separateBodies → resolveWalls`（I9）；墙解算是最终裁决 |
| **F4** | 分离每拍抖动（重叠未一次修完） | 位移不乘 `dt`（I8）；完全重合一步推到相切；测试断言「相切即稳定」（`step(n)` 后间距恒为 `2r`） |
| **F5** | 分离消费随机 ⇒ 破坏全局单流 PRNG | 分离只读 `EntityId` 派生的纯函数方向（I6）；测试断言生成器下一个值不变 |
| **F6** | 完全重合时除零 ⇒ `NaN` 坐标 | `distSq === 0` 分支走 `separationAngle`（纯整数 → 角度），永不除零；`separationAngle` 单测断言永不 `NaN` |
| **F7** | 相机在假 `Application` 下读 `app.renderer.*` ⇒ 测试抛错 | `screenWidth()/screenHeight()` 只读 `app.screen`，缺失降级为 `0`（I12）；测试显式钉桩 |
| **F8** | 相机破坏 M5 场景图契约 | `root` 恒为 camera 最后子节点、`fxLayer` 恒为 root 最后子节点（I13）；`renderRoot` 助手与 G5 同步断言 |
| **F9** | 分离让不同阵营夹具坐标漂移（回归） | 只同阵营（I5）；既有 500 用例全绿是证据 |
| **F10** | `syncWorld(world, NaN)` 让 `camera.x/y` 也变 `NaN`（**第二条 NaN 通路**） | 与 M5 已登记的「视图坐标变 NaN ⇒ 实体静默消失」**同源**：`syncTransforms` 先把 `NaN` 写进 `view.container.x`，`syncCamera` 的 `target = screenWidth/2 − NaN = NaN` 再传染给相机。`±Infinity` 仍被 clamp 正常处理，**只有 `NaN` 穿透**。当前调用链不可达（`GameLoop` 的 `alpha` 恒为有限值）⇒ 与 M5 同名项同一处置：**登记、不修**（入口加 `Number.isFinite` 防御属后续可选项） |

---

## 9. 追溯表（Traceability）

| 需求 | 不变量 | 语义 | 验收 | 测试 |
|---|---|---|---|---|
| 贪心合并 | I1 I2 I3 I4 | §3.1 §3.2 §4.1 | AC-01 | `tilemap_and_topology` G1/G2 + 变异① |
| 软碰撞分离 | I5 I6 I7 I8 I9 I10 | §3.3 §4.2 | AC-02 | `soft_collision` 全组 + 变异② |
| 表现层摄像机 | I11 I12 I13 I14 | §3.4 §4.3 | AC-03 | `camera_follow` 全组 + 四套件同步 + 变异③ |
| 管道不变 | （spec 00 §2） | §4.4 | AC-04 | `tilemap_and_topology` G4 + 九钉桩套件 |
| 零回归 | （spec 19 I10） | §4.2 §4.3 | AC-05 | 既有 500 用例 |

---

## 10. 参考

- `specs/19_room_topology_and_tilemaps_spec.md` §1.3 / §4.1 / §4.4 / §4.5 / §8（网格契约、清理集、静态几何渲染、R3/R5）
- `specs/13_arena_and_projectiles_spec.md` §3.1 / §3.2 / §4.1（`resolveCircleAABB`、`WallComponent`、静态几何解算顺序）
- `specs/09_renderer_bridge_spec.md` §3.2 / §4.3 / §4.4（`stage` / `root` / `fxLayer` 子节点契约）
- `specs/10_render_juice_spec.md` §4（插值、跳字、`fxLayer` 冻结契约）
- `specs/00_harness_spec.md` §6（ECS / 零隐藏状态 / 确定性）
- `docs/architecture/ADR-001-headless-ecs-foundation.md`（R1 无 DOM、R2 无随机/墙钟）
- `docs/architecture/ADR-002-render-interpolation.md`（渲染插值）
- `docs/architecture/ADR-004-deterministic-prng.md`（单流 PRNG、整数确定性）
- `.workbuddy-ai/memory/INVARIANTS.md` §2（「同实体位移/物理相位挂 `MovementSystem` 尾部」）
