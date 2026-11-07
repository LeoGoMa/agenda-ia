import { z } from "zod";
import { conSesion, cuerpoDe, solicitudInvalida } from "@/src/web/rutas";

const esquema = z.object({ conversacionId: z.string(), modo: z.enum(["bot", "humano"]) });

/** «Tomar el chat» (`humano`) o «Devolver al bot» (`bot`). Responde `{ ok: true }`. */
export async function POST(peticion: Request) {
  return conSesion(peticion, "POST /api/panel/modo", async (sesionId, { repo }) => {
    const cuerpo = await cuerpoDe(peticion, esquema);
    if (!cuerpo) return solicitudInvalida();
    // Acotado a la sesión: una conversación de otra lanza DATOS_INVALIDOS (400).
    await repo.conversaciones.cambiarModo(sesionId, cuerpo.conversacionId, cuerpo.modo);
    return Response.json({ ok: true });
  });
}
