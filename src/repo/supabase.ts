import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { ErrorDominio, type Cita } from "../dominio/tipos";
import type { Conversacion, MensajeVisible, Repositorio } from "./tipos";

/** Filas tal como las devuelve PostgREST (supabase/migrations/0001_agenda.sql). */
interface FilaCita {
  id: string;
  sesion_id: string;
  negocio_id: string;
  servicio_id: string;
  cliente_nombre: string;
  cliente_telefono: string;
  inicio: string;
  fin: string;
  estado: Cita["estado"];
  creada: string;
}

interface FilaConversacion {
  id: string;
  sesion_id: string;
  negocio_id: string;
  modo: Conversacion["modo"];
  historial_api: unknown[];
  version_prompt: string | null;
  mensajes_visitante: number;
  mensajes: { rol: MensajeVisible["rol"]; texto: string; creado: string }[];
}

const CONVERSACION =
  "id, sesion_id, negocio_id, modo, historial_api, version_prompt, mensajes_visitante, mensajes(rol, texto, creado)";
// Los ids son uuid en Postgres; otro texto (de la petición o del modelo) daría un error de tipo en vez de «no existe».
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgREST devuelve "2026-11-10T15:00:00+00:00"; el contrato pide ISO 8601 UTC con Z y milisegundos.
const iso = (fecha: string) => new Date(fecha).toISOString();

const aCita = (f: FilaCita): Cita => ({
  id: f.id,
  sesionId: f.sesion_id,
  negocioId: f.negocio_id,
  servicioId: f.servicio_id,
  cliente: { nombre: f.cliente_nombre, telefono: f.cliente_telefono },
  inicio: iso(f.inicio),
  fin: iso(f.fin),
  estado: f.estado,
  creadaEn: iso(f.creada),
});

const aConversacion = (f: FilaConversacion): Conversacion => ({
  id: f.id,
  sesionId: f.sesion_id,
  negocioId: f.negocio_id,
  modo: f.modo,
  mensajes: f.mensajes.map((m) => ({ rol: m.rol, texto: m.texto, creadoEn: iso(m.creado) })),
  historialApi: f.historial_api,
  versionPrompt: f.version_prompt,
  mensajesVisitante: f.mensajes_visitante,
});

/** Un error que no es de dominio sube tal cual: la ruta responde 500 en vez de disfrazarlo. */
const fallo = (error: PostgrestError) => new Error(`Supabase: ${error.message}`, { cause: error });
const citaNoEncontrada = (id: string) => new ErrorDominio("CITA_NO_ENCONTRADA", `No existe una cita vigente con id «${id}»`);
const conversacionInexistente = (id: string) => new ErrorDominio("DATOS_INVALIDOS", `No existe la conversación «${id}»`);

/** Las RPC lanzan `raise exception 'CODIGO'`; PostgREST lo devuelve como el mensaje del error. */
function deLaRpc(error: PostgrestError, citaId: string): Error {
  if (error.message === "HORARIO_NO_DISPONIBLE") return new ErrorDominio("HORARIO_NO_DISPONIBLE", "Ese horario ya no está disponible");
  if (error.message === "CITA_NO_ENCONTRADA") return citaNoEncontrada(citaId);
  return fallo(error);
}

/**
 * Repositorio de producción. La regla de choque y su atomicidad viven en las funciones de Postgres
 * `crear_cita_si_cabe` y `actualizar_cita_si_cabe`. Las filas de `sesiones` las crea cada ruta antes de usar
 * el repositorio (`asegurarSesion` en servicio/deps.ts).
 * El cliente debe usar la service role: las tablas tienen RLS sin políticas.
 */
