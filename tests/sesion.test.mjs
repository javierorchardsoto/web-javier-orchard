import test from 'node:test';
import assert from 'node:assert/strict';
import { crearTransferencia, confirmarTransferencia, avisarTransferenciasVencidas, transferenciaPorToken, datosTransferencia, crearCheckout, procesarRetorno, contarCupos, inscritosCsv, validarEntrada, enviarRecordatorios, ordenPagada, comprobanteDe, SESION } from '../netlify/lib/core.mjs';
import { generarIcs, urlGoogleCalendar, enlaceIcs, enlaceGoogle } from '../netlify/lib/calendario.mjs';
import { textoConfirmacion, crearNotificador } from '../netlify/lib/brevo.mjs';

// Almacén en memoria que imita las escrituras condicionales de Netlify Blobs.
function memStore() {
  const m = new Map();
  let v = 0;
  return {
    async setJSON(key, data, opts = {}) {
      const cur = m.get(key);
      if (opts.onlyIfNew && cur) return { modified: false };
      if (opts.onlyIfMatch !== undefined && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
      const etag = 'e' + ++v;
      m.set(key, { data: JSON.parse(JSON.stringify(data)), etag });
      return { modified: true, etag };
    },
    async get(key) {
      const c = m.get(key);
      return c ? JSON.parse(JSON.stringify(c.data)) : null;
    },
    async getWithMetadata(key) {
      const c = m.get(key);
      return c ? { data: JSON.parse(JSON.stringify(c.data)), etag: c.etag } : null;
    },
    async delete(key) {
      m.delete(key);
    },
    async list({ prefix = '' } = {}) {
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

let tokens = 0;
const webpayOk = () => ({
  async create(orden) {
    return { url: 'https://webpay.test/init', token: 'tok' + ++tokens + '_' + orden };
  },
  async commit(token) {
    const orden = token.split('_')[1];
    return {
      response_code: 0,
      status: 'AUTHORIZED',
      buy_order: orden,
      amount: SESION.montoClp,
      authorization_code: '1213',
      card_detail: { card_number: '6623' },
      payment_type_code: 'VN',
      installments_number: 0,
      transaction_date: '2026-11-20T12:00:00.000Z',
    };
  },
});
const notifyMock = () => {
  const calls = [];
  return {
    calls,
    async confirmar(x) {
      calls.push(['confirmar', x.orden.email]);
    },
    async aviso(x) {
      calls.push(['aviso', x.ocupados]);
    },
  };
};
const entrada = (i = 0, extra = {}) => ({
  nombre: 'Ana Pérez ' + i,
  email: `ana${i}@correo.cl`,
  aceptaPolitica: true,
  aceptaCorreo: true,
  ...extra,
});
const ORIGEN = 'https://sitio.test';

test('valida: exige política, correo, nombre y email; rechaza la trampa anti-spam', () => {
  assert.equal(validarEntrada(entrada()).ok, true);
  assert.equal(validarEntrada(entrada(0, { aceptaPolitica: false })).error, 'politica');
  assert.equal(validarEntrada(entrada(0, { aceptaCorreo: false })).error, 'correo');
  assert.equal(validarEntrada(entrada(0, { email: 'sin-arroba' })).error, 'email');
  assert.equal(validarEntrada(entrada(0, { nombre: 'A' })).error, 'nombre');
  assert.equal(validarEntrada(entrada(0, { web: 'spam' })).ok, false);
});

test('30 reservas simultáneas reciben cupos distintos y la 31 queda agotada', async () => {
  const store = memStore();
  const webpay = webpayOk();
  const res = await Promise.all(
    Array.from({ length: 31 }, (_, i) => crearCheckout({ store, webpay, body: entrada(i), origin: ORIGEN, now: 1000 }))
  );
  const ok = res.filter((r) => r.status === 200);
  const agotados = res.filter((r) => r.status === 409);
  assert.equal(ok.length, 30);
  assert.equal(agotados.length, 1);
  const cupos = new Set();
  for (const k of (await store.list({ prefix: 'orden-' })).blobs) cupos.add((await store.get(k.key)).cupo);
  assert.equal(cupos.size, 30);
  assert.equal((await contarCupos(store, 1000)).disponibles, 0);
});

test('una reserva vencida libera su cupo para otra persona', async () => {
  const store = memStore();
  const webpay = webpayOk();
  for (let i = 0; i < 30; i++) await crearCheckout({ store, webpay, body: entrada(i), origin: ORIGEN, now: 0 });
  const pasado = SESION.reservaMin * 60000 + 1;
  assert.equal((await contarCupos(store, pasado)).disponibles, 30);
  const r = await crearCheckout({ store, webpay, body: entrada(99), origin: ORIGEN, now: pasado });
  assert.equal(r.status, 200);
});

test('pago aprobado: confirma cupo, envía correos una sola vez y queda en el CSV', async () => {
  const store = memStore();
  const webpay = webpayOk();
  const notify = notifyMock();
  const c = await crearCheckout({ store, webpay, body: entrada(1), origin: ORIGEN, now: 1000 });
  const r1 = await procesarRetorno({ store, webpay, notify, params: { token_ws: c.body.token }, now: 2000 });
  assert.equal(r1.resultado, 'ok');
  const r2 = await procesarRetorno({ store, webpay, notify, params: { token_ws: c.body.token }, now: 3000 }); // recarga
  assert.equal(r2.resultado, 'ok');
  assert.deepEqual(notify.calls, [['confirmar', 'ana1@correo.cl'], ['aviso', 1]]);
  const csv = await inscritosCsv(store);
  assert.match(csv, /Ana Pérez 1/);
  assert.match(csv, /"si"/);
  assert.equal((await contarCupos(store, 5e9)).disponibles, 29); // un cupo pagado nunca vence
});

test('pago rechazado o monto distinto: libera el cupo y no envía correos', async () => {
  const store = memStore();
  const notify = notifyMock();
  const rechaza = { ...webpayOk(), async commit() { return { response_code: -1, status: 'FAILED' }; } };
  const c = await crearCheckout({ store, webpay: rechaza, body: entrada(2), origin: ORIGEN, now: 1000 });
  const r = await procesarRetorno({ store, webpay: rechaza, notify, params: { token_ws: c.body.token }, now: 2000 });
  assert.equal(r.resultado, 'rechazado');
  assert.equal((await contarCupos(store, 2000)).disponibles, 30);

  const distinto = { ...webpayOk(), async commit(t) { const x = await webpayOk().commit(t); return { ...x, amount: 1 }; } };
  const c2 = await crearCheckout({ store, webpay: distinto, body: entrada(3), origin: ORIGEN, now: 1000 });
  const r2 = await procesarRetorno({ store, webpay: distinto, notify, params: { token_ws: c2.body.token }, now: 2000 });
  assert.equal(r2.resultado, 'rechazado');
  assert.equal(notify.calls.length, 0);
});

test('cancelación en Webpay libera el cupo', async () => {
  const store = memStore();
  const webpay = webpayOk();
  const c = await crearCheckout({ store, webpay, body: entrada(4), origin: ORIGEN, now: 1000 });
  const orden = c.body.token.split('_')[1];
  const r = await procesarRetorno({ store, webpay, notify: notifyMock(), params: { TBK_TOKEN: 'x', TBK_ORDEN_COMPRA: orden }, now: 1500 });
  assert.equal(r.resultado, 'cancelado');
  assert.equal((await contarCupos(store, 1500)).disponibles, 30);
});

test('si el cupo fue reasignado antes de pagar, no se cobra', async () => {
  const store = memStore();
  const webpay = webpayOk();
  let commits = 0;
  const contador = { ...webpay, async commit(t) { commits++; return webpay.commit(t); } };
  const c = await crearCheckout({ store, webpay: contador, body: entrada(5), origin: ORIGEN, now: 0 });
  const tarde = SESION.reservaMin * 60000 + 1;
  await crearCheckout({ store, webpay: contador, body: entrada(6), origin: ORIGEN, now: tarde }); // toma el mismo cupo
  const r = await procesarRetorno({ store, webpay: contador, notify: notifyMock(), params: { token_ws: c.body.token }, now: tarde + 1 });
  assert.equal(r.resultado, 'expirada');
  assert.equal(commits, 0);
});

test('si Brevo falla, el pago queda registrado y se marca correo_enviado = no', async () => {
  const store = memStore();
  const webpay = webpayOk();
  const roto = { async confirmar() { throw new Error('Brevo caído'); }, async aviso() {} };
  const c = await crearCheckout({ store, webpay, body: entrada(7), origin: ORIGEN, now: 1000 });
  const r = await procesarRetorno({ store, webpay, notify: roto, params: { token_ws: c.body.token }, now: 2000 });
  assert.equal(r.resultado, 'ok');
  assert.match(await inscritosCsv(store), /"no"/);
});

test('el CSV neutraliza fórmulas en el nombre', async () => {
  const store = memStore();
  const webpay = webpayOk();
  const c = await crearCheckout({ store, webpay, body: entrada(8, { nombre: '=HYPERLINK("x")' }), origin: ORIGEN, now: 1 });
  await procesarRetorno({ store, webpay, notify: notifyMock(), params: { token_ws: c.body.token }, now: 2 });
  assert.match(await inscritosCsv(store), /"'=HYPERLINK/);
});

test('recordatorio: solo en la ventana, una vez por persona y sin repetirlo a quien compró dentro de ella', async () => {
  const store = memStore();
  const enviados = [];
  const notify = { async recordatorio(x) { enviados.push(x.orden.email); } };
  const desde = SESION.inicioMs - SESION.recordatorioHorasAntes * 3600000;
  const orden = (id, email, pagada, estado = 'pagada') => store.setJSON('orden-' + id, { id, email, nombre: 'N ' + id, estado, pagada });
  await orden('a', 'a@x.cl', desde - 5 * 86400000);
  await orden('b', 'b@x.cl', desde - 1000);
  await orden('c', 'c@x.cl', desde + 1000); // compró dentro de la ventana: ya tiene toda la información
  await orden('d', 'd@x.cl', desde - 1000, 'rechazada');

  assert.equal((await enviarRecordatorios({ store, notify, now: desde - 1 })).motivo, 'aun-no');
  assert.deepEqual(enviados, []);

  const r1 = await enviarRecordatorios({ store, notify, now: desde + 3600000 });
  assert.equal(r1.enviados, 2);
  assert.deepEqual(enviados.sort(), ['a@x.cl', 'b@x.cl']);

  await enviarRecordatorios({ store, notify, now: desde + 2 * 3600000 });
  assert.equal(enviados.length, 2); // no se repite

  assert.equal((await enviarRecordatorios({ store, notify, now: SESION.inicioMs + 1 })).motivo, 'ya-paso');
});

test('recordatorio: si Brevo falla, se reintenta en la siguiente ejecución', async () => {
  const store = memStore();
  let falla = true;
  const notify = { async recordatorio() { if (falla) throw new Error('caído'); } };
  const desde = SESION.inicioMs - SESION.recordatorioHorasAntes * 3600000;
  await store.setJSON('orden-a', { id: 'a', email: 'a@x.cl', nombre: 'A', estado: 'pagada', pagada: desde - 1000 });
  const r1 = await enviarRecordatorios({ store, notify, now: desde + 1000 });
  assert.equal(r1.fallidos, 1);
  falla = false;
  const r2 = await enviarRecordatorios({ store, notify, now: desde + 3600000 });
  assert.equal(r2.enviados, 1);
});

// ---------- Calendario ----------

const ZOOM = 'https://us02web.zoom.us/j/12345678901?pwd=EnlaceDePruebaInventado.1';
const desplegar = (ics) => ics.replace(/\r\n /g, '');

test('ics: fecha en UTC (10:30 de Chile), duración de 90 minutos, dos avisos y líneas de hasta 75 bytes', () => {
  const ics = generarIcs({ ordenId: 'S13-aaaaaaaaaaaa', zoomUrl: ZOOM, zoomId: '897 4886 5507', zoomPasscode: 'abc123' });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'todos los saltos de línea son CRLF');
  assert.match(ics, /DTSTART:20261213T133000Z/);
  assert.match(ics, /DTEND:20261213T150000Z/);
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 2);
  assert.match(ics, /TRIGGER:-P1D/);
  assert.match(ics, /UID:S13-aaaaaaaaaaaa@javierorchard\.com/);
  for (const l of ics.split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75, 'línea larga: ' + l);
  const plano = desplegar(ics);
  assert.ok(plano.includes('LOCATION:' + ZOOM));
  assert.ok(plano.includes('Enlace para conectarte: ' + ZOOM));
  assert.match(plano, /897 4886 5507/);
});

test('ics: sin enlace de Zoom avisa que llegará por correo y no inventa uno', () => {
  const plano = desplegar(generarIcs({ ordenId: 'S13-aaaaaaaaaaaa' }));
  assert.match(plano, /LOCATION:Online \(Zoom\)/);
  assert.match(plano, /te llegará por correo/);
  assert.ok(!plano.includes('zoom.us'));
});

test('enlace de Google Calendar: hora UTC, zona de Chile y enlace de conexión', () => {
  const u = new URL(urlGoogleCalendar({ zoomUrl: ZOOM }));
  assert.equal(u.origin + u.pathname, 'https://calendar.google.com/calendar/render');
  assert.equal(u.searchParams.get('dates'), '20261213T133000Z/20261213T150000Z');
  assert.equal(u.searchParams.get('ctz'), 'America/Santiago');
  assert.equal(u.searchParams.get('location'), ZOOM);
  assert.ok(u.searchParams.get('details').includes(ZOOM));
});

test('el calendario solo se entrega a una orden pagada con número válido', async () => {
  const store = memStore();
  const webpay = webpayOk();
  const notify = notifyMock();
  const c = await crearCheckout({ store, webpay, body: entrada(7), origin: ORIGEN, now: 1000 });
  const ordenId = (await store.list({ prefix: 'orden-' })).blobs[0].key.replace('orden-', '');
  assert.equal(await ordenPagada(store, ordenId), null, 'creada pero sin pagar');
  const r = await procesarRetorno({ store, webpay, notify, params: { token_ws: c.body.token }, origin: ORIGEN, now: 2000 });
  assert.equal(r.resultado, 'ok');
  assert.equal(r.orden, ordenId);
  assert.equal((await ordenPagada(store, ordenId)).email, 'ana7@correo.cl');
  assert.equal(await ordenPagada(store, 'S13-000000000000'), null, 'orden inexistente');
  assert.equal(await ordenPagada(store, '../orden-x'), null, 'formato inválido');
  assert.equal(await ordenPagada(store, undefined), null);
  const rec = await procesarRetorno({ store, webpay, notify, params: { token_ws: c.body.token }, origin: ORIGEN, now: 3000 });
  assert.equal(rec.orden, ordenId, 'al recargar también devuelve la orden');
});

test('un pago cancelado no devuelve número de orden', async () => {
  const store = memStore();
  const r = await procesarRetorno({ store, webpay: webpayOk(), notify: notifyMock(), params: { TBK_TOKEN: 'x', TBK_ORDEN_COMPRA: 'S13-bbbbbbbbbbbb' }, now: 1 });
  assert.equal(r.resultado, 'cancelado');
  assert.equal(r.orden, undefined);
});

test('correo de confirmación: incluye los enlaces de calendario de esa orden, solo si conoce el origen', () => {
  const orden = { id: 'S13-aaaaaaaaaaaa', nombre: 'Ana Pérez', monto: 17000 };
  const con = textoConfirmacion({ orden, pago: { autorizacion: '1213' }, origin: ORIGEN });
  assert.ok(con.includes(enlaceGoogle(ORIGEN, orden.id).replace(/&/g, '&amp;')));
  assert.ok(con.includes(enlaceIcs(ORIGEN, orden.id)));
  assert.match(con, /va adjunto/);
  const sin = textoConfirmacion({ orden, pago: { autorizacion: '1213' } });
  assert.ok(!sin.includes('Agrégala a tu calendario'));
});

test('confirmar: adjunta el .ics y, si Brevo rechaza el adjunto, reenvía sin él', async () => {
  const guardado = { fetch: globalThis.fetch, env: { ...process.env } };
  Object.assign(process.env, { BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'hola@javierorchard.com', ZOOM_URL: ZOOM });
  delete process.env.BREVO_LIST_ID;
  const cuerpos = [];
  let rechazar = false;
  globalThis.fetch = async (url, init) => {
    cuerpos.push(JSON.parse(init.body));
    const mala = rechazar && cuerpos[cuerpos.length - 1].attachment;
    return { ok: !mala, status: mala ? 400 : 201, text: async () => 'adjunto no permitido' };
  };
  try {
    const orden = { id: 'S13-aaaaaaaaaaaa', nombre: 'Ana Pérez', email: 'ana@correo.cl', monto: 17000 };
    await crearNotificador().confirmar({ orden, pago: { autorizacion: '1' }, origin: ORIGEN });
    assert.equal(cuerpos.length, 1);
    const adj = cuerpos[0].attachment[0];
    assert.equal(adj.name, 'sesion-grupal-13-dic.ics');
    assert.match(Buffer.from(adj.content, 'base64').toString('utf-8'), /BEGIN:VCALENDAR[\s\S]*DTSTART:20261213T133000Z/);

    cuerpos.length = 0;
    rechazar = true;
    await crearNotificador().confirmar({ orden, pago: { autorizacion: '1' }, origin: ORIGEN });
    assert.equal(cuerpos.length, 2);
    assert.ok(cuerpos[0].attachment && !cuerpos[1].attachment);
    assert.match(cuerpos[1].htmlContent, /Agrégala a tu calendario/);
  } finally {
    globalThis.fetch = guardado.fetch;
    for (const k of Object.keys(process.env)) if (!(k in guardado.env)) delete process.env[k];
    Object.assign(process.env, guardado.env);
  }
});

test('correo de confirmación: texto de Javier; el aviso del recordatorio solo si pagó antes de la ventana de 24 h', () => {
  const desde = SESION.inicioMs - SESION.recordatorioHorasAntes * 3600000;
  const base = { id: 'S13-aaaaaaaaaaaa', nombre: 'Ana Pérez', monto: 17000 };
  const temprano = textoConfirmacion({ orden: { ...base, pagada: desde - 1000 }, pago: { autorizacion: '1' }, origin: ORIGEN });
  assert.match(temprano, /Gracias por inscribirte/);
  assert.match(temprano, /Recomendaciones para llegar bien a la sesión/);
  assert.match(temprano, /Un día antes de la sesión, te enviaré un recordatorio por email/);
  assert.match(temprano, /Esta sesión es un acompañamiento grupal/);
  assert.ok(!/grabaci/i.test(temprano), 'la sesión no se graba: ningún correo la menciona');
  assert.ok(temprano.includes('devolución de tu pago hasta el domingo 6 de diciembre'), 'el correo informa el plazo de devolución');
  const tarde = textoConfirmacion({ orden: { ...base, pagada: desde + 1000 }, pago: { autorizacion: '1' }, origin: ORIGEN });
  assert.ok(!/te enviaré un recordatorio/.test(tarde), 'quien compra dentro de las 24 h no recibe recordatorio, así que no se le promete');
});

test('el comprobante en pantalla trae lo que pide Transbank, sin correo ni tarjeta completa', async () => {
  const store = memStore();
  const webpay = webpayOk();
  const c = await crearCheckout({ store, webpay, body: entrada(8), origin: ORIGEN, now: 1000 });
  const ordenId = (await store.list({ prefix: 'orden-' })).blobs[0].key.replace('orden-', '');
  assert.equal(await comprobanteDe(store, ordenId), null, 'sin pagar no hay comprobante');
  await procesarRetorno({ store, webpay, notify: notifyMock(), params: { token_ws: c.body.token }, origin: ORIGEN, now: 2000 });
  const comp = await comprobanteDe(store, ordenId);
  assert.equal(comp.orden, ordenId);
  assert.equal(comp.monto, SESION.montoClp);
  assert.equal(comp.moneda, 'CLP');
  assert.equal(comp.autorizacion, '1213');
  assert.equal(comp.tarjeta, '6623');
  assert.equal(comp.tipo, 'Crédito, sin cuotas');
  assert.equal(comp.cuotas, 0);
  assert.equal(comp.fecha, '2026-11-20T12:00:00.000Z');
  assert.ok(comp.comercio && comp.servicio);
  assert.ok(!JSON.stringify(comp).includes('ana8@correo.cl'), 'no incluye el correo');
  assert.equal(await comprobanteDe(store, '../orden-x'), null);
});


// ---------- Transferencia bancaria ----------

const DATOS = { banco: 'Banco Prueba', tipo: 'Cuenta corriente', cuenta: '000111', rut: '11.111.111-1', titular: 'Titular Prueba', email: 'pagos@correo.test' };
const notifyTransf = () => {
  const calls = [];
  return {
    calls,
    async transferencia(x) {
      calls.push(['transferencia', x.orden.email, x.confirmarUrl]);
    },
    async transferenciaVencida(x) {
      calls.push(['vencida', x.orden.email]);
    },
    async confirmar(x) {
      calls.push(['confirmar', x.orden.email, x.pago.metodo]);
    },
    async aviso(x) {
      calls.push(['aviso', x.ocupados]);
    },
  };
};
const tokenDe = (calls) => calls.find((c) => c[0] === 'transferencia')[2].split('t=')[1];
const T0 = Date.parse('2026-12-01T12:00:00-03:00');

test('datosTransferencia: solo existe si están todos los datos en el entorno', () => {
  assert.equal(datosTransferencia({}), null);
  assert.equal(datosTransferencia({ TRANSFER_BANCO: 'x' }), null);
  const d = datosTransferencia({ TRANSFER_BANCO: 'b', TRANSFER_TIPO: 't', TRANSFER_CUENTA: 'c', TRANSFER_RUT: 'r', TRANSFER_TITULAR: 'h', TRANSFER_EMAIL: 'e' });
  assert.equal(d.cuenta, 'c');
});

test('transferencia: reserva el cupo por 1 hora, muestra los datos y avisa por correo', async () => {
  const store = memStore();
  const notify = notifyTransf();
  const r = await crearTransferencia({ store, notify, datos: DATOS, body: entrada(1), origin: ORIGEN, now: T0 });
  assert.equal(r.status, 200);
  assert.equal(r.body.expira, T0 + 60 * 60000);
  assert.equal(r.body.monto, SESION.montoClp);
  assert.equal(r.body.datos.cuenta, '000111');
  assert.match(r.body.referencia, /^S13-[a-f0-9]{12}$/);
  assert.equal(notify.calls[0][0], 'transferencia');
  assert.match(notify.calls[0][2], /^https:\/\/sitio\.test\/api\/sesion\/confirmar-pago\?t=[a-f0-9]{32}$/);
  assert.equal((await contarCupos(store, T0)).ocupados, 1);
  assert.equal(await ordenPagada(store, r.body.orden), null); // aún no está pagada: no recibe el Zoom
});

test('transferencia: sin datos configurados, cerrada la fecha o con datos inválidos, no reserva', async () => {
  const store = memStore();
  const n = notifyTransf();
  assert.equal((await crearTransferencia({ store, notify: n, datos: null, body: entrada(), origin: ORIGEN, now: T0 })).status, 503);
  assert.equal((await crearTransferencia({ store, notify: n, datos: DATOS, body: entrada(), origin: ORIGEN, now: SESION.ultimoPagoMs + 1000 })).body.error, 'plazo');
  assert.equal((await crearTransferencia({ store, notify: n, datos: DATOS, body: entrada(0, { aceptaPolitica: false }), origin: ORIGEN, now: T0 })).body.error, 'politica');
  assert.equal((await contarCupos(store, T0)).ocupados, 0);
});

test('transferencia: el último día (12 de diciembre) todavía se acepta y también la tarjeta; el 13 ya no', async () => {
  const store = memStore();
  const dia12 = Date.parse('2026-12-12T20:00:00-03:00');
  assert.equal((await crearTransferencia({ store, notify: notifyTransf(), datos: DATOS, body: entrada(), origin: ORIGEN, now: dia12 })).status, 200);
  assert.equal((await crearCheckout({ store, webpay: webpayOk(), body: entrada(2), origin: ORIGEN, now: dia12 })).status, 200);
  const dia13 = Date.parse('2026-12-13T00:30:00-03:00');
  assert.equal((await crearCheckout({ store, webpay: webpayOk(), body: entrada(3), origin: ORIGEN, now: dia13 })).body.error, 'plazo');
});

test('transferencia: repetir el pedido con el mismo correo devuelve la misma reserva, sin otro cupo', async () => {
  const store = memStore();
  const n = notifyTransf();
  const a = await crearTransferencia({ store, notify: n, datos: DATOS, body: entrada(5), origin: ORIGEN, now: T0 });
  const b = await crearTransferencia({ store, notify: n, datos: DATOS, body: entrada(5), origin: ORIGEN, now: T0 + 60000 });
  assert.equal(a.body.orden, b.body.orden);
  assert.equal((await contarCupos(store, T0 + 60000)).ocupados, 1);
  assert.equal(n.calls.filter((c) => c[0] === 'transferencia').length, 1);
});

test('transferencia: al confirmar, queda pagada, se envía la confirmación y el calendario ya la reconoce', async () => {
  const store = memStore();
  const n = notifyTransf();
  const r = await crearTransferencia({ store, notify: n, datos: DATOS, body: entrada(1), origin: ORIGEN, now: T0 });
  const token = tokenDe(n.calls);
  const c = await confirmarTransferencia({ store, notify: n, token, origin: ORIGEN, now: T0 + 20 * 60000 });
  assert.equal(c.resultado, 'ok');
  assert.ok(await ordenPagada(store, r.body.orden));
  assert.deepEqual(n.calls.filter((x) => x[0] === 'confirmar'), [['confirmar', 'ana1@correo.cl', 'transferencia']]);
  assert.equal((await comprobanteDe(store, r.body.orden)).tipo, 'Transferencia bancaria');
  // Confirmar dos veces no duplica el correo
  assert.equal((await confirmarTransferencia({ store, notify: n, token, origin: ORIGEN, now: T0 + 30 * 60000 })).resultado, 'ya');
  assert.equal(n.calls.filter((x) => x[0] === 'confirmar').length, 1);
  const csv = await inscritosCsv(store);
  assert.match(csv, /transferencia/);
});

test('transferencia: enlace inválido o inventado no confirma nada', async () => {
  const store = memStore();
  const n = notifyTransf();
  assert.equal((await confirmarTransferencia({ store, notify: n, token: 'x', origin: ORIGEN })).resultado, 'invalido');
  assert.equal((await confirmarTransferencia({ store, notify: n, token: 'a'.repeat(32), origin: ORIGEN })).resultado, 'invalido');
  assert.equal(await transferenciaPorToken(store, 'a'.repeat(32)), null);
});

test('transferencia: si la reserva venció pero el cupo sigue libre, la confirmación lo mantiene', async () => {
  const store = memStore();
  const n = notifyTransf();
  const r = await crearTransferencia({ store, notify: n, datos: DATOS, body: entrada(1), origin: ORIGEN, now: T0 });
  const c = await confirmarTransferencia({ store, notify: n, token: tokenDe(n.calls), origin: ORIGEN, now: T0 + 3 * 3600000 });
  assert.equal(c.resultado, 'ok');
  assert.ok(await ordenPagada(store, r.body.orden));
});

test('transferencia: si la reserva venció y otra persona tomó el cupo, se busca otro; si no hay ninguno, se avisa', async () => {
  const store = memStore();
  const n = notifyTransf();
  await crearTransferencia({ store, notify: n, datos: DATOS, body: entrada(1), origin: ORIGEN, now: T0 });
  const token = tokenDe(n.calls);
  const despues = T0 + 2 * 3600000;
  // Otra persona toma el cupo vencido (cupo-01) con tarjeta
  await crearCheckout({ store, webpay: webpayOk(), body: entrada(2), origin: ORIGEN, now: despues });
  const c = await confirmarTransferencia({ store, notify: n, token, origin: ORIGEN, now: despues + 60000 });
  assert.equal(c.resultado, 'ok'); // había cupos libres: recibe otro
  assert.equal((await contarCupos(store, despues + 60000)).ocupados, 2);

  // Con todos los cupos ocupados, no hay dónde ubicarla
  const store2 = memStore();
  const n2 = notifyTransf();
  await crearTransferencia({ store: store2, notify: n2, datos: DATOS, body: entrada(1), origin: ORIGEN, now: T0 });
  for (let i = 10; i < 10 + SESION.total; i++) await crearCheckout({ store: store2, webpay: webpayOk(), body: entrada(i), origin: ORIGEN, now: despues });
  const c2 = await confirmarTransferencia({ store: store2, notify: n2, token: tokenDe(n2.calls), origin: ORIGEN, now: despues + 60000 });
  assert.equal(c2.resultado, 'sin-cupo');
  assert.equal(n2.calls.filter((x) => x[0] === 'confirmar').length, 0);
});

test('transferencia: la reserva vencida libera el cupo y se avisa una sola vez', async () => {
  const store = memStore();
  const n = notifyTransf();
  await crearTransferencia({ store, notify: n, datos: DATOS, body: entrada(1), origin: ORIGEN, now: T0 });
  assert.equal((await contarCupos(store, T0 + 30 * 60000)).ocupados, 1);
  assert.equal((await contarCupos(store, T0 + 61 * 60000)).ocupados, 0);
  assert.deepEqual(await avisarTransferenciasVencidas({ store, notify: n, now: T0 + 30 * 60000 }), { avisados: 0 });
  assert.deepEqual(await avisarTransferenciasVencidas({ store, notify: n, now: T0 + 61 * 60000 }), { avisados: 1 });
  assert.deepEqual(await avisarTransferenciasVencidas({ store, notify: n, now: T0 + 90 * 60000 }), { avisados: 0 });
});

test('correos de transferencia: llevan los datos y la hora límite; el de confirmación dice transferencia', async () => {
  const { textoTransferencia, textoConfirmacion: conf } = await import('../netlify/lib/brevo.mjs');
  const orden = { id: 'S13-abcdef012345', nombre: 'Ana Pérez', email: 'a@b.cl', monto: 17000, expira: Date.parse('2026-12-01T13:00:00-03:00') };
  const h = textoTransferencia({ orden, datos: DATOS });
  for (const v of ['Banco Prueba', '000111', '11.111.111-1', 'Titular Prueba', 'pagos@correo.test', '$17.000', 'S13-abcdef012345', '13:00']) assert.ok(h.includes(v), v);
  assert.match(conf({ orden, pago: { metodo: 'transferencia' }, origin: ORIGEN }), /transferencia bancaria/);
});
