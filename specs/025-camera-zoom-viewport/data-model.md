# Phase 1 · Data Model：相机缩放与视口自适应（M17）

**Feature**: `025-camera-zoom-viewport` · **Date**: 2026-10-02 · **Source**: [spec.md](./spec.md) 的 5 个关键实体

本模型描述**表现层**的数据结构。全部类型都是**表现层私有**（定义 / 消费在 `client/GameRenderer.ts`），**不进入 `src/`**，不进 `snapshot()`，不影响确定性。除「相机缩放因子」与「相机视图状态」是 `GameRenderer` 上的**纯表现层字段**外，其余实体都是对既有 `World` 的**只读投影**，不新增任何数据。

---

## E1 · 视口 `Viewport`（规格中的「视口」）

缩放适配的输入之一；随窗口尺寸与分辨率变化。**不是新数据** —— 它是 `app.screen` 的守卫式读取结果。

| 字段 | 类型 | 来源（只读） | 说明 |
|---|---|---|---|
| `width` | `number` | `app.screen.width`（守卫） | CSS 像素；缺失 / 非有限 ⇒ `0` |
| `height` | `number` | `app.screen.height`（守卫） | CSS 像素；缺失 / 非有限 ⇒ `0` |
| `readable` | `boolean` | 派生 | `width > 0 ∧ height > 0 ∧ 二者有限` |

**校验规则**
- 读取 MUST 只碰 `app.screen`，**绝不**碰 `app.renderer.*`（既有 `camera_adversarial` 的抛错 getter 是这条约束的机器守卫）。
- 尺寸缺失 / 非有限 / 非正 MUST 归零（`readable === false`），**MUST NOT** 产生 `NaN` / 除零 / 无穷。
- 读取 MUST 每帧发生（`resizeTo: window` 让 `app.screen` 自动更新）⇒ 视口变化无需事件即可生效（FR-010）。

**状态迁移**：无（每帧纯读取，无记忆）。

---

## E2 · 相机缩放因子 `CameraZoom`（规格中的「相机缩放因子」）

作用于世界空间的**统一**缩放倍率。关键属性为「取值」「上下限夹取」「重算时机」。

| 字段 | 类型 | 说明 |
|---|---|---|
| `value` | `number` | 当前倍率 `z`，恒满足 `ZOOM_MIN ≤ z ≤ ZOOM_MAX` |
| `active` | `boolean` | 是否处于「缩放激活」态；`false` ⇒ `value === 1` 且不钳制 |
| `bounds` | `{ minX, minY, maxX, maxY } \| null` | 由房间范围 × `z` 推出的相机平移可行区间；`active === false` ⇒ `null` |

**取值公式（纯函数）**

```
z = clamp( min(viewportW / roomPxW, viewportH / roomPxH) × ZOOM_FIT_MARGIN, ZOOM_MIN, ZOOM_MAX )
```

常量：`ZOOM_FIT_MARGIN = 0.8` · `ZOOM_MIN = 1.0` · `ZOOM_MAX = 16.0`（理由见 research.md D1）。

**校验规则**
- `z` MUST 有限、`> 0`；输入退化时 `z = 1`（恒等），**MUST NOT** 产生 `NaN` / `Infinity`。
- `z` MUST 是 `(房间范围, 视口)` 的**纯函数**：无随机源、无墙钟（FR-020）。给定相同输入恒得相同 `z`。
- 横纵 MUST 同倍率（等比，FR-005）：`cameraContainer.scale.x === cameraContainer.scale.y === z`。
- `z` MUST 被夹取在 `[ZOOM_MIN, ZOOM_MAX]`（FR-003）。

**状态迁移（每帧）**
```
computeZ(roomExtent, viewport) ──▶ z（若 zoomActive）  |  1（否则）
```
无历史依赖 ⇒ 相同输入恒得相同输出，不累积、不漂移。

---

## E3 · 房间范围 `RoomExtent`（规格中的「房间范围」）

当前房间的世界空间包围盒；缩放适配的另一输入。**不是新数据** —— 它是既有 `WallComponent` 的只读派生，且渲染层**已经**为地板铺贴计算过它。

