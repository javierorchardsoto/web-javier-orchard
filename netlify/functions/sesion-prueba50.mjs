import { adminOk, getPruebaStore, webpayClient, contextInfo, json } from '../lib/runtime.mjs';
import { crearCheckout } from '../lib/core.mjs';

// Compra de prueba de $50 que Transbank pide para cerrar el paso a producción. Privada: exige el token de
// administración, funciona aunque la venta esté cerrada y usa un almacén aparte (no gasta cupos reales).
export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'metodo' }, 405);
  if (!adminOk(req)) return json({ error: 'no autorizado' }, 401);
  const origin = new URL(req.url).origin;
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalido' }, 400);
  }
  const r = await crearCheckout({
    store: getPruebaStore(),
    webpay: webpayClient(contextInfo(context)),
    body: { ...body, aceptaPolitica: true, aceptaCorreo: true },
    origin,
    monto: 50,
    prefijo: 'P50',
  });
  return json(r.body, r.status);
};

export const config = { path: '/api/sesion/prueba50' };
