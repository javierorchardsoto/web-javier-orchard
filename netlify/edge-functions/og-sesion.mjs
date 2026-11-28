// Vista previa al compartir /sesiondiciembre: título, descripción y foto propios de la sesión.
export default async (request, context) => {
  const res = await context.next();
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  const t = 'Alíviate. Desde la Reacción a la Presencia.';
  const d = 'Sesión grupal online en vivo · Domingo 13 de diciembre, 10:30. “Herramientas para abordar los desafíos de este tiempo.”';
  let html = await res.text();
  html = html
    .replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${t}">`)
    .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${d}">`)
    .replace(/<meta property="og:type" content="website">/, `<meta property="og:type" content="website">\n<meta property="og:url" content="https://javierorchard.com/sesiondiciembre">`);
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(html, { status: res.status, headers });
};
export const config = { path: '/sesiondiciembre' };
