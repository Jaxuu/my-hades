# M19 · 基线固化（T001）

**特性**：`specs/027-hud-boon-ui`（UI 层重构：材质化 HUD 与祝福交互面板）
**日期**：2026-10-03 · **执行**：程基岩（engineering-lead）
**改动前基线提交**：`8606ca5`（M18 收尾）

---

## 1. 测试基线

```
NO_COLOR=1 npx vitest run
Test Files  62 passed (62)
     Tests  948 passed (948)
  Duration  47.36s
```

- **N₀ = 948**（SC-009 / FR-055 的下限）。
- 本次运行 `tests/performance/stress.test.ts` 的 G2（墙钟缩放比，负载敏感）**通过**。
  该例为已知的机器负载敏感项：满载时可能失败，同机空载下复现通过。
  判定口径以「逻辑/玩法测试 100% 通过 + 该例在同机空载下复现通过」为准。

## 2. 无损摘要基线

```
[M16 lossless] no-renderer digest f52dfdd4, rendered digest f52dfdd4
[M17 lossless] zooming digest f52dfdd4 vs pinned f52dfdd4 (zoomActive on 601/601 frames, z = 2.880)
```

- **摘要基线 = `f52dfdd4`**（seed `0x12345678`，601 tick，FNV-1a over `listEntities() × listComponents()`）。
- 改动后 MUST 逐位相同（SC-008 / V3）。

## 3. 性能基线（比值口径）

```
[M16 perf] baseline 0.3832ms/frame, art 0.4284ms/frame, ratio 1.118 — budget 1.2
```

- 既有 `tests/performance/render_art_cost.test.ts` 的改动前基线比值 ≈ 1.118。
- M19 只加 DOM（HUD 写-变更、Tab 面板按需重建），Pixi 场景图零新增节点 ⇒ 期望比值 ≈ 1.0。

## 4. 硬约束基线

| 约束 | 基线实测 |
|---|---|
| `src/` 改动文件数 | **0**（`git status --short src/` / `git diff --stat src/` 均为空） |
| 运行时依赖 | `{pixi.js ^8.21.0, howler ^2.2.4}`（`package.json.dependencies`） |
| 管道段数 | 17 段（`tests/combat/boons.test.ts` G7 钉桩） |
| 冻结 UI 钩子 | 10 class + 5 id + 6 M16 钩子（`tests/ui/ui_skin.test.ts` 21 例） |
| 字体栈 | `--font-(body\|mono)` 恰 2 个（`tests/ui/text_readability.test.ts` T4） |

## 5. 三条源码扫描红线（实现期硬约束）

- **R-a**：`client/UIManager.ts` 保留 **≥3 处**字面 `document.createElement('button')`（**单引号**）。
- **R-b**：**禁止新增任何 `--font-*` 变量**（T4 断言恰 2 个）。
- **R-c**：`index.html` 的 `#hud, #keys, #gold {` 保持**连续且同序**；`#hud-material` MUST NOT 被插入该选择器列表。
