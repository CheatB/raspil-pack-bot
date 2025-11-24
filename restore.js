const { execSync } = require('child_process');
const path = require('path');

const projectRoot = '/var/www/projects/emoji_bot';

console.log('🔨 Пересобираю tg-bot...');
try {
  execSync('pnpm -C apps/tg-bot build:prod', {
    cwd: projectRoot,
    stdio: 'inherit'
  });
  console.log('✅ tg-bot пересобран');
} catch (error) {
  console.error('❌ Ошибка при сборке tg-bot:', error.message);
  process.exit(1);
}

console.log('🚀 Запускаю PM2 процессы...');
try {
  execSync('pm2 start ecosystem.config.js || pm2 restart emoji_bot_web', {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: true
  });
  execSync('pm2 save', { stdio: 'inherit' });
  console.log('✅ PM2 процессы запущены');
} catch (error) {
  console.error('❌ Ошибка при запуске PM2:', error.message);
  process.exit(1);
}

console.log('✅ Проект восстановлен!');
execSync('pm2 list', { stdio: 'inherit' });