| 字段 | 类型 | 来源（只读） | 说明 |
|---|---|---|---|
| `minX` / `minY` | `number` | `min` over `wall.x` / `wall.y` | 世界单位 |
| `maxX` / `maxY` | `number` | `max` over `wall.x + wall.width` / `wall.y + wall.height` | 世界单位 |
| `pxW` / `pxH` | `number` | `(maxX − minX) × PX_PER_UNIT` 等 | 世界像素（供 E2 使用） |
| `determinable` | `boolean` | 派生 | `query(WallComponent).length > 0 ∧ ¬isInHub(world)` |

**校验规则**
- MUST 只读 `WallComponent`，**MUST NOT** 写 `World`（不 `addComponent` / 不 `destroyEntity` / 不推进模拟）。
- MUST **复用** `syncStaticGeometry` 每帧已算出的墙包围盒（避免第二次 `World.query`，见 research.md D10）。
- `determinable === false` ⇒ E2 退化 `z = 1`、不钳制（FR-021），**MUST NOT** 抛错 / 阻塞渲染。
- `pxW` / `pxH` MUST `> 0` 才参与 `fitZoom`；否则视为不可确定（防止除零）。
- 房间范围在**同一房间内恒定**（墙静态且不可破坏，spec 19 I3）⇒ `z` 在房间内恒定，只在房间边界或视口变化时改变。

**状态迁移**
```
无墙 / 营地 ──▶ determinable = false（z = 1）
有墙且非营地 ──▶ determinable = true（z 按公式）
```

---

## E4 · 相机取景状态 `CameraViewState`（规格中的「相机取景状态」）

取景分**两种且仅两种模式**，由「房间能否被完整容纳」（`roomFits`）唯一决定；两种模式都叠加缩放，**不改变跟随的收敛语义**（仍是一阶 lerp、`CAMERA_LERP_FACTOR = 0.2`）。

| 字段 | 类型 | 来源（只读 / 表现层私有） | 说明 |
|---|---|---|---|
| `position` | `{ x, y }` | `cameraContainer.x/y` | **屏幕像素**平移；含震动偏移 |
| `scale` | `number` | `cameraContainer.scale` | `= z`（E2），施加在世界空间公共父节点 |
| `mode` | `'room' \| 'follow'` | 派生自 `roomFits`（仅 `E2.active` 时） | **房间模式**（`roomFits === true`：房间可容纳，房间居中且静止）/ **跟随模式**（`roomFits === false`：房间大于视口，玩家居中 + 边界钳制）；退化时不进入任何模式 |
| `target` | `{ x, y }` | 派生 | 房间模式：`screen/2 − roomCenterPx × z`（**与玩家位置无关**）；跟随模式：`clamp(screen/2 − playerPx × z, E2.bounds)`；退化：旧公式 `screen/2 − playerPx` |

**校验规则**
- `mode` MUST 只由 `roomFits` 决定，MUST NOT 依赖玩家位置或任何其它状态（FR-004）。
- 房间模式的目标 MUST 以房间中心（`roomCenterPx`）为基准、**不含**玩家位置 ⇒ 房间居中且静止；玩家位移直接体现为屏幕位移。
- 跟随模式的目标 MUST 以玩家**插值后**的渲染坐标为基准（`playerView.container.x/y`，既有语义，ADR-002），并**先钳制、再 `lerp`**（顺序是契约，见 research.md D3）；钳制区间为空 / 不可用时不钳制。
- 无存活玩家视图 ⇒ **原地不动、不抛错**（既有语义，spec 20 §4.3）。
- `scale` MUST 与 E2 一致；`reset()` MUST 复位 `scale = 1`（运行边界「忘记上一局」）。
- 震动（`x/y` 的屏幕像素偏移）与缩放（`scale`）是**独立分量**，MUST NOT 互相改写（FR-019）。

