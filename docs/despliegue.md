# Guía de despliegue

Para Leo: cómo publicar Agenda IA en Vercel con Supabase y la API de Claude, de cero a la demo en vivo. Calcula una hora la primera vez.

## 1. Antes de empezar

- **Las llaves nunca van en un chat,** ni con Claude, ni con un cliente, ni con nadie, y tampoco en el repo. Van solo en tres lugares:
  - la página de cada servicio, donde se crean;
  - las variables de entorno de Vercel;
  - en tu máquina, `.env.local` o `.env.prueba`, que git ignora.
- **Si algo falla y pides ayuda,** comparte el mensaje de error, nunca el valor de una llave.
- **Necesitas cuentas en** [Supabase](https://supabase.com), [Vercel](https://vercel.com) y la [consola de Anthropic](https://console.anthropic.com), y el repo en GitHub (`LeoGoMa/agenda-ia`).
- **Variables que se configuran:** las mismas de [`.env.example`](../.env.example).

## 2. Supabase: proyecto y migración

1. **Crea un proyecto nuevo** en Supabase y guarda la contraseña de la base en tu gestor de contraseñas: la app no la usa, pero Supabase la pide.
   - Como región, elige una cercana a donde corren las funciones de Vercel. Por defecto Vercel usa Washington, D. C. (`iad1`), así que conviene «East US (North Virginia)».
2. **Corre la migración.** En el panel del proyecto, abre **SQL Editor**, crea una consulta nueva, pega **todo** el contenido de [`supabase/migrations/0001_agenda.sql`](../supabase/migrations/0001_agenda.sql) y presiona **Run**. Debe terminar sin errores.
3. **Revisa que quedó todo:**
   - En **Table Editor** aparecen cinco tablas: `sesiones`, `citas`, `conversaciones`, `mensajes` y `contadores`.
   - En **Database → Functions** aparecen `crear_cita_si_cabe`, `actualizar_cita_si_cabe`, `incrementar_contador` y `limpiar_sesiones_viejas`.
4. **Busca los dos datos que pide la app.** Están en la configuración de la API del proyecto (**Project Settings → API** o **API Keys**, según la versión del panel):
   - **Project URL** → va en `SUPABASE_URL`.
   - **La llave del servidor** → va en `SUPABASE_SERVICE_ROLE_KEY`. Es la `service_role` o, en el panel nuevo, la «secret key» que empieza con `sb_secret_`.

   Esta llave se salta la seguridad de las tablas: solo va en el servidor (Vercel o tu `.env.local`), nunca en el navegador. La llave pública (`anon` o `publishable`) no se usa.

En el plan gratis, Supabase pausa los proyectos que pasan días sin actividad. El cron diario de limpieza hace una consulta al día; aun así, si la demo empieza a responder 500, revisa en Supabase que el proyecto no esté pausado.

## 3. Pruebas de integración, con un proyecto de PRUEBA

Las pruebas de `tests/integracion/` corren contra un Postgres real lo mismo que las pruebas en memoria:

- citas en paralelo y regla de choque;
- que las RPC devuelvan la cita como objeto;
- que el historial vuelva con las llaves en el mismo orden;
- la siembra, los contadores y la limpieza.

Hasta hoy no se han corrido contra Supabase real.

**Usa un proyecto de prueba, no el de la demo:** las pruebas crean y borran sesiones, y la de limpieza borra cualquier sesión de más de 7 días.

1. Crea un segundo proyecto en Supabase (por ejemplo `agenda-ia-pruebas`) y corre la migración igual que en el paso 2.
2. En la raíz del repo, crea un archivo `.env.prueba` con las dos variables de ese proyecto. Git lo ignora, porque `.gitignore` excluye todo `.env*` salvo `.env.example`:

   ```
   SUPABASE_URL=
   SUPABASE_SERVICE_ROLE_KEY=
   ```

3. Córrelas. Node carga el archivo, así las llaves no quedan en el historial de la terminal:

   ```bash
   node --env-file=.env.prueba node_modules/vitest/vitest.mjs run tests/integracion
   ```

   Deben pasar 23 pruebas. Si en vez de eso dice «Integración con Supabase saltada», el archivo no tiene las dos variables.
4. Revisa que `git status` no muestre `.env.prueba`.

Si una prueba falla, guarda la salida y pide ayuda con ella (sin las llaves). Las que más pueden fallar son las que dependen de cómo responde PostgREST: el orden de las llaves del json y los errores `P0001`.

## 4. Llave de Anthropic

1. En la consola de Anthropic, en **Settings → API Keys**, crea una llave **solo para este proyecto**, por ejemplo `agenda-ia-produccion`. Así la puedes revocar sin tocar nada más.
2. Cópiala directo al campo de Vercel del paso 7. No la guardes en un archivo del repo ni la pegues en un chat.

**Modelo.** Por defecto la app usa `claude-opus-5-5` con esfuerzo `low` (variables `ANTHROPIC_MODEL` y `AGENDA_EFFORT`; déjalas vacías para usar esos valores). Cambiar de modelo es decisión tuya, pero no basta con la variable. El bot manda los fallbacks del lado del servidor (`fallbacks: "default"`), y no todos los modelos los aceptan: Claude Haiku 5.5, por ejemplo, no los tiene. Cambiar a Haiku requiere ajustar `src/bot/responder.ts` y probarlo antes en local.

## 5. Límite de gasto en Anthropic

La app ya tiene sus propios límites (mensajes por sesión, por IP, por conversación y conversaciones nuevas por día), pero el último seguro es el límite de gasto de la cuenta.

1. En la consola de Anthropic, abre la configuración de límites (**Settings → Limits**; si el menú cambió, busca «spend limit»).
2. Pon un **límite mensual de gasto**. Si tu cuenta permite crear un workspace solo para la demo, créalo, ponle su propio límite y crea ahí la llave del paso 4: así la demo nunca se come el presupuesto de otros proyectos.
3. Empieza bajo (por ejemplo, US$20 al mes) y revisa el uso la primera semana.

**Precios** (noviembre de 2026; confírmalos en la página de precios de Anthropic):

| Modelo | Entrada, por millón de tokens | Salida, por millón de tokens |
| --- | --- | --- |
| Claude Opus 5.5 | US$4 | US$20 |
| Claude Haiku 5.5, con prompts de hasta 100 000 tokens | US$0.10 | US$0.50 |
| Claude Haiku 5.5, con prompts de más de 100 000 tokens | US$0.50 | US$2.50 |

- Cada mensaje del cliente hace de 1 a 6 llamadas.
- Cada llamada manda el prompt, las herramientas y el historial. La mayor parte sale de la caché, que cuesta mucho menos.

## 6. Secretos propios: `CRON_SECRET` y `AGENDA_SAL_IP`

Son dos textos largos y aleatorios que inventas tú:

- **`CRON_SECRET`** protege la ruta de limpieza. Vercel lo manda solo al correr el cron.
- **`AGENDA_SAL_IP`** es la sal con la que las IP se guardan como hash. En producción es obligatoria: sin ella la API responde 500.

Para generar cada uno, corre esto en tu terminal (una vez por secreto):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Copia cada valor directo a su variable en Vercel y no lo guardes en otro lado. Si algún día cambias `AGENDA_SAL_IP`, solo se reinician los contadores de los límites; no se pierde nada más.

## 7. Vercel: proyecto y variables

1. En Vercel: **Add New → Project** y elige el repo `LeoGoMa/agenda-ia`. Detecta Next.js solo; no cambies el comando de build. La versión de Node sale de `engines` en `package.json` (22 o más nueva).
2. **Antes del primer despliegue,** abre **Environment Variables** y agrega todas las de `.env.example`. En cada una marca **solo Production** y desmarca **Preview** y **Development**: así `vercel env pull` nunca trae las llaves de producción a tu `.env.local`. Para probar en local usa el proyecto de pruebas (paso 3).

   | Variable | Valor |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | La llave del paso 4 |
   | `ANTHROPIC_MODEL` | Vacía (usa `claude-opus-5-5`) o el id de otro modelo; ver el paso 4 |
   | `AGENDA_EFFORT` | Vacía (usa `low`) |
   | `SUPABASE_URL` | La Project URL del paso 2 (el proyecto de la demo, no el de pruebas) |
   | `SUPABASE_SERVICE_ROLE_KEY` | La llave del servidor del paso 2 |
   | `CRON_SECRET` | El primer secreto del paso 6 |
   | `AGENDA_SAL_IP` | El segundo secreto del paso 6 |
   | `AGENDA_TOPE_DIARIO` | Vacía (300 conversaciones nuevas al día) o tu número |
   | `AGENDA_LIMITE_SESION_HORA` | Vacía (20) |
   | `AGENDA_LIMITE_IP_HORA` | Vacía (40) |
   | `AGENDA_MAX_MENSAJES_CONVERSACION` | Vacía (30) |
   | `AGENDA_LIMITE_SESIONES_IP_HORA` | Vacía (10) |

   Las de límites puedes no crearlas: vacías o ausentes toman el valor por defecto.

   **Preview:** si también quieres despliegues de vista previa (uno por rama), dales sus propias variables, con el proyecto de Supabase de pruebas y una llave aparte. Si no las configuras, las vistas previas responden 500, y está bien.
3. **Despliega** (**Deploy**). Si cambias una variable después, hace falta volver a desplegar (**Deployments → Redeploy**) para que tome efecto.
4. **El cron** de limpieza ya viene en `vercel.json`: todos los días a las 09:00 UTC (03:00 en la Ciudad de México). Aparece en **Settings → Cron Jobs**. Vercel le manda `CRON_SECRET` solo.

## 8. Revisar el despliegue

Con la URL de Vercel abierta:

1. **Inicio:** se ven los tres negocios y la franja «Negocio ficticio · Datos de demostración».
2. **Supabase y siembra:** abre un negocio. En el panel aparecen de 3 a 6 citas ficticias.
3. **Claude:** escribe «¿Qué horarios tienen mañana?». La respuesta **no** debe llevar la etiqueta «demo sin IA».
4. **Agendar:** agenda una cita con un nombre ficticio y un teléfono `55 0000 0099`. Debe salir en el panel.
5. **Paso a persona:** pide hablar con una persona. El panel pasa a «Modo: Persona». Contesta desde ahí y luego presiona «Devolver al bot».
6. **Datos guardados:** en Supabase (**Table Editor**), `citas` tiene filas. Las claves de `contadores` tienen la forma `sesion:<uuid>`, `ip:<hash>`, `sesion-nueva:<hash>` y `conversaciones-nuevas`: las de `ip:` y `sesion-nueva:` llevan un hash largo, y ninguna contiene una IP legible.
7. **Errores:** en Vercel (**Logs**) no hay errores. Si hay un 500, el registro dice qué falta, por ejemplo «Falta AGENDA_SAL_IP…».
8. **Cron:** en **Settings → Cron Jobs**, corre el de `/api/limpieza` a mano. Debe responder `{"borradas":0}`; un 401 significa que falta `CRON_SECRET`.
9. **Caché:** en la consola de Anthropic se ven las llamadas. Tras varios mensajes en la misma conversación, los tokens leídos de caché deben ser más que cero.

Si todo sale bien, cambia en los dos README la línea de la demo («_(pending deployment)_» en `README.md` y «_(pendiente de desplegar)_» en `README.es.md`) por la URL, y sube el cambio.

## 9. Desarrollo local

- **Sin variables,** `npm run dev` corre todo en memoria, con el responder guionado («demo sin IA»), sin red y sin costo. Es lo normal para trabajar en la interfaz.
- **Para probar con Claude,** pon tu llave en `.env.local` (copia de `.env.example`). Cada mensaje cuesta; los límites de la app aplican igual.
- **Para probar con Supabase,** usa el proyecto de **pruebas**, nunca el de la demo.
- **Reinicia `npm run dev` después de cambiar `.env.local`.** Las dependencias (repositorio, limitador y cliente de Claude) se arman en la primera petición y quedan guardadas en `globalThis`, que sobrevive a la recarga en caliente. Sin reiniciar, la app sigue con la configuración vieja.
- **Antes de subir cambios:**

  ```bash
  npx vitest run
  npx tsc --noEmit
  npm run lint
  npm run build
  ```

## 10. Si una llave se filtra

Si una llave llegó a un chat, a un commit o a una captura, cámbiala de inmediato:

- **Anthropic:** revoca la llave en **Settings → API Keys** y crea otra.
- **Supabase:** genera una llave del servidor nueva en la configuración de la API del proyecto (y revoca la anterior).
- **`CRON_SECRET` o `AGENDA_SAL_IP`:** genera otro valor como en el paso 6.

Después, cambia el valor en Vercel y vuelve a desplegar. Si la llave llegó a un commit, cambiarla es lo urgente; borrarla del historial de git no basta, porque ya pudo copiarse.
