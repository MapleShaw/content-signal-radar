# TODO - Content Signal Radar

## Next up (paused here)

### v0.5 - Make the radar less noisy
- [ ] Add a low-signal filter layer
  - down-rank offsite / celebration / vague hype / pure design flex / low-information updates
  - explicitly detect tweets with weak product, workflow, creator, or agent relevance
- [ ] Split scoring by section intent
  - separate ranking logic for `x_angles` vs `product_signals`
  - avoid reusing the exact same top items across every section
- [ ] Improve X draft quality
  - reduce template tone
  - generate more specific openings based on signal type and source content
- [ ] Add a `ignoredSignals` or `lowSignalNotes` output section for debugging

### v0.6 - Better rendering and delivery
- [ ] Improve markdown rendering so it feels like a real daily radar, not an internal debug view
- [ ] Add a cleaner final digest renderer with tighter Chinese phrasing
- [ ] Consider OpenClaw cron delivery once output quality is stable

### Sources
- [ ] Keep `zh_creators` as placeholder for now
- [ ] Later decide first Chinese source batch from: WeChat OA / Jike / 少数派 / Bilibili / newsletter / RSS

### Sharing / public-facing
- [ ] Clean README once core ranking is stable
- [ ] Turn the build process into an X thread / post
- [ ] Decide whether to publish as a public fork or a more opinionated standalone repo

## Current status snapshot
- repo renamed conceptually to `Content Signal Radar`
- prompts rewritten toward signal extraction
- config expanded with goals / sections / weights / modes
- source profiles + custom sources supported
- scored signals + draft candidates implemented
- source weights and reasons implemented
- engagement / recency included in scoring
- markdown rendering implemented
- Chinese sources reserved but not connected
