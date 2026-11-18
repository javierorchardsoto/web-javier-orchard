import { adminOk, contextInfo, getSesionStore, webpayClient, json } from '../lib/runtime.mjs';
import { reembolsar } from '../lib/pruebas.mjs';

// Reembolsa una compra (total o parcial). Solo con el token de administración.
// Uso: POST /api/sesion/reembolso con cuerpo {"token":"<token de la compra>","monto":5000} (sin "monto" = el total restante).
export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'método' }, 405);
  if (!adminOk(req)) return json({ error: 'no autorizado' }, 401);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalido' }, 400);
  }
  const info = contextInfo(context);
  const r = await reembolsar({ store: getSesionStore(info), webpay: webpayClient(info), token: body && body.token, monto: body && body.monto });
  return json(r.body, r.status);
};

export const config = { path: '/api/sesion/reembolso' };
