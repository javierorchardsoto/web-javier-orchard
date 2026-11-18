import { contextInfo, getSesionStore, json } from '../lib/runtime.mjs';
import { comprobanteDe } from '../lib/core.mjs';

// Datos del comprobante de pago para mostrarlos al volver de Webpay. Solo responde si el número de orden
// corresponde a una compra pagada; si no, 404 sin dar pistas.
export default async (req, context) => {
  const ordenId = new URL(req.url).searchParams.get('orden');
  const c = await comprobanteDe(getSesionStore(contextInfo(context)), ordenId);
  if (!c) return json({ error: 'no encontrado' }, 404);
  return new Response(JSON.stringify(c), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
};

export const config = { path: '/api/sesion/comprobante' };
