import { createHash, timingSafeEqual } from "node:crypto";
import { obtenerDeps } from "@/src/servicio/deps";
import { sinFugas } from "@/src/web/rutas";

const resumen = (texto: string) => createHash("sha256").update(texto).digest();

/**
 * Borra las sesiones de más de 7 días. La llama el cron diario de Vercel (vercel.json), que manda
 * `Authorization: Bearer <CRON_SECRET>`. Sin CRON_SECRET configurado responde 401 a todo.
 */
export async function GET(peticion: Request) {
  const autorizacion = peticion.headers.get("authorization") ?? "";
  const secreto = process.env.CRON_SECRET;
  // Hashes del mismo largo comparados en tiempo constante: la respuesta no revela cuánto del secreto coincide.
  if (!secreto || !timingSafeEqual(resumen(autorizacion), resumen(`Bearer ${secreto}`))) {
    return Response.json({ error: "No autorizado." }, { status: 401 });
  }
  return sinFugas("GET /api/limpieza", async () => Response.json({ borradas: await obtenerDeps().limpiar() }));
}
