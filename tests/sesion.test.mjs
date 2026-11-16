import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCheckout, procesarRetorno, contarCupos, inscritosCsv, validarEntrada, enviarRecordatorios, ordenPagada, SESION } from '../netlify/lib/core.mjs';
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
  assert.ok(!/devolución/.test(temprano), 'sin el aviso de devolución en el correo');
  assert.ok(!/grabaci/i.test(temprano), 'la sesión no se graba: ningún correo la menciona');
  assert.ok(temprano.includes('devolución de tu pago hasta el domingo 6 de diciembre'), 'el correo informa el plazo de devolución');
  const tarde = textoConfirmacion({ orden: { ...base, pagada: desde + 1000 }, pago: { autorizacion: '1' }, origin: ORIGEN });
  assert.ok(!/te enviaré un recordatorio/.test(tarde), 'quien compra dentro de las 24 h no recibe recordatorio, así que no se le promete');
});
