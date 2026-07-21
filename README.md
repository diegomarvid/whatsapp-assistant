# 💬 WhatsApp Assistant

> **Tu WhatsApp reciente, disponible para vos o tu agente de IA desde una CLI
> local.** Lee el chat correcto, recupera adjuntos, entiende los hechos que
> WhatsApp reporta y actúa sólo cuando se lo pedís.

WhatsApp Assistant convierte una cuenta vinculada de WhatsApp en contexto local
**reciente, verificable y accionable**. En vez de hacer que un agente adivine
qué chat mirar o trabaje con una copia vieja, el comando `wa` le da mensajes,
media, replies, receipts, reacciones y cobertura de sincronización desde un
mirror privado de los últimos siete días por defecto —o de la ventana que la
persona configure conscientemente durante el onboarding.

No es una integración oficial de WhatsApp. Nunca publica una API a Internet ni
interpreta el significado de tus conversaciones por reglas de texto.

![Arquitectura del bridge local](docs/assets/whatsapp-assistant-architecture.drawio.png)

## ⚡ Una conexión, mucho más contexto útil

| | |
| --- | --- |
| 🔄 **Siempre reciente** | Un bridge en segundo plano recibe eventos y conserva una ventana móvil de siete días por defecto; se puede ampliar explícitamente cuando el caso lo justifica. |
| 🎯 **El chat correcto** | Resuelve números, aliases, nombres de WhatsApp y el LID actual antes de leer, responder o reaccionar. |
| ✅ **Acciones sobre hechos frescos** | `latest`, replies y reacciones validan cobertura `fresh` para no actuar sobre un mensaje que quedó viejo. |
| 🔒 **Privado por diseño** | API sólo en `127.0.0.1`; sesión, SQLite, aliases y adjuntos quedan en tu máquina, fuera de Git y Homebrew. |
| 🧠 **Ideal para agentes** | Devuelve datos estructurados y paths absolutos; la IA interpreta el contenido con sus propias capacidades, en cualquier idioma. |

## ✨ Todo lo que podés hacer

### 💬 Leer conversaciones con contexto real

- Encontrar personas por alias, teléfono, nombre de WhatsApp o actividad
  reciente: `wa find "Florencia"`.
- Ver el último mensaje entrante, la conversación reciente o buscar en todos
  los chats de la ventana: `latest-incoming`, `history`, `search` y
  `search-all`.
- Saber si una lectura está realmente al día antes de concluir algo:
  `wa coverage contacto`.
- Mantener listas privadas de grupos de trabajo, inspeccionarlos y descubrir
  nuevos sin hardcodear el universo de grupos.

### 👀 Ver lo que pasó alrededor de un mensaje

- Consultar entrega, leído, reproducido y receipts por participante para
  mensajes propios; sin convertir la falta de un receipt en una conclusión.
- Ver reacciones actuales, encuestas y votos observables, respuestas
  interactivas, ubicaciones, contactos, llamadas perdidas y eventos de grupo.
- Listar URLs HTTP(S) como hechos estructurales con mensaje, autor, hora e ID;
  la IA las abre con su propia herramienta web, sin que el bridge scrapee ni
  clasifique destinos.
- Conservar el estado actual de mensajes editados, efímeros o revocados dentro
  de la ventana reciente.

### 📎 Trabajar con los adjuntos, no sólo con el texto

- Listar y descargar selectivamente audios, imágenes, videos, stickers y
  documentos. El resultado es un path local que cualquier IA puede abrir con
  su herramienta visual o documental.
- Transcribir audios localmente con un runtime Python privado y reutilizar un
  modelo Whisper ya descargado cuando existe.
- No asumir que una imagen o un PDF es texto: el bridge entrega el archivo y
  deja su interpretación al runtime que lo invoca.

### ✉️ Actuar cuando vos lo indicás

- Enviar texto, documentos, imágenes, videos, audios y notas de voz.
- Responder citando exactamente un mensaje o reaccionar al último entrante
  **confirmado**.
