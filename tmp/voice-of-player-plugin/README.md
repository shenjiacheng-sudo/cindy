# 玩家声音 V0.1 本地体验版

这是一个独立 Ghost v3 插件，用本地合成评论验证 Review → Feedback Item → Feedback Cluster → 原评论证据追溯链路。

当前不连接 TapTap，不代表真实玩家意见，也不执行版本分析或业务优先级判断。真实数据接入时使用已有 TapTap CLI 插件的 player-feedback list-player-reviews，并保留 app scope、时间窗、分页上限和缺失字段为空的约束。

## 本地检查

    node --test node/*.test.cjs evaluation/*.test.cjs
    node evaluation/evaluate.cjs
    node --check main.js
    node --check node/worker.cjs

## 使用

在隔离 Cindy 开发环境中导入本目录的 Ghost 包，启用插件后打开面板，点击“开始分析”。点击反馈主题可以查看 Feedback Item 的 evidence 和对应原评论。
