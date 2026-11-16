// Correos por Brevo: confirmación a la persona, aviso a Javier y registro en la lista de contactos.
import { SESION } from './core.mjs';

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
    ? `<p style="font-size:14px;color:#4F6480">Si Zoom te lo pide: ${process.env.ZOOM_ID ? `ID de reunión <b>${esc(process.env.ZOOM_ID)}</b>` : ''}${process.env.ZOOM_ID && process.env.ZOOM_PASSCODE ? ' · ' : ''}${process.env.ZOOM_PASSCODE ? `código de acceso <b>${esc(process.env.ZOOM_PASSCODE)}</b>` : ''}.</p>`
    : '';
  return enlace + '\n' + datos;
}

// BORRADOR: texto general para que Javier lo revise y lo ajuste a su manera de preparar la sesión.
const PREPARACION = `<p><b>Para llegar bien a la sesión</b></p>
<ul style="padding-left:20px;margin:0 0 12px">
<li>Busca un lugar donde nadie te interrumpa durante los 90 minutos.</li>
<li>Conéctate unos minutos antes, para entrar sin apuro.</li>
<li>Ten a mano algo para anotar, si te sirve.</li>
</ul>`;

const INVITAR = `<p style="font-size:14px;color:#4F6480">¿Conoces a alguien a quien le pueda servir? Cada persona reserva su propio cupo en <a href="${SESION.urlPublica}">${SESION.urlPublica}</a>. El enlace de conexión de este correo es solo para ti.</p>`;

const cabecera = (nombre) => `<!doctype html><html lang="es"><body style="margin:0;background:#F6F1E7;color:#1F3454;font-family:Georgia,serif;line-height:1.6">
<div style="max-width:560px;margin:0 auto;padding:28px 20px">
<p style="font-size:20px;margin:0 0 16px">Hola, ${nombre}.</p>`;

const datosSesion = () => `<p><b>${esc(SESION.titulo)}</b><br>${esc(SESION.fechaTexto)}<br>${esc(SESION.duracionTexto)}</p>`;

const NO_PSICOTERAPIA = `<p style="font-size:14px;color:#4F6480">Es un acompañamiento grupal para el autoconocimiento. No es psicoterapia ni reemplaza la atención de un profesional de salud mental.</p>`;

export function textoConfirmacion({ orden, pago }) {
  return `${cabecera(esc(orden.nombre.split(' ')[0]))}
<p>Tu cupo está confirmado. Gracias por anotarte.</p>
${datosSesion()}
${bloqueEnlace()}
${PREPARACION}
<p>Si asistes, recibirás la grabación y podrás verla durante 30 días. Un día antes te enviaré un recordatorio.</p>
${INVITAR}
<p style="border-left:3px solid #2F4A6B;padding:6px 14px;background:#D9E3EC">Esta compra no tiene devolución. Lo informé antes de que pagaras y quedó aceptado al reservar tu cupo.</p>
${NO_PSICOTERAPIA}
<hr style="border:none;border-top:1px solid #D9CFBD;margin:24px 0">
<p style="font-size:13px;color:#4F6480">Comprobante: orden ${esc(orden.id)} · ${clp(orden.monto)} CLP · autorización ${esc((pago && pago.autorizacion) || '')}<br>
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
  const sender = { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'Javier Orchard Soto' };
  // Las respuestas de los compradores van a REPLY_TO_EMAIL (p. ej. un Gmail) si el remitente no tiene buzón.
  const replyTo = process.env.REPLY_TO_EMAIL ? { email: process.env.REPLY_TO_EMAIL, name: sender.name } : sender;
  const listId = Number(process.env.BREVO_LIST_ID) || null;
  return {
    async confirmar({ orden, pago }) {
      if (!process.env.BREVO_API_KEY || !sender.email) {
        console.warn('Brevo sin configurar: no se envió la confirmación de', orden.id);
        return;
      }
      await brevo('/smtp/email', {
        sender,
        to: [{ email: orden.email, name: orden.nombre }],
        replyTo,
        subject: 'Tu cupo está confirmado: sesión grupal del 13 de diciembre',
        htmlContent: textoConfirmacion({ orden, pago }),
      });
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
