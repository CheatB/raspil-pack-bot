import axios from 'axios';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Load environment variables from project root
dotenv.config({ path: resolve(process.cwd(), '.env.local') });
dotenv.config({ path: resolve(process.cwd(), '.env') });

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;

if (!TG_BOT_TOKEN) {
  console.error('Missing required environment variable: TG_BOT_TOKEN');
  process.exit(1);
}

// Команды бота
const commands = [
  {
    command: 'start',
    description: 'Начать работу с ботом',
  },
  {
    command: 'generate',
    description: 'Сгенерировать пак из изображения',
  },
  {
    command: 'history',
    description: 'Просмотреть историю паков',
  },
  {
    command: 'tariffs',
    description: 'Информация о тарифах',
  },
  {
    command: 'help',
    description: 'Справка по использованию бота',
  },
];

async function setCommands() {
  try {
    console.log('Setting bot commands...');

    const response = await axios.post(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/setMyCommands`,
      {
        commands: commands,
      }
    );

    if (response.data.ok) {
      console.log('✅ Bot commands set successfully!');
      console.log('Commands:', commands.map(c => `/${c.command} - ${c.description}`).join('\n'));
    } else {
      console.error('❌ Failed to set commands:', response.data);
      process.exit(1);
    }
  } catch (error: any) {
    console.error('❌ Error setting commands:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
    process.exit(1);
  }
}

setCommands();

