import { aUtc, partesLocales } from "./tiempo";
import { ErrorDominio, type Cita, type PerfilNegocio } from "./tipos";

const MINUTO = 60_000;
const DIA = 24 * 60 * MINUTO;

const aMinutos = (hora: string) => Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5));
const aHora = (minutos: number) =>
  `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;

// La vuelta a texto descarta fechas que Date acomoda solo, como 2026-02-30.
const esFecha = (fecha: string) => {
  const d = new Date(`${fecha}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(fecha) && !Number.isNaN(d.getTime()) && d.toISOString().startsWith(fecha);
};

/**
 * Horarios en que cabe el servicio en la fecha local `fecha` ("YYYY-MM-DD") del negocio.
 * `inicio` va en ISO UTC y `etiqueta` en "HH:MM" local.
 */
export function horariosLibres({
  perfil,
  servicioId,
  fecha,
  citas,
  ahora,
}: {
  perfil: PerfilNegocio;
  servicioId: string;
  fecha: string;
  citas: Cita[];
  ahora: Date;
}): { inicio: string; etiqueta: string }[] {
  const servicio = perfil.servicios.find((s) => s.id === servicioId);
  if (!servicio) throw new ErrorDominio("SERVICIO_INEXISTENTE", `No existe el servicio «${servicioId}»`);
  if (!esFecha(fecha)) throw new ErrorDominio("DATOS_INVALIDOS", `Fecha «${fecha}» inválida, se espera AAAA-MM-DD`);

  const horario = perfil.horario.find((h) => h.dia === new Date(`${fecha}T00:00:00Z`).getUTCDay());
  if (!horario) return [];

  const { intervaloMin, anticipacionMinMin, anticipacionMaxDias, capacidadPorHorario } = perfil.politicas;
  const desde = ahora.getTime() + anticipacionMinMin * MINUTO;
  const hasta = ahora.getTime() + anticipacionMaxDias * DIA;
  const duracion = servicio.duracionMin;
  const confirmadas = citas.filter((c) => c.estado === "confirmada" && c.negocioId === perfil.id);
  const libres: { inicio: string; etiqueta: string }[] = [];

  for (let m = aMinutos(horario.abre); m + duracion <= aMinutos(horario.cierra); m += intervaloMin) {
    if (horario.descansos.some((d) => m < aMinutos(d.fin) && m + duracion > aMinutos(d.inicio))) continue;

    const etiqueta = aHora(m);
    const inicio = aUtc(fecha, etiqueta, perfil.zonaHoraria).getTime();
    // Con `ahora` inválido, desde y hasta son NaN y la negación descarta el horario.
    if (!(inicio >= desde && inicio <= hasta)) continue;

    const fin = inicio + duracion * MINUTO;
    // Escrito como negación para que una fecha inválida (NaN) cuente como encimada: falla cerrado.
    const encimadas = confirmadas.filter((c) => !(Date.parse(c.fin) <= inicio || Date.parse(c.inicio) >= fin)).length;
    if (encimadas >= capacidadPorHorario) continue;

    libres.push({ inicio: new Date(inicio).toISOString(), etiqueta });
  }
  return libres;
}

/** Si una cita del servicio puede empezar en `inicioIso`: es uno de los horarios que da `horariosLibres`. */
export function cabe(perfil: PerfilNegocio, servicioId: string, inicioIso: string, citas: Cita[], ahora: Date): boolean {
  const inicio = new Date(inicioIso);
  // Sin Z ni desfase, Date leería la hora en la zona del servidor.
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(inicioIso) || Number.isNaN(inicio.getTime())) {
    throw new ErrorDominio("DATOS_INVALIDOS", `Inicio «${inicioIso}» inválido, se espera ISO 8601 con zona`);
  }
  const { fecha } = partesLocales(inicio, perfil.zonaHoraria);
  return horariosLibres({ perfil, servicioId, fecha, citas, ahora }).some((h) => h.inicio === inicio.toISOString());
}
