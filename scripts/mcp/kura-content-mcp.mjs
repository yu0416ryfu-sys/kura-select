// KuraSelect 読み取り専用 MCP サーバー
// 起動: node scripts/mcp/kura-content-mcp.mjs（プロジェクトルートから実行）
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  listArticles,
  getArticleProducts,
  getProductContext,
  parseCapacityInput,
  readLatestReports,
  searchRag,
} from "./lib/content-tools.ts";

const server = new Server(
  { name: "kura-content", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_articles",
      description: "記事一覧を返す（frontmatterのみ、本文なし）",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", description: "カテゴリでフィルタ" },
          productCountLt: { type: "number", description: "商品数がN未満の記事のみ" },
          hasYahooOffer: { type: "boolean", description: "Yahoo offer を持つ記事のみ" },
        },
      },
    },
    {
      name: "get_article_products",
      description: "指定記事の商品配列を返す（本文は返さない）",
      inputSchema: {
        type: "object",
        properties: {
          articleFile: {
            type: "string",
            description: "例: src/content/articles/toilet-paper-comparison.md",
          },
        },
        required: ["articleFile"],
      },
    },
    {
      name: "get_product_context",
      description: "商品情報と data/rag/match-decisions.jsonl の照合履歴を返す",
      inputSchema: {
        type: "object",
        properties: {
          articleFile: { type: "string" },
          rank: { type: "number", description: "rank で商品を指定" },
          name: { type: "string", description: "name で商品を指定（rank と排他）" },
        },
        required: ["articleFile"],
      },
    },
    {
      name: "parse_capacity",
      description: "capacity 文字列を解析して抽出総量・正規化・単価を返す",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "商品名または capacity 文字列",
          },
          capacity: {
            type: "string",
            description: "capacity フィールド値（省略時は name を使用）",
          },
          price: {
            type: "number",
            description: "価格（pricePerUnit 計算に使用）",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "read_latest_reports",
      description: "reports/ 以下の最新ファイル概要を返す",
      inputSchema: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["capacity-review", "product-match", "addition-candidates", "all"],
            description: "レポート種別",
          },
          limit: { type: "number", description: "最大件数（デフォルト 5）" },
        },
        required: ["kind"],
      },
    },
    {
      name: "search_rag",
      description: "data/rag/*.jsonl を文字列検索する（初期実装は部分一致）",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "検索文字列" },
          type: {
            type: "string",
            enum: ["product", "capacity-pattern", "match-decision", "category-rule"],
            description: "対象ファイルタイプ（省略時は全ファイル）",
          },
          limit: { type: "number", description: "最大件数（デフォルト 20）" },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case "list_articles":
        result = listArticles(args);
        break;
      case "get_article_products":
        result = getArticleProducts(/** @type {string} */ (args.articleFile));
        break;
      case "get_product_context":
        result = getProductContext(/** @type {import('./lib/content-tools.ts').ProductContextInput} */ (args));
        break;
      case "parse_capacity":
        result = parseCapacityInput(/** @type {import('./lib/content-tools.ts').ParseCapacityInput} */ (args));
        break;
      case "read_latest_reports":
        result = readLatestReports(/** @type {import('./lib/content-tools.ts').LatestReportsInput} */ (args));
        break;
      case "search_rag":
        result = searchRag(/** @type {import('./lib/content-tools.ts').SearchRagInput} */ (args));
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: String(err) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
