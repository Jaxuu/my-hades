# Quickstart · 真实 2D 美术与音效资产接入

**Feature**: `024-real-art-assets` · **Date**: 2026-10-01

本文件是**验证/运行指南**：列出能证明特性端到端成立的场景、命令与预期结果。实现细节见 [plan.md](./plan.md) 与 [contracts/](./contracts/)；任务拆解见 `tasks.md`（由 `/speckit.tasks` 生成）。

---

## 0. 前置条件

```bash
npm install                 # 依赖已含 pixi.js 8 / howler 2.2
# 资产已落盘于 assets/art/** 与 assets/audio/**，并在
# assets/art/LICENSES.md / assets/audio/LICENSES.md 登记来源与许可（CC0）
```

## 1. 五道闸门（每次改动后必跑）

```bash
npm test                    # 逻辑 642 例 + 表现层新增用例
npm run typecheck           # 逻辑层 + 测试（无 DOM）
npm run typecheck:client    # 表现层（含 DOM lib）
npm run lint                # 含 src/ 的无头/确定性/单向依赖 AST 门禁
npm run build               # Vite 生产构建（资产导入的构建期校验在此生效）
```

**预期**：五条全绿。其中 `lint` MUST 报告 `src/**` 无违规；`build` MUST 成功产出含资产的 bundle。

## 2. 核心合规检查（对应 FR-014 / FR-015 / VI）

```bash
git diff --stat src/        # 预期：空输出
grep -rn "'TransformSnapshotSystem'" tests/ | wc -l   # 预期：9（钉桩未动）
```

**预期**：`src/` 零改动；17 段管道不变。

## 3. 确定性无损自证（对应 FR-014 / SC-004）

用同一种子跑同一 601-Tick 脚本，取改动前后的**快照摘要**（`listEntities() × listComponents()` 拼串过 FNV-1a）：

```bash
# 改动前
git stash && npm test -- tests/performance/stress.test.ts   # 记录摘要
# 改动后
git stash pop && npm test -- tests/performance/stress.test.ts
```

**预期**：两次摘要**逐位相同**，实体数相同。若不同 ⇒ 说明表现层意外影响了逻辑，必须回退。

## 4. 视觉验收（浏览器）

```bash
npm run dev                 # http://localhost:5173
```

| # | 场景 | 预期 | 对应 |
|---|---|---|---|
| V1 | 开局静止 / 四向移动 / 冲刺 / 攻击 / 受击 / 死亡 | 角色是带动画的人物，朝向与动作可辨 | FR-001…004 · SC-001 |
| V2 | 依次遇到 5 类敌人（含精英） | 每类形象专属；**去色后仍可区分** | FR-005 · SC-002 |
| V3 | 沿墙走动 | 视觉墙边界 = 碰撞边界，无可见偏差 | FR-007/008 · SC-003 |
| V4 | 加载 `start_room` / `arena_room` / `stress_room` | 纹理按房间尺寸铺设，无拉伸/错位/空洞 | FR-009 |
| V5 | 命中 / 冲刺 / 拾取金币 | 播放真实音效，与画面同步 | FR-010/011 · SC-008 |
| V6 | 拾取物 vs 危险预警同屏 | 两类形状语言不同，不会误判 | FR-017 |
| V7 | 走完「开局 → 战斗 → 清房 → 三选一 → 终局 → 营地 → 再开局」 | **全程找不到占位几何或默认控件** | FR-018/022 · SC-009 |
| V8 | 覆盖层中文 | 清晰可读，无乱码/方块 | FR-019 |
| V9 | 键盘 `Tab`/`Enter` 操作三选一与营地按钮 | 可聚焦、可触发 | ui-asset-slots 承诺 3 |

## 5. 压测与性能（对应 FR-016 / SC-006）

```bash
npm run dev                 # 打开 http://localhost:5173/?mode=stress
```

**预期**：30×30 房间 + 约 150 敌同屏下保持流畅可玩，相对改动前基线**无可感知退化**；断言用**缩放比**而非绝对墙钟（宪法 IV）。

## 6. 离线与降级验收（对应 FR-012/013 · SC-005/007）

| # | 操作 | 预期 |
|---|---|---|
| O1 | 断开网络后打开页面（或 DevTools 置 Offline） | 画面与音效全部可用；Network 面板**零外部请求** |
| O2 | 人为损坏单个图集（如 `assets/art/atlas/enemies.*`）后重新 `npm run build` + 预览 | 敌人回退为几何方块，**其余美术正常**，游戏可玩，崩溃 0 次 |
| O3 | 删除任一资产文件后 `npm run build` | **构建失败**（响亮失败，asset-manifest 承诺 2） |
| O4 | 在自动播放被阻止的浏览器中首次加载 | 静默无报错，按键后可正常出声 |

## 7. 冻结契约验收（对应宪法 V / D6）

```bash
npm test -- tests/render/           # 既有渲染套件：一行不改，全部通过
```

**预期**：`renderer_bridge` / `camera_follow` / `camera_adversarial` / `interpolation` / `juice_m14` / `juice-verify` 全绿；F1–F6 逐条成立（`stage` 唯一子节点 = camera；`camera.children[last]` = root；`root.children[last]` = fxLayer；`root.children[0]` = 首个实体视图；无墙时 `camera.children` 长恰 1；空闲时 `fxLayer.children` 长恰 0）。

## 8. 许可验收（对应 FR-020 / SC-010）

```bash
# 清单中每个 id 都能在 LICENSES.md 中反查到
grep -c "CC0-1.0" assets/art/LICENSES.md assets/audio/LICENSES.md
```

**预期**：100% 可追溯；无任何专有/未知许可条目；无任何 Supergiant Games /《哈迪斯》原版资产。

---

## 快速排障

| 症状 | 可能原因 | 处置 |
|---|---|---|
| `build` 报资产路径错误 | 清单引用了不存在的文件 | 修 `manifest.ts` 或补文件（**不要**改成 `public/` 绕过） |
| 敌人全是同一种形象 | 签名分类器未命中 | 核对 `contracts/renderer-asset-mapping.md` §4 表 |
| 渲染套件失败 | 新增了常驻场景节点 | 改为替换 `staticLayer` 内容（D6） |
| `typecheck` 报 TS2304 `window` | 某模块被 `GameRenderer` 导入图意外带入 | 检查 howler/DOM 全局的导入图隔离（D8） |
| 中文显示为方块 | 依赖了未打包的自定义字体 | 回退系统字体栈（D7） |
