import twilio from 'twilio';
import { requireEnv } from '../env';

function getWhatsAppAddress(phone: string) {
  return phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;
}

function getTwilioClient() {
  return twilio(
    requireEnv('TWILIO_ACCOUNT_SID'),
    requireEnv('TWILIO_AUTH_TOKEN')
  );
}

export async function sendWhatsApp(to: string, body: string) {
  return getTwilioClient().messages.create({
    from: getWhatsAppAddress(requireEnv('TWILIO_WHATSAPP_NUMBER')),
    to: getWhatsAppAddress(to),
    body,
  });
}
