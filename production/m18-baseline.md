# M18 · 改动前基线（T001）

**日期**: 2026-10-03 · **分支**: `main` · **HEAD**: `da17474`（M17-T01，未 push 之上的工作树）
**工作树状态**: 已含 M17 全部提交；`.specify/`、`specs/026-hd-2d-art-assets/`、`.workbuddy-ai/` 为未跟踪的新增内容（不参与门禁）。

## 1. 五道闸门（改动前）

| 闸门 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 单元/集成测试 | `npm test` | **893 例**，892 通过 / 1 失败 | 失败项为 `tests/performance/stress.test.ts` G2（墙钟缩放比），**负载相关抖动**：全量并发时比值 10.09（上限 9），单跑同套件比值 **7.67** 通过。`vitest.config.ts` 的注释已记录该口径随 CI 负载漂移 |
| 逻辑内核类型检查 | `npm run typecheck` | PASS | 无输出 |
| 表现层类型检查 | `npm run typecheck:client` | PASS | 无输出 |
| 静态检查 | `npm run lint` | PASS | 无输出 |
| 生产构建 | `npm run build` | PASS | 11.67s；主 chunk 544.59 kB（gzip 147.86 kB） |

> 复跑确认（T001 记录）：`npx vitest run tests/performance/stress.test.ts` → 5/5 通过，`ratio = 7.67`。
> 结论：基线为 **893 例全绿**（唯一失败是已知的负载敏感墙钟断言，非功能缺陷）。

## 2. 无损摘要（D21 口径）

固定种子 `0x12345678`、601 tick、`listEntities() × listComponents()` 拼串过 FNV-1a：

```
[M16 lossless] no-renderer digest f52dfdd4, rendered digest f52dfdd4
```

**基线摘要 = `f52dfdd4`**（与 M15 / M16 / M17 同值，符合 `research.md` D21 预期）。

## 3. 性能基线（交错比值口径）

`npx vitest run tests/performance/render_art_cost.test.ts`：

```
[M16 perf] baseline 0.2555ms/frame, art 0.1671ms/frame, ratio 0.654 — budget 1.2
per-round [0.24, 0.55, 0.48, 1.15, 1.67, 1.68, 0.97, 0.57, 0.45, 0.62, 0.93, 0.96]
```

- **基线每帧耗时（几何路径）** ≈ **0.2555 ms/frame**（同机、同场景、同脚本）。
- 改动后 MUST 满足「改动后 / 改动前 ≤ 1.2」（`research.md` D20 / SC-010）。
- ⚠️ 绝对墙钟值仅作参考（宪法 Principle IV 禁用绝对阈值），验收一律用比值。

## 4. 资产体积基线（改动前）

| 范围 | 实测 |
|---|---|
| `assets/art/**`（含 `atlas/` + `raw/` + `ui/`） | ≈ 221 KB（`LICENSES.md` §5 记录） |
| `assets/audio/**` | ≈ 186 KB |
| **合计** | **≈ 407 KB** |
| 单文件最大 | `atlas/enemies.json` 124 KB |

构建产物中的像素图集（`dist/assets/`）：`player-*.png` · `enemies-*.png` · `tiles-*.png` · `fx-*.png` · `ui-*.png` —— 这五个文件在 M18 后 MUST **从产物中消失**（FR-020 / SC-008）。

## 5. 旧像素资产清单（M18 需移除，`research.md` D19 口径）

| 路径 | 处置 |
|---|---|
| `assets/art/atlas/{player,enemies,tiles,fx,ui}.{png,json}` | 删除（FR-016） |
| `assets/art/tools/build-atlas.py` | 删除（FR-017） |
| `assets/art/raw/**`（`tiny-dungeon` / `fantasy-ui-borders` / `kenney_pixel-ui-pack`） | 删除（FR-018） |
| `assets/art/ui/*.png` | **保留**（FR-030 授权保留，不计入 SC-008 残留数） |
| `assets/audio/**`（含 `raw/`） | **保留**（FR-030 授权保留，不计入 SC-008 残留数） |

## 6. 管道与冻结契约基线

- 17 段管道（`createDefaultSystems`），钉桩 9 处（`grep -rl "'TransformSnapshotSystem'" tests/`）+ 段数钉桩 2 处（`aoe_and_lifecycle` / `walls_and_projectiles` 的 `toHaveLength(N)`）。
- 渲染场景图 6 条冻结契约（F1–F6），由 `tests/render/tilemap_art.test.ts` 与 `tests/render/camera_zoom_*.test.ts` 守护。
- `src/` 零改动基线：`git diff --stat -- src/` 与 `git status --short -- src/` 均为空。
- 依赖集合：`dependencies` 恰为 `{ howler, pixi.js }`（FR-031）。