- Mencionar participantes explícitos en grupos.
- Nada se envía por iniciativa del bridge: cada `send`, `reply` o `react`
  requiere una instrucción explícita.

### 🧱 Dejarlo funcionando una vez

- Escaneás un QR una vez; el servicio se reconecta luego de reinicios de macOS
  o Linux/VPS sin un navegador.
- En onboarding elegís 7 días (default) o una ventana mayor; el CLI explica
  que pedir full-history a WhatsApp no garantiza que el proveedor lo entregue.
- Funciona como LaunchAgent en macOS o servicio `systemd --user` en Linux.
- La sesión y SQLite sobreviven actualizaciones de Homebrew; `wa doctor` y
  `wa status` muestran qué falta sin revelar chats ni secretos.

## 🎯 Ejemplos que justifican tenerlo siempre activo

| Si necesitás… | El agente puede hacer… |
| --- | --- |
| **No perder un follow-up** | Leer los últimos mensajes de una persona o de un conjunto de grupos, con hora, autor y adjuntos reales. |
| **Responder con precisión** | Verificar cobertura, leer el último entrante y ejecutar un `reply` que cita ese mensaje —no uno anterior. |
| **Entender un audio o una foto** | Descargar el adjunto puntual, abrirlo con la capacidad disponible y transcribirlo localmente si es audio. |
| **Saber qué pasó en un grupo** | Consultar reacciones, receipts de tus mensajes, votos, participantes y eventos de grupo que WhatsApp haya reportado. |
| **Compartir una entrega** | Enviar un PDF, imagen, video o audio por WhatsApp desde una ruta local con un mensaje explícito. |

## 🤖 Guía rápida para una IA

La interfaz está diseñada para que un agente no tenga que conocer Baileys ni
adivinar el estado de WhatsApp. El recorrido seguro es:

```bash
# 1. Resolver la persona y comprobar que el mirror está actualizado
wa find "Nombre"
wa coverage contacto

# 2. Leer hechos recientes, con IDs para cualquier acción posterior
wa latest-incoming contacto --ids
wa history contacto 20 --ids

# 3. Sólo ante una instrucción explícita: actuar sobre el ID confirmado
wa reply contacto <message-id> "Mensaje pedido por el usuario"
```

Para límites temporales, receipts, reacciones y datos que no pueden
reconstruirse del pasado, ejecutar siempre `wa help data` antes de inferir algo.
Para la instalación y recuperación completa, seguir
[`docs/onboarding-and-recovery.md`](docs/onboarding-and-recovery.md).

## 🚀 Instalación rápida

### 🍺 macOS con Homebrew (recomendada)

```bash
brew tap diegomarvid/tap
brew install whatsapp-assistant
wa setup
```

`wa setup` instala y arranca un LaunchAgent local, y abre la imagen QR sólo si
la cuenta todavía no está vinculada. Antes de iniciar el bridge, pregunta
cuántos días querés conservar: **7** es el default. Si elegís más, solicita
full-history a WhatsApp con perfil desktop y guarda esa preferencia privada. La
solicitud puede tardar, consumir más disco y WhatsApp puede entregar menos —o
fallar el sync—; no se borra la sesión para cambiarla. Después del vínculo
inicial, el servicio se reconecta automáticamente al iniciar sesión en macOS.

Si ya usabas el checkout de este repositorio, migrá primero el estado privado
para conservar la sesión y el mirror sin escanear otro QR:

```bash
wa migrate-state ~/Documents/whatsapp-assistant
wa setup
```

El estado instalado queda en `~/Library/Application Support/WhatsApp Assistant/`:
ahí viven `auth/`, SQLite, aliases, token y logs. Homebrew puede actualizar o
desinstalar el código sin borrar conversaciones recientes ni credenciales.

### 🗓️ Elegir la ventana de historial

La retención local y el pedido de historial a WhatsApp son explícitos y quedan
en un archivo privado. En una terminal interactiva `wa setup` pregunta la
ventana; para una IA o instalación no interactiva, el default seguro es siete
días.

