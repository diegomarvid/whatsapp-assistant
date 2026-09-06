# Guía técnica y continuidad de automatizaciones

Punto de entrada para retomar el desarrollo desde otra sesión o equipo. Describe
el código **0.11.0**, el despliegue y la evidencia revisados el **2026-09-06**.
El estado operativo es una fotografía de esa fecha: consultar el CLI antes de actuar.

## Qué leer y qué está funcionando

1. Esta guía: arquitectura, implementación, piloto y próximos pasos.
2. [Conversaciones autónomas](autonomous-conversations.md): reglas, juez, ejecución,
   intervención humana, recuperación y comandos.
3. [Borradores con revisión](draft-review.md): política, protocolo JSON completo,
   herramientas del modelo y adaptador opcional Maspeak/Mustpeak Drafts.
4. [Estado privado](private-state.md) y [recuperación del bridge](onboarding-and-recovery.md):
   ubicación de datos y cuidados al cambiar instalación o sesión.

La [guía de consultas humanas](human-consultations.md) define la implementación
0.11: tarea estable, diario SQLite, preguntas y replies de varias rondas,
confirmación publicada antes de continuar y reanudación de sesión nativa para
Codex y Claude. Funciona con o sin revisión del mensaje final. El
[diseño](human-consultation-design.md) y la
[investigación de proveedores](provider-consultation-research.md) conservan los
antecedentes; para configurar o desarrollar, usar el contrato de la guía actual.

### Evidencia de 0.11, 2026-09-06

- `npm run check` y **221 pruebas** pasan, incluyendo esperas superiores a una
  semana, varias rondas, ediciones, paginación, cambios del chat antes de retomar,
  publicaciones ambiguas, pausa y recuperación transaccional.
- **Codex 0.153.4 y Claude Code 2.1.263 reales**, sin terminal interactiva:
  pregunta de color, aclaración del tono, confirmación y continuación en la misma
  sesión del ejecutor. En estas dos pruebas el canal y las respuestas humanas
  fueron simulados; ambos terminaron `completed`, con cero envíos a WhatsApp.
- **Telegram real + Claude:** el humano respondió la primera pregunta y recibió
  una segunda consulta coherente. Un reinicio durante la espera conservó el
  mismo trabajo y sesión sin duplicar el mensaje. Al registrar esta evidencia,
  queda pendiente la respuesta humana al segundo mensaje y el cierre del ciclo.
- El receptor Telegram v2 se desplegó en Linux con **18 pruebas de servicio**
  aprobadas y long polling saludable. Los CLIs nativos se probaron en macOS sin
  interfaz; falta UAT de ambos proveedores autenticados en el VPS elegido.

La prueba neutra reproducible es `wa automation human test`; usa un bridge de
fixtures sin conexión ni endpoints de envío a WhatsApp. El caso histórico de
draft y envío aprobado se documenta más abajo y no debe confundirse con esta
prueba de consulta y reanudación.

Las tres reglas conservadas de laboratorio/soporte siguen pausadas. Retomar
el desarrollo no las activa. Los detalles de instalación local y de cada piloto
están en el expediente privado. Antes de migrar 0.10 → 0.11, parar el daemon
anterior y respaldar el estado coherentemente: el schema v4 no admite volver a
una versión antigua contra el mismo archivo.

La distribución pública se debe verificar por separado: una instalación del
registro o de Homebrew puede ir detrás de `main`. Se puede reproducir esta versión
con el código 0.11.0, `npm ci`, sus verificaciones y un tarball de `npm pack`.
No asumir que la última versión del registro tiene estas capacidades.

## Recorrido completo

```mermaid
sequenceDiagram
  participant W as WhatsApp / Baileys
  participant D as Daemon y estado local
  participant E as Ejecutor IA
  participant A as Adaptador y canal de revisión
  participant H as Revisor humano
  participant R as Intérprete IA
  W->>D: messages.upsert: mensaje live
  D->>D: Persistir, agrupar y comprobar regla
  Note over D,E: Juez opcional: ai, human o none
  D->>E: Ejecutar con contexto y permisos de la corrida
  E->>D: draft submit: texto exacto y motivo
  D->>A: publish con clave estable
  A->>H: Borrador con contexto y versión
  Note over D,R: Espera persistente, sin modelo activo
  H->>A: Reply al mensaje del borrador
  D->>A: replies desde cursor guardado
  A-->>D: Identidad, texto, ediciones y cursor
  D->>R: Interpretar feedback autorizado
  R->>D: approve / revise / cancel / wait
  Note over D,A: revise publica otra versión y exige otra aprobación
  D->>D: Revalidar aprobación, contexto, destino y permisos
  D->>W: Enviar texto exacto si approve sigue vigente
  W-->>D: ID aceptado; luego entrega/lectura si se reciben
```

