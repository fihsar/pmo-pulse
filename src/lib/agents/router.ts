import { getServiceClient } from '../supabase';

export interface RouterResult {
  assignee_phone: string;
  assignee_name: string;
  is_self: boolean;
  was_overloaded: boolean;
}

async function getSelf(creatorPhone: string): Promise<RouterResult> {
  const sb = getServiceClient();
  const { data: self } = await sb
    .from('users')
    .select('display_name')
    .eq('phone', creatorPhone)
    .single();

  return {
    assignee_phone: creatorPhone,
    assignee_name: self?.display_name ?? 'Self',
    is_self: true,
    was_overloaded: false,
  };
}

export async function routeTask(
  creatorPhone: string,
  assigneeHint: string | null
): Promise<RouterResult | null> {
  const sb = getServiceClient();

  if (!assigneeHint) return getSelf(creatorPhone);

  const { data: matches } = await sb
    .from('users')
    .select('phone, display_name')
    .eq('active', true)
    .ilike('display_name', `%${assigneeHint}%`);

  if (!matches || matches.length === 0) return getSelf(creatorPhone);

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