**状态迁移**
```
每帧： mode   = roomFits ? 'room' : 'follow'   // 仅 E2.active 时
       target = (mode === 'room') ? (screen/2 − roomCenterPx×z)
                                   : clamp(screen/2 − playerPx×z, bounds)
       position += (target − position) × 0.2   // 一阶 lerp（既有）
       position += shakeOffset                 // 屏幕像素，独立
reset()： position = 0, scale = 1
```

---

## E5 · 世界空间 / 屏幕空间内容分类 `SpaceClass`（规格中的「世界空间内容 / 屏幕空间内容」）

本特性引入的**分类**（不是数据结构，而是一条**归属契约**）。它决定「谁随 `z` 缩放」。

| 归属 | 内容 | 承载节点 | 是否随 `z` |
|---|---|---|---|
| **世界空间** | 地板、墙体、玩家、敌人、投射物、危险预警、掉落物、命中特效、伤害跳字 | `cameraContainer` 子树（`staticLayer` / `root` / `fxLayer` / `particleLayer`） | ✅ 随 `cameraContainer.scale` |
| **屏幕空间** | 金币读数、生命 HUD、奖励三选一、死亡 / 胜利 / 营地覆盖层 | DOM（`#ui-layer` / `#hud` / `#gold`） | ❌ 不变（DOM 不在 Pixi 场景图内） |

**校验规则**
- 世界空间内容 MUST 全部位于 `cameraContainer` 子树内（否则不随缩放）。
- 屏幕空间内容 MUST NOT 迁入 `cameraContainer` 子树（否则随缩放 ⇒ 违反 FR-006/007，且新增常驻节点撞坏 F1–F6）。
- 分类 MUST 完备：每个可见元素恰属一类，无「两不管」或「两边都算」。

---

## 关系图

```
E1 Viewport ──┐
              ├──▶ E2 CameraZoom (z, active, bounds) ──▶ E4 CameraViewState.scale
E3 RoomExtent ┘                                          │
                                                         ▼
E4 CameraViewState.mode   = roomFits ? 'room' : 'follow'
E4 CameraViewState.target = room ? screen/2 − roomCenterPx×z
                                 : clamp(screen/2 − playerPx×z, bounds)
                                                         │
E5 SpaceClass ──(世界空间)──▶ cameraContainer 子树（随 z）
              ──(屏幕空间)──▶ DOM（不随 z）
```

依赖方向：`E1`/`E3`（只读输入）→ `E2`（纯函数）→ `E4`（应用）。`E5` 是横切归属契约，约束 `E2`/`E4` 的作用范围。

## 不变量

1. **表现层私有**：E1–E5 全部定义 / 消费在 `client/GameRenderer.ts`，`src/` 不 import 它们，也不感知「缩放」概念（I14）。
2. **只读**：E1/E3 的每个字段都来自对既有 API / 组件的读取；不存在任何从表现层写回 `World` 的路径（宪法 V）。
3. **不进快照**：本模型不进 `snapshot()`，不影响逐位确定性（宪法 II）。
4. **纯函数**：`E2.value` 是 `(E3, E1)` 的纯函数，无随机、无墙钟、无历史依赖（FR-020）。
5. **退化安全**：`E1.readable === false ∨ E3.determinable === false` ⇒ `E2.value === 1 ∧ E2.active === false ∧ E4.target === 旧公式`，逐位等价改动前行为，不抛错、不阻塞渲染（FR-014 / FR-021）。
6. **等比**：`E4.scale.x === E4.scale.y`（FR-005）。
7. **正交**：`E4.position`（含震动）与 `E4.scale` 是独立变换分量，互不改写（FR-019）。
8. **场景图不变**：本模型**不新增任何场景节点**；6 条冻结契约（F1–F6）逐条保持（FR-015）。
9. **既有断言不动**：E1 不可读时 `z === 1`，`E4.target` 与旧公式逐位相同 ⇒ 既有渲染断言无需修改（FR-017 / SC-006）。
10. **模式判定无玩家依赖**：`E4.mode` 只由 `roomFits`（房间范围 × `z` 与视口的关系）决定，MUST NOT 读玩家位置或任何其它状态（FR-004）；房间模式下 `E4.target` 与玩家位置无关 ⇒ 房间居中且静止。
