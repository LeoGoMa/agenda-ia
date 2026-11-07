import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { configDesdeEntorno, responder as responderClaude } from "../bot/responder";
import { responderDev } from "../bot/responderDev";
import { crearRepoMemoria } from "../repo/memoria";
import { crearRepoSupabase } from "../repo/supabase";
import { almacenSupabase } from "./almacenSupabase";
import type { DepsChat, Responder } from "./chat";
import { almacenMemoria, crearLimitador, limitesDesdeEntorno, type AlmacenContadores } from "./limites";
import { sembrarCitas } from "./siembra";

export interface Deps extends DepsChat {
  /**
   * Crea la fila de `sesiones` si falta (citas y conversaciones la referencian) y, solo la primera vez,
   * siembra sus citas ficticias para que la agenda se vea ocupada.
   */
  asegurarSesion(sesionId: string): Promise<void>;
  /** Borra las sesiones de más de 7 días con todo lo suyo y devuelve cuántas borró. */
  limpiar(): Promise<number>;
}

type Entorno = Record<string, string | undefined>;
type Datos = Pick<Deps, "repo" | "limpiar"> & {
  almacen: AlmacenContadores;
  /** Crea la fila de `sesiones` si falta; true solo si la creó esta llamada. */
  crearSesion(id: string): Promise<boolean>;
};

/** Supabase con las dos variables; sin ellas, memoria (solo fuera de producción). */
function armarDatos(env: Entorno, produccion: boolean): Datos {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const cliente = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const fallo = (error: { message: string }) => new Error(`Supabase: ${error.message}`, { cause: error });
    return {
      repo: crearRepoSupabase(cliente),
      almacen: almacenSupabase(cliente),
      async crearSesion(id) {
        // Con ignoreDuplicates es un insert ... on conflict do nothing: solo devuelve la fila si la insertó.
        const { data, error } = await cliente.from("sesiones").upsert({ id }, { onConflict: "id", ignoreDuplicates: true }).select("id");
        if (error) throw fallo(error);
        return data.length > 0;
      },
      async limpiar() {
        const { data, error } = await cliente.rpc("limpiar_sesiones_viejas");
        if (error) throw fallo(error);
        return data as number;
      },
    };
  }
  if (produccion) {
    throw new Error("Faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY: en producción no se usa el repositorio en memoria (ver .env.example)");
  }
  const sesiones = new Set<string>();
  return {
    repo: crearRepoMemoria(),
    almacen: almacenMemoria(),
    async crearSesion(id) {
      if (sesiones.has(id)) return false;
      sesiones.add(id);
      return true;
    },
    limpiar: async () => 0,
  };
}

/** Claude con `ANTHROPIC_API_KEY`; sin ella, el responder guionado sin red (solo fuera de producción). */
function armarResponder(env: Entorno, produccion: boolean): Responder {
  if (env.ANTHROPIC_API_KEY) {
    const cliente = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const config = configDesdeEntorno(env);
    return (entrada) => responderClaude({ ...entrada, cliente, config });
  }
  if (produccion) {
    throw new Error("Falta ANTHROPIC_API_KEY: en producción no se usa el responder de demostración (ver .env.example)");
  }
  return responderDev;
}

/**
 * Arma las dependencias a partir del entorno. En producción, sin Supabase, sin la llave de Claude o sin
 * AGENDA_SAL_IP lanza un error que dice qué falta (y la ruta responde 500 genérico).
 */
export function armarDeps(env: Entorno = process.env): Deps {
  const produccion = env.NODE_ENV === "production";
  const limites = limitesDesdeEntorno(env);
  const { almacen, crearSesion, ...datos } = armarDatos(env, produccion);
  const responder = armarResponder(env, produccion);
  if (env.NODE_ENV === "development") {
    const repo = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY ? "Supabase" : "memoria";
    console.info(`Agenda IA: datos en ${repo}, responder ${responder === responderDev ? "de demostración sin IA" : "de Claude"}.`);
  }
  const ahora = () => new Date();
  return {
    ...datos,
    async asegurarSesion(sesionId) {
      if (await crearSesion(sesionId)) await sembrarCitas(datos.repo, sesionId, ahora());
    },
    limitador: crearLimitador(almacen, limites),
    responder,
    ahora,
  };
}

// En desarrollo, cada ruta y cada recarga en caliente pueden evaluar este módulo por separado; en globalThis
// queda una sola copia, así el chat y el panel ven el mismo repositorio en memoria.
const compartido = globalThis as typeof globalThis & { agendaDeps?: Deps };

/** Las dependencias, armadas en la primera petición: nunca al importar el módulo ni durante `next build`. */
export function obtenerDeps(): Deps {
  return (compartido.agendaDeps ??= armarDeps());
}

/** Para las pruebas: pone dependencias armadas a mano, o `undefined` para volver a armarlas del entorno. */
export function ponerDeps(deps: Deps | undefined): void {
  compartido.agendaDeps = deps;
}
