# Maple Signal Radar

这是一个基于 follow-builders 改出来的 fork，但目标已经不是“AI 行业摘要”，而是“信息信号雷达”。

## 主要改动

它不再只回答“今天发生了什么”，而是更关注：
- 哪些内容值得写成 X 观点
- 哪些内容适合转成小红书选题
- 哪些变化值得影响产品 / agent / workflow 判断
- 接下来应该做什么

## 核心思路

原仓库最值钱的地方不是默认信源，而是这个骨架：
**central feed + local remix + scheduled delivery**

我保留了这个骨架，但把最后一公里重写了：
- 从“资讯摘要”改成“信号提炼”
- 从“告诉你发生了什么”改成“告诉你为什么值得关心”
- 从“日报”改成“内容 + 产品决策辅助”

## 新增配置方向

目前 schema 已加入：
- `focusTopics`
- `contentGoals`
- `outputSections`
- `scoring`

这样它就可以逐步从通用 skill，变成更贴合个人目标的系统。

## 适合谁

如果你想每天/每周得到这样一份输出，这个 fork 就有价值：
- 今天该关注什么？
- 哪 3 个角度适合发 X？
- 哪 3 个方向适合做小红书？
- 哪些变化会影响我的产品判断？
- 我今天下一步该干嘛？

## 当前状态

这还是第一版改造。
目前 feed 层仍继承原项目，下一步最值得做的是：
- 让信源支持更强自定义
- 在 prepare/remix 流程里显式加入评分机制
- 增加更贴合个人工作流的输出格式

## 致谢

原项目： https://github.com/zarazhangrui/follow-builders
这个 fork 的方向：把通用 digest 改造成更适合个人内容与产品判断的 signal radar