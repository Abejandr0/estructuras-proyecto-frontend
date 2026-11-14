# AIVerse

MiniGit es un control de versiones local en TypeScript, organizado como monorepo. El motor almacena blobs, árboles y commits identificados con SHA-1 de `tipo tamaño\0contenido` y comprimidos con zlib en `.minigit/objects`; mantiene staging en `index`, ramas en `refs/heads`, HEAD simbólico y un reflog básico. El objeto vuelve a verificarse por hash y tamaño al leerlo.

## Inicio

```sh
npm install
npm run build
npm test
npm run dev:server # inicializa .minigit en la raíz si hace falta, puerto 4179
npm run dev:web    # Vite
```

Abre `http://localhost:5173`. El servidor local escucha en `127.0.0.1:4179`. Para servir otro repositorio usa `MINIGIT_REPO=/ruta/al/repo npm run dev:server`. La clave de Gemini solo la lee el backend.

## AIVerse y despliegue local

La plataforma usa MongoDB para cuentas, sesiones, perfiles, metadatos de repositorios y pull requests. Los objetos del código se guardan en el volumen persistente del backend; MongoDB conserva el índice y los metadatos. En local puedes levantar MongoDB con Docker Compose; para producción crea una base MongoDB Atlas y configura `MONGODB_URI`.

```sh
cp .env.example .env
# Edita MONGO_PASSWORD y agrega la clave de Gemini cuando la tengas.
docker compose up --build
```

La web quedará en `http://localhost:5173`, MongoDB y el backend sólo escucharán en loopback. Asegúrate de que `MONGO_PASSWORD` use caracteres URL-safe al editar `.env`; no subas ese archivo al repositorio.

### Despliegue en Render, Vercel y MongoDB Atlas

El repositorio ya incluye `render.yaml` y `vercel.json`. Para producción, despliega primero el backend, después la web y finalmente vuelve al backend para completar el origen permitido.

1. **Crea la base en MongoDB Atlas.** Crea un cluster, luego un usuario de base de datos con permisos de lectura y escritura sobre la base `aiverse`. Este usuario es independiente del usuario con el que inicias sesión en Atlas. En Network Access, permite las IP ranges de salida de tu servicio Render: aparecen en **Connect → Outbound** dentro del servicio. Atlas bloquea conexiones de IPs que no estén en su allowlist; evita `0.0.0.0/0` en producción. Copia la URI `mongodb+srv://...` de Atlas y sustituye el marcador del password por la contraseña del usuario de base de datos.
2. **Despliega el backend en Render.** Crea un Blueprint desde el repositorio `estructuras-proyecto-backend`, branch `main`, y usa el `render.yaml` de la raíz. Render creará `aiverse-api` desde el Dockerfile. El servicio incluye un disco persistente de 10 GB montado en `/srv/aiverse`; se necesita un plan web pagado para conservar ahí los objetos del código entre despliegues. En Environment completa `MONGODB_URI` con la URI de Atlas y `WEB_ORIGIN` temporalmente con `https://aiverse.vercel.app`. La aplicación selecciona la base `aiverse` por defecto (`MONGODB_DB_NAME` permite cambiarla). Espera a que `/api/health/ready` responda `{"ok":true,"database":"connected"}` y copia el dominio `https://...onrender.com` del servicio.
3. **Despliega el frontend en Vercel.** Importa `estructuras-proyecto-frontend`, branch `main`. Deja **Root Directory** como `.` para que Vercel use el workspace y `vercel.json` de la raíz. El build usa `npm run build -w @aiverse/web` y publica `apps/web/dist`. En Settings → Environment Variables crea `VITE_API_URL` con la URL HTTPS de Render, sin `/api` ni `/` final, y `VITE_SITE_URL` con el dominio público final de la web. El segundo valor se usa para crear `robots.txt` y `sitemap.xml`. Añádelas a Production (y Preview si vas a usar previews) y despliega.
4. **Conecta los dos dominios.** Copia el dominio de Production de Vercel y reemplaza `WEB_ORIGIN` en Render por ese origen exacto, sin barra final. Si separas varios dominios con comas, cada uno debe ser un origen exacto. Guarda y despliega de nuevo el backend. Cuando `/api/health/ready` muestre la base conectada y la web ya use la URL de Render, la cuenta, el feed y las sesiones podrán comunicarse.
5. **Activa Gemini cuando tengas la clave.** Añade `GEMINI_API_KEY` sólo en Environment de Render y cambia `AI_ALLOW_NETWORK` a `true`. No la pongas como variable `VITE_*` en Vercel: las variables Vite forman parte del JavaScript que recibe el navegador. Después, vuelve a desplegar Render.

