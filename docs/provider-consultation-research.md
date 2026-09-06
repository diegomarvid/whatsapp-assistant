# Consultas humanas: Codex CLI y Claude Code

Investigación del **2026-09-06**, sobre `main` `6409452`. Complementa y ajusta
el [diseño de consultas](human-consultation-design.md). **Investigación y diseño;
no implementación ni validación de una consulta real con estos mecanismos.**
«Claude CLI» aquí significa Claude Code, no un CLI de infraestructura cloud.

## Conclusión y decisión

El patrón es viable con ambos proveedores. Mantener un motor común de trabajo,
diálogo, identidad, publicación y continuación; adaptar la ejecución a las
funciones de cada proveedor. La mejora respecto del diseño inicial es **preferir
la sesión nativa para conservar contexto**, además del checkpoint verificable
del trabajo. Una sesión nueva reconstruida sigue siendo una alternativa explícita
cuando se pierde el historial o se cambia de proveedor.

Claude Code ofrece una pausa nativa particularmente adecuada: `PreToolUse` puede
diferir una herramienta en ejecución no interactiva y continuarla más tarde.
Codex permite reanudar conversaciones y ofrece un protocolo de aplicación para
preguntas, eventos e interrupciones. Eso no demuestra que una solicitud pendiente
de su protocolo sobreviva al cierre del proceso. Ver las fuentes y límites abajo.

No declarar que el sistema «ya funciona perfecto para ambos»: la consulta sigue
pendiente de implementación. El piloto anterior verificó drafts con Codex; no
probó esta suspensión/continuación ni su equivalente con Claude.

## Qué hace hoy nuestro código

Inspección de [agent-provider-adapters.js](../src/agent-provider-adapters.js) y
[agent-provider-runner.js](../src/agent-provider-runner.js):

| Aspecto | Codex actual | Claude actual |
| --- | --- | --- |
| Entrada | `codex exec`, prompt por stdin. | `claude -p`, prompt por stdin. |
| Salida | JSONL y archivo de última respuesta. | Un resultado JSON. |
| Persistencia nativa | `--ephemeral`: desactivada. | `--no-session-persistence`: desactivada. |
| Preguntas/hook nativo | No hay cliente de App Server en el runner. | `--safe-mode` deshabilita hooks/MCP; la lista de herramientas tampoco incluye `AskUserQuestion`. |
| Contexto local | Directorio temporal nuevo por corrida, borrado al finalizar salvo el workspace externo. | Mismo ciclo de directorio temporal. |
| Identidad de sesión | El runner no guarda `thread_id` como estado de continuación. | El runner no guarda `session_id` ni trata `deferred_tool_use` como suspensión. |

Por tanto, cambiar sólo el prompt no habilita una pausa nativa. Además, el
runner de Claude usa código de salida e `is_error` para determinar éxito; debe
distinguir resultados terminales de una suspensión antes de llamar al cierre
de lote. Conservar la salida narrativa como auditoría, sin convertirla en envíos.

## Codex: dos superficies útiles