```bash
wa history-policy show       # ver política activa y qué solicitó al proveedor
wa history-policy set 30     # conservar 30 días y pedir full-history
wa history-policy set 365    # un año, si WhatsApp lo entrega
wa history-policy set all    # hasta 10 años locales; puede ser pesado
wa daemon restart            # aplica un cambio a una sesión ya instalada
```

Más de siete días activa `syncFullHistory` y un perfil desktop de Baileys, que
es un **pedido** al proveedor, no una garantía ni un bypass de WhatsApp. Si el
vínculo o sync extendido falla, volver a `wa history-policy set 7`, reiniciar el
daemon y conservar `auth/`; no hace falta borrar estado ni escanear un QR de
nuevo salvo que WhatsApp haya cerrado la sesión.

Si una persona o un agente necesita orientación dentro del propio CLI:

```bash
wa --help
wa help setup
wa help data
wa doctor
```

`wa setup` espera el arranque del bridge, abre el QR en macOS cuando WhatsApp
necesita vincular un dispositivo y deja como verificación final `wa status`.
`wa doctor` muestra rutas, estado del daemon, presencia de SQLite/auth y si hay
un QR pendiente; nunca muestra credenciales ni contenido de chats.

### 🐧 Linux / VPS con systemd

Requiere Node.js 22+ y una distribución con systemd. No requiere navegador ni
interfaz gráfica. Usá un usuario normal del VPS —no `root` ni `sudo wa`— para
que el servicio, QR y sesión privada pertenezcan al mismo usuario. Si todavía
no tenés Node, la ruta recomendada evita permisos globales de npm instalándolo
con `nvm` para el mismo usuario que va a vincular WhatsApp:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. "$HOME/.nvm/nvm.sh"
nvm install 22
```

Abrí una shell nueva si el instalador lo indica y confirmá antes de seguir:

```bash
node --version # v22 o superior
```

Después instalá el paquete público desde npm:

```bash
npm install -g @diegomarvid/whatsapp-assistant
wa setup
```

`wa setup` crea un servicio de usuario de systemd en
`~/.config/systemd/user/whatsapp-assistant.service`, conserva el estado privado
en `~/.local/state/whatsapp-assistant/` (o `WA_STATE_DIR`) e imprime el QR
directamente en la terminal SSH, además de guardar una imagen privada. Para que
el observer siga vivo al cerrar la sesión SSH o reiniciar el VPS, habilitá
linger una sola vez con permisos de administrador:

```bash
sudo loginctl enable-linger "$USER"
```

`wa setup` detecta si no hay un `systemd --user` utilizable o si Node es
demasiado viejo y devuelve una instrucción accionable antes de crear estado
parcial. Al finalizar, `wa doctor` no dice `ready` mientras falte `linger`.

Verificá el servicio sin exponer la cuenta:

```bash
wa doctor
wa daemon status
wa status
```

Esto asume una distro con systemd. En un contenedor o distro sin systemd, el
bridge sigue funcionando con `npm start`, pero hay que ejecutarlo bajo el
supervisor propio del entorno.

### 🛠 Desarrollo desde checkout (opcional)

Para contribuir o correr el bridge desde el repositorio en vez de instalar el
paquete, necesitás Node.js **22 o superior**. La búsqueda opcional en Contactos
es una mejora exclusiva de macOS.

```bash
git clone https://github.com/diegomarvid/whatsapp-assistant.git
cd whatsapp-assistant
npm install
npm link
npm start
```

En el primer arranque aparece un QR. En WhatsApp móvil: **Ajustes →
Dispositivos vinculados → Vincular un dispositivo**. Escanealo una sola vez.
Después, conservar `auth/` permite reconectar tras reiniciar la Mac sin volver a
escanear.

En un checkout de desarrollo, el estado se conserva en `auth/` y `data/` del
proyecto para compatibilidad. En la instalación Homebrew queda fuera del
paquete. En ambos casos, el token, las credenciales y el mirror privado están
excluidos de Git.

> [!IMPORTANT]
> Antes de tocar una sesión, pedir un QR o modificar sincronización, leer
> [`docs/onboarding-and-recovery.md`](docs/onboarding-and-recovery.md). El modo
> normal es **sync reciente**, no un archivo histórico completo.

### 🕰️ Qué se puede saber y desde cuándo

El CLI lo explica también con `wa help data`, pensado para que una persona o una
IA conozca el límite antes de interpretar una salida.

| Dato | De antes de instalar | Desde que el bridge está activo |
| --- | --- | --- |
| Texto, hora, remitente, citas y adjuntos | Sí, sólo si WhatsApp lo incluyó en el sync y sigue dentro de la ventana local configurada. | Sí, mientras WhatsApp lo entregue. |
| Edición y contenido efímero | Puede verse el estado actual que llegó en el sync; no la versión original ni la secuencia anterior. | Se registran los cambios recibidos. |
| Reacciones, entregas y vistos | Sólo si ese dato vino incluido en el mensaje sincronizado; no se promete para mensajes pasados. | Se registran las actualizaciones que WhatsApp reporte. |
| Votos de encuestas | No se pueden reconstruir si no se observó la clave local y el voto. | Sí, cuando se observan creación y actualización. |
| Llamadas perdidas y eventos de grupo | No se reconstruyen retroactivamente. | Sí, cuando WhatsApp los entrega al observer. |

Nunca se obtiene un historial completo ni se interpreta la falta de un *read
receipt* como “no lo vio” o “me está ignorando”. Los receipts individuales de
un grupo sólo aplican a mensajes propios. Los mensajes *view once* no se
exponen ni descargan. Antes de responder sobre “el último” mensaje, la IA debe
consultar `wa coverage contacto`; `fresh` confirma cobertura reciente, no una
prueba de que WhatsApp haya emitido cada señal de interacción posible.

### 🎧 Transcripción local (opcional)

El bridge funciona sin Whisper. La transcripción se instala aparte, pero queda
encapsulada en un venv privado del CLI: no modifica el Python global ni depende
de `ct`.

```bash
wa transcribe doctor       # inspecciona runtime y modelos locales; no descarga
wa transcribe setup        # opcional: instala anticipadamente la librería Python adecuada
wa transcribe pull         # descarga un modelo, explícitamente
wa transcribe flor latest
```

Al pedir una transcripción por primera vez, el CLI crea ese runtime privado
automáticamente. Nunca baja un modelo de forma implícita: si
no encuentra uno local, termina con una instrucción para que la IA pida
aprobación antes de ejecutar `wa transcribe pull`.

En Apple Silicon usa `mlx-whisper`; en Linux y Macs Intel usa
`faster-whisper`. Ambos backends usan el cache estándar de Hugging Face. Antes
de descargar, el CLI busca un snapshot compatible ya presente allí —por ejemplo
un `mlx-community/whisper-large-v3-turbo` existente— y le pasa su path local al
backend, sin pedir ni bajar el modelo de nuevo.

Si no hay modelo, `wa transcribe doctor` devuelve el modelo sugerido y el
comando exacto, pero **no descarga nada por sí mismo**. La IA debe consultar al
usuario si prefiere descargarlo o indicar una carpeta local existente:

```bash
wa transcribe config model-path /ruta/al/modelo
wa transcribe config model mlx-community/whisper-large-v3-turbo
wa transcribe pull mlx-community/whisper-large-v3-turbo
```

En macOS, `mlx-whisper` necesita `ffmpeg` disponible; instalalo con `brew
install ffmpeg` si hiciera falta. `faster-whisper` en Linux usa su runtime
Python aislado.

## 🧭 Uso diario

```bash
wa status
wa find "Florencia"
wa latest-incoming Florencia --ids
wa history Florencia 20 --ids
```

Guardá una relación estable entre un nombre y un teléfono como alias privado:

```bash
wa alias add flor +598XXXXXXXX "Florencia Ferrario"
wa latest-incoming flor
```

Los aliases viven en `data/aliases.json`, fuera de Git. `wa find` también puede
usar nombres sincronizados por WhatsApp, mensajes recientes y, en macOS,
Contactos como complemento. No copia la agenda al mirror.

## ⌨️ Comandos

### Consultar chats y cobertura

| Comando | Para qué sirve |
| --- | --- |
| `wa status` | Estado del bridge y cantidad de mensajes cacheados. |
| `wa doctor` | Diagnóstico sin secretos: daemon, rutas privadas, SQLite, QR y health. |
| `wa qr` | Abre el QR en macOS o lo imprime en la terminal (ideal por SSH). |
| `wa find "Nombre"` | Busca aliases, identidad WhatsApp, mensajes recientes y Contactos de macOS opcionales. |
| `wa recent 20` | Chats individuales recientes con identidad WhatsApp. |
| `wa latest contacto` | Último evento del chat, entrante o saliente. |
| `wa latest-incoming contacto` | Último mensaje **recibido** de ese contacto. |
| `wa history contacto 20 --ids` | Últimos mensajes, con IDs para descargar, responder o reaccionar. |
| `wa coverage contacto` | Indica si el chat está sincronizado (`fresh`) o si hay un hueco verificable. |
| `wa help data` | Explica qué hechos recientes pueden venir del sync y qué eventos sólo se conocen desde que el bridge los observó. |
| `wa message contacto <message-id>` | Hechos completos del evento: hora, autor, adjuntos, estado, reactions y receipts que el mirror haya recibido. |
| `wa delivery contacto <message-id>` | Estado agregado de un mensaje propio en un chat directo (`enviado`, `entregado`, `leído` o `reproducido`) y su timestamp reportado por WhatsApp. |
| `wa receipts grupo <message-id>` | Receipts individuales reportados por WhatsApp para **un mensaje propio** de grupo: entregado, leído o reproducido por participante. |
| `wa unread-by grupo <message-id>` | Para un mensaje propio, participantes actuales sin **read receipt reportado**. No los llama “no leídos”. |
| `wa reactions contacto-o-grupo <message-id>` | Reacciones actuales al mensaje, participante, emoji y hora si WhatsApp la reportó. |
| `wa polls contacto` / `wa poll contacto <message-id>` | Encuestas observadas y sus votos descifrables, agrupados por opción y participante. |
| `wa calls contacto` | Eventos de llamada que WhatsApp entregó mientras el bridge estaba activo, más mensajes de llamada perdida cuando existan. |
| `wa links contacto` | URLs HTTP(S) literales del chat, con ID, autor, hora y cobertura del mirror; no abre ni resume destinos. |
| `wa group-events grupo` | Cambios de participantes y metadatos de grupo observados por el bridge. |
| `wa search contacto "presupuesto"` | Busca texto dentro de un chat. |
| `wa search-all "Oracle" --since 7d` | Busca texto en todos los chats recientes. |

> `latest` incluye tus propios mensajes; para “¿qué me mandó X?”, usar siempre
> `latest-incoming`. Ambos exigen cobertura reciente antes de responder.
> El CLI no clasifica saludos, urgencia ni “pendientes”: expone eventos y la IA
> decide su significado, en cualquier idioma.
>
> Un participante sin read receipt no es evidencia de que no haya visto el
> mensaje. WhatsApp puede omitirlo por privacidad, conectividad o porque el
> bridge todavía no recibió el evento. La salida usa deliberadamente
> `withoutReportedReadReceipt` para reflejar ese límite.
>
> Los mensajes editados, efímeros y respuestas interactivas se representan como
> tales. Un mensaje revocado se marca como eliminado y se purgan sus adjuntos
> locales. Los mensajes *view once* no se abren ni descargan deliberadamente.
>
> Cada mensaje nuevo también preserva hechos de contexto: mensaje citado
> (sin revelar contenido *view once*), menciones, si fue reenviado, preview
> local de un link (URL/título/descripción) y metadatos de media como tamaño,
> dimensiones, duración, nota de voz, GIF y páginas de documento. No son
> resúmenes generados por IA.

### 👥 Grupos de trabajo

| Comando | Para qué sirve |
| --- | --- |
| `wa groups find maspeak` | Muestra grupos ya confirmados y propone candidatos recientes. |
| `wa groups inspect <jid>` | Lee título, descripción y mensajes recientes antes de clasificar. |
| `wa groups add maspeak <jid>` | Guarda un grupo confirmado en la lista privada. |
| `wa groups participants <jid>` | Lista participantes y rol de un grupo para poder mencionarlos explícitamente. |
| `wa coverage <grupo-jid>` | Verifica cobertura de un grupo usando su JID `…@g.us`. |

La lista está en `data/group-lists.json`, no en el código ni en Git. `find`
siempre vuelve a revisar los grupos actuales para poder descubrir nuevos.

### 📎 Media y mensajes estructurados

| Comando | Para qué sirve |
| --- | --- |
| `wa audios contacto` | Lista audios recientes y si su envelope está disponible. |
| `wa audio contacto <message-id>` | Descarga un audio seleccionado. |
| `wa transcribe setup` | Instala el backend Python aislado, sin descargar modelo. |
| `wa transcribe doctor` | Muestra backend, runtime y modelos locales compatibles. |
| `wa transcribe pull [modelo]` | Descarga explícitamente un modelo compatible. |
| `wa transcribe contacto latest` | Descarga el audio más reciente y lo transcribe localmente. |
| `wa transcribe contacto <message-id>` | Transcribe un audio concreto; el ID sale de `wa audios` o `wa history --ids`. |
| `wa images contacto` / `wa image contacto <message-id>` | Lista o descarga una imagen seleccionada. |
| `wa videos contacto` / `wa video contacto <message-id>` | Lista o descarga un video o GIF seleccionado. |
| `wa stickers contacto` / `wa sticker contacto <message-id>` | Lista o descarga un sticker seleccionado. |
| `wa files contacto` / `wa file contacto <message-id>` | Lista o descarga un documento entrante seleccionado. |
| `wa locations contacto` | Devuelve coordenadas y datos de ubicación como JSON factual. |
| `wa contacts contacto` | Devuelve tarjetas de contacto/vCard como JSON factual. |
| `wa polls contacto` | Devuelve pregunta y opciones de encuestas, sin inferir intención ni votos. |
| `wa message contacto <message-id>` | Devuelve el evento normalizado completo, incluidos los datos estructurados. |

El comando de transcripción correcto es `wa transcribe contacto latest` o
`wa transcribe contacto <message-id>`: no recibe un selector genérico
`<id|latest>` en la tabla porque el ID tiene que corresponder a un audio.

`wa image`, `wa video`, `wa sticker`, `wa file` y `wa audio` descargan sólo el adjunto seleccionado y
devuelven su **path absoluto privado**. La CLI no interpreta imágenes, PDFs ni
documentos: el agente que la invoca abre ese path con la capacidad visual o de
documentos que tenga disponible. Así no se asume que una imagen es texto ni se
acopla el bridge a un runtime concreto de IA.

### ✉️ Acciones explícitas

| Comando | Para qué sirve |
| --- | --- |
| `wa react contacto latest-incoming 👍` | Reacciona al último mensaje entrante confirmado. |
| `wa reply contacto latest-incoming "Entendido"` | Responde citando un mensaje concreto. |
| `wa send contacto "mensaje"` | Envía un texto. |
| `wa send-file contacto /ruta/resumen.pdf "mensaje"` | Envía un archivo como documento. |
| `wa send-image contacto /ruta/foto.jpg "caption"` | Envía una imagen nativa. |
| `wa send-video contacto /ruta/video.mp4 "caption"` | Envía un video nativo. |
| `wa send-audio contacto /ruta/audio.ogg --voice` | Envía audio; `--voice` lo marca como nota de voz. |
| `wa send grupo@g.us "Hola" --mention flor` | Envía texto y menciona contactos explícitos en un grupo. |

El bridge nunca envía, reacciona ni responde por su cuenta. `send`, `send-file`, `send-image`, `send-video`, `send-audio`,
`react` y `reply` requieren un comando explícito; las operaciones que usan
`latest` sólo se ejecutan si el mismo chat tiene cobertura `fresh`.

## 🏗️ Cómo se mantiene actualizado

WhatsApp puede representar el mismo contacto con un número telefónico (PN,
`…@s.whatsapp.net`) o un identificador privado de cuenta (LID, `…@lid`). Los
mensajes nuevos pueden llegar bajo el LID aunque un alias viejo señale al PN.

1. El observer de Baileys recibe eventos en tiempo real y persiste el batch en
   SQLite antes de que el CLI lo consulte.
2. Cuando se consulta un contacto directo, el CLI pide `/resolve`: el bridge
   traduce PN → LID actual usando el mapping de Baileys.
3. `coverage` comprueba conexión, salud del observer y cursor. Si no está
   `fresh`, el CLI no inventa un “último mensaje” ni actúa sobre uno viejo.
4. Una acción usa el JID y el message ID que salieron de esa misma lectura
   confirmada.

```mermaid
flowchart LR
  U["👤 Usuario / alias / teléfono"] --> C["⌨️ CLI wa"]
  C --> R["🔎 /resolve\nPN → LID actual"]
  R --> B["🔌 Bridge Baileys\n127.0.0.1"]
  B --> M[("🗄️ SQLite\nventana configurable\n7 días por default")]
  W["💬 WhatsApp Web events"] --> B
  C --> V{"✅ coverage\nfresh?"}
  M --> V
  V -->|"sí"| Q["latest / history /\nreply / react"]
  V -->|"no"| S["⛔ sin conclusión ni acción"]
