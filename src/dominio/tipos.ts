/** 0 = domingo … 6 = sábado. */
export type DiaSemana = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Un día sin entrada en `horario` está cerrado. Horas en "HH:MM", hora local del negocio. */
export interface HorarioDia {
  dia: DiaSemana;
  abre: string;
  cierra: string;
  descansos: { inicio: string; fin: string }[];
}

export interface Servicio {
  id: string;
  nombre: string;
  duracionMin: number;
  precioMxn: number;
  descripcion: string;
}

export interface Politicas {
  /** Cada cuántos minutos empieza un horario posible. */
  intervaloMin: number;
  /** Minutos mínimos entre ahora y el inicio de una cita. */
  anticipacionMinMin: number;
  /** Días máximos hacia adelante para agendar. */
  anticipacionMaxDias: number;
  /** Horas mínimas antes del inicio para cancelar o cambiar. */
  cancelacionMinHoras: number;
  /** Citas que caben a la misma hora (sillas, bahías, consultorios). */
  capacidadPorHorario: number;
}

export interface PerfilNegocio {
  id: string;
  nombre: string;
  giro: string;
  /** Zona IANA, por ejemplo "America/Mexico_City". */
  zonaHoraria: string;
  tono: string;
  horario: HorarioDia[];
  servicios: Servicio[];
  politicas: Politicas;
  preguntasFrecuentes: { pregunta: string; respuesta: string }[];
}

export interface Cita {
  id: string;
  sesionId: string;
  negocioId: string;
  servicioId: string;
  cliente: { nombre: string; telefono: string };
  /** ISO 8601 en UTC. */
  inicio: string;
  /** ISO 8601 en UTC. */
  fin: string;
  estado: "confirmada" | "cancelada";
  creadaEn: string;
}

export type CodigoErrorDominio =
  | "HORARIO_NO_DISPONIBLE"
  | "FUERA_DE_POLITICA"
  | "CITA_NO_ENCONTRADA"
  | "SERVICIO_INEXISTENTE"
  | "DATOS_INVALIDOS";

export class ErrorDominio extends Error {
  readonly codigo: CodigoErrorDominio;

  constructor(codigo: CodigoErrorDominio, mensaje: string = codigo) {
    super(mensaje);
    this.name = "ErrorDominio";
    this.codigo = codigo;
  }
}
