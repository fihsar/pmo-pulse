import { NextRequest, NextResponse } from 'next/server';
import { logAuditEvent } from '@/lib/agents/audit';
import { validateCronRequest } from '@/lib/cron';
import { sendWhatsApp } from '@/lib/integrations/twilio';
import { getServiceClient } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const authError = validateCronRequest(req);
  if (authError) return authError;

  const sb = getServiceClient();
  const { data: team, error } = await sb
    .from('users')
    .select('phone, display_name')
    .eq('active', true)
    .neq('role', 'stakeholder');

  if (error) {
    console.error('Failed to load standup team:', error);
    return NextResponse.json({ prompted: 0, error: 'team_load_failed' }, { status: 500 });
  }

  let prompted = 0;

  for (const member of team || []) {
    try {
      await sendWhatsApp(
        member.phone,
        `Selamat pagi ${member.display_name}! 🌅\n\n*Daily Standup*\nReply dalam 30 menit:\n1️⃣ Yesterday\n2️⃣ Today\n3️⃣ Blockers (kosongkan jika none)`
      );
      prompted++;
    } catch (err) {
      console.error('Standup send failed:', err);
    }
  }

  await logAuditEvent({
    event_type: 'standup_initiated',
    actor_phone: 'system',
    payload: { count: prompted },
  });

  return NextResponse.json({ prompted });
}
