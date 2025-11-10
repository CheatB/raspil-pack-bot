import axios from 'axios';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables from project root
dotenv.config({ path: resolve(process.cwd(), '.env.local') });
dotenv.config({ path: resolve(process.cwd(), '.env') });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const APP_BASE_URL = process.env.APP_BASE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!TG_BOT_TOKEN || !APP_BASE_URL || !WEBHOOK_SECRET) {
  console.error('Missing required environment variables: TG_BOT_TOKEN, APP_BASE_URL, WEBHOOK_SECRET');
  process.exit(1);
}

const webhookUrl = `${APP_BASE_URL}/api/tg/webhook`;

async function setWebhook() {
  try {
    console.log(`Setting webhook to: ${webhookUrl}`);

    const response = await axios.post(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook`,
      {
        url: webhookUrl,
        secret_token: WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
      }
    );

    if (response.data.ok) {
      console.log('✅ Webhook set successfully!');
      console.log('Webhook info:', response.data.result);
    } else {
      console.error('❌ Failed to set webhook:', response.data);
      process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ Error setting webhook:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
}

setWebhook();

