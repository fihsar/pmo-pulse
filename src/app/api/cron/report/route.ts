import { NextRequest, NextResponse } from 'next/server';
import { sendWeeklyReportEmail } from '@/lib/agents/report';
import { validateCronRequest } from '@/lib/cron';

export async function GET(req: NextRequest) {
  const validation = validateCronRequest(req);
  if (validation) return validation;

  const result = await sendWeeklyReportEmail({ requestor: 'system' });
  const status = result.status === 'sent' || result.status === 'no_tasks' ? 200 : 500;
  return NextResponse.json(result, { status });
}

