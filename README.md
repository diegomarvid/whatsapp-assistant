# WhatsApp Assistant

Asistente local de WhatsApp: un bridge de solo lectura basado en Baileys y un
CLI para consultar chats por alias. La API escucha **únicamente** en
`127.0.0.1`; no es una integración oficial de WhatsApp.

## Arranque

```bash
cd /Users/diegomarvid/Documents/whatsapp-assistant
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
| `wa alias add tommy +59892869665 "Tomi Wajner"` | Guarda un alias privado |
| `wa aliases` | Lista aliases conocidos |
| `wa find "Tomi Wajner"` | Busca un alias, contacto o chat cacheado |
| `wa latest tommy` | Último mensaje de ese chat |
| `wa history tommy 20` | Últimos 20 mensajes del chat |
| `wa search tommy "presupuesto"` | Busca texto dentro del chat |

Los aliases viven en `data/aliases.json`, que nunca entra a Git. El comando no
incluye ninguna capacidad de envío.

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
