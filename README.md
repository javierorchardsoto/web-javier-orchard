# Web de Javier Orchard Soto

Sitio de una página de Consultoría de vida 1:1 online, con la página de la sesión grupal.
Se publica en Netlify (`javierorchard-consultoria`). El sitio estático no tiene paso de construcción:
la carpeta raíz se publica tal cual. Las funciones de la carpeta `netlify/functions` atienden la
inscripción pagada a la sesión grupal.

## Inscripción pagada a la sesión grupal (13 de diciembre de 2026)

Flujo: la persona reserva su cupo en la página, paga por Webpay (Transbank), y al confirmarse el pago
recibe un correo de confirmación por Brevo y queda en la lista de contactos. Máximo 30 cupos.
Mientras la venta no esté abierta, la página muestra la lista de espera de siempre (Netlify Forms).

| Dirección | Para qué |
|---|---|
| `/api/sesion/estado` | La página pregunta si la venta está abierta y cuántos cupos quedan |
| `/api/sesion/checkout` | Reserva un cupo (15 min) y crea el pago en Webpay |
| `/api/sesion/retorno` | Webpay devuelve a la persona aquí; se confirma el pago, se envían los correos |
| `/api/sesion/inscritos?token=…` | Lista de inscritos pagados en CSV (para las boletas y la asistencia) |

### Variables de entorno (Netlify → Site configuration → Environment variables)

| Variable | Qué es | Dónde |
|---|---|---|
| `TBK_ENV` | `production` para cobrar de verdad. Sin ella se usa el ambiente de prueba de Transbank | Solo Production |
| `TBK_COMMERCE_CODE` | Código de comercio de Webpay Plus (producción) | Solo Production |
| `TBK_API_KEY` | Clave secreta de Webpay Plus (producción) | Solo Production |
| `BREVO_API_KEY` | Clave de la API de Brevo | Todos los contextos |
| `BREVO_SENDER_EMAIL` | Correo remitente, verificado en Brevo | Todos |
| `BREVO_SENDER_NAME` | Nombre del remitente (opcional; por defecto "Javier Orchard Soto") | Todos |
| `BREVO_LIST_ID` | Número de la lista de contactos de Brevo (opcional) | Todos |
| `REPLY_TO_EMAIL` | Correo al que llegan las respuestas de quienes compran (opcional; por defecto el remitente). Úsalo si el remitente no tiene buzón | Todos |
| `ZOOM_ID` y `ZOOM_PASSCODE` | ID y código de la reunión, como respaldo del enlace en el correo (opcionales) | Todos |
| `NOTIFY_EMAIL` | Correo donde Javier recibe el aviso de cada inscripción (opcional; por defecto `REPLY_TO_EMAIL`, o el remitente) | Todos |
| `ZOOM_URL` | Enlace de la sesión, que va en el correo de confirmación (si falta, el correo dice que se enviará después) | Todos |
| `ADMIN_TOKEN` | Contraseña larga para descargar la lista de inscritos | Todos |
| `SESION_ABIERTA` | `1` para abrir la venta en el sitio publicado. Es el interruptor final | Solo Production |

La venta en el sitio publicado solo se abre si están `TBK_ENV=production`, las claves de Webpay, Brevo
y `SESION_ABIERTA=1`. En vistas previas siempre está abierta, en modo de prueba (no cobra) y con un
almacén de cupos aparte, para no mezclar pruebas con inscripciones reales.

### Cómo probar antes de abrir la venta

1. Abrir la vista previa de la solicitud de cambios (Netlify la genera sola).
2. Reservar con un correo propio y pagar con la tarjeta de prueba de Transbank
   (VISA 4051 8856 0044 6623, CVV 123, cualquier fecha futura; RUT 11.111.111-1, clave 123).
3. Comprobar que llega el correo de confirmación y que aparece en `/api/sesion/inscritos?token=…`.
4. Probar también cancelar en la pantalla de Webpay y ver que el cupo queda libre.

### Pruebas automáticas

`npm install && npm test` (verifica cupos simultáneos, vencimiento de reservas, pago aprobado/rechazado,
cancelación y fallo de correo, sin conectarse a Transbank ni a Brevo).

## Recordatorio previo

- `netlify/functions/sesion-recordatorio.mjs` corre cada hora en el sitio publicado y envía el recordatorio, una sola vez por persona, desde 24 horas antes de la sesión (sábado 12 de diciembre, 10:30 hora de Chile) hasta el inicio. Quien compra dentro de esas 24 horas no lo recibe: su confirmación ya trae todo.
- Para revisar cómo se ve: abrir `/api/sesion/recordatorio-prueba?token=TU_ADMIN_TOKEN`. Envía una copia solo a `NOTIFY_EMAIL` o `REPLY_TO_EMAIL`; nunca a compradores.
- Las funciones programadas de Netlify solo corren en el despliegue publicado (producción), no en vistas previas.