WhatsApp entra por eventos de la conexión Baileys; no hay un webhook público de
Meta. El daemon hace un tick local cada segundo y una reconciliación del mirror
cada minuto para recuperar eventos ya persistidos que no entraron a la cola.
Esto no recupera mensajes que nunca llegaron al mirror.

En el piloto, el servicio externo de Telegram mantiene un único consumidor
`getUpdates` con long polling de 25 segundos y guarda respuestas en SQLite.
El daemon consulta ese servicio **por draft** cada 5 segundos mediante el
adaptador; no consulta a una IA para saber si llegó algo. La asociación se hace
por el mensaje respondido y el ID de draft, con cursor independiente por versión.
No se registra un webhook por ID de mensaje. La latencia suma la consulta, la
interpretación del modelo y la comprobación previa al envío.

## Piezas y responsabilidades

| Pieza | Responsabilidad y fuente |
| --- | --- |
| Bridge y API local | [server.js](../src/server.js): eventos, mirror, endpoints y comprobaciones de acceso. |
| Reglas y cola | [prompt-automation-rules.js](../src/prompt-automation-rules.js): agrupación, estados, pausas, novedades, outbox, migración y recuperación. |
| Consultas humanas | [automation-human.js](../src/automation-human.js): diálogo, respuestas autorizadas, confirmación, reanudación y recuperación de publicación. |
| Diario durable | [automation-store.js](../src/automation-store.js): control y eventos en una misma transacción SQLite. |
| Coordinador | [automation-worker.js](../src/automation-worker.js): etapas, cobertura fresca, concurrencia, procesos e interrupción. |
| Revisión humana | [automation-reviews.js](../src/automation-reviews.js): publicación, feedback, versiones, decisiones, vencimiento y entrega aprobada. |
| Contrato externo | [review-adapter.js](../src/review-adapter.js): validación, proceso JSON sin shell, límites y normalización de identidad/ediciones. |
| Ejemplo de transporte | [maspeak-drafts.js](../src/review-adapters/maspeak-drafts.js): traducción al CLI opcional; no implementa un servidor Telegram. |
| Proveedores y perfiles | [agent-providers.js](../src/agent-providers.js), [agent-provider-runner.js](../src/agent-provider-runner.js) y [agent-provider-adapters.js](../src/agent-provider-adapters.js): modelo, esfuerzo, prompt fijado por huella y ejecución de Codex/Claude CLI. |
| Credencial de corrida | [automation-capabilities.js](../src/automation-capabilities.js): alcance por etapa/chat/corrida y revocación. |
| CLI operativo | [bin/wa.js](../bin/wa.js): perfiles, reglas, auditoría y herramientas explícitas del agente. |
| Identidad y frescura | [chat-identity.js](../src/chat-identity.js), [chat-coverage.js](../src/chat-coverage.js), [mirror-store.js](../src/mirror-store.js): resolver LID actual, persistir mensajes y comprobar cobertura. |
| Ubicación de datos | [runtime-paths.js](../src/runtime-paths.js): instalación empaquetada, checkout y `WA_STATE_DIR`. |

Un **perfil** elige proveedor, modelo, esfuerzo, prompt y workspace; una **regla**
elige conversación, dirección, disparador, tiempos y política de revisión. Cada
disparo produce un **lote**; cada corrección crea una **versión** con su propia
publicación, feedback y decisión. El **outbox** conserva intentos de envío a
WhatsApp. Son registros distintos; un proceso `completed` no prueba un envío.

La semántica vive en los prompts: el juez decide si intervenir y el intérprete
decide qué significa el feedback. El motor exige decisiones mediante herramientas;
no interpreta frases de la salida narrativa como órdenes de envío.

## Tiempos, estados y persistencia

| Control | Qué limita |
| --- | --- |
| `debounceSeconds` / `maxWaitSeconds` | Silencio para agrupar mensajes y máximo antes de iniciar análisis. |
| Perfil `timeoutMs` | Duración de una ejecución IA. Nuevos perfiles: `0`, sin corte por reloj; finitos hasta una hora. No limita cuánto puede demorar el humano. |
| Política `pollSeconds` | Consulta al canal mientras existe un draft pendiente; 5–3600 segundos. |
| Política `expiresSeconds` | Plazo desde la **primera propuesta**, incluso si hay correcciones. Default siete días; configurable entre 60 segundos y 30 días. |
| `maxRevisions` | Máximo de versiones, 1–20. El piloto usa 5. |
| `maxRepliesPerHour` | Límite de entregas de la regla; evita conversaciones ilimitadas con otros bots. |

