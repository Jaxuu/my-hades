# Contract · 缩放适配与退化（Zoom Fit & Degradation）

**Feature**: `025-camera-zoom-viewport` · **Version**: 1.0.0 · **Date**: 2026-10-02

本契约定义缩放因子 `z` 的**计算**与**退化**语义。它是 FR-002 / FR-003 / FR-005 / FR-010 / FR-011 / FR-014 / FR-020 / FR-021 的机器可执行形式。

---

## 1. 输入（全部只读）

| 输入 | 来源 | 用途 |
|---|---|---|
| `viewportW` / `viewportH` | `app.screen`（守卫读取，CSS 像素） | 适配目标尺寸 |
| `roomMinX/Y`、`roomMaxX/Y` | `WallComponent` 的 AABB 并集（世界单位） | 房间范围 |
| `isInHub(world)` | `GameStateComponent`（只读） | 营地退化（FR-021） |

## 2. 计算（纯函数）

```
roomPxW = (roomMaxX − roomMinX) × PX_PER_UNIT
roomPxH = (roomMaxY − roomMinY) × PX_PER_UNIT
fitZoom = min(viewportW / roomPxW, viewportH / roomPxH)
z       = clamp(fitZoom × ZOOM_FIT_MARGIN, ZOOM_MIN, ZOOM_MAX)
```

**常量（冻结）**：`ZOOM_FIT_MARGIN = 0.8` · `ZOOM_MIN = 1.0` · `ZOOM_MAX = 16.0`（理由见 research.md D1）。

**输出**：`z` 施加在 `cameraContainer.scale`（见 `camera-view-transform.md`）。

## 3. 退化谓词与取景模式判定

```
hasViewport   = viewportW > 0 ∧ viewportH > 0 ∧ Number.isFinite(viewportW) ∧ Number.isFinite(viewportH)
hasRoomExtent = roomPxW > 0 ∧ roomPxH > 0 ∧ ¬isInHub(world)
zoomActive    = hasViewport ∧ hasRoomExtent
```

`zoomActive === false` ⇒ `z = 1`、不钳制、跟随目标 = 旧公式，逐位等价改动前行为。

**取景模式判定（`roomFits`；缩放激活时生效）**：

```
roomFits = roomPxW × z ≤ viewportW  ∧  roomPxH × z ≤ viewportH
```

- `roomFits === true` ⇒ **房间模式**：房间居中于视口且**静止**（`target` 与玩家位置无关）：
  `target = (viewportW/2 − roomCenterPxX × z, viewportH/2 − roomCenterPxY × z)`
- `roomFits === false` ⇒ **跟随模式**：保留「以玩家为中心」跟随并钳制在房间边界内：
  `target = clamp(viewport/2 − playerPx × z, bounds)`

模式判定 MUST **只**由 `roomFits` 决定，MUST NOT 依赖玩家位置或任何其它状态（FR-004）。

**为何跟随模式是防御性分支**：`z = clamp(fitZoom × 0.8, 1, 16)` 且 `fitZoom × 0.8 < fitZoom` ⇒ 除 `z` 被下限 `1` 夹住（`fitZoom < 1.25`，即约 86 世界单位以上的房间或极端小视口）外 `roomFits` 恒为真。现有三个房间（10×10 / 12×10 / 30×30）在全部目标视口下都走房间模式。

## 4. 承诺（MUST）

