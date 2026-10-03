# M19 · T055 变异实验日志（M1–M6）

> 纪律：每次「破坏 → 确认对应断言**真的失败** → **从快照逐字节还原** → 以 sha256 校验还原」。
> **未**使用 `git checkout --` / `git restore` / `git stash`。
> 驱动脚本：`production/m19-mutation-run.py`（一次性工具）。

## 结果总表

| # | 破坏点 | 目标文件 | 守卫测试 | 断言是否失败 | 还原是否逐位一致 |
|---|---|---|---|---|---|
| M1 | 品质 → class 映射塌缩（UIManager 的 RARITY_CLASSES.epic 改成 common 的类名） | `client/UIManager.ts` | `tests/ui/boon-card.test.ts` | **是（断言有效）** | 是 |
| M2 | 描述数值脱离逻辑层（zeus_strike 的 damage 硬编码成 999） | `client/ui/boon-presentation.ts` | `tests/ui/boon-description.test.ts` | **是（断言有效）** | 是 |
| M3 | Tab 面板获得通往模拟的通道（togglePanel 签名加上 world 形参） | `client/UIManager.ts` | `tests/ui/status-panel-nopause.test.ts` | **是（断言有效）** | 是 |
| M4 | 降级回退被移除（品质卡片在无框体图时的实心品质边框改成 transparent） | `index.html` | `tests/ui/ui_degradation.test.ts` | **是（断言有效）** | 是 |
| M5 | 面板集合不一致（readOwnedBoonIds 只返回第一个已拥有祝福） | `client/ui/status-panel.ts` | `tests/ui/status-panel.test.ts` | **是（断言有效）** | 是 |
| M6 | 槽位只声明不消费（.hud-dash 不再引用 var(--ui-frame-dash)） | `index.html` | `tests/ui/ui_degradation.test.ts` | **是（断言有效）** | 是 |

## 逐条证据

### M1 · 品质 → class 映射塌缩（UIManager 的 RARITY_CLASSES.epic 改成 common 的类名）

- 目标文件：`client/UIManager.ts`
- 守卫测试：`tests/ui/boon-card.test.ts`
- 期望守卫的断言：T023 · maps each card rarity to the `boon-rarity-*` class the manager emits
- 破坏：`  epic: 'boon-rarity-epic',` → `  epic: 'boon-rarity-common',`
- 实测退出码：`1`；捕获到的失败用例：T023 · every card carries all three elements (FR-011/012/013) > maps each card rarity to the `boon-rarity-*` class the manager emits 10ms | tests/ui/boon-card.test.ts > T023 · every card carries all three elements (FR-011/012/013) > maps each card rarity to the `boon-rarity-*` class the manager emits
- 测试输出尾部：

