// Google Analytics 4 読み取り専用 MCP サーバー
// 起動: node scripts/mcp/ga4-mcp.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";

const PROPERTY_ID = process.env.GA4_PROPERTY_ID ?? "535186053";
const PROPERTY = `properties/${PROPERTY_ID}`;
const DEFAULT_METRICS = ["screenPageViews", "activeUsers", "sessions"];

const DIMENSIONS = [
  "date",
  "pagePath",
  "pageTitle",
  "sessionDefaultChannelGroup",
  "sessionSource",
  "sessionMedium",
  "deviceCategory",
  "country",
  "city",
  "eventName",
];

const METRICS = [
  "screenPageViews",
  "activeUsers",
  "newUsers",
  "sessions",
  "engagedSessions",
  "engagementRate",
  "averageSessionDuration",
  "eventCount",
];

async function getAnalyticsData() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  return google.analyticsdata({
    version: "v1beta",
    auth: await auth.getClient(),
  });
}

function formatRows(data) {
  const dimensionHeaders = (data.dimensionHeaders ?? []).map(({ name }) => name);
  const metricHeaders = (data.metricHeaders ?? []).map(({ name }) => name);

  return (data.rows ?? []).map((row) => {
    const dimensions = Object.fromEntries(
      dimensionHeaders.map((name, index) => [
        name,
        row.dimensionValues?.[index]?.value ?? "",
      ]),
    );
    const metrics = Object.fromEntries(
      metricHeaders.map((name, index) => [
        name,
        row.metricValues?.[index]?.value ?? "",
      ]),
    );
    return { ...dimensions, ...metrics };
  });
}

const server = new Server(
  { name: "ga4", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ga4_report",
      description:
        "GA4の集計レポートを取得。記事別PV、日別推移、流入元、イベントなどを確認できます。",
      inputSchema: {
        type: "object",
        properties: {
          startDate: {
            type: "string",
            description: "開始日 YYYY-MM-DD、または 7daysAgo、28daysAgo",
          },
          endDate: {
            type: "string",
            description: "終了日 YYYY-MM-DD、または yesterday、today",
          },
          dimensions: {
            type: "array",
            items: { type: "string", enum: DIMENSIONS },
            description: "集計軸。例: [\"pagePath\"]、[\"date\"]",
          },
          metrics: {
            type: "array",
            items: { type: "string", enum: METRICS },
            description:
              "指標。省略時: screenPageViews、activeUsers、sessions",
          },
          rowLimit: {
            type: "number",
            description: "取得件数。デフォルト100、最大10000",
          },
        },
        required: ["startDate", "endDate", "dimensions"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name !== "ga4_report") {
    throw new Error(`不明なツール: ${params.name}`);
  }

  const {
    startDate,
    endDate,
    dimensions,
    metrics = DEFAULT_METRICS,
    rowLimit = 100,
  } = params.arguments;
  const analyticsData = await getAnalyticsData();
  const res = await analyticsData.properties.runReport({
    property: PROPERTY,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit: Math.min(rowLimit, 10000).toString(),
    },
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            propertyId: PROPERTY_ID,
            rowCount: res.data.rowCount ?? 0,
            rows: formatRows(res.data),
          },
          null,
          2,
        ),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
