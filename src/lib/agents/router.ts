import { getServiceClient } from '../supabase';

export interface RouterResult {
  assignee_phone: string;
  assignee_name: string;
  is_self: boolean;
  was_overloaded: boolean;
}

const DEFAULT_ASSIGNEE_PHONE = '+628115344666';

export function getDefaultAssigneePhone() {
  return process.env.DEFAULT_ASSIGNEE_PHONE || DEFAULT_ASSIGNEE_PHONE;
}

async function getDefaultAssignee(creatorPhone: string): Promise<RouterResult> {
  const sb = getServiceClient();
  const defaultPhone = getDefaultAssigneePhone();
  const { data: user } = await sb
    .from('users')
    .select('display_name')
    .eq('phone', defaultPhone)
    .maybeSingle();

  return {
    assignee_phone: defaultPhone,
    assignee_name: user?.display_name ?? 'Fihsar',
    is_self: defaultPhone === creatorPhone,
    was_overloaded: false,
  };
}

export async function routeTask(
  creatorPhone: string,
  assigneeHint: string | null
): Promise<RouterResult | null> {
  const sb = getServiceClient();

  if (!assigneeHint) return getDefaultAssignee(creatorPhone);

  const { data: matches } = await sb
    .from('users')
    .select('phone, display_name')
    .eq('active', true)
    .ilike('display_name', `%${assigneeHint}%`);

  if (!matches || matches.length === 0) return getDefaultAssignee(creatorPhone);

  const target = matches[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count } = await sb
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('assignee_phone', target.phone)
    .eq('status', 'pending')
    .gte('created_at', weekAgo);

  return {
    assignee_phone: target.phone,
    assignee_name: target.display_name,
    is_self: target.phone === creatorPhone,
    was_overloaded: (count ?? 0) > 15,
  };
}