La espera humana usa `review_waiting`; feedback listo para interpretar usa
`review_ready` y su ejecución usa `reviewing`. `wait` reconoce el feedback
procesado y vuelve a esperar novedades. `revise` publica el texto completo nuevo;
responder a una versión vieja no aprueba la nueva. `cancel` y vencimiento terminan
sin envío. Una aprobación puede quedar invalidada por novedades del chat fuente,
pausa, toma de control humano o cambio de destino antes de entregar.

Se puede responder al día siguiente si el plazo sigue vigente y el contexto no
fue invalidado. Esperar más tiempo no concede aprobación. El daemon y el canal
deben estar disponibles para procesar; una Mac dormida no ejecuta el flujo.

El estado de reglas es schema v4 en SQLite y migra v1/v2/v3 JSON, manteniendo
pausas e historial. Los escritores conservan el lock de proceso; cada cambio
de control y sus eventos se guardan en una transacción. El JSON original pasa
a ser un marcador que rechazan las versiones antiguas. El mirror usa otra base SQLite. Feedback y cursor de recepción se guardan
antes de invocar al intérprete; `processedCursor` registra por separado lo ya
decidido. Pendientes e inciertos se conservan; terminales por mensajes y outbox
aceptado usan retención de siete días, salvo trabajos con consulta humana y sus
envíos, que se conservan junto con el diario sin poda automática. Las claves de disparos manuales se
conservan indefinidamente para impedir duplicados del scheduler.

