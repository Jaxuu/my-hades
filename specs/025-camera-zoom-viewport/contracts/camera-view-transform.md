# Contract · 相机视图变换（Camera View Transform）

**Feature**: `025-camera-zoom-viewport` · **Version**: 1.0.0 · **Date**: 2026-10-02

本契约定义相机节点的**视图变换语义**：世界空间内容如何在屏幕上被平移与缩放，取景模式与目标如何计算，以及退化路径如何**逐位**等价改动前行为。它是 FR-001 / FR-004 / FR-005 / FR-019 的机器可执行形式。

---

## 1. 变换模型（唯一真相）

相机是**唯一**承载视图变换的节点（I11 其余语义不变）；世界空间内容（E5）的节点仍持有**世界像素**坐标，其局部 `x/y` **永不**被缩放改写。

```
screen(child) = camera.pos + child.localPos × camera.scale
```

- `camera.pos` = `cameraContainer.x/y`，单位**屏幕（CSS）像素**。
- `camera.scale` = `cameraContainer.scale`，`x === y === z`（等比）。
- `child.localPos` = 实体 / 墙 / 特效 / 跳字节点自身的 `x/y`，单位**世界像素**（= 世界单位 × `PX_PER_UNIT`）。

**推论（写死为契约）**：
- 缩放 MUST 施加在**世界空间的公共父节点** `cameraContainer.scale`，MUST NOT 施加在实体 / 墙 / `root` / `staticLayer` 节点自身的 scale 上。
- 实体 / 墙视图的**局部** `x/y` MUST 保持 `world × PX_PER_UNIT`（不受 `z` 影响）—— 这是既有 `camera_follow` / `tilemap_art` 断言的直接依据。

## 2. 取景模式与目标（`syncCamera`）

取景模式 MUST **只**由「房间能否被完整容纳」决定（`roomFits`），MUST NOT 依赖玩家位置或任何其它状态：

```
roomFits = roomPxW × z ≤ screenW  ∧  roomPxH × z ≤ screenH
```

**房间模式（`roomFits === true`；全部现有房间的默认）** —— 房间居中于视口且**静止**，不随玩家漂移：

```
targetX = screenW/2 − roomCenterPxX × z        // roomCenterPxX = (roomMinX + roomMaxX)/2 × PX_PER_UNIT
targetY = screenH/2 − roomCenterPxY × z
```

**跟随模式（`roomFits === false`；防御性分支）** —— 保留既有「以玩家为中心」跟随并钳制在房间边界内：

```
desiredX = screenW/2 − playerView.x × z        // playerView.x 是插值后的世界像素
desiredY = screenH/2 − playerView.y × z
targetX  = clamp(desiredX, bounds.minX, bounds.maxX)
targetY  = clamp(desiredY, bounds.minY, bounds.maxY)
```

两种模式共用同一施加步骤：

```
camera.x += (targetX − camera.x) × CAMERA_LERP_FACTOR
camera.y += (targetY − camera.y) × CAMERA_LERP_FACTOR
camera.x += shakeOffsetX ; camera.y += shakeOffsetY   // 屏幕像素，与 z 无关
```

**顺序是契约**：① 由 `roomFits` 选模式；② 按模式算 `target`；③ 一阶 lerp；④ 叠加震动。`bounds` 只在跟随模式使用（退化时不进入任何模式）。

## 3. 承诺（MUST）

1. **等比**：`cameraContainer.scale.x === cameraContainer.scale.y`（FR-005）。
2. **单一变换节点**：只有 `cameraContainer` 的 `x/y/scale` 是世界视图变换；实体 / 墙 / 特效 / 跳字节点的局部坐标与局部 scale MUST NOT 因缩放而改变（I11 其余语义）。
3. **取景以模式为准**：房间模式 MUST 使房间中心居中且 `target` 与玩家位置无关（房间静止）；跟随模式 MUST 由玩家**插值后**的渲染坐标派生（ADR-002）并钳制在房间边界内。模式判定 MUST 只由 `roomFits` 决定，MUST NOT 读玩家位置。
4. **先定 target 后 lerp**：模式选择与 `target` 计算 MUST 在 lerp **之前**完成，MUST NOT 在 lerp 之后修正（避免触界 / 模式切换时硬拽 → 跳变）。
5. **无玩家视图即不动**：无存活玩家视图时 `syncCamera` MUST NOT 改变 `camera.x/y`，且 MUST NOT 抛错。
6. **退化逐位等价**：`zoomActive === false` 时 `z === 1`、不钳制、`target = screen/2 − playerView`，MUST 与改动前的公式**逐位相同**（`x × 1 === x`）。这是既有收敛断言零改动的**机制枢纽**。
7. **震动正交**：震动是 `camera.x/y` 上的屏幕像素偏移，MUST NOT 影响 `z`，MUST NOT 被 `z` 缩放；`z` MUST NOT 读取震动状态（FR-019）。
8. **reset 复位**：`reset()` MUST 把 `cameraContainer.scale` 复位为 `1`（连同既有 `x/y = 0`）。
9. **确定性**：给定相同的玩家坐标、房间范围与视口，MUST 得到相同的 `camera.x/y/scale` 演化；MUST NOT 依赖墙钟（FR-020）。

## 4. 违例判定

| 场景 | 期望 |
|---|---|
| 无 `screen` 替身 + 有玩家，同步 ≥120 帧 | `camera.x ≈ screen/2 − playerPx`（`z = 1`），既有断言**不改一行**成立 |
| 带 `screen`(800×600) 替身 + **无墙** + 玩家 (1.5,1.5) | `camera.x ≈ 385`、`camera.y ≈ 285`（`z = 1`，退化路径） |
| 有墙 + 无 `screen` 替身，同步 ≥120 帧 | `camera.x ≠ 0`（仍被玩家平移），墙块 `x === wall.x × PX_PER_UNIT` |
| 玩家视图 `isDying` 或无玩家视图 | `syncCamera` 不移动相机、不抛错 |
| 设置 `cameraContainer.x = 42` 后同步空世界 | `camera.x === 42`（不变） |
| 实体视图 `x/y` 在缩放激活下 | 仍 `=== world × PX_PER_UNIT`（局部坐标不随 `z` 变） |
| 1920×1080 + 有墙房间（10×10）+ 带 `screen` 替身 | `roomFits === true` ⇒ 房间模式；`camera.x/y` 收敛到**房间中心**取景，**与玩家位置无关**（玩家移动不改变收敛目标 ⇒ 房间静止） |
| 假想 > 86 世界单位房间（`z = 1` ⇒ `roomFits === false`）+ 带 `screen` 替身 | 跟随模式；`target = clamp(screen/2 − playerPx×z, bounds)`，房间之外不进入视口 |
| `reset()` 后 | `camera.x === 0 ∧ camera.y === 0 ∧ camera.scale.x === 1` |

## 5. 已知限制

- **L1 · 跟随滞后**：`CAMERA_LERP_FACTOR = 0.2` 的一阶滞后语义**不变**（spec 20 T3 已登记）。
- **L2 · 房间模式使相机静止**：房间可容纳时相机以**房间中心**为取景中心静止（不随玩家漂移），玩家位移直接体现为屏幕位移；跟随模式（房间大于视口）才把相机钳制在房间边界内。这是 FR-004「房间居中且静止」的直接结果（research.md D3）。
- **L3 · NaN alpha 通路**：既有 `syncWorld(world, NaN)` 会让 `camera.x/y` 变 `NaN`（INVARIANTS M12-T02 已登记的第二条 NaN 通路）。本契约**不新增**该通路，也**不修复**它（当前调用链不可达，超出本特性范围）。
