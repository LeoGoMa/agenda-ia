import { inspect } from "node:util";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { POST as chat } from "@/app/api/chat/route";
import { GET as limpieza } from "@/app/api/limpieza/route";
import { POST as panelMensaje } from "@/app/api/panel/mensaje/route";
import { POST as panelModo } from "@/app/api/panel/modo/route";
import { GET as panel } from "@/app/api/panel/route";
import { proxy } from "@/proxy";
import { crearHerramientas } from "@/src/bot/herramientas";
import { MARCA_DEMO, responderDev } from "@/src/bot/responderDev";
import { obtenerPerfil } from "@/src/dominio/perfiles";
import { crearRepoMemoria } from "@/src/repo/memoria";
import { devolverAlBot } from "@/src/servicio/chat";
import { armarDeps, ponerDeps, type Deps } from "@/src/servicio/deps";

// Un espía que llama a la función real: así se ve qué camino del servicio usa cada ruta.
vi.mock("@/src/servicio/chat", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/src/servicio/chat")>();
  return { ...real, devolverAlBot: vi.fn(real.devolverAlBot) };
});

const ahora = new Date("2026-11-09T15:00:00Z"); // lunes 9:00 en CDMX; la clínica pide 2 h de anticipación
const PRIMER_HORARIO = "2026-11-09T17:00:00.000Z"; // 11:00 en CDMX
const IP = "203.0.113.7"; // rango reservado para documentación
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEXTOS = {
  sesionInvalida: "La sesión no es válida o ya expiró. Recarga la página para empezar una nueva.",
  solicitudInvalida: "La solicitud no es válida.",
  errorInterno: "Algo salió mal de nuestro lado. Inténtalo de nuevo en un momento.",
  noAutorizado: "No autorizado.",
  // Del servicio de chat, con el trato de la clínica (usted).
  invalido: "Escriba un mensaje de 1 a 1000 caracteres.",
  limite: "Llegó al límite de la demo por ahora. Si quiere un bot así para su negocio, escríbale a Forge Studio.",
  enEspera: "Le atiende una persona; en un momento le contesta",
};
// Cookies alteradas: vacía, texto, uuid v1, uuid v4 con variante inválida, con basura antes o después.
const COOKIES_MALAS = [
  "",
  "abc",
  "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  "6ba7b810-9dad-41d1-c0b4-00c04fd430c8",
  `${crypto.randomUUID()}x`,
  `x${crypto.randomUUID()}`,
  `${crypto.randomUUID()}%00`,
  "' or 1=1 --",
];

interface Opciones {
  sesion?: string;
  cuerpo?: unknown;
  ip?: string;
  encabezados?: Record<string, string>;
}

/** Una petición de Web como la que recibe el handler; el cuerpo de texto va tal cual (JSON roto a propósito). */
function peticion(ruta: string, { sesion, cuerpo, ip = IP, encabezados = {} }: Opciones = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": ip, ...encabezados };
  if (sesion !== undefined) headers.cookie = `otra=1; agenda_sesion=${sesion}; tema=oscuro`;
  if (cuerpo === undefined) return new Request(`http://localhost${ruta}`, { headers });
  const body = typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo);
  return new Request(`http://localhost${ruta}`, { method: "POST", headers, body });
}

const leer = async (r: Response) => ({ estado: r.status, cuerpo: await r.json() });

/** Un visitante con su cookie de sesión. */
function visitante(sesion: string = crypto.randomUUID(), ip = IP) {
  return {
    sesion,
    escribir: async (texto: string, negocioId = "dental") => leer(await chat(peticion("/api/chat", { sesion, ip, cuerpo: { negocioId, texto } }))),
    verPanel: async (negocioId = "dental") => leer(await panel(peticion(`/api/panel?negocioId=${negocioId}`, { sesion, ip }))),
    responder: async (conversacionId: string, texto: string) =>
      leer(await panelMensaje(peticion("/api/panel/mensaje", { sesion, ip, cuerpo: { conversacionId, texto } }))),
    cambiarModo: async (conversacionId: string, modo: string) =>
      leer(await panelModo(peticion("/api/panel/modo", { sesion, ip, cuerpo: { conversacionId, modo } }))),
  };
}

