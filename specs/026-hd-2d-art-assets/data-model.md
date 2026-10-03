# 数据模型：HD 2D 美术与动画资产（M18）

> 权威来源：`specs/026-hd-2d-art-assets/spec.md`；结构契约见 `contracts/`。
> 本文件描述**表现层资产的数据形状与校验规则**，不含实现代码。
> 具体数值（分辨率、帧数、体积预算）以 `design/art-direction.md` 与 `research.md` 为准；本文件只固定**结构**。

## 概览：实体关系

```text
HD 资产清单（唯一引用点：client/assets/manifest.ts）
├── E1 清单条目 AssetEntry ──(1:N)── E6 许可登记记录
│     ├─ kind='spritesheet' ──(1:1)── E2 角色/敌人动画集
│     ├─ kind='spritesheet' ──(1:1)── E3 场景贴图集
│     ├─ kind='spritesheet' ──(1:1)── E4 局内特效资产
│     ├─ kind='image'       ──(1:1)── 界面贴图（本特性不动）
│     └─ kind='audio'       ──(1:1)── 音频（本特性不动）
├── E7 体积预算（全局约束）
└── E5 图集装载状态（运行期，逐条目）
```

---

## E1 · 清单条目（AssetEntry）

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | `string` | kebab-case；MUST 命中命名空间白名单 `player.` / `enemy.` / `tile.` / `fx.` / `ui.` / `sfx.`；全清单唯一 |
| `kind` | `'spritesheet' \| 'image' \| 'audio'` | 三值枚举，无第四种 |
| `source` | `string` | Vite 构建期解析的**本地** URL；非空、非纯空白；MUST NOT 以 `http://` / `https://` 开头 |
| `license` | `string` | MUST 命中经登记的开放许可白名单（见 `contracts/hd-asset-manifest.md` §5） |
| `fallback` | `'graphics' \| 'silent'` | `kind==='audio'` ⇒ `'silent'`；其余 ⇒ `'graphics'` |

**校验规则**

- VR-1：`MANIFEST` 与 `MANIFEST_IDS` MUST 冻结；`MANIFEST[id].id === id`；无重复 id。
- VR-2：`source` 的 basename MUST 在磁盘上存在且非空（构建期由静态导入保证；测试期按 basename 复核）。
- VR-3：`fallback` 与 `kind` 的对应关系 MUST 成立（见上表）。
- VR-4：`ui.*` 与 `sfx.*` 条目 MUST 保持存在（FR-030：覆盖范围不含界面与音频，但不得删条目）。

**状态机（E5，运行期装载状态）**

```text
declared ──load()──> loading ──成功──> ready     （终态）
                          └──失败──> degraded  （终态，不重试）
```

- `ready` 与 `degraded` 均为**终态**；第二次 `load()` MUST 是空操作（不重试）。
- 逐条目隔离：一个 id 失败 MUST NOT 影响其它 id 的状态。

---

## E2 · 角色 / 敌人动画集（HD spritesheet）

| 字段 | 类型 | 约束 |
|---|---|---|
| `spriteId` | `string` | `player.base` 或 `enemy.{grunt,elite,raider,bomber,gunner,unknown}` —— **恰好 7 个** |
| `facing` | `Facing4` | `down` / `up` / `left` / `right` —— **恰好 4 个** |
| `action` | `AnimationState` | `idle` / `move` / `dash` / `attack` / `hit` / `death` —— **恰好 6 个** |
| `frames` | `Frame[]` | 非空；每个 `Frame = { x, y, w, h }`，`x+w` / `y+h` MUST 落在图像源尺寸内 |
| `frameMs` | `number` | 每动作一个值（视觉时钟，由 ticker `deltaMS` 驱动；MUST NOT 由逻辑 tick 推导） |
| `loop` | `boolean` | 循环动作（`idle` / `move`）为 `true`；一次性动作（`attack` / `hit` / `death`）为 `false` |
| `anchor` | `{x, y}` | 与 hurtbox 的锚定区域一致（见 `contracts/renderer-asset-mapping.md` §6） |
| `naturalPx` | `number` | 单帧自然像素尺寸；驱动 `hurtboxSpriteScale` |

**校验规则**

- VR-5：`player.base` MUST 具备 **6 动作 × 4 朝向 = 24** 个动画键（或按 `contracts/renderer-asset-mapping.md` §5 显式登记省略项，且 `idle.down` 必须存在）。
- VR-6：六个 `enemy.*` id MUST 各至少具备 `idle.down`（总函数兜底），SHOULD 具备 4 动作 × 4 朝向。
- VR-7：`spriteId` 的**视觉外接尺寸** MUST 与 hurtbox 直径一致（由 `hurtboxSpriteScale` 保证；FR-008）。
- VR-8：六类敌人 MUST 在**关闭颜色线索**时仍可区分（形态层面；FR-004 / SC-002）。
- VR-9：`naturalPx` MUST 与 `TILE_NATURAL_PX` 的基准一致（**HD 基准 = 128**，决策 D2 / D14）。

---

## E3 · 场景贴图集（HD 地牢 Tilemap）

| 字段 | 类型 | 约束 |
|---|---|---|
| `floorVariants` | `Frame[]` | ≥ 1；变体选择 MUST 确定性（按格坐标哈希），MUST NOT 随机 |
| `wallParts` | `Map<mask, Frame>` | 按邻接位掩码（4 邻或 8 邻）索引的墙体部件集 |
| `tilePx` | `number` | 单 tile 自然像素尺寸 = **128**（决策 D2）；MUST 与 `TILE_NATURAL_PX` 及 `meta.tilePx` 三者一致 |
| `depthExtentPx` | `number` | 墙体立面朝屏幕内侧延伸的像素高度（表达深度/透视） |

