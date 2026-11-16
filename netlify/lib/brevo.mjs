// Correos por Brevo: confirmación a la persona, aviso a Javier y registro en la lista de contactos.
import { SESION } from './core.mjs';
import { generarIcs, enlaceIcs, enlaceGoogle } from './calendario.mjs';

const API = 'https://api.brevo.com/v3';

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const clp = (n) => '$' + Number(n).toLocaleString('es-CL');

async function brevo(path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Brevo ${path} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}

function bloqueEnlace() {
  const enlace = process.env.ZOOM_URL
    ? `<p><b>Enlace para conectarte:</b> <a href="${esc(process.env.ZOOM_URL)}">${esc(process.env.ZOOM_URL)}</a></p>`
    : '<p><b>Enlace para conectarte:</b> te lo enviaré por correo antes de la sesión.</p>';
  // Si la reunión pide ID y código, se muestran como respaldo del enlace (ZOOM_ID y ZOOM_PASSCODE, opcionales).
  const datos = process.env.ZOOM_ID || process.env.ZOOM_PASSCODE
    ? `<p style="font-size:15.4px;color:#4F6480">Si Zoom te lo pide: ${process.env.ZOOM_ID ? `ID de reunión <b>${esc(process.env.ZOOM_ID)}</b>` : ''}${process.env.ZOOM_ID && process.env.ZOOM_PASSCODE ? ' · ' : ''}${process.env.ZOOM_PASSCODE ? `código de acceso <b>${esc(process.env.ZOOM_PASSCODE)}</b>` : ''}.</p>`
    : '';
  return enlace + '\n' + datos;
}

// Enlaces para agregar la sesión al calendario (el número de orden protege los datos de conexión).
function bloqueCalendario(origin, ordenId) {
  if (!origin || !ordenId) return '';
  return `<p><b>Agrégala a tu calendario:</b> <a href="${esc(enlaceGoogle(origin, ordenId))}">Google Calendar</a> · <a href="${esc(enlaceIcs(origin, ordenId))}">Apple, Outlook u otro (.ics)</a><br><span style="font-size:15.4px;color:#4F6480">El archivo del evento también va adjunto a este correo.</span></p>`;
}

// Preparación para la sesión (texto de Javier).
const PREPARACION = `<p><b>Recomendaciones para llegar bien a la sesión</b></p>
<ul style="padding-left:20px;margin:0 0 12px">
<li>Un computador para conectarte, con cámara y micrófono funcionando y una conexión a internet estable.</li>
<li>Un lugar cómodo y tranquilo, donde puedas estar sin distracciones externas.</li>
<li>Papel y lápiz para escribir.</li>
<li>Agua, un té o lo que necesites para sentirte a gusto durante la sesión.</li>
</ul>`;

const INVITAR = `<p style="font-size:15.4px;color:#4F6480">¿Conoces a alguien a quien le pueda servir? Cada persona reserva su propio cupo en <a href="${SESION.urlPublica}">${SESION.urlPublica}</a>. El enlace de conexión de este correo es solo para ti.</p>`;

const cabecera = (nombre) => `<!doctype html><html lang="es"><body style="margin:0;background:#F6F1E7;color:#1F3454;font-family:Lora,Georgia,serif;font-size:17.6px;line-height:1.6">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<p style="font-size:22px;margin:0 0 16px">Hola, ${nombre}.</p>`;

const datosSesion = () => `<p><b>${esc(SESION.titulo)}</b><br>${esc(SESION.fechaTexto)}<br>${esc(SESION.duracionTexto)}</p>`;

const NO_PSICOTERAPIA = `<p style="font-size:15.4px;color:#4F6480">Esta sesión es un acompañamiento grupal para el autoconocimiento. No es psicoterapia ni reemplaza la atención de un profesional de salud mental.</p>`;

// El recordatorio solo se envía a quien pagó antes de la ventana de 24 h previa a la sesión.
const recibeRecordatorio = (orden) =>
  (orden.pagada || Date.now()) < SESION.inicioMs - SESION.recordatorioHorasAntes * 3600000;

