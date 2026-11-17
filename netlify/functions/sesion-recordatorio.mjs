import { contextInfo, getSesionStore } from '../lib/runtime.mjs';
import { enviarRecordatorios } from '../lib/core.mjs';
import { crearNotificador } from '../lib/brevo.mjs';

// Se ejecuta cada hora (solo en el sitio publicado). Envía el recordatorio, una sola vez por persona,
// desde 24 horas antes de la sesión hasta su inicio.
export default async (req, context) => {
  const info = contextInfo(context);
  const r = await enviarRecordatorios({ store: getSesionStore(info), notify: crearNotificador() });
  console.log('Recordatorios:', JSON.stringify(r));
};

export const config = { schedule: '@hourly' };
