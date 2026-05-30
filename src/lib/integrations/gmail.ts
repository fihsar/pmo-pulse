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

function encodeMessage(value: string) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  htmlBody: string;
}) {
  const gmail = google.gmail({ version: 'v1', auth: getOAuthClient() });
  const raw = encodeMessage(
    `To: ${opts.to.join(', ')}\r\n` +
      `Subject: ${opts.subject}\r\n` +
      'MIME-Version: 1.0\r\n' +
      'Content-Type: text/html; charset=utf-8\r\n\r\n' +
      opts.htmlBody
  );

  return gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}
