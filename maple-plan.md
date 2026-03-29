# Content Signal Radar - 当前计划

## 已确认
- 名称：Content Signal Radar
- 优先级：C > A > B
  - C = AI 产品 / agent 信号跟踪
  - A = X 观点生产
  - B = 小红书选题生产（暂时关闭）
- 重点主题：agent / AI 产品 / personal brand / creator tools / AI 出海
- 第一批重点 X 账号：
  - _catwu
  - zarazhangrui
  - levelsio
  - thedankoe
  - tdinh_me
  - lexfridman
  - leeerob
  - steipete
  - naval
  - gregisenberg

## 本轮改造目标
1. 把新配置字段真正接入 prepare-digest 输出
2. 支持 sourceProfiles + custom-sources.json
3. 默认关闭 xiaohongshu_topics section
4. 保留原项目 feed，增加 Maple profile 作为附加层
5. v0.2 增加显式 scoring + x_drafts
6. 预留中文 source 占位，不急着接真实源
7. v0.3 增加 sourceWeights + outputMode
8. v0.4 增加 sourceWeightReasons + engagement/recency scoring + explainability

## 下一轮建议
1. 做真正的 digest render（把 scoredSignals 渲染成可直接看的 markdown）
2. 真正接入中文 source 抓取
3. 适配 OpenClaw cron，直接定时投递到常用 chat
4. 做一版公开分享用的 X 线程草稿
5. 增加“忽略哪些低信号内容”的 section

## 关于中文 source
第一阶段先只留 placeholder，不接真实抓取。
等你想清楚后，再决定从公众号、即刻、少数派、B站、newsletter、RSS 哪条线先切。