import type { Cita } from "../dominio/tipos";

export interface MensajeVisible {
  rol: "cliente" | "bot" | "humano" | "sistema";
  texto: string;
  /** ISO 8601 en UTC. */
  creadoEn: string;
}

export interface Conversacion {
  id: string;
  sesionId: string;
  negocioId: string;
  modo: "bot" | "humano";
  mensajes: MensajeVisible[];
  /** Mensajes tal como van a la API de Claude. */
  historialApi: unknown[];
  /** Mensajes con rol "cliente"; sirve para el tope por conversación. */
  mensajesVisitante: number;
}

/**
 * Todo va acotado a una sesión: nunca se devuelve ni se toca una cita de otra.
 * `inicio` y `fin` se guardan y se devuelven en ISO 8601 UTC con Z (`toISOString()`).
 *
 * Regla de choque, la misma de `horariosLibres`: intervalos semiabiertos [inicio, fin);
 * solo cuentan las citas confirmadas de la misma sesión y negocio, y se rechaza
 * con `HORARIO_NO_DISPONIBLE` si ya hay `capacidad` o más encimadas.
 */
export interface RepositorioCitas {
  /** Citas de cualquier estado cuyo inicio cae en [desdeIso, hastaIso), ordenadas por inicio. */
  listar(sesionId: string, negocioId: string, desdeIso: string, hastaIso: string): Promise<Cita[]>;
  obtener(sesionId: string, id: string): Promise<Cita | null>;
  /** Atómica: el chequeo de choque y la escritura no se pueden intercalar con otra reserva. */
  crearSiCabe(cita: Cita, capacidad: number): Promise<Cita>;
  /**
   * Lanza `CITA_NO_ENCONTRADA` si la cita no es de la sesión. Si la cita queda confirmada,
   * aplica la regla de choque de forma atómica sin contarse a sí misma.
   */
  actualizar(
    sesionId: string,
    id: string,
    cambios: Partial<Pick<Cita, "inicio" | "fin" | "estado" | "servicioId">>,
    capacidad: number,
  ): Promise<Cita>;
}

/** Una conversación por sesión y negocio. Una conversación inexistente o de otra sesión lanza `DATOS_INVALIDOS`. */
export interface RepositorioConversaciones {
  obtenerOCrear(sesionId: string, negocioId: string): Promise<Conversacion>;
  /** Agrega al final; un mensaje con rol "cliente" suma uno a `mensajesVisitante`. */
  agregarMensaje(conversacionId: string, m: MensajeVisible): Promise<void>;
  /** Reemplaza el historial completo. */
  guardarHistorialApi(conversacionId: string, historial: unknown[]): Promise<void>;
  cambiarModo(sesionId: string, conversacionId: string, modo: "bot" | "humano"): Promise<void>;
  listar(sesionId: string, negocioId: string): Promise<Conversacion[]>;
}

export interface Repositorio {
  citas: RepositorioCitas;
  conversaciones: RepositorioConversaciones;
}