Las sesiones usan cookies `Secure` y CORS con credenciales. Si la consola muestra `NetworkError`, revisa que `VITE_API_URL` sea el dominio HTTPS de Render, que el servicio esté activo, que MongoDB acepte las IP ranges de salida de Render y que `WEB_ORIGIN` coincida exactamente con Vercel. Para producción, sirve la web y la API bajo el mismo sitio (por ejemplo, `app.tudominio.com` y `api.tudominio.com`) o usa un proxy de API del mismo origen: los dominios predeterminados `vercel.app` y `onrender.com` son sitios distintos y algunos navegadores bloquean cookies de sesión de terceros. Cambiar una variable en cualquiera de las plataformas requiere un nuevo despliegue para que el frontend compilado o el backend la reciban.

El backend de Render mantiene desactivada por defecto la API heredada que opera sobre un único repositorio local (`ENABLE_SHARED_REPOSITORY_API=false`). Esa API no está aislada por cuenta: habilitarla en una web pública permitiría que visitantes compartan el mismo repositorio. Actívala solo en una instalación privada y de un solo operador; para un producto multiusuario hay que completar primero el aislamiento por repositorio y autorización.

Vercel aplica HTTPS y sirve las rutas públicas de la SPA; Caddy obtiene certificados y redirige HTTP a HTTPS en el despliegue de Lightsail. La web publica páginas legales, metadatos, datos estructurados, `robots.txt`, `sitemap.xml` y una página 404. Antes de abrir el registro al público, completa el nombre/domicilio del operador, un canal de privacidad y soporte y revisa legalmente los textos de beta. Una ficha de Google Business Profile requiere una empresa real verificable y se administra fuera del código.

**Dónde viven tus datos:** MongoDB guarda usuarios, sesiones, perfiles y metadatos de repositorios/PRs. Los blobs y árboles que forman el contenido versionado se guardan en el disco persistente de Render, no dentro de MongoDB. Por eso el disco y su tamaño son importantes; si quieres almacenamiento más escalable, conviene migrar los objetos a un servicio S3 compatible y dejar MongoDB para los metadatos.

Los planes y pagos dependen de la configuración de Mercado Pago en el backend; sin credenciales, el checkout permanece deshabilitado. El backend aplica los límites actuales por plan: Free 3, Starter 10, Plus 20 y Pro ilimitado. Los textos legales de beta requieren añadir el nombre legal y el canal de soporte del operador antes de abrir el registro al público.

CLI: `aiverse init`, `add`, `commit`, `status`, `log`, `branch`, `checkout`, `merge`, `stash`, `reset`, `revert`, `serve`, `clone`, `push`, `pull`. En este checkout puedes compilarlo con `npm run build` y enlazar el comando con `npm link --workspace @aiverse/cli`; después usa `aiverse init` en un proyecto. El transporte remoto actual usa los endpoints HTTP de AIVerse: `aiverse clone <url> <directorio>` y, dentro de un repositorio, `aiverse push <url>` o `aiverse pull <url>`.

### Suscripciones con Mercado Pago (Colombia)

La página de planes inicia suscripciones mensuales en COP mediante Mercado Pago y el backend activa el nivel después de validar el webhook `subscription_preapproval`. Para probarlo:

