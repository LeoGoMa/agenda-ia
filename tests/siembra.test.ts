import { describe, expect, it, vi } from "vitest";
import { NOMBRES_FICTICIOS } from "@/src/datos/ficticios";
import { cabe } from "@/src/dominio/disponibilidad";
import { PERFILES } from "@/src/dominio/perfiles";
import { partesLocales } from "@/src/dominio/tiempo";
import { ErrorDominio, type Cita } from "@/src/dominio/tipos";
import { crearRepoMemoria } from "@/src/repo/memoria";
import { sembrarCitas } from "@/src/servicio/siembra";

const ahora = new Date("2026-11-09T15:00:00Z"); // lunes 9:00 en CDMX
const MINUTO = 60_000;

const DESDE = "2026-01-01T00:00:00.000Z";
const HASTA = "2027-12-31T00:00:00.000Z";

/**
 * Siembra en un repositorio nuevo y devuelve, por negocio, lo que distingue a cada cita: inicio, servicio y
 * cliente. Sin id, sesión ni creadaEn, que cambian siempre y harían pasar cualquier «son distintas».
 */
async function sembradas(sesionId: string, momento = ahora) {
  const repo = crearRepoMemoria();
  await sembrarCitas(repo, sesionId, momento);
  const porNegocio: Record<string, Pick<Cita, "inicio" | "servicioId" | "cliente">[]> = {};
  for (const { id } of PERFILES) {
    const citas = await repo.citas.listar(sesionId, id, DESDE, HASTA);
    porNegocio[id] = citas.map(({ inicio, servicioId, cliente }) => ({ inicio, servicioId, cliente }));
  }
  return porNegocio;
}

