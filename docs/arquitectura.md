# Arquitectura de Agenda IA

Cómo está hecho por dentro: las capas, el camino de un mensaje y las reglas que no se rompen. Para correrlo o desplegarlo, ver el [README](../README.es.md) y la [guía de despliegue](despliegue.md).

## Capas

Cada capa solo depende de las de abajo. El dominio no sabe de la base de datos (solo usa la interfaz del repositorio), el bot no sabe de HTTP y la interfaz no sabe de Claude.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Interfaz            app/page.tsx, app/demo/[negocio]/page.tsx, src/ui/      │
│   Chat con aspecto de app de mensajería y panel del negocio.               │
│   El panel se pide cada 4 s (GET /api/panel) y tras cada acción.           │
└───────────────┬────────────────────────────────────────────────────────────┘
                │ fetch con la cookie agenda_sesion (httpOnly; la pone proxy.ts)
┌───────────────▼────────────────────────────────────────────────────────────┐
│ Canal web           proxy.ts, app/api/*, src/web/                           │
│   Sesión solo de la cookie, 401 y 429, cuerpos validados con Zod,           │
│   errores inesperados como 500 genérico (sinFugas).                         │
└───────────────┬────────────────────────────────────────────────────────────┘
┌───────────────▼────────────────────────────────────────────────────────────┐
│ Servicio            src/servicio/                                           │
│   chat.ts: manejarMensaje, mensajeHumano, devolverAlBot.                    │
│   limites.ts: limitador por ventanas fijas. siembra.ts: citas ficticias.    │
│   deps.ts: arma repositorio, limitador y responder según el entorno.        │
└───────┬───────────────────────────────────────────────┬────────────────────┘
┌───────▼───────────────────────────────┐   ┌───────────▼────────────────────┐
│ Bot              src/bot/              │   │ API de Claude                  │
│   prompt.ts: prompt fijo del perfil.   │──►│ client.beta.messages.create    │
│   herramientas.ts: 8 herramientas.     │◄──│ (herramientas, caché,          │
│   responder.ts: bucle de herramientas. │   │  fallbacks del servidor)       │
│   responderDev.ts: guionado, sin red.  │   └────────────────────────────────┘
└───────┬───────────────────────────────┘
┌───────▼────────────────────────────────────────────────────────────────────┐
│ Dominio             src/dominio/                                            │
│   perfiles.ts (esquema Zod), disponibilidad.ts (horariosLibres, cabe,       │
│   encimadas), citas.ts (agendar, reprogramar, cancelar, buscarPorTelefono), │
│   tiempo.ts (zona horaria con Intl). Funciones puras, sin red ni base.      │
└───────┬────────────────────────────────────────────────────────────────────┘
┌───────▼────────────────────────────────────────────────────────────────────┐
│ Repositorio         src/repo/tipos.ts (interfaz)                            │
│   memoria.ts: pruebas y desarrollo.                                         │
│   supabase.ts: producción, con las RPC de supabase/migrations/.             │
│   Las dos pasan la misma suite: tests/compartidas/repositorio.ts.           │
└────────────────────────────────────────────────────────────────────────────┘
```

Los perfiles de los tres negocios ficticios están en `src/datos/negocios/*.json` y se validan con Zod al cargar (horas en orden, descansos dentro del horario, zona IANA válida, servicios sin repetir). Para agregar un negocio se escribe su JSON y se suma a la lista `PERFILES` de `src/dominio/perfiles.ts`; un perfil mal escrito falla al arrancar, no a media conversación.

## El camino de un mensaje

1. **La página.** `proxy.ts` corre antes de cada página: si la cookie `agenda_sesion` falta o no es un uuid v4, pone una nueva. La API no pasa por ahí: sin cookie válida responde 401 y la siguiente carga de página la repone.
2. **La ruta.** `POST /api/chat` llega a `conSesion` (`src/web/rutas.ts`), que lee la sesión de la cookie y llama a `asegurarSesion`:
   - si la sesión ya existe, sigue;
   - si es nueva, primero cuenta en el tope de sesiones nuevas por IP (429 si se pasa), después crea la fila de `sesiones` y siembra de 3 a 6 citas confirmadas por negocio en sus próximos 5 días hábiles (`src/servicio/siembra.ts`).

   El cuerpo se valida con Zod y se arma como `{ ...cuerpo, sesionId, ip }`: aunque el cuerpo traiga un `sesionId`, nunca pisa al de la cookie.
3. **El servicio** (`manejarMensaje`, en `src/servicio/chat.ts`):
   1. valida el texto: de 1 a 1000 caracteres reales y sin caracteres de control; si no, 400 sin crear la conversación;
   2. obtiene o crea la conversación (una por sesión y negocio);
   3. calcula `versionPrompt`, un hash del prompt y las herramientas. Si cambió desde el último turno (se editó un perfil y se redesplegó), arranca un historial de API nuevo y conserva los mensajes visibles;
   4. en modo bot, si el historial pasa de 120 000 caracteres, responde 429 sin gastar contadores;
   5. pasa por el limitador (ver «Límites»); si se pasa de algún límite, 429 con el texto en el trato del negocio (usted o tú);
   6. si la conversación está en modo persona, guarda el mensaje, lo agrega al historial de la API y responde «Le atiende una persona…» sin llamar a Claude.
4. **El bot** (`responder`, en `src/bot/responder.ts`) corre un bucle propio de herramientas:
   - cada vuelta llama a `client.beta.messages.create` con el prompt del sistema del negocio, las 8 herramientas y el historial;
   - si el modelo pide herramientas, se ejecutan (validadas con Zod) y sus resultados vuelven en un solo mensaje `user`;
   - termina con `end_turn`, con `refusal` o al llegar a 6 vueltas. Con `max_tokens` o en la vuelta 6, las herramientas pendientes **no se ejecutan** (no se agenda nada a ciegas): reciben un `tool_result` de error y el cliente ve un texto de respaldo.
5. **Se guarda el turno:** el historial de la API completo (con los bloques de pensamiento y de fallback tal como llegaron), el mensaje visible del bot y, si el bot usó `pasar_a_humano`, el modo persona.
6. **La interfaz** vuelve a pedir el panel. El sondeo de 4 s se salta el tic si ya hay una petición en curso, y solo se aplica la respuesta más reciente (`crearRefresco`, en `src/ui/api.ts`).

### Las herramientas del bot

| Herramienta | Qué hace |
| --- | --- |
| `obtener_fecha_hora` | Fecha, hora y día de la semana en la zona del negocio. La fecha nunca va en el prompt, para no romper la caché. |
| `ver_servicios` | Servicios con id, duración, precio y descripción. |
| `ver_disponibilidad` | Horarios libres de un servicio en una fecha local (solo de hoy al tope de la política). Cada horario trae `inicio` en UTC y `etiqueta` en hora local. |
| `agendar_cita` | Agenda con nombre y teléfono. La cita solo existe si responde `ok: true`. |
| `reprogramar_cita` | Mueve una cita a otro horario del mismo servicio. |
| `cancelar_cita` | Cancela una cita, respetando las horas mínimas de anticipación. |
| `buscar_mis_citas` | Citas vigentes y futuras con ese teléfono. |
| `pasar_a_humano` | Pasa la conversación a una persona del negocio. |

Cada herramienta valida su entrada con Zod y tiene `strict: true` en su JSON Schema. Un error esperado (`HORARIO_NO_DISPONIBLE`, `FUERA_DE_POLITICA`, `CITA_NO_ENCONTRADA`, `SERVICIO_INEXISTENTE`, `DATOS_INVALIDOS`) vuelve al modelo como `{ ok: false, codigo, mensaje }`; uno inesperado (la base caída) sube y la ruta responde 500. El id de sesión lo pone el servidor, nunca el modelo.

## La regla de choque única

Hay una sola regla para saber si una cita cabe, y se aplica igual en las tres partes que la necesitan:

- **Intervalos semiabiertos `[inicio, fin)`:** una cita que termina a las 10:00 no choca con una que empieza a las 10:00.
- **Solo cuentan las citas confirmadas de la misma sesión y negocio.** Las canceladas liberan su horario.
- **Se rechaza si ya hay `capacidadPorHorario` o más citas encimadas.** La capacidad es la del perfil: 1 en el consultorio, 2 sillas en la barbería y 3 bahías en el taller.

Dónde vive:

| Parte | Archivo |
| --- | --- |
| Motor de disponibilidad | `encimadas()` en `src/dominio/disponibilidad.ts`, que usan `horariosLibres()` y `cabe()` |
| Repositorio en memoria | `revisarChoque` en `src/repo/memoria.ts`, que llama a `encimadas()` |
| Postgres | `crear_cita_si_cabe` y `actualizar_cita_si_cabe` en `supabase/migrations/0001_agenda.sql` (`inicio < p_fin and fin > p_inicio`) |

La regla es conservadora: cuenta toda cita que se encime con el horario propuesto, aunque esas citas no coincidan entre sí. Nunca sobreagenda, pero con citas escalonadas puede ofrecer menos horarios de los que permitiría la capacidad.

## La reserva atómica

`agendar` y `reprogramar` (`src/dominio/citas.ts`) revisan con `cabe()` el horario del negocio, los descansos, la duración y las políticas de anticipación. A `cabe()` no le pasan citas: **la capacidad la decide solo el repositorio, en una sola operación atómica.** Así no hay una ventana entre «revisé que está libre» y «lo guardé» en la que otra reserva se pueda meter.

- **En Postgres,** cada RPC toma `pg_advisory_xact_lock(hashtext(sesion_id || negocio_id))`. Ese candado serializa las reservas de la misma sesión y negocio hasta que termina la transacción, y el conteo de choques y el `insert` o `update` van dentro de esa misma transacción.
- **Al reprogramar,** `actualizar_cita_si_cabe` vuelve a leer la cita con el candado puesto (`for update`):
  - si mientras tanto otra petición la canceló, falla con `CITA_NO_ENCONTRADA` en vez de dar un falso éxito;
  - la cita nunca choca consigo misma (`id <> actual.id`).
- **En memoria,** el chequeo y la escritura van sin ningún `await` de por medio, así que en un solo hilo ninguna otra reserva se mete entre ellos.

Lo prueban `agendar en paralelo el mismo horario: solo uno gana` y `actualizar en paralelo dos citas al mismo horario: solo una gana`, en la suite compartida que corre contra los dos repositorios.

Las RPC de Postgres son `security definer` con `search_path` fijo, y solo `service_role` las puede ejecutar. Las tablas tienen RLS activada sin políticas y se les quitan los permisos de `anon` y `authenticated`: nada entra con la llave pública de Supabase.

## La sesión por cookie

- **La cookie.** `agenda_sesion` es un uuid v4 aleatorio, `httpOnly`, `SameSite=Lax`, `Secure` en producción, y dura 7 días: lo mismo que tarda la limpieza en borrar la sesión.
- **De dónde sale el id.** Solo de la cookie, nunca de la URL ni del cuerpo. Las pruebas de rutas mandan un `sesionId` ajeno en la consulta y en el cuerpo, y comprueban que se ignora.
- **Todo va acotado a la sesión.** Cada método del repositorio recibe la sesión y nunca devuelve ni toca citas o conversaciones de otra. Una conversación de otra sesión da 400, sin decir si existe.
- **El panel devuelve solo lo que muestra.** De cada cita: id, servicio, cliente, inicio, fin y estado. De cada conversación: id, modo y mensajes. Ni el id de sesión ni el historial de la API salen del servidor.
- **La limpieza.** El cron diario de Vercel (`vercel.json`, a las 09:00 UTC) llama a `GET /api/limpieza` con `Authorization: Bearer <CRON_SECRET>`, y la ruta compara los hashes en tiempo constante. `limpiar_sesiones_viejas` borra las sesiones de más de 7 días (en cascada, con sus citas, conversaciones y mensajes) y los contadores de más de 2 días.

## Límites

Todos se revisan **antes** de llamar a Claude. Las variables son opcionales y se validan como enteros positivos.

| Límite | Variable | Por defecto |
| --- | --- | --- |
| Mensajes por sesión y por hora | `AGENDA_LIMITE_SESION_HORA` | 20 |
| Mensajes por IP y por hora | `AGENDA_LIMITE_IP_HORA` | 40 |
| Mensajes por conversación (cliente y persona del negocio juntos) | `AGENDA_MAX_MENSAJES_CONVERSACION` | 30 |
| Conversaciones nuevas al día, entre todos los visitantes | `AGENDA_TOPE_DIARIO` | 300 |
| Sesiones nuevas por IP y por hora (cada una siembra citas en la base) | `AGENDA_LIMITE_SESIONES_IP_HORA` | 10 |
| Tokens de salida por llamada (`max_tokens`) | constante | 4000 |
| Vueltas de herramientas por mensaje | constante | 6 |
| Caracteres por mensaje | constante | 1000 |
| Caracteres del historial que se manda a Claude | constante | 120 000 |

Cómo funciona el limitador (`src/servicio/limites.ts`):

- **Ventanas fijas alineadas al reloj:** horas y días UTC.
- **En producción,** la tabla `contadores` con la RPC `incrementar_contador`. Es un solo `insert … on conflict do update … returning`, así que dos peticiones al mismo tiempo nunca leen el mismo conteo.
- **Las revisiones van en orden y cada una solo corre si pasó la anterior:** tamaño del historial y mensajes de la conversación (que no gastan contadores), después sesión, IP y tope diario. Así, un visitante rechazado por sesión no se acaba el tope diario de todos.
- **La IP nunca se guarda en claro:** la clave es el SHA-256 de `AGENDA_SAL_IP` más la IP. En producción la sal es obligatoria. La IP es dato personal según la LFPDPPP, y con una sal secreta el hash no se revierte probando todas las IPv4.
- **Lo que ve el cliente:** al llegar a un límite, un 429 con un texto amable y la liga a Forge Studio.

Por encima de todo esto está el límite de gasto mensual de la cuenta de Anthropic ([guía de despliegue](despliegue.md#5-límite-de-gasto-en-anthropic)).

## Cómo se usa la API de Claude

- **Solo con el SDK oficial** (`@anthropic-ai/sdk`), con `client.beta.messages.create`.
- **Modelo:** `ANTHROPIC_MODEL`, por defecto `claude-opus-5-5`. **Esfuerzo:** `output_config.effort` con `AGENDA_EFFORT`, por defecto `low`, porque es una conversación corta. No se manda `thinking`: en Opus 5.5 el pensamiento siempre está activo.
- **`tool_choice: auto`.** Forzar una herramienta (`any` o `tool`) da 400 en este modelo. El prompt indica cuándo usar cada herramienta y `strict: true` garantiza entradas válidas.
- **Fallbacks del servidor:** `betas: ["server-side-fallback-2026-07-01"]` con `fallbacks: "default"`. Si toda la cadena de modelos se niega (`refusal`), el bot pide perdón y ofrece pasar con una persona. Si la negativa llegó en la primera vuelta, el mensaje del visitante no entra al historial de la API, para que no se reenvíe y trabe la conversación.
- **Caché:**
  - una marca explícita al final del prompt del sistema cachea herramientas y prompt, que comparten todas las conversaciones del negocio;
  - el `cache_control` de nivel superior cachea además la conversación que va creciendo;
  - el prompt es determinista: sin fechas ni ids.
- **El historial solo crece.** Las respuestas del asistente se guardan con su `content` completo, sin quitar bloques de pensamiento ni de fallback. En Postgres la columna es `json` y no `jsonb`, porque `jsonb` reordena las llaves y un `tool_use` reenviado con otro orden rompe la caché.
- **Sin llave, en desarrollo:** `responderDev` usa las mismas herramientas reales (disponibilidad, agendar y pasar a una persona) con un guion fijo. El flujo de la demo funciona igual, sin red, y cada respuesta lleva la marca «demo sin IA».

## Zona horaria

- **Cada perfil tiene su zona IANA,** por defecto `America/Mexico_City`.
- **Las citas se guardan en UTC** (ISO 8601 con `Z`) y se muestran en la hora local del negocio.
- **Sin librerías de fechas:** `partesLocales` y `aUtc` (`src/dominio/tiempo.ts`) usan `Intl.DateTimeFormat`.
- **Probado:** un horario de 18:00 a 20:00 en la Ciudad de México cae de 00:00 a 02:00 UTC del día siguiente, y sale en el día local correcto.
- **Atajo documentado en el código:** en zonas con horario de verano, una hora que no existe por el salto de primavera cae en la hora anterior. Hoy no afecta a ningún perfil, porque la Ciudad de México ya no cambia de horario.

## Por qué no es un bot de uso general

- **Por diseño.** El producto es la atención de un negocio. Un chatbot que contesta de todo se ve genérico, gasta más y se desvía del objetivo, que es que el cliente agende.
- **Por regla de la plataforma.** La fase 2 conecta el bot a WhatsApp. Los términos de WhatsApp Business Solution de Meta, vigentes desde el 15 de enero de 2026, restringen los asistentes de IA de uso general en la plataforma, mientras que los bots de negocio para atención, citas o seguimiento de pedidos siguen permitidos ([TechCrunch, 18 de octubre de 2025](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform/)). Este bot es de los segundos: solo atiende las citas del negocio.
- **Cómo se cumple en el código:**
  - el prompt solo describe el negocio y le pide al modelo regresar al tema con amabilidad;
  - las herramientas solo leen y cambian citas de ese negocio en la sesión del visitante;
  - el modelo nunca escribe en la base, y todo lo que propone se valida (horario, políticas y capacidad), diga lo que diga el visitante («ignora tus reglas», «agéndame a las 3 a. m.»);
  - si un dato no está en el perfil ni en las herramientas, el prompt le pide no inventarlo y ofrecer pasar con una persona.

## Fase 2: WhatsApp

El servicio de chat (`manejarMensaje`, `mensajeHumano`, `devolverAlBot`) no sabe de HTTP ni de cookies: recibe una sesión, una IP y un texto, y devuelve la respuesta. El canal de WhatsApp sería otro adaptador junto a `app/api/`: un webhook de la API de WhatsApp Cloud que reciba el mensaje, derive la sesión del número y llame al mismo servicio. Eso todavía no está hecho; queda para la fase 2, junto con el video de la demo.
