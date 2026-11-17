// Lógica de la inscripción pagada a la sesión grupal (cupos, pago Webpay, confirmación).
// No depende de Netlify ni de Transbank directamente: recibe el almacenamiento (`store`),
// el cliente de Webpay (`webpay`) y el aviso por correo (`notify`), para poder probarla sin red.

import { randomUUID } from 'node:crypto';

export const SESION = {
  id: 'sesion-13-dic',
  total: 30,
  montoClp: 17000,
  reservaMin: 15, // minutos que se retiene un cupo mientras la persona paga con tarjeta
  transferenciaMin: 60, // minutos que se retiene un cupo mientras la persona hace la transferencia
  ultimoPagoMs: Date.parse('2026-12-12T23:59:59-03:00'), // último momento para pagar (tarjeta o transferencia)
  titulo: 'Sesión grupal: abordar los desafíos de este tiempo',
  fechaTexto: 'domingo 13 de diciembre de 2026, 10:30 (hora de Chile)',
  duracionTexto: '90 minutos, en vivo y online',
  duracionMin: 90,
  inicioMs: Date.parse('2026-12-13T10:30:00-03:00'), // hora de Chile en diciembre (UTC-3)
  recordatorioHorasAntes: 24,
  urlPublica: 'https://javierorchard.com/sesiondiciembre',
};

const seatKey = (n) => `cupo-${String(n).padStart(2, '0')}`;
const ordenKey = (id) => `orden-${id}`;
const confirmarKey = (t) => `confirmar-${t}`;
export const TOKEN_CONFIRMAR_RE = /^[a-f0-9]{32}$/;
const tokenKey = (t) => `token-${t}`;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validarEntrada(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalido' };
  if (body.web) return { ok: false, error: 'invalido' }; // trampa anti-spam: un humano no la llena
  const nombre = String(body.nombre || '').trim().replace(/\s+/g, ' ');
  const email = String(body.email || '').trim().toLowerCase();
  if (nombre.length < 2 || nombre.length > 80) return { ok: false, error: 'nombre' };
  if (!EMAIL_RE.test(email) || email.length > 120) return { ok: false, error: 'email' };
  if (body.aceptaPolitica !== true) return { ok: false, error: 'politica' };
  if (body.aceptaCorreo !== true) return { ok: false, error: 'correo' };
  return { ok: true, data: { nombre, email } };
}

// ---------- Cupos ----------

// Toma el primer cupo libre. Cada cupo es una clave que solo se puede crear una vez (onlyIfNew),
// así dos personas simultáneas nunca reciben el mismo cupo.
export async function tomarCupo(store, ordenId, now, minutos = SESION.reservaMin) {
  const rec = { estado: 'reservado', orden: ordenId, expira: now + minutos * 60000 };
  for (let n = 1; n <= SESION.total; n++) {
    const key = seatKey(n);
    const r = await store.setJSON(key, rec, { onlyIfNew: true });
    if (r.modified) return key;
    const cur = await store.getWithMetadata(key, { type: 'json' });
    if (cur && cur.data.estado === 'reservado' && cur.data.expira < now) {
      const r2 = await store.setJSON(key, rec, { onlyIfMatch: cur.etag });
      if (r2.modified) return key;
    }
  }
  return null;
}

export async function liberarCupo(store, key, ordenId) {
  const cur = await store.getWithMetadata(key, { type: 'json' });
  if (cur && cur.data.orden === ordenId && cur.data.estado === 'reservado') {
    await store.delete(key);
  }
}

export async function contarCupos(store, now) {
  const { blobs } = await store.list({ prefix: 'cupo-' });
  let ocupados = 0;
  await Promise.all(
    blobs.map(async (b) => {
      const d = await store.get(b.key, { type: 'json' });
      if (d && (d.estado === 'pagado' || (d.estado === 'reservado' && d.expira >= now))) ocupados++;
    })
  );
  return { total: SESION.total, ocupados, disponibles: Math.max(0, SESION.total - ocupados) };
}

// ---------- Checkout ----------

