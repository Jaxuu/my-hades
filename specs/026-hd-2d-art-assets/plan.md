# Implementation Plan: 高清 2D 美术与动画资产替换（M18）

**Branch**: `026-hd-2d-art-assets` | **Date**: 2026-10-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/026-hd-2d-art-assets/spec.md`

## Summary

把表现层（`client/`）的世界美术从 16×16 像素风整体替换为**高清逐帧位图序列**：玩家与六类敌人获得**四向 × 全动作**的高清动画（玩家 4向×6动作 = 148 帧；敌人 6 类各 4向×4动作 ≈ 552 帧）；房间从「单色块 + 单张贴图平铺」升级为**带深度与透视的 HD 地牢 Tilemap**（墙格内「顶面 / 立面 / 墙脚阴影」三带 + 按 8 邻位掩码自动选件）；旧的像素图集、像素派生生成器（`build-atlas.py`）与像素源素材包被彻底移除。

**技术路线**：纯表现层替换。`src/` **零改动文件**、17 段管道不变、依赖方向保持单向；`client/` 依赖集合不变（仍只有 `pixi.js` + `howler`，**不引入 Spine 等骨骼运行时**）。资产仍走既有的**唯一引用点**（`client/assets/manifest.ts` 的构建期静态导入 ⇒ 删文件即构建失败）与**逐条目优雅降级**契约。

**定案的关键数字**：基准 tile **128×128**（`TILE_NATURAL_PX` 16 → 128）· 体积预算 **单文件 ≤ 3 MB / 总量 ≤ 12 MB** / 单图集 ≤ 4096²（目标 ≤ 2048²）/ 图集数 ≤ 12 · 世界 HD 图集 **9 张** · 纹理过滤 = **全局默认保持 `nearest`** + **HD 世界美术按纹理设 `linear` + mipmap**。

**核心工程动作集中在五处**：① 资产结构与命名契约的重定义（含掉落物 id 迁到 `fx.pickup.*`）；② `TILE_NATURAL_PX` 与纹理过滤策略的调整；③ `GameRenderer` 的墙体 autotile + 深度内嵌（**不新增任何节点**）；④ 与被替换资产耦合的测试套件改写（**结构断言可改、契约断言不得放宽**）；⑤ 像素资产 / 生成器 / 源包的彻底移除与许可重登记。

**全部决策与备选**见 `research.md`；两位成员的专业交付物见 `design/`。

## Technical Context

**Language/Version**: TypeScript 5.7（`strict`）· Node ≥ 22 · ESM

**Primary Dependencies**:
- 表现层：`pixi.js ^8.21.0` + `howler ^2.2.4` —— **本特性 MUST NOT 新增任何依赖**（用户裁定：动画路线为逐帧位图序列，不引入 Spine 等骨骼运行时）。
- 逻辑内核 `src/`：零运行时依赖（宪法「技术栈与架构约束」）。

**Storage**: 本地文件资产。清单以 Vite 静态导入（`?url` / JSON）在**构建期**解析；无后端、无 CDN、无运行时 `fetch`（FR-021 / SC-012）。

**Testing**: Vitest 2.1.8，`pool: 'threads'`、`environment: 'node'`（无 jsdom）、`setupFiles: ./tests/harness/setup-config.ts`。基线 **893 例全绿**；本特性后总数 MUST ≥ 893（FR-029）。

**Target Platform**: 桌面浏览器（WebGL · PixiJS v8 渲染管线）。窗口尺寸可变，配合 M17（`specs/025`）的相机缩放与视口自适应。

**Project Type**: 单仓库前端游戏 —— **冻结的 headless ECS 内核（`src/`）+ 独立表现层（`client/`）**。二者单向依赖（`client → src`）。

**Performance Goals**:
- 约 150 敌人同屏的压测场景下，表现层**每帧耗时中位数**的「改动后 / 改动前」**比值 ≤ 1.2**（同机、同场景、同一脚本、连续 3 次取中位数；宪法 Principle IV 禁用绝对墙钟阈值）。
- 高清图集的加载 MUST NOT 阻塞游戏循环（FR-006 / FR-022）。

**Constraints**:
- `src/` **改动文件数 = 0**（FR-011 / SC-007）；17 段管道段数与顺序不变（FR-014）。
- 依赖方向单向，`GameRenderer` 导入图 MUST NOT 含 `howler`（宪法 Principle V）。
- **唯一资产引用点**：全仓库只有 `client/assets/manifest.ts` 引用资产文件（FR-019）。
- 许可合规：开放许可或本仓库原创，逐项登记；MUST NOT 含商业游戏专有资产（FR-023）。
- 离线可用、外部请求数 = 0（FR-021）。
- 渲染场景图 **6 条冻结契约** MUST NOT 被破坏；新增节点只能**惰性挂载**或**常驻 + 显式同步钉桩**（FR-027）。
- 根 `tsconfig` MUST NOT include `client/`；表现层由 `tsconfig.client.json` + `npm run typecheck:client` 覆盖。
- 五道闸门 MUST 全绿：`npm test` · `npm run typecheck` · `npm run typecheck:client` · `npm run lint` · `npm run build`。

**Scale/Scope**:
- 角色动画：`player.base`（4向 × 6动作 = **24 个动画键**，148 帧）+ 6 个敌人 sprite id（`enemy.{grunt,elite,raider,bomber,gunner,unknown}`，各 4向 × 4动作 = 16 键 ≈ 92 帧，`dash` 别名 `move`）。
- 场景：地面 tile 变体集（8 变体）+ 墙体 autotile 部件集（8 邻 47 部件；4 邻 16 例回落），基准 tile **128×128**。
- 局内特效：`fx.spark`（**保持 `Graphics`**）、`fx.dash-trail`、`fx.hazard-ring`、伤害数字字形、掉落物 `fx.pickup.{gold,heal,darkness}`。
- 资产体积：世界 HD 图集 **9 张**，全量估算 ≈ 9.64 MB（上界），预算 ≤ 12 MB。
- 明确**不在范围**：界面（`ui.*`）与音频（`sfx.*`）保持现状（FR-030），但其清单条目与既有测试仍须通过。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 判定 | 论证 |
|------|------|------|
| **I. 逻辑内核零浏览器依赖** | **PASS** | 本特性 `src/` 改动文件数 = 0，不触碰 DOM/随机/墙钟。全部资产与渲染逻辑落在 `client/`。 |
| **II. 确定性模拟** | **PASS** | 不改组件/系统/`World`/`snapshot()`。要求以固定种子 + 固定输入序列证明状态序列与快照摘要逐位不变（FR-012 / SC-006）。 |
| **III. 17 段固定管道** | **PASS** | 无段增删或重排（FR-014）；不新增事件，故 `createDefaultSystems` 签名不变。 |
| **IV. 测试先行与证据化验证** | **PASS（须落实）** | 性能验收用**比值**口径（SC-010）；`src/` 零改动用**快照摘要逐位自证**（SC-006），不靠「既有测试全绿」推断；测试改写 MUST NOT 靠删除断言降强度（FR-029）。 |
| **V. 表现层隔离** | **PASS（须落实）** | 全部改动在 `client/`；渲染器仍为 `World` 只读消费者（`selectSprite` 的只读契约由 `tests/assets/sprite-map.test.ts` 守护）；`GameRenderer` 导入图不含 `howler`（由 node 渲染套件守护）；`client/` 变更过 `typecheck:client`。 |
| **VI. 既有核心不可重构** | **PASS** | 不重构组件/系统/预制体/管道。等价目标一律在 `client/` 内实现（例如敌人类型仍由「能力签名」只读推断，不向实体写入类型标签）。 |

**闸门结论：PASS**（无未论证的违规）。Phase 1 设计完成后须**复核**一次。

## Project Structure

### Documentation (this feature)

```text
specs/026-hd-2d-art-assets/
├── spec.md                       # 已冻结（/speckit.specify 产出）
├── plan.md                       # 本文件
├── research.md                   # Phase 0 产出：决策与理由
├── data-model.md                 # Phase 1 产出：资产实体与映射
├── quickstart.md                 # Phase 1 产出：端到端验收指南
├── contracts/                    # Phase 1 产出：接口契约
│   ├── hd-asset-manifest.md          # 清单条目 / 命名空间 / 降级语义
│   ├── hd-spritesheet-schema.md      # 图集 JSON schema 与命名契约
│   ├── tilemap-autotile.md           # 墙体部件选择与深度/透视规则
│   └── renderer-asset-mapping.md     # 状态 → 高清资产 的只读映射（承接 024）
├── design/                       # 成员专业交付物（本特性新增，非 speckit 标准件）
│   ├── art-direction.md              # 美术总监：高清美术资产规格书
│   └── engineering-architecture.md   # 技术总监：渲染层接入架构与测试改写方案
├── checklists/
│   └── requirements.md           # 规格质量校验（已全部通过）
└── tasks.md                      # Phase 2 产出（/speckit.tasks，不由本命令创建）
```

### Source Code (repository root)

```text
# ── 冻结层：本特性改动文件数 = 0 ──────────────────────────────
src/                              # headless ECS 内核（17 段管道）
├── ecs/                          # Entity / World / components / systems
├── core/                         # GameSimulator
└── ...

