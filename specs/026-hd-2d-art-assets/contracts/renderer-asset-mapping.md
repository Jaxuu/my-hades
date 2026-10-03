# 契约：状态 → HD 资产 的只读映射（renderer-asset-mapping）

> 承接 `specs/024-real-art-assets/contracts/renderer-asset-mapping.md`，在 M18 下**保持语义不变**，仅补充 HD 相关的落点。
> 权威来源：`specs/026-hd-2d-art-assets/spec.md` FR-001…FR-010、FR-012、FR-013、FR-025。
> 实现落点：`client/assets/sprite-map.ts`（纯函数）、`client/GameRenderer.ts`（消费者）。
> 守护测试：`tests/assets/sprite-map.test.ts`、`tests/render/{player_art,enemy_art,tilemap_art,fx_art}.test.ts`。

## 1. 只读性（**MUST NOT 放宽**）

`sprite-map.ts` 的全部导出函数 MUST 是 `World` 的**只读**消费者：

- MUST NOT 调用任何写 API（`setComponent` / `removeComponent` / `addComponent` / `spawn` / `destroy` 等）。
- MUST NOT 推进模拟、MUST NOT 消费随机（`World.rng` 的下一值 MUST 不变）。
- MUST NOT 依赖时间或迭代顺序；无 DOM、无 `pixi.js` 导入。

**理由**：这是「渲染器是模拟世界的只读消费者」这一宪法 Principle V 的具体执行点。HD 化 MUST NOT 成为向实体写入「类型标签」「动画状态」等字段的借口 —— 那会进入 `listComponents()` ⇒ 改变 `snapshot()` 摘要 ⇒ 破坏确定性基线与冻结内核。

## 2. 朝向量化（**保持不变**）

`facingFromRadians(radians): Facing4`，`Facing4 = 'down' | 'up' | 'left' | 'right'`。

| 输入角（归一化到 `[-PI, PI)`） | 输出 |
|---|---|
| `|θ| ≤ π/4` | `right` |
| `|θ| ≥ 3π/4` | `left` |
| `π/4 < θ < 3π/4` | `down` |
| `-3π/4 < θ < -π/4` | `up` |
| 非有限值（`NaN` / `±Infinity`） | `down`（总函数，绝不抛错） |

- 归一化 MUST 把 `PI` 折叠到 `-PI`（同一朝向的单一代表），使 `±PI` 接缝稳定。
- 判定边界 MUST 落在 `±45°` / `±135°`，远离 `±PI` 接缝 ⇒ 直行不抖动。

**HD 影响**：HD 资产若提供 8 朝向或自由旋转，MUST **另立增量**。本特性 MUST 保持 4 朝向量化，因为 `facingRadians` 的量化语义由 `tests/assets/sprite-map.test.ts` 冻结。

## 3. 动作投影（**保持不变**）

`animationFromState(state: ActionState | undefined): AnimationState`，`AnimationState = 'idle' | 'move' | 'dash' | 'attack' | 'hit' | 'death'`。

| `ActionState` | `AnimationState` |
|---|---|
| `IDLE` | `idle` |
| `MOVING` | `move` |
| `DASHING` | `dash` |
| `ATTACKING` | `attack` |
| `HITSTUN` | `hit` |
| `undefined` / 其它 | `idle` |

- **总函数**：任何输入都有答案，绝不抛错。
- `death` **不是** `ActionState`：死亡是 `DeadTagComponent` 这个**标签**，由 `selectSprite` 折叠进来。
- **HD 影响**：HD 资产 MUST 覆盖上表全部 6 个动作。若 HD 想引入新动作（如「受击倒地」「蓄力」），MUST 另立增量并同步 `src/` 的状态枚举 —— **本特性不允许**（FR-003 / FR-011）。

## 4. 敌人分类（**保持不变：能力签名表**）

`enemyTypeFromSignature(world, id): EnemyType`，`EnemyType = 'grunt' | 'elite' | 'raider' | 'bomber' | 'gunner' | 'unknown'`。

**按优先级顺序**（顺序只在一处关键：`armor + hazard` 必须先于 `armor` 判定，否则 `gunner` 会被误读为 `elite`）：

