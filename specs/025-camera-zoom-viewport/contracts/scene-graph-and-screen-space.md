# Contract · 场景图与屏幕空间边界（Scene Graph & Screen-Space Boundary）

**Feature**: `025-camera-zoom-viewport` · **Version**: 1.0.0 · **Date**: 2026-10-02

本契约冻结**场景图结构**（6 条既有契约 F1–F6）与**世界空间 / 屏幕空间边界**（E5）。它是 FR-001 / FR-006 / FR-007 / FR-015 的机器可执行形式，也是「零回归」的结构性保障。

---

## 1. 场景图（冻结，与改动前逐条一致）

```
app.stage
 └─ camera (Container)                 // stage 唯一子节点（F1）；承载 translate + scale
     ├─ staticLayer (Container)        // 惰性：仅当世界有墙时存在，恒在 camera 索引 0
     │   ├─ floorNode (Container)      //   地板
     │   └─ wallNode[0..n]             //   一墙一节点（局部坐标 = 墙世界像素）
     ├─ particleLayer (Container)      // 惰性：仅有存活粒子时存在，插在 root 之前
     └─ root (Container)               // 恒为 camera 最后子节点（F2）
         ├─ view[0..n]                 //   实体视图（升序 id，首个在索引 0 —— F4）
         └─ fxLayer (Container)        //   恒为 root 最后子节点（F3）；装伤害跳字
```

**F1–F6（逐条冻结，MUST 保持）**：

| ID | 契约 | 本特性的处置 |
|---|---|---|
| **F1** | `stage.children` 长 **1** 且 `[0] === camera` | 缩放写在 `camera.scale`，不新增 stage 子节点 ⇒ 保持 |
| **F2** | `camera.children[last] === root` | 不新增 camera 子节点 ⇒ 保持 |
| **F3** | `root.children[last] === fxLayer` | root 子树不动 ⇒ 保持 |
| **F4** | `root.children[0]` = 首个实体视图 | `createMissingViews` 不动 ⇒ 保持 |
| **F5** | 无墙时 `camera.children` 长**恰 1** | 静态层仍「仅在有墙时惰性挂载」；缩放不新增节点 ⇒ 保持 |
| **F6** | 空闲时 `fxLayer.children` 长**恰 0** | 跳字生命周期不动 ⇒ 保持 |

## 2. 世界空间 / 屏幕空间边界（E5）

| 归属 | 内容 | 承载节点 | 随 `z` |
|---|---|---|---|
| **世界空间** | 地板、墙体、玩家、敌人、投射物、危险预警、掉落物、命中特效、伤害跳字 | `cameraContainer` 子树 | ✅ |
| **屏幕空间** | 金币读数、生命 HUD、奖励三选一、死亡 / 胜利 / 营地覆盖层 | DOM（`#ui-layer` / `#hud` / `#gold`） | ❌ |

## 3. 承诺（MUST）

1. **不新增常驻节点**：本特性 MUST NOT 向 `stage` / `camera` / `root` / `fxLayer` 添加任何新的**常驻**子节点（F1–F6 的推论）。缩放 MUST 通过既有 `cameraContainer.scale` 实现。
2. **不改变既有惰性挂载点**：静态层（`camera` 索引 0，仅在有墙时存在）与粒子层（`camera` 内、`root` 之前，仅有粒子时存在）的位置与生命周期 MUST 不变。
3. **世界空间内容全在相机子树内**：地板 / 墙 / 实体 / 特效 / 跳字 MUST 全部位于 `cameraContainer` 子树内（否则不随缩放，违反 FR-001）。
4. **屏幕空间内容不迁入世界空间**：HUD / 菜单 / 覆盖层 MUST 保持为 DOM，MUST NOT 迁入 `cameraContainer` 子树（否则随缩放，违反 FR-006/007，且撞 F1–F6）。
5. **局部坐标不变**：实体 / 墙 / 特效 / 跳字节点的**局部** `x/y/scale` MUST NOT 因世界缩放而改写（`z` 只在 `cameraContainer.scale` 上）。
6. **销毁完整**：`destroy()` MUST 仍以 `cameraContainer.destroy({ children: true })` 递归拆掉 root（含视图、fxLayer、跳字）并显式拆掉静态层与粒子层；`reset()` MUST 复位 `camera.scale = 1`。

## 4. 违例判定

| 场景 | 期望 |
|---|---|
| 无墙世界同步后 | `stage.children` 长 1；`camera.children` 长 1；`camera.children[0] === root` |
| 有墙世界同步后 | `camera.children` 长 2；`[0]` = 静态层（≠ root）；`[last] === root` |
| 有墙 + 有存活粒子 | `camera.children` 长 3；顺序 `[static, particle, root]`（root 恒最后） |
| 跳字存在时 | `fxLayer.parent === root`；`root.children[last] === fxLayer`；跳字 `parent === fxLayer` |
| 缩放激活时 | `camera.scale.x === camera.scale.y === z`；实体视图局部 `x === world × PX_PER_UNIT` |
| 检查 DOM | `#ui-layer` / `#hud` / `#gold` 的屏幕位置与尺寸与改动前一致（SC-003） |
| `destroy()` 后 | `stage.children` 长 0 |
| 新增任何常驻子节点 | **违例**（F1–F6 之一必失败） |

## 5. 已知限制

- **L1 · 静态层与实体层必须同缩放**：二者是 `camera` 的兄弟子节点，唯一公共父节点是 `camera` 本身 ⇒ 缩放**只能**写在 `camera.scale`。若未来有人把 `staticLayer` 迁入 `root`，需重新评估 F4/F5。
- **L2 · 跳字随世界放大**：跳字是世界空间（FR-001），故 `z ≈ 8.6` 下字号会被放大；调小表现常量是正确处置，反缩放跳字会破坏本契约第 5 条（research.md D8 T1）。
