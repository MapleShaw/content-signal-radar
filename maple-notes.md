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