| 序 | 条件（只读组件） | 结果 | 中文标签 |
|---|---|---|---|
| 0 | 无 `FactionComponent`，或 `faction === Player`，或有 `PlayerInputComponent` | `unknown` | 兜底 |
| 1 | `ArmorComponent` ∧ `HazardCasterComponent` | `gunner` | 远程精英 |
| 2 | `ArmorComponent` | `elite` | 精英 |
| 3 | `HazardCasterComponent` | `bomber` | 自爆者 |
| 4 | `AIControllerComponent` | `raider` | 突袭者 |
| 5 | 其余（有阵营的战斗单位） | `grunt` | 普通 |

**已知限制（沿用 024，并在本特性中继续保持）**：非 `grunt` 的**精英变体**（如 `spawnElite('gunner')`，签名为 armor + hazard）按**基础类型**呈现，不额外区分「精英化」。这满足「数据表中声明的敌人类别」的区分要求，但不承诺区分同类别精英变体。

**HD 影响**：HD 资产 MUST 为 `enemy.{grunt,elite,raider,bomber,gunner,unknown}` **六个 id 各出一套**（含 `unknown` 兜底 —— 未识别敌人 MUST NOT 变成不可见）。区分 MUST 在**形态层面**成立（FR-004 / SC-002：关闭颜色线索仍可区分）。

## 5. 动画查找与回退链（**保持不变**）

```
exact   = `${spriteId}.${action}.${facing}`
then    = `${spriteId}.${action}.down`
then    = `${spriteId}.idle.down`
```

- 去重（若 `exact` 本身即 `idle.down`，链只含一项）。
- **HD 影响**：HD 图集 SHOULD 提供完整交叉（6 动作 × 4 朝向），使回退链在正常路径上**不被触发**。若 HD 出于作画量考虑省略部分朝向，回退链 MUST 仍然成立（即至少 `idle.down` 必须存在），且省略 MUST 在美术规格中显式登记。

## 6. 身体尺寸 = 碰撞尺寸（**保持不变，HD 的关键约束**）

```ts
hurtboxSpriteScale(radiusUnits, naturalPx, pxPerUnit) = (radiusUnits * 2 * pxPerUnit) / naturalPx
```

- 精灵缩放 MUST 由实体的 **hurtbox 半径** 推导，MUST NOT 用手调常数 —— 这样「视觉边界 == 碰撞边界」（FR-008 / SC-004）在数值再平衡时自动成立。
- 守卫：非有限 / ≤ 0 的半径、`naturalPx`、目标像素 ⇒ 返回 `1`（按自然尺寸绘制），绝不返回 `Infinity` / `NaN`。

**HD 影响（本特性的核心落点）**：

- `TILE_NATURAL_PX` 由 `16` 改为 **HD 基准 tile 尺寸**（数值见 research.md）。该常量是「贴图自然像素 ↔ 世界单位」的换算基准；HD 贴图改变其自然尺寸，常量 MUST 同步。
- HD 角色精灵的**视觉外接尺寸** MUST 与 hurtbox 直径一致。若 HD 美术采用「角色高于其碰撞体」的写实比例（常见做法），MUST 在美术规格中定义**碰撞体对应的锚定区域**（例如脚部/躯干），并由 `GameRenderer` 按该锚点定位，MUST NOT 让「角色看起来比实际碰撞体大/小」。
- `anchor` 必须与上述锚定区域一致（当前为 `0.5, 0.5` 居中；HD 若采用脚部锚点则需相应调整）。

## 7. 场景 tile 的资产查找（**本特性扩展**）

现状：`tileTexture(id)` 优先取「与 id 同名的单帧动画」（`tile.floor` / `tile.wall`），回退到 `texture(id)`。

HD 扩展（MUST 保持「同名动画优先」的语义）：

