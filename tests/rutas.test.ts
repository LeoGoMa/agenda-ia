import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearHerramientas } from "@/src/bot/herramientas";
import { MARCA_DEMO, responderDev } from "@/src/bot/responderDev";
import { obtenerPerfil } from "@/src/dominio/perfiles";
import { crearRepoMemoria } from "@/src/repo/memoria";
import { armarDeps, ponerDeps } from "@/src/servicio/deps";

const ahora = new Date("2026-11-09T15:00:00Z"); // lunes 9:00 en CDMX; la clínica pide 2 h de anticipación
const PRIMER_HORARIO = "2026-11-09T17:00:00.000Z"; // 11:00 en CDMX

// Los contadores y las herramientas usan el reloj: se fija para que ninguna prueba cruce un cambio de hora o de día.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ahora);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  ponerDeps(undefined);
});

describe("deps", () => {
  it("fuera de producción y sin variables usa memoria y el responder de demostración", async () => {
    const deps = armarDeps({ NODE_ENV: "test" });
    expect(deps.responder).toBe(responderDev);
    await expect(deps.asegurarSesion(crypto.randomUUID())).resolves.toBeUndefined();
    expect(await deps.limpiar()).toBe(0);
    expect(deps.ahora()).toEqual(ahora);
  });

  it("con ANTHROPIC_API_KEY usa el responder de Claude", () => {
    expect(armarDeps({ NODE_ENV: "test", ANTHROPIC_API_KEY: "llave-de-prueba" }).responder).not.toBe(responderDev);
  });

  it("en producción exige Supabase, la llave de Claude y la sal de la IP, con un error claro", () => {
    const completo = {
      NODE_ENV: "production",
      AGENDA_SAL_IP: "sal-de-prueba",
      SUPABASE_URL: "https://proyecto-de-prueba.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "llave-de-prueba",
      ANTHROPIC_API_KEY: "llave-de-prueba",
    };
    expect(() => armarDeps(completo)).not.toThrow();
    expect(() => armarDeps({ ...completo, SUPABASE_URL: "" })).toThrow("SUPABASE_URL");
    expect(() => armarDeps({ ...completo, SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow("SUPABASE_SERVICE_ROLE_KEY");
    expect(() => armarDeps({ ...completo, ANTHROPIC_API_KEY: "" })).toThrow("ANTHROPIC_API_KEY");
    expect(() => armarDeps({ ...completo, AGENDA_SAL_IP: "" })).toThrow("AGENDA_SAL_IP");
  });
});

describe("responderDev", () => {
  const preparar = (perfil = obtenerPerfil("dental")) => {
    const repo = crearRepoMemoria();
    const sesionId = crypto.randomUUID();
    const alPasarAHumano = vi.fn(async () => {});
    const herramientas = crearHerramientas({ repo, perfil, sesionId, conversacionId: "c-1", ahora: () => ahora, alPasarAHumano });
    const decir = (mensaje: string, historialApi: unknown[] = []) => responderDev({ perfil, historialApi, mensaje, herramientas });
    const citas = () => repo.citas.listar(sesionId, perfil.id, "2026-11-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
    return { decir, citas, alPasarAHumano };
  };

  it("saluda y marca cada respuesta como demostración sin IA", async () => {
    const { decir } = preparar();
    const previo = [{ role: "user", content: "Hola" }];
    const r = await decir("Buenas tardes", previo);
    expect(r.texto).toBe(
      `Hola, soy el asistente de citas de Clínica Dental Muela Serena. En este modo de prueba entiendo tres cosas: «horarios», «agenda el primero» y «pasar a humano».\n\n${MARCA_DEMO}`,
    );
    expect(MARCA_DEMO).toBe("(modo de demostración sin IA)");
    expect(r.pasoAHumano).toBe(false);
    expect(r.uso).toEqual({ entrada: 0, salida: 0, cacheLeida: 0 });
    // Solo agrega: el historial recibido queda igual y sigue el formato de la API.
    expect(r.historialApi).toEqual([
      ...previo,
      { role: "user", content: "Buenas tardes" },
      { role: "assistant", content: [{ type: "text", text: r.texto }] },
    ]);
    expect(previo).toHaveLength(1);
  });

  it("ofrece los horarios que dan las herramientas reales y agenda el primero", async () => {
    const { decir, citas } = preparar();
    expect((await decir("¿Qué horarios tienen?")).texto).toBe(
      `Primeros horarios libres para Consulta de valoración el lunes 9 de noviembre: 11:00, 11:30 y 12:00. Para apartar el primero: «agenda el primero».\n\n${MARCA_DEMO}`,
    );
    expect(await citas()).toEqual([]);

    expect((await decir("Agéndame el primero, por favor")).texto).toBe(
      `Listo: quedó agendada la cita de Consulta de valoración el lunes 9 de noviembre a las 11:00, a nombre de Cliente Demo (55 0000 0001).\n\n${MARCA_DEMO}`,
    );
    expect(await citas()).toMatchObject([
      { servicioId: "valoracion", inicio: PRIMER_HORARIO, estado: "confirmada", cliente: { nombre: "Cliente Demo", telefono: "5500000001" } },
    ]);
    // El horario agendado ya no se ofrece: la disponibilidad sale del repositorio.
    expect((await decir("horarios")).texto).toContain("11:30, 12:00 y 12:30");
  });

  it("si no hay horarios en los próximos 14 días lo dice y no agenda", async () => {
    const { decir, citas } = preparar({ ...obtenerPerfil("dental"), horario: [] });
    const sinHorarios = `No hay horarios libres para Consulta de valoración en los próximos 14 días.\n\n${MARCA_DEMO}`;
    expect((await decir("horarios")).texto).toBe(sinHorarios);
    expect((await decir("agenda el primero")).texto).toBe(sinHorarios);
    expect(await citas()).toEqual([]);
  });

  it("pasa a humano si se lo piden, con la herramienta real", async () => {
    const { decir, alPasarAHumano } = preparar();
    const r = await decir("Quiero hablar con una persona");
    expect(r).toMatchObject({ pasoAHumano: true, texto: `Listo, una persona del negocio seguirá la conversación.\n\n${MARCA_DEMO}` });
    expect(alPasarAHumano).toHaveBeenCalledOnce();
  });
});
