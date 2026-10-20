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

// Decimales de cada moneda (PayZen recibe el monto en la unidad mínima)
const DECIMALES = { CLP: 0, PEN: 2 };

// Los montos están en unidades normales (35000 CLP, 120 PEN)
const DEUDAS = {
  '12.572.407-8': {
    numeroCliente: '12.572.407-8',
    pais: 'CL',
    moneda: 'CLP',
    nombre: 'Fernando Luna',
    email: 'fernando.luna@lyra.com',
    direccion: 'Av Chile, San Isidro',
    periodo: 'Octubre 2026',
    vencimiento: '2026-10-31',
    monto: 35000
  },
  '12345678': {
    numeroCliente: '12345678',
    pais: 'PE',
    moneda: 'PEN',
    nombre: 'Fernando Luna',
    email: 'fernando.luna@lyra.com',
    direccion: 'Av. Perú 123, Lima',
    periodo: 'Octubre 2026',
    vencimiento: '2026-10-31',
    monto: 120
  }
};

const {
  PAYZEN_ENDPOINT = 'https://api.payzen.lat',
  PAYZEN_STATIC = 'https://static.payzen.lat/static/js/krypton-client/V4.0'
} = process.env;

// Medios de pago disponibles. Cada uno usa su propia tienda (credenciales PAYZEN_<CLAVE>_*)
const CATALOGO = {
  izipay:    { nombre: 'Izipay',    pais: 'PE' },
  niubiz:    { nombre: 'Niubiz',    pais: 'PE' },
  transbank: { nombre: 'Transbank', pais: 'CL' },
  klap:      { nombre: 'Klap',      pais: 'CL' },
  getnet:    { nombre: 'Getnet',    pais: 'CL' }
};

const TIENDAS = Object.fromEntries(
  Object.entries(CATALOGO).map(([clave, datos]) => {
    const p = `PAYZEN_${clave.toUpperCase()}_`;
    return [clave, {
      ...datos,
      username: process.env[p + 'USERNAME'],
      password: process.env[p + 'PASSWORD'],
      publicKey: process.env[p + 'PUBLIC_KEY'],
      sha256: process.env[p + 'SHA256']
    }];
  })
);

const NOMBRE_PAIS = { PE: 'Perú', CL: 'Chile' };

// Health check para Render
app.get('/health', (req, res) => res.json({ ok: true }));

// Busca la deuda y verifica que el documento corresponda al país del medio de pago
function buscarCuenta(dni, claveTienda) {
  const tienda = TIENDAS[claveTienda];
  if (!tienda) return { status: 400, error: 'Medio de pago no válido.' };
  const cuenta = DEUDAS[String(dni || '').trim()];
  if (!cuenta || cuenta.pais !== tienda.pais) {
    return { status: 404, error: `No encontramos una deuda asociada a ese documento en ${NOMBRE_PAIS[tienda.pais]}.` };
  }
  return { cuenta, tienda };
}

app.post('/api/consulta-deuda', (req, res) => {
  const r = buscarCuenta(req.body.dni, req.body.tienda);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ ...r.cuenta, medioPago: r.tienda.nombre });
});

// Datos públicos que necesita el navegador para la tienda elegida
app.get('/api/config', (req, res) => {
  const tienda = TIENDAS[req.query.tienda];
  if (!tienda) return res.status(400).json({ error: 'Medio de pago no válido.' });
  if (!tienda.publicKey) return res.status(500).json({ error: `Falta la clave pública de ${tienda.nombre} en el .env` });
  res.json({
    publicKey: tienda.publicKey,
    jsUrl: `${PAYZEN_STATIC}/stable/kr-payment-form.min.js`,
    themeCss: `${PAYZEN_STATIC}/ext/classic-reset.css`,
    themeJs: `${PAYZEN_STATIC}/ext/classic.js`
  });
});