export async function crearCheckout({ store, webpay, body, origin, now = Date.now() }) {
  if (now > SESION.ultimoPagoMs) return { status: 409, body: { error: 'plazo' } };
  const v = validarEntrada(body);
  if (!v.ok) return { status: 400, body: { error: v.error } };

  const ordenId = 'S13-' + randomUUID().replace(/-/g, '').slice(0, 12);
  const cupo = await tomarCupo(store, ordenId, now);
  if (!cupo) return { status: 409, body: { error: 'agotado' } };

  const orden = {
    id: ordenId,
    cupo,
    nombre: v.data.nombre,
    email: v.data.email,
    monto: SESION.montoClp,
    estado: 'creada',
    creada: now,
  };
  await store.setJSON(ordenKey(ordenId), orden);

  let tx;
  try {
    tx = await webpay.create(ordenId, ordenId, SESION.montoClp, `${origin}/api/sesion/retorno`);
    await store.setJSON(tokenKey(tx.token), { orden: ordenId });
  } catch (e) {
    console.error('webpay.create falló', e);
    await liberarCupo(store, cupo, ordenId);
    await store.setJSON(ordenKey(ordenId), { ...orden, estado: 'fallida' });
    return { status: 502, body: { error: 'pasarela' } };
  }
  return { status: 200, body: { url: tx.url, token: tx.token } };
}

// ---------- Retorno desde Webpay ----------

async function marcarPagada(store, ordenId, pago, now) {
  const cur = await store.getWithMetadata(ordenKey(ordenId), { type: 'json' });
  if (!cur) return null;
  if (cur.data.estado === 'pagada') return null; // otra petición ya lo hizo
  const nueva = { ...cur.data, estado: 'pagada', pagada: now, pago };
  const r = await store.setJSON(ordenKey(ordenId), nueva, { onlyIfMatch: cur.etag });
  return r.modified ? nueva : null;
}

// Devuelve { resultado } con: ok | cancelado | rechazado | expirada | error
export async function procesarRetorno({ store, webpay, notify, params, origin, now = Date.now() }) {
  const token = params.token_ws;
  const cancelado = !token || params.TBK_TOKEN;

  if (cancelado) {
    const ordenId = params.TBK_ORDEN_COMPRA;
    if (ordenId) {
      const cur = await store.getWithMetadata(ordenKey(ordenId), { type: 'json' });
      if (cur && cur.data.estado === 'creada') {
        await liberarCupo(store, cur.data.cupo, ordenId);
        await store.setJSON(ordenKey(ordenId), { ...cur.data, estado: 'cancelada' }, { onlyIfMatch: cur.etag });
      }
    }
    return { resultado: 'cancelado' };
  }

  const mapa = await store.get(tokenKey(token), { type: 'json' });
  if (!mapa) return { resultado: 'error' };
  const ordenId = mapa.orden;
  const orden = await store.get(ordenKey(ordenId), { type: 'json' });
  if (!orden) return { resultado: 'error' };
  if (orden.estado === 'pagada') return { resultado: 'ok', orden: ordenId }; // recarga de la página de retorno

  // Antes de cobrar, comprobar que el cupo sigue siendo de esta orden.
  const cupo = await store.get(orden.cupo, { type: 'json' });
  if (!cupo || cupo.orden !== ordenId) {
    await store.setJSON(ordenKey(ordenId), { ...orden, estado: 'expirada' });
    return { resultado: 'expirada' };
  }

  let res;
  try {
    res = await webpay.commit(token);
  } catch (e) {
    // Caso ambiguo (red, token ya usado): no se libera el cupo; se revisa a mano.
    console.error('webpay.commit falló', ordenId, e);
    return { resultado: 'error' };
  }

  const aprobado =
    res &&
    res.response_code === 0 &&
    res.status === 'AUTHORIZED' &&
    res.buy_order === ordenId &&
    res.amount === orden.monto;

  if (!aprobado) {
    await liberarCupo(store, orden.cupo, ordenId);
    await store.setJSON(ordenKey(ordenId), { ...orden, estado: 'rechazada' });
    return { resultado: 'rechazado' };
  }

  await store.setJSON(orden.cupo, { estado: 'pagado', orden: ordenId, pagado: now });
  const pago = {
    autorizacion: res.authorization_code,
    tarjeta: res.card_detail && res.card_detail.card_number,
    tipo: res.payment_type_code,
    cuotas: res.installments_number,
    fecha: res.transaction_date,
  };
  const pagada = await marcarPagada(store, ordenId, pago, now);
  if (!pagada) return { resultado: 'ok', orden: ordenId };

  let emailEnviado = false;
  try {
    const { ocupados } = await contarCupos(store, now);
    await notify.confirmar({ orden: pagada, pago, origin });
    emailEnviado = true;
    await notify.aviso({ orden: pagada, pago, ocupados });
  } catch (e) {
    console.error('Aviso por correo falló', ordenId, e);
  }
  const fin = await store.getWithMetadata(ordenKey(ordenId), { type: 'json' });
  if (fin) await store.setJSON(ordenKey(ordenId), { ...fin.data, emailEnviado }, { onlyIfMatch: fin.etag });
  return { resultado: 'ok', orden: ordenId };
}