/** Todo lo que se escribió en un console.* espiado, como texto (los Error con su stack y su causa). */
const registrado = (espia: MockInstance) => espia.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : inspect(a))).join(" ")).join("\n");

// Los contadores y las herramientas usan el reloj: se fija para que ninguna prueba cruce un cambio de hora o de día.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ahora);
  // Deps en memoria, sin red: responder de demostración y límites por defecto.
  ponerDeps(armarDeps({ NODE_ENV: "test" }));
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

describe("sesión por cookie", () => {
  const llamadasCon = (sesion?: string) => [
    chat(peticion("/api/chat", { sesion, cuerpo: { negocioId: "dental", texto: "Hola" } })),
    panel(peticion("/api/panel?negocioId=dental", { sesion })),
    panelMensaje(peticion("/api/panel/mensaje", { sesion, cuerpo: { conversacionId: crypto.randomUUID(), texto: "Hola" } })),
    panelModo(peticion("/api/panel/modo", { sesion, cuerpo: { conversacionId: crypto.randomUUID(), modo: "bot" } })),
  ];

  it("sin cookie responde 401", async () => {
    for (const respuesta of await Promise.all(llamadasCon())) {
      expect(await leer(respuesta)).toEqual({ estado: 401, cuerpo: { error: TEXTOS.sesionInvalida } });
    }
  });

  it("una cookie alterada responde 401, nunca 500", async () => {
    for (const mala of COOKIES_MALAS) {
      for (const respuesta of await Promise.all(llamadasCon(mala))) {
        expect(await leer(respuesta), mala).toEqual({ estado: 401, cuerpo: { error: TEXTOS.sesionInvalida } });
      }
    }
  });

  it("cada ruta crea la fila de la sesión antes de usar el repositorio; con 401, ninguna de las dos cosas", async () => {
    const orden: string[] = [];
    const base = armarDeps({ NODE_ENV: "test" });
    /** Anota cada llamada a un método del repositorio. */
    const anotado = <T extends object>(objeto: T): T =>
      new Proxy(objeto, {
        get(destino, nombre) {
          const valor = Reflect.get(destino, nombre);
          if (typeof valor !== "function") return valor;
          return (...args: unknown[]) => {
            orden.push(`repo.${String(nombre)}`);
            return valor.apply(destino, args);
          };
        },
      });
    const deps: Deps = {
      ...base,
      repo: { citas: anotado(base.repo.citas), conversaciones: anotado(base.repo.conversaciones) },
      asegurarSesion: async (id) => {
        orden.push(`sesion:${id}`);
      },
    };
    ponerDeps(deps);
    await Promise.all(llamadasCon());
    await Promise.all(llamadasCon("abc"));
    expect(orden).toEqual([]);

    const ana = visitante();
    const conversacionId = async () => (await base.repo.conversaciones.listar(ana.sesion, "dental"))[0].id;
    const pasos = [
      () => ana.escribir("Hola"),
      () => ana.verPanel(),
      async () => ana.responder(await conversacionId(), "Hola"),
      async () => ana.cambiarModo(await conversacionId(), "humano"),
    ];
    for (const paso of pasos) {
      orden.length = 0;
      expect((await paso()).estado).toBe(200);
      expect(orden[0]).toBe(`sesion:${ana.sesion}`);
      expect(orden.length).toBeGreaterThan(1);
      expect(orden.slice(1).every((o) => o.startsWith("repo."))).toBe(true);
    }
  });
});

