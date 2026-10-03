# 契约：HD 资产清单（hd-asset-manifest）

> 承接 `specs/024-real-art-assets/contracts/asset-manifest.md`，在 M18 下**重新定义**清单的结构性约束。
> 权威来源：`specs/026-hd-2d-art-assets/spec.md` FR-016…FR-024、FR-030。
> 实现落点：`client/assets/manifest.ts`、`client/assets/AssetCatalog.ts`。
> 守护测试：`tests/assets/manifest.test.ts`、`tests/assets/licenses.test.ts`、`tests/assets/degradation.test.ts`。

## 1. 清单条目的形状（**保持不变**）

```ts
export type AssetKind = 'spritesheet' | 'image' | 'audio';
export type AssetFallback = 'graphics' | 'silent';

export interface AssetEntry {
  readonly id: string;        // kebab-case，带命名空间前缀
  readonly kind: AssetKind;
  readonly source: string;    // Vite 构建期解析出的 URL；绝不是远端 URL
  readonly license: string;   // 开放许可标识（见 §5）
  readonly fallback: AssetFallback;
}
```

**硬约束**（逐条由测试钉住）：

1. `MANIFEST` 与 `MANIFEST_IDS` MUST 冻结（`Object.freeze`）。
2. 每条 `MANIFEST[id].id === id`；`MANIFEST_IDS` 无重复。
3. `kind === 'audio'` ⇒ `fallback === 'silent'`；其余 ⇒ `fallback === 'graphics'`。
4. `source` 非空、非纯空白、且是**本地构建路径**（MUST NOT 以 `http://` / `https://` 开头）。
5. 全部 `kind === 'spritesheet'` 的 id MUST 在 `SHEET_DATA` 中有对应的解析结果。

## 2. 命名空间（**保持不变**）

id 前缀白名单，MUST 命中其一：

| 前缀 | 语义 | 本特性是否改动 |
|---|---|---|
| `player.` | 玩家形象 | ✅ 换成 HD 图集 |
| `enemy.` | 敌人类别形象 | ✅ 换成 HD 图集 |
| `tile.` | 场景 tile | ✅ 换成 HD 贴图（含墙体深度部件） |
| `fx.` | 局内特效 | ✅ 换成 HD 资产 |
| `ui.` | 界面资产 | ❌ **不动**（FR-030） |
| `sfx.` | 音频资产 | ❌ **不动**（FR-030） |

**关键点**：`ui.*` 与 `sfx.*` 条目**继续留在清单里**并继续通过既有测试，只是本特性不替换其资产。这保证了「覆盖范围仅局内世界美术」不会以「删掉界面条目」的方式实现（那会破坏界面）。

**掉落物 id 迁移（`research.md` D4）**：局内掉落物（金币 / 治疗 / 暗影）的 id 由 `ui.icon.*` 迁到 **`fx.pickup.gold` / `fx.pickup.heal` / `fx.pickup.darkness`**。理由：掉落物渲染在**世界空间**，与 HUD 的屏幕空间图标是两回事；分属不同命名空间使「FR-030：`ui.*` 不动」成为一条可机器检查的边界。`ui.icon.*` 条目可保留（供 HUD 使用）或按实现需要退役，但 `ui.` 命名空间本身 MUST 保留。

**`fx.` 命名空间在本特性下的完整内容**：

| id | 用途 |
|---|---|
| `fx.spark` | 命中火花（**运行时 MUST 保持 `Graphics`**，见 D11） |
| `fx.dash-trail` | 冲刺拖尾 |
| `fx.hazard-ring` | 危险预警环 |
| `fx.pickup.gold` / `fx.pickup.heal` / `fx.pickup.darkness` | 掉落物（三类，视觉上 MUST 区分「应拾取」与「应躲避」） |
| `fx.damage-font`（或等价） | 伤害数字字形图集 |

## 3. 引用点唯一性（**保持不变，且是本特性的核心安全网**）

- 全仓库 MUST **只有** `client/assets/manifest.ts` 引用资产**文件**。
- 每个引用 MUST 是 Vite 静态导入（`?url` 或 JSON），从而在**构建期**解析。
- 推论（FR-019 / FR-020）：**删除一个仍被引用的资产文件 ⇒ `npm run build` 响亮失败**，而不是产出一个运行期 404 的包。

这条契约在本特性中承担额外职责：它是「旧像素资产已被彻底移除、且没有任何残留引用」的**机器可验证**保证 —— 只要构建通过，就不存在悬空引用。

## 4. 降级语义（**保持不变**）

| 层级 | 时机 | 要求 |
|---|---|---|
| **构建期** | 清单引用的文件缺失 | MUST **响亮失败**（构建报错）。MUST NOT 静默产出缺资产的产物。 |
| **运行期** | 文件损坏 / 解码失败 / 格式不受支持 | MUST **优雅降级**：该 id 标记为 `degraded`（终态、不重试），渲染回退到既有 `Graphics` 几何或静默。MUST NOT 崩溃、黑屏或阻塞游戏循环。 |

**逐条目隔离**：每个 id 在自己的 `try`/`catch` 内加载。一个坏文件只影响该 id，其余 id 不受影响。

**按 source 去重**：同一 `source` 只解码一次（六类敌人曾共享一张 `enemies.png`）。本特性下 HD 资产若按实体/动作切分成多张图集，去重逻辑 MUST 继续按 `source` 生效。

