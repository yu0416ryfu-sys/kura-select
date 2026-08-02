// Bing Webmaster Tools 読み取り専用 MCP サーバー
// 起動: node scripts/mcp/bing-mcp.mjs
// 疎通確認: node scripts/mcp/bing-mcp.mjs --selftest
//
// GSC は Google の検索データしか返さないが、KuraSelect の送客クリックは
// Bing/デスクトップが第1チャネル（2026-08-03 分析）。このサーバーで Bing 側の
// 表示・クリック・順位を GSC と同じ粒度で取得し、施策判定を両チャネルで行う。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, "../../.env");

// API キーは .env（gitignore 済み）から読む。.mcp.json は commit されるので書かない。
if (!process.env.BING_WEBMASTER_API_KEY && existsSync(ENV_PATH)) {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch {
    // .env が読めなくても環境変数側で渡されていれば動くので握りつぶす
  }
}

const API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";
// Bing 側の登録表記は末尾スラッシュ付き（GetUserSites で確認済み）。
// 表記が違うと 400 になるため既定値を登録どおりに合わせている。
const SITE_URL = process.env.BING_SITE_URL ?? "https://www.kura-select.com/";

function getApiKey() {
  const key = process.env.BING_WEBMASTER_API_KEY;
  if (!key) {
    throw new Error(
      "BING_WEBMASTER_API_KEY が未設定です。Bing Webmaster Tools の " +
        "設定 > API アクセス > API キー で発行し、.env に " +
        "BING_WEBMASTER_API_KEY=xxxx を追記してください。",
    );
  }
  return key;
}

// WCF/ASP.NET AJAX 形式の日付 "/Date(1399100400000-0700)/" を YYYY-MM-DD に変換する。
// Bing の JSON API は ISO8601 ではなくこの形式で返すため、そのままでは日付比較できない。
const WCF_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

