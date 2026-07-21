# WhatsApp Assistant

Asistente local de WhatsApp: un bridge de solo lectura basado en Baileys y un
CLI para consultar chats por alias. La API escucha **únicamente** en
`127.0.0.1`; no es una integración oficial de WhatsApp.

Antes de tocar una sesión, un QR o la sincronización, leer la guía operativa:
[`docs/onboarding-and-recovery.md`](docs/onboarding-and-recovery.md). Define
el modo reciente de 30 días y evita pedir QRs innecesarios.

## Arranque

```bash
cd whatsapp-assistant
npm install
npm start
```

En el primer arranque aparece un QR en esta terminal. En WhatsApp móvil:
**Ajustes → Dispositivos vinculados → Vincular un dispositivo**. Escanealo.

La primera vez también se crea un token local en `data/bridge-token`. Tanto
ese token como las credenciales de WhatsApp están excluidos de Git.

## CLI

Instalación local del comando:

```bash
npm link
```

| Comando | Uso |
| --- | --- |
| `wa status` | Estado del bridge y cantidad de mensajes cacheados |
| `wa alias add contacto +598XXXXXXXX "Nombre del contacto"` | Guarda un alias privado |
| `wa aliases` | Lista aliases conocidos |
| `wa find "Nombre del contacto"` | Busca aliases, identidad de WhatsApp, mensajes recientes y, opcionalmente, Contactos de macOS |
| `wa recent 20` | Lista chats individuales recientes con identidad de WhatsApp; usa Contactos de macOS sólo como complemento |
| `wa groups find maspeak` | Muestra grupos conocidos de Maspeak y descubre candidatos nuevos desde metadata y mensajes |
| `wa groups inspect <jid>` | Lee título, descripción y mensajes recientes antes de clasificar un candidato |
| `wa groups add maspeak <jid>` | Guarda un grupo confirmado en la lista privada de Maspeak |
| `wa latest contacto` | Último mensaje de ese chat |
| `wa history contacto 20 --ids` | Últimos mensajes, con IDs para operar sobre ellos |
| `wa search contacto "presupuesto"` | Busca texto dentro del chat |
| `wa search-all "Oracle" --since 7d` | Busca texto en todos los chats recientes |
| `wa pending --since 24h` | Lista chats directos recientes cuya última intervención fue entrante |
| `wa pending --groups maspeak --since 24h` | Lista actividad reciente cuyo último intercambio fue entrante en grupos conocidos |
| `wa audios contacto` / `wa audio contacto <id>` | Lista o descarga un audio seleccionado |
| `wa transcribe contacto <id|latest>` | Descarga y transcribe un audio seleccionado |
| `wa images contacto` / `wa image contacto <id>` | Lista o descarga una imagen seleccionada |
| `wa image-text contacto <id>` | Hace OCR local de una imagen seleccionada |
| `wa files contacto` / `wa file contacto <id>` | Lista o descarga un documento entrante seleccionado |
| `wa react contacto latest-incoming 👍` | Reacciona explícitamente al último mensaje entrante |
| `wa send contacto "mensaje"` | Envía un mensaje de texto al contacto resuelto |
| `wa send-file contacto /ruta/resumen.pdf "mensaje"` | Envía un PDF con un mensaje al contacto resuelto |

Los aliases viven en `data/aliases.json`, que nunca entra a Git. Las acciones
de escritura (`send`, `send-file`, `react`) requieren un comando explícito; el
bridge nunca responde, reacciona ni envía archivos por su cuenta.

`wa send-file` conserva el nombre y detecta automáticamente el tipo de archivo
(PDF, Excel, Word, imagen, CSV, ZIP y formatos comunes); siempre lo envía como
documento y requiere una instrucción explícita.

El CLI no clasifica intención, urgencia, saludos ni pendientes según el texto:
sólo presenta hechos estructurales (autor, fecha, tipo, orden y si hubo una
respuesta posterior). La interpretación semántica corresponde a la IA que use
estos datos, para conservar compatibilidad entre idiomas y contextos.

`wa find` funciona sin agenda local: prioriza aliases privados, nombres que
WhatsApp sincroniza (`pushName` / contactos / chats) y coincidencias en
mensajes recientes, mostrando cuántos mensajes sustentan cada resultado. En
macOS también consulta Contactos bajo demanda, normalizando acentos y prefijos
como `Flor` → `Florencia`; la agenda nunca se copia al cache. Los nombres
ambiguos se muestran como candidatos; para enviar sin alias, usar el nombre
completo que coincida exactamente o el número de teléfono.

Las listas de grupos viven en `data/group-lists.json`, nunca en Git. Una lista
guarda los grupos confirmados, pero `wa groups find <lista>` siempre vuelve a
consultar los grupos actuales de WhatsApp y los mensajes recientes para detectar
candidatos nuevos; no es una lista rígida hardcodeada.
Antes de agregar un candidato cuya pertenencia no sea evidente por el título,
usar `wa groups inspect <jid>` y clasificarlo por su contenido real, no sólo por
una palabra compartida en el nombre.

La separación exacta entre el código público y el estado privado está en
[`docs/private-state.md`](docs/private-state.md).

Los audios, imágenes y documentos recientes se conservan como envelopes privados
durante la misma ventana de 30 días. Cada archivo se descarga únicamente al
pedirlo con un comando explícito. El OCR de imágenes usa Vision local de macOS.

## API local

Todas las rutas (salvo `GET /health`) requieren:

```text
Authorization: Bearer <contenido de data/bridge-token>
```

| Ruta | Uso |
| --- | --- |
| `GET /health` | Estado de conexión, sin token |
| `GET /chats?limit=50` | Chats conocidos, más recientes primero |
| `GET /messages?jid=<jid>&limit=50` | Mensajes sincronizados de un chat |
| `GET /search?q=<texto>&limit=30` | Búsqueda local en mensajes recibidos/sincronizados |

La API queda cerrada a loopback. El envío solo está expuesto mediante el CLI
local (`wa send`) y debe usarse únicamente ante una instrucción explícita del
usuario.

## Notas operativas

- Dejá este proceso corriendo para recibir mensajes nuevos.
- Para desvincularlo: WhatsApp → Dispositivos vinculados → cerrar sesión del
  dispositivo. Luego se puede borrar `auth/` localmente.
- `data/messages.json` guarda mensajes recientes de hasta 30 días, con un tope
  de 10.000, para búsquedas. Contiene texto de chats, por lo que el directorio
  tiene permisos privados. WhatsApp define el detalle exacto de la
  sincronización reciente; el asistente no solicita una copia del historial
  completo.
