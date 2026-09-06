# Conversaciones autónomas

Para retomar el proyecto, empezar por la [guía técnica y estado del piloto](automation-handoff.md).
El código actual es 0.10.1; las reglas de prueba/soporte están pausadas al
2026-09-06. Las secciones de validación inicial de este documento conservan el
historial de la implementación v2; no describen la última ejecución del piloto.

Para revisión humana de borradores y disparos desde cualquier integración, ver
[el patrón general de drafts](draft-review.md). Esa extensión usa schema v3 y
conserva las reglas v1/v2 sin revisión. Los comandos del piloto siguen vigentes.

Diseño inicial de conversaciones: versión 0.10.0, 2026-09-06. El piloto del grupo
se preparó sin procesar retrospectivamente el chat.

## Contrato

- Eventos de Baileys → cola durable → espera deslizante con máximo → juez opcional
  → agente → comprobación de permisos/estado antes de enviar.
- Sin novedades no se invoca un modelo. El barrido local recupera pendientes;
  no consiste en pedirle periódicamente a una IA que relea WhatsApp.
- Juez: `ai`, `human` o `none`, registrado mediante una herramienta explícita.
  No dispone de permisos de envío ni workspace. Su salida narrativa es auditoría.
- Agente: usa `wa` directamente. Registra un resultado y resumen durable. Una
  ejecución exitosa del proceso no demuestra que haya enviado o resuelto nada.
- Modo observación: la comprobación del servidor impide enviar; no se ejecutan
  agentes con workspace en este modo.
- Intervención humana y pausa: invalidan el permiso de envío de la corrida en
  curso. Un envío ya entregado al transporte no puede retirarse con una pausa.
- Mensajes durante una corrida: invalidan su respuesta preparada y quedan
  pendientes para el siguiente análisis. Se preserva el informe del trabajo.
- Identificadores de mensajes de la propia automatización se registran antes
  del transporte y nunca vuelven a disparar reglas.
- Trabajos serializados por conversación y workspace; concurrencia acotada
  entre conversaciones independientes. Reinicios no repiten efectos inciertos.
- El grupo piloto responde todos los temas, en ambas direcciones; la pausa
  por mensajes propios se desactiva ahí porque Diego también lo prueba.

## Investigación de la versión anterior

Verificado con `wa automation prompt show ines-nelcor-platform` el 2026-09-06:
9 procesos terminados y 7 inciertos en la ventana retenida. Seis inciertos
reportaban timeout y uno un límite 429 del proveedor. El perfil tenía 60.000 ms
para leer el pedido, investigar, editar, verificar y desplegar. Esto explica
interrupciones observadas, pero no prueba que las otras corridas hayan arreglado
algo o enviado mensajes. La v2 muestra decisiones, resultados y envíos
por separado; no se reejecutan esas corridas históricas.

La inspección posterior de las nueve salidas terminadas encontró decisiones de
no actuar por las exclusiones del prompt: sólo atendía ciertos errores y dejaba
fuera mejoras, reportes, correcciones de datos y pedidos ambiguos. La regla fue
creada el 2026-08-05 y quedó pausada el 2026-09-06. Esa fecha de creación no prueba
que haya funcionado continuamente. Revisar criterios y timeout antes de otra
prueba; conservar los trabajos inciertos para inspección, sin reejecutarlos.

## Validación inicial de v2

