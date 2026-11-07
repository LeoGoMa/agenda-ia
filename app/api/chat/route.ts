import { z } from "zod";
import { manejarMensaje } from "@/src/servicio/chat";
import { conSesion, cuerpoDe, ipDe, solicitudInvalida } from "@/src/web/rutas";

const esquema = z.object({ negocioId: z.string(), texto: z.string() });

/** Segundos: un mensaje puede llevar hasta 6 vueltas de herramientas con Claude. */
export const maxDuration = 60;

/** Un mensaje del visitante. Responde `{ respuesta, modo }` con 200, 400 o 429. */
export async function POST(peticion: Request) {
  return conSesion(peticion, "POST /api/chat", async (sesionId, deps) => {
    const cuerpo = await cuerpoDe(peticion, esquema);
    if (!cuerpo) return solicitudInvalida();
    const { estado, respuesta, modo } = await manejarMensaje(deps, { ...cuerpo, sesionId, ip: ipDe(peticion) });
    return Response.json({ respuesta, modo }, { status: estado });
  });
}
