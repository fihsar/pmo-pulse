import { createHash } from 'crypto';
import { getServiceClient } from '../supabase';

interface AuditEvent {
  event_type: string;
  actor_phone: string;
  target_id?: string;
  payload?: Record<string, unknown>;
}

export async function logAuditEvent(event: AuditEvent) {
  const sb = getServiceClient();
  const { data: prev } = await sb
    .from('audit_log')
    .select('payload_hash')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  const payload = event.payload ?? {};
  const payloadStr = JSON.stringify(payload);
  const prevHash = prev?.payload_hash ?? '0000000000000000';
  const combined = prevHash + payloadStr + event.event_type + event.actor_phone;
  const payloadHash = createHash('sha256').update(combined).digest('hex');

  await sb.from('audit_log').insert({
    event_type: event.event_type,
    actor_phone: event.actor_phone,
    target_id: event.target_id ?? null,
    payload,
    payload_hash: payloadHash,
    prev_hash: prevHash,
  });
}
