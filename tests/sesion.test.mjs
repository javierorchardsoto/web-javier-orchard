import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCheckout, procesarRetorno, contarCupos, inscritosCsv, validarEntrada, SESION } from '../netlify/lib/core.mjs';

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
