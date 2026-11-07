import { describe, expect, it } from "vitest";
import { cabe, horariosLibres } from "@/src/dominio/disponibilidad";
import { obtenerPerfil } from "@/src/dominio/perfiles";
import { aUtc, partesLocales } from "@/src/dominio/tiempo";
import { ErrorDominio, type Cita, type PerfilNegocio } from "@/src/dominio/tipos";

const ahora = new Date("2026-11-09T15:00:00Z"); // lunes 9:00 en CDMX
const dental = obtenerPerfil("dental");
const barberia = obtenerPerfil("barberia");
const taller = obtenerPerfil("taller");

const libres = (perfil: PerfilNegocio, servicioId: string, fecha: string, citas: Cita[] = []) =>
  horariosLibres({ perfil, servicioId, fecha, citas, ahora });
const etiquetas = (perfil: PerfilNegocio, servicioId: string, fecha: string, citas: Cita[] = []) =>
  libres(perfil, servicioId, fecha, citas).map((h) => h.etiqueta);

let consecutivo = 0;
const cita = (perfil: PerfilNegocio, inicio: string, minutos: number, estado: Cita["estado"] = "confirmada"): Cita => ({
  id: `cita-${++consecutivo}`,
  sesionId: "sesion-demo",
  negocioId: perfil.id,
  servicioId: perfil.servicios[0].id,
  cliente: { nombre: "Cliente Demo", telefono: "55 0000 0001" },
  inicio,
  fin: new Date(Date.parse(inicio) + minutos * 60_000).toISOString(),
  estado,
  creadaEn: ahora.toISOString(),
});

const codigoDe = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ErrorDominio ? e.codigo : e;
  }
  return "no lanzó";
};

describe("horariosLibres", () => {
  it("día cerrado no da horarios", () => {
    expect(libres(dental, "limpieza", "2026-11-15")).toEqual([]); // domingo
  });

  it("respeta horario, comida y duración", () => {
    const martes = etiquetas(dental, "limpieza", "2026-11-10");
    expect(martes[0]).toBe("09:00");
    expect(martes.at(-1)).toBe("18:00"); // 18:00 + 60 min = cierre
    // La comida es de 14:00 a 15:00: una limpieza de 60 min que empieza a las 13:30, 14:00 o 14:30 la pisa.
    expect(martes).not.toContain("13:30");
    expect(martes).not.toContain("14:00");
    expect(martes).not.toContain("14:30");
    expect(martes).toContain("13:00");
    expect(martes).toContain("15:00");
    expect(libres(dental, "limpieza", "2026-11-10")[0].inicio).toBe("2026-11-10T15:00:00.000Z");
  });

  it("no ofrece horarios pasados ni dentro de anticipacionMinMin", () => {
    // Son las 9:00 y la anticipación mínima es de 120 min: el primero es a las 11:00 exactas.
    const hoy = etiquetas(dental, "limpieza", "2026-11-09");
    expect(hoy[0]).toBe("11:00");
    expect(hoy).not.toContain("10:30");
    expect(libres(dental, "limpieza", "2026-11-06")).toEqual([]); // el viernes pasado
  });

  it("no ofrece más allá de anticipacionMaxDias", () => {
    // 30 días después de ahora es el miércoles 2026-12-09 a las 9:00 locales.
    expect(etiquetas(dental, "limpieza", "2026-12-08").at(-1)).toBe("18:00");
    expect(etiquetas(dental, "limpieza", "2026-12-09")).toEqual(["09:00"]);
    expect(libres(dental, "limpieza", "2026-12-10")).toEqual([]);
  });

  it("una cita confirmada bloquea, una cancelada no", () => {
    const citas = [
      cita(dental, "2026-11-10T16:00:00.000Z", 60), // 10:00 a 11:00 locales
      cita(dental, "2026-11-10T18:00:00.000Z", 60, "cancelada"), // 12:00 a 13:00 locales
    ];
    const martes = etiquetas(dental, "limpieza", "2026-11-10", citas);
    for (const pisada of ["09:30", "10:00", "10:30"]) expect(martes).not.toContain(pisada);
    // 09:00 termina justo cuando empieza la cita y 11:00 empieza justo cuando termina.
    for (const libre of ["09:00", "11:00", "11:30", "12:00", "12:30"]) expect(martes).toContain(libre);
  });

  it("capacidad", () => {
    const mediodia = "2026-11-10T18:00:00.000Z"; // martes 12:00 locales
    const una = [cita(barberia, mediodia, 45)];
    const dos = [...una, cita(barberia, "2026-11-10T18:30:00.000Z", 30)]; // 12:30 a 13:00, se encima con un corte de 12:00
    expect(etiquetas(barberia, "corte", "2026-11-10", una)).toContain("12:00");
    expect(etiquetas(barberia, "corte", "2026-11-10", dos)).not.toContain("12:00");
  });

  it("horarios de la tarde no se van al día siguiente", () => {
    const tallerLunes = libres(taller, "diagnostico", "2026-11-09");
    expect(tallerLunes.find((h) => h.etiqueta === "17:00")?.inicio).toBe("2026-11-09T23:00:00.000Z");

    // 19:00 en CDMX ya es el día siguiente en UTC, pero pertenece al martes local.
    const barberiaMartes = libres(barberia, "corte", "2026-11-10");
    expect(barberiaMartes.find((h) => h.etiqueta === "19:00")?.inicio).toBe("2026-11-11T01:00:00.000Z");
    for (const h of barberiaMartes) expect(partesLocales(new Date(h.inicio), barberia.zonaHoraria).fecha).toBe("2026-11-10");

    const barberiaMiercoles = libres(barberia, "corte", "2026-11-11");
    expect(barberiaMiercoles[0]).toEqual({ inicio: "2026-11-11T16:00:00.000Z", etiqueta: "10:00" });
  });

  it("fecha mal escrita lanza DATOS_INVALIDOS", () => {
    for (const fecha of ["2026-13-01", "2026-02-30", "10/11/2026", "2026-11-1", "mañana", ""]) {
      expect(codigoDe(() => libres(dental, "limpieza", fecha)), fecha).toBe("DATOS_INVALIDOS");
    }
  });

  it("servicio inexistente lanza SERVICIO_INEXISTENTE", () => {
    expect(codigoDe(() => libres(dental, "corte", "2026-11-10"))).toBe("SERVICIO_INEXISTENTE");
  });
});

