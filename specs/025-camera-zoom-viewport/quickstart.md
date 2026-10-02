# Quickstart · 相机缩放与视口自适应（M17）

**Feature**: `025-camera-zoom-viewport` · **Date**: 2026-10-02

本文件是**验证 / 运行指南**：列出能证明特性端到端成立的场景、命令与预期结果。设计细节见 [plan.md](./plan.md)、[research.md](./research.md)、[data-model.md](./data-model.md) 与 [contracts/](./contracts/)；任务拆解见 `tasks.md`（由 `/speckit.tasks` 生成）。

---

## 0. 前置条件

```bash
npm install                 # 依赖已含 pixi.js 8.21 / howler 2.2
npm run dev                 # 或 npm run build + npm run preview
```

- 目标视口以 **1920×1080** 与 **2560×1440** 为主（SC-001 / SC-002）。
- 浏览器需支持 `devicePixelRatio`（高 DPI 验收用；可用 DevTools 的 device emulation 调 DPR）。
- 运行任何命令时统一加 `NO_COLOR=1`（本项目约定）。

## 1. 五道闸门（每次改动后必跑）

```bash
npm test                    # 既有 803 例 + 表现层新增用例
npm run typecheck           # 逻辑层 + 测试（无 DOM）
npm run typecheck:client    # 表现层（含 DOM lib）
npm run lint                # 含 src/ 的无头 / 确定性 / 单向依赖 AST 门禁
npm run build               # Vite 生产构建
```

**预期**：五条全绿。`lint` MUST 报告 `src/**` 无违规。

## 2. 核心合规检查（对应 FR-012 / FR-015 / FR-016 · 宪法 I / III / VI）

```bash
git diff --stat src/                                   # 预期：空输出
grep -rn "'TransformSnapshotSystem'" tests/ | wc -l    # 预期：9（管道钉桩未动）
```

**预期**：`src/` 零改动；17 段管道不变；`GameRenderer` 导入图不含 `howler`。

## 3. 既有测试零回归（对应 FR-017 · SC-006）

```bash
NO_COLOR=1 npm test -- tests/render/
```

**预期**：`renderer_bridge` / `camera_follow` / `camera_adversarial` / `interpolation` / `juice-verify` / `juice_m14` / `enemy_art` / `player_art` / `fx_art` / `tilemap_art` **一行不改**、全部通过；F1–F6 逐条成立。全量 `npm test` 期望 **803 例 100% 通过，失败 0、新增跳过 0**。

**尤其核对**（最脆弱的三条）：
- `camera_follow` G2 / `camera_adversarial` C1：`toBeCloseTo(..., 6)` 的跟随收敛（无 `screen` ⇒ `z = 1`）。
- `camera_adversarial` C4：带 `screen`(800×600) 但**无墙** ⇒ `camera.x ≈ 385`（退化路径，不缩放、不进入取景模式）。
- `camera_follow` G3 / `tilemap_art`：墙块 `x === wall.x × PX_PER_UNIT`（局部坐标不随 `z` 变）。

## 4. 视觉验收（浏览器，对应 SC-001 / SC-002 / SC-008）

```bash
NO_COLOR=1 npm run dev      # http://localhost:5173
```

| # | 场景 | 预期 | 对应 |
|---|---|---|---|
| V1 | 1920×1080 打开起始房间（`start_room` 10×10） | 房间**完整可见、居中**，短边约占视口短边 **80%**（∈ [55%, 85%]），无裁剪 / 溢出 | SC-001 · FR-002/004 |
| V2 | 2560×1440 打开同一房间 | 房间大小合适、内容清晰可读（与 V1 观感一致） | SC-002 |
| V3 | 在房间内四向移动、冲刺、攻击 | 地板 / 墙 / 玩家 / 敌人 / 投射物 / 预警 / 掉落 / 特效 / 跳字**同倍率**放大，相对尺寸不变形 | FR-001 / FR-005 |
| V4 | 在房间内移动（含走到边缘） | **房间静止不动、保持居中**；玩家位移直接体现为屏幕位移；房间边缘不裁剪、不溢出、不漂移（房间模式） | FR-004 / SC-001 |
| V5 | DevTools 设 32:9 与 9:16 视口 | 以受限方向 fit，房间完整可见、内容可辨 | FR-011 / SC-008 |
| V6 | 清房推进到 `arena_room`(12×10)、`?mode=stress` 进 `stress_room`(30×30) | 各自按比例放大、可读，无荒谬的过度缩放 | FR-003 / US1 AS4 |
| V7 | 观察取景模式（现有三房 vs. 人造超大房） | 现有房间（10×10 / 12×10 / 30×30）均走**房间模式**（房间居中且静止）；仅当房间大于视口（如人造 > 86 世界单位房）时走**跟随模式**（玩家居中 + 钳制边界） | FR-004 |

## 5. HUD / 覆盖层跨倍率不变（对应 FR-006 / FR-007 · SC-003）

在 V1/V6 各场景下，逐一切换房间（世界倍率随之变化），核对：

| 界面面 | 预期 |
|---|---|
| 金币读数（`#gold`）、生命 HUD（`#hud`） | 屏幕位置与尺寸**与缩放前一致**；文字清晰、无模糊 / 锯齿放大 / 非等比拉伸 |
| 奖励三选一（`#ui-layer.is-visible`） | 屏幕空间呈现，**不随**世界缩放变化 |
| 死亡 / 胜利 / 营地覆盖层 | 同上 |

