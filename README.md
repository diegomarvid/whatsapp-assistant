# 💬 WhatsApp Assistant

> Un bridge local de WhatsApp con Baileys y un CLI pensado para consultar el
> contexto **reciente y correcto** de una conversación.

WhatsApp Assistant mantiene un mirror privado de los últimos siete días y
expone un comando `wa` para leer, buscar, descargar adjuntos y —únicamente
cuando se pide en forma explícita— enviar, responder o reaccionar. No es una
integración oficial de WhatsApp y nunca abre una API a Internet.

![Arquitectura del bridge local](docs/assets/whatsapp-assistant-architecture.drawio.png)

## ✨ Qué resuelve

| | |
| --- | --- |
| 🔄 **Contexto reciente** | El bridge recibe eventos mientras está conectado y conserva sólo una ventana móvil de siete días. |
| 🎯 **Chat correcto** | Resuelve el número telefónico histórico al LID actual de WhatsApp antes de leer o actuar. |
| ✅ **Acciones seguras** | `latest`, reacciones y replies verifican cobertura `fresh`, para no operar sobre un mensaje viejo. |
| 🔒 **Local y privado** | API limitada a `127.0.0.1`; credenciales, cache y aliases nunca entran a Git. |
| 🧠 **Sin heurísticas de idioma** | El CLI presenta hechos; interpretar intención, urgencia o pendientes es trabajo de la IA. |

## 🚀 Instalación rápida

### 🍺 macOS con Homebrew (recomendada)

```bash
brew tap diegomarvid/tap
brew install whatsapp-assistant
wa setup
```

`wa setup` instala y arranca un LaunchAgent local, y abre la imagen QR sólo si
la cuenta todavía no está vinculada. Después del vínculo inicial, el servicio
se reconecta automáticamente al iniciar sesión en macOS.

Si ya usabas el checkout de este repositorio, migrá primero el estado privado
para conservar la sesión y el mirror sin escanear otro QR:

```bash
wa migrate-state ~/Documents/whatsapp-assistant
wa setup
```

El estado instalado queda en `~/Library/Application Support/WhatsApp Assistant/`:
ahí viven `auth/`, SQLite, aliases, token y logs. Homebrew puede actualizar o
desinstalar el código sin borrar conversaciones recientes ni credenciales.

Si una persona o un agente necesita orientación dentro del propio CLI:

```bash
wa --help
wa help setup
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

Después instalá el paquete desde un release:

```bash
npm install -g https://github.com/diegomarvid/whatsapp-assistant/archive/refs/tags/v0.6.1.tar.gz
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

### Requisitos base

- Node.js **22 o superior**.
- Una cuenta de WhatsApp para vincular una sola vez por QR.
- macOS o Linux con systemd si se quiere un servicio administrado. La búsqueda
  opcional en Contactos es una mejora exclusiva de macOS.

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
| `wa search contacto "presupuesto"` | Busca texto dentro de un chat. |
| `wa search-all "Oracle" --since 7d` | Busca texto en todos los chats recientes. |

> `latest` incluye tus propios mensajes; para “¿qué me mandó X?”, usar siempre
> `latest-incoming`. Ambos exigen cobertura reciente antes de responder.
> El CLI no clasifica saludos, urgencia ni “pendientes”: expone eventos y la IA
> decide su significado, en cualquier idioma.

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
| `wa delivery contacto <message-id>` | Muestra el último estado factual de un mensaje propio: enviado, entregado, leído o reproducido. |

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
  B --> M[("🗄️ SQLite\nventana móvil: 7 días")]
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
- El mirror conserva como máximo **siete días** y 10.000 mensajes: no es un
  backup ni pretende pedir el historial completo.
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
