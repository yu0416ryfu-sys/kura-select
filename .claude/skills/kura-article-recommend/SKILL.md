---
name: kura-article-recommend
description: |
  KuraSelectで次に追加する比較記事候補を提案するスキル。
  「記事を追加したい」「おすすめ記事を提案して」「次に作るカテゴリ案を出して」など、楽天アフィリエイト向けの記事テーマ選定・新規記事候補の優先順位付けを依頼された場合に使う。
  既存記事・カテゴリ・RAGデータ・読み取り専用MCP/レポートを踏まえて、重複回避、商品候補の拾いやすさ、比較軸、収益性を評価する。
---

# KuraSelect 記事候補提案スキル

KuraSelectの新規比較記事候補を、思いつきではなく既存コンテンツとRAG/MCP情報に基づいて提案する。候補出しだけを扱い、記事ファイル作成は `kura-article-create` に引き継ぐ。

## 参照順

1. `src/content/articles/` と `src/content/categories/` で既存記事・カテゴリの重複を確認する。
2. `data/rag/summary.json` で記事数・商品数・RAG生成状況を確認する。
3. 必要な範囲で `data/rag/products.jsonl` / `category-rules.jsonl` / `match-decisions.jsonl` / `capacity-patterns.jsonl` を検索する。
4. MCPが利用可能なら、読み取り専用の `kura-content` MCP で `search_rag` / `get_product_context` / `read_latest_reports` を使う。MCPが使えない場合は、その旨をユーザーへ簡潔に報告してからローカルファイルを直接読む。`search_rag` は部分一致検索のため、返却された record の `category` / `articleFile` を確認し、無関係な行が混ざっていないかチェックすること。
5. `reports/addition-candidates-*.md` / `reports/addition-urls-*.md` / `reports/toAI/` は最新または関連ジャンルだけを確認する。`reports/` はコミット対象外なので編集しない。

## 評価軸

各候補を次の観点で評価する。

- 既存記事との距離: 既存カテゴリに自然につながるか、重複しないか。
- 楽天商品候補の拾いやすさ: 既存RAG・追加候補・カテゴリルールから商品数を見込めるか。
- 比較軸の作りやすさ: 容量、単価、タイプ、素材、用途、対応機種などを比較表に落とせるか。
- 収益性: 消耗品・まとめ買い・リピート購入・単価の高さのいずれかがあるか。
- 法務/表現リスク: 薬機法・景表法に触れやすい断定や効果効能訴求が中心にならないか。

## 提案フォーマット

候補は優先順位順に3〜8件へ絞る。各候補に以下を短く添える。

```text
1. 記事テーマ
   - 推奨理由:
   - 既存記事とのつながり:
   - 比較軸:
   - 注意点:
```

最後に、必ず次を明記する。

- RAG/MCP/レポートのどれを使ったか。
- MCPが使えなかった場合は、その代替として読んだローカルファイル。
- 最有力候補を1〜2件。

## 禁止

- 既存記事・カテゴリだけを見て最終提案しない。
- `data/rag/` を直接編集しない。
- `reports/` を編集・削除しない。
- 商品追加や記事生成まで進めない。ユーザーが作成を依頼したら `kura-article-create` を使う。
