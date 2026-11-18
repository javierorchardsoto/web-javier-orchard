// Conexión con Netlify (almacenamiento), Transbank y el contexto de despliegue.
import { timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import transbank from 'transbank-sdk';

const { WebpayPlus, IntegrationCommerceCodes, IntegrationApiKeys } = transbank;

export function contextInfo(context) {
  const ctx = (context && context.deploy && context.deploy.context) || process.env.CONTEXT || 'production';
  const esProduccion = ctx === 'production';
  const cobraDeVerdad = process.env.TBK_ENV === 'production';
  const brevoListo = Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
  // En el sitio publicado, la venta solo se abre cuando todo está listo y Javier la activa a propósito.
  // En vistas previas se puede probar siempre, con el ambiente de integración de Transbank (sin cobro).
  const abierto = esProduccion
    ? cobraDeVerdad && brevoListo && Boolean(process.env.TBK_COMMERCE_CODE && process.env.TBK_API_KEY) && process.env.SESION_ABIERTA === '1'
    : true;
  return { esProduccion, cobraDeVerdad: esProduccion && cobraDeVerdad, abierto, modoPrueba: !(esProduccion && cobraDeVerdad) };
}

export function getSesionStore(info) {
  // Las pruebas usan un almacén aparte para no tocar los cupos reales.
  return getStore({ name: info.esProduccion ? 'sesion-13-dic' : 'sesion-13-dic-prueba', consistency: 'strong' });
}

export function webpayClient(info) {
  return info.cobraDeVerdad
    ? WebpayPlus.Transaction.buildForProduction(process.env.TBK_COMMERCE_CODE, process.env.TBK_API_KEY)
    : WebpayPlus.Transaction.buildForIntegration(IntegrationCommerceCodes.WEBPAY_PLUS, IntegrationApiKeys.WEBPAY);
}

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// ¿La petición trae el token de administración (ADMIN_TOKEN)? Acepta "Authorization: Bearer ..." o ?token=...
export function adminOk(req) {
  const esperado = process.env.ADMIN_TOKEN || '';
  const dado = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('token') || '';
  const a = Buffer.from(dado);
  const b = Buffer.from(esperado);
  return Boolean(esperado) && a.length === b.length && timingSafeEqual(a, b);
}