// ---------- Transferencia bancaria ----------

// Los datos de la cuenta no están en el código (el repositorio es público): vienen de variables de entorno.
export function datosTransferencia(env = process.env) {
  const d = {
    banco: env.TRANSFER_BANCO,
    tipo: env.TRANSFER_TIPO,
    cuenta: env.TRANSFER_CUENTA,
    rut: env.TRANSFER_RUT,
    titular: env.TRANSFER_TITULAR,
    email: env.TRANSFER_EMAIL,
  };
  return d.banco && d.tipo && d.cuenta && d.rut && d.titular && d.email ? d : null;
}

// Reserva un cupo por una hora y entrega los datos para transferir. El cupo queda pagado solo cuando Javier
// confirma que recibió el dinero (confirmarTransferencia).
export async function crearTransferencia({ store, notify, datos, body, origin, now = Date.now() }) {
  if (!datos) return { status: 503, body: { error: 'sin-transferencia' } };
  if (now > SESION.ultimoPagoMs) return { status: 409, body: { error: 'plazo' } };
  const v = validarEntrada(body);
  if (!v.ok) return { status: 400, body: { error: v.error } };

  // Una persona con una reserva vigente recibe la misma, en vez de ocupar otro cupo.
  const { blobs } = await store.list({ prefix: 'orden-' });
  for (const b of blobs) {
    const o = await store.get(b.key, { type: 'json' });
    if (o && o.estado === 'transferencia' && o.email === v.data.email && o.expira > now) {
      return { status: 200, body: respuestaTransferencia(o, datos) };
    }
  }

  const ordenId = 'S13-' + randomUUID().replace(/-/g, '').slice(0, 12);
  const cupo = await tomarCupo(store, ordenId, now, SESION.transferenciaMin);
  if (!cupo) return { status: 409, body: { error: 'agotado' } };

  const tokenConfirmar = randomUUID().replace(/-/g, '');
  const orden = {
    id: ordenId,
    cupo,
    nombre: v.data.nombre,
    email: v.data.email,
    monto: SESION.montoClp,
    estado: 'transferencia',
    metodo: 'transferencia',
    creada: now,
    expira: now + SESION.transferenciaMin * 60000,
  };
  await store.setJSON(ordenKey(ordenId), orden);
  await store.setJSON(confirmarKey(tokenConfirmar), { orden: ordenId });
  try {
    await notify.transferencia({ orden, datos, confirmarUrl: `${origin}/api/sesion/confirmar-pago?t=${tokenConfirmar}` });
  } catch (e) {
    console.error('Correo de transferencia falló', ordenId, e); // los datos igual se muestran en pantalla
  }
  return { status: 200, body: respuestaTransferencia(orden, datos) };
}

function respuestaTransferencia(o, datos) {
  return { orden: o.id, referencia: o.id, monto: o.monto, expira: o.expira, datos };
}

// Datos para mostrarle a Javier antes de confirmar (la página de confirmación).
export async function transferenciaPorToken(store, token) {
  if (!TOKEN_CONFIRMAR_RE.test(String(token || ''))) return null;
  const mapa = await store.get(confirmarKey(token), { type: 'json' });
  if (!mapa) return null;
  const orden = await store.get(ordenKey(mapa.orden), { type: 'json' });
  return orden && orden.metodo === 'transferencia' ? orden : null;
}