```text
     70|       expect(UI_MANAGER).toContain(`boon-rarity-${card.rarity}`);
       |                          ^
     71|     }
     72|     // The three hooks really are all three, so the mapping is not col…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

- 还原后 sha256 与快照一致：是

### M2 · 描述数值脱离逻辑层（zeus_strike 的 damage 硬编码成 999）

- 目标文件：`client/ui/boon-presentation.ts`
- 守卫测试：`tests/ui/boon-description.test.ts`
- 期望守卫的断言：描述数值与逻辑层一致（双通道，含真实掉血）
- 破坏：`      return { damage: config.damage };` → `      return { damage: 999 };`
- 实测退出码：`1`；捕获到的失败用例：CHANNEL A · the rendered number matches two independent logic sources > zeus_strike quotes the modifiers.json damage 14ms | CHANNEL B · the engine really deals the number the card quotes > zeus_strike: a landed hit takes exactly the quoted damage one tick later 9ms | tests/ui/boon-description.test.ts > CHANNEL A · the rendered number matches two independent logic sources > zeus_strike quotes the modifiers.json damage | tests/ui/boon-description.test.ts > CHANNEL B · the engine really deals the number the card quotes > zeus_strike: a landed hit takes exactly the quoted damage one tick later
- 测试输出尾部：

```text
    123|     expect(hpAfterBase - hpAfterBolt).toBe(quoted);
       |                                       ^
    124|   });
    125| 

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯
```

- 还原后 sha256 与快照一致：是

### M3 · Tab 面板获得通往模拟的通道（togglePanel 签名加上 world 形参）

- 目标文件：`client/UIManager.ts`
- 守卫测试：`tests/ui/status-panel-nopause.test.ts`
- 期望守卫的断言：T031 · togglePanel takes no World / simulator and cannot reach one
- 破坏：`  public togglePanel(): void {` → `  public togglePanel(world: unknown): void {`
- 实测退出码：`1`；捕获到的失败用例：T031 · the panel has no channel to the simulation (FR-022) > togglePanel takes no World / simulator and cannot reach one 8ms | tests/ui/status-panel-nopause.test.ts > T031 · the panel has no channel to the simulation (FR-022) > togglePanel takes no World / simulator and cannot reach one
- 测试输出尾部：

```text
     74|     expect(body).toMatch(/togglePanel\(\)/);
       |                  ^
     75|     expect(body).not.toContain('world');
     76|     expect(body).not.toContain('sim');

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

- 还原后 sha256 与快照一致：是

### M4 · 降级回退被移除（品质卡片在无框体图时的实心品质边框改成 transparent）

- 目标文件：`index.html`
- 守卫测试：`tests/ui/ui_degradation.test.ts`
- 期望守卫的断言：T047 · falls the boon card back to a solid quality border when the frame is `none`
- 破坏：`        border-color: var(--rarity-common);` → `        border-color: transparent;`
- 实测退出码：`1`；捕获到的失败用例：T047 · each surface has a plain-CSS fallback under the art > falls the boon card back to a solid quality border when the frame is `none` 10ms | tests/ui/ui_degradation.test.ts > T047 · each surface has a plain-CSS fallback under the art > falls the boon card back to a solid quality border when the frame is `none`
- 测试输出尾部：

```text
     85|       expect(block).toContain(`border-color: var(${colour})`);
       |                     ^
     86|     }
     87|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

- 还原后 sha256 与快照一致：是

### M5 · 面板集合不一致（readOwnedBoonIds 只返回第一个已拥有祝福）

- 目标文件：`client/ui/status-panel.ts`
- 守卫测试：`tests/ui/status-panel.test.ts`
- 期望守卫的断言：面板集合 == 玩家实际拥有集合（SC-005）
- 破坏：`  return modifiers?.modifiers ?? [];` → `  return (modifiers?.modifiers ?? []).slice(0, 1);`
- 实测退出码：`1`；捕获到的失败用例：T030 · the panel set equals the owned set exactly (SC-005) > reads the player’s modifiers, ascending and deduplicated 14ms | T030 · the panel set equals the owned set exactly (SC-005) > includes an UNKNOWN owned id (the set never silently shrinks) 2ms | tests/ui/status-panel.test.ts > T030 · the panel set equals the owned set exactly (SC-005) > reads the player’s modifiers, ascending and deduplicated | tests/ui/status-panel.test.ts > T030 · the panel set equals the owned set exactly (SC-005) > includes an UNKNOWN owned id (the set never silently shrinks)
- 测试输出尾部：

```text
     62|     expect(panel.rows.map((row) => row.id).sort()).toEqual(
       |                                                    ^
     63|       ['a_boon_the_table_does_not_know', 'zeus_strike'].sort(),
     64|     );

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯
```

- 还原后 sha256 与快照一致：是

### M6 · 槽位只声明不消费（.hud-dash 不再引用 var(--ui-frame-dash)）

- 目标文件：`index.html`
- 守卫测试：`tests/ui/ui_degradation.test.ts`
- 期望守卫的断言：T047 · every M19 slot is CONSUMED, not merely declared
- 破坏：`        border-image-source: var(--ui-frame-dash);` → `        border-image-source: none;`
- 实测退出码：`1`；捕获到的失败用例：T047 · every M19 slot is CONSUMED, not merely declared > draws `--ui-frame-dash` somewhere in the stylesheet 10ms | tests/ui/ui_degradation.test.ts > T047 · every M19 slot is CONSUMED, not merely declared > draws `--ui-frame-dash` somewhere in the stylesheet
- 测试输出尾部：

```text
     56|     expect(INDEX_HTML).toContain(`var(${slot})`);
       |                        ^
     57|   });
     58| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯
```

- 还原后 sha256 与快照一致：是

## 还原完整性（实验结束后全量校验）

| 文件 | 快照 sha256 | 实验后 sha256 | 一致 |
|---|---|---|---|
| `index.html` | `8a50f8b7de157d8a…` | `8a50f8b7de157d8a…` | 是 |
| `client/UIManager.ts` | `1384d13102510f8c…` | `1384d13102510f8c…` | 是 |
| `client/ui/quality.ts` | `82369f0a4d603725…` | `82369f0a4d603725…` | 是 |
| `client/ui/boon-presentation.ts` | `f98a21e9dded1918…` | `f98a21e9dded1918…` | 是 |
| `client/ui/status-panel.ts` | `5e1e952b97a3c4e8…` | `5e1e952b97a3c4e8…` | 是 |

**结论：全部逐字节还原成功。**
