# TODO - Content Signal Radar

## ✅ Completed

### v0.4 - Foundation
- [x] Repo renamed to Content Signal Radar
- [x] Prompts rewritten toward signal extraction
- [x] Config expanded with goals / sections / weights / modes
- [x] Source profiles + custom sources supported
- [x] Scored signals + draft candidates implemented
- [x] Source weights and reasons implemented
- [x] Engagement / recency included in scoring
- [x] Markdown rendering implemented

### v0.5 - Make the radar less noisy
- [x] Low-signal filter layer (`76ec90d`, `d8808dc`)
  - hard filter: pure RT / emoji-only / hollow hype
  - soft filter: thread preview / self-promo
  - `lowSignalPenalty` scoring integrated
- [x] Split scoring by section intent (`d8808dc`)
  - `computeSectionScore`: x_angle / product_signal 独立打分
  - `deduplicateByHandle`: same handle 3+ → keep top 2
- [x] `needsReview` anomaly detection (`d8808dc`)
  - flags: HIGH_ENG_LOW_MATCH / HIGH_SOURCE_LOW_ENG / SHORT_TEXT / PENALIZED_BUT_ENGAGED
  - rendered as ⚠️ 待确认, `stats.needsReviewCount` in JSON
- [x] X draft quality — topic-aware dynamic copy (`2a3792a`)
  - expanded intent classifier, topic templates, reduced "neither" signals
- [x] Editorial radar rewrite (`d8808dc`)
  - dynamic lead, unified signal list, topic templates, dynamic actions

### Sources (v0.5)
- [x] 即刻 RSS 接入 (`e71e5b9`)
- [x] 自定义 RSS blog 支持 (`e71e5b9`)
- [x] 31 个 CN 账号迁入 (`e71e5b9`)
- [x] needsReview 渲染清理 (`e71e5b9`)

---

## Next up

### v0.6 - Polish + delivery
- [ ] X draft quality 继续打磨
  - 当前 topic-aware copy 是第一版，部分 opening 仍偏模板感
  - 针对不同 signal type（产品发布 / 观点 / 教程 / 工具推荐）生成更差异化的 copy
- [ ] Markdown 渲染优化
  - 当前 editorial radar 可读性 OK，但排版密度高，长 digest 容易视觉疲劳
  - 考虑分段 / 折叠 / 优先级视觉层级
- [ ] OpenClaw cron 定时推送
  - 输出质量稳定后接入，每日自动跑 + 推送到 Telegram

### v0.7 - 更多数据源 + 中文生态
- [ ] 微信公众号（需要解决抓取方案）
- [ ] 少数派 RSS
- [ ] Bilibili（创作者动态）
- [ ] Newsletter 聚合
- [ ] 评估当前即刻 + RSS blog 的信号质量，决定是否调整权重

### Backlog
- [ ] Clean README once core ranking is stable
- [ ] Turn the build process into an X thread / post
- [ ] Decide whether to publish as a public fork or a more opinionated standalone repo
- [ ] 测试覆盖（至少 scoring + filter 逻辑）
