# 契约：HD 精灵图集 schema 与命名（hd-spritesheet-schema）

> 权威来源：`spec.md` FR-001…FR-006、FR-019、FR-024；决策见 `research.md` D2 / D5 / D6 / D13 / D14 / D15。
> 实现落点：`assets/art/hd/**`（图集）· `client/assets/manifest.ts`（`SHEET_DATA`）· `client/assets/AssetCatalog.ts`（解析）· `client/GameRenderer.ts`（消费）。
> 守护测试：`tests/assets/manifest.test.ts`、`tests/assets/licenses.test.ts`、`tests/render/{player_art,enemy_art,fx_art}.test.ts`。

## 1. 目录与文件形态

```text
assets/art/hd/
├── player.png / player.json              # 玩家：4 向 × 6 动作
├── enemy-grunt.png / enemy-grunt.json
├── enemy-elite.png / enemy-elite.json
├── enemy-raider.png / enemy-raider.json
├── enemy-bomber.png / enemy-bomber.json
├── enemy-gunner.png / enemy-gunner.json
├── enemy-unknown.png / enemy-unknown.json
├── tiles.png / tiles.json                # 地面变体 + 墙体 autotile 部件
└── fx.png / fx.json                      # 特效 + 掉落物
assets/art/ui/**                          # 保留（FR-030，不在本特性范围）
```

**共 9 张世界 HD 图集**（决策 D15）。`assets/art/atlas/**` 整体删除。

**关联 MUST 显式**：图集描述源与图像源的配对 MUST 写在 `SHEET_DATA`（键控）中，**MUST NOT** 依赖「同名即配对」的隐式约定 —— 隐式约定在 HD 多图集切分下脆弱且难以静态检查。

## 2. `SHEET_DATA` schema

```ts
interface SheetFrameData {
  readonly frame: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

interface SpriteSheetData {
  readonly frames: Readonly<Record<string, SheetFrameData>>;      // 帧名 → 矩形
  readonly animations?: Readonly<Record<string, readonly string[]>>; // 动画名 → 帧名序列
  readonly meta: {
    readonly app?: string;
    readonly format?: string;
    readonly image?: string;
    readonly scale: number | string;
    readonly size?: { readonly w: number; readonly h: number };
    // ── M18 新增（可选，向后兼容）──
    readonly tilePx?: number;        // 该图集的自然 tile/帧基准像素（HD = 128）
    readonly silhouettes?: Readonly<Record<string, string>>;  // 剪影参考（供形态区分测试）
  };
}
```

**约束**

| # | 约束 |
|---|---|
| C1 | `meta.scale` MUST 存在（使该接口可结构化赋值给 PixiJS 的 `SpritesheetData`，无需 cast）。 |
| C2 | `meta.tilePx`（若声明）MUST 与 `GameRenderer` 的 `TILE_NATURAL_PX` 一致（决策 D14 的一致性断言）。 |
| C3 | 每条动画引用的帧名 MUST 在 `frames` 中存在。 |
| C4 | 每个 `spritesheet` 条目 MUST 至少声明一条动画。 |
| C5 | 每条 frame 的 `x + w` / `y + h` MUST 落在其图像源的实际像素尺寸内（**矩形越界断言保留**）。 |
| C6 | 单张图集像素尺寸 MUST ≤ 4096×4096（目标 ≤ 2048×2048）。 |
| C7 | 相邻帧之间 MUST 留 ≥ 4px 透明 gutter（mipmap 防渗色，决策 D8）。 |

## 3. 命名契约（**不变**）

```text
动画名 = `<spriteId>.<action>.<facing>`
帧名   = `<动画名>.<n>`          （n 从 0 起，零填充不强制）
```

| 维度 | 取值 | 基数 |
|---|---|---|
| `spriteId` | `player.base` · `enemy.{grunt,elite,raider,bomber,gunner,unknown}` | 7 |
| `action` | `idle` · `move` · `dash` · `attack` · `hit` · `death` | 6 |
| `facing` | `down` · `up` · `left` · `right` | 4 |

**回退链（不变）**：`<spriteId>.<action>.<facing>` → `<spriteId>.<action>.down` → `<spriteId>.idle.down`。

## 4. 必须存在的动画键（决策 D5：全量矩阵）

### 4.1 玩家 `player.base`

**MUST 具备 6 动作 × 4 朝向 = 24 个动画键**（`tests/assets/manifest.test.ts` 逐项钉住）：

```
player.base.{idle,move,dash,attack,hit,death}.{down,up,left,right}
```

| 动作 | 帧数（参考） | 循环 | 相位 |
|---|---|---|---|
| `idle` | 8 | ✅ | 呼吸循环 |
| `move` | 8 | ✅ | 行走/奔跑循环 |
| `dash` | 6 | ❌ | 蓄势 → 突进 → 收势（停末帧） |
| `attack` | 6 | ❌ | **起手 f0–1 / 命中 f2–3 / 收招 f4–5** |
| `hit` | 4 | ❌ | 受创（停末帧） |
| `death` | 8 | ❌ | 消亡（停末帧） |

> `attack` 的相位切分是**给实现阶段的接口**：命中帧（f2–f3）SHOULD 与模拟层 `ATTACKING` 状态的命中窗口对齐，使画面与判定同步。