**可注入 loader**：`AssetLoader` 是生产接缝（`PixiAssetLoader`）；测试注入假 loader。此接缝 MUST 保留 —— 它是「降级矩阵可确定性断言、且无需 DOM」的前提。

## 5. 许可与登记（**口径放宽，底线不变**）

**放宽项（经 spec 026 FR-023 / FR-029 授权）**：

- 旧断言「每条 `license` MUST **恰为** `'CC0-1.0'`」⇒ 放宽为「MUST 命中**经登记的开放许可白名单**」。
- 白名单建议内容：`CC0-1.0`、公共领域（`Public Domain` / `CC0`）、`CC-BY-4.0`、`CC-BY-SA-4.0`（含 ShareAlike 义务者须在登记中注明）。
- 白名单 MUST 在测试中以**显式字面量列表**声明，MUST NOT 用「非空字符串」之类的空真断言替代。

**不变项（底线）**：

1. 每项资产 MUST 逐项登记来源与许可（`assets/art/LICENSES.md`）。
2. 每个 manifest id MUST 以 `` `id` `` 形式出现在许可登记中（可追溯率 100%）。
3. MUST NOT 出现商业游戏专有资产的任何痕迹（既有断言 `not.toMatch(/Supergiant/i)` 保留，并 SHOULD 扩展为「不得出现任何已知商业游戏/发行商名称」）。
4. MUST NOT 使用无明确再分发授权的同人素材。
5. 本仓库原创 / 程序化生成的资产 MUST 在登记中明确标注为原创，并记录生成方式。

**旧断言「`raw/` 下包数 ≥ 5 且各带 `License.txt`」的处置**：该断言服务于「像素源素材包留档」。像素源包被移除后，此断言的**前提消失**，故改写为：**HD 素材来源包（若以原始包形式留档）MUST 各自保留上游许可文本**；若 HD 资产全部为「本仓库原创 / 程序化生成」，则该断言改为**对许可登记完整性**的断言（每个 id 都有来源与许可），MUST NOT 直接删除而不设替代。

## 6. 体积预算（**数值已定案**）

| 项 | 旧值（像素时代） | **新值（HD）** | 依据 |
|---|---|---|---|
| 单文件上限 | < 1 MB | **≤ 3 MB** | 最大图集 @0.75 B/px ≈ 2.16 MB，留 ~40% 余量（`research.md` D3） |
| 资产总量上限 | < 6 MB | **≤ 12 MB** | 全量 @0.75 B/px ≈ 9.64 MB，留 ~25% 余量（`research.md` D3） |
| 单图集像素上限 | （无） | **≤ 4096 × 4096**（目标 ≤ 2048 × 2048） | WebGL `MAX_TEXTURE_SIZE` 保证下限 + 低端设备余量 |
| 图集数量上限 | （无） | **≤ 12**（世界 9 张 + UI 保留） | 抵补单文件上限放宽，防「切碎成无数小图集」绕过总量约束 |

**额外硬约束**：

- 体积判定 MUST 以**构建产物实测**为准。
- **强度不可退化（VR-24）**：放宽单文件上限（1 MB → 3 MB）时 MUST 同时新增**图集像素尺寸上限**与**图集数量上限**两条等价强度的约束。MUST NOT 把预算放宽到「无上限」。
- 图集内相邻帧 MUST 留 ≥ 4px 透明 gutter（mipmap 防渗色，`research.md` D8）。

## 7. 图集文件形态（**重新定义，本特性最大结构性变更**）

**旧契约（被替换）**：每个 `spritesheet` 源 MUST 是「`X.png` + 同目录同名 `X.json`」并存，且 JSON 的 `frames` 矩形 MUST 落在 PNG 尺寸内。

**新契约**：

1. `spritesheet` 条目 MUST 由一个**图像源**与一个**图集描述源**共同定义；二者的关联 MUST 是**显式**的（写在 `SHEET_DATA` 或 `AssetEntry` 的扩展字段中），MUST NOT 依赖「同名即配对」的隐式约定 —— 隐式约定在 HD 多图集切分下会变得脆弱。
2. 图集描述 MUST 声明 `frames`（名称 → 矩形）与 `animations`（名称 → 帧名序列），MUST 声明 `meta.scale`。
3. **矩形越界 MUST 被测试捕获**（保留旧断言的强度）：每条 frame 的 `x + w` / `y + h` MUST 落在其图像源的实际像素尺寸内。
4. 每个 `spritesheet` 条目 MUST 至少声明一条动画，且每条动画引用的帧名 MUST 存在。

## 8. 契约的可测试性对照

| 契约条款 | 守护测试 | 强度 |
|---|---|---|
| §1 条目形状与冻结 | `tests/assets/manifest.test.ts` | 保持 |
| §2 命名空间白名单 | `tests/assets/manifest.test.ts` | 保持 |
| §3 引用点唯一性 | `tests/assets/licenses.test.ts`（构建期缺失即失败）+ 构建闸门 | 保持 |
| §4 降级语义 | `tests/assets/degradation.test.ts` | **MUST NOT 放宽** |
| §5 许可登记完整性 | `tests/assets/licenses.test.ts` | 保持（口径放宽、底线不变） |
| §6 体积与图集尺寸 | `tests/assets/licenses.test.ts` | 数值重定 + 新增图集尺寸上限 |
| §7 图集形态与矩形越界 | `tests/assets/licenses.test.ts` | 形态重定义、越界断言保持 |