describe("rutas del chat y el panel", () => {
  it("flujo completo con el responder de demostración: saluda, agenda, la cita sale en el panel y pasa a humano", async () => {
    const ana = visitante();
    expect(await ana.escribir("Hola")).toEqual({ estado: 200, cuerpo: { respuesta: expect.stringContaining(MARCA_DEMO), modo: "bot" } });
    expect((await ana.escribir("¿Qué horarios tienen?")).cuerpo.respuesta).toContain("11:00, 11:30 y 12:00");
    expect((await ana.escribir("Agenda el primero")).cuerpo.respuesta).toContain("a las 11:00");

    let tablero = await ana.verPanel();
    expect(tablero.estado).toBe(200);
    // Solo lo que muestra el panel: ni el id de sesión ni el historial de la API salen del servidor.
    expect(tablero.cuerpo.citas).toEqual([
      {
        id: expect.stringMatching(UUID_V4),
        servicioId: "valoracion",
        cliente: { nombre: "Cliente Demo", telefono: "5500000001" },
        inicio: PRIMER_HORARIO,
        fin: "2026-11-09T17:30:00.000Z",
        estado: "confirmada",
      },
    ]);
    expect(tablero.cuerpo.conversaciones).toHaveLength(1);
    const [conv] = tablero.cuerpo.conversaciones;
    expect(Object.keys(conv).sort()).toEqual(["id", "mensajes", "modo"]);
    expect(conv.modo).toBe("bot");
    expect(conv.mensajes.map((m: { rol: string }) => m.rol)).toEqual(["cliente", "bot", "cliente", "bot", "cliente", "bot"]);
    expect(conv.mensajes[0]).toEqual({ rol: "cliente", texto: "Hola", creadoEn: ahora.toISOString() });

    expect(await ana.escribir("Quiero hablar con una persona")).toEqual({
      estado: 200,
      cuerpo: { respuesta: expect.stringContaining(MARCA_DEMO), modo: "humano" },
    });
    expect(await ana.responder(conv.id, "Hola, le atiende recepción.")).toEqual({ estado: 200, cuerpo: { ok: true } });
    expect(await ana.escribir("Gracias")).toEqual({ estado: 200, cuerpo: { respuesta: TEXTOS.enEspera, modo: "humano" } });
    tablero = await ana.verPanel();
    expect(tablero.cuerpo.conversaciones[0].modo).toBe("humano");
    expect(tablero.cuerpo.conversaciones[0].mensajes.slice(-2).map((m: { rol: string; texto: string }) => [m.rol, m.texto])).toEqual([
      ["humano", "Hola, le atiende recepción."],
      ["cliente", "Gracias"],
    ]);

    expect(await ana.cambiarModo(conv.id, "bot")).toEqual({ estado: 200, cuerpo: { ok: true } });
    expect((await ana.verPanel()).cuerpo.conversaciones[0].modo).toBe("bot");
    expect((await ana.escribir("Hola de nuevo")).cuerpo.modo).toBe("bot");

    // Otro negocio de la misma sesión tiene su propio panel.
    expect((await ana.verPanel("barberia")).cuerpo).toEqual({ citas: [], conversaciones: [] });
  });

  it("el panel ignora un sesionId en la consulta", async () => {
    const ana = visitante();
    const beto = visitante();
    await ana.escribir("Agenda el primero");
    expect((await ana.verPanel()).cuerpo.citas).toHaveLength(1);

    // Beto pide el panel con el id de Ana en la consulta: ve solo lo suyo (nada).
    const conIdAjeno = await panel(peticion(`/api/panel?negocioId=dental&sesionId=${ana.sesion}`, { sesion: beto.sesion }));
    expect(await leer(conIdAjeno)).toEqual({ estado: 200, cuerpo: { citas: [], conversaciones: [] } });
    // Sin cookie, el id en la consulta o en un encabezado no sirve de nada.
    const sinCookie = await panel(
      peticion(`/api/panel?negocioId=dental&sesionId=${ana.sesion}`, { encabezados: { "x-sesion-id": ana.sesion } }),
    );
    expect(sinCookie.status).toBe(401);
    // Tampoco en el cuerpo del chat: el mensaje entra a la conversación de quien trae la cookie.
    await chat(peticion("/api/chat", { sesion: beto.sesion, cuerpo: { negocioId: "dental", texto: "Hola", sesionId: ana.sesion } }));
    expect((await ana.verPanel()).cuerpo.conversaciones[0].mensajes).toHaveLength(2);
    expect((await beto.verPanel()).cuerpo.conversaciones[0].mensajes).toHaveLength(2);
  });

  it("«Devolver al bot» pasa por devolverAlBot del servicio; «Tomar el chat» no", async () => {
    const ana = visitante();
    await ana.escribir("Hola");
    const [conv] = (await ana.verPanel()).cuerpo.conversaciones;
    vi.mocked(devolverAlBot).mockClear();

    expect(await ana.cambiarModo(conv.id, "humano")).toEqual({ estado: 200, cuerpo: { ok: true } });
    expect(devolverAlBot).not.toHaveBeenCalled();
    expect((await ana.verPanel()).cuerpo.conversaciones[0].modo).toBe("humano");

    expect(await ana.cambiarModo(conv.id, "bot")).toEqual({ estado: 200, cuerpo: { ok: true } });
    expect(devolverAlBot).toHaveBeenCalledExactlyOnceWith(expect.anything(), { sesionId: ana.sesion, conversacionId: conv.id });
    expect((await ana.verPanel()).cuerpo.conversaciones[0].modo).toBe("bot");
  });

  it("no se puede tocar la conversación de otra sesión desde el panel", async () => {
    const ana = visitante();
    const beto = visitante();
    await ana.escribir("Hola");
    const [conv] = (await ana.verPanel()).cuerpo.conversaciones;
    expect(await beto.responder(conv.id, "Soy otro")).toEqual({ estado: 400, cuerpo: { error: TEXTOS.solicitudInvalida } });
    expect(await beto.cambiarModo(conv.id, "humano")).toEqual({ estado: 400, cuerpo: { error: TEXTOS.solicitudInvalida } });
    expect((await ana.verPanel()).cuerpo.conversaciones).toEqual([conv]);
  });

  it("negocioId inexistente da 400", async () => {
    const ana = visitante();
    expect(await ana.escribir("Hola", "no-existe")).toEqual({ estado: 400, cuerpo: { error: TEXTOS.solicitudInvalida } });
    expect(await ana.verPanel("no-existe")).toEqual({ estado: 400, cuerpo: { error: TEXTOS.solicitudInvalida } });
    expect(await leer(await panel(peticion("/api/panel", { sesion: ana.sesion })))).toEqual({
      estado: 400,
      cuerpo: { error: TEXTOS.solicitudInvalida },
    });
  });

  it("un cuerpo que no es JSON o no trae los campos da 400; un texto inválido da el 400 del servicio", async () => {
    const { sesion } = visitante();
    const casos: { ruta: string; manejar: (r: Request) => Promise<Response>; cuerpo: unknown }[] = [
      { ruta: "/api/chat", manejar: chat, cuerpo: "{no es json" },
      { ruta: "/api/chat", manejar: chat, cuerpo: ["dental", "Hola"] },
      { ruta: "/api/chat", manejar: chat, cuerpo: { negocioId: "dental" } },
      { ruta: "/api/chat", manejar: chat, cuerpo: { negocioId: 7, texto: "Hola" } },
      { ruta: "/api/panel/mensaje", manejar: panelMensaje, cuerpo: "null" },
      { ruta: "/api/panel/mensaje", manejar: panelMensaje, cuerpo: { conversacionId: crypto.randomUUID() } },
      { ruta: "/api/panel/modo", manejar: panelModo, cuerpo: { conversacionId: crypto.randomUUID(), modo: "robot" } },
      { ruta: "/api/panel/modo", manejar: panelModo, cuerpo: { modo: "bot" } },
    ];
    for (const { ruta, manejar, cuerpo } of casos) {
      expect(await leer(await manejar(peticion(ruta, { sesion, cuerpo }))), JSON.stringify(cuerpo)).toEqual({
        estado: 400,
        cuerpo: { error: TEXTOS.solicitudInvalida },
      });
    }

    const ana = visitante(sesion);
    expect(await ana.escribir("Hola\u0000")).toEqual({ estado: 400, cuerpo: { respuesta: TEXTOS.invalido, modo: "bot" } });
    await ana.escribir("Hola");
    const [conv] = (await ana.verPanel()).cuerpo.conversaciones;
    expect(await ana.responder(conv.id, " ")).toEqual({ estado: 400, cuerpo: { respuesta: TEXTOS.invalido } });
  });

  it("chat devuelve 429 con mensaje amable al pasar el límite", async () => {
    ponerDeps(armarDeps({ NODE_ENV: "test", AGENDA_LIMITE_SESION_HORA: "2" }));
    const ana = visitante();
    expect((await ana.escribir("Hola")).estado).toBe(200);
    expect((await ana.escribir("¿Qué horarios tienen?")).estado).toBe(200);
    expect(await ana.escribir("Agenda el primero")).toEqual({ estado: 429, cuerpo: { respuesta: TEXTOS.limite, modo: "bot" } });
    const tablero = await ana.verPanel();
    expect(tablero.cuerpo.citas).toEqual([]); // el bot no se llamó
    expect(await ana.responder(tablero.cuerpo.conversaciones[0].id, "Hola")).toEqual({ estado: 429, cuerpo: { respuesta: TEXTOS.limite } });
  });

  it("la IP sale del primer valor de x-forwarded-for", async () => {
    ponerDeps(armarDeps({ NODE_ENV: "test", AGENDA_LIMITE_IP_HORA: "2" }));
    const ana = visitante(undefined, "203.0.113.7, 10.0.0.1");
    expect((await ana.escribir("Hola")).estado).toBe(200);
    expect((await ana.escribir("Hola")).estado).toBe(200);
    // Otra sesión con la misma IP de cliente (aunque pase por otro proxy intermedio) comparte el límite…
    expect((await visitante(undefined, " 203.0.113.7 ,10.0.0.2").escribir("Hola")).estado).toBe(429);
    // …y una IP de cliente distinta no, aunque traiga la de Ana más adelante en la cadena.
    expect((await visitante(undefined, "198.51.100.4, 203.0.113.7").escribir("Hola")).estado).toBe(200);
  });

  it("un error inesperado da 500 genérico, sin detalles, y el registro no lleva el texto del visitante", async () => {
    const base = armarDeps({ NODE_ENV: "test" });
    ponerDeps({
      ...base,
      responder: async () => {
        throw new Error("detalle interno: conexión rechazada con sk-ant-llave-falsa", { cause: new Error("causa interna") });
      },
    });
    const registro = vi.spyOn(console, "error").mockImplementation(() => {});
    const texto = "texto-privado-del-visitante";
    const respuesta = await leer(await chat(peticion("/api/chat", { sesion: crypto.randomUUID(), cuerpo: { negocioId: "dental", texto } })));
    expect(respuesta).toEqual({ estado: 500, cuerpo: { error: TEXTOS.errorInterno } });
    expect(registro).toHaveBeenCalledOnce();
    expect(registrado(registro)).toContain("POST /api/chat");
    expect(registrado(registro)).toContain("detalle interno"); // el servidor sí sabe qué pasó…
    expect(registrado(registro)).not.toContain(texto); // …pero no guarda lo que escribió el visitante
  });

  it("las dependencias se arman en la primera petición: en producción sin variables, 500 genérico y el registro dice qué falta", async () => {
    ponerDeps(undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENDA_SAL_IP", "sal-de-prueba");
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const registro = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await visitante().verPanel()).toEqual({ estado: 500, cuerpo: { error: TEXTOS.errorInterno } });
    expect(registrado(registro)).toContain("SUPABASE_URL");
  });
});