**校验规则**

- VR-10：视觉边界 MUST 与碰撞几何一致 —— 视觉上是墙的地方即被阻挡的地方（FR-008 / SC-004，一致率 100%）。
- VR-11：按房间实际尺寸与形状铺设，MUST NOT 拉伸、错位、重复错位或空洞（FR-009）。
- VR-12：墙体立面 MUST NOT 遮挡本应可见的可通行地面（FR-010）。
- VR-13：`wallParts` 的掩码覆盖 MUST 是**完备**的 —— 任一可能邻接组合 MUST 解析到一个部件（不得出现空洞）。缺失组合 MUST 有显式兜底部件。
- VR-14：房间切换后静态层 MUST 无残留（旧节点全部回收）。

---

## E4 · 局内特效资产

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | `string` | `fx.spark` / `fx.dash-trail` / `fx.hazard-ring` / `fx.pickup.{gold,heal,darkness}`（掉落物，决策 D4）/ 伤害数字字形 |
| `frames` | `Frame[]` | 非空 |
| `blendMode` | `'normal' \| 'additive'` | 明确声明 |
| `loop` | `boolean` | 拖尾/预警通常非循环 |
| `runtimeKind` | `'graphics' \| 'sprite'` | ⚠️ 受 `tests/render/fx_art.test.ts` 的「粒子必须是 `Graphics`」契约约束 |

**校验规则**

- VR-15：`fx.spark` 的 `runtimeKind` MUST 保持 `'graphics'`（既有冻结粒子契约），除非评审显式授权放宽。
- VR-16：危险预警（`fx.hazard-ring`）的进度 MUST 继续由**组件引信**（`delayTicks` / `totalDelayTicks`）驱动，MUST NOT 改为由美术时钟驱动（否则预警时机与判定脱节）。
- VR-17：掉落物三类（金币/治疗/暗影）MUST 在视觉上清晰区分「应拾取」与「应躲避」，MUST NOT 混淆。

---

## E5 · 图集装载状态

见 E1 的状态机。补充：

| 字段 | 类型 | 约束 |
|---|---|---|
| `states` | `Map<id, 'declared'\|'loading'\|'ready'\|'degraded'>` | 逐 id |
| `sourceCache` | `Map<source, Promise<Bundle>>` | 按 `source` 去重；共享同一图集的多个 id 只解码一次 |

**校验规则**

- VR-18：`degraded` MUST 是终态（无重试）。
- VR-19：去重 MUST 按 `source` 生效 —— HD 多图集切分后，同一图集被多个 id 引用时仍只解码一次。

---

## E6 · 许可登记记录

| 字段 | 类型 | 约束 |
|---|---|---|
| `id` | `string` | 对应 E1 的 `id`，以 `` `id` `` 形式出现在 `assets/art/LICENSES.md` |
| `sourceName` | `string` | 素材包名 / 「本仓库原创」/「程序化生成」 |
| `author` | `string` | 作者或「本仓库」 |
| `license` | `string` | 与 E1 的 `license` 一致 |
| `modifications` | `string` | 若做过程序化派生，MUST 记录变换内容 |

**校验规则**

- VR-20：可追溯率 MUST = 100%（每个 id 都能在登记中找到）。
- VR-21：MUST NOT 出现商业游戏专有资产痕迹（保留 `/Supergiant/i` 断言，SHOULD 扩展为已知发行商名单）。
- VR-22：本仓库原创 / 程序化生成的资产 MUST 明确标注为原创并记录生成方式。

---

## E7 · 体积预算（全局约束）

| 字段 | 类型 | 约束 |
|---|---|---|
| `maxFileBytes` | `number` | 单文件上限 = **3 MB**（决策 D3） |
| `maxTotalBytes` | `number` | 资产总量上限 = **12 MB**（决策 D3） |
| `maxAtlasPx` | `number` | 单张图集像素尺寸上限 = **4096**（目标 ≤ 2048，决策 D3） |
| `maxAtlasCount` | `number` | 图集数量上限 = **12**（世界 9 + UI 保留，抵补单文件上限放宽） |

**校验规则**

- VR-23：以**构建产物实测**为准判定。
- VR-24：预算断言 MUST NOT 退化为「无上限」；放宽单文件上限时 MUST 同步新增等价强度的约束（**已新增**图集数量上限与单图集像素上限两条）。
- VR-25：单张图集 MUST ≤ `maxAtlasPx`（WebGL `MAX_TEXTURE_SIZE` 保证下限），超出 MUST 切分。
- VR-26：图集内相邻帧 MUST 留 ≥ 4px 透明 gutter（mipmap 防渗色，决策 D8）。

---

## 附：本特性**不**引入的数据

以下内容 MUST NOT 被本特性加入数据模型（它们是 `src/` 冻结层或超出覆盖范围）：

| 不引入项 | 理由 |
|---|---|
| 实体上的「敌人类型标签」字段 | 会进入 `listComponents()` ⇒ 改变快照摘要 ⇒ 破坏确定性（用能力签名只读推断替代） |
| 实体上的「动画状态」字段 | 动画是表现层概念，由 `ActionState` + `DeadTag` 投影（FR-003） |
| 新的 `ActionState` 枚举成员 | 会改动 `src/` 与 17 段管道（FR-011 / FR-014） |
| 界面（`ui.*`）与音频（`sfx.*`）的新资产 | 超出覆盖范围（FR-030） |
| 任何运行时依赖（如骨骼动画运行时） | 用户裁定为逐帧位图序列；宪法技术栈约束（FR-031） |
