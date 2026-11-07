import { encimadas } from "../dominio/disponibilidad";
import { ErrorDominio, type Cita } from "../dominio/tipos";
import type { Conversacion, Repositorio } from "./tipos";

/**
 * Repositorio para pruebas y desarrollo. Los datos viven en el proceso y se pierden al reiniciar.
 * Guarda y devuelve copias, como una base de datos: quien llama no puede cambiar lo guardado por referencia.
 */
export function crearRepoMemoria(): Repositorio {
  const citas: Cita[] = [];
  const conversaciones: Conversacion[] = [];

  const enUtc = (cita: Cita): Cita => ({
    ...structuredClone(cita),
    inicio: new Date(cita.inicio).toISOString(),
    fin: new Date(cita.fin).toISOString(),
  });

  // Sin await entre este chequeo y la escritura que lo sigue: en un solo hilo ninguna otra reserva se mete en medio.
  const revisarChoque = (cita: Cita, capacidad: number) => {
    const otras = citas.filter((c) => c.id !== cita.id && c.sesionId === cita.sesionId && c.negocioId === cita.negocioId);
    if (cita.estado === "confirmada" && encimadas(otras, Date.parse(cita.inicio), Date.parse(cita.fin)) >= capacidad) {
      throw new ErrorDominio("HORARIO_NO_DISPONIBLE", "Ese horario ya no está disponible");
    }
  };

  const conversacion = (id: string, sesionId?: string) => {
    const c = conversaciones.find((c) => c.id === id);
    if (!c || (sesionId !== undefined && c.sesionId !== sesionId)) {
      throw new ErrorDominio("DATOS_INVALIDOS", `No existe la conversación «${id}»`);
    }
    return c;
  };

  return {
    citas: {
      async listar(sesionId, negocioId, desdeIso, hastaIso) {
        const desde = Date.parse(desdeIso);
        const hasta = Date.parse(hastaIso);
        return structuredClone(
          citas
            .filter((c) => c.sesionId === sesionId && c.negocioId === negocioId)
            .filter((c) => Date.parse(c.inicio) >= desde && Date.parse(c.inicio) < hasta)
            .sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio)),
        );
      },

      async obtener(sesionId, id) {
        const cita = citas.find((c) => c.id === id && c.sesionId === sesionId);
        return cita ? structuredClone(cita) : null;
      },

      async crearSiCabe(cita, capacidad) {
        const nueva = enUtc(cita);
        revisarChoque(nueva, capacidad);
        citas.push(nueva);
        return structuredClone(nueva);
      },

      async actualizar(sesionId, id, cambios, capacidad) {
        const i = citas.findIndex((c) => c.id === id && c.sesionId === sesionId);
        const mueve = cambios.inicio !== undefined || cambios.fin !== undefined || cambios.servicioId !== undefined;
        if (i < 0 || (mueve && citas[i].estado !== "confirmada")) {
          throw new ErrorDominio("CITA_NO_ENCONTRADA", `No existe una cita vigente con id «${id}»`);
        }
        const actualizada = enUtc({ ...citas[i], ...cambios });
        revisarChoque(actualizada, capacidad);
        citas[i] = actualizada;
        return structuredClone(actualizada);
      },
    },

    conversaciones: {
      async obtenerOCrear(sesionId, negocioId) {
        let c = conversaciones.find((c) => c.sesionId === sesionId && c.negocioId === negocioId);
        if (!c) {
          c = {
            id: crypto.randomUUID(),
            sesionId,
            negocioId,
            modo: "bot",
            mensajes: [],
            historialApi: [],
            versionPrompt: null,
            mensajesVisitante: 0,
          };
          conversaciones.push(c);
        }
        return structuredClone(c);
      },

      async obtener(sesionId, conversacionId) {
        return structuredClone(conversacion(conversacionId, sesionId));
      },

      async agregarMensaje(conversacionId, m) {
        const c = conversacion(conversacionId);
        c.mensajes.push(structuredClone(m));
        if (m.rol === "cliente") c.mensajesVisitante++;
      },

      async guardarHistorialApi(conversacionId, historial, versionPrompt) {
        const c = conversacion(conversacionId);
        c.historialApi = structuredClone(historial);
        c.versionPrompt = versionPrompt;
      },

      async cambiarModo(sesionId, conversacionId, modo) {
        conversacion(conversacionId, sesionId).modo = modo;
      },

      async listar(sesionId, negocioId) {
        return structuredClone(conversaciones.filter((c) => c.sesionId === sesionId && c.negocioId === negocioId));
      },
    },
  };
}
