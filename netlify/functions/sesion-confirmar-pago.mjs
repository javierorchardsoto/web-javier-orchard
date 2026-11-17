import { contextInfo, getSesionStore } from '../lib/runtime.mjs';
import { confirmarTransferencia, transferenciaPorToken, TOKEN_CONFIRMAR_RE } from '../lib/core.mjs';
import { crearNotificador } from '../lib/brevo.mjs';

// Página para que Javier confirme que recibió una transferencia. El enlace llega a su correo.
// Abrir el enlace solo muestra los datos; el cupo se confirma al apretar el botón (así un
// antivirus o una vista previa del correo no confirman nada por accidente).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clp = (n) => '$' + Number(n).toLocaleString('es-CL');

const pagina = (titulo, cuerpo, status = 200) =>
  new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(titulo)}</title>
<style>body{margin:0;background:#F6F1E7;color:#1F3454;font:17px/1.6 Georgia,serif}main{max-width:34rem;margin:0 auto;padding:2rem 1.25rem}h1{font-size:1.5rem;font-weight:400}button{font:600 1rem system-ui,sans-serif;padding:.85rem 1.35rem;border-radius:999px;border:1px solid #D9A441;background:#E8BC62;color:#1F3454;cursor:pointer}.nota{color:#4F6480;font-size:.95rem}</style></head><body><main>${cuerpo}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } }
  );

export default async (req, context) => {
  const info = contextInfo(context);
  const store = getSesionStore(info);
  const url = new URL(req.url);
  let token = url.searchParams.get('t') || '';

  if (req.method === 'POST') {
    try {
      token = String((await req.formData()).get('t') || '');
    } catch {
      /* sin datos */
    }
    const r = await confirmarTransferencia({ store, notify: crearNotificador(), token, origin: url.origin });
    if (r.resultado === 'ok') {
      return pagina('Pago confirmado', `<h1>Listo, cupo confirmado.</h1><p>${esc(r.orden.nombre)} ya está inscrita(o). Le envié la confirmación con el enlace para conectarse.</p>`);
    }
    if (r.resultado === 'ya') return pagina('Ya estaba confirmado', `<h1>Este pago ya estaba confirmado.</h1><p class="nota">No se hizo ningún cambio.</p>`);
    if (r.resultado === 'sin-cupo') {
      return pagina(
        'Sin cupo',
        `<h1>No quedan cupos.</h1><p>${esc(r.orden.nombre)} (${esc(r.orden.email)}) transfirió después de que venciera su reserva y los cupos ya se agotaron. Hay que devolverle la transferencia.</p>`,
        409
      );
    }
    return pagina('Enlace no válido', `<h1>Este enlace no es válido.</h1>`, 404);
  }

  if (!TOKEN_CONFIRMAR_RE.test(token)) return pagina('Enlace no válido', `<h1>Este enlace no es válido.</h1>`, 404);
  const orden = await transferenciaPorToken(store, token);
  if (!orden) return pagina('Enlace no válido', `<h1>Este enlace no es válido.</h1>`, 404);
  if (orden.estado === 'pagada') return pagina('Ya estaba confirmado', `<h1>Este pago ya estaba confirmado.</h1><p>${esc(orden.nombre)} ya está inscrita(o).</p>`);
  return pagina(
    'Confirmar transferencia',
    `<h1>¿Ya viste el depósito en tu banco?</h1>
<p><b>${esc(orden.nombre)}</b> (${esc(orden.email)})<br>${clp(orden.monto)} CLP · referencia ${esc(orden.id)}</p>
<form method="post"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Sí, recibí la transferencia: confirmar cupo</button></form>
<p class="nota">Al confirmar, se le envía el correo con el enlace de Zoom. Confirma solo si el dinero ya está en tu cuenta.</p>`
  );
};

export const config = { path: '/api/sesion/confirmar-pago' };
