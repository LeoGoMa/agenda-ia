import type { Cita } from "../dominio/tipos";
import type { Conversacion } from "../repo/tipos";
import { textoDeAviso } from "./formato";

const SIN_CONEXION = "No hay conexión. Revisa tu internet e inténtalo de nuevo.";

/** Lo que la página manda del perfil: solo lo que se muestra. */
export interface PerfilVista {
  id: string;
  nombre: string;
  giro: string;
  zonaHoraria: string;
  servicios: { id: string; nombre: string }[];
}

/** Lo que devuelve GET /api/panel. */
export interface DatosPanel {
  citas: Pick<Cita, "id" | "servicioId" | "cliente" | "inicio" | "fin" | "estado">[];
  conversaciones: Pick<Conversacion, "id" | "modo" | "mensajes">[];
}

export interface Resultado {
  ok: boolean;
  estado: number;
  cuerpo: unknown;
  /** Para mostrar si algo salió mal: `respuesta` del servicio o `error` de la ruta. */
  texto: string;
}

/** GET sin cuerpo y POST con JSON. Nunca lanza: sin red responde con estado 0. */
export async function pedir(url: string, cuerpo?: unknown): Promise<Resultado> {
  try {
    const r = await fetch(
      url,
      cuerpo === undefined
        ? { cache: "no-store" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) },
    );
    const datos: unknown = await r.json().catch(() => null);
    return { ok: r.ok, estado: r.status, cuerpo: datos, texto: textoDeAviso(datos) };
  } catch {
    return { ok: false, estado: 0, cuerpo: null, texto: SIN_CONEXION };
  }
}
