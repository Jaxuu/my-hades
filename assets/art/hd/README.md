# HD 世界美术图集目录（`assets/art/hd/`）

> 规格：`specs/026-hd-2d-art-assets/` · 结构契约：`contracts/hd-spritesheet-schema.md`
> 本目录是 M18 之后**唯一**的局内世界美术来源（FR-016…FR-019）。

## 1. 目录约定

```text
assets/art/hd/
├── player.png / player.json              # 玩家：4 向 × 6 动作 = 24 动画键 / 160 帧
├── enemy-grunt.png / enemy-grunt.json    # 6 类敌人：各 4 向 × 5 动作 = 20 键 + 4 dash 别名 / 128 帧
├── enemy-elite.png / enemy-elite.json
├── enemy-raider.png / enemy-raider.json
├── enemy-bomber.png / enemy-bomber.json
├── enemy-gunner.png / enemy-gunner.json
├── enemy-unknown.png / enemy-unknown.json
├── tiles.png / tiles.json                # 8 地面变体 + 47 墙体 autotile 部件 + 1 兜底
└── fx.png / fx.json                      # 火花 / 拖尾 / 危险环 / 三类掉落物
```

**共 9 张世界 HD 图集**（决策 D15：按**装载单元**切分，`AssetCatalog` 的按 `source` 去重语义零改动）。

## 2. 命名契约（不变）

```text
动画名 = `<spriteId>.<action>.<facing>`
帧名   = `<动画名>.<n>`          （n 从 0 起）
```

| 维度 | 取值 |
|---|---|
| `spriteId` | `player.base` · `enemy.{grunt,elite,raider,bomber,gunner,unknown}` |
| `action` | `idle` · `move` · `dash` · `attack` · `hit` · `death` |
| `facing` | `down` · `up` · `left` · `right` |

**回退链**：`<spriteId>.<action>.<facing>` → `<spriteId>.<action>.down` → `<spriteId>.idle.down`。

**敌人 `dash` 别名**（决策 D6）：`enemy.<type>.dash.<facing>` 存在，且其**帧名序列等于** `enemy.<type>.move.<facing>`（不额外作画）。

## 3. 打包坐标与 gutter

- 单帧为**正方形**（player / tiles / fx = 128²；grunt / bomber / unknown = 96²；raider / gunner = 128²；elite = 160²）。
- 网格步长 = `帧边长 + 4`，**相邻帧之间恒有 4px 全透明 gutter**（决策 D8：mipmap 低层级跨帧取样会渗色）。
- 每个 frame 矩形的 `x + w` / `y + h` MUST 落在图像源尺寸内（`tests/assets/licenses.test.ts` 逐条核对）。
- 图集像素尺寸 MUST ≤ 4096²（目标 ≤ 2048²）；图集数 MUST ≤ 12。

## 4. `meta` 字段

| 字段 | 说明 |
|---|---|
| `scale` | 必填（使该接口可结构化赋值给 PixiJS `SpritesheetData`） |
| `size` | `{ w, h }` 图像源像素尺寸 |
| `tilePx` | 该图集的自然 tile 基准像素；**MUST 与 `GameRenderer.TILE_NATURAL_PX` 一致**（决策 D14 一致性断言） |
| `silhouettes` | 剪影参考（`{ grid: 64 字符 8×8 覆盖率, rows: 8 段行计数, opaque: 不透明像素数 }`），供「关闭颜色线索仍可区分」的断言使用 |

## 5. 与模拟层的隔离（MUST NOT 违反）

- 图集 schema / 命名 / 帧数 / 帧率 **MUST NOT** 影响 `src/` 的任何行为。
- 动作 MUST 由 `ActionState` + `DeadTag` 投影而来（`client/assets/sprite-map.ts`），**MUST NOT** 为动画在实体上写入任何字段。
- 帧数 MUST NOT 被用作判定依据（判定由模拟层 tick 决定）。

## 6. 重新生成占位图集

当前图集为**程序化生成的占位 HD 资产**（本仓库原创）：

```bash
node production/m18-placeholder-atlases.mjs
```

真实 HD 美术就位后，该脚本与占位图集一并退役（`tasks.md` T049）。