# ── 表现层：本特性的全部改动落点 ──────────────────────────────
client/
├── assets/
│   ├── manifest.ts               # 唯一资产引用点：换成 HD 图集/贴图导入
│   ├── AssetCatalog.ts           # 加载 + 逐条目降级 + 纹理过滤策略
│   └── sprite-map.ts             # 状态 → spriteId/action/facing 的纯映射（命名契约）
├── GameRenderer.ts               # 主战场：角色动画、HD tilemap、墙体深度分层、特效
├── VFXManager.ts                 # 局内特效
├── main.ts                       # 启动装配（渲染器 + 资源加载）
├── GameLoop.ts / ClientEventBridge.ts / KeyboardInput.ts
└── UIManager.ts / AudioManager.ts / SaveStore.ts   # 界面与音频：本特性不动

# ── 资产：像素资产/生成器/源包 被移除，HD 资产接入 ─────────────
assets/
├── art/
│   ├── hd/                       # 新增：HD 图集与贴图（本特性唯一的世界美术来源）
│   ├── LICENSES.md               # 许可登记（逐 id 可追溯）
│   ├── atlas/                    # 删除：旧像素图集（*.png + *.json）
│   ├── raw/                      # 删除/退役：像素源素材包
│   ├── ui/                       # 保留：界面贴图（不在范围）
│   └── tools/build-atlas.py      # 删除：像素派生生成器
├── audio/                        # 保留（不在范围）
└── data/                         # 保留：业务数值 JSON（逻辑层数据，不动）