describe("limpieza", () => {
  const llamar = async (autorizacion?: string) =>
    leer(await limpieza(peticion("/api/limpieza", { encabezados: autorizacion === undefined ? {} : { authorization: autorizacion } })));

  it("limpieza sin CRON_SECRET da 401", async () => {
    const limpiar = vi.fn(async () => 3);
    ponerDeps({ ...armarDeps({ NODE_ENV: "test" }), limpiar });
    // Sin definir y vacía (como en .env.example); sin la revisión, «Bearer undefined» pasaría.
    for (const secreto of [undefined, ""]) {
      vi.stubEnv("CRON_SECRET", secreto);
      for (const autorizacion of [undefined, "", "Bearer", "Bearer ", "Bearer undefined"]) {
        expect(await llamar(autorizacion), `${secreto} / ${autorizacion}`).toEqual({ estado: 401, cuerpo: { error: TEXTOS.noAutorizado } });
      }
    }
    expect(limpiar).not.toHaveBeenCalled();
  });

  it("con CRON_SECRET solo pasa el encabezado exacto y devuelve cuántas sesiones borró", async () => {
    const limpiar = vi.fn(async () => 3);
    ponerDeps({ ...armarDeps({ NODE_ENV: "test" }), limpiar });
    vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
    const malos = [undefined, "secreto-de-prueba", "Bearer otro", "Bearer secreto-de-prueb", "Bearer secreto-de-prueba2", "bearer secreto-de-prueba"];
    for (const autorizacion of malos) {
      expect(await llamar(autorizacion), String(autorizacion)).toEqual({ estado: 401, cuerpo: { error: TEXTOS.noAutorizado } });
    }
    expect(limpiar).not.toHaveBeenCalled();
    expect(await llamar("Bearer secreto-de-prueba")).toEqual({ estado: 200, cuerpo: { borradas: 3 } });
    expect(limpiar).toHaveBeenCalledOnce();
  });

  it("si la limpieza falla responde 500 genérico", async () => {
    ponerDeps({ ...armarDeps({ NODE_ENV: "test" }), limpiar: () => Promise.reject(new Error("Supabase: tiempo agotado")) });
    vi.stubEnv("CRON_SECRET", "secreto-de-prueba");
    const registro = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await llamar("Bearer secreto-de-prueba")).toEqual({ estado: 500, cuerpo: { error: TEXTOS.errorInterno } });
    expect(registrado(registro)).toContain("GET /api/limpieza");
  });
});