// Javier confirma que recibió la transferencia. Si el cupo venció pero nadie lo tomó, se mantiene;
// si ya lo tomó otra persona, se busca otro; si no queda ninguno, se avisa para devolver el dinero.
export async function confirmarTransferencia({ store, notify, token, origin, now = Date.now() }) {
  const orden = await transferenciaPorToken(store, token);
  if (!orden) return { resultado: 'invalido' };
  if (orden.estado === 'pagada') return { resultado: 'ya', orden };
  if (orden.estado !== 'transferencia' && orden.estado !== 'sin-cupo') return { resultado: 'invalido' };

  let cupoKey = orden.cupo;
  const cupo = await store.get(cupoKey, { type: 'json' });
  if (!cupo || cupo.orden !== orden.id) {
    // El cupo original ya lo tiene otra persona (la reserva había vencido): se busca uno libre.
    cupoKey = await tomarCupo(store, orden.id, now, SESION.transferenciaMin);
    if (!cupoKey) {
      await store.setJSON(ordenKey(orden.id), { ...orden, estado: 'sin-cupo' });
      return { resultado: 'sin-cupo', orden };
    }
  }
  await store.setJSON(cupoKey, { estado: 'pagado', orden: orden.id, pagado: now });
  const pago = { tipo: 'TRF', metodo: 'transferencia', fecha: new Date(now).toISOString() };
  const base = { ...orden, cupo: cupoKey };
  await store.setJSON(ordenKey(orden.id), base);
  const pagada = await marcarPagada(store, orden.id, pago, now);
  if (!pagada) return { resultado: 'ya', orden };

  let emailEnviado = false;
  try {
    const { ocupados } = await contarCupos(store, now);
    await notify.confirmar({ orden: pagada, pago, origin });
    emailEnviado = true;
    await notify.aviso({ orden: pagada, pago, ocupados });
  } catch (e) {
    console.error('Aviso por correo falló', orden.id, e);
  }
  const fin = await store.getWithMetadata(ordenKey(orden.id), { type: 'json' });
  if (fin) await store.setJSON(ordenKey(orden.id), { ...fin.data, emailEnviado }, { onlyIfMatch: fin.etag });
  return { resultado: 'ok', orden: pagada };
}

// Avisa, una sola vez, a quien no completó la transferencia dentro de la hora de reserva.
export async function avisarTransferenciasVencidas({ store, notify, now = Date.now() }) {
  const { blobs } = await store.list({ prefix: 'orden-' });
  let avisados = 0;
  for (const b of blobs) {
    const cur = await store.getWithMetadata(b.key, { type: 'json' });
    const o = cur && cur.data;
    if (!o || o.estado !== 'transferencia' || o.expira >= now || o.avisoVencida) continue;
    const r = await store.setJSON(b.key, { ...o, avisoVencida: now }, { onlyIfMatch: cur.etag });
    if (!r.modified) continue;
    try {
      await notify.transferenciaVencida({ orden: o });
      avisados++;
    } catch (e) {
      console.error('Aviso de reserva vencida falló', o.id, String(e && e.message).slice(0, 200));
    }
  }
  return { avisados };
}

// ---------- Comprobante en pantalla ----------

const TIPOS_PAGO = {
  VD: 'Débito (Redcompra)',
  VN: 'Crédito, sin cuotas',
  VC: 'Crédito, en cuotas',
  SI: 'Crédito, cuotas sin interés',
  S2: 'Crédito, cuotas sin interés',
  NC: 'Crédito, cuotas sin interés',
  VP: 'Prepago',
  TRF: 'Transferencia bancaria',
};

