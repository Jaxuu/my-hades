# Contract · 祝福元数据表（`boons.json`）

**Owner**：表现层（`client/`）｜**消费者**：`UIManager` / 卡面渲染 / Tab 面板｜**关联**：FR-011/012/013/014/017/034/035/036 · D1/D2/D3/D15/D16

---

## 1. 位置与所有权

- **路径**：`client/assets/boons.json`（**表现层自有目录**，不在 `assets/data/` 之下）。
- **所有权**：**表现层只读**。逻辑内核**不**加载、**不**校验、**不**感知它的存在。
- **读取方式**：`client/` 以**静态 JSON import**（`import boonsJson from './boons.json'`）在**构建期**解析；无运行时 `fetch`。

## 2. 形状（Schema）

```jsonc
{
  "<rewardId>": {
    "rarity": "common" | "epic" | "legendary",
    "icon": "ui.boon.<rewardId>",
    "description": "<含 {placeholder} 的模板>"
  }
}
```

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| 键 | string | ✅ | MUST 是 `REWARD_POOL` 中的 id |
| `rarity` | enum | ✅ | `common` / `epic` / `legendary` |
| `icon` | string | ✅ | 前缀 `ui.boon.` |
| `description` | string | ✅ | 非空；占位符键 MUST 可解析 |

## 3. 与逻辑层祝福目录的一致性（**核心契约**）

- 逻辑层祝福目录 = `src/ecs/rewards/RewardPool.ts::REWARD_POOL`（**唯一真源**）。
- 契约：`boons.json` 的键集合 **==** `REWARD_POOL` 的 id 集合。
- **校验时机**：**测试期**（`tests/ui/boon-data.test.ts`），非运行期。
- **运行期行为**：某 id 缺元数据 ⇒ **降级**（`rarity` 回退 `common`、图标回退占位、描述回退安全文案），**不崩溃、不抛错**。

## 4. 引用点唯一性

- 全仓库对 UI 图标资产的引用 MUST 只有一处：`client/assets/manifest.ts`（`?url` 静态导入）。
- 删除任一图标文件 ⇒ `npm run build` **响亮失败**（沿用 M16/M18 契约）。
- `boons.json` 的 `icon` 字段**引用** `manifest.ts` 中的 id；悬空 id ⇒ 运行期降级为占位图。

## 5. 逻辑内核惰性（护栏）

| 断言 | 说明 |
|---|---|
| `src/**` MUST NOT import `boons.json` | 防止未来把该表接进内核 |
| `src/data/bundled.ts` 的加载列表 MUST NOT 含 `boons.json` | 内核具名加载，不做目录枚举 |
| 该表位于 `client/` 之下 | **结构性**隔离：`src/` 引用它在路径语义上即不成立 |
| `git diff --stat src/` 为空 | 本特性 `src/` 零改动（FR-030 / SC-007） |

## 6. 数值占位符

- `description` **不含字面数值**，只含 `{key}` 占位符。
- 占位符 → 数值的映射见 [`data-model.md`](../data-model.md) §4「数值注入表」。
- 注入器 MUST 是**纯函数**；缺失键 ⇒ 移除该占位符所在子句或回退安全文案（**绝不**输出 `undefined` / `NaN`）。
- 一致性契约：描述中出现的每个数值 MUST 等于逻辑层对应字段的**当前**值（SC-004）。

## 7. 不变式清单

1. `boons.json` 只承载**外观元数据**（品质 / 图标 / 文案模板），**不承载**数值、概率或行为。
2. 修改该表 MUST NOT 改变任何模拟结果（摘要逐位不变，SC-008）。
3. 该表 MUST NOT 出现在 `snapshot()` 中。
