import * as dotenv from "dotenv";
import { resolve } from "path";

// Определяем корень проекта
const projectRoot = process.env.PROJECT_ROOT || "/var/www/projects/emoji_bot";

console.log("📁 Project root:", projectRoot);
console.log("📁 Current working directory:", process.cwd());

// Грузим .env.production с абсолютным путём
const envProdPath = resolve(projectRoot, ".env.production");
const envPath = resolve(projectRoot, ".env");

console.log("📄 Loading .env.production from:", envProdPath);
const resultProd = dotenv.config({ path: envProdPath });
if (resultProd.error) {
  console.warn("⚠️  Could not load .env.production:", resultProd.error.message);
} else {
  console.log("✅ Loaded .env.production");
}

// И на всякий случай .env
console.log("📄 Loading .env from:", envPath);
const result = dotenv.config({ path: envPath });
if (result.error) {
  console.warn("⚠️  Could not load .env:", result.error.message);
} else {
  console.log("✅ Loaded .env");
}

import { initBot } from "./bot";

async function main() {
  console.log("🚀 Starting Telegram bot...");

  const token = process.env.TG_BOT_TOKEN;
  const baseUrl = process.env.APP_BASE_URL;
  const key = process.env.WEBHOOK_SECRET;

  console.log("🔍 Environment check:");
  console.log("  TG_BOT_TOKEN:", token ? `${token.substring(0, 10)}...` : "undefined");
  console.log("  APP_BASE_URL:", baseUrl || "undefined");
  console.log("  WEBHOOK_SECRET:", key ? "***" : "undefined");

  if (!token || !baseUrl || !key) {
    console.error("❌ Missing required environment variables.");
    console.error("TG_BOT_TOKEN:", token);
    console.error("APP_BASE_URL:", baseUrl);
    console.error("WEBHOOK_SECRET:", key);
    process.exit(1);
  }

  try {
    initBot(token, baseUrl, key);
    console.log("✅ Bot initialized with webhook:", baseUrl + "/api/tg/webhook");
    console.log("🔄 Bot process is running and waiting for webhook updates...");
    
    // Keep the process alive for webhook mode
    // The bot handles updates via handleUpdate() called from the web server
    process.on('SIGINT', () => {
      console.log('🛑 Received SIGINT, shutting down gracefully...');
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      console.log('🛑 Received SIGTERM, shutting down gracefully...');
      process.exit(0);
    });
    
    // Keep process alive
    setInterval(() => {
      // Heartbeat to keep process alive
    }, 60000); // Every minute
  } catch (err) {
    console.error("❌ Bot start failed:", err);
    process.exit(1);
  }
}

main();
