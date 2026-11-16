import { timingSafeEqual } from 'node:crypto';
import { contextInfo, getSesionStore, json } from '../lib/runtime.mjs';
import { inscritosCsv } from '../lib/core.mjs';

// Lista de inscritos pagados en CSV, solo para Javier: requiere el token ADMIN_TOKEN.
// Uso: abrir /api/sesion/inscritos?token=TU_TOKEN (o enviar "Authorization: Bearer TU_TOKEN").
export default async (req, context) => {
  const esperado = process.env.ADMIN_TOKEN || '';
  const url = new URL(req.url);
  const dado = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  const a = Buffer.from(dado);
  const b = Buffer.from(esperado);
  if (!esperado || a.length !== b.length || !timingSafeEqual(a, b)) return json({ error: 'no autorizado' }, 401);

  const csv = await inscritosCsv(getSesionStore(contextInfo(context)));
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="inscritos-sesion-13-dic.csv"',
      'cache-control': 'no-store',
    },
  });
};

export const config = { path: '/api/sesion/inscritos' };
