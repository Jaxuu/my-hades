# Implementation Plan: 真实 2D 美术与音效资产接入

**Branch**: `024-real-art-assets` | **Date**: 2026-10-01 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/024-real-art-assets/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command; its definition describes the execution workflow.

## Summary

把表现层（`client/` + `index.html`）中所有占位几何图形与代码合成占位音，替换为一套**本地、开放许可（CC0）**的真实 2D 美术与音效资产：玩家为带动画的人物、5 类敌人各有专属怪物形象、墙体/地面为 Tilemap 场景纹理，另加全部局内特效（火花/预警/掉落物）与全部界面（HUD / 奖励三选一 / 死亡 / 胜利 / 营地）。

技术路线（详见 [research.md](./research.md)）：在 `assets/art/**` 与 `assets/audio/**` 落盘 CC0 资产 → 经 Vite 资产导入 + 生成式清单（manifest）→ 表现层加载器（try/catch 逐个降级）→ PixiJS v8 `Assets.load` + `Spritesheet` + `AnimatedSprite` 驱动世界空间渲染 → 界面侧保留 DOM 结构、以 CSS + 美术资产重皮。**模拟核心 `src/` 零改动**，17 段管道不变，6 条渲染场景图冻结契约不变。

## Technical Context

**Language/Version**: TypeScript 5.7（`strict`）· Node ≥ 22 · ES2022（`client/` 额外含 DOM lib）

**Primary Dependencies**: pixi.js 8.21（渲染）· howler 2.2（音频）· vite 5.4（构建/资产管线）· vitest 2.1.8（测试，`pool:'threads'`）。`src/` 保持零运行时依赖。

**Storage**: 无后端、无数据库。资产以文件形式随仓库本地分发：`assets/art/**`（精灵/图集/瓦片/UI）、`assets/audio/**`（音效）。既有 `assets/data/*.json` 数据表不变。

**Testing**: vitest（node，`pool:'threads'`）。逻辑层沿用真实 `GameSimulator`；表现层沿用「鸭子类型 `Application` + 真 PixiJS 场景图」的既有 node 渲染套件模式（`tests/render/*`）。新增：资产清单/映射纯函数单测 + 渲染降级单测。五道闸门：`npm test` · `typecheck` · `typecheck:client` · `lint` · `build`。

**Target Platform**: 桌面浏览器（`vite dev` / `vite build` 产物）。离线可用，无外部服务。

**Project Type**: 单仓库 Web 前端（headless 逻辑内核 `src/` + 表现层 `client/`），非前后端分离。

**Performance Goals**: 既有压测场景（30×30 房间 · 约 150 敌 · ~174 实体）下表现层无可感知退化；动画播放不产生每帧新对象；图集化以压低 draw call。

**Constraints**:
- **模拟核心冻结**：`git diff --stat src/` 必须为空；17 段管道不变；同种子同输入逐 Tick 状态一致（快照摘要逐位相同）。
- **单向依赖**：`client → src` 允许；`src → client` 永不出现（ESLint AST 门禁）。
- **6 条渲染场景图冻结契约**（F1–F6）不得破坏；禁新增**常驻**场景节点。
- **`howler` 导入图隔离**：仅 `client/AudioManager.ts` 可 import howler；`GameRenderer` 导入图不得含 howler。
- **许可**：全部资产必须 CC0 / 公共领域 / 明确允许再分发，且逐项登记来源与许可。
- **离线**：运行期零外部请求。

**Scale/Scope**: 1 名玩家形象 · 5 类敌人形象 · 1 套场景瓦片（≥3 房间尺寸：10×10 / 12×10 / 30×30）· 约 6–8 类局内特效与掉落物 · 4 个界面面（HUD / 三选一 / 终局 / 营地）· 约 8–12 条音效。资产总量目标 **< 6 MB**（图集 PNG + 短音效），不含全量 CJK 字体。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 宪法条款 | 本特性的合规判定 | 结论 |
|---|---|---|
| I. 逻辑内核零浏览器依赖 | 全部改动落在 `client/**`、`index.html`、`assets/**`、`specs/**`；`src/` 不新增任何 import | ✅ PASS |
| II. 确定性模拟 | 渲染与音频仍是只读消费者；动画以真实帧 delta 播放（与既有浮动文字/震动同模式），状态选择来自模拟层，不回写 | ✅ PASS |
| III. 17 段固定管道 | 不新增/重排任何系统段 | ✅ PASS |
| IV. 测试先行与证据化验证 | 新增映射/降级单测；渲染侧沿用真 PixiJS 场景图套件；性能用缩放比而非绝对墙钟；无损用快照摘要自证 | ✅ PASS |
| V. 表现层隔离 | 仅在 `client/` + `index.html` 扩充；单向依赖不变；渲染器不写 `World` | ✅ PASS |
| VI. 既有核心不可重构 | 不改组件/系统/World/预制体/管道 | ✅ PASS |

**关键合规风险（已消解，见 research.md）**：为 5 类敌人渲染专属形象需要「实体 → 敌人类型」的读取路径，而 `src/` 中**不存在**敌人类型组件（`TagComponent` 以**空数组**挂载）。若为此在 `src/` 里加类型标签，会改变快照摘要、破坏「无损」与冻结核心契约 ⇒ **被否决**。改用**表现层能力签名分类器**（只读组件组合推断类型），完全满足 I/II/VI。

