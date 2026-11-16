import { contextInfo, getSesionStore, json } from '../lib/runtime.mjs';
import { contarCupos, SESION } from '../lib/core.mjs';

export default async (req, context) => {
  const info = contextInfo(context);
  if (!info.abierto) return json({ abierto: false });
  const cupos = await contarCupos(getSesionStore(info), Date.now());
  return json({
    abierto: true,
    modoPrueba: info.modoPrueba,
    total: cupos.total,
    disponibles: cupos.disponibles,
    agotado: cupos.disponibles === 0,
    montoClp: SESION.montoClp,
  });
};

export const config = { path: '/api/sesion/estado' };
