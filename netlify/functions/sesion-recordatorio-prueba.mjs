import { timingSafeEqual } from 'node:crypto';
import { json } from '../lib/runtime.mjs';
import { crearNotificador } from '../lib/brevo.mjs';

// Envía a Javier (nunca a compradores) una copia del correo de recordatorio para revisarlo.
// Uso: /api/sesion/recordatorio-prueba?token=TU_TOKEN
export default async (req) => {
  const esperado = process.env.ADMIN_TOKEN || '';
  const dado = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('token') || '';
  const a = Buffer.from(dado);
  const b = Buffer.from(esperado);
  if (!esperado || a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: 'no autorizado' }, 401);
  const para = process.env.NOTIFY_EMAIL || process.env.REPLY_TO_EMAIL;
  if (!para) return json({ error: 'falta NOTIFY_EMAIL o REPLY_TO_EMAIL' }, 400);
  try {
    await crearNotificador().recordatorio({ orden: { nombre: 'Javier (prueba)', email: para } });
    return json({ enviado: true });
  } catch (e) {
    return json({ enviado: false, error: String(e.message).slice(0, 200) }, 500);
  }
};

export const config = { path: '/api/sesion/recordatorio-prueba' };
