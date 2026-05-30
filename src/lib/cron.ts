import { NextRequest, NextResponse } from 'next/server';

export function validateCronRequest(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return new NextResponse('CRON_SECRET is not configured', { status: 500 });
  }

  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  return null;
}