// Datos del comprobante que se muestra al volver del pago. Solo para una orden pagada; no incluye el correo
// ni más que los últimos cuatro dígitos de la tarjeta.
export async function comprobanteDe(store, ordenId) {
  const o = await ordenPagada(store, ordenId);
  if (!o) return null;
  const p = o.pago || {};
  return {
    orden: o.id,
    comercio: 'Javier, Hari Avtar · Consultoría de Vida',
    servicio: `${SESION.titulo}, ${SESION.fechaTexto}`,
    monto: o.monto,
    moneda: 'CLP',
    autorizacion: p.autorizacion || '',
    fecha: p.fecha || (o.pagada ? new Date(o.pagada).toISOString() : ''),
    tipo: TIPOS_PAGO[p.tipo] || '',
    cuotas: Number.isFinite(p.cuotas) ? p.cuotas : 0,
    tarjeta: p.tarjeta ? String(p.tarjeta).slice(-4) : '',
  };
}

// ---------- Calendario de la sesión ----------

export const ORDEN_RE = /^S13-[a-f0-9]{12}$/;

// Devuelve la orden solo si existe y está pagada: es lo que autoriza a recibir los datos de conexión.
export async function ordenPagada(store, ordenId) {
  if (!ORDEN_RE.test(String(ordenId || ''))) return null;
  const o = await store.get(ordenKey(ordenId), { type: 'json' });
  return o && o.estado === 'pagada' ? o : null;
}

// ---------- Lista de inscritos (para boletas y asistencia) ----------

const celda = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita que Excel lo trate como fórmula
  return '"' + s.replace(/"/g, '""') + '"';
};

export async function inscritosCsv(store) {
  const { blobs } = await store.list({ prefix: 'orden-' });
  const filas = [];
  for (const b of blobs) {
    const o = await store.get(b.key, { type: 'json' });
    if (o && o.estado === 'pagada') filas.push(o);
  }
  filas.sort((a, b) => a.pagada - b.pagada);
  const cab = ['n', 'fecha_pago', 'nombre', 'email', 'monto_clp', 'orden', 'metodo', 'autorizacion', 'tarjeta', 'correo_enviado'];
  const lineas = [cab.map(celda).join(',')];
  filas.forEach((o, i) => {
    lineas.push(
      [
        i + 1,
        new Date(o.pagada).toISOString(),
        o.nombre,
        o.email,
        o.monto,
        o.id,
        o.metodo === 'transferencia' ? 'transferencia' : 'tarjeta',
        o.pago && o.pago.autorizacion,
        o.pago && o.pago.tarjeta,
        o.emailEnviado ? 'si' : 'no',
      ]
        .map(celda)
        .join(',')
    );
  });
  return lineas.join('\n') + '\n';
}

// ---------- Recordatorio previo ----------

// Envía el recordatorio a quienes pagaron ANTES de que se abriera la ventana (24 h antes de la sesión).
// Quien compra dentro de la ventana ya recibió la confirmación con todos los datos, así que no se le repite.
// Cada orden se marca al enviarse, de modo que ejecutarlo varias veces nunca duplica un correo.
export async function enviarRecordatorios({ store, notify, now = Date.now() }) {
  const desde = SESION.inicioMs - SESION.recordatorioHorasAntes * 3600000;
  if (now < desde) return { enviados: 0, fallidos: 0, motivo: 'aun-no' };
  if (now >= SESION.inicioMs) return { enviados: 0, fallidos: 0, motivo: 'ya-paso' };
  const { blobs } = await store.list({ prefix: 'orden-' });
  let enviados = 0;
  let fallidos = 0;
  for (const b of blobs) {
    const cur = await store.getWithMetadata(b.key, { type: 'json' });
    const o = cur && cur.data;
    if (!o || o.estado !== 'pagada' || o.recordatorio || o.pagada >= desde) continue;
    // Se marca primero: si el envío falla se revierte; así dos ejecuciones simultáneas no duplican.
    const r = await store.setJSON(b.key, { ...o, recordatorio: now }, { onlyIfMatch: cur.etag });
    if (!r.modified) continue;
    try {
      await notify.recordatorio({ orden: o });
      enviados++;
    } catch (e) {
      fallidos++;
      console.error('Recordatorio fallido', o.id, String(e && e.message).slice(0, 200));
      const act = await store.getWithMetadata(b.key, { type: 'json' });
      if (act) await store.setJSON(b.key, { ...act.data, recordatorio: null }, { onlyIfMatch: act.etag });
    }
  }
  return { enviados, fallidos };
}
