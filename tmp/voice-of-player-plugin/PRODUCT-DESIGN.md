# Voice of Player V0.1 本地合成数据设计

本目录是本地体验版 Ghost 插件，所有样本明确标记为 synthetic，不代表 TapTap 实时数据。

数据链路：Review → 0..N Feedback Item → Feedback Cluster → Insight

- 默认分析窗口为最近 7 天。
- 未提供的 device、game_version、likes 等字段保持 null，不推断。
- sentiment：positive / negative / neutral / mixed。
- feedback_type：problem / suggestion / praise / question。
- severity：high / medium / low，不等同业务优先级。
- 完整 category 分类表收到后再收紧枚举，当前不补造分类。
