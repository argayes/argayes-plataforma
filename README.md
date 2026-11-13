# ARGAYES — backend de lealtad

Conecta la página web (registro + QR) con Google Wallet y Apple Wallet de verdad,
y guarda negocio, clientes, visitas y canjes. Corresponde a los Pasos 3–9 de la
guía "Programa de lealtad con Wallet y QR".

## 1. Instalar

```
npm install
cp .env.example .env
```

## 2. Credenciales (Paso 3 de la guía — esto no lo hace el código, lo trámitas tú)

**Google Wallet**
1. Crea cuenta en [Google Wallet Business Console](https://pay.google.com/business/console/)
2. Activa la Google Wallet API en el mismo proyecto de Google Cloud
3. Crea un Service Account, descarga su llave `.json`, guárdala como
   `google-service-account.json` en esta carpeta (no la subas a git)
4. En `.env`, pon `GOOGLE_ISSUER_ID` con el Issuer ID que te da la consola de Wallet

**Apple Wallet**
1. Cuenta en [Apple Developer Program](https://developer.apple.com/programs/) ($99 USD/año)
2. Crea un Pass Type ID en el portal de certificados
3. Descarga el certificado de ese Pass Type ID y conviértelo a `.pem`:
   ```
   openssl pkcs12 -in Certificates.p12 -clcerts -nokeys -out certs/signerCert.pem
   openssl pkcs12 -in Certificates.p12 -nocerts -out certs/signerKey.pem
   ```
4. Descarga el certificado WWDR de Apple (G4) y guárdalo como `certs/wwdr.pem`
5. En `.env`, llena `APPLE_TEAM_ID` y `APPLE_PASS_TYPE_ID`
6. Agrega a `pass-model/` las imágenes que Apple exige: `icon.png` (29×29),
   `icon@2x.png` (58×58), `logo.png` (160×50) y `logo@2x.png` (320×100), con
   el logo de ARGAYES. Sin estas imágenes el `.pkpass` no se genera.

Sin estas dos cosas, el backend igual corre y guarda los registros — solo las
rutas de `/api/wallet/...` responderán con un error explicando qué falta.

**Actualizaciones automáticas del pase de Apple Wallet**: ya no hace falta
configurar nada aparte — reutiliza los mismos certificados de arriba. En
cuanto el cliente agrega el pase con las notificaciones activadas, su
iPhone se registra solo (`/api/apple/v1/...`) y cada vez que cambian sus
puntos o el negocio edita su tarjeta, el pase que ya tiene guardado se
actualiza solo, sin que vuelva a escanear nada. Si `PUBLIC_URL` no está
configurado en `.env`, el pase se genera igual pero sin esta parte (no
lleva `webServiceURL`, así que el iPhone nunca pregunta por actualizaciones).

## 3. Correr local

```
npm start
```

Corre en `http://localhost:3000`.

## 4. Flujo de prueba con curl

```bash
# 1) Alta de la empresa (una sola vez)
curl -X POST http://localhost:3000/api/empresas \
  -H "Content-Type: application/json" \
  -d '{"nombre":"ARGAYES","recompensa":"Servicio de publicidad gratis","umbral":10}'
# → guarda el "id" que regresa, es tu EMPRESA_ID

# 2) Alta de un cliente
curl -X POST http://localhost:3000/api/clientes \
  -H "Content-Type: application/json" \
  -d '{"empresaId":"EMPRESA_ID","nombre":"Juan Pérez","contacto":"55 1234 5678"}'
# → guarda el "id" que regresa, es tu CLIENTE_ID

# 3) Link para agregar a Google Wallet
curl http://localhost:3000/api/wallet/google/CLIENTE_ID

# 4) Descargar el .pkpass de Apple Wallet
curl http://localhost:3000/api/wallet/apple/CLIENTE_ID.pkpass -o pase.pkpass

# 5) Registrar una visita (sumar un punto)
curl -X POST http://localhost:3000/api/visita \
  -H "Content-Type: application/json" -d '{"clienteId":"CLIENTE_ID"}'

# 6) Generar código de canje cuando ya llegó al umbral
curl -X POST http://localhost:3000/api/canje \
  -H "Content-Type: application/json" -d '{"clienteId":"CLIENTE_ID"}'

# 7) Confirmar el canje en caja
curl -X POST http://localhost:3000/api/canje/confirmar \
  -H "Content-Type: application/json" -d '{"codigo":"CODIGO_DEL_PASO_6"}'
```

## 5. Desplegarlo (para que no viva solo en tu computadora)

Este backend necesita quedarse corriendo todo el tiempo (no es un sitio
estático como la página de registro), así que no va en Netlify/Vercel
estático. Opciones gratis/baratas que sí lo soportan:

- **Railway** (railway.app): conecta tu repo de GitHub, agrega las variables
  de entorno del `.env` en Settings → Variables, y sube `google-service-account.json`
  y los `.pem` como "Variables" tipo archivo o Volumes.
- **Render** (render.com): mismo flujo, "Web Service" con `npm start`.

Una vez desplegado, copia la URL pública que te den y ponla en `PUBLIC_URL`.

## 7. Respaldo mensual de la base de datos

El Postgres gratis de Render no hace respaldos. El de pago sí, pero solo
guarda los últimos 3-7 días (point-in-time recovery) — no sirve para
"quiero poder recuperar lo de hace 2 meses". Para eso, `scripts/respaldo-mensual.js`
manda por correo, una vez al mes, un archivo con TODO lo que hay en la base
de datos (negocios, clientes, visitas, canjes — sin contraseñas).

Esto corre gratis con **GitHub Actions** (`.github/workflows/respaldo-mensual.yml`),
no con un Cron Job de Render — así no hace falta dar tarjeta de crédito en
ningún lado solo para mandar un correo una vez al mes.

Para activarlo (una sola vez, tarda 2 minutos):
1. En GitHub, entra al repo `argayes-plataforma` → **Settings** → **Secrets
   and variables** → **Actions** → **New repository secret**
2. Agrega estos 4, uno por uno:
   - `DATABASE_URL` — cópiala igual que la tiene el servicio del backend en Render
   - `RESEND_API_KEY` y `EMAIL_FROM` — igual, cópialas del backend (si no
     las tienes configuradas todavía, revisa `lib/email.js`)
   - `BACKUP_EMAIL_TO` — el correo tuyo donde quieres recibir el respaldo

De ahí en adelante, GitHub lo corre solo cada mes — no hace falta volver a
tocarlo. También lo puedes correr a mano cuando quieras, para probar: en el
repo, pestaña **Actions** → "Respaldo mensual de la base de datos" →
**Run workflow**.

Si alguna vez necesitas RESTAURAR un respaldo, pide ayuda para hacerlo
bien: no es algo que convenga improvisar.

## 6. Conectarlo con la página web (`argayes-lealtad.html`)

En la página, al generar el QR, en vez de armar el JSON con los datos
localmente, hay que:

1. Primero llamar a `POST /api/clientes` con los datos del formulario
2. Con el `id` que regresa, llamar a `GET /api/wallet/google/:id` (botón
   Google) o abrir `GET /api/wallet/apple/:id.pkpass` (botón Apple)
3. Meter esa URL real (`saveUrl` o la del `.pkpass`) en el QR, en vez del JSON

Dime cuando tengas el backend desplegado y te ayudo a hacer ese cambio en la página.

## 8. La página (panel, registro, etc.) se publica sola en GitHub Pages

`public-frontend/` (el panel, la página de registro, el escáner, etc.)
ya NO se sube a mano arrastrando un zip a Netlify Drop — eso se dejó de
usar porque el plan gratis de Netlify tiene un límite de "créditos" al
mes (300) y cada subida gasta 15, así que con varias pruebas se acaba
rápido y bloquea subir nada nuevo hasta que se resetea el mes siguiente.

Ahora, cada vez que se hace push a `main` con cambios en
`public-frontend/`, el workflow `.github/workflows/pages.yml` publica
esos archivos solo en **GitHub Pages** (gratis, sin ese límite):

```
https://argayes.github.io/argayes-plataforma/
```

Si alguna vez se quiere usar un dominio propio (ej. `app.argayes.com`)
en vez de ese, se configura en GitHub → Settings → Pages → Custom domain.

La URL del backend (`https://argayes-backend.onrender.com`) ya viene
puesta por default en el código — no hace falta configurarla a mano la
primera vez que se abre la página en un dominio nuevo.
