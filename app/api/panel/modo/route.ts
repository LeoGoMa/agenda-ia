import { z } from "zod";
import { devolverAlBot } from "@/src/servicio/chat";
import { conSesion, cuerpoDe, solicitudInvalida } from "@/src/web/rutas";

const esquema = z.object({ conversacionId: z.string(), modo: z.enum(["bot", "humano"]) });

/** «Tomar el chat» (`humano`) o «Devolver al bot» (`bot`). Responde `{ ok: true }`. */
export async function POST(peticion: Request) {
  return conSesion(peticion, "POST /api/panel/modo", async (sesionId, deps) => {
    const cuerpo = await cuerpoDe(peticion, esquema);
    if (!cuerpo) return solicitudInvalida();
    const { conversacionId, modo } = cuerpo;
    // Un solo camino por modo, acotado a la sesión: una conversación de otra lanza DATOS_INVALIDOS (400).
    if (modo === "bot") await devolverAlBot(deps, { sesionId, conversacionId });
    else await deps.repo.conversaciones.cambiarModo(sesionId, conversacionId, "humano");
    return Response.json({ ok: true });
  });
}
