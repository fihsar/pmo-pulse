'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserClient } from '@/lib/supabase';

interface Task {
  id: string;
  task: string;
  assignee_phone: string;
  project: string | null;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'cancelled';
}

type Filter = 'mine' | 'team' | 'overdue' | 'done';

const filters: Filter[] = ['mine', 'team', 'overdue', 'done'];

export default function Dashboard() {
  const router = useRouter();
  const [phone, setPhone] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Filter>('mine');
  const [loading, setLoading] = useState(true);

  const loadTasks = useCallback(async () => {
    const sb = getBrowserClient();
    const { data } = await sb
      .from('tasks')
      .select('id, task, assignee_phone, project, due_date, priority, status')
      .order('due_date', { ascending: true, nullsFirst: false });

    setTasks((data as Task[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    const savedPhone = localStorage.getItem('pulse_phone');
    if (!savedPhone) {
      router.push('/');
      return;
    }

    queueMicrotask(() => {
      setPhone(savedPhone);
      void loadTasks();
    });

    const sb = getBrowserClient();
    const channel = sb
      .channel('tasks-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => void loadTasks())
      .subscribe();

    return () => {
      void sb.removeChannel(channel);
    };
  }, [loadTasks, router]);

  async function toggleTask(task: Task) {
    const sb = getBrowserClient();
    const status = task.status === 'done' ? 'pending' : 'done';
    await sb
      .from('tasks')
      .update({ status, completed_at: status === 'done' ? new Date().toISOString() : null })
      .eq('id', task.id);
  }

  const filtered = useMemo(() => tasks.filter((task) => {
    if (!phone) return false;
    if (filter === 'done') return task.status === 'done';
    if (task.status === 'done') return false;
    if (filter === 'mine') return task.assignee_phone === phone;
    if (filter === 'overdue') return Boolean(task.due_date && new Date(task.due_date) < new Date());
    return true;
  }), [filter, phone, tasks]);

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <header className="border-b border-white/10 bg-slate-950/80 px-5 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-teal-300">PMO Pulse</p>
            <h1 className="mt-1 text-xl font-black">Task Command Center</h1>
            <p className="text-xs text-slate-400">{phone}</p>
          </div>
          <button
            onClick={() => {
              localStorage.removeItem('pulse_phone');
              router.push('/');
            }}
            className="rounded-full border border-white/10 px-4 py-2 text-sm text-slate-200 hover:bg-white/10"
          >
            Logout
          </button>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-5 py-6">
        <div className="flex gap-2 overflow-x-auto pb-2">
          {filters.map((item) => (
            <button
              key={item}
              onClick={() => setFilter(item)}
              className={`rounded-full px-4 py-2 text-sm font-semibold capitalize transition ${filter === item ? 'bg-teal-300 text-slate-950' : 'bg-white/10 text-slate-300 hover:bg-white/15'}`}
            >
              {item}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="mt-8 rounded-3xl border border-white/10 bg-white/5 p-10 text-center text-slate-400">Loading tasks...</div>
        ) : filtered.length === 0 ? (
          <div className="mt-8 rounded-3xl border border-white/10 bg-white/5 p-10 text-center text-slate-400">
            ✨ Nothing here. Send a WhatsApp message to add a task.
          </div>
        ) : (
          <div className="mt-6 grid gap-3">
            {filtered.map((task) => (
              <article key={task.id} className="rounded-3xl border border-white/10 bg-white/[0.07] p-5 shadow-xl shadow-black/10">
                <div className="flex items-start gap-4">
                  <input
                    type="checkbox"
                    checked={task.status === 'done'}
                    onChange={() => void toggleTask(task)}
                    className="mt-1 h-5 w-5 accent-teal-300"
                  />
                  <div className="min-w-0 flex-1">
                    <p className={`text-lg font-semibold ${task.status === 'done' ? 'text-slate-500 line-through' : 'text-white'}`}>{task.task}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      {task.due_date && <span className="rounded-full bg-white/10 px-3 py-1 text-slate-300">{new Date(task.due_date).toLocaleString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' })}</span>}
                      {task.project && <span className="rounded-full bg-blue-400/15 px-3 py-1 text-blue-200">{task.project}</span>}
                      <span className="rounded-full bg-white/10 px-3 py-1 text-slate-300">{task.priority}</span>
                      <span className="rounded-full bg-white/10 px-3 py-1 text-slate-400">→ {task.assignee_phone}</span>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