La publicación reserva una clave estable antes de llamar al canal; WhatsApp
reserva un ID antes del transporte. Ante resultado ambiguo se bloquea para
inspección, sin reenviar automáticamente. Un ejecutor interrumpido puede haber
hecho trabajo externo y queda incierto; una espera persistida puede continuar
al reiniciar. No hay una transacción distribuida que garantice exactamente una
vez entre WhatsApp, la cola y Telegram. Ver [recuperación](draft-review.md#estado-prueba-y-límites).

## Prueba real del chat directo

Piloto del 2026-09-06, con conversación y revisor conocidos. La identidad y el
contenido real se conservan en el expediente privado descrito al final de esta
guía. Este caso corresponde a la prueba de responder en tono humano mediante
drafts; es distinto del grupo dedicado a IA con respuesta directa.

| Ajuste | Configuración usada |
| --- | --- |
| Ejecutor e intérprete | Dos perfiles Codex `gpt-5.6-sol`, esfuerzo `medium`, timeout `0`, sin workspace. |
| Alcance | Conversar sobre mensajes entrantes nuevos; mismo chat de origen/destino; sin juez. Sin trabajo de código ni otras cuentas. |
| Agrupación | 10 segundos de silencio, máximo 45, lote de hasta 100 mensajes. |
| Intervención | Toma de control por mensaje humano propio activada; máximo una respuesta por hora. |
| Revisión | Telegram mediante adaptador Maspeak, un revisor autorizado por identidad, consulta cada 5 segundos, hasta cinco versiones. |
| Vencimiento | La prueba inicial usó una hora. Después se actualizó la regla a siete días; el lote ya completado conserva su plazo histórico. |

Secuencia verificada, horas de Uruguay (UTC−03:00):

1. **03:35:37:** llegó un mensaje nuevo al chat y se creó el trabajo.
2. **03:36:** el ejecutor propuso una respuesta breve; se publicó el draft en
   Telegram. No hubo envío a WhatsApp durante la espera.
3. **03:36:51:** el revisor autorizado respondió al mensaje del bot.
4. **03:37:34:** el intérprete registró aprobación de la versión actual.
5. **03:37:44:** el transporte aceptó un único envío con el texto exacto aprobado.
6. **03:37:47:** se recibió `DELIVERY_ACK` (estado 3). Confirma entrega, no lectura.
7. Al cerrar la prueba se verificaron pausados la regla y su seguimiento de Codex.

Luego se publicó una **vista previa independiente** del formato nuevo: título
con emoji, automatización y responsable en viñetas, motivo separado, negritas,
versión y mensaje. Oculta IDs de transporte y escapa el texto para MarkdownV2.
Esa muestra no estaba conectada a un envío de WhatsApp; no cuenta como una
segunda aprobación de extremo a extremo ni como prueba real de reescritura.

| Validación | Evidencia y alcance |
| --- | --- |
| Aprobación humana → entrega exacta | Probada con una persona, Telegram y WhatsApp reales; una versión y un envío. |
| Formato nuevo | Vista previa real en Telegram, sin envío posterior. |
| Agrupación, permisos, idempotencia, pausa, reinicio, feedback editado, corrección, cancelación, audio sin transcribir y vencimiento | Pruebas automatizadas con componentes simulados; consultar [automation-reviews.test.js](../test/automation-reviews.test.js), [autonomous-conversations.test.js](../test/autonomous-conversations.test.js), [prompt-automation-rules.test.js](../test/prompt-automation-rules.test.js) y [automation-capabilities.test.js](../test/automation-capabilities.test.js). |
| Gates 0.10.1 | `npm run check` y 205 pruebas pasaron en CI. El servicio externo pasó sus 16 pruebas de presentación/persistencia; no forman parte de este repo. |
| UAT todavía pendiente | Humano pide cambios y aprueba versión 2; cancela; responde por audio; responde tras un día; reinicio real durante espera. |

El grupo de respuesta directa registró cinco envíos aceptados y quedó pausado;
no se recolectó aquí evidencia de entrega/lectura para todos. La regla histórica
de soporte también quedó pausada: nueve procesos finalizados informaban no
actuar por exclusiones del prompt; otros seis vencieron a los 60 segundos y uno
falló por límite 429. Se conoce su fecha de creación, no continuidad de uptime.
Conservar esa evidencia; no repetir automáticamente su trabajo histórico.

## Servicio externo y reutilización

El núcleo funciona con cualquier canal que cumpla el [contrato del adaptador](draft-review.md#contrato-para-cualquier-adaptador):
publicación idempotente, identidad verificable, replies/ediciones ordenados por
cursor y vínculo entre versiones. El programa recibe JSON por stdin y devuelve
JSON por stdout; tiene 35 segundos por operación y salida acotada. No recibe
autoridad para aprobar o enviar a WhatsApp.

La implementación Telegram del piloto está en otro repositorio privado:
`ops/drafts/service.py` mantiene cola, publicaciones y long polling;
`ops/drafts/client.py` conecta por socket/SSH;
`scripts/cli/drafts.ts` expone el CLI y `docs/telegram-drafts.md` documenta ese
servicio. Las rutas y versión desplegadas están en el expediente privado.
El consumidor Telegram del bot debe ser único: no iniciar otro `getUpdates`
en un plugin o sesión paralela con el mismo token.

El servicio necesita los campos `automation`, `reason` y `revision` antes de usar
el adaptador 0.10.1. Mantiene el mensaje propuesto literal y renderiza por separado
la presentación. Su estado `sent` significa **publicado en Telegram**; la
aprobación y entrega WhatsApp pertenecen al motor de este repo. La transcripción
de feedback es un wrapper opcional configurado privadamente; no está probada
con audio humano real en este piloto.

Para otra integración, reutilizar el contrato y los prompts
[ejecutor con revisión](prompts/reviewed-conversation.md) e
[intérprete](prompts/draft-reviewer.md). Definir por separado propósito, fuentes
permitidas y criterio de intervención. Una aprobación de mensaje no amplía los
permisos para modificar una plataforma. No hay una integración de customer success
implementada como parte de este patrón.

Una automatización de Codex u otro scheduler puede invocar una regla
`--trigger manual` con `--key` estable por operación y `--reason` contextual.
Después termina: el daemon continúa la espera y revisión. La receta completa
está en [configuración](draft-review.md#configurar-una-regla). El seguimiento de
Codex del piloto era supervisión temporal; no recibía los mensajes ni las
aprobaciones. `wa schedule` es otra función: programa textos fijos ya definidos.

## Inspección y continuidad desde otro lugar

Comandos de consulta, ejecutados en el host que mantiene el estado:

```sh
wa --version
wa doctor
wa status
wa automation prompt list --all --verbose
wa agents profile list
wa agents profile show NOMBRE_DE_PERFIL
wa automation prompt show NOMBRE_DE_REGLA --json
wa automation review-policy status /ruta/privada/policy.json
```

`list --verbose` muestra modelo/esfuerzo, prompt, timeout, workspace, revisión y
conteos. `show --json` contiene lotes, versiones, feedback, decisiones, errores
y outbox. La información es privada. Todavía no existe una bandeja única que
consolide todos los drafts pendientes con estado final del canal y de WhatsApp.
El CLI externo permite `drafts list` y `drafts replies ID --after CURSOR --wait 0`;
su lista reciente no reemplaza el historial ni el estado de aprobación del motor.

Para intervenir, `wa automation prompt pause NOMBRE_DE_REGLA` invalida trabajo
pendiente y detiene al proveedor. El plazo se cambia sin activar:
`wa automation prompt review-expiry NOMBRE_DE_REGLA --days 7`. El comando actualiza
la regla y propuestas todavía vigentes desde su creación original; no revive
lotes vencidos o terminales. Editar el JSON de política externo no actualiza por
sí solo la copia guardada en la regla.

Antes de desarrollar o trasladar ejecución:

1. Identificar host y estado activos con `wa doctor`; desde otro equipo, usar
   SSH al host propietario para consultar. No exponer la API local a Internet.
2. La instalación global usa estado externo: macOS en
   `~/Library/Application Support/WhatsApp Assistant`; Linux en
   `${XDG_STATE_HOME:-~/.local/state}/whatsapp-assistant`. `WA_STATE_DIR` prevalece.
   Ejecutar `node bin/wa.js` desde un checkout usa por defecto el estado **de ese
   checkout**, que puede estar vacío. No concluir por eso que se perdió la sesión.
3. Leer el expediente privado y conservar pausas. La configuración contiene
   rutas absolutas a prompts, ejecutables y al CLI externo: clonar Git no las migra.
   Configurar proveedor autenticado, permisos y rutas para el host elegido;
   no arrancar una segunda copia del mismo estado ni pedir otro QR como reparación.
4. Para instalar cambios: checkout limpio, `npm ci`, `npm run check`, `npm test`,
   backup privado de estado, `npm pack` e instalación del tarball. Seguir
   [instalación y reversión](autonomous-conversations.md#instalación-y-reversión).
   Antes de migrar de host, planificar también sesión, único propietario de la
   cola, servicio de arranque y backup consistente de SQLite.
5. Verificar versión, conexión, cobertura y reglas después de un cambio de código.
   Revisar efectos inciertos antes de liberar trabajo. Las pruebas de envío se
   activan expresamente en un chat acordado y se cierran pausando la regla.

En la instalación del piloto, `data/automation-handoff.md`, relativo al estado
activo, contiene reglas reales, rutas, versiones del servicio y ubicación de
`data/draft-pilots/` con prompts, política y evidencia. Es un expediente privado
complementario, no un archivo que el programa genere automáticamente. Mantenerlo
junto con backups de estado y compartirlo sólo por un canal privado autorizado.
El repo público conserva arquitectura, configuración anonimizada y resultados;
no debe contener conversaciones, identidades, destinos ni credenciales reales.

## Mejoras pendientes para una siguiente iteración

- **UAT del ciclo de cambios:** versión 2, cancelación, audio, espera de un día
  y reinicio durante espera. Comprobar un solo envío exacto y que una respuesta
  vieja o una novedad del chat no autorice una propuesta desactualizada.
- **Operación de drafts:** vista unificada de pendientes con regla, modelo, versión,
  vencimiento, última consulta y error; confirmaciones visibles en el canal al
  aprobar/cancelar/entregar. Las consultas ya tienen `human list/show`, modelo,
  rondas, errores y confirmación antes de continuar; los drafts conservan su
  contrato independiente. Hoy la evidencia completa está en el CLI y el estado.
- **Disponibilidad:** host siempre encendido, salud del bridge/proveedor/canal y
  backup periódico consistente de la cola externa; hoy hay backup manual del
  despliegue, no una política automática verificada para ese servicio.
- **Escala:** medir coste de procesos/SSH por draft. El motor limita a diez
  elementos por barrido y tres operaciones de adaptador concurrentes; considerar
  consultas agrupadas, backoff o avisos por webhook manteniendo cursores durables.
- **Distribución:** resolver publicación npm y comprobar qué versión entrega
  cada método de instalación antes de recomendar upgrades a terceros.
- **Soporte histórico:** revisar criterios excluyentes y timeout del perfil antes
  de diseñar otra prueba. La pausa actual se conserva hasta decidir su alcance.

Al cambiar comportamiento, actualizar contrato, ejemplos y pruebas de la frontera
afectada. Separar evidencia simulada de verificación real. Registrar fecha y
commit de cada despliegue, sin convertir una fotografía de producción en una
promesa de disponibilidad futura.
