# Maple Fork Notes

## 已做
- 把定位从 builders digest 改成 signal radar
- 改了 prompt 层：摘要 -> 信号提炼 / 内容机会 / 行动建议
- 扩展了 config schema：focusTopics / contentGoals / outputSections / scoring
- 重写中英文 README 和 sample output，方便后面公开分享
- prepare-digest.js 已接入 sourceProfiles + custom-sources.json
- v0.2 增加 scoredSignals + draftCandidates
- 新增 x_drafts section，默认关闭小红书 section
- 给中文 source 留了占位：zh_creators
- v0.3 增加 sourceWeights + outputMode（balanced / signal_only / x_draft）
- v0.4 增加 sourceWeightReasons、engagement/recency scoring、mode explainability

## 还没做但值得做
1. 做真正的 digest markdown render
2. 真正接入中文 source 抓取
3. 适配 OpenClaw cron，直接定时投递到常用 chat
4. 做一版公开分享用的 X 线程草稿
5. 增加“低信号忽略列表”

## 当前定位
这是最小可用 fork，不是终版。先把框架立住，再慢慢把 source、ranking、draft、render 全做深。
---

## 2026-06-12 系统状态复盘 + 修复记录

### 数据源健康状态（当前）

| 数据源 | 状态 | 备注 |
|---|---|---|
| RSSHub (localhost:1200) | ✅ 正常 | X 小号 cookie 未过期，@ruanyf 等可正常抓取 |
| wewe-rss (localhost:4000) | ✅ 正常 | 2026-06-12 重新扫码 + 重新抓取后恢复 |
| X 账号 (maple profile, 41个) | ✅ 修复 | 见下方 bug |
| 即刻 (李继刚/歸藏/孟岩) | ✅ 正常 | 每次各约 10 条 |
| GitHub Trending / HN | ✅ 正常 | - |
| YouTube 播客 | ⚠️ 限速 | 429 错误，偶发，非关键路径 |

### Bug 修复：maple X 账号全部静默跳过

**现象：** prepare-digest.js 跑出的 X 信号全部来自 default profile（zarazhangrui 远程 feed），maple 自定义的 41 个账号零产出。

**根因：** `default-sources.json` 里 maple profile 的 x_accounts 条目没有 `rsshub` 字段；代码逻辑 `x_accounts.filter(a => a.rsshub)` 直接把它们全部跳过，不报错。

**修复：** 给全部 41 个账号批量补上 `"rsshub": "http://localhost:1200/twitter/user/<handle>"`，验证后 @_catwu / @levelsio / @op7418 / @ruanyf 等均能正常抓取。

**顺带发现：** `default-sources.json` 末尾有一处 JSON 格式错误（`zh_creators` 对象缺少 `}`），一并修复。

### 待做（v0.6 优先级排序）

1. **输出质量优化**（方向待定）— X 草稿模板感、排版密度、降噪阈值
2. **收口提交** — 当前 prepare-digest.js 有大量未提交改动（+664/-142 行），稳定后 commit
