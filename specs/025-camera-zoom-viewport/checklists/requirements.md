# Specification Quality Checklist: 相机缩放与视口自适应（M17）

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-02
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit.clarify` or `/speckit.plan`
- Validation performed 2026-10-02; all items pass on the first iteration.
- **Governance amendment 2026-10-02（老板拍板，`/speckit.plan` 期间发现规格自相矛盾）**：`FR-004` 原文同时要求「相机以玩家为中心跟随」与「房间可容纳时房间居中」，二者在数学上互斥（10×10 房间在 1080p 下要完整可见则 `z ≤ 5.68` ⇒ 仅占视口短边 52.6%，低于 SC-001 的 55% 下限；出生点 `(4.5, 8.5)` 非中心时纯跟随立即垂直溢出 194px）。已按拍板结果把 `FR-004` 改为**两种且仅有两种取景模式**（房间可容纳 ⇒ 房间模式：房间居中且静止；房间大于视口 ⇒ 跟随模式：玩家居中 + 钳制在房间边界内），并同步修订 US1 场景 3/4、Key Entity「相机取景状态」、Edge Cases（模式临界点抖动、视口变化引发的模式切换）与 Assumptions（原「不引入以房间为中心的第二套相机模式」一句已被取代，并写入两条被否决替代方案的算术理由）。第二项拍板：**保留 `isInHub` 检查**，忠实执行 FR-021。
- **Second-pass review 2026-10-02** (independent re-read against the live codebase): all items re-confirmed; two degradation gaps were found and closed in the spec — (a) FR-014 extended from「视口尺寸无法被读取」to also cover **非有限 / 非正** viewport dimensions (minimised window, hidden container ⇒ no `NaN`/divide-by-zero zoom), plus the matching edge case; (b) new **FR-021** + Key-Entity note + US5 acceptance scenario 4 for **房间范围无法被确定**（无墙 / 房间未加载 / 营地等非房间场景）⇒ zoom degrades to identity, no throw, no render block. No other changes.
- **Baseline facts verified against the repository, not assumed**: `PX_PER_UNIT = 10` (`client/GameRenderer.ts:115`); `CAMERA_LERP_FACTOR = 0.2` (`:128`); `screenWidth()/screenHeight()` are guarded reads returning `0` for the duck-typed test `Application` (`:1312`/`:1319`); the camera is a plain `Container` documented as "no zoom, no rotation, no bounds" (`:398`); `specs/20 §2.1 I11–I14` and `specs/19 §1.3` really do freeze the camera as translate-only; `npm test` = **803 passed / 50 files** on 2026-10-02.
- **Scope boundaries recorded**: 世界空间内容随缩放变化；屏幕空间内容（HUD/菜单/覆盖层）不变；模拟内核零改动；既有 803 用例零改动；既有场景图 6 条冻结契约不变。
- **Deliberate defaults (documented in Assumptions, not left as clarification markers)**: 缩放策略 = 自动适配 + 上下限夹取（非固定倍率 / 非手动控制）；相机取景按「房间能否被完整容纳」分两种模式（**房间模式**：房间居中且静止；**跟随模式**：玩家居中 + 钳制在房间边界内）；既有世界单位→像素换算不变，缩放为叠加的视口因子；退化路径缩放恒为 1。
- **Verification hooks noted for planning**: 无渲染 vs 渲染的状态序列对拍（SC-004）；HUD 位置/尺寸跨倍率不变（SC-003）；压测每帧耗时比值 ≤ 1.2（SC-007）；既有 803 用例零改动全绿（SC-006）。
