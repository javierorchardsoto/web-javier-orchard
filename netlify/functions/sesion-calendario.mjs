import { contextInfo, getSesionStore, json } from '../lib/runtime.mjs';
import { ordenPagada } from '../lib/core.mjs';
import { generarIcs, urlGoogleCalendar } from '../lib/calendario.mjs';

// Evento de calendario con los datos de conexión. Solo lo entrega si el número de orden corresponde
// a una compra pagada; si no, responde 404 sin dar pistas. ?formato=google redirige a Google Calendar.
export default async (req, context) => {
  const url = new URL(req.url);
  const ordenId = url.searchParams.get('orden');
  const orden = await ordenPagada(getSesionStore(contextInfo(context)), ordenId);
  if (!orden) return json({ error: 'no encontrado' }, 404);

  const conexion = {
    zoomUrl: process.env.ZOOM_URL,
    zoomId: process.env.ZOOM_ID,
    zoomPasscode: process.env.ZOOM_PASSCODE,
  };

  if (url.searchParams.get('formato') === 'google') {
    return new Response(null, {
      status: 302,
      headers: { location: urlGoogleCalendar(conexion), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  }

  return new Response(generarIcs({ ordenId: orden.id, ...conexion }), {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'attachment; filename="sesion-grupal-13-dic.ics"',
      'cache-control': 'no-store',
    },
  });
};

export const config = { path: '/api/sesion/calendario' };