**预期**：世界缩放取遍上下限之间多个倍率时，HUD 与覆盖层的屏幕位置 / 视觉尺寸相对基线变化为 **0**。

## 6. 视口变化自动重适配（对应 FR-010 · SC-005）

在运行中拖动窗口 / 切换全屏 / 用 DevTools 从 **800×600 → 3840×2160** 连续改变视口：

**预期**：画面**无需刷新**即重新适配；房间**始终完整可见**（裁剪 / 溢出发生次数 = 0）；无肉眼可辨的跳变或闪烁。

## 7. 高 DPI 与保锐采样（对应 FR-008 / FR-009）

在 DevTools 把设备像素比设为 **2×** 后重复 V1：

**预期**：画面与设备像素比匹配呈现（**不因缩放变糊**）；像素美术放大后**边缘锐利**，无肉眼可辨的模糊或渗色（`scaleMode: 'nearest'` 生效）。

## 8. 玩法逐位不变（对应 FR-012 / FR-013 · SC-004）

在固定种子与固定输入序列下，分别以「不渲染」与「渲染（含缩放）」运行同一段模拟，比较状态序列：

```bash
# 既有确定性对拍套件（真 GameSimulator）应保持全绿
NO_COLOR=1 npm test -- tests/performance/ tests/harness/
```

**预期**：两次产生的状态序列**逐 Tick 完全一致（差异处数 = 0）**；渲染层不写 `World`（`git diff --stat src/` 空）。

## 9. 压测与性能（对应 FR-018 · SC-007）

```bash
NO_COLOR=1 npm run dev      # 打开 http://localhost:5173/?mode=stress
```

同机、同场景（30×30 房间 + 约 150 敌）、同一脚本下，对比改动前后**每帧 CPU 耗时**，连续 3 次取中位数：

**预期**：**改动后 / 改动前 ≤ 1.2**（预期 ≈ 1.0，缩放重算为 `O(1)` 且复用既有包围盒）。判定 MUST 用**比值**，MUST NOT 用绝对墙钟（宪法 IV）。

## 10. 震动与缩放共存（对应 FR-019 · SC-009）

在 V1 场景下制造命中（触发屏幕震动），同时观察世界缩放：

**预期**：震动正常衰减到 0、**不使缩放漂移**；缩放**不改变**震动的衰减语义（两者互不干扰）。既有 `juice_m14` 的震动断言保持全绿。

## 11. 退化路径（对应 FR-014 / FR-021 · US5 AS4）

| # | 操作 | 预期 |
|---|---|---|
| D1 | 在无 `screen` 的替身下运行既有渲染套件 | `z === 1`、不进入任何取景模式、目标 = 旧公式，逐位等价 |
| D2 | 无墙世界 / 营地（`isInHub`）/ 加载间隙 | `z === 1`，不抛错、不阻塞渲染 |
| D3 | 视口退化为 0 / 负 / `NaN` / `Infinity` | `z === 1`，无除零 / `NaN` / 无穷倍率 |
| D4 | 运行中反复快速缩放窗口 | 无抖动、撕裂或闪烁 |

---

## 快速排障

| 症状 | 可能原因 | 处置 |
|---|---|---|
| 渲染套件失败（收敛断言） | 退化路径未逐位等价（`z ≠ 1` 或误入取景模式） | 核对退化谓词：无 `screen` **或** 无墙 ⇒ `z = 1`、不进入取景模式（contracts/zoom-fit-and-degradation §3） |
| `camera_adversarial` C4 失败 | 把「有视口」误判为「缩放激活」 | 谓词必须**同时**要求 `hasRoomExtent`（C4 有视口但无墙） |
| 场景图契约失败 | 新增了常驻场景节点 | 缩放只写 `cameraContainer.scale`，不新增节点（contracts/scene-graph-and-screen-space §3.1） |
| 某测试报「读了 `app.renderer`」 | 在同步路径访问了 `app.renderer`（如挂 resize 事件） | 每帧重算 `z`（读 `app.screen`），不挂 `renderer` 事件（research.md D6） |
| 像素美术发糊 / 渗色 | `scaleMode` 仍是 `linear` | 加载纹理前设 `TextureSource.defaultOptions.scaleMode = 'nearest'`（research.md D5） |
| 高 DPI 屏发糊 | 未设 `resolution` / `autoDensity` | `app.init({ resolution: devicePixelRatio, autoDensity: true })`（research.md D5） |
| 房间在 1080p 仍很小 | 房间范围未被识别（无墙 / 营地） | 确认 `LevelLoader.enterRoom` 已装配房间；确认非 `isInHub` |
| 玩家移动时房间在屏幕上漂移 | 误入跟随模式（房间模式未生效） | 核对 `roomFits` 判定：房间可容纳 ⇒ 房间模式（`target` = 房间中心，与玩家位置无关）（contracts/zoom-fit-and-degradation §3） |
| 房间被裁 / 溢出 | `roomFits` 判定错误或 `bounds` 计算错 | 房间模式 ⇒ 房间居中静止（不会裁）；跟随模式 ⇒ 核对 `bounds` 与「先钳制后 lerp」顺序（contracts/camera-view-transform §2） |