describe("proxy", () => {
  const pedirPagina = (cookie?: string) =>
    proxy(new NextRequest("http://localhost/demo/dental", { headers: cookie === undefined ? {} : { cookie: `agenda_sesion=${cookie}` } }));

  it("pone la cookie agenda_sesion (uuid v4, httpOnly, sameSite lax, 7 días) si falta o está alterada", () => {
    for (const cookie of [undefined, ...COOKIES_MALAS]) {
      const encabezado = pedirPagina(cookie).headers.get("set-cookie") ?? "";
      expect(encabezado.match(/^agenda_sesion=([^;]+);/)?.[1], String(cookie)).toMatch(UUID_V4);
      const atributos = encabezado.toLowerCase().split("; ");
      expect(atributos).toEqual(expect.arrayContaining(["path=/", "max-age=604800", "httponly", "samesite=lax"]));
      expect(atributos).not.toContain("secure"); // fuera de producción, para que funcione en http://localhost
    }
    // Cada visitante recibe una distinta.
    expect(pedirPagina().headers.get("set-cookie")).not.toBe(pedirPagina().headers.get("set-cookie"));
  });

  it("no toca una cookie válida", () => {
    expect(pedirPagina(crypto.randomUUID()).headers.get("set-cookie")).toBeNull();
  });

  it("en producción la cookie va con Secure", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(pedirPagina().headers.get("set-cookie")?.toLowerCase().split("; ")).toContain("secure");
  });
});
