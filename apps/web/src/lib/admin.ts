import { prisma } from './prisma';
import { logger } from './logger';

/**
 * Admin configuration
 * Add admin usernames (without @) or user IDs here
 */
export const ADMIN_CONFIG = {
  // Admin usernames (without @)
  usernames: ['Cheatb'],
  // Admin user IDs (BigInt) - можно добавить напрямую, если знаете ID
  userIds: [] as bigint[],
};

export function normalizeUsername(username?: string | null): string | undefined {
  if (!username) return undefined;
  return username.replace(/^@/, '').toLowerCase();
}

/**
 * Check if user is admin by username or user ID
 */
export async function isAdmin(userId: bigint, username?: string): Promise<boolean> {
  // Check by user ID
  if (ADMIN_CONFIG.userIds.includes(userId)) {
    return true;
  }

  // Check by username
  if (username) {
    const normalizedUsername = username.replace('@', '').toLowerCase();
    if (ADMIN_CONFIG.usernames.some(u => u.toLowerCase() === normalizedUsername)) {
      return true;
    }
  }

  // Check by status in database
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    
    if (user && user.status === 'ADMIN') {
      return true;
    }
  } catch (error) {
    logger.error({ err: error, userId }, 'Error checking admin status');
  }

  return false;
}

/**
 * Set user as admin
 */
export async function setAdmin(userId: bigint, username?: string): Promise<void> {
  const normalizedUsername = normalizeUsername(username);
  await prisma.user.upsert({
    where: { id: userId },
    create: {
      id: userId,
      status: 'ADMIN',
      ...(normalizedUsername ? { username: normalizedUsername } : {}),
    },
    update: {
      status: 'ADMIN',
      ...(normalizedUsername ? { username: normalizedUsername } : {}),
    },
  });
  logger.info({ userId, username: normalizedUsername }, 'User set as admin');
}

/**
 * Grant subscription to user
 */
export async function grantSubscription(
  userId: bigint,
  plan: 'PRO' | 'MAX' = 'PRO',
  days: number = 30,
  username?: string
): Promise<void> {
  const paidUntil = new Date();
  paidUntil.setDate(paidUntil.getDate() + days);

  const normalizedUsername = normalizeUsername(username);

  await prisma.user.upsert({
    where: { id: userId },
    create: {
      id: userId,
      status: plan,
      paidUntil,
      ...(normalizedUsername ? { username: normalizedUsername } : {}),
    },
    update: {
      status: plan,
      paidUntil,
      ...(normalizedUsername ? { username: normalizedUsername } : {}),
    },
  });

  logger.info({ userId, plan, days, paidUntil, username: normalizedUsername }, 'Subscription granted');
}

/**
 * Get user info by username or user ID
 */
export async function getUserInfo(identifier: string | bigint): Promise<{
  id: bigint;
  status: string;
  paidUntil: Date | null;
  username?: string;
} | null> {
  if (typeof identifier === 'bigint' || /^\d+$/.test(String(identifier))) {
    // Search by user ID
    const userId = BigInt(identifier);
    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    
    if (user) {
      return {
        id: user.id,
        status: user.status,
        paidUntil: user.paidUntil,
      };
    }
  } else {
    // Search by username - нужно получить через Telegram API
    // Пока возвращаем null, так как для этого нужен Telegram API
    logger.warn({ identifier }, 'Username search not implemented yet');
  }

  return null;
}