# ── 测试 ─────────────────────────────────────────────────────
tests/
├── assets/                       # 允许更新（结构性断言：图集形态/体积/许可白名单）
│   ├── manifest.test.ts
│   ├── licenses.test.ts
│   ├── sprite-map.test.ts        # 只读/确定性契约：MUST NOT 放宽
│   └── degradation.test.ts       # 降级契约：MUST NOT 放宽
├── render/                       # *_art 允许更新；其余（相机/插值/桥接）不动
│   ├── player_art.test.ts / enemy_art.test.ts
│   ├── tilemap_art.test.ts / fx_art.test.ts
│   ├── camera_zoom_*.test.ts     # ⚠️ 见 Complexity Tracking：过滤策略的影响面
│   ├── interpolation.test.ts / renderer_bridge.test.ts / juice_*.test.ts
├── harness/art-fixtures.ts       # 夹具：REAL 图集结构 + 假 loader（结构变则随改）
└── ...                           # 其余（combat/ai/physics/core/...）零改动
```

**Structure Decision**:

沿用既有的**双层单仓库**结构，不新增项目、不新增构建目标：

- **冻结层 `src/`** —— 一行不改。所有「看起来需要改内核」的需求（敌人分类、动作状态、碰撞尺寸）都在 `client/` 侧以**只读投影**解决：敌人类型继续由 `sprite-map.ts` 的「能力签名」表推断（`tests/assets/sprite-map.test.ts` 已冻结该表），动作继续由 `ActionState` + `DeadTag` 投影，身体尺寸继续由 **hurtbox 半径** 驱动（`hurtboxSpriteScale`）——这正是 FR-008「视觉边界 == 碰撞边界」的既有机制，HD 资产必须复用它而非另立一套尺寸。
- **表现层 `client/`** —— 改动集中四文件：`assets/manifest.ts`（清单换成 HD 图集）、`assets/AssetCatalog.ts`（纹理过滤策略 + 多图集装载）、`assets/sprite-map.ts`（若命名/动作集需扩展）、`GameRenderer.ts`（角色动画、HD tilemap、墙体深度分层）。
- **资产 `assets/art/`** —— 新增 `hd/` 子目录承载全部 HD 图集与贴图；删除 `atlas/`、`raw/`、`tools/build-atlas.py`；`ui/` 与 `assets/audio/` 保持不动。
- **测试 `tests/`** —— 结构性断言（图集形态、体积预算、许可白名单、tilemap 节点构成）随实现更新；**契约性断言**（只读、确定性、降级回几何、场景图 6 条冻结契约、不得出现专有资产）一律保持原强度。

## Complexity Tracking

> 本表登记**经规格显式授权的偏离**，以及需要用户/评审确认的影响面。

| 偏离 / 影响面 | 为何必要 | 更简单的替代为何被否决 |
|---|---|---|
| **改写 `tests/assets/*` 的结构性断言**（图集「PNG + 同名 JSON」形态、`raw/` 包数 ≥ 5、体积 ≤ 6MB/≤ 1MB、许可恰为 `CC0-1.0`） | 这些断言编码的正是**被本特性移除的像素管线**：像素源包被删、`build-atlas.py` 被删、HD 图集体积必然超 6MB。规格 FR-029 已显式授权更新。 | 「保持断言原样」⇒ 必须保留像素源包与体积上限，与 FR-016/017/018「彻底移除」及 FR-024「预算重定」直接冲突，且用户已裁定「893 为下限、允许更新资产/渲染测试」。 |
| **体积预算上调**（数值见 research.md，由美术规格与 WebGL 纹理上限共同定） | 高清逐帧资产在 6MB / 1MB 内无法容纳（四向 × 多动作 × 多角色）。规格 FR-024 / SC-014 授权「以构建产物实测为准」。 | 保持 6MB ⇒ 只能维持低分辨率，FR-001/007 的「高清」不可达成。 |
| **`TILE_NATURAL_PX` 由 16 改为 HD 基准 tile 尺寸** | 该常量是「贴图自然像素 ↔ 世界单位」的换算基准（`PX_PER_UNIT / TILE_NATURAL_PX`）。HD 贴图改变其自然尺寸，常量必须同步，否则贴图被错误缩放。 | 不改 ⇒ HD tile 被放大/缩小到错误尺寸，FR-009「按房间实际尺寸铺展、不拉伸」不成立。 |
| **纹理过滤策略：`TextureSource.defaultOptions.scaleMode`** | M17 为像素锐利把全局默认设为 `'nearest'`，并由 `tests/render/camera_zoom_sharpness.test.ts` 以**字面量 `'nearest'`** 钉死；HD 美术需要 `linear`（FR-025）。该测试**不在**用户授权的 `tests/render/*_art` 集合内。 | **已定案（`research.md` D7）：全局默认保持 `'nearest'`，改为按纹理为 HD 世界美术显式设 `linear` + mipmap。** M17 冻结测试**零改动**继续通过，同时满足 FR-025 并消除缩小摩尔纹。**无需扩权。** |
| **`tests/render/fx_art.test.ts` 的「粒子必须是 `Graphics`」契约** | 该测试显式守护「frozen particle contract」（火花粒子保持 `Graphics`）。HD 特效若把火花改成 `AnimatedSprite` 即与之冲突。 | **已定案（`research.md` D11）：`fx.spark` 保持 `Graphics`**，HD 质感落在纹理填充与绘制参数上；HD 化作用于非粒子元素（拖尾 / 危险预警 / 掉落物 / 伤害数字）。既有粒子契约**零改动**。 |
| **掉落物 id 由 `ui.icon.*` 迁到 `fx.pickup.*`** | 掉落物渲染在**世界空间**，与 HUD 的屏幕空间图标是两回事；挂在 `ui.` 下会与 FR-030「UI 不动」的边界自相矛盾。 | **已定案（`research.md` D4，用户裁定 P3）**：新设 `fx.pickup.{gold,heal,darkness}`。改动 `sprite-map.ts::pickupIconId` 的返回值字面量 + 清单条目；`tests/assets/sprite-map.test.ts` 的**三条断言强度不变**，仅更新 id 字面量。 |
| **`tests/render/tilemap_art.test.ts` 的「wall node 子节点数 == cols×rows」** | 墙体深度改为「格内三带」后，每个 wall node 内部由「N 个平铺 tile」变为「N 个三带部件」。 | 属 `*_art`（用户已授权更新）。**`staticLayer.children.length === 1 + wallCount` 与 F1–F6 六条冻结契约 MUST NOT 放宽**（`research.md` D10）。 |

## Constitution Check（Phase 1 设计后复核）

*GATE: Phase 0 前已判定 PASS；此处为设计完成后的复核。*

| 原则 | 复核判定 | 复核依据（设计已定案） |
|------|---------|----------------------|
| **I. 逻辑内核零浏览器依赖** | **PASS** | 设计不含任何 `src/` 改动；资产加载与渲染全在 `client/`。 |
| **II. 确定性模拟** | **PASS** | 掩码推导、地面变体选择均为**确定性哈希**，显式禁止消费 `World.rng`（`contracts/tilemap-autotile.md` §4/§7）；无损证明用摘要 `f52dfdd4`（`research.md` D21）。 |
| **III. 17 段固定管道** | **PASS** | 渲染完全在 `step()` 之外；不新增事件、不改 `createDefaultSystems`。 |
| **IV. 测试先行与证据化验证** | **PASS** | 性能用交错**比值** ≤ 1.2（D20）；无损用**摘要逐位**自证（D21）；测试改写区分**结构断言（可改）** vs **契约断言（不得放宽）**（R8 风险项有明确缓解）。 |
| **V. 表现层隔离** | **PASS** | 依赖单向；渲染器仍为只读消费者；`GameRenderer` 导入图不含 `howler`；`client/` 过 `typecheck:client`；`sprite-map.ts` 保持纯函数（仅 `pickupIconId` 返回值字面量变更）。 |
| **VI. 既有核心不可重构** | **PASS** | 不重构组件/系统/预制体/管道；敌人分类继续用**能力签名只读推断**（D16），不向实体写入类型标签。 |

**闸门结论：PASS**（无未论证的违规）。**无新增运行时依赖** ⇒ 技术栈条款无需修订。

## 生成物索引

| 产物 | 说明 |
|---|---|
| `spec.md` | 已冻结的特性规格（**8** 用户故事 · 31 FR · **16** SC） |
| `plan.md` | 本文件 |
| `research.md` | Phase 0：22 条决策（D1–D22）+ 冲突仲裁 + 风险登记 |
| `data-model.md` | Phase 1：7 个实体 · 25 条校验规则 · 「不引入的数据」清单 |
| `contracts/hd-asset-manifest.md` | 清单形状 · 命名空间 · 引用点唯一性 · 降级 · 许可 · 体积 · 图集形态 |
| `contracts/hd-spritesheet-schema.md` | 图集 schema · 命名契约 · 必须存在的动画键 · 切分 · 过滤 · 循环语义 |
| `contracts/tilemap-autotile.md` | 基准换算 · 格内三带 · 位掩码 autotile · 渲染落地 · 场景图约束 |
| `contracts/renderer-asset-mapping.md` | 只读性 · 朝向量化 · 动作投影 · 敌人签名表 · 回退链 · hurtbox 尺寸 · 过滤 · 掉落物 id |
| `quickstart.md` | V1–V10 端到端验收剧本 |
| `design/art-direction.md` | 美术总监交付物（A–E 全节 + 附录） |
| `design/engineering-architecture.md` | 技术总监交付物（D1–D12 决策 + 逐文件测试改写 + Epic 骨架） |
| `tasks.md` | **未生成** —— 由 `/speckit.tasks` 产出 |
