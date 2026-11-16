import { contextInfo, getSesionStore, webpayClient } from '../lib/runtime.mjs';
import { procesarRetorno } from '../lib/core.mjs';
import { crearNotificador } from '../lib/brevo.mjs';

// Webpay devuelve a la persona a esta dirección (por POST o GET) con el resultado del pago.
export default async (req, context) => {
  const info = contextInfo(context);
  const origin = new URL(req.url).origin;
  const params = {};
  if (req.method === 'POST') {
    try {
      for (const [k, v] of (await req.formData()).entries()) params[k] = String(v);
    } catch {
      /* sin datos */
    }
  } else {
    for (const [k, v] of new URL(req.url).searchParams.entries()) params[k] = v;
  }

  let resultado = 'error';
  let orden = '';
  try {
    const r = await procesarRetorno({
      store: getSesionStore(info),
      webpay: webpayClient(info),
      notify: crearNotificador(),
      params,
      origin,
    });
    resultado = r.resultado;
    if (resultado === 'ok' && r.orden) orden = `&orden=${encodeURIComponent(r.orden)}`;
  } catch (e) {
    console.error('retorno falló', e);
  }
  return Response.redirect(`${origin}/?pago=${resultado}${orden}#sesion`, 303);
};

export const config = { path: '/api/sesion/retorno' };
