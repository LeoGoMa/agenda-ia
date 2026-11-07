import type { z } from "zod";
import { ErrorDominio } from "../dominio/tipos";
import { obtenerDeps, type Deps } from "../servicio/deps";
import { sesionDe } from "./sesion";

// Los errores de la petición (400, 401, 500) responden `{ error }`; las respuestas del servicio de chat
// (200, 400 por texto inválido y 429) traen `respuesta`, con el trato del negocio.
const TEXTOS = {
  sesionInvalida: "La sesión no es válida o ya expiró. Recarga la página para empezar una nueva.",
  solicitudInvalida: "La solicitud no es válida.",
  errorInterno: "Algo salió mal de nuestro lado. Inténtalo de nuevo en un momento.",
};

export const solicitudInvalida = () => Response.json({ error: TEXTOS.solicitudInvalida }, { status: 400 });

/** El primer valor de x-forwarded-for: en Vercel, la IP del cliente. */
export const ipDe = (peticion: Request) => peticion.headers.get("x-forwarded-for")?.split(",")[0].trim() || "desconocida";

/** El cuerpo JSON validado con `esquema` (los campos de más se descartan); null si no es JSON o no cumple. */
export async function cuerpoDe<T>(peticion: Request, esquema: z.ZodType<T>): Promise<T | null> {
  const datos = esquema.safeParse(await peticion.json().catch(() => undefined));
  return datos.success ? datos.data : null;
}

/** Corre `manejar`; un dato inexistente da 400 y lo inesperado un 500 genérico, sin detalles internos. */
export async function sinFugas(ruta: string, manejar: () => Promise<Response>): Promise<Response> {
  try {
    return await manejar();
  } catch (e) {
    // Negocio o conversación inexistentes, o de otra sesión: no se dice cuál.
    if (e instanceof ErrorDominio && e.codigo === "DATOS_INVALIDOS") return solicitudInvalida();
    // Solo el error, nunca la petición: el registro no guarda lo que escribió el visitante.
    console.error(`${ruta}: error inesperado`, e);
    return Response.json({ error: TEXTOS.errorInterno }, { status: 500 });
  }
}

/**
 * Para las rutas del chat y el panel. Sin cookie de sesión válida responde 401. Si no, crea la fila de la sesión
 * (con sus citas ficticias la primera vez) y llama a `manejar` con las dependencias. La cookie se lee fuera del
 * try: en `next build`, leer la petición
 * lanza la señal con que Next deja la ruta como dinámica; atrapada, saldría como un falso error inesperado.
 */
export async function conSesion(
  peticion: Request,
  ruta: string,
  manejar: (sesionId: string, deps: Deps) => Promise<Response>,
): Promise<Response> {
  const sesionId = sesionDe(peticion);
  if (!sesionId) return Response.json({ error: TEXTOS.sesionInvalida }, { status: 401 });
  return sinFugas(ruta, async () => {
    const deps = obtenerDeps();
    await deps.asegurarSesion(sesionId);
    return manejar(sesionId, deps);
  });
}
