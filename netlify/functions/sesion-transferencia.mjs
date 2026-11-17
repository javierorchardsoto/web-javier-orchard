import { contextInfo, getSesionStore, json } from '../lib/runtime.mjs';
import { crearTransferencia, datosTransferencia } from '../lib/core.mjs';
import { crearNotificador } from '../lib/brevo.mjs';

// Reserva un cupo por una hora y entrega los datos para pagar por transferencia bancaria.
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
  const r = await crearTransferencia({
    store: getSesionStore(info),
    notify: crearNotificador(),
    datos: datosTransferencia(),
    body,
    origin,
  });
  return json(r.body, r.status);
};

export const config = { path: '/api/sesion/transferencia' };
