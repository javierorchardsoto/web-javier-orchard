// Herramientas de administración para Javier: ver los tokens de las compras (validación con Transbank)
// y reembolsar una compra, total o parcialmente. Solo se usan con el token de administración.
// No depende de Netlify ni de Transbank directamente: recibe `store` y `webpay`, para poder probarla sin red.

const ordenKey = (id) => `orden-${id}`;
const tokenKey = (t) => `token-${t}`;
const TOKEN_RE = /^[A-Za-z0-9_-]{10,200}$/;

const sumaReembolsos = (orden) => (orden.reembolsos || []).reduce((a, r) => a + (r.monto || 0), 0);

// Lista las compras recientes con su token, para copiarlo al formulario de validación de Transbank.
export async function listarTokens(store) {
  const { blobs } = await store.list({ prefix: 'token-' });
  const filas = [];
  for (const b of blobs) {
    const token = b.key.slice('token-'.length);
    const mapa = await store.get(b.key, { type: 'json' });
    const orden = mapa && (await store.get(ordenKey(mapa.orden), { type: 'json' }));
    if (!orden) continue;
    filas.push({
      token,
      orden: orden.id,
      estado: orden.estado,
      monto: orden.monto,
      reembolsado: sumaReembolsos(orden),
      tipoPago: orden.pago && orden.pago.tipo,
      cuotas: orden.pago && orden.pago.cuotas,
      creada: orden.creada,
    });
  }
  return filas.sort((a, b) => (b.creada || 0) - (a.creada || 0));
}

// Reembolsa una compra pagada (monto total o parcial). Si queda reembolsada por completo, libera el cupo.
export async function reembolsar({ store, webpay, token, monto, now = Date.now() }) {
  if (!TOKEN_RE.test(String(token || ''))) return { status: 400, body: { error: 'token' } };
  const mapa = await store.get(tokenKey(token), { type: 'json' });
  if (!mapa) return { status: 404, body: { error: 'no-encontrada' } };
  const cur = await store.getWithMetadata(ordenKey(mapa.orden), { type: 'json' });
  if (!cur) return { status: 404, body: { error: 'no-encontrada' } };
  const orden = cur.data;
  if (orden.estado !== 'pagada') return { status: 409, body: { error: 'no-pagada', estado: orden.estado } };

  const restante = orden.monto - sumaReembolsos(orden);
  const pedido = monto === undefined || monto === null || monto === '' ? restante : Number(monto);
  if (!Number.isInteger(pedido) || pedido <= 0 || pedido > restante) {
    return { status: 400, body: { error: 'monto', restante } };
  }

  let res;
  try {
    res = await webpay.refund(token, pedido);
  } catch (e) {
    console.error('webpay.refund falló', orden.id, e);
    return { status: 502, body: { error: 'pasarela' } };
  }

  const queda = restante - pedido;
  const total = queda === 0;
  const registro = {
    monto: pedido,
    tipo: res && res.type,
    autorizacion: res && res.authorization_code,
    fecha: now,
  };
  const nueva = {
    ...orden,
    estado: total ? 'reembolsada' : 'pagada',
    reembolsos: [...(orden.reembolsos || []), registro],
  };
  const r = await store.setJSON(ordenKey(orden.id), nueva, { onlyIfMatch: cur.etag });
  if (!r.modified) return { status: 409, body: { error: 'concurrencia' } };

  if (total && orden.cupo) {
    const cupo = await store.get(orden.cupo, { type: 'json' });
    if (cupo && cupo.orden === orden.id) await store.delete(orden.cupo);
  }
  return { status: 200, body: { ok: true, orden: orden.id, reembolsado: pedido, restante: queda, tipo: registro.tipo, total } };
}
