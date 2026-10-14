# EphemChat (Node.js + WebSockets)

Chat **efímero por salas** en tiempo real. Cada ruta es una sala: si entras a
`chat.lup1nlab.com.ar/hola`, todos los que estén en `/hola` chatean al instante y **nada
queda guardado**:

- Un usuario que entra **no ve** lo escrito antes de entrar (no hay historial, solo retransmisión en vivo).
- **Todo en RAM**: los mensajes se retransmiten y se descartan; no se escribe nada a disco.
- Los **archivos compartidos** viven en memoria solo mientras el navegador que los subió siga conectado;
  al cancelar o cerrar la pestaña se liberan.
- Sin base de datos, sin cuentas, **sin logs** (solo una línea de arranque, sin IPs ni contenido).

Markdown, bloques de código con resaltado y archivos efímeros.

## Cómo funciona (resumen)

- **WebSocket** para el chat (mensajes en vivo, sin historial).
- **HTTP** solo para subir/descargar archivos: `multer` con `memoryStorage`, el archivo queda en un
  `Buffer` (RAM) y se sirve desde ahí. Nunca toca el disco.
- Cada archivo está ligado a un `ownerToken` (generado en el navegador). El servidor guarda la
  relación token → conexión WebSocket; cuando el dueño se desconecta, sus archivos se liberan
  (con 20 s de gracia para tolerar reconexiones rápidas).
- Markdown saneado en el cliente con `marked` + `DOMPurify`, resaltado con `highlight.js`.

## Requisitos

- Node.js **18+**.
- Un plan de Hostinger con **Node.js/WebSockets**: **"Web Apps hosting"** (el que permite subir un ZIP)
  o un **VPS**. *No* funciona en el hosting compartido clásico (PHP), que no admite WebSockets.

## Estructura

```
ephemchat-node/
├── package.json          # start: node server.js, deps: express, ws, multer
├── server.js             # servidor HTTP + WebSocket + API (todo en RAM)
├── README.md
└── public/               # frontend (SPA)
    ├── index.html
    ├── style.css
    ├── app.js
    └── vendor/           # marked, DOMPurify, highlight.js (sin CDN)
```

## Importar en Hostinger (Web Apps hosting / "Deploy Node.js app")

1. Sube el **ZIP** (no descomprimido) tal cual: debe contener `package.json`, `server.js` y `public/`
   en la **raíz** del ZIP.
2. Hostinger detectará `package.json`, hará `npm install` y arrancará con `npm start` automáticamente.
3. El puerto lo da Hostinger vía variable `PORT`; `server.js` ya lo lee (`process.env.PORT`).
4. Si te pide un **comando de arranque**, usa: `npm start` (o `node server.js`).
5. Crea el subdominio `chat` y apúntalo a la Web App (o usa la URL que te asigna Hostinger).

> Si usas un **VPS** en su lugar: sube los archivos, `npm install`, y arranca con
> `PORT=8080 npm start` (o detrás de un reverse proxy tipo Nginx/Caddy + SSL).

## Probar en local

```bash
cd ephemchat-node
npm install
PORT=8080 npm start
# abre http://localhost:8080/  y  http://localhost:8080/hola
```

## Configuración

Edita las constantes al inicio de `server.js`:

| Constante | Valor | Significado |
|-----------|-------|-------------|
| `PORT` | `process.env.PORT \|\| 8080` | Puerto (lo da Hostinger) |
| `MAX_FILE_SIZE` | `50 MB` | Tamaño máximo por archivo |
| `MAX_TEXT` | `10000` | Caracteres máx. por mensaje |
| `FILE_GRACE_MS` | `20000` | Gracia (ms) antes de borrar archivos tras desconexión |
| `MAX_FILES_PER_TOKEN` | `20` | Máx. archivos compartidos por pestaña |

## Nota de privacidad

Esta versión **no escribe nada a disco** (mensajes y archivos solo en RAM) y no genera logs propios.
Para el máximo control sobre el rastro (desactivar también los *access logs* del servidor web, que
son los que registran IP+URL), usa un **VPS** propio: ahí puedes desactivar los logs del proxy/nginx.
En el hosting Node gestionado de Hostinger, la plataforma puede conservar sus propios logs de
infraestructura, pero tu aplicación no persiste ningún dato ni contenido.

## Seguridad

- `Content-Security-Policy` estricta, `X-Frame-Options`, `Referrer-Policy: no-referrer` y
  `Cache-Control: no-store`.
- Markdown saneado con `DOMPurify` (bloquea `<script>`, `javascript:`, etc.).
- `shareId` de 128 bits aleatorios: solo quien tenga el enlace puede descargar.
- Nombres de sala restringidos a `A-Za-z0-9_-`.
- Keepalive por ping/pong para liberar conexiones muertas (y por tanto sus archivos).