function parseWcfDate(value) {
  if (typeof value !== "string") return null;
  const match = WCF_DATE.exec(value);
  if (!match) return null;
  let ms = Number(match[1]);
  if (match[2]) {
    // オフセットは「元のタイムゾーンでの現地日付」を示すため、epoch に足し戻してから日付を取る
    const sign = match[2][0] === "-" ? -1 : 1;
    const hours = Number(match[2].slice(1, 3));
    const minutes = Number(match[2].slice(3, 5));
    ms += sign * (hours * 60 + minutes) * 60_000;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// Bing のレスポンスはメソッドごとにフィールド名が揺れる（Url / Query など）ため、
// 特定のキー名に依存せず「日付だけ正規化し、Clicks/Impressions があれば CTR を足す」方針にする。
function normalizeRow(row) {
  if (row === null || typeof row !== "object") return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const asDate = parseWcfDate(value);
    out[key] = asDate ?? value;
  }
  const clicks = Number(out.Clicks);
  const impressions = Number(out.Impressions);
  if (Number.isFinite(clicks) && Number.isFinite(impressions) && impressions > 0) {
    out.ctr = Math.round((clicks / impressions) * 10000) / 100 + "%";
  }
  return out;
}

async function callBing(method, extraParams = {}) {
  const url = new URL(`${API_BASE}/${method}`);
  url.searchParams.set("apikey", getApiKey());
  if (method !== "GetUserSites") url.searchParams.set("siteUrl", SITE_URL);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
  const text = await res.text();

  if (!res.ok) {
    // キー誤り・サイト未登録・siteUrl の表記ゆれはここで出る。原文を残して切り分け可能にする。
    throw new Error(
      `Bing API ${method} が ${res.status} ${res.statusText} を返しました。` +
        `siteUrl=${SITE_URL} / 応答: ${text.slice(0, 500)}`,
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bing API ${method} の応答が JSON ではありません: ${text.slice(0, 500)}`);
  }

  // WCF の JSON は結果を "d" でラップして返す
  const payload = json?.d ?? json;
  return Array.isArray(payload) ? payload.map(normalizeRow) : normalizeRow(payload);
}

// 日付つき行を startDate/endDate で絞る。Bing 側に期間指定パラメータが無いメソッドが多く、
// 期間比較（施策の前後比較）はクライアント側で行う必要がある。
function filterByDate(rows, startDate, endDate) {
  if (!Array.isArray(rows) || (!startDate && !endDate)) return rows;
  return rows.filter((row) => {
    const date = row?.Date;
    if (typeof date !== "string") return true;
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    return true;
  });
}

function sortAndLimit(rows, sortBy = "Clicks", rowLimit = 100) {
  if (!Array.isArray(rows)) return rows;
  const sorted = [...rows].sort(
    (a, b) => (Number(b?.[sortBy]) || 0) - (Number(a?.[sortBy]) || 0),
  );
  return sorted.slice(0, rowLimit);
}

function textResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

const DATE_PROPS = {
  startDate: { type: "string", description: "開始日 YYYY-MM-DD（省略時は全期間）" },
  endDate: { type: "string", description: "終了日 YYYY-MM-DD（省略時は全期間）" },
};
const LIMIT_PROPS = {
  rowLimit: { type: "number", description: "取得件数（デフォルト100）" },
  sortBy: {
    type: "string",
    enum: ["Clicks", "Impressions", "AvgImpressionPosition"],
    description: "並び替えキー（デフォルト Clicks の降順）",
  },
};

const TOOLS = [
  {
    name: "bing_sites",
    description:
      "APIキーで参照できるサイト一覧を取得。疎通確認と、Bing に登録されている siteUrl の正確な表記（末尾スラッシュ有無）の確認に使う。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bing_rank_and_traffic",
    description:
      "Bing の日別サイト全体パフォーマンス（表示・クリック）を取得。GSC の date 次元に相当し、週次トレンド比較に使う。",
    inputSchema: { type: "object", properties: { ...DATE_PROPS } },
  },
  {
    name: "bing_query_stats",
    description:
      "Bing のクエリ別パフォーマンス（表示・クリック・平均順位）を取得。GSC の query 次元に相当。",
    inputSchema: { type: "object", properties: { ...DATE_PROPS, ...LIMIT_PROPS } },
  },
  {
    name: "bing_page_stats",
    description:
      "Bing のページ別パフォーマンスを取得。GSC の page 次元に相当し、記事別の施策判定に使う。",
    inputSchema: { type: "object", properties: { ...DATE_PROPS, ...LIMIT_PROPS } },
  },
  {
    name: "bing_page_query_stats",
    description:
      "指定ページを表示させているクエリ一覧を取得。GSC の filterPage + query 次元に相当。",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description:
            "対象ページURL（例: https://www.kura-select.com/articles/portable-toilet-comparison/）",
        },
        ...DATE_PROPS,
        ...LIMIT_PROPS,
      },
      required: ["page"],
    },
  },
  {
    name: "bing_url_traffic_info",
    description: "指定URL単体の表示・クリック・順位などのトラフィック情報を取得。",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "対象URL" } },
      required: ["url"],
    },
  },
  {
    name: "bing_sitemaps",
    description: "Bing に送信済みのサイトマップ（フィード）の一覧と状態を取得。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bing_crawl_stats",
    description:
      "Bing のクロール統計（クロール数・エラー・ブロック等）を日別で取得。インデックス問題の切り分けに使う。",
    inputSchema: { type: "object", properties: { ...DATE_PROPS } },
  },
];

async function runTool(name, args = {}) {
  const { startDate, endDate, rowLimit = 100, sortBy = "Clicks" } = args;

  switch (name) {
    case "bing_sites":
      return { siteUrl: SITE_URL, sites: await callBing("GetUserSites") };

    case "bing_rank_and_traffic": {
      const rows = await callBing("GetRankAndTrafficStats");
      return { siteUrl: SITE_URL, rows: filterByDate(rows, startDate, endDate) };
    }

    case "bing_query_stats": {
      const rows = await callBing("GetQueryStats");
      const filtered = filterByDate(rows, startDate, endDate);
      return {
        siteUrl: SITE_URL,
        rowCount: Array.isArray(filtered) ? filtered.length : 0,
        rows: sortAndLimit(filtered, sortBy, rowLimit),
      };
    }

    case "bing_page_stats": {
      const rows = await callBing("GetPageStats");
      const filtered = filterByDate(rows, startDate, endDate);
      return {
        siteUrl: SITE_URL,
        rowCount: Array.isArray(filtered) ? filtered.length : 0,
        rows: sortAndLimit(filtered, sortBy, rowLimit),
      };
    }

    case "bing_page_query_stats": {
      const rows = await callBing("GetPageQueryStats", { page: args.page });
      const filtered = filterByDate(rows, startDate, endDate);
      return {
        siteUrl: SITE_URL,
        page: args.page,
        rowCount: Array.isArray(filtered) ? filtered.length : 0,
        rows: sortAndLimit(filtered, sortBy, rowLimit),
      };
    }

    case "bing_url_traffic_info":
      return {
        siteUrl: SITE_URL,
        url: args.url,
        info: await callBing("GetUrlTrafficInfo", { url: args.url }),
      };

    case "bing_sitemaps":
      return { siteUrl: SITE_URL, feeds: await callBing("GetFeeds") };

    case "bing_crawl_stats": {
      const rows = await callBing("GetCrawlStats");
      return { siteUrl: SITE_URL, rows: filterByDate(rows, startDate, endDate) };
    }

    default:
      throw new Error(`不明なツール: ${name}`);
  }
}

// --selftest: MCP を経由せず API キーと siteUrl の疎通だけ確認する
if (process.argv.includes("--selftest")) {
  try {
    const sites = await runTool("bing_sites");
    console.log("✅ API キーは有効です。参照可能なサイト:");
    console.log(JSON.stringify(sites, null, 2));
    console.log(
      `\n設定中の siteUrl: ${SITE_URL}\n` +
        "上の一覧に同じ表記が無ければ .env の BING_SITE_URL を一覧の表記に合わせてください。",
    );
  } catch (error) {
    console.error("❌ 疎通に失敗しました:\n" + error.message);
    process.exitCode = 1;
  }
} else {
  const server = new Server(
    { name: "bing", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    return textResult(await runTool(params.name, params.arguments ?? {}));
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
