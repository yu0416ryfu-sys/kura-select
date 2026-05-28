// Google Search Console 読み取り専用 MCP サーバー
// 起動: node scripts/mcp/gsc-mcp.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(__dirname, "gsc-credentials.json");
const TOKEN_PATH = path.join(__dirname, "gsc-token.json");
const SITE_URL = "https://www.kura-select.com/";

// OAuth2クライアント初期化
function getOAuth2Client() {
  const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret } = raw.installed ?? raw.web;
  return new google.auth.OAuth2(client_id, client_secret, "http://localhost:3456");
}

// トークン取得（初回はブラウザ認証、以降は token.json を再利用）
async function authorize() {
  const oauth2Client = getOAuth2Client();
  if (existsSync(TOKEN_PATH)) {
    oauth2Client.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, "utf-8")));
    // トークン自動更新時に保存
    oauth2Client.on("tokens", (tokens) => {
      const current = existsSync(TOKEN_PATH)
        ? JSON.parse(readFileSync(TOKEN_PATH, "utf-8"))
        : {};
      writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...tokens }));
    });
    return oauth2Client;
  }

  // 初回認証フロー
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/webmasters.readonly"],
    prompt: "consent",
  });
  console.error("以下のURLをブラウザで開いて認証してください:\n" + authUrl);

  const code = await waitForAuthCode();
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.error("認証完了。gsc-token.json を保存しました。");
  return oauth2Client;
}

// ローカルサーバーで認証コードを受け取る
function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:3456");
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.end("認証に失敗しました: " + error);
        server.close();
        reject(new Error(error));
        return;
      }
      res.end("<html><body><h2>認証完了。このタブを閉じてください。</h2></body></html>");
      server.close();
      resolve(code);
    }).listen(3456);
    server.on("error", reject);
  });
}

// MCPサーバー
const server = new Server(
  { name: "gsc", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "gsc_search_analytics",
      description: "GSCの検索パフォーマンスデータを取得（クリック・表示・CTR・順位）",
      inputSchema: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "開始日 YYYY-MM-DD（例: 2026-04-01）",
          },
          endDate: {
            type: "string",
            description: "終了日 YYYY-MM-DD（例: 2026-04-30）",
          },
          dimensions: {
            type: "array",
            items: {
              type: "string",
              enum: ["query", "page", "country", "device"],
            },
            description: "集計軸（例: [\"query\"] or [\"page\"] or [\"query\",\"page\"]）",
          },
          rowLimit: {
            type: "number",
            description: "取得件数（最大5000、デフォルト100）",
          },
          filterPage: {
            type: "string",
            description: "特定ページのみに絞り込む場合のURL（例: https://www.kura-select.com/articles/kitchen-sponge/）",
          },
        },
        required: ["startDate", "endDate", "dimensions"],
      },
    },
    {
      name: "gsc_sitemaps",
      description: "送信済みサイトマップの一覧と状態を取得",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "gsc_index_status",
      description: "指定URLのインデックス状態を確認",
      inputSchema: {
        type: "object",
        properties: {
          inspectionUrl: {
            type: "string",
            description: "確認するURL（例: https://www.kura-select.com/articles/kitchen-sponge/）",
          },
        },
        required: ["inspectionUrl"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const auth = await authorize();

  if (params.name === "gsc_search_analytics") {
    const webmasters = google.webmasters({ version: "v3", auth });
    const { startDate, endDate, dimensions, rowLimit = 100, filterPage } = params.arguments;

    const requestBody = { startDate, endDate, dimensions, rowLimit };
    if (filterPage) {
      requestBody.dimensionFilterGroups = [
        {
          filters: [
            { dimension: "page", operator: "equals", expression: filterPage },
          ],
        },
      ];
    }

    const res = await webmasters.searchanalytics.query({
      siteUrl: SITE_URL,
      requestBody,
    });

    const rows = (res.data.rows ?? []).map((row) => ({
      keys: row.keys,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: Math.round(row.ctr * 10000) / 100 + "%",
      position: Math.round(row.position * 10) / 10,
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
    };
  }

  if (params.name === "gsc_sitemaps") {
    const webmasters = google.webmasters({ version: "v3", auth });
    const res = await webmasters.sitemaps.list({ siteUrl: SITE_URL });
    return {
      content: [
        { type: "text", text: JSON.stringify(res.data.sitemap ?? [], null, 2) },
      ],
    };
  }

  if (params.name === "gsc_index_status") {
    const searchconsole = google.searchconsole({ version: "v1", auth });
    const res = await searchconsole.urlInspection.index.inspect({
      requestBody: {
        inspectionUrl: params.arguments.inspectionUrl,
        siteUrl: SITE_URL,
      },
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(res.data.inspectionResult ?? {}, null, 2),
        },
      ],
    };
  }

  throw new Error(`不明なツール: ${params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
