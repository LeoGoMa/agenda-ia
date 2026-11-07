import { describe, expect, it, vi } from "vitest";
import { MARCA_DEMO } from "@/src/bot/responderDev";
import { crearRefresco } from "@/src/ui/api";
import {
  agruparPorDia,
  avisoPrivacidad,
  contar,
  ETIQUETA_MODO,
  etiquetaHora,
  formatoTelefono,
  separarMarcaDemo,
  textoDeAviso,
} from "@/src/ui/formato";

const CDMX = "America/Mexico_City";
const ahora = new Date("2026-11-09T15:00:00Z"); // lunes 9:00 en CDMX

describe("etiquetaHora", () => {
  it("da la hora local de la zona en HH:MM de 24 horas", () => {
    expect(etiquetaHora("2026-11-09T17:00:00.000Z", CDMX)).toBe("11:00");
    expect(etiquetaHora("2026-11-09T15:05:00Z", CDMX)).toBe("09:05");
    // La tarde en México ya es el día siguiente en UTC.
    expect(etiquetaHora("2026-11-10T01:30:00.000Z", CDMX)).toBe("19:30");
    // La medianoche sale como 00:00, nunca 24:00.
    expect(etiquetaHora("2026-11-09T06:00:00.000Z", CDMX)).toBe("00:00");
    // Otra zona: Tijuana va 8 horas detrás de UTC en noviembre.
    expect(etiquetaHora("2026-11-09T17:00:00.000Z", "America/Tijuana")).toBe("09:00");
  });
});

