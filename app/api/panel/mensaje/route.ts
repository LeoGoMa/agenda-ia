import { z } from "zod";
import { mensajeHumano } from "@/src/servicio/chat";
import { conSesion, cuerpoDe, ipDe, solicitudInvalida } from "@/src/web/rutas";

const esquema = z.object({ conversacionId: z.string(), texto: z.string() });

/** Una persona del negocio contesta desde el panel. 200 `{ ok: true }`; 400 o 429 `{ respuesta }`. */
export async function POST(peticion: Request) {
  return conSesion(peticion, "POST /api/panel/mensaje", async (sesionId, deps) => {
    const cuerpo = await cuerpoDe(peticion, esquema);
    if (!cuerpo) return solicitudInvalida();
    const resultado = await mensajeHumano(deps, { sesionId, ip: ipDe(peticion), ...cuerpo });
    if (resultado.estado === 200) return Response.json({ ok: true });
    return Response.json({ respuesta: resultado.respuesta }, { status: resultado.estado });
  });
}
