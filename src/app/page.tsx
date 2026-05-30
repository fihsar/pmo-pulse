'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
  const [phone, setPhone] = useState('');
  const router = useRouter();

  function handleLogin() {
    const normalized = phone.replace(/\D/g, '');
    if (normalized.length < 10) return alert('Invalid phone number');

    localStorage.setItem('pulse_phone', `+${normalized}`);
    router.push('/dashboard');
  }

  return (
    <main className="min-h-screen overflow-hidden bg-[#07111f] px-6 py-10 text-white">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(20,184,166,0.28),_transparent_34%),radial-gradient(circle_at_bottom_right,_rgba(59,130,246,0.22),_transparent_32%)]" />
      <section className="relative mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl items-center gap-10 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.36em] text-teal-200">PMO Pulse</p>
          <h1 className="mt-5 max-w-3xl text-5xl font-black leading-[0.95] tracking-tight md:text-7xl">
            WhatsApp-first project command center.
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-slate-300">
            Turn natural-language PMO updates into assigned tasks, audit events, reminders, and a live executive dashboard.
          </p>
        </div>

        <div className="rounded-[2rem] border border-white/10 bg-white/10 p-6 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <div className="rounded-[1.5rem] bg-white p-6 text-slate-950">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-500">Dashboard Access</p>
            <h2 className="mt-3 text-3xl font-bold">Open your PMO queue</h2>
            <label className="mt-6 block text-sm font-medium text-slate-700">WhatsApp number</label>
            <input
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleLogin();
              }}
              placeholder="+628123456789"
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-base outline-none ring-brand/20 transition focus:border-brand focus:ring-4"
            />
            <button
              onClick={handleLogin}
              className="mt-5 w-full rounded-2xl bg-brand px-5 py-3 font-bold text-white shadow-lg shadow-brand/20 transition hover:-translate-y-0.5 hover:bg-[#172d58]"
            >
              Open Dashboard
            </button>
            <p className="mt-4 text-xs leading-5 text-slate-500">
              Hackathon auth uses local phone storage for speed. Production should replace this with verified auth.
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
