import { adminOk, contextInfo, getSesionStore, json } from '../lib/runtime.mjs';
import { listarTokens } from '../lib/pruebas.mjs';

// Lista de compras recientes con su token, para la validación con Transbank. Solo en vistas previas
// (modo pruebas) y solo con el token de administración. En el sitio publicado no existe.
export default async (req, context) => {
  const info = contextInfo(context);
  if (info.esProduccion) return json({ error: 'no encontrado' }, 404);
  if (!adminOk(req)) return json({ error: 'no autorizado' }, 401);
  return json({ compras: await listarTokens(getSesionStore(info)) });
};

export const config = { path: '/api/sesion/pruebas' };
