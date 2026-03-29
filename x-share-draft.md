# X Share Draft - Content Signal Radar

## 版本 1：偏观点
最近我在看一个开源 skill，原本是追踪 AI builders 的推文 / 播客 / 博客，然后自动整理成 digest。

我没直接搬。
我把它 fork 之后，往另一个方向改了：

**从“资讯摘要”改成“信号雷达”。**

我现在更想要的不是：
- 今天 AI 圈发生了什么

而是：
- 哪些变化值得我关心
- 哪些适合写成 X 观点
- 哪些会影响我对 agent / AI 产品 / workflow 的判断

所以这次 fork 我重点改了几层：
1. source profile
2. signal scoring
3. X draft output
4. 中文 source placeholder

越来越觉得：
**很多开源 skill 真正的价值，不在于直接拿来用，而在于它给了你一个能继续长成自己的骨架。**

---

## 版本 2：偏实操
最近 fork 了一个 AI digest skill，但我改的不是 UI，而是工作流本身。

原版更像：
“帮你追踪 AI builders 最近说了什么。”

我改成了：
“帮我筛出真正高信号的内容，并直接给我 X 可写角度 / X 草稿 / 产品判断。”

具体做了几件事：
- 增加 sourceProfiles
- 增加 custom sources
- 加了 scoring（relevance / writeability / actionability / novelty）
- 给不同 source 加权重
- 增加 output modes：balanced / signal_only / x_draft

我越来越相信一件事：
**通用 skill 解决的是“大家都能用”，但真正长期有价值的，是你愿不愿意把它改成“为你工作”。**

---

## 版本 3：更短
最近一个很强的感受：

与其收藏更多 skill，
不如把一个对的开源骨架 fork 下来，改成自己的系统。

我这两天就在把一个 AI builder digest，改成自己的 Content Signal Radar：
- 盯更相关的 source
- 给信号打分
- 直接产出 X 草稿
- 预留中文 sources

**骨架拿来，灵魂重写。**
这比单纯分享一个仓库有意思多了。