1. Crea una aplicación en **Tus integraciones** de Mercado Pago y copia las credenciales de prueba. Configura `MP_ACCESS_TOKEN` sólo en el backend.
2. Configura `MP_WEBHOOK_SECRET` con la firma secreta generada para Webhooks y registra `https://TU_DOMINIO/api/billing/webhook`, con el evento de suscripción (`subscription_preapproval`).
3. Configura los precios mensuales en pesos: `MP_PRICE_STARTER_COP=3300`, `MP_PRICE_PLUS_COP=26500`, `MP_PRICE_PRO_COP=59600`. Son valores iniciales editables; Starter se aproxima a USD 1 según una tasa de referencia, pero Mercado Pago cobrará COP.
4. Despliega el backend y prueba el flujo con usuarios/tarjetas de prueba de Mercado Pago. Cambia `MP_ACCESS_TOKEN` a la credencial de producción sólo al estar listo para cobrar dinero real.

No publiques el access token ni la firma del webhook. El nivel se asigna tras consultar la suscripción directamente a Mercado Pago desde el webhook firmado; la URL de regreso del checkout no activa el plan por sí sola.

## Arquitectura y persistencia

- `packages/core`: estructuras propias y motor de objetos/refs.
- `packages/cli`: CLI sobre directorios reales.
- `packages/server`: HTTP, WebSocket de eventos, endpoints de repositorio y proveedor IA (heurístico o API compatible OpenAI mediante `OPENAI_API_KEY`).
- `apps/web`: interfaz React/Vite en español, grafo SVG, terminal, estado del repo e inspector de buckets.

`.minigit/index` es JSON con ruta, modo y hash de blob. Árboles y commits son JSON UTF-8 dentro de objetos comprimidos; los árboles contienen entradas ordenadas con nombre, modo, tipo y hash. HEAD contiene `ref: refs/heads/main`. El reflog usa registros de hash anterior/nuevo, autor y mensaje.

## Estructuras

| Estructura | Uso actual / estado | Complejidad |
|---|---|---|
| DynamicArray | Colecciones indexadas y rutas de recorrido | acceso O(1), inserción amortizada O(1), quitar O(n) |
| Stack | Almacenamiento de la pila persistida de stashes | push/pop O(1) |
| Queue | BFS de objetos alcanzables y recorridos del motor | enqueue/dequeue amortizado O(1) |
| NaryTree | Implementada; falta conectarla al árbol de archivos | recorrido O(n) |
| Graph | Implementado; el motor recorre el DAG con BFS/Queue | BFS/topológico O(V+E) |
| SinglyLinkedList | Implementada; historial lineal aún no la usa | append O(1), búsqueda O(n) |
| DoublyLinkedList | Base de la lista usada por LRUCache | insertar/quitar por nodo O(1) |
| CircularDoublyLinkedList | Implementada; falta conectarla al carrusel de ramas/stashes | rotación O(1) |
| HashTable | Índice en memoria de objetos leídos/escritos | promedio O(1), peor O(n) |
| Trie | Implementado; autocompletado aún no integrado | O(k) por prefijo |
| MinHeap | Implementado; top-K aún no integrado | push/pop O(log n), peek O(1) |
| BloomFilter | Negociación remota de objetos junto con hashes exactos | O(k), puede tener falsos positivos |
| LRUCache | Implementado; falta conectarlo a lecturas y diffs del motor | promedio O(1) |

La regla del curso prohíbe `Map`, `Set` y librerías de estructuras de datos en core; las colecciones del motor usan implementaciones propias. La interfaz y el servidor pueden usar colecciones nativas.

## Estado de alcance

Esta entrega cubre almacenamiento local, ramas, merge con marcadores de conflicto, stash, reset, revert, sincronización remota por HTTP, API local, eventos de archivos, IA heurística y adaptador de revisión por API, y una interfaz de exploración con diff lado a lado. La cola de IA conserva estados en memoria, aplica reintentos y limita la concurrencia mediante `AI_CONCURRENCY`. La transferencia recorre el DAG alcanzable desde las ramas, usa un Bloom filter junto con los hashes conocidos y envía los objetos que faltan. Los hashes exactos evitan perder objetos por falsos positivos del filtro. El editor todavía no guarda cambios y el trazado del grafo usa un solo carril visual. `reset --hard` reescribe el árbol de trabajo y debe usarse con cuidado. Los objetos y el protocolo son educativos y no intercambiables con Git. Benchmarks básicos: `npm run bench`.
