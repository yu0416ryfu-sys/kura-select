// GSC OAuth2 初回認証スクリプト（一度だけ実行）
// 実行: node scripts/mcp/gsc-auth.mjs
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(__dirname, "gsc-credentials.json");
const TOKEN_PATH = path.join(__dirname, "gsc-token.json");

if (existsSync(TOKEN_PATH)) {
  console.log("gsc-token.json がすでに存在します。認証済みです。");
  process.exit(0);
}

const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));
const { client_id, client_secret } = raw.installed ?? raw.web;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, "http://localhost:3456");

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  scope: ["https://www.googleapis.com/auth/webmasters.readonly"],
  prompt: "consent",
});

console.log("\n以下のURLをブラウザで開いてGoogleアカウントでログインしてください:\n");
console.log(authUrl);
console.log("\nブラウザで認証後、このターミナルに戻ってください...\n");

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost:3456");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) {
      res.end("認証失敗: " + error);
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

const { tokens } = await oauth2Client.getToken(code);
writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
console.log("認証完了。gsc-token.json を保存しました。");
console.log("MCP サーバーを Claude Desktop から使用できます。");
