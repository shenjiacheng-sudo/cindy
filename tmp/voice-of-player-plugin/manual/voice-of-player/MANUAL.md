# 玩家声音 V0.1

这是本地合成数据体验版。返回结果中的 source_type 为 synthetic 时，只能用于验证数据结构、原子化、聚类和原评论追溯，不能描述真实 TapTap 玩家意见。

核心关系是 Review → 0..N Feedback Item → Feedback Cluster。单条评论必须允许拆成多个反馈；evidence 必须是原始评论中的准确片段。

当前工具：

- load_player_feedback_fixture：加载合成评论。
- analyze_player_feedback：运行本地标准化、原子化和聚类。
- get_feedback_evidence：按 feedback ID、cluster ID 或 review ID 回看证据。

当前不支持真实 TapTap 采集、版本前后分析、业务优先级判断或 P0/P1/P2 输出。真实采集接入时必须使用已有 TapTap CLI 的 player-feedback list-player-reviews，并保留 app scope、时间窗和分页边界。
