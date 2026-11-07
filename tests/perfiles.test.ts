import { describe, expect, it } from "vitest";
import { ErrorDominio, type PerfilNegocio } from "@/src/dominio/tipos";
import { PERFILES, esquemaPerfil, obtenerPerfil } from "@/src/dominio/perfiles";

// Una corrida de 8 o más dígitos con espacios, guiones, puntos o paréntesis cuenta como teléfono.
const telefonos = (texto: string) =>
  (texto.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []).filter((m) => m.replace(/\D/g, "").length >= 8);
const esFicticio = (telefono: string) => /^55 0000 00\d{2}$/.test(telefono);

describe("perfiles de ejemplo", () => {
  it("los tres perfiles cumplen el esquema", () => {
    expect(PERFILES).toHaveLength(3);
    expect(PERFILES.map((p) => p.id)).toEqual(["dental", "barberia", "taller"]);
    for (const perfil of PERFILES) expect(() => esquemaPerfil.parse(perfil)).not.toThrow();
  });

  it("cada negocio abre al menos 5 días y tiene 3 o más servicios con duración múltiplo de intervaloMin", () => {
    for (const perfil of PERFILES) {
      expect(new Set(perfil.horario.map((h) => h.dia)).size).toBeGreaterThanOrEqual(5);
      expect(perfil.servicios.length).toBeGreaterThanOrEqual(3);
      for (const servicio of perfil.servicios) {
        expect(servicio.duracionMin % perfil.politicas.intervaloMin, servicio.id).toBe(0);
      }
    }
  });

  it("horarios y políticas según el plan", () => {
    const resumen = (id: string) => {
      const p = obtenerPerfil(id);
      return {
        zona: p.zonaHoraria,
        trato: p.trato,
        intervalo: p.politicas.intervaloMin,
        capacidad: p.politicas.capacidadPorHorario,
        horario: p.horario.map((h) => [h.dia, h.abre, h.cierra, h.descansos.map((d) => `${d.inicio}-${d.fin}`)]),
        preguntas: p.preguntasFrecuentes.length,
      };
    };
    const comida = ["14:00-15:00"];
    expect(resumen("dental")).toEqual({
      zona: "America/Mexico_City",
      trato: "usted",
      intervalo: 30,
      capacidad: 1,
      horario: [
        ...[1, 2, 3, 4, 5].map((dia) => [dia, "09:00", "19:00", comida]),
        [6, "09:00", "14:00", []],
      ],
      preguntas: 4,
    });
    expect(resumen("barberia")).toEqual({
      zona: "America/Mexico_City",
      trato: "tu",
      intervalo: 15,
      capacidad: 2,
      horario: [0, 2, 3, 4, 5, 6].map((dia) => [dia, "10:00", "20:00", []]),
      preguntas: 4,
    });
    expect(resumen("taller")).toEqual({
      zona: "America/Mexico_City",
      trato: "tu",
      intervalo: 60,
      capacidad: 3,
      horario: [1, 2, 3, 4, 5, 6].map((dia) => [dia, "08:00", "18:00", []]),
      preguntas: 4,
    });
  });

  it("nombres y teléfonos ficticios", () => {
    // El detector tiene que atrapar un número real y dejar pasar uno ficticio.
    expect(telefonos("llama al 55 1234 5678").filter((t) => !esFicticio(t))).toHaveLength(1);
    expect(telefonos("llama al 55 0000 0012").filter((t) => !esFicticio(t))).toHaveLength(0);

    for (const perfil of PERFILES) {
      const textos = [
        perfil.nombre,
        perfil.tono,
        ...perfil.servicios.flatMap((s) => [s.nombre, s.descripcion]),
        ...perfil.preguntasFrecuentes.flatMap((f) => [f.pregunta, f.respuesta]),
      ].join("\n");
      expect(telefonos(textos).filter((t) => !esFicticio(t)), perfil.id).toEqual([]);
      expect(textos, perfil.id).not.toMatch(/\S+@\S+\.\S+/); // sin correos
    }
  });

  // Cada caso parte de un perfil válido y le mete un solo error; se revisa el mensaje para saber que falló por esa regla.
  it.each<[string, (p: PerfilNegocio) => void, string]>([
    ["abre a la misma hora que cierra", (p) => { p.horario[0].abre = p.horario[0].cierra; }, "abrir antes de cerrar"],
    ["descanso fuera del horario", (p) => { p.horario[0].descansos = [{ inicio: "18:30", fin: "19:30" }]; }, "descanso debe quedar dentro"],
    ["día repetido", (p) => { p.horario.push({ ...p.horario[0] }); }, "Día repetido"],
    ["servicio con id repetido", (p) => { p.servicios.push({ ...p.servicios[0] }); }, "Servicio con id repetido"],
    ["zona horaria inválida", (p) => { p.zonaHoraria = "Marte/Olympus"; }, "Zona horaria IANA inválida"],
    ["trato que no es usted ni tu", (p) => { (p as { trato: string }).trato = "vos"; }, "El trato debe ser"],
  ])("esquemaPerfil rechaza: %s", (_, romper, mensaje) => {
    const perfil = structuredClone(obtenerPerfil("dental"));
    romper(perfil);
    const resultado = esquemaPerfil.safeParse(perfil);
    expect(resultado.success).toBe(false);
    expect(resultado.error?.issues.map((i) => i.message).join("\n")).toContain(mensaje);
  });

  it("sin zonaHoraria usa America/Mexico_City", () => {
    const sinZona: Partial<PerfilNegocio> = structuredClone(obtenerPerfil("dental"));
    delete sinZona.zonaHoraria;
    expect(esquemaPerfil.parse(sinZona).zonaHoraria).toBe("America/Mexico_City");
  });

  it("obtenerPerfil con id inexistente lanza DATOS_INVALIDOS", () => {
    expect(obtenerPerfil("dental").id).toBe("dental");
    let error: unknown;
    try {
      obtenerPerfil("no-existe");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ErrorDominio);
    expect((error as ErrorDominio).codigo).toBe("DATOS_INVALIDOS");
  });
});
