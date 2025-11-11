import { prisma } from '@/lib/prisma';
import { isAdmin, setAdmin } from '@/lib/admin';

export async function GET() {
  const testUserId = BigInt(12345); // Тестовый ID
  const testUsername = 'testuser';
  
  try {
    console.log('Step 1: Testing prisma connection...');
    
    // Тест 1: Подключение к базе
    const userCount = await prisma.user.count();
    console.log('Step 1 OK: userCount =', userCount);
    
    console.log('Step 2: Testing user upsert...');
    
    // Тест 2: Создание/обновление пользователя
    const user = await prisma.user.upsert({
      where: { id: testUserId },
      create: {
        id: testUserId,
        username: testUsername,
      },
      update: {
        username: testUsername,
      },
    });
    console.log('Step 2 OK: user created/updated', user.id.toString());
    
    console.log('Step 3: Testing admin check...');
    
    // Тест 3: Проверка админа
    const admin = await isAdmin(testUserId, testUsername);
    console.log('Step 3 OK: isAdmin =', admin);
    
    if (admin) {
      console.log('Step 4: Testing setAdmin...');
      await setAdmin(testUserId, testUsername);
      console.log('Step 4 OK: setAdmin completed');
    }
    
    console.log('Step 5: All tests passed!');
    
    const response = Response.json({
      ok: true,
      steps: [
        { step: 1, name: 'prisma connection', status: 'OK', userCount },
        { step: 2, name: 'user upsert', status: 'OK', userId: user.id.toString() },
        { step: 3, name: 'admin check', status: 'OK', isAdmin: admin },
        { step: 4, name: 'setAdmin', status: admin ? 'OK' : 'SKIPPED' },
        { step: 5, name: 'complete', status: 'OK' }
      ]
    });

    // Clean up test user to avoid unique constraint conflicts
    await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});

    return response;
    
  } catch (error: any) {
    console.error('Debug start error:', error);
    return Response.json({
      ok: false,
      error: error.message,
      stack: error.stack,
      step: 'unknown'
    }, { status: 500 });
  }
}