**CLI y SDK.** `codex exec resume ID` continúa una conversación persistida. El
SDK TypeScript ofrece `resumeThread` y turnos sucesivos. Son útiles para mantener
contexto entre ejecuciones; en un sistema con varios trabajos hay que guardar
el ID exacto, evitando `--last`. [Modo no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode#resume-a-non-interactive-session),
[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk).

**App Server.** Expone JSON-RPC para threads, turnos, preguntas al cliente y
control de la ejecución. La documentación describe `thread/resume`,
`turn/interrupt`, `turn/steer` y `item/tool/requestUserInput`.
Los `dynamicTools` se negocian como experimentales. Un request de pregunta puede
quedar resuelto por limpieza al interrumpir o terminar el turno; no tratar su
ID como autorización durable para responder después a otro proceso.
[Protocolo oficial](https://learn.chatgpt.com/docs/app-server).

La inspección **del schema generado por el binario instalado** confirma métodos
de resume/interrupt/steer, requests de pregunta y respuestas por ID. También
encontró un detalle que importa al implementar: `isBlocking` es requerido,
`autoResolutionMs` figura deprecado y las preguntas permiten `options: null`.
El texto web todavía describe el timeout opcional. Generar los bindings del
runtime fijado, no copiar una estructura aproximada desde un ejemplo web.

Recomendación para este repo: añadir sesión persistente y continuación por ID al
adaptador CLI primero. Adoptar App Server si se necesitan preguntas y eventos
nativos bidireccionales durante el turno. En ambos casos, el motor registra
la consulta antes de cerrar/interrumpir, conserva el trabajo y sólo crea otro
turno después de la confirmación y los controles comunes. El soporte del esquema
no prueba disponibilidad de una herramienta en todos los modos/modelos.

No encontré en las superficies verificadas un contrato documentado equivalente
a «cerrar este proceso y recuperar exactamente este request pendiente» de Claude.
Esto delimita la evidencia, no afirma que ninguna versión futura pueda ofrecerlo.

## Claude: pausa de herramienta y reanudación

`PreToolUse` puede devolver `permissionDecision: defer` en modo `-p`: el proceso
termina conservando la herramienta pendiente. El resultado incluye
`stop_reason: tool_deferred`, `session_id` y `deferred_tool_use`. Al reanudar por
ID, vuelve a pasar por el hook; éste entrega la respuesta con `updatedInput`.
Para `AskUserQuestion`, la entrada mantiene las preguntas y agrega las respuestas.
[Contrato de defer](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later).

Límites documentados: defer requiere una sola llamada de herramienta en ese turno;
en una tanda paralela puede ignorarse. La sesión está sujeta a limpieza de
transcripts, por defecto 30 días. Una herramienta ausente al retomar produce
`tool_deferred_unavailable`; los modos de permisos deben configurarse otra vez
en `-p`. El adaptador debe detectar estos casos, no inferir suspensión por exit 0.
[Hooks](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later).

Esto se puede integrar con el **CLI existente**, sin exigir migrar al Agent SDK.
El SDK facilita callbacks de permisos y preguntas con `canUseTool`, y hooks para
controles que deben ocurrir antes de toda herramienta. Esperar dentro de un
callback mantiene el proceso; para respuestas que tardan días, preferir defer
con estado persistido. [Entrada humana](https://code.claude.com/docs/en/agent-sdk/user-input),
[hooks del SDK](https://code.claude.com/docs/en/agent-sdk/hooks).

La implementación debe reemplazar el uso actual de `--safe-mode` por un entorno
con configuración controlada que habilite **sólo** los hooks/herramientas propios.
No habilitar incidentalmente hooks, plugins o MCP del usuario/proyecto. Quitar
`--no-session-persistence` en este modo, conservar la sesión y validar la
configuración efectiva. Las flags de CLI verificadas muestran por qué los hooks
no funcionarían con la invocación actual.

Un resultado nativo diferido abre nuestra consulta; el intérprete separado puede
repreguntar por Telegram mientras el ejecutor permanece suspendido. Cuando hay
información suficiente, el motor publica la confirmación y recién después
permite reanudar la herramienta original. No responder el hook con un permiso
genérico que libere otras acciones.

## Otras funciones que ayudan, sin reemplazar el motor

| Función | Uso y límite |
| --- | --- |
| Historial de Claude y `SessionStore` | Conserva contexto y permite transportar transcripts a otro host. No transporta por sí solo el filesystem ni los efectos externos. [Sesiones](https://code.claude.com/docs/en/agent-sdk/sessions). |
| Checkpointing de archivos de Claude | Puede restaurar cambios de herramientas de edición; no cubre cambios hechos por Bash ni revierte un deploy o un mensaje. [File checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing). |
| Channels de Claude, incluido Telegram | Reciben eventos en una sesión abierta y pueden contestar por el canal. Requieren sesión en funcionamiento; son otra forma de conectar una conversación. [Channels](https://code.claude.com/docs/en/channels). |
| JSON/streaming/esquemas de salida | Facilitan leer estados e IDs tipados. No convierten una frase del modelo en una aprobación válida del usuario. |

Para nuestro mismo bot, conservar el servicio Drafts como receptor único. Iniciar
además el plugin Telegram sobre ese bot competiría por su consumo de updates;
esa topología no forma parte del diseño. Un canal propio podría conectarse a la
cola existente, pero no elimina identidad, correlación de replies ni outbox.

No elegir `claude --bare` como reemplazo automático del aislamiento actual:
la ayuda instalada especifica que usa autenticación por API key/helper y omite
OAuth/keychain. No cambiar de credenciales o modalidad de consumo al incorporar
esta capacidad. Tampoco hace falta una nueva integración de negocio.

## Ajuste concreto del diseño común

Agregar un registro privado de sesión por **trabajo y etapa**:

```json
{
  "provider": "claude",
  "runtimeVersion": "version-verificada",
  "strategy": "native-defer",
  "sessionId": "id-privado",
  "pendingToolId": "id-privado-o-null",
  "workspaceRef": "workspace-privado",
  "promptHash": "huella-verificada",
  "policyEpoch": 7,
  "checkpointRef": "checkpoint-privado"
}
```

Esquema propuesto, no configuración soportada hoy. Estrategias: `native-defer`
para una suspensión nativa comprobada; `native-session` para otra corrida en la
misma conversación; `checkpoint` para reconstrucción controlada. No mezclar la
sesión del ejecutor con la del intérprete/juez ni elegir la última sesión global.

Mantener estas condiciones independientemente del proveedor:

1. El motor conserva diálogo, respuestas, permisos, estado de los efectos y
   decisión de continuación. La sesión aporta contexto, no autoridad.
2. Cada reanudación recibe permisos nuevos de corrida y políticas verificadas.
   Los paths/capabilities del directorio temporal anterior no sirven. Usar un
   contexto privado estable y renovar el enlace al bridge; no incrustar tokens
   en el transcript ni confiar en permisos recordados por el modelo.
3. Recibir una pregunta nativa no basta para afirmar que todo el trabajo está
   quieto. Confirmar suspensión y procesos, o registrar incertidumbre. Ante
   herramientas paralelas, bloquear efectos dependientes antes de continuar.
4. Pregunta, confirmación y reanudación tienen claves/claims estables. Un resultado
   `success` diferido no significa trabajo completado ni permite enviar WhatsApp.
5. Un reply autoriza sólo la decisión dentro del alcance configurado. Si la
   respuesta final necesita draft, todavía requiere aprobación de texto exacto.
6. Cambio de proveedor, pérdida de sesión o herramienta pendiente incompatible:
   detener y reconciliar. Sólo reconstruir desde checkpoint cuando se demuestre
   qué se hizo; nunca repetir automáticamente un efecto incierto.
7. Retención de sesiones y backups deben cubrir el plazo del diálogo. Un
   transcript limpiado no debe hacer desaparecer la pregunta o el avance guardado.

Esto permite aprovechar las funciones nativas sin que la fiabilidad dependa de
tener una terminal viva, de una memoria resumida del modelo o de una sesión
intercambiable entre proveedores. No promete portabilidad del historial interno
de Codex a Claude: la portabilidad está en nuestro checkpoint y auditoría.

## Verificación realizada y pruebas que faltan

Comprobado localmente sin invocar modelos ni enviar mensajes:

- Codex CLI **0.153.4**: ayuda de `exec resume`, App Server y generación real de
  schemas estables/experimentales. Métodos y campos descriptos arriba presentes.
- Claude Code **2.1.263**: ayuda de resume, persistencia, safe mode, herramientas,
  streaming y autenticación de bare mode. `defer` se contrastó con documentación
  oficial; no se ejecutó una ronda diferida real en esta investigación.
- Registro npm: `@openai/codex-sdk` **0.153.4** y
  `@anthropic-ai/claude-agent-sdk` **0.3.263**. Se consultaron versiones; no se
  instalaron SDKs ni se actualizó el runtime de producción.
- Fuentes oficiales abiertas y leídas, no sólo fragmentos del buscador. Las
  diferencias entre schema local, documentación y fragmentos viejos del buscador
  impiden usar estos últimos como prueba de compatibilidad.

Antes de implementar la migración grande del motor, hacer dos pruebas acotadas
en directorios privados de laboratorio:

| Prueba | Evidencia requerida |
| --- | --- |
| Claude: pregunta → defer → proceso cerrado → resume | Mismo ID de sesión/herramienta; respuesta aplicada una vez; ninguna acción durante la espera. |
| Claude: herramientas paralelas y herramienta ausente | Detectar que no hay suspensión segura; bloqueo en vez de continuación accidental. |
| Codex: sesión persistida → salida → resume por ID | Contexto retenido, nueva capacidad válida, sin reejecutar trabajo anterior. |
| Codex App Server: pregunta e interrupción/reinicio | Observar el cierre/invalidez del request; reconstruir desde nuestro registro, sin responder a un request viejo. |
| Ambos: repregunta, corrección y respuesta al día siguiente | Confirmación visible antes de trabajo; múltiples rondas; sin ocupar un modelo mientras esperan. |
| Ambos: cambios de política/workspace y sesión perdida | Revalidación y bloqueo de efectos dudosos; roles y trabajos no comparten sesiones. |

Primero validar con herramientas inocuas y artefactos locales. Después conectar
el bot de laboratorio por el receptor existente y comprobar salida directa y
draft por separado. La matriz real con ambos proveedores es condición para
declarar esta capacidad lista para producción; la prueba de drafts anterior no
la sustituye.
