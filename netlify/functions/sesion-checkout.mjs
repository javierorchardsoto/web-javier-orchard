import { contextInfo, getSesionStore, webpayClient, json } from '../lib/runtime.mjs';
import { crearCheckout } from '../lib/core.mjs';

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'metodo' }, 405);
  const info = contextInfo(context);
  if (!info.abierto) return json({ error: 'cerrado' }, 503);

  const origin = new URL(req.url).origin;
  const desde = req.headers.get('origin');
  if (desde && desde !== origin) return json({ error: 'origen' }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalido' }, 400);
  }
  const r = await crearCheckout({ store: getSesionStore(info), webpay: webpayClient(info), body, origin });
  return json(r.body, r.status);
};

export const config = { path: '/api/sesion/checkout' };
