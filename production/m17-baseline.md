# M17 · 相机缩放与视口自适应 —— 改动前基线证据

**Feature**: `specs/025-camera-zoom-viewport` · **Task**: T001 / T002 · **Date**: 2026-10-02
**Git**: `main` @ `539d96a`（工作树中 `specs/025-*` 与 `.specify/` 为未跟踪新增，未提交）

本文件冻结**改动前**的可复现基线。M17 的全部验收断言（SC-004 / SC-006 / FR-017 / FR-018）
都以本文件的数字为对照。任何一条基线在改动后发生变化，都必须在 `m17-evidence.md` 中正面解释。

---

## 1 五道闸门（改动前）

| # | 命令 | 结果 | 备注 |
|---|---|---|---|
| 1 | `NO_COLOR=1 npm test` | ✅ **803 passed / 50 files**，失败 0、跳过 0 | 耗时 ≈ 24.4s |
| 2 | `NO_COLOR=1 npm run typecheck` | ✅ 通过（`tsc --noEmit`，无输出） | 逻辑层 + 测试，无 DOM lib |
| 3 | `NO_COLOR=1 npm run typecheck:client` | ✅ 通过（`tsc --noEmit -p tsconfig.client.json`） | 表现层，含 DOM lib |
| 4 | `NO_COLOR=1 npm run lint` | ✅ 通过（`eslint .`，无输出） | 含 `src/**` 的无头 / 确定性 / 单向依赖 AST 门禁 |
| 5 | `NO_COLOR=1 npm run build` | ✅ `✓ built in 10.11s` | `dist/assets/index-B7yK6Zaz.js` 542.29 kB（gzip 147.09 kB） |

> `build` 的 chunk-size 警告是既有的（>500 kB 提示），与本次改动无关。

## 2 工作树状态（改动前）

```console
$ git diff --stat src/ client/ tests/
(空输出)
```

⇒ `src/` / `client/` / `tests/` **三处均零改动**。这是「逻辑内核冻结 + 既有测试零改动」判据的起点。

## 3 管道钉桩计数（改动前）

```console
$ grep -rl "'TransformSnapshotSystem'" tests/ | wc -l
13
```

命中的 13 个文件（升序）：

```
tests/ai/enemy_fsm.test.ts
tests/combat/aoe_and_lifecycle.test.ts
tests/combat/armor_and_dash.test.ts
tests/combat/boons.test.ts
tests/combat/death_and_encounter.test.ts
tests/combat/economy_and_victory.test.ts
tests/combat/feedback.test.ts
tests/combat/status_effects.test.ts
tests/meta/meta_progression.test.ts
tests/physics/advanced_ballistics.test.ts
tests/physics/walls_and_projectiles.test.ts
tests/render/interpolation.test.ts
tests/world/tilemap_and_topology.test.ts
```

> ⚠️ **基线订正**：`tasks.md` T028 与 `quickstart.md` §2 沿用 M16 时的口径写「**9 处**」。
> 实测（本文件，2026-10-02，`539d96a`）为 **13 个文件**——`meta_progression` / `advanced_ballistics`
> / `interpolation` / `tilemap_and_topology` 四个套件在 M16 之后也加入了同一钉桩。
> 判据不变，只是数字要用**实测值 13**：改动后仍须为 **13**，且这 13 个文件的内容**逐字节不变**。

## 4 场景图冻结契约（F1–F6）的机器守卫位置

| ID | 契约 | 既有守卫（本特性 MUST NOT 触碰） |
|---|---|---|
| F1 | `stage.children` 长 1 且 `[0] === camera` | `tests/render/camera_adversarial.test.ts` C2/C3 |
| F2 | `camera.children[last] === root` | `camera_adversarial` C3/C7、`camera_follow` |
| F3 | `root.children[last] === fxLayer` | `camera_adversarial` C6、`juice_m14` |
| F4 | `root.children[0]` = 首个实体视图 | `renderer_bridge`、`interpolation` |
| F5 | 无墙时 `camera.children` 长**恰 1** | `camera_adversarial` C7 |
| F6 | 空闲时 `fxLayer.children` 长**恰 0** | `juice_m14`、`fx_art` |

## 5 最脆弱的三条既有断言（M17 的零回归枢纽）

| # | 断言 | 位置 | M17 的规避机制 |
|---|---|---|---|
| 1 | `camera.x ≈ screen/2 − playerPx`（`toBeCloseTo(…, 6)`） | `camera_follow` G2、`camera_adversarial` C1 | 无 `screen` 替身 ⇒ `hasViewport === false` ⇒ `zoomActive === false` ⇒ `z = 1`、不进入取景模式、旧公式逐位相同 |
| 2 | 带 `screen`(800×600) 但**无墙** ⇒ `camera.x ≈ 385` | `camera_adversarial` C4 | 有视口但 `hasRoomExtent === false` ⇒ 退化。**这是谓词必须同时要求「有墙」的直接原因** |
| 3 | 墙块 `x === wall.x × PX_PER_UNIT`（**局部**坐标） | `camera_follow` G3、`tilemap_art` | `z` 只写 `cameraContainer.scale`，墙节点局部坐标不动 |

## 6 对照用常量（源码实测，非假设）

| 常量 | 值 | 位置 |
|---|---|---|
| `PX_PER_UNIT` | `10` | `client/GameRenderer.ts:115` |
| `CAMERA_LERP_FACTOR` | `0.2` | `client/GameRenderer.ts:128` |
| `SHAKE_DURATION_MS` / `SHAKE_INTENSITY` | `180` / `6` | `client/GameRenderer.ts:159` / `:162` |
| `screenWidth()` / `screenHeight()` | 守卫读 `app.screen`，不可读 ⇒ `0` | `client/GameRenderer.ts:1312` / `:1319` |
| pixi.js | `8.21.0`（`node_modules` 实测） | `package.json` |
| `TextureSource.defaultOptions` | 存在；`TextureSourceOptions extends TextureStyleOptions`，后者含 `scaleMode?: SCALE_MODE` | `node_modules/pixi.js/lib/rendering/renderers/shared/texture/sources/TextureSource.d.ts:117` |
| `TextureSource` 运行时合并点 | `options = { ..._TextureSource.defaultOptions, ...options }` | `.../TextureSource.js:109` |

**Checkpoint**：基线可复现，零回归判据已落盘（T001 / T002 完成）。
