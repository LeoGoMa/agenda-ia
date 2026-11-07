import type { RepositorioCitas } from "../repo/tipos";
import { cabe } from "./disponibilidad";
import { ErrorDominio, type Cita, type PerfilNegocio } from "./tipos";

const MINUTO = 60_000;
const HORA = 60 * MINUTO;
// Tope abierto para buscar hacia adelante; cualquier base de datos entiende esta fecha.
const SIN_TOPE = "9999-12-31T23:59:59.999Z";

/** Solo los dígitos; deben ser 10. */
function telefonoValido(telefono: string): string {
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length !== 10) throw new ErrorDominio("DATOS_INVALIDOS", "El teléfono debe tener 10 dígitos");
  return digitos;
}

/**
 * Revisa horario y políticas con `cabe()` y devuelve el intervalo en UTC.
 * A `cabe()` no se le pasan citas: la capacidad la decide solo el repositorio, de forma atómica,
 * y así la cita que se reprograma nunca choca consigo misma.
 */
function intervalo(perfil: PerfilNegocio, servicioId: string, inicioIso: string, ahora: Date) {
  if (!cabe(perfil, servicioId, inicioIso, [], ahora)) {
    throw new ErrorDominio("HORARIO_NO_DISPONIBLE", "Ese horario no está disponible");
  }
  const inicio = new Date(inicioIso);
  const { duracionMin } = perfil.servicios.find((s) => s.id === servicioId)!; // cabe() ya revisó que existe
  return { inicio: inicio.toISOString(), fin: new Date(inicio.getTime() + duracionMin * MINUTO).toISOString() };
}

/** La cita confirmada de la sesión y el negocio, si todavía se puede cancelar o cambiar. */
async function citaModificable(
  repo: RepositorioCitas,
  perfil: PerfilNegocio,
  sesionId: string,
  citaId: string,
  ahora: Date,
): Promise<Cita> {
  const cita = await repo.obtener(sesionId, citaId);
  if (!cita || cita.negocioId !== perfil.id || cita.estado !== "confirmada") {
    throw new ErrorDominio("CITA_NO_ENCONTRADA", `No hay una cita vigente con id «${citaId}»`);
  }
  const horas = perfil.politicas.cancelacionMinHoras;
  // Escrito como negación para que una fecha inválida (NaN) falle cerrado.
  if (!(Date.parse(cita.inicio) - ahora.getTime() >= horas * HORA)) {
    throw new ErrorDominio("FUERA_DE_POLITICA", `Solo se puede cancelar o cambiar una cita con ${horas} horas de anticipación`);
  }
  return cita;
}

export async function agendar(
  repo: RepositorioCitas,
  {
    perfil,
    sesionId,
    servicioId,
    inicio,
    cliente,
    ahora,
  }: {
    perfil: PerfilNegocio;
    sesionId: string;
    servicioId: string;
    inicio: string;
    cliente: { nombre: string; telefono: string };
    ahora: Date;
  },
): Promise<Cita> {
  const nombre = cliente.nombre.trim();
  const letras = [...nombre].length; // cuenta caracteres reales: un emoji vale 1, no 2
  if (letras < 2 || letras > 60) throw new ErrorDominio("DATOS_INVALIDOS", "El nombre debe tener de 2 a 60 caracteres");
  const telefono = telefonoValido(cliente.telefono);

  const cita: Cita = {
    id: crypto.randomUUID(),
    sesionId,
    negocioId: perfil.id,
    servicioId,
    cliente: { nombre, telefono },
    ...intervalo(perfil, servicioId, inicio, ahora),
    estado: "confirmada",
    creadaEn: ahora.toISOString(),
  };
  return repo.crearSiCabe(cita, perfil.politicas.capacidadPorHorario);
}

export async function reprogramar(
  repo: RepositorioCitas,
  {
    perfil,
    sesionId,
    citaId,
    nuevoInicio,
    ahora,
  }: { perfil: PerfilNegocio; sesionId: string; citaId: string; nuevoInicio: string; ahora: Date },
): Promise<Cita> {
  const cita = await citaModificable(repo, perfil, sesionId, citaId, ahora);
  // El repositorio no cuenta la propia cita al revisar el choque.
  const nuevo = intervalo(perfil, cita.servicioId, nuevoInicio, ahora);
  return repo.actualizar(sesionId, cita.id, nuevo, perfil.politicas.capacidadPorHorario);
}

export async function cancelar(
  repo: RepositorioCitas,
  { perfil, sesionId, citaId, ahora }: { perfil: PerfilNegocio; sesionId: string; citaId: string; ahora: Date },
): Promise<Cita> {
  await citaModificable(repo, perfil, sesionId, citaId, ahora);
  return repo.actualizar(sesionId, citaId, { estado: "cancelada" }, perfil.politicas.capacidadPorHorario);
}

/** Citas confirmadas que todavía no empiezan, con ese teléfono (se comparan solo los dígitos). */
export async function buscarPorTelefono(
  repo: RepositorioCitas,
  { sesionId, negocioId, telefono, ahora }: { sesionId: string; negocioId: string; telefono: string; ahora: Date },
): Promise<Cita[]> {
  const digitos = telefonoValido(telefono);
  const citas = await repo.listar(sesionId, negocioId, ahora.toISOString(), SIN_TOPE);
  return citas.filter((c) => c.estado === "confirmada" && c.cliente.telefono.replace(/\D/g, "") === digitos);
}
