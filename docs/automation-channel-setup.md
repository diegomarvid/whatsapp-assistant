# Configuración explícita de canales por automatización

La elección pertenece a **cada automatización y usuario operador**, no a todo el
bot. Dos automatizaciones pueden usar el mismo bot con destinos diferentes.

## Etapa obligatoria de configuración

Antes de activar una automatización, registrar estas decisiones con el dueño:

1. ¿Requiere revisión de borradores? Si no, guardar revisión desactivada. Si sí,
   ¿a qué grupo o privado de Telegram van y quién puede responder/aprobar?
2. ¿Usa consultas humanas? Si sí, ¿a qué grupo o privado van y quién puede
   responder? Un usuario debe iniciar el bot antes de recibir privados.
3. ¿Qué decisiones justifican consultar? Registrar criterios y ejemplos en el
   prompt ejecutor y las instrucciones de la política humana. Las pruebas o
   acciones técnicas de otro participante se coordinan en WhatsApp; no se usa
   al dueño como intermediario por Telegram.
4. Mostrar un resumen: nombre de regla, operador, bot, ambos destinos (nombre,
   tipo e ID), canales desactivados, personas autorizadas, modelo y timeout.
   No inferir que revisión y ayuda deben compartir destino.

Esto es el procedimiento de configuración para el operador/agente; todavía no
hay un asistente interactivo que haga estas preguntas automáticamente.

## Guardar y consultar con el adaptador Maspeak

El cliente de transporte `ops/drafts/client.py` del servicio Maspeak ofrece:

```sh
python3 /ruta/ops/drafts/client.py routing-set --automation NOMBRE_EXACTO \
  --draft-chat ID_TELEGRAM_BORRADORES --help-chat ID_TELEGRAM_AYUDA --json
python3 /ruta/ops/drafts/client.py routing-show --automation NOMBRE_EXACTO --json
```

Ambos destinos son obligatorios al guardar, aunque un canal esté desactivado en
la regla; guardar un destino no activa revisión ni consultas. Los IDs positivos
son privados y los negativos grupos. Usar identidades verificadas, no inventadas.
La salida distingue `explicit` de `legacy_default`: este último es compatibilidad
con instalaciones previas, no una elección explícita para nuevas configuraciones.

La ruta se guarda en la base privada del servicio Telegram, tabla `settings`,
claves `draft_routes` y `dialogue_routes`, indexadas por usuario Linux autenticado
y nombre exacto de automatización. En la instalación estándar la base es
`/var/lib/maspeak-drafts/queue.sqlite3`; el servidor puede configurar otra ruta.
El cliente de macOS usa SSH: el operador es el usuario remoto, no el usuario Mac.
No editar SQLite manualmente para configurar destinos.

La regla WhatsApp guarda por separado las políticas de revisión y ayuda:
`wa automation prompt show NOMBRE` permite inspeccionarlas. Sus `reviewers` y
`responders` definen quién puede decidir; el chat de destino no sustituye esos
controles. Los archivos de políticas/adaptadores deben ser privados, fuera del
repo. No versionar IDs personales, tokens ni credenciales.

Los mensajes de seguimiento y revisiones conservan el chat original del trabajo.
Cambiar rutas afecta nuevos trabajos, no traslada conversaciones pendientes.
Resolver o cancelar pendientes conscientemente antes de cambiar destinos; nunca
republicar automáticamente consultas viejas ni ignorar respuestas pendientes.

## Verificación antes de activar

- Consultar `routing-show` y comprobar ambos destinos explícitos.
- Validar políticas y transporte con `human-policy check/status` y el equivalente
  de revisión; confirmar el bot y que el polling esté sano.
- Verificar un envío autorizado al destino elegido y una respuesta real con
  `wa automation human test`. Distinguir envío confirmado de reanudación probada.
- Guardar el resumen operativo privado y la fecha de verificación. Conservar
  decisiones existentes; no cambiar todas las automatizaciones a un mismo chat.

Ver [consultas humanas](human-consultations.md) para la reanudación y
[revisión de borradores](draft-review.md) para aprobación de mensajes.