describe("cabe", () => {
  const cabeDental = (inicioIso: string, citas: Cita[] = []) => cabe(dental, "limpieza", inicioIso, citas, ahora);

  it("usa la misma regla que horariosLibres", () => {
    expect(cabeDental("2026-11-10T15:00:00.000Z")).toBe(true); // martes 9:00
    expect(cabeDental("2026-11-10T09:00:00-06:00")).toBe(true); // el mismo instante con desfase
    expect(cabeDental("2026-11-10T20:00:00.000Z")).toBe(false); // 14:00, comida
    expect(cabeDental("2026-11-10T15:10:00.000Z")).toBe(false); // fuera de la rejilla de 30 min
    expect(cabeDental("2026-11-09T16:00:00.000Z")).toBe(false); // hoy a las 10:00, antes de la anticipación mínima
    expect(cabeDental("2026-11-10T15:00:00.000Z", [cita(dental, "2026-11-10T15:00:00.000Z", 60)])).toBe(false);
    expect(codigoDe(() => cabe(dental, "corte", "2026-11-10T15:00:00.000Z", [], ahora))).toBe("SERVICIO_INEXISTENTE");
  });

  it("un inicio sin zona o mal escrito lanza DATOS_INVALIDOS", () => {
    // Sin Z ni desfase, Date lo leería en la zona del servidor.
    for (const inicio of ["2026-11-10T09:00:00", "mañana a las 9", ""]) {
      expect(codigoDe(() => cabeDental(inicio)), inicio).toBe("DATOS_INVALIDOS");
    }
  });
});

describe("tiempo", () => {
  it("aUtc y partesLocales funcionan con cualquier zona IANA", () => {
    const iso = (fecha: string, hora: string, zona: string) => aUtc(fecha, hora, zona).toISOString();
    expect(iso("2026-07-01", "09:00", "America/New_York")).toBe("2026-07-01T13:00:00.000Z"); // horario de verano
    expect(iso("2026-12-01", "09:00", "America/New_York")).toBe("2026-12-01T14:00:00.000Z");
    // El día del cambio el desfase de medianoche UTC ya no sirve; hace falta la segunda vuelta.
    expect(iso("2026-03-08", "03:30", "America/New_York")).toBe("2026-03-08T07:30:00.000Z");
    expect(iso("2026-11-10", "09:00", "Asia/Kolkata")).toBe("2026-11-10T03:30:00.000Z");

    expect(partesLocales(new Date("2026-11-11T01:00:00Z"), "America/Mexico_City")).toEqual({
      fecha: "2026-11-10",
      hora: "19:00",
      dia: 2,
    });
    expect(partesLocales(new Date("2026-11-15T06:00:00Z"), "America/Mexico_City")).toEqual({
      fecha: "2026-11-15",
      hora: "00:00",
      dia: 0,
    });
  });
});
