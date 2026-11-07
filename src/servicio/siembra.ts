import { createHash } from "node:crypto";
import { NOMBRES_FICTICIOS } from "../datos/ficticios";
import { horariosLibres } from "../dominio/disponibilidad";
import { PERFILES } from "../dominio/perfiles";
import { partesLocales } from "../dominio/tiempo";
import type { Cita, PerfilNegocio } from "../dominio/tipos";
import type { Repositorio } from "../repo/tipos";

const MINUTO = 60_000;
const DIA = 24 * 60 * MINUTO;
const DIAS_HABILES = 5;
const MAX_INTENTOS = 50;

/** Enteros en [0, tope) que salen siempre iguales para la misma semilla: SHA-256 de la semilla y un contador. */
function azar(semilla: string) {
  let i = 0;
  return (tope: number) => createHash("sha256").update(`${semilla}:${i++}`).digest().readUInt32BE(0) % tope;
}

/** Los siguientes días en que abre el negocio, desde mañana (fecha local), buscando a lo más dos semanas. */
function diasHabiles(perfil: PerfilNegocio, hoy: string): string[] {
  const dias: string[] = [];
  for (let i = 1; i <= 14 && dias.length < DIAS_HABILES; i++) {
    const fecha = new Date(Date.parse(`${hoy}T00:00:00Z`) + i * DIA);
    if (perfil.horario.some((h) => h.dia === fecha.getUTCDay())) dias.push(fecha.toISOString().slice(0, 10));
  }
  return dias;
}

/** De 3 a 6 citas confirmadas en horarios que da `horariosLibres` (los mismos que acepta `cabe()`). */
function citasDe(perfil: PerfilNegocio, sesionId: string, ahora: Date): Cita[] {
  const hoy = partesLocales(ahora, perfil.zonaHoraria).fecha;
  const n = azar(`${sesionId}:${hoy}:${perfil.id}`);
  const dias = diasHabiles(perfil, hoy);
  const cuantas = 3 + n(4);
  const citas: Cita[] = [];
  // Un día lleno para el servicio sorteado se vuelve a sortear; el tope de intentos evita un ciclo sin fin.
  for (let intento = 0; dias.length > 0 && citas.length < cuantas && intento < MAX_INTENTOS; intento++) {
    const servicio = perfil.servicios[n(perfil.servicios.length)];
    const libres = horariosLibres({ perfil, servicioId: servicio.id, fecha: dias[n(dias.length)], citas, ahora });
    if (libres.length === 0) continue;
    const { inicio } = libres[n(libres.length)];
    citas.push({
      id: crypto.randomUUID(),
      sesionId,
      negocioId: perfil.id,
      servicioId: servicio.id,
      // Rango reservado 55 0000 00xx, en dígitos como los guarda `agendar`; el 01 es del cliente de demostración.
      cliente: { nombre: NOMBRES_FICTICIOS[n(NOMBRES_FICTICIOS.length)], telefono: `55000000${10 + n(90)}` },
      inicio,
      fin: new Date(Date.parse(inicio) + servicio.duracionMin * MINUTO).toISOString(),
      estado: "confirmada",
      creadaEn: ahora.toISOString(),
    });
  }
  return citas;
}

/**
 * Siembra citas ficticias en los tres negocios de una sesión nueva, para que su agenda se vea ocupada.
 * Deterministas dado el id de sesión y la fecha local: empiezan mañana, así la hora de `ahora` no cambia cuáles salen.
 */
export async function sembrarCitas(repo: Repositorio, sesionId: string, ahora: Date): Promise<void> {
  await Promise.all(
    PERFILES.flatMap((perfil) =>
      citasDe(perfil, sesionId, ahora).map((cita) => repo.citas.crearSiCabe(cita, perfil.politicas.capacidadPorHorario)),
    ),
  );
}
