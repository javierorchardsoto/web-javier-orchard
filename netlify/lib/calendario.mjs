// Evento de calendario de la sesión: archivo .ics (Apple, Outlook, Android) y enlace a Google Calendar.
// Es una función pura: recibe los datos de conexión y devuelve texto, para poder probarla sin red.
import { SESION } from './core.mjs';

const pad = (n) => String(n).padStart(2, '0');

// 2026-12-13T13:30:00Z -> 20261213T133000Z
export function fechaUtc(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// Texto de un campo iCalendar: escapa \ ; , y saltos de línea.
const escIcs = (s) =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');

// Las líneas de un .ics no pueden pasar de 75 bytes: se parten y se continúan con un espacio.
function plegar(linea) {
  const enc = new TextEncoder();
  if (enc.encode(linea).length <= 75) return linea;
  const partes = [];
  let resto = Array.from(linea);
  let max = 75;
  while (resto.length) {
    let tomados = '';
    let bytes = 0;
    while (resto.length) {
      const c = resto[0];
      const b = enc.encode(c).length;
      if (bytes + b > max) break;
      tomados += c;
      bytes += b;
      resto.shift();
    }
    partes.push(tomados);
    max = 74; // las continuaciones llevan un espacio al inicio
  }
  return partes.join('\r\n ');
}

export function datosConexion({ zoomUrl, zoomId, zoomPasscode } = {}) {
  const lineas = [];
  if (zoomUrl) lineas.push(`Enlace para conectarte: ${zoomUrl}`);
  else lineas.push('El enlace para conectarte te llegará por correo antes de la sesión.');
  if (zoomId || zoomPasscode) {
    lineas.push(
      'Si Zoom te lo pide: ' +
        [zoomId ? `ID de reunión ${zoomId}` : '', zoomPasscode ? `código de acceso ${zoomPasscode}` : ''].filter(Boolean).join(' · ')
    );
  }
  return lineas;
}

function descripcion(opts) {
  return [
    `${SESION.titulo}. ${SESION.duracionTexto}.`,
    '',
    ...datosConexion(opts),
    '',
    'Para llegar bien: un computador con cámara, micrófono e internet estable; un lugar tranquilo; papel y lápiz; agua o un té.',
    '',
    'Javier, Hari Avtar',
  ].join('\n');
}

export function generarIcs({ ordenId, now = Date.now(), ...conexion } = {}) {
  const inicio = SESION.inicioMs;
  const fin = inicio + SESION.duracionMin * 60000;
  const ubicacion = conexion.zoomUrl || 'Online (Zoom)';
  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Javier Orchard//Sesion grupal//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ordenId || SESION.id}@javierorchard.com`,
    `DTSTAMP:${fechaUtc(now)}`,
    `DTSTART:${fechaUtc(inicio)}`,
    `DTEND:${fechaUtc(fin)}`,
    `SUMMARY:${escIcs(SESION.titulo)}`,
    `DESCRIPTION:${escIcs(descripcion(conexion))}`,
    `LOCATION:${escIcs(ubicacion)}`,
    `URL:${SESION.urlPublica}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escIcs('Mañana: ' + SESION.titulo)}`,
    'TRIGGER:-P1D',
    'END:VALARM',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escIcs('En 30 minutos: ' + SESION.titulo)}`,
    'TRIGGER:-PT30M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lineas.map(plegar).join('\r\n') + '\r\n';
}

export function urlGoogleCalendar(conexion = {}) {
  const inicio = SESION.inicioMs;
  const fin = inicio + SESION.duracionMin * 60000;
  const q = new URLSearchParams({
    action: 'TEMPLATE',
    text: SESION.titulo,
    dates: `${fechaUtc(inicio)}/${fechaUtc(fin)}`,
    details: descripcion(conexion),
    location: conexion.zoomUrl || 'Online (Zoom)',
    ctz: 'America/Santiago',
  });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

// Enlaces de la orden (el número de orden es lo que protege los datos de conexión).
export const enlaceIcs = (origin, ordenId) => `${origin}/api/sesion/calendario?orden=${encodeURIComponent(ordenId)}`;
export const enlaceGoogle = (origin, ordenId) => `${enlaceIcs(origin, ordenId)}&formato=google`;
