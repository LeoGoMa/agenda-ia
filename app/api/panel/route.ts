import { obtenerPerfil } from "@/src/dominio/perfiles";
import { aUtc, partesLocales } from "@/src/dominio/tiempo";
import { conSesion, solicitudInvalida } from "@/src/web/rutas";

const DIA = 24 * 60 * 60_000;
const DIAS_DEL_PANEL = 14;

/**
 * Panel del negocio para la sesión de la cookie: citas de cualquier estado de hoy y los 13 días siguientes
 * (días locales del negocio, desde la medianoche: las de hoy que ya pasaron también salen) y sus conversaciones.
 * Solo devuelve lo que muestra el panel: ni el id de sesión ni el historial de la API.
 */
export async function GET(peticion: Request) {
  return conSesion(peticion, "GET /api/panel", async (sesionId, { repo, ahora }) => {
    const negocioId = new URL(peticion.url).searchParams.get("negocioId");
    if (!negocioId) return solicitudInvalida();
    const { id, zonaHoraria } = obtenerPerfil(negocioId);
    const hoy = partesLocales(ahora(), zonaHoraria).fecha;
    const tope = new Date(Date.parse(`${hoy}T00:00:00Z`) + DIAS_DEL_PANEL * DIA).toISOString().slice(0, 10);
    const [citas, conversaciones] = await Promise.all([
      repo.citas.listar(sesionId, id, aUtc(hoy, "00:00", zonaHoraria).toISOString(), aUtc(tope, "00:00", zonaHoraria).toISOString()),
      repo.conversaciones.listar(sesionId, id),
    ]);
    return Response.json({
      citas: citas.map(({ id, servicioId, cliente, inicio, fin, estado }) => ({ id, servicioId, cliente, inicio, fin, estado })),
      conversaciones: conversaciones.map(({ id, modo, mensajes }) => ({ id, modo, mensajes })),
    });
  });
}
