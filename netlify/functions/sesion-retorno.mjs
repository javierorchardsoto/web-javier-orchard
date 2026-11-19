import { contextInfo, getSesionStore, getPruebaStore, webpayClient } from '../lib/runtime.mjs';
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

  // La compra de prueba de $50 (orden P50-…) vive en un almacén aparte y vuelve a su propia página.
  let esPrueba = String(params.TBK_ORDEN_COMPRA || '').startsWith('P50-');
  if (!esPrueba && params.token_ws) {
    try {
      esPrueba = Boolean(await getPruebaStore().get(`token-${params.token_ws}`, { type: 'json' }));
    } catch {
      /* si falla, se trata como compra normal */
    }
  }

  let resultado = 'error';
  let orden = '';
  try {
    const r = await procesarRetorno({
      store: esPrueba ? getPruebaStore() : getSesionStore(info),
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
  if (esPrueba) return Response.redirect(`${origin}/prueba-50.html?pago=${resultado}`, 303);
  return Response.redirect(`${origin}/sesiondiciembre?pago=${resultado}${orden}`, 303);
};

export const config = { path: '/api/sesion/retorno' };