describe("agruparPorDia", () => {
  const cita = (id: string, inicio: string) => ({ id, inicio, extra: `dato-${id}` });

  it("agrupa por día local en orden, con «Hoy» y «Mañana», y conserva los demás campos", () => {
    const citas = [
      cita("c", "2026-11-11T16:00:00.000Z"), // miércoles 10:00
      cita("b", "2026-11-11T01:30:00.000Z"), // martes 19:30 en CDMX, aunque en UTC ya sea miércoles
      cita("a2", "2026-11-09T20:00:00.000Z"), // lunes 14:00
      cita("a1", "2026-11-09T17:00:00.000Z"), // lunes 11:00
    ];
    expect(agruparPorDia(citas, CDMX, ahora)).toEqual([
      { fecha: "2026-11-09", titulo: "Hoy · lunes 9 de noviembre", citas: [citas[3], citas[2]] },
      { fecha: "2026-11-10", titulo: "Mañana · martes 10 de noviembre", citas: [citas[1]] },
      { fecha: "2026-11-11", titulo: "Miércoles 11 de noviembre", citas: [citas[0]] },
    ]);
  });

  it("sin citas no hay grupos, y no cambia el arreglo recibido", () => {
    expect(agruparPorDia([], CDMX, ahora)).toEqual([]);
    const citas = [cita("b", "2026-11-12T16:00:00.000Z"), cita("a", "2026-11-12T15:00:00.000Z")];
    agruparPorDia(citas, CDMX, ahora);
    expect(citas.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("«Hoy» es el día local de la zona: a las 22:00 del lunes en CDMX ya es martes en UTC", () => {
    const [grupo] = agruparPorDia([cita("a", "2026-11-10T03:30:00.000Z")], CDMX, new Date("2026-11-10T04:00:00Z"));
    expect(grupo.titulo).toBe("Hoy · lunes 9 de noviembre");
  });
});

describe("formatoTelefono", () => {
  it("agrupa los 10 dígitos de México; las ladas de dos dígitos van 2-4-4 y las demás 3-3-4", () => {
    expect(formatoTelefono("5500000012")).toBe("55 0000 0012");
    expect(formatoTelefono("3312345678")).toBe("33 1234 5678");
    expect(formatoTelefono("8112345678")).toBe("81 1234 5678");
    expect(formatoTelefono("2221234567")).toBe("222 123 4567");
    expect(formatoTelefono("+52 (55) 0000-0012")).toBe("55 0000 0012");
  });

  it("lo que no son 10 dígitos sale tal cual", () => {
    expect(formatoTelefono("12345")).toBe("12345");
    expect(formatoTelefono("")).toBe("");
    expect(formatoTelefono("55 0000 00123")).toBe("55 0000 00123");
  });
});

describe("separarMarcaDemo", () => {
  it("quita la marca del final y avisa que fue el modo de demostración sin IA", () => {
    expect(separarMarcaDemo(`Hola, ¿en qué le ayudo?\n\n${MARCA_DEMO}`)).toEqual({ texto: "Hola, ¿en qué le ayudo?", demo: true });
  });

  it("un texto sin la marca al final queda igual", () => {
    expect(separarMarcaDemo("Hola")).toEqual({ texto: "Hola", demo: false });
    const enMedio = `Escribió ${MARCA_DEMO} a la mitad`;
    expect(separarMarcaDemo(enMedio)).toEqual({ texto: enMedio, demo: false });
  });
});

describe("textoDeAviso", () => {
  it("usa respuesta (del servicio) o error (de la ruta), y si no hay ninguno un texto genérico", () => {
    expect(textoDeAviso({ respuesta: "Llegó al límite de la demo.", modo: "bot" })).toBe("Llegó al límite de la demo.");
    expect(textoDeAviso({ error: "La solicitud no es válida." })).toBe("La solicitud no es válida.");
    expect(textoDeAviso({ respuesta: "Primero", error: "Segundo" })).toBe("Primero");
    const generico = "Algo salió mal. Inténtalo de nuevo en un momento.";
    for (const cuerpo of [null, undefined, "texto", {}, { respuesta: 7 }, { error: "" }]) {
      expect(textoDeAviso(cuerpo), JSON.stringify(cuerpo)).toBe(generico);
    }
  });
});

describe("crearRefresco (el sondeo del panel)", () => {
  /** Peticiones que se resuelven a mano, en el orden que pida la prueba. */
  function red() {
    const pendientes: ((valor: string) => void)[] = [];
    const cargar = vi.fn(() => new Promise<string>((resolver) => pendientes.push(resolver)));
    return { cargar, responder: (i: number, valor: string) => pendientes[i](valor) };
  }

  it("el tic se salta si hay una petición en curso: con la red más lenta que el intervalo, cada respuesta se aplica", async () => {
    const { cargar, responder } = red();
    const aplicar = vi.fn();
    const { sondear } = crearRefresco(cargar, aplicar);

    const primera = sondear();
    expect(sondear()).toBeUndefined(); // tic de los 4 s con la primera aún en camino
    expect(sondear()).toBeUndefined();
    expect(cargar).toHaveBeenCalledTimes(1);
    responder(0, "datos 1");
    await primera;
    expect(aplicar).toHaveBeenCalledWith("datos 1");

    const segunda = sondear();
    expect(cargar).toHaveBeenCalledTimes(2);
    responder(1, "datos 2");
    await segunda;
    expect(aplicar.mock.calls).toEqual([["datos 1"], ["datos 2"]]);
  });

  it("tras una acción siempre pide, y la respuesta vieja del sondeo no pisa la más nueva", async () => {
    const { cargar, responder } = red();
    const aplicar = vi.fn();
    const { sondear, refrescar } = crearRefresco(cargar, aplicar);

    const delSondeo = sondear(); // salió antes de la acción: puede traer datos viejos
    const trasAccion = refrescar();
    expect(cargar).toHaveBeenCalledTimes(2);
    responder(1, "nuevos");
    // Quien llamó recibe lo que pidió, aunque otra petición más nueva lo haya dejado sin aplicar.
    expect(await trasAccion).toBe("nuevos");
    responder(0, "viejos");
    expect(await delSondeo).toBe("viejos");
    expect(aplicar.mock.calls).toEqual([["nuevos"]]);
  });

  it("una petición que falla no traba el sondeo", async () => {
    const cargar = vi.fn().mockRejectedValueOnce(new Error("sin red")).mockResolvedValueOnce("datos");
    const aplicar = vi.fn();
    const { sondear } = crearRefresco(cargar, aplicar);
    await expect(sondear()).rejects.toThrow("sin red");
    await sondear();
    expect(aplicar).toHaveBeenCalledWith("datos");
  });
});

describe("avisoPrivacidad", () => {
  it("pide datos inventados y dice quién procesa los mensajes y cuándo se borran, en el trato del negocio", () => {
    expect(avisoPrivacidad("tu")).toBe(
      "Usa nombre y teléfono inventados (55 0000 00xx). Los mensajes los procesa Claude (Anthropic) y se borran a los 7 días.",
    );
    expect(avisoPrivacidad("usted")).toBe(
      "Use nombre y teléfono inventados (55 0000 00xx). Los mensajes los procesa Claude (Anthropic) y se borran a los 7 días.",
    );
  });
});

describe("conteos y modos", () => {
  it("citas y mensajes se cuentan con la misma regla de singular y plural, y con separador de miles", () => {
    expect(contar(0, "cita", "citas")).toBe("0 citas");
    expect(contar(1, "cita", "citas")).toBe("1 cita");
    expect(contar(27, "cita", "citas")).toBe("27 citas");
    expect(contar(1284, "cita", "citas")).toBe("1,284 citas");
    expect(contar(1, "mensaje", "mensajes")).toBe("1 mensaje");
    expect(contar(2, "mensaje", "mensajes")).toBe("2 mensajes");
    expect(contar(1000, "mensaje", "mensajes")).toBe("1,000 mensajes");
  });

  it("nombra el modo de la conversación", () => {
    expect(ETIQUETA_MODO).toEqual({ bot: "Bot", humano: "Persona" });
  });
});