### 4.2 敌人 `enemy.<type>`

**MUST 具备 4 动作 × 4 朝向 = 16 个动画键**：

```
enemy.<type>.{idle,move,attack,hit}.{down,up,left,right}
```

外加 **`dash` 别名**（决策 D6）：`enemy.<type>.dash.<facing>` MUST 存在，且其帧序列 **= `enemy.<type>.move.<facing>`**（满足键存在性，省去每类 16 帧）。

| 动作 | 帧数（参考） | 循环 |
|---|---|---|
| `idle` | 8 | ✅ |
| `move` | 8 | ✅ |
| `attack` | 6 | ❌ |
| `hit` | 4 | ❌ |
| `dash` | = `move` | ✅（别名） |

**`death`**：敌人消亡使用**通用消亡表现**（`fx` 层的 burst/消散），不要求每类独立 `death` 图集。若某类提供，则走精确键，否则走回退链到 `idle.down` 并由 FX 层承担消亡表现。

**形态区分（FR-004 / SC-002）**：六类 MUST 在**关闭颜色线索**时仍可区分 —— 区分依据是**形态语言**（剪影轮廓、体态、武器外接形状、运动特征），MUST NOT 依赖颜色。`meta.silhouettes` 可登记每类的剪影参考帧名，供测试断言。

## 5. 图集切分与去重（决策 D15）

- 世界 HD 图集按**装载单元**切分：player 1 · 每类敌人 1（共 6）· tiles 1 · fx 1 = **9 张**。
- `AssetCatalog` 的**按 `source` 去重**逻辑 MUST **零改动**：同一图集被多个 id 引用时只解码一次。
- 单张图集尺寸预算（`tilePx = 128` 下）：player 148 帧 × 128² ≈ **1552²**；单类敌人最大 92 帧 × 160²（elite）≈ **1264²**；均 < 2048² ✅。

## 6. 纹理过滤（决策 D7）

| 资产 | `scaleMode` | `autoGenerateMipmaps` |
|---|---|---|
| HD 世界美术（角色/敌人/地面/墙/特效/掉落物） | **`'linear'`** | **`true`** |
| 全局默认 `TextureSource.defaultOptions.scaleMode` | **保持 `'nearest'`** | — |
| 保留的 UI 贴图 | `'nearest'` | `false` |

**理由**：全局默认保持 `nearest` 使 M17 的 `tests/render/camera_zoom_sharpness.test.ts`（**不在**授权更新集内）**零改动**继续通过；HD 世界美术按纹理覆盖为 `linear` + mipmap 满足 FR-025 并消除缩小摩尔纹。

**实现位置**：`AssetCatalog.load()` 开头设全局默认后，对每个 HD 世界美术纹理的 `TextureSource` 显式设置。

## 7. 动画时钟（决策 D13）

| 动作 | 循环 | 停止行为 |
|---|---|---|
| `idle` · `move` | ✅ | — |
| `dash` · `attack` · `hit` · `death` | ❌ | 停在**末帧**（不得回绕到首帧） |

- 时钟 MUST 由 ticker 的 `deltaMS` 驱动（视觉时钟），MUST NOT 由逻辑 tick 推导（ADR-002 / spec 22 §3.4）。
- `AnimatedSprite.autoUpdate` MUST 为 `false`（由渲染器持有时钟）。

## 8. 与模拟层的隔离（**MUST NOT 违反**）

- 图集 schema、命名、帧数、帧率 MUST NOT 影响 `src/` 的任何行为。
- 动作 MUST 由 `ActionState` + `DeadTag` 投影而来（`sprite-map.ts`），MUST NOT 为动画在实体上写入任何字段。
- 帧数 MUST NOT 被用作判定依据（判定由模拟层 tick 决定）。

## 9. 契约的可测试性对照

| 条款 | 守护测试 | 强度 |
|---|---|---|
| §2 C3–C5 schema 与矩形越界 | `tests/assets/manifest.test.ts` · `tests/assets/licenses.test.ts` | 保持 |
| §2 C6/C7 图集尺寸与 gutter | `tests/assets/licenses.test.ts` | 新增 |
| §3 命名契约与回退链 | `tests/assets/manifest.test.ts` · `tests/assets/sprite-map.test.ts` | 保持 |
| §4.1 玩家 24 个键 | `tests/assets/manifest.test.ts` | 保持（键集合不变） |
| §4.2 敌人 16 + dash 别名 | `tests/assets/manifest.test.ts`（新增别名断言） | 新增 |
| §4.2 形态区分 | `tests/render/enemy_art.test.ts` + 新增剪影用例 | 新增 |
| §5 去重零改动 | `tests/assets/degradation.test.ts` | 保持 |
| §6 过滤策略 | `tests/render/camera_zoom_sharpness.test.ts`（**零改动**）+ 新增 HD 锐利度用例 | 保持 + 新增 |
| §7 循环语义 | 新增用例（`idle`/`move` 循环、其余停末帧） | 新增 |
| §8 与模拟层隔离 | `tests/harness/*lossless*`（**零改动**）+ `git diff src/` | **MUST NOT 放宽** |