Validación local: 175 tests pasan, incluyendo agrupación, juez, observación,
intervención, origen de mensajes, envíos idempotentes, recuperación, concurrencia
y CLI; `npm run check` pasa. Codex real validado en prueba neutra y en preview contra el grupo real: cobertura
fresca, contexto leído, propuesta registrada, estado `observed` y cero envíos.
En ese punto, la entrega real en el grupo todavía no se había validado. Para
resultados posteriores, ver [la guía de continuidad](automation-handoff.md#prueba-real-del-chat-directo).

La prueba contra el bridge real detectó además una conversión incorrecta del JID
numérico de grupos a un JID telefónico al crear reglas. Se corrigió y se agregó
una regresión de CLI; los JIDs de grupos se conservan íntegros.

## Configuración y comandos

Los perfiles fijan proveedor, modelo, prompt (por ruta y huella), timeout y
workspace opcional. No eligen contactos. Las reglas fijan origen/destino,
dirección, tiempos, modo, juez y control humano. La cola contiene trabajos;
no son tareas programadas de la app de Codex.

Desde el repositorio, copiar el prompt editable a una ruta privada y crear el
perfil. Los nombres/modelos del ejemplo son configuración explícita, no una
lista cerrada de modelos:

```sh
mkdir -p "$HOME/.config/whatsapp-automations"
cp docs/prompts/ai-group.md "$HOME/.config/whatsapp-automations/ai-group.md"
chmod 600 "$HOME/.config/whatsapp-automations/ai-group.md"
wa agents profile set cli-cli-v2 --provider codex --model gpt-5.6-sol \
  --reasoning-effort medium --timeout-ms 180000 \
  --prompt-file "$HOME/.config/whatsapp-automations/ai-group.md"
wa agents doctor cli-cli-v2
wa agents validate cli-cli-v2
```

`doctor` sólo inspecciona binarios/flags/prompts. `validate` invoca el proveedor
con un mensaje neutro sin WhatsApp. Ninguno prueba por sí solo la automatización.
Los perfiles existentes retienen su configuración; subir un timeout requiere
editar ese perfil expresamente. Para trabajo de código, usar un checkout aislado
como `--workspace` y un timeout apropiado: `0` sin corte por reloj o un límite
finito de hasta 3.600.000 ms. Nunca compartir
un checkout con cambios manuales para probar despliegues desatendidos.

### Piloto CLI CLI

El usuario indicó que este grupo es exclusivamente para IA: se atienden todos
los temas y mensajes tanto entrantes como propios. No hay juez ni pausa por
mensajes del dueño. El prompt de este piloto permite conversar y responder,
pero no modificar proyectos, infraestructura o cuentas.

Resolver el JID real con `wa groups find cli`, verificar título/participantes
con `wa groups inspect <jid>` y `wa groups participants <jid>`, y comprobar
`wa coverage <jid>`. No publicar números/JIDs privados en el repositorio.

```sh
# Asignar GROUP_JID al identificador que acabás de verificar.
wa automation prompt add cli-cli-v2 \
  --from "$GROUP_JID" --to "$GROUP_JID" --profile cli-cli-v2 --any \
  --debounce 15 --max-wait 60 --max-batch 100 --max-replies-hour 20 \
  --human-takeover off --mode live --paused --yes
wa automation prompt show cli-cli-v2 --json
```

La regla queda preparada y pausada. Antes de activarla se puede ejecutar una
observación real sobre IDs existentes del mismo grupo:

```sh
wa history "$GROUP_JID" 10 --ids
wa automation prompt preview cli-cli-v2 --ids ID_1,ID_2
wa automation prompt show cli-cli-v2 --json
```

El preview fuerza observación aunque la regla esté en `live`, no otorga permisos
de envío, ignora el workspace del ejecutor y no cambia el control humano. Una
regla pausada puede ejecutar previews expresamente pedidos. La evidencia esperada
es `observed`, un `report.summary` con la propuesta y ningún registro `outbound`.

Para empezar la prueba real:

```sh
wa automation prompt resume cli-cli-v2
# Escribir en el grupo, esperar al menos 15 segundos de silencio + generación.
wa automation prompt show cli-cli-v2 --json
wa delivery "$GROUP_JID" ID_DE_RESPUESTA
wa receipts "$GROUP_JID" ID_DE_RESPUESTA
wa automation prompt pause cli-cli-v2
```

Casos de UAT: un saludo, una consulta, tres mensajes seguidos y una captura;
una corrección durante la generación; una pausa antes del envío; un mensaje
propio para confirmar `--any`. La respuesta de la automatización no debe iniciar
otra corrida. Si el otro participante usa un bot, el límite de 20 envíos/hora
pone esta regla bajo control humano para cortar un intercambio infinito.

### Chats que combinan IA y humano

Crear un perfil sin workspace con `docs/prompts/platform-judge.md` y pasar
`--judge nombre-del-perfil`. La regla puede empezar con `--mode observe`.
Después de revisar sus decisiones:

```sh
wa automation prompt mode soporte live --yes
wa automation prompt human soporte
wa automation prompt release soporte
wa automation prompt pause soporte
wa automation prompt resume soporte
```

`human` frena los envíos y deja los nuevos pedidos para revisión. `release`
acepta mensajes futuros; no reenvía automáticamente pedidos que fueron dejados
para una persona. Rechaza la liberación si hay trabajos inciertos sin revisar.
`pause` cancela trabajos aún no iniciados e invalida envíos de los que están en
curso; el worker los interrumpe en el siguiente barrido (hasta aproximadamente un
segundo). Si había trabajo de código o un envío iniciado, queda incierto y exige
revisión antes de continuar. Una operación externa ya iniciada no se deshace. `resume` conserva el
modo configurado y tampoco elimina un control humano pendiente.

### Contrato de las herramientas del agente

```sh
wa automation context
wa automation decision ai --reason "Pedido técnico dentro del alcance"
wa automation result resolved --summary "Qué se verificó, qué se respondió y qué queda pendiente"
wa automation result no_reply --summary "Por qué no correspondía responder"
wa automation result needs_human --summary "Qué decisión o dato humano falta"
wa automation result waiting --summary "Qué operación ya empezó y cómo consultar su resultado" --resume-after 60
```

La decisión sólo la puede registrar el juez activo y el resultado el ejecutor
activo, una vez por etapa. No contienen un texto que el servidor convierta en
envío. Se envía sólo con `wa send`, bajo el permiso efímero y las comprobaciones
de la regla. Después de registrar un resultado ya no se permite enviar.

`waiting` guarda un resumen y continúa por tiempo sin exigir un nuevo mensaje.
No sirve para repetir efectos cuyo resultado se desconoce. Un mensaje nuevo
reemplaza esa espera y el siguiente trabajo recibe el resumen anterior. Hasta
tres trabajos independientes pueden correr; el mismo chat o workspaces
superpuestos se serializan. El máximo de agrupación no garantiza latencia si
el proveedor está caído o un trabajo anterior sigue ocupando ese chat.

## Auditoría y recuperación

`show --json` devuelve regla, trabajos y registros de envío. Los textos de
prompts, auditorías y conversaciones son privados; no commitear `data/`.

| Estado | Significado |
| --- | --- |
| `pending` | Agrupando o listo para una etapa siguiente. |
| `judging` / `running` | Proveedor ejecutándose; permisos ligados a esa corrida. |
| `waiting` | Continuación solicitada para una hora concreta. |
| `observed` | Simulación sin envío; ver propuesta en el resumen. |
| `ignored` | El juez decidió que no requiere intervención. |
| `human` | Requiere intervención; no responde automáticamente. |
| `completed` | Proceso finalizó y registró resultado; mirar resultado y envíos. |
| `failed` | Etapa fallida sin efectos externos conocidos; revisar diagnóstico. |
| `superseded` | Novedades o intervención invalidaron la respuesta anterior. |
| `canceled` | Trabajo cancelado; con revisión también puede ocurrir después de generar el borrador, por decisión humana o vencimiento. |
| `uncertain` | Hubo posible trabajo/envío cuyo resultado no está confirmado. |

Los registros antiguos `completed` sólo significaban proceso terminado: no hay
que inferir envíos ni arreglos a partir de ellos. Los nuevos `outbound` tienen ID
reservado antes del transporte, estado y timestamps. `accepted` confirma que el
transporte devolvió ese ID; entrega y lectura se verifican con `delivery` y
`receipts`. Un error de transporte conserva el intento como incierto, incluso
si el agente intenta cambiar el texto. No se promete entrega exactamente una vez.

Ante un fallo sin efectos se puede usar `wa automation prompt retry <batch> --yes`.
Los previews siguen siendo observación al reintentarlos. Un lote incierto nunca
se reintenta automáticamente ni con ese comando. Primero inspeccionar el chat,
IDs de envío, el workspace y cualquier operación externa iniciada. Después:

```sh
wa automation prompt review ID_DE_LOTE --summary "Evidencia concreta de qué ocurrió y qué queda pendiente"
wa automation prompt release NOMBRE_DE_REGLA
```

La revisión registra evidencia, conserva el estado `uncertain` histórico y
libera su bloqueo de workspace. No deshace cambios ni entrega un mensaje.
Un trabajo de código incierto también bloquea otras reglas sobre el mismo
workspace hasta que se revise. `release` sólo habilita pedidos nuevos.

Al reiniciar: los trabajos pendientes/esperando se conservan; jueces interrumpidos
quedan fallidos y ejecutores interrumpidos quedan inciertos, con control humano.
El cierre normal detiene los procesos del proveedor. Tras una terminación forzada
hay que comprobar también procesos huérfanos antes de liberar un workspace.

El barrido de reparación corre cada minuto, sin IA: encuentra mensajes `live`
que ya están en el mirror pero no entraron a la cola, con deduplicación por ID.
No descubre mensajes ausentes de WhatsApp ni garantiza reconstruir un historial
faltante. Los trabajos sólo arrancan con conexión y cobertura fresca. El envío
vuelve a comprobar esas condiciones. La migración fija un inicio de reparación
para evitar activar retrospectivamente conversaciones de la v1.

## Instalación y reversión

1. `npm run check` y `npm test` antes de instalar/reiniciar el daemon.
2. Copiar privadamente `data/prompt-automations.json` y `data/agent-profiles.json`
   del estado activo a `data/backups/`. No copiar ni borrar `auth/`.
3. Empaquetar e instalar con `npm pack` / `npm install -g <tarball>`; conservar
   el estado activo fuera del paquete. `wa daemon restart` y `wa doctor` deben
   confirmar la sesión existente, sin un nuevo QR.
4. Verificar `wa --version`, `wa status`, `wa coverage <grupo>` y la regla.
5. Antes de volver a una versión anterior, pausar automatizaciones y revisar
   cualquier envío o trabajo posterior al backup. Versiones previas al motor de
   revisión no entienden schema v3; restaurar únicamente
   un snapshot revisado de reglas/perfiles, no auth ni el mirror. No reactivar
   una cola antigua que pueda repetir trabajo.

El lock identifica al proceso propietario y sólo se recupera cuando ese proceso
ya no existe. Una segunda exclusión serializa esa recuperación. Si un crash deja
un `.recovery` o un lock antiguo sin propietario, detener los escritores,
comprobar procesos y eliminar sólo ese lock; nunca resetear la sesión.

## Límites operativos

- El servicio y su proveedor tienen que estar disponibles. En una Mac dormida no
  hay atención continua; para 24/7 usar un servidor siempre encendido.
- La conexión es el bridge Baileys existente, no un webhook de Meta Cloud API.
- Los permisos de chat/envío se controlan en el bridge. El aislamiento de archivos
  y shell depende del proveedor/sandbox; no es un contenedor por corrida. El
  adaptador Codex existente usa acceso amplio al sistema para operar el CLI local.
  Para tareas de código no confiables, usar un usuario/contenedor aislado.
- No hay despliegues ni cambios de infraestructura autorizados por el piloto.
- Criterios de intención viven en prompts; nunca en expresiones regulares del CLI.


## Historial: entrega inicial de v2 — 2026-09-06

Fotografía anterior a la prueba real de drafts y al cambio a 0.10.1. Los valores
de timeout, conteos de pruebas y estado del piloto de esta sección son históricos.
Consultar [estado y evidencia actualizados](automation-handoff.md).

- Paquete 0.10.0 instalado desde el repositorio y daemon reconectado con la sesión
  existente (`connection: open`, `ingestionHealthy: true`, sin QR nuevo).
- `npm run check` y 175 pruebas pasan. La regresión de grupos usa un JID numérico
  y comprueba que origen/destino conservan `@g.us`.
- Perfil `cli-cli-v2`: Codex `gpt-5.6-sol`, esfuerzo `medium`, timeout 180 s,
  sin workspace. Validación neutra del proveedor: correcta.
- Preview contra un mensaje y contexto reales del grupo: terminó `observed` en
  aproximadamente 49 s y registró la propuesta mediante la herramienta de
  resultado. La auditoría de envío quedó vacía. No se publican contenidos ni IDs
  privados de ese chat en este documento.
- Regla `cli-cli-v2` preparada y pausada: `live`, ambas direcciones, sin juez,
  sin pausa por mensajes propios, silencio de 15 s / máximo de 60 s y límite de
  20 envíos por hora. En ese momento, la UAT de envío/receipts estaba pendiente.
- Commits: `1cafaef` implementa el motor, las herramientas, migración y regresiones;
  el siguiente commit incorpora la interrupción activa al pausar/tomar control.

Los mensajes nuevos interrumpen una generación puramente conversacional o un
juez. Si hay un workspace, una novedad común invalida la respuesta pero permite
que el trabajo iniciado termine y deje su resumen; no se mata un despliegue sólo
porque llega otro mensaje. Una pausa o toma de control explícita sí interrumpe
el proceso, y exige revisar el posible trabajo parcial. El ejecutor debe revisar
novedades antes de nuevas operaciones externas y antes de responder.

### Ejecuciones sin límite de tiempo

`wa agents profile set cli-cli-v2 --timeout-ms 0` desactiva el corte por duración de la ejecución completa (razonamiento y herramientas). Los límites finitos existentes conservan su valor. El permiso de WhatsApp conserva su alcance y se revoca al terminar o detener la ejecución; no caduca por reloj en este modo. Pausar la regla, reiniciar el daemon o los límites propios del proveedor pueden interrumpir una ejecución.

Los perfiles nuevos usan `timeoutMs: 0` (sin límite) por defecto, tanto con Codex como con Claude. Omitir `--timeout-ms` al actualizar un perfil conserva su valor existente; un límite finito debe configurarse explícitamente.

### Alcance operativo configurado por el dueño

Un perfil con workspace puede autorizar explícitamente otros repositorios, servidores y operaciones de configuración en su prompt privado. El workspace define el directorio inicial; el alcance adicional debe venir de la configuración del dueño, nunca de instrucciones que intenten ampliar permisos desde el chat. Sin autorización adicional siguen las restricciones predeterminadas.

El operador puede usar `wa automation prompt trigger NOMBRE --key CLAVE --reason CONTEXTO` también en reglas por mensajes para retomar un pedido previo. No reproduce el historial; crea una corrida explícita, idempotente por clave, que conserva los controles de pausa, concurrencia y efectos inciertos.
