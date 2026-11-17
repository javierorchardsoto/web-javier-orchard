import { contextInfo, getSesionStore } from '../lib/runtime.mjs';
import { enviarRecordatorios, avisarTransferenciasVencidas } from '../lib/core.mjs';
import { crearNotificador } from '../lib/brevo.mjs';

// Se ejecuta cada hora (solo en el sitio publicado). Envía el recordatorio, una sola vez por persona,
// desde 24 horas antes de la sesión hasta su inicio.
export default async (req, context) => {
  const info = contextInfo(context);
  const store = getSesionStore(info);
  const notify = crearNotificador();
  console.log('Recordatorios:', JSON.stringify(await enviarRecordatorios({ store, notify })));
  console.log('Reservas vencidas:', JSON.stringify(await avisarTransferenciasVencidas({ store, notify })));
};

export const config = { schedule: '@hourly' };
