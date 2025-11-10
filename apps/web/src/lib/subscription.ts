import dayjs from 'dayjs';

import { prisma } from './prisma';

export async function userHasPro(userId: number | bigint): Promise<boolean> {
  const id = typeof userId === 'bigint' ? userId : BigInt(userId);
  const user = await prisma.user.findUnique({ where: { id } });

  if (!user) {
    return false;
  }

  if (user.status && user.status !== 'FREE') {
    if (!user.paidUntil) {
      return true;
    }

    return dayjs(user.paidUntil).isAfter(dayjs());
  }

  return false;
}