describe("siembra de citas ficticias", () => {
  it("cada negocio recibe de 3 a 6 citas confirmadas que caben junto a las ya sembradas, en los próximos 5 días hábiles", async () => {
    const sesionId = crypto.randomUUID();
    const repo = crearRepoMemoria();
    const crear = vi.spyOn(repo.citas, "crearSiCabe");
    await sembrarCitas(repo, sesionId, ahora);
    for (const perfil of PERFILES) {
      // En el orden en que se guardaron, que es como el repositorio las revisa: cada una contra las que ya estaban.
      const citas = crear.mock.calls.map(([cita]) => cita).filter((c) => c.negocioId === perfil.id);
      expect(await repo.citas.listar(sesionId, perfil.id, DESDE, HASTA), perfil.id).toHaveLength(citas.length);
      expect(citas.length, perfil.id).toBeGreaterThanOrEqual(3);
      expect(citas.length, perfil.id).toBeLessThanOrEqual(6);
      // Los días en que abre, desde mañana: el lunes 9 no entra; los cinco siguientes hábiles sí.
      const habiles: string[] = [];
      for (let i = 1; habiles.length < 5; i++) {
        const fecha = new Date(Date.parse("2026-11-09T00:00:00Z") + i * 24 * 60 * MINUTO);
        if (perfil.horario.some((h) => h.dia === fecha.getUTCDay())) habiles.push(fecha.toISOString().slice(0, 10));
      }
      for (const [i, cita] of citas.entries()) {
        const servicio = perfil.servicios.find((s) => s.id === cita.servicioId);
        expect(servicio, cita.servicioId).toBeDefined();
        expect(cita).toMatchObject({ sesionId, negocioId: perfil.id, estado: "confirmada", creadaEn: ahora.toISOString() });
        // Contra las sembradas antes que ella, con la capacidad del negocio. No contra todas: la regla de choque
        // cuenta toda cita encimada y depende del orden. En la barbería (capacidad 2), una cita larga puede no
        // caber junto a dos cortas que se sembraron después y sí cupieron (~0.25 % de las sesiones).
        expect(cabe(perfil, cita.servicioId, cita.inicio, citas.slice(0, i), ahora), `${perfil.id} ${cita.inicio}`).toBe(true);
        expect(Date.parse(cita.fin) - Date.parse(cita.inicio)).toBe(servicio!.duracionMin * MINUTO);
        expect(habiles).toContain(partesLocales(new Date(cita.inicio), perfil.zonaHoraria).fecha);
        // Nombres de la lista fija y teléfonos del rango reservado 55 0000 00xx (el 01 es del cliente de demostración).
        expect(NOMBRES_FICTICIOS).toContain(cita.cliente.nombre);
        expect(cita.cliente.telefono).toMatch(/^55000000[1-9]\d$/);
      }
    }
  });

  it("dentro de cada negocio inserta en serie, y una cita que ya no cabe se omite sin romper la siembra", async () => {
    const sesionId = crypto.randomUUID();
    const repo = crearRepoMemoria();
    const real = repo.citas.crearSiCabe;
    const enCurso = new Map<string, number>();
    let maximoEnCurso = 0;
    const intentadas: Cita[] = [];
    repo.citas.crearSiCabe = async (cita, capacidad) => {
      enCurso.set(cita.negocioId, (enCurso.get(cita.negocioId) ?? 0) + 1);
      maximoEnCurso = Math.max(maximoEnCurso, enCurso.get(cita.negocioId)!);
      const numero = intentadas.push(cita);
      try {
        await new Promise((resolver) => setTimeout(resolver, 0)); // como la ida y vuelta a la base
        // La segunda cita que llega la rechaza la regla de choque del repositorio.
        if (numero === 2) throw new ErrorDominio("HORARIO_NO_DISPONIBLE", "Ese horario ya no está disponible");
        return await real(cita, capacidad);
      } finally {
        enCurso.set(cita.negocioId, enCurso.get(cita.negocioId)! - 1);
      }
    };

    await sembrarCitas(repo, sesionId, ahora);
    expect(maximoEnCurso).toBe(1);
    const rechazada = intentadas[1];
    for (const perfil of PERFILES) {
      const guardadas = await repo.citas.listar(sesionId, perfil.id, DESDE, HASTA);
      const esperadas = intentadas.filter((c) => c.negocioId === perfil.id && c !== rechazada);
      expect(guardadas.map((c) => c.id).sort(), perfil.id).toEqual(esperadas.map((c) => c.id).sort());
    }
  });

  it("un error que no es de horario sí sube: la sesión no queda sembrada a medias en silencio", async () => {
    const repo = crearRepoMemoria();
    vi.spyOn(repo.citas, "crearSiCabe").mockRejectedValueOnce(new Error("Supabase: tiempo agotado"));
    await expect(sembrarCitas(repo, crypto.randomUUID(), ahora)).rejects.toThrow("Supabase: tiempo agotado");
  });

  it("es determinista dado el id de sesión y la fecha local: la hora del día no cambia nada", async () => {
    const sesionId = crypto.randomUUID();
    const primera = await sembradas(sesionId);
    expect(await sembradas(sesionId)).toEqual(primera);
    // 22:00 del mismo lunes en CDMX (04:00 UTC del martes): mismo día local, mismas citas.
    expect(await sembradas(sesionId, new Date("2026-11-10T04:00:00Z"))).toEqual(primera);
    // Otra sesión, u otro día, da otras citas.
    expect(await sembradas(crypto.randomUUID())).not.toEqual(primera);
    expect(await sembradas(sesionId, new Date("2026-11-10T15:00:00Z"))).not.toEqual(primera);
  });

  it("los nombres de la lista fija tienen el largo que acepta agendar y no repiten el del cliente de demostración", () => {
    expect(NOMBRES_FICTICIOS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(NOMBRES_FICTICIOS).size).toBe(NOMBRES_FICTICIOS.length);
    for (const nombre of NOMBRES_FICTICIOS) {
      expect([...nombre.trim()].length, nombre).toBeGreaterThanOrEqual(2);
      expect([...nombre.trim()].length, nombre).toBeLessThanOrEqual(60);
    }
    expect(NOMBRES_FICTICIOS).not.toContain("Cliente Demo");
  });
});
