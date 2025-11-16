import { prisma } from './prisma';
import { logger } from './logger';
import { isAdmin } from './admin';

/**
 * Get current period in YYYYMM format (UTC)
 */
export function currentPeriod(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

/**
 * Check if user can process image (quota available)
 * @returns {allowed: boolean, remaining: number, error?: string}
 */
export async function checkImageQuota(userId: bigint, username?: string): Promise<{
  allowed: boolean;
  remaining: number;
  error?: string;
}> {
  // Check if user is admin - admins have unlimited quota
  const admin = await isAdmin(userId, username);
  if (admin) {
    return {
      allowed: true,
      remaining: 999999, // Unlimited for admins
    };
  }

  const period = currentPeriod();

  // Get or create user
  let user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        id: userId,
        status: 'FREE',
      },
    });
  }

  // Check if user status is ADMIN (from database)
  if (user.status === 'ADMIN') {
    return {
      allowed: true,
      remaining: 999999, // Unlimited for admins
    };
  }

  // Get or create quota for current period
  let quota = await prisma.quota.findUnique({
    where: {
      userId_period: {
        userId,
        period,
      },
    },
  });

  if (!quota) {
    quota = await prisma.quota.create({
      data: {
        userId,
        period,
        imagesUsed: 0,
        videosUsed: 0,
      },
    });
  }

  // Проверяем срок действия подписки для платных тарифов
  if (user.status !== 'FREE' && user.status !== 'ADMIN') {
    if (!user.paidUntil) {
      // Если нет paidUntil, но статус платный - считаем что подписка активна (для обратной совместимости)
      return {
        allowed: true,
        remaining: 999999, // Безлимит для платных тарифов
      };
    }
    
    // Проверяем, не истекла ли подписка
    const now = new Date();
    if (user.paidUntil < now) {
      // Подписка истекла, возвращаем к FREE
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'FREE', paidUntil: null },
      });
      // Продолжаем проверку как FREE пользователь
    } else {
      // Подписка активна - безлимит
      return {
        allowed: true,
        remaining: 999999, // Безлимит для платных тарифов
      };
    }
  }

  // Для FREE пользователей проверяем лимит
  const limit = 5;
  const remaining = limit - quota.imagesUsed;

  if (quota.imagesUsed >= 5) {
    return {
      allowed: false,
      remaining: 0,
      error: 'Лимит обработок достигнут. Free: до 5 обработок/мес. Перейдите на тариф Pro/Max для безлимитных генераций.',
    };
  }

  return {
    allowed: remaining > 0,
    remaining: Math.max(0, remaining),
  };
}

/**
 * Check and increment image quota for user
 * @throws Error if quota limit exceeded
 */
export async function checkAndIncImageQuota(userId: bigint, username?: string): Promise<void> {
  // Check if user is admin - admins have unlimited quota
  const admin = await isAdmin(userId, username);
  if (admin) {
    logger.info({ userId, username }, 'Admin user - skipping quota check');
    return; // Admins have unlimited quota, no need to increment
  }

  const period = currentPeriod();

  // Get or create user
  let user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        id: userId,
        status: 'FREE',
      },
    });
  }

  // Check if user status is ADMIN (from database)
  if (user.status === 'ADMIN') {
    logger.info({ userId }, 'Admin user (from DB) - skipping quota check');
    return; // Admins have unlimited quota
  }

  // Get or create quota for current period
  let quota = await prisma.quota.findUnique({
    where: {
      userId_period: {
        userId,
        period,
      },
    },
  });

  if (!quota) {
    quota = await prisma.quota.create({
      data: {
        userId,
        period,
        imagesUsed: 0,
        videosUsed: 0,
      },
    });
  }

  // Проверяем срок действия подписки для платных тарифов
  if (user.status !== 'FREE' && user.status !== 'ADMIN') {
    if (!user.paidUntil) {
      // Если нет paidUntil, но статус платный - считаем что подписка активна (для обратной совместимости)
      return; // Безлимит для платных тарифов
    }
    
    // Проверяем, не истекла ли подписка
    const now = new Date();
    if (user.paidUntil < now) {
      // Подписка истекла, возвращаем к FREE
      await prisma.user.update({
        where: { id: userId },
        data: { status: 'FREE', paidUntil: null },
      });
      // Продолжаем проверку как FREE пользователь
    } else {
      // Подписка активна - безлимит, не инкрементируем квоту
      logger.info({ userId, period }, 'Paid user - unlimited quota, skipping increment');
      return;
    }
  }

  // Для FREE пользователей проверяем лимит
  if (quota.imagesUsed >= 5) {
    throw new Error('Лимит обработок достигнут. Free: до 5 обработок/мес. Перейдите на тариф Pro/Max для безлимитных генераций.');
  }

  // Increment quota
  await prisma.quota.update({
    where: {
      userId_period: {
        userId,
        period,
      },
    },
    data: {
      imagesUsed: {
        increment: 1,
      },
    },
  });

  logger.info({ userId, period, imagesUsed: quota.imagesUsed + 1 }, 'Quota incremented');
}

/**
 * Get user quota info for current period
 */
export async function getUserQuota(userId: bigint): Promise<{
  imagesUsed: number;
  videosUsed: number;
  limit: number;
  status: string;
}> {
  const period = currentPeriod();

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    return {
      imagesUsed: 0,
      videosUsed: 0,
      limit: 5,
      status: 'FREE',
    };
  }

  const quota = await prisma.quota.findUnique({
    where: {
      userId_period: {
        userId,
        period,
      },
    },
  });

  // Check if user is admin
  const admin = await isAdmin(userId);
  const isAdminUser = admin || user.status === 'ADMIN';
  
  // Проверяем срок действия подписки для платных тарифов
  let limit = 5; // По умолчанию FREE
  if (isAdminUser) {
    limit = 999999; // Безлимит для админов
  } else if (user.status !== 'FREE' && user.status !== 'ADMIN') {
    if (user.paidUntil && user.paidUntil >= new Date()) {
      limit = 999999; // Безлимит для активных платных тарифов
    }
  }

  return {
    imagesUsed: quota?.imagesUsed || 0,
    videosUsed: quota?.videosUsed || 0,
    limit,
    status: user.status,
  };
}
