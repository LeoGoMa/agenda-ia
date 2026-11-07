import type { z } from "zod";
import { ErrorDominio } from "../dominio/tipos";
import { obtenerDeps, type Deps } from "../servicio/deps";
import { sesionDe } from "./sesion";

// Los errores de la petición (400, 401, 500 y el 429 por sesiones nuevas) responden `{ error }`; las respuestas
// del servicio de chat (200, 400 por texto inválido y 429) traen `respuesta`, con el trato del negocio.
const TEXTOS = {
  sesionInvalida: "La sesión no es válida o ya expiró. Recarga la página para empezar una nueva.",
  solicitudInvalida: "La solicitud no es válida.",
  errorInterno: "Algo salió mal de nuestro lado. Inténtalo de nuevo en un momento.",
  limiteSesiones: "Llegaste al límite de la demo por ahora. Si quieres un bot así para tu negocio, escríbele a Forge Studio.",
};

export const solicitudInvalida = (status = 400) => Response.json({ error: TEXTOS.solicitudInvalida }, { status });

/**
 * El primer valor de x-forwarded-for. Es confiable solo en Vercel, que lo reescribe con la IP del cliente;
 * detrás de otro proxy que no lo reescriba, el visitante lo inventa y se salta los límites por IP.
 */
export const ipDe = (peticion: Request) => peticion.headers.get("x-forwarded-for")?.split(",")[0].trim() || "desconocida";

/** `application/json`, con o sin parámetros como `; charset=utf-8`. */
const esJson = (peticion: Request) => peticion.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";

/** El cuerpo JSON validado con `esquema` (los campos de más se descartan); null si no es JSON o no cumple. */
export async function cuerpoDe<T>(peticion: Request, esquema: z.ZodType<T>): Promise<T | null> {
  const datos = esquema.safeParse(await peticion.json().catch(() => undefined));
  return datos.success ? datos.data : null;
}

/**
 * Lo único que se registra de un error: nombre, código (el suyo o el de Postgres en su causa) y mensaje.
 * Ni la causa completa, ni los `details` o `hint` de Postgres, ni la pila: pueden traer datos de la fila o del visitante.
 */
function resumenError(e: unknown) {
  if (!(e instanceof Error)) return { nombre: typeof e, mensaje: String(e) };
  const codigoDe = (x: unknown) => (typeof x === "object" && x !== null ? (x as { codigo?: unknown; code?: unknown }) : {});
  return { nombre: e.name, codigo: codigoDe(e).codigo ?? codigoDe(e).code ?? codigoDe(e.cause).code, mensaje: e.message };
}

/** Corre `manejar`; un dato inexistente da 400 y lo inesperado un 500 genérico, sin detalles internos. */
export async function sinFugas(ruta: string, manejar: () => Promise<Response>): Promise<Response> {
  try {
    return await manejar();
  } catch (e) {
    // Negocio o conversación inexistentes, o de otra sesión: no se dice cuál.
    if (e instanceof ErrorDominio && e.codigo === "DATOS_INVALIDOS") return solicitudInvalida();
    // Solo el resumen del error, nunca la petición: el registro no guarda lo que escribió el visitante.
    console.error(`${ruta}: error inesperado`, resumenError(e));
    return Response.json({ error: TEXTOS.errorInterno }, { status: 500 });
  }
}

/**
 * Para las rutas del chat y el panel. Sin cookie de sesión válida responde 401, y un POST que no es JSON, 415.
 * Si no, crea la fila de la sesión (con sus citas ficticias la primera vez; 429 si la IP pasó el tope de sesiones
 * nuevas) y llama a `manejar` con las dependencias. La petición se lee fuera del try: en `next build`, leerla lanza
 * la señal con que Next deja la ruta como dinámica; atrapada, saldría como un falso error inesperado.
 */
export async function conSesion(
  peticion: Request,
  ruta: string,
  manejar: (sesionId: string, deps: Deps) => Promise<Response>,
): Promise<Response> {
  const sesionId = sesionDe(peticion);
  if (!sesionId) return Response.json({ error: TEXTOS.sesionInvalida }, { status: 401 });
  if (peticion.method === "POST" && !esJson(peticion)) return solicitudInvalida(415);
  return sinFugas(ruta, async () => {
    const deps = obtenerDeps();
    if (!(await deps.asegurarSesion(sesionId, ipDe(peticion)))) {
      return Response.json({ error: TEXTOS.limiteSesiones }, { status: 429 });
    }
    return manejar(sesionId, deps);
  });
}