export function textoConfirmacion({ orden, pago, origin }) {
  return `${cabecera(esc(orden.nombre.split(' ')[0]))}
<p>Tu cupo está confirmado. Gracias por inscribirte.</p>
${datosSesion()}
${bloqueEnlace()}
${bloqueCalendario(origin, orden.id)}
${PREPARACION}
${recibeRecordatorio(orden) ? '<p>Un día antes de la sesión, te enviaré un recordatorio por email.</p>' : ''}
<p>Si no puedes asistir, puedes pedirme la devolución de tu pago hasta el domingo 6 de diciembre, respondiendo a este correo o escribiéndome por WhatsApp.</p>
${INVITAR}
${NO_PSICOTERAPIA}
<hr style="border:none;border-top:1px solid #D9CFBD;margin:24px 0">
<p style="font-size:14.3px;color:#4F6480">Comprobante: orden ${esc(orden.id)} · ${clp(orden.monto)} CLP · autorización ${esc((pago && pago.autorizacion) || '')}<br>
Si algo no te calza o tienes una duda, responde a este correo.</p>
<p>Javier, Hari Avtar</p>
</div></body></html>`;
}

export function textoRecordatorio({ orden }) {
  return `${cabecera(esc(orden.nombre.split(' ')[0]))}
<p>Mañana nos vemos.</p>
${datosSesion()}
${bloqueEnlace()}
${PREPARACION}
${INVITAR}
${NO_PSICOTERAPIA}
<p>Si algo no te calza o tienes una duda, responde a este correo.</p>
<p>Javier, Hari Avtar</p>
</div></body></html>`;
}

export function crearNotificador() {
  const sender = { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'Javier, Hari Avtar' };
  // Las respuestas de los compradores van a REPLY_TO_EMAIL (p. ej. un Gmail) si el remitente no tiene buzón.
  const replyTo = process.env.REPLY_TO_EMAIL ? { email: process.env.REPLY_TO_EMAIL, name: sender.name } : sender;
  const listId = Number(process.env.BREVO_LIST_ID) || null;
  return {
    async confirmar({ orden, pago, origin }) {
      if (!process.env.BREVO_API_KEY || !sender.email) {
        console.warn('Brevo sin configurar: no se envió la confirmación de', orden.id);
        return;
      }
      const correo = {
        sender,
        to: [{ email: orden.email, name: orden.nombre }],
        replyTo,
        subject: 'Tu cupo está confirmado: sesión grupal del 13 de diciembre',
        htmlContent: textoConfirmacion({ orden, pago, origin }),
      };
      const ics = generarIcs({
        ordenId: orden.id,
        zoomUrl: process.env.ZOOM_URL,
        zoomId: process.env.ZOOM_ID,
        zoomPasscode: process.env.ZOOM_PASSCODE,
      });
      try {
        await brevo('/smtp/email', {
          ...correo,
          attachment: [{ name: 'sesion-grupal-13-dic.ics', content: Buffer.from(ics, 'utf-8').toString('base64') }],
        });
      } catch (e) {
        // Si Brevo no acepta el adjunto, la confirmación sale igual, con los enlaces al calendario en el cuerpo.
        console.error('Confirmación con adjunto falló; se reenvía sin adjunto', orden.id, String(e && e.message).slice(0, 200));
        await brevo('/smtp/email', correo);
      }
      if (listId) {
        await brevo('/contacts', {
          email: orden.email,
          attributes: { FIRSTNAME: orden.nombre },
          listIds: [listId],
          updateEnabled: true,
        });
      }
    },
    async recordatorio({ orden }) {
      if (!process.env.BREVO_API_KEY || !sender.email) throw new Error('Brevo sin configurar');
      await brevo('/smtp/email', {
        sender,
        to: [{ email: orden.email, name: orden.nombre }],
        replyTo,
        subject: 'Mañana: sesión grupal del 13 de diciembre',
        htmlContent: textoRecordatorio({ orden }),
      });
    },
    async aviso({ orden, pago, ocupados }) {
      const to = process.env.NOTIFY_EMAIL || replyTo.email;
      if (!process.env.BREVO_API_KEY || !to) return;
      await brevo('/smtp/email', {
        sender,
        to: [{ email: to }],
        subject: `Nueva inscripción (${ocupados}/${SESION.total}): ${orden.nombre}`,
        htmlContent: `<p>${esc(orden.nombre)} (${esc(orden.email)}) pagó ${clp(orden.monto)} CLP.<br>Orden ${esc(orden.id)} · autorización ${esc((pago && pago.autorizacion) || '')}.</p>`,
      });
    },
  };
}
