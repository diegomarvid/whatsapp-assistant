# WhatsApp Bridge

Puente local de solo lectura entre WhatsApp Web y una API HTTP que escucha
**únicamente** en `127.0.0.1`. Usa Baileys; no es una integración oficial de
WhatsApp.

## Arranque

```bash
cd /Users/diegomarvid/Documents/whatsapp-bridge
npm install
npm start
```

En el primer arranque aparece un QR en esta terminal. En WhatsApp móvil:
**Ajustes → Dispositivos vinculados → Vincular un dispositivo**. Escanealo.

La primera vez también se crea un token local en `data/bridge-token`. Tanto
ese token como las credenciales de WhatsApp están excluidos de Git.

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
- `data/messages.json` guarda una caché local limitada a 3.000 mensajes para
  búsquedas; contiene texto de chats, por lo que el directorio tiene permisos
  privados.