export function crearRepoSupabase(cliente: SupabaseClient): Repositorio {
  // Los mensajes se ordenan por id (bigserial): el orden en que se guardaron.
  const conversaciones = () =>
    cliente.from("conversaciones").select(CONVERSACION).order("id", { referencedTable: "mensajes", ascending: true });

  /** Cambia la conversación que cumple el filtro; si no hay ninguna, lanza `DATOS_INVALIDOS`. */
  const cambiarConversacion = async (filtro: { id: string; sesion_id?: string }, cambios: Record<string, unknown>) => {
    if (!Object.values(filtro).every((v) => UUID.test(v))) throw conversacionInexistente(filtro.id);
    const { data, error } = await cliente.from("conversaciones").update(cambios).match(filtro).select("id");
    if (error) throw fallo(error);
    if (data.length === 0) throw conversacionInexistente(filtro.id);
  };

  return {
    citas: {
      async listar(sesionId, negocioId, desdeIso, hastaIso) {
        if (!UUID.test(sesionId)) return [];
        const { data, error } = await cliente
          .from("citas")
          .select("*")
          .eq("sesion_id", sesionId)
          .eq("negocio_id", negocioId)
          .gte("inicio", desdeIso)
          .lt("inicio", hastaIso)
          .order("inicio");
        if (error) throw fallo(error);
        return (data as FilaCita[]).map(aCita);
      },

      async obtener(sesionId, id) {
        if (!UUID.test(sesionId) || !UUID.test(id)) return null;
        const { data, error } = await cliente.from("citas").select("*").eq("id", id).eq("sesion_id", sesionId).maybeSingle();
        if (error) throw fallo(error);
        return data ? aCita(data as FilaCita) : null;
      },

      async crearSiCabe(cita, capacidad) {
        const { data, error } = await cliente.rpc("crear_cita_si_cabe", {
          p_id: cita.id,
          p_sesion_id: cita.sesionId,
          p_negocio_id: cita.negocioId,
          p_servicio_id: cita.servicioId,
          p_cliente_nombre: cita.cliente.nombre,
          p_cliente_telefono: cita.cliente.telefono,
          p_inicio: cita.inicio,
          p_fin: cita.fin,
          p_estado: cita.estado,
          p_creada: cita.creadaEn,
          p_capacidad: capacidad,
        });
        if (error) throw deLaRpc(error, cita.id);
        return aCita(data as FilaCita);
      },

      async actualizar(sesionId, id, cambios, capacidad) {
        if (!UUID.test(sesionId) || !UUID.test(id)) throw citaNoEncontrada(id);
        // null = no cambia ese campo.
        const { data, error } = await cliente.rpc("actualizar_cita_si_cabe", {
          p_sesion_id: sesionId,
          p_id: id,
          p_inicio: cambios.inicio ?? null,
          p_fin: cambios.fin ?? null,
          p_servicio_id: cambios.servicioId ?? null,
          p_estado: cambios.estado ?? null,
          p_capacidad: capacidad,
        });
        if (error) throw deLaRpc(error, id);
        return aCita(data as FilaCita);
      },
    },

    conversaciones: {
      async obtenerOCrear(sesionId, negocioId) {
        // Con dos peticiones a la vez, una inserta y la otra no hace nada: las dos leen la misma conversación.
        const { error } = await cliente
          .from("conversaciones")
          .upsert({ sesion_id: sesionId, negocio_id: negocioId }, { onConflict: "sesion_id,negocio_id", ignoreDuplicates: true });
        if (error) throw fallo(error);
        const leida = await conversaciones().eq("sesion_id", sesionId).eq("negocio_id", negocioId).single();
        if (leida.error) throw fallo(leida.error);
        return aConversacion(leida.data as FilaConversacion);
      },

      async obtener(sesionId, conversacionId) {
        if (!UUID.test(sesionId) || !UUID.test(conversacionId)) throw conversacionInexistente(conversacionId);
        const { data, error } = await conversaciones().eq("id", conversacionId).eq("sesion_id", sesionId).maybeSingle();
        if (error) throw fallo(error);
        if (!data) throw conversacionInexistente(conversacionId);
        return aConversacion(data as FilaConversacion);
      },

      async agregarMensaje(conversacionId, m) {
        if (!UUID.test(conversacionId)) throw conversacionInexistente(conversacionId);
        // El trigger `mensajes_contar` suma a mensajes_visitante en la misma transacción.
        const { error } = await cliente
          .from("mensajes")
          .insert({ conversacion_id: conversacionId, rol: m.rol, texto: m.texto, creado: m.creadoEn });
        if (error?.code === "23503") throw conversacionInexistente(conversacionId); // llave foránea: no existe
        if (error) throw fallo(error);
      },

      async guardarHistorialApi(conversacionId, historial, versionPrompt) {
        await cambiarConversacion({ id: conversacionId }, { historial_api: historial, version_prompt: versionPrompt });
      },

      async cambiarModo(sesionId, conversacionId, modo) {
        await cambiarConversacion({ id: conversacionId, sesion_id: sesionId }, { modo });
      },

      async listar(sesionId, negocioId) {
        if (!UUID.test(sesionId)) return [];
        const { data, error } = await conversaciones().eq("sesion_id", sesionId).eq("negocio_id", negocioId);
        if (error) throw fallo(error);
        return (data as FilaConversacion[]).map(aConversacion);
      },
    },
  };
}
