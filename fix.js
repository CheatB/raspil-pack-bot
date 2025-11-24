const { execSync } = require('child_process');
const path = require('path');

const projectRoot = '/var/www/projects/emoji_bot';

console.log('🔧 Автоматическое исправление бота...\n');

try {
  process.chdir(projectRoot);
  
  console.log('1️⃣  Устанавливаю зависимости в корне...');
  execSync('npm install', { stdio: 'inherit', cwd: projectRoot });
  
  console.log('\n2️⃣  Устанавливаю зависимости в apps/web...');
  execSync('npm install', { stdio: 'inherit', cwd: path.join(projectRoot, 'apps/web') });
  
  console.log('\n3️⃣  Пересобираю проект...');
  execSync('NODE_OPTIONS="--max-old-space-size=1536" npm run build', { 
    stdio: 'inherit', 
    cwd: projectRoot,
    shell: true 
  });
  
  console.log('\n4️⃣  Перезапускаю PM2...');
  try {
    execSync('pm2 delete emoji_bot_web', { stdio: 'ignore' });
  } catch (e) {
    // Игнорируем ошибку если процесс не существует
  }
  execSync('pm2 start ecosystem.config.js', { stdio: 'inherit', cwd: projectRoot });
  execSync('pm2 save', { stdio: 'inherit' });
  
  console.log('\n5️⃣  Настраиваю webhook...');
  try {
    execSync('npm run set:webhook', { stdio: 'inherit', cwd: projectRoot });
  } catch (e) {
    console.log('⚠️  Не удалось настроить webhook автоматически, выполните вручную: npm run set:webhook');
  }
  
  console.log('\n✅ Готово! Проверьте статус: pm2 list');
  execSync('pm2 list', { stdio: 'inherit' });
  
} catch (error) {
  console.error('\n❌ Ошибка:', error.message);
  process.exit(1);
}

