import { google } from 'googleapis';
import { requireEnv } from '../env';

function getOAuthClient() {
  const oauth = new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET')
  );

  oauth.setCredentials({ refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN') });
  return oauth;
}

export async function createCalendarEvent(opts: {
  summary: string;
  startISO: string;
  endISO: string;
  description?: string;
  attendeeEmail?: string;
}) {
  const calendar = google.calendar({ version: 'v3', auth: getOAuthClient() });

  return calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: opts.summary,
      description: opts.description,
      start: { dateTime: opts.startISO, timeZone: 'Asia/Jakarta' },
      end: { dateTime: opts.endISO, timeZone: 'Asia/Jakarta' },
      attendees: opts.attendeeEmail ? [{ email: opts.attendeeEmail }] : undefined,
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
    },
  });
}
