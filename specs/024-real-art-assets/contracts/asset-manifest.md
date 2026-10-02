# Contract · 资产清单（Asset Manifest）

**Feature**: `024-real-art-assets` · **Version**: 1.0.0 · **Date**: 2026-10-01

本契约定义 `client/assets/manifest.ts` 必须遵守的接口，以及它对外承诺的语义。它是「资产是否存在」的**唯一真相**。

---

## 1. 接口

```ts
/** 资产种类决定加载器分支与回退行为。 */
type AssetKind = 'spritesheet' | 'image' | 'audio';

/** 加载失败时的行为。 */
type AssetFallback = 'graphics' | 'silent';

interface AssetEntry {
  readonly id: string;            // kebab-case，见 §2 命名空间
  readonly kind: AssetKind;
  readonly source: string;        // Vite 导入得到的 URL
  readonly license: string;       // 恒为 'CC0-1.0'（本特性）
  readonly fallback: AssetFallback;
}

/** 全量清单：id → 条目。构建期静态生成，运行期只读。 */
declare const MANIFEST: Readonly<Record<string, AssetEntry>>;
```

## 2. id 命名空间（冻结）

| 前缀 | 含义 | 示例 |
|---|---|---|
| `player.` | 玩家形象 | `player.base` |
| `enemy.` | 敌人类别形象 | `enemy.grunt` · `enemy.elite` · `enemy.raider` · `enemy.bomber` · `enemy.gunner` |
| `tile.` | 场景瓦片 | `tile.floor` · `tile.wall` |
| `fx.` | 局内特效 | `fx.spark` · `fx.dash-trail` · `fx.hazard-ring` |
| `ui.` | 界面与图标 | `ui.icon.gold` · `ui.icon.heal` · `ui.icon.darkness` · `ui.panel.hud` |
| `sfx.` | 音效 | `sfx.hit` · `sfx.dash` · `sfx.coin` · `sfx.enemy-death` · `sfx.ui-click` |

## 3. 承诺（MUST）

1. **唯一引用点**：`manifest.ts` 是全仓**唯一**直接 import 资产文件的地方；其余模块一律经它取句柄。
2. **构建期失败**：引用的资产文件缺失 ⇒ `npm run build` MUST 失败（响亮失败），MUST NOT 静默产出缺资产的产物。（对应 FR-013 的「构建期」一层；「运行期」降级见承诺 3。）
3. **运行期降级**：单个资产**解码/格式**失败 ⇒ 该条目进入 `degraded`，其消费者 MUST 回退到 `fallback` 指定的路径；其余条目 MUST 不受影响。
4. **终态不重试**：`degraded` 是终态，MUST NOT 每帧重试。
5. **许可可追溯**：每个 `id` MUST 能在 `assets/art/LICENSES.md` / `assets/audio/LICENSES.md` 中反查到来源与许可。
6. **白名单**：`license` MUST ∈ {`CC0-1.0`, `public-domain`, 明确允许再分发}；出现专有或未知许可 ⇒ **构建期拒绝**。
7. **零外部请求**：`source` MUST 是本地构建产物路径，MUST NOT 是远端 URL。

## 4. 违例判定（供测试与评审使用）

| 场景 | 期望 |
|---|---|
| `MANIFEST` 中出现重复 `id` | 构建期抛错 |
| 某条目 `kind === 'audio'` 而 `fallback !== 'silent'` | 单测失败 |
| 某 `id` 在 `LICENSES.md` 中查不到 | 单测失败（SC-010） |
| 某 `license` 为 `proprietary` | 单测失败 + 构建期拒绝 |
| 删除任一资产文件后执行 `npm run build` | 构建失败（承诺 2） |
| 注入一个解码失败的资产后运行 | 该元素回退，游戏可玩（SC-007） |

## 5. 非目标

- 本契约**不**规定图集内部的帧名布局（那属于各 spritesheet 自身的 JSON）。
- 本契约**不**规定加载时机（见 [quickstart.md](../quickstart.md) 与 plan 的 D2）。
