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
| `wa find "Nombre del contacto"` | Busca un alias, contacto o chat cacheado |
| `wa latest contacto` | Último mensaje de ese chat |
| `wa history contacto 20` | Últimos 20 mensajes del chat |
| `wa search contacto "presupuesto"` | Busca texto dentro del chat |
| `wa transcribe contacto latest` | Descarga y transcribe el audio más reciente del chat |

Los aliases viven en `data/aliases.json`, que nunca entra a Git. El comando no
incluye ninguna capacidad de envío.

La separación exacta entre el código público y el estado privado está en
[`docs/private-state.md`](docs/private-state.md).

Los audios recientes se conservan como envelopes privados durante la misma
ventana de 30 días. El archivo de audio se descarga y transcribe únicamente al
pedirlo con el comando anterior.

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

No existe endpoint de envío. La API queda cerrada a loopback y es de lectura
solamente hasta que se decida, explícitamente, agregar un flujo de aprobación.

## Notas operativas

- Dejá este proceso corriendo para recibir mensajes nuevos.
- Para desvincularlo: WhatsApp → Dispositivos vinculados → cerrar sesión del
  dispositivo. Luego se puede borrar `auth/` localmente.
- `data/messages.json` guarda mensajes recientes de hasta 30 días, con un tope
  de 10.000, para búsquedas. Contiene texto de chats, por lo que el directorio
  tiene permisos privados. WhatsApp define el detalle exacto de la
  sincronización reciente; el asistente no solicita una copia del historial
  completo.
