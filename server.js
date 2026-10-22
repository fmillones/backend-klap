require('dotenv').config();
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // PayZen devuelve kr-answer / kr-hash por POST (form)

// URL(s) del frontend, separadas por coma. Puede incluir ruta (ej. GitHub Pages:
// https://usuario.github.io/mi-repo/). Para CORS se usa solo el origen (esquema + dominio).
const URLS_FRONTEND = (process.env.FRONTEND_URL)
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const ORIGENES_PERMITIDOS = URLS_FRONTEND.map((u) => {
  try { return new URL(u).origin; } catch { return u.replace(/\/$/, ''); }
});
const FRONTEND_PRINCIPAL = URLS_FRONTEND[0]; // a donde vuelve el usuario tras pagar

// CORS solo para la API que consume el navegador (el retorno y el IPN no lo necesitan)
app.use('/api', (req, res, next) => {
  const origen = req.headers.origin;
  if (origen && ORIGENES_PERMITIDOS.includes(origen)) {
    res.setHeader('Access-Control-Allow-Origin', origen);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Datos de prueba ----------
const PERIODO = 'Octubre 2026';
const VENCIMIENTO = '2026-10-31';

// Decimales de cada moneda (PayZen recibe el monto en la unidad mínima)
const DECIMALES = { CLP: 0, PEN: 2 };
const MONEDA_PAIS = { CL: 'CLP', PE: 'PEN' };
const NOMBRE_PAIS = { CL: 'Chile', PE: 'Perú' };

// Cada cliente tiene un documento por país (RUT en Chile, DNI en Perú) y una deuda en la
// moneda de ese país. Los montos están en unidades normales (35000 CLP, 120 PEN).
// Los clientes 2, 3 y 4 son de relleno: reemplaza sus datos y documentos por los reales.
const CLIENTES = [
  {
    nombre: 'Fernando Luna',
    email: 'fernando.luna@lyra.com',
    CL: { documento: '12.572.407-8', direccion: 'Av Chile, San Isidro', monto: 195062 },
    PE: { documento: '12345678', direccion: 'Av. Perú 123, Lima', monto: 120 }
  },
  {
    nombre: 'Miguel Aguilar',
    email: 'miguel.aguilar@lyra.com',
    CL: { documento: '15.234.876-2', direccion: 'Av. Providencia 1234, Santiago', monto: 18500 },
    PE: { documento: '45871236', direccion: 'Jr. de la Unión 456, Lima', monto: 85.5 }
  },
  {
    nombre: 'Carlos Rojas',
    email: 'carlos.rojas@example.com',
    CL: { documento: '18.456.231-6', direccion: 'Calle Prat 789, Valparaíso', monto: 52900 },
    PE: { documento: '70234518', direccion: 'Av. Arequipa 2010, Lima', monto: 210 }
  },
  {
    nombre: 'Ana Silva',
    email: 'ana.silva@example.com',
    CL: { documento: '9.876.543-3', direccion: 'Av. Libertad 321, Viña del Mar', monto: 27300 },
    PE: { documento: '41562987', direccion: 'Calle Los Olivos 55, Lima', monto: 64.9 }
  }
];

// Índice de deudas por país + documento
const DEUDAS = {};
for (const c of CLIENTES) {
  for (const pais of Object.keys(MONEDA_PAIS)) {
    const d = c[pais];
    if (!d) continue;
    DEUDAS[`${pais}:${d.documento}`] = {
      numeroCliente: d.documento,
      pais,
      moneda: MONEDA_PAIS[pais],
      nombre: c.nombre,
      email: c.email,
      direccion: d.direccion,
      periodo: PERIODO,
      vencimiento: VENCIMIENTO,
      monto: d.monto
    };
  }
}

const {
  PAYZEN_ENDPOINT = 'https://api.payzen.lat',
  PAYZEN_STATIC = 'https://static.payzen.lat/static/js/krypton-client/V4.0'
} = process.env;

// ---------- Medios de pago y modos ----------
// Cada medio tiene dos juegos de credenciales: PAYZEN_<MEDIO>_TEST_* y PAYZEN_<MEDIO>_PROD_*
const CATALOGO = {
  transbank_mall: { nombre: 'Transbank (Mall)', pais: 'CL' },
  transbank_plus: { nombre: 'Transbank (Plus)', pais: 'CL' },
  klap:           { nombre: 'Klap',             pais: 'CL' },
  pagonxt:        { nombre: 'Pagonxt',          pais: 'CL' },
  izipay:         { nombre: 'Izipay',           pais: 'PE' },
  niubiz:         { nombre: 'Niubiz',           pais: 'PE' }
};
const MODOS = { test: 'Test', prod: 'Producción' };

// Se arma una "tienda" por cada combinación medio + modo
const TIENDAS = {};
for (const [clave, datos] of Object.entries(CATALOGO)) {
  for (const modo of Object.keys(MODOS)) {
    const p = `PAYZEN_${clave.toUpperCase()}_${modo.toUpperCase()}_`;
    TIENDAS[`${clave}:${modo}`] = {
      ...datos,
      clave,
      modo,
      username: process.env[p + 'USERNAME'],
      password: process.env[p + 'PASSWORD'],
      publicKey: process.env[p + 'PUBLIC_KEY'],
      sha256: process.env[p + 'SHA256']
    };
  }
}

function obtenerTienda(clave, modo) {
  return TIENDAS[`${clave}:${modo}`] || null;
}

function nombreCompleto(tienda) {
  return `${tienda.nombre} (${MODOS[tienda.modo]})`;
}

// Health check para Render
app.get('/health', (req, res) => res.json({ ok: true }));

// Busca la deuda y verifica que el documento corresponda al país del medio de pago
function buscarCuenta(dni, clave, modo) {
  const tienda = obtenerTienda(clave, modo);
  if (!tienda) return { status: 400, error: 'Medio de pago o modo no válido.' };
  const cuenta = DEUDAS[`${tienda.pais}:${String(dni || '').trim()}`];
  if (!cuenta) {
    return { status: 404, error: `No encontramos una deuda asociada a ese documento en ${NOMBRE_PAIS[tienda.pais]}.` };
  }
  return { cuenta, tienda };
}

app.post('/api/consulta-deuda', (req, res) => {
  const r = buscarCuenta(req.body.dni, req.body.tienda, req.body.modo);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const { email, ...publico } = r.cuenta; // el correo no se expone al navegador
  res.json({ ...publico, medioPago: r.tienda.nombre, modo: r.tienda.modo });
});

// Datos públicos que necesita el navegador para la tienda elegida
app.get('/api/config', (req, res) => {
  const tienda = obtenerTienda(req.query.tienda, req.query.modo);
  if (!tienda) return res.status(400).json({ error: 'Medio de pago o modo no válido.' });
  if (!tienda.publicKey) {
    return res.status(500).json({ error: `Falta la clave pública de ${nombreCompleto(tienda)} en el .env` });
  }
  res.json({
    publicKey: tienda.publicKey,
    jsUrl: `${PAYZEN_STATIC}/stable/kr-payment-form.min.js`,
    themeCss: `${PAYZEN_STATIC}/ext/classic-reset.css`,
    themeJs: `${PAYZEN_STATIC}/ext/classic.js`
  });
});

// Crea el pago en PayZen con las credenciales del medio y modo elegidos
app.post('/api/crear-pago', async (req, res) => {
  const r0 = buscarCuenta(req.body.dni, req.body.tienda, req.body.modo);
  if (r0.error) return res.status(r0.status).json({ error: r0.error });
  const { cuenta, tienda } = r0;

  if (!tienda.username || !tienda.password) {
    return res.status(500).json({ error: `Faltan las credenciales de ${nombreCompleto(tienda)} en el .env` });
  }

  const auth = Buffer.from(`${tienda.username}:${tienda.password}`).toString('base64');
  const amount = Math.round(cuenta.monto * 10 ** DECIMALES[cuenta.moneda]); // el monto SIEMPRE sale del backend
  const doc = cuenta.numeroCliente.replace(/[^0-9kK]/g, '');

  try {
    const r = await fetch(`${PAYZEN_ENDPOINT}/api-payment/V4/Charge/CreatePayment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify(
        {
        amount,
        currency: cuenta.moneda,
        orderId: `GV-${tienda.clave.toUpperCase()}-${tienda.modo.toUpperCase()}-${doc}-${Date.now()}`,
        customer: { 
          email: cuenta.email, reference: cuenta.numeroCliente 
        }
      })
    });
    const data = await r.json();

    if (data.status !== 'SUCCESS' || !data.answer || !data.answer.formToken) {
      console.error(`Error PayZen CreatePayment (${nombreCompleto(tienda)}):`, JSON.stringify(data));
      const msg = (data.answer && data.answer.errorMessage) || 'PayZen rechazó la creación del pago.';
      return res.status(502).json({ error: msg });
    }

    res.json({ formToken: data.answer.formToken });
  } catch (err) {
    console.error('Error llamando a PayZen:', err);
    res.status(502).json({ error: 'No se pudo conectar con PayZen.' });
  }
});

// Valida kr-hash = HMAC-SHA256(kr-answer). Como el retorno no dice de qué tienda viene,
// se prueba con las claves de cada combinación medio + modo configurada.
function hashValido(body) {
  const respuesta = body['kr-answer'];
  const hash = body['kr-hash'];
  if (!respuesta || !hash) return false;

  const recibido = Buffer.from(String(hash));
  return Object.values(TIENDAS).some((t) => {
    const clave = body['kr-hash-key'] === 'password' ? t.password : t.sha256;
    if (!clave) return false;
    const esperado = Buffer.from(crypto.createHmac('sha256', clave).update(respuesta, 'utf8').digest('hex'));
    return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
  });
}

// Retorno del navegador (kr-post-url-success y kr-post-url-refused apuntan aquí)
app.post('/retorno-pago', (req, res) => {
  const firmaOk = hashValido(req.body);

  let respuesta = null;
  try { respuesta = JSON.parse(req.body['kr-answer']); } catch { /* sin respuesta válida */ }

  if (!respuesta) {
    return res.status(400).send(paginaResultado({
      exito: false,
      titulo: 'No se recibió respuesta del pago',
      json: req.body
    }));
  }

  const pagado = respuesta.orderStatus === 'PAID';
  const exito = firmaOk && pagado;
  const titulo = !firmaOk ? 'Firma no válida: respuesta no verificada' : pagado ? 'Pago aceptado' : 'Pago rechazado';

  res.send(paginaResultado({
    exito,
    titulo,
    firmaOk,
    resumen: { Orden: respuesta.orderDetails?.orderId, Estado: respuesta.orderStatus },
    json: respuesta
  }));
});

// Si alguien abre la URL de retorno directamente
app.get('/retorno-pago', (req, res) => res.redirect(FRONTEND_PRINCIPAL));

// IPN (notificación servidor a servidor). Configura esta URL en el Back Office de TODAS las tiendas
// (test y producción). Aquí es donde debes marcar la deuda como pagada, no en el retorno del navegador.
app.post('/webhook-payzen', (req, res) => {
  if (!hashValido(req.body)) return res.status(400).send('Firma inválida');
  const respuesta = JSON.parse(req.body['kr-answer']);
  console.log('IPN:', respuesta.orderDetails?.orderId, respuesta.orderStatus);
  res.status(200).send('OK');
});

function escaparHtml(valor) {
  return String(valor).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Página de resultado: título aceptado/rechazado y el JSON de la transacción oculto
// detrás de un botón "Ver respuesta (JSON)".
function paginaResultado({ exito, titulo, firmaOk = true, resumen = {}, json }) {
  const color = exito ? '#00b58a' : '#c0392b';
  const jsonTexto = escaparHtml(JSON.stringify(json, null, 2));
  const filas = Object.entries(resumen)
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="fila"><span>${escaparHtml(k)}</span><strong>${escaparHtml(v)}</strong></div>`)
    .join('');
  const aviso = firmaOk
    ? ''
    : '<div class="alert alert-warning py-2 small mb-3">No se pudo verificar la firma de la respuesta con las claves configuradas.</div>';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resultado del pago</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.3/css/bootstrap.min.css" rel="stylesheet">
<style>
  body{ font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; min-height:100vh;
    background:linear-gradient(135deg,#e9edf3 0%,#d9dfe9 50%,#c9d2e3 100%);
    display:flex; align-items:center; justify-content:center; padding:24px 12px; }
  .panel{ width:100%; max-width:640px; background:#fff; border-radius:22px; overflow:hidden; box-shadow:0 14px 40px rgba(13,27,76,.18); }
  .head{ background:${color}; color:#fff; padding:1.6rem 1.8rem; text-align:center; }
  .head h1{ font-size:1.6rem; font-weight:900; margin:0; }
  .body{ padding:1.6rem 1.8rem 2rem; }
  .fila{ display:flex; justify-content:space-between; gap:1rem; padding:.55rem 0; border-bottom:1px solid #eef1f7; color:#0d1b4c; word-break:break-all; }
  .fila span{ color:#6b7385; }
  pre{ background:#0d1b4c; color:#d6e2ff; border-radius:14px; padding:1rem; max-height:420px; overflow:auto; font-size:.8rem; margin:0; }
  .btn-navy{ background:#0d1b4c; color:#fff; font-weight:700; border-radius:12px; }
  .btn-navy:hover{ background:#081338; color:#fff; }
</style></head>
<body>
<main class="panel">
  <div class="head"><h1>${exito ? '✅' : '⚠️'} ${escaparHtml(titulo)}</h1></div>
  <div class="body">
    ${aviso}
    <div class="mb-3">${filas}</div>

    <div class="d-grid">
      <button id="verJson" type="button" class="btn btn-outline-secondary">Ver respuesta (JSON)</button>
    </div>

    <div id="jsonBox" class="d-none mt-3">
      <div class="d-flex justify-content-end mb-2">
        <button id="copiar" type="button" class="btn btn-sm btn-outline-secondary">Copiar</button>
      </div>
      <pre id="json">${jsonTexto}</pre>
    </div>

    <div class="d-grid mt-4">
      <a href="${escaparHtml(FRONTEND_PRINCIPAL)}" class="btn btn-navy py-2">Volver al inicio</a>
    </div>
  </div>
</main>
<script>
  var box = document.getElementById('jsonBox');
  var ver = document.getElementById('verJson');
  ver.addEventListener('click', function () {
    var oculto = box.classList.toggle('d-none');
    ver.textContent = oculto ? 'Ver respuesta (JSON)' : 'Ocultar respuesta (JSON)';
  });
  document.getElementById('copiar').addEventListener('click', function () {
    var b = this;
    navigator.clipboard.writeText(document.getElementById('json').textContent)
      .then(function () { b.textContent = 'Copiado'; setTimeout(function () { b.textContent = 'Copiar'; }, 1500); });
  });
</script>
</body></html>`;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));