```

Los grupos mantienen su JID `…@g.us` y no se remapean como contactos.

## 🔐 Privacidad y límites

- La API escucha solamente en `127.0.0.1`; todas las rutas salvo `/health`
  requieren el token local.
- El mirror conserva **siete días y hasta 10.000 mensajes** por default. Una
  persona puede ampliar la ventana con `wa history-policy`; eso solicita más
  historial a WhatsApp, pero nunca promete recuperar lo que el proveedor no
  entregue y puede usar bastante más disco.
- También guarda envelopes raw recientes para reintentos de Baileys, media
  seleccionada y un audit técnico sin texto. Nada se sube.
- El CLI no intenta detectar saludos, urgencia, intención ni “pendientes” por
  regex o palabras clave. La IA interpreta el contenido después de leer los
  hechos estructurales.

Para el detalle de qué estado es privado y queda excluido de Git, ver
[`docs/private-state.md`](docs/private-state.md).

## 🩺 Operación y recuperación

- `wa daemon status` muestra el servicio; `wa daemon restart` lo reinicia sin
  desvincular WhatsApp. `wa daemon uninstall` elimina sólo el servicio y deja
  intacto el estado privado.
- `wa setup` instala un LaunchAgent en macOS o un servicio `systemd --user` en
  Linux. En SSH imprime el QR en la terminal, sin navegador.
- Dejá el proceso/LaunchAgent corriendo para recibir los eventos nuevos.
- Si algo parece viejo, usar primero `wa status`, `wa coverage contacto` y
  `wa latest-incoming contacto`.
- Un reinicio normal con las credenciales existentes **no necesita QR**.
- Pedir o resetear la sesión es el último recurso: seguí el checklist completo
  en [`docs/onboarding-and-recovery.md`](docs/onboarding-and-recovery.md).

## 🔌 API local

Todas las rutas, salvo `GET /health`, requieren:

```text
Authorization: Bearer <contenido de data/bridge-token>
```

| Ruta | Uso |
| --- | --- |
| `GET /health` | Estado de conexión, sin token. |
| `GET /snapshot` | Vista reciente consistente del mirror. |
| `GET /resolve?jid=<jid>` | Resuelve un PN al LID vivo conocido por Baileys. |
| `GET /chats?limit=50` | Chats conocidos, más recientes primero. |
| `GET /messages?jid=<jid>&limit=50` | Mensajes sincronizados de un chat. |
| `GET /search?q=<texto>&limit=30` | Búsqueda local en mensajes recientes. |

---

Hecho para ser un asistente de contexto reciente: **local, verificable y sin
convertirse en un archivo de toda la cuenta**.
