import test from 'node:test';
import assert from 'node:assert/strict';
import { crearCheckout, procesarRetorno, contarCupos, SESION } from '../netlify/lib/core.mjs';
import { listarTokens, reembolsar } from '../netlify/lib/pruebas.mjs';

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
    async get(key) { const c = m.get(key); return c ? JSON.parse(JSON.stringify(c.data)) : null; },
    async getWithMetadata(key) { const c = m.get(key); return c ? { data: JSON.parse(JSON.stringify(c.data)), etag: c.etag } : null; },
    async delete(key) { m.delete(key); },
    async list({ prefix = '' } = {}) { return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}

let n = 0;
const webpay = () => ({
  refunds: [],
  async create(orden) { return { url: 'https://webpay.test/init', token: 'tokenprueba' + ++n + '_' + orden }; },
  async commit(token) {
    return { response_code: 0, status: 'AUTHORIZED', buy_order: token.split('_')[1], amount: SESION.montoClp, authorization_code: '1213', card_detail: { card_number: '6623' }, payment_type_code: 'VN', installments_number: 0, transaction_date: '2026-11-20T12:00:00.000Z' };
  },
  async refund(token, monto) { this.refunds.push([token, monto]); return { type: 'REVERSED', authorization_code: '9999', balance: 0 }; },
});
const notify = { async confirmar() {}, async aviso() {} };
const body = { nombre: 'Persona Prueba', email: 'prueba@example.com', aceptaPolitica: true, aceptaCorreo: true };

async function compraPagada(store, w) {
  const c = await crearCheckout({ store, webpay: w, body, origin: 'https://x.test' });
  await procesarRetorno({ store, webpay: w, notify, params: { token_ws: c.body.token }, origin: 'https://x.test' });
  return c.body.token;
}

test('listarTokens muestra la compra con su estado', async () => {
  const store = memStore(); const w = webpay();
  const token = await compraPagada(store, w);
  const filas = await listarTokens(store);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].token, token);
  assert.equal(filas[0].estado, 'pagada');
});

test('reembolso parcial deja la compra pagada y descuenta el restante', async () => {
  const store = memStore(); const w = webpay();
  const token = await compraPagada(store, w);
  const r = await reembolsar({ store, webpay: w, token, monto: 5000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.restante, SESION.montoClp - 5000);
  assert.equal(r.body.total, false);
  assert.deepEqual(w.refunds[0], [token, 5000]);
  assert.equal((await contarCupos(store, Date.now())).ocupados, 1);
});

test('reembolso total sin monto reembolsa lo que queda y libera el cupo', async () => {
  const store = memStore(); const w = webpay();
  const token = await compraPagada(store, w);
  await reembolsar({ store, webpay: w, token, monto: 5000 });
  const r = await reembolsar({ store, webpay: w, token });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, true);
  assert.equal(w.refunds[1][1], SESION.montoClp - 5000);
  assert.equal((await contarCupos(store, Date.now())).ocupados, 0);
  assert.equal((await listarTokens(store))[0].estado, 'reembolsada');
});

test('no reembolsa más de lo pagado, ni dos veces, ni una compra no pagada', async () => {
  const store = memStore(); const w = webpay();
  const token = await compraPagada(store, w);
  assert.equal((await reembolsar({ store, webpay: w, token, monto: SESION.montoClp + 1 })).status, 400);
  assert.equal((await reembolsar({ store, webpay: w, token, monto: -5 })).status, 400);
  await reembolsar({ store, webpay: w, token });
  assert.equal((await reembolsar({ store, webpay: w, token })).status, 409);
  const c = await crearCheckout({ store, webpay: w, body, origin: 'https://x.test' });
  assert.equal((await reembolsar({ store, webpay: w, token: c.body.token })).status, 409);
  assert.equal((await reembolsar({ store, webpay: w, token: 'no-existe-123456' })).status, 404);
  assert.equal((await reembolsar({ store, webpay: w, token: '!!' })).status, 400);
});

test('si Transbank falla al reembolsar, la compra queda intacta', async () => {
  const store = memStore(); const w = webpay();
  const token = await compraPagada(store, w);
  w.refund = async () => { throw new Error('red'); };
  const r = await reembolsar({ store, webpay: w, token });
  assert.equal(r.status, 502);
  assert.equal((await listarTokens(store))[0].estado, 'pagada');
});