1. **受限方向**：MUST 用 `min(viewportW/roomPxW, viewportH/roomPxH)`（保证房间完整可见）；MUST NOT 用 `max` 或单一「短边」（会溢出）。
2. **夹取**：`z` MUST 满足 `ZOOM_MIN ≤ z ≤ ZOOM_MAX`（FR-003）。
3. **等比**：`z` 同时作用于两轴（FR-005）。
4. **纯函数**：`z` MUST 是 `(房间范围, 视口)` 的纯函数，MUST NOT 依赖随机 / 墙钟 / 历史（FR-020）。
5. **每帧重算**：`z` MUST 在每帧 `syncCamera` 之前重算（`resizeTo: window` 已让视口变化可见）⇒ FR-010 无需事件即可生效。
6. **只读视口**：读取视口 MUST 只碰 `app.screen`，MUST NOT 碰 `app.renderer.*`。
7. **有限性**：退化输入下 `z` MUST 为 `1`，MUST NOT 产生 `NaN` / `Infinity` / 除零。
8. **退化不抛错**：`zoomActive === false` 时 MUST NOT 抛错、MUST NOT 阻塞渲染（FR-014 / FR-021）。
9. **不复用房间尺寸硬编码**：`z` MUST NOT 依赖针对某个房间尺寸的常数（FR-002）—— 常量只有 `ZOOM_FIT_MARGIN/MIN/MAX`，与房间尺寸无关。
10. **取景模式判定**：`roomFits` MUST 只由 `(房间范围, 视口, z)` 决定，MUST NOT 读玩家位置或任何其它状态（FR-004）。
11. **房间模式静止**：`roomFits === true` 时相机平移 `target` MUST 与玩家位置无关 ⇒ 房间在屏幕上**居中且静止**；玩家位移直接体现为屏幕位移（US1 AS3）。
12. **跟随模式钳制**：`roomFits === false` 时相机 MUST 以玩家为中心跟随并**钳制在房间边界内**（房间之外不进入视口）。

## 5. 违例判定

| 场景 | 期望 |
|---|---|
| 1920×1080 + `start_room`(10×10) | `z ≈ 8.64`；房间短边 864 px；`864/1080 = 80%` ∈ [55%, 85%]（SC-001） |
| 2560×1440 + `start_room` | `z ≈ 11.52`；房间短边占比 80%（SC-002） |
| 1920×1080 + `stress_room`(30×30) | `z ≈ 2.88`；房间短边占比 80%（不缩到不可辨认） |
| 3840×2160 + `start_room` | `z = 16`（上限夹取）；房间短边占比 74.1%（仍 > 55%） |
| 800×600 + `start_room` | `z = 4.8`；房间短边占比 80%（SC-005 小视口端） |
| 假想 3×3 房间 + 1920×1080 | `z = 16`（上限夹取）；单格 ≤ 160 px（不「占满整屏」） |
| 1920×1080 + 有墙房间（10×10 / 12×10 / 30×30） | `roomFits === true` ⇒ **房间模式**；`target` = 房间中心，与玩家位置无关（房间居中静止） |
| 假想 > 86 世界单位房间（`fitZoom < 1.25` ⇒ `z = 1`） | `roomFits === false` ⇒ **跟随模式**（以玩家为中心 + 钳制在房间边界内） |
| 玩家在房间内任意位置（房间模式） | 相机 `target` 恒为房间中心，不随玩家漂移 |
| 无墙世界（或营地） | `zoomActive === false` ⇒ `z === 1`、不钳制、不抛错 |
| 无 `screen` 替身 | `hasViewport === false` ⇒ `z === 1`、逐位等价旧行为 |
| 视口 = `NaN` / `Infinity` / `0` / 负 | `hasViewport === false` ⇒ `z === 1`，无 `NaN` 传播 |
| 极端宽高比（32:9 / 9:16） | 以受限方向 fit；房间完整可见（SC-008） |
| 同输入两次调用 | `z` 逐位相同（FR-020） |

## 6. 已知限制

- **L1 · 非方房间的「短边占比」不保证**：`min` 保证的是「房间完整可见」，不保证「房间短边占视口短边 ≥ 55%」对**任意**宽高比成立（该比例只在「房间宽高比与视口宽高比接近」时 ≈ `ZOOM_FIT_MARGIN`）。SC-001 只针对 10×10 房间，故满足；极端长条房间不在验收范围。
- **L2 · 上限 `16` 是观感常量**：真实房间不会触及；它只在假想极小房间下生效（research.md D1 / 未决事项 4）。
- **L3 · 下限 `1` 使极大房间不缩小**：房间大于视口时（`roomFits === false`）由**跟随模式**接管（以玩家为中心跟随并钳制在边界内，房间外的空白不进入视口）；实体不小于改动前尺寸。