**Gate 结论**：Phase 0 前 PASS；Phase 1 后需复检（见文末）。

## Project Structure

### Documentation (this feature)

```text
specs/024-real-art-assets/
├── plan.md              # This file (/speckit.plan command output)
├── spec.md              # Feature specification (/speckit.specify)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── asset-manifest.md
│   ├── renderer-asset-mapping.md
│   └── ui-asset-slots.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit.specify)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
assets/
├── data/                        # 既有：唯一数值来源（本特性不改）
│   ├── enemies.json             #   grunt/elite/raider/bomber/gunner
│   ├── rooms.json               #   整数网格 0 空地 / 1 墙 / 2 玩家点 / 3 刷怪点
│   └── …                        #   encounters / hazards / modifiers / projectiles / meta_upgrades
├── art/                         # 新增：美术资产（CC0）
│   ├── LICENSES.md              #   逐项来源与许可登记（SC-010 的载体）
│   ├── atlas/                   #   图集（PNG + JSON）与精灵图
│   │   ├── player.{png,json}
│   │   ├── enemies.{png,json}
│   │   ├── tiles.{png,json}
│   │   ├── fx.{png,json}
│   │   └── ui.{png,json}
│   └── ui/                      #   界面用的整图/面板（如需九宫格切片）
└── audio/                       # 新增：音效资产（CC0）
    ├── LICENSES.md
    └── sfx/*.ogg|wav

client/
├── assets/                      # 新增：资产接入层（表现层内，非 src/）
│   ├── manifest.ts              #   资产清单（id → 导入/URL + 类型 + 许可引用）
│   ├── AssetCatalog.ts          #   加载器：Assets.load + 逐个 try/catch 降级
│   └── sprite-map.ts            #   纯函数：实体/状态 → 精灵 id 与动画状态
├── GameRenderer.ts              # 改：世界空间渲染改为 AnimatedSprite（保留 Graphics 回退）
├── VFXManager.ts                # 改：火花/拖尾改用 fx 图集（保留回退）
├── AudioManager.ts              # 改：占位合成音 → 真实音效文件（保留静默降级 + howler 隔离）
├── GameLoop.ts                  # 改：AudioSink 事件集加性扩展（可选参数，保持兼容）
├── UIManager.ts                 # 改：DOM 结构不变，仅增/改 class 钩子（逻辑零改动）
└── main.ts                      # 改：boot 期 await 资产加载（失败降级，不阻塞启动）

index.html                       # 改：<style> 重皮为美术风格（按钮/面板/覆盖层/图标）

tests/
├── assets/                      # 新增：manifest / sprite-map / 降级 / 许可 单测
├── render/                      # 改：新增 player_art / enemy_art / tilemap_art / fx_art
├── audio/                       # 改：新增 audio_assets
└── ui/                          # 新增：ui_skin / text_readability
```

**Structure Decision**: 沿用既有单仓库布局，**不新建工程**。新增目录只有两处：仓库根的 `assets/art/**` 与 `assets/audio/**`（资产落盘），以及 `client/assets/**`（表现层内的资产接入层）。刻意把接入层放在 `client/` 而非 `src/`，是因为它依赖浏览器/渲染运行时，属于表现层职责；`src/` 保持零浏览器依赖。资产清单与映射函数写成**纯模块**，以便在 node 下直接单测（无需 DOM）。

## Complexity Tracking

> 无宪法违规。本节留空（未引入第 4 个项目、未引入仓储模式、未放宽任何 `src/` 门禁）。

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| （无） | — | — |

---

## Phase 0 / Phase 1 产物索引

| 产物 | 内容 |
|---|---|
| [research.md](./research.md) | D1–D10 决策：资产来源与许可、Vite 资产管线、敌人类型只读识别、动画驱动、UI 重皮路线、冻结契约规避、字体、音频、性能、降级 |
| [data-model.md](./data-model.md) | 资产清单模型、精灵视图模型、动画状态映射、许可登记、校验规则 |
| [contracts/asset-manifest.md](./contracts/asset-manifest.md) | 资产清单契约（id 命名、字段、缺失语义） |
| [contracts/renderer-asset-mapping.md](./contracts/renderer-asset-mapping.md) | 模拟状态 → 精灵/动画 的映射契约 + 回退契约 |
| [contracts/ui-asset-slots.md](./contracts/ui-asset-slots.md) | 界面面 → 资产槽位契约 |
| [quickstart.md](./quickstart.md) | 端到端验证场景与命令 |

## Constitution Check（Phase 1 设计后复检）

| 条款 | 复检判定 | 结论 |
|---|---|---|
| I. 无头内核 | 设计产物未要求任何 `src/` 改动；接入层位于 `client/assets/**` | ✅ PASS |
| II. 确定性 | 动画时钟用真实 delta（既有模式）；状态选择只读；`sprite-map` 是纯函数 | ✅ PASS |
| III. 17 段管道 | 无系统增删 | ✅ PASS |
| IV. 测试先行 | 映射/降级纯函数可 node 直测；渲染沿用真场景图套件；含变异实验与快照摘要自证 | ✅ PASS |
| V. 表现层隔离 | UI 走 DOM 重皮（不新增 Pixi 常驻节点）；图集替换 `staticLayer` 内容而非新增层 | ✅ PASS |
| VI. 核心不可重构 | 敌人类型识别改走能力签名，避免给 `src/` 加标签 | ✅ PASS |

**复检结论**：PASS，无违规需豁免。