1. 地面 MUST 支持**多张变体**（避免大面积重复感），变体的选择 MUST 是**确定性**的（例如按格坐标哈希），MUST NOT 使用随机 —— 渲染层不得消费 `World.rng`，也不得引入墙钟。
2. 墙体 MUST 按**邻接位掩码（autotile）**选择部件（顶面 / 立面 / 转角 / T 形 / 端点 / 内侧角）。掩码 MUST 由**只读**的房间网格推导。
3. 视觉边界 MUST 与碰撞几何一致：立面朝屏幕内侧延伸、顶面覆盖墙格本身 —— 具体规则见 `contracts/tilemap-autotile.md`。

## 8. 纹理过滤（**已定案**）

| 资产类别 | 采样模式 | mipmap | 理由 |
|---|---|---|---|
| HD 世界美术（角色/敌人/场景/特效/掉落物） | **`linear`** | **`true`** | HD 手绘不是像素画；`z=8.64`、DPR=1.5/2 等**非整数倍**放大下 `nearest` 会产生硬锯齿与闪烁。mipmap 消除**缩小**时的摩尔纹（30×30 房 `z=2.88` 时 128px→29px，缩小 4.4×，无 mipmap 必现 ⇒ 违反 SC-009） |
| 全局默认 `TextureSource.defaultOptions.scaleMode` | **保持 `'nearest'`** | — | 使 M17 的 `tests/render/camera_zoom_sharpness.test.ts`（**不在**授权更新集内）**零改动**继续通过 |
| 保留的 UI 贴图 | `'nearest'` | `false` | 保持像素锐利（本特性不改 UI） |

**实现要点**：`AssetCatalog.load()` 开头仍设全局默认 `'nearest'`（M17 断言保留），随后对**每个 HD 世界美术纹理**的 `TextureSource` 显式设 `scaleMode = 'linear'` 且 `autoGenerateMipmaps = true`。

**约束**：过滤策略 MUST NOT 影响 `src/`，MUST NOT 改变碰撞或判定，MUST NOT 改变 17 段管道。

## 9. 掉落物图标 id（`research.md` D4）

`sprite-map.ts::pickupIconId(kind)` 的返回值 MUST 由 `ui.icon.*` 改为 **`fx.pickup.*`**：

| `PickupKind` | 旧 id | **新 id** |
|---|---|---|
| `HEAL` | `ui.icon.heal` | `fx.pickup.heal` |
| `DARKNESS` | `ui.icon.darkness` | `fx.pickup.darkness` |
| 其余（金币） | `ui.icon.gold` | `fx.pickup.gold` |

**理由**：掉落物渲染在**世界空间**，`ui.` 命名空间留给 HUD（FR-030 边界）。三类 MUST 在视觉上清晰区分「应拾取」与「应躲避」。

**约束**：`pickupIconId` MUST 仍是**纯函数**（无 DOM、无 `pixi.js`、不写世界、不消费随机），且三类 MUST 返回**三个互不相同**的 id（该断言保留）。

## 10. 契约的可测试性对照

| 契约条款 | 守护测试 | 强度 |
|---|---|---|
| §1 只读性 / 不消费随机 | `tests/assets/sprite-map.test.ts` | **MUST NOT 放宽** |
| §2 朝向量化（含接缝与总函数） | `tests/assets/sprite-map.test.ts` | **MUST NOT 放宽** |
| §3 动作投影（含枚举全覆盖） | `tests/assets/sprite-map.test.ts` | **MUST NOT 放宽** |
| §4 敌人签名表 | `tests/assets/sprite-map.test.ts` | **MUST NOT 放宽** |
| §5 回退链 | `tests/assets/sprite-map.test.ts` + `tests/render/*_art` | 保持 |
| §6 hurtbox 缩放（FR-008） | `tests/assets/sprite-map.test.ts` + `tests/render/enemy_art.test.ts` | 保持 |
| §7 tile 查找与 autotile | `tests/render/tilemap_art.test.ts` | 节点构成断言随实现更新；**F1–F6 冻结契约 MUST NOT 放宽** |
| §8 纹理过滤 | `tests/render/camera_zoom_sharpness.test.ts`（**零改动**）+ 新增 HD 锐利度用例 | 保持 + 新增 |
| §9 掉落物 id 命名空间 | `tests/assets/sprite-map.test.ts`（改 id 字面量，**三条断言强度不变**） | 保持强度、更新数值 |