// Crea el pago en PayZen con las credenciales de la tienda elegida
app.post('/api/crear-pago', async (req, res) => {
  const r0 = buscarCuenta(req.body.dni, req.body.tienda);
  if (r0.error) return res.status(r0.status).json({ error: r0.error });
  const { cuenta, tienda } = r0;

  if (!tienda.username || !tienda.password) {
    return res.status(500).json({ error: `Faltan las credenciales de ${tienda.nombre} en el .env` });
  }

  const auth = Buffer.from(`${tienda.username}:${tienda.password}`).toString('base64');
  const amount = Math.round(cuenta.monto * 10 ** DECIMALES[cuenta.moneda]); // el monto SIEMPRE sale del backend

  try {
    const r = await fetch(`${PAYZEN_ENDPOINT}/api-payment/V4/Charge/CreatePayment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount,
        currency: cuenta.moneda,
        formAction: 'PAYMENT',
        orderId: `GV-${req.body.tienda.toUpperCase()}-${cuenta.numeroCliente.replace(/[^0-9kK]/g, '')}-${Date.now()}`,
        customer: { email: cuenta.email, reference: cuenta.numeroCliente }
      })
    });
    const data = await r.json();

    if (data.status !== 'SUCCESS' || !data.answer || !data.answer.formToken) {
      console.error(`Error PayZen CreatePayment (${tienda.nombre}):`, JSON.stringify(data));
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
// se prueba con las claves de cada tienda configurada.
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
    return res.status(400).send(paginaResultado({ exito: false, titulo: 'No se recibió respuesta del pago', json: req.body }));
  }

  const exito = firmaOk && respuesta.orderStatus === 'PAID';
  res.send(paginaResultado({
    exito,
    titulo: !firmaOk ? 'Firma no válida: respuesta no verificada' : exito ? 'Pago autorizado' : 'Pago no autorizado',
    firmaOk,
    json: respuesta
  }));
});

// Si alguien abre la URL de retorno directamente
app.get('/retorno-pago', (req, res) => res.redirect(FRONTEND_PRINCIPAL));

// IPN (notificación servidor a servidor). Configura esta URL en el Back Office de TODAS las tiendas.
// Aquí es donde debes marcar la deuda como pagada, no en el retorno del navegador.
app.post('/webhook-payzen', (req, res) => {
  if (!hashValido(req.body)) return res.status(400).send('Firma inválida');
  const respuesta = JSON.parse(req.body['kr-answer']);
  console.log('IPN:', respuesta.orderDetails?.orderId, respuesta.orderStatus);
  res.status(200).send('OK');
});

function escaparHtml(valor) {
  return String(valor).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function paginaResultado({ exito, titulo, firmaOk = true, json }) {
  const color = exito ? '#00b58a' : '#c0392b';
  const jsonTexto = escaparHtml(JSON.stringify(json, null, 2));
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resultado del pago</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.3/css/bootstrap.min.css" rel="stylesheet">
<style>
  body{ font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; min-height:100vh;
    background:linear-gradient(135deg,#e9edf3 0%,#d9dfe9 50%,#c9d2e3 100%);
    display:flex; align-items:center; justify-content:center; padding:24px 12px; }
  .panel{ width:100%; max-width:760px; background:#fff; border-radius:22px; overflow:hidden; box-shadow:0 14px 40px rgba(13,27,76,.18); }
  .head{ background:${color}; color:#fff; padding:1.4rem 1.8rem; text-align:center; }
  .head h1{ font-size:1.5rem; font-weight:900; margin:0; }
  .body{ padding:1.6rem 1.8rem 2rem; }
  pre{ background:#0d1b4c; color:#d6e2ff; border-radius:14px; padding:1rem; max-height:420px; overflow:auto; font-size:.8rem; margin:0; }
  .btn-navy{ background:#0d1b4c; color:#fff; font-weight:700; border-radius:12px; }
  .btn-navy:hover{ background:#081338; color:#fff; }
</style></head>
<body>
<main class="panel">
  <div class="head"><h1>${exito ? '✅' : '⚠️'} ${escaparHtml(titulo)}</h1></div>
  <div class="body">
    <div class="d-flex justify-content-between align-items-center mb-2">
      <strong style="color:#0d1b4c">Respuesta (JSON)</strong>
      <button id="copiar" type="button" class="btn btn-sm btn-outline-secondary">Copiar</button>
    </div>
    <pre id="json">${jsonTexto}</pre>
    <div class="d-grid mt-4">
      <a href="${escaparHtml(FRONTEND_PRINCIPAL)}" class="btn btn-navy py-2">Volver al inicio</a>
    </div>
  </div>
</main>
<script>
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