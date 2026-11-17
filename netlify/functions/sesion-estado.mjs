import { contextInfo, getSesionStore, json } from '../lib/runtime.mjs';
import { contarCupos, datosTransferencia, SESION } from '../lib/core.mjs';

export default async (req, context) => {
  const info = contextInfo(context);
  if (!info.abierto) return json({ abierto: false });
  const cupos = await contarCupos(getSesionStore(info), Date.now());
  return json({
    abierto: true,
    modoPrueba: info.modoPrueba,
    agotado: cupos.disponibles === 0,
    cerrado: Date.now() > SESION.ultimoPagoMs,
    transferencia: Boolean(datosTransferencia()),
    montoClp: SESION.montoClp,
  });
};

export const config = { path: '/api/sesion/estado' };
