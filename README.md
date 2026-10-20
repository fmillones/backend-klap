# Pago en línea multi-medio con PayZen (demo)

Backend Node/Express + frontend estático (HTML/Bootstrap) con el **formulario embebido (Krypton V4)** de PayZen/Lyra.

## Flujo

1. `index.html`: el usuario elige **Test** o **Producción** (botones superiores) y luego un medio de pago (cuadro con la bandera del país).
2. `gas.html?tienda=<medio>&modo=<test|prod>`: página "Pago fácil". El usuario ingresa su documento (RUT en Chile, DNI en Perú) y se abre el detalle de la cuenta.
3. Al pulsar **Pagar**, el backend llama a `Charge/CreatePayment` con las credenciales del medio y modo elegidos y devuelve un `formToken`. El frontend renderiza el formulario con `KR.setFormConfig`. En **Transbank (Plus)** el botón de Webpay se presiona automáticamente.
4. PayZen hace POST al backend en `/retorno-pago`. El backend valida `kr-hash` (HMAC-SHA256) y muestra "Pago aceptado" o "Pago rechazado", con la opción de ver la respuesta JSON.

## Medios de pago

| Clave            | Nombre            | País  |
|------------------|-------------------|-------|
| `transbank_mall` | Transbank (Mall)  | Chile |
| `transbank_plus` | Transbank (Plus)  | Chile |
| `klap`           | Klap              | Chile |
| `pagonxt`        | Pagonxt           | Chile |
| `izipay`         | Izipay            | Perú  |
| `niubiz`         | Niubiz            | Perú  |

Cada medio tiene dos juegos de credenciales en el `.env`:

    PAYZEN_<MEDIO>_<TEST|PROD>_<USERNAME|PASSWORD|PUBLIC_KEY|SHA256>

Ejemplo: `PAYZEN_TRANSBANK_PLUS_PROD_PASSWORD`. Las credenciales salen de Back Office > Configuración > Tienda > Claves de la API REST. Usa `.env.example` como plantilla.

## Clientes de prueba

Están en el arreglo `CLIENTES` de `server.js`: cada uno tiene un RUT (Chile) y un DNI (Perú) con su deuda. Los clientes 2, 3 y 4 tienen datos de relleno; reemplázalos por los reales.

## Ejecutar en local

    npm install
    cp .env.example .env    # y completa las credenciales
    npm start               # http://localhost:3000

## Despliegue en Render

- Web Service con `npm install` / `npm start` y Health Check Path `/health`.
- Carga en Environment todas las variables de `.env.example`. `FRONTEND_URL` es la URL del frontend (puede incluir la ruta de GitHub Pages).
- En el Back Office de PayZen, configura el IPN de todas las tiendas (test y producción) como `https://TU-BACKEND.onrender.com/webhook-payzen`.

## Antes de producción

- Marca la deuda como pagada en el IPN (`/webhook-payzen`), no en el retorno del navegador.
- Reemplaza `CLIENTES` por tu consulta real.
- El modo (`test` o `prod`) lo envía el navegador; si el sitio será público, restringe quién puede usar producción.
- En el plan gratuito de Render el backend se "duerme" tras un rato sin uso y la primera petición puede tardar.