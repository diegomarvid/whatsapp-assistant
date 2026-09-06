# Revisión de consultas humanas — 2026-09-06

## Resultado y alcance

**La revisión independiente con Claude Fable 5.1 `xhigh` quedó pendiente.**
Se invocó el CLI real, pero no devolvió un informe de revisión. Las correcciones
de 0.11.1 descritas aquí provienen de inspección local y pruebas de regresión;
no se atribuyen a Fable ni constituyen su aprobación.

Base revisada: `90d04cf73a2b26013158685ef0520006cfbc9aec` (0.11.0).
Se examinó la espera durable, autorización de replies, publicaciones, reanudación
nativa y reconciliación del workspace. Los contratos y límites operativos están
en [consultas humanas](../human-consultations.md) y la evidencia anterior del
piloto real en [continuidad](../automation-handoff.md).

## Intentos de revisión independiente

Se usó Claude Code 2.1.263 con el modelo y esfuerzo solicitados:

```sh
claude -p --model claude-fable-5-1 --effort xhigh \
  --safe-mode --tools '' --strict-mcp-config \
  --dangerously-skip-permissions --no-session-persistence \
  --output-format stream-json --verbose < review-input.txt
```

El contenido se entregó por stdin: sin herramientas disponibles, plugins ni
modificaciones del revisor. La bandera de permisos no concede herramientas que
no estén habilitadas. No se habilitó un receptor Telegram paralelo.

| Intento | Entrada y resultado |
| --- | --- |
| Diseño completo | 615.319 bytes de documentación, código y pruebas, incluyendo el servicio externo. Usó salida `json`; terminó por timeout, sin informe. SHA-256: `3b74e237b02cea22a180f79620ceae856203c9bebd53dbf1af416b01d96a4601`. |
| Núcleo acotado | 175.060 bytes: guía, motor de consultas, almacenamiento, worker, reglas, runner/adaptadores nativos, hooks y pruebas. Incluía las primeras correcciones locales; describía los guards del servidor y el servicio externo como supuestos, sin su implementación completa. Confirmó `claude-fable-5-1`, pero terminó con `is_error: true`, HTTP 429 y límite de sesión, sin hallazgos finales. SHA-256: `0cb2f2f9d59466e5cbcd2c6b41728fc158625aed89ec71304986a69a116398af`. |

Los metadatos y entradas permanecen en el expediente privado. No se publica el
stream interno del proveedor ni contenido de clientes. No se cambió de modelo o
esfuerzo para presentar otra revisión como equivalente. Cuando haya cuota, falta
revisar la versión final, preferiblemente en paquetes pequeños por frontera y
con un informe final obligatorio por paquete.

## Correcciones locales comprobadas

| Problema | Corrección y regresión |
| --- | --- |
| Un reply de una identidad no autorizada avanzaba el mismo cursor que la interpretación; podía invalidar una decisión válida y provocar otra llamada al modelo. | `transportCursor` avanza sobre todos los eventos; `cursor` sólo sobre feedback autorizado. Lo ignorado queda en el diario. Se cubren interpretación en curso, confirmación, preflight, páginas de 50 eventos y estado antiguo sin el campo nuevo. |
| Una confirmación del adaptador con otro ID de diálogo podía reemplazar la raíz de la consulta. Una novedad del chat podía habilitar interpretación pese a una publicación incierta. | Publicación e inspección deben conservar el ID original. El worker no reclama interpretación ni continuación mientras la publicación está en curso o sin confirmar. La prueba combina raíz incorrecta, actualización del chat e inspección. |
| El runner comprobaba configuración, pero aceptaba un ID de sesión distinto devuelto al reanudar. | Se exige el ID persistido exacto. La salida se marca fallida y no reemplaza la sesión original. Una prueba del proveedor simulado devuelve otro ID y verifica el rechazo. |
| Un cambio del workspace antes de reanudar una pregunta nativa de Claude borraba la pregunta todavía diferida. | La consulta del worker sobre esos cambios conserva la pregunta nativa y vuelve a exigir sus respuestas estructuradas antes de continuar. Una pregunta nueva del ejecutor sigue limpiando la anterior. La regresión usa un repositorio Git real temporal y confirma que no se lanza el proveedor antes de reconciliar. |

El último caso se reprodujo antes de corregirlo: el estado quedaba esperando,
pero `nativeQuestion` era `null`. Tras la corrección conserva la pregunta y sólo
acepta continuar con una respuesta para cada pregunta original.

## Verificación y límites

- `npm run check` y las **225 pruebas** de la suite completa pasaron localmente
  antes del despliegue. La guía de continuidad registra la verificación operativa.
- Las regresiones nuevas usan canales/proveedores simulados; el caso de cambio
  del workspace usa Git real. No se envían mensajes a WhatsApp ni Telegram.
- La espera por sí sola no consume tokens. Interpretar un reply y continuar
  trabajo sí consume tokens; también puede consumirlos una revisión externa
  que termina sin informe, como ocurrió en este intento.
- El perfil fija el nombre de modelo configurado. Para fijar una versión se
  necesita un ID versionado: un alias del proveedor puede cambiar de significado.
- No se amplía la evidencia del piloto real anterior. Siguen pendientes UAT de
  proveedores autenticados en Linux/VPS, casos de draft con reescritura/audio y
  respuesta humana tras un día. La renovación de autenticación sigue siendo una
  operación del proveedor, no una concesión implícita mediante replies de Telegram.
- Estas correcciones no cambian el contrato del servicio Telegram externo ni
  reactivan reglas pausadas. Mantener un solo propietario del bot y una copia
  coherente del estado antes de actualizar.
