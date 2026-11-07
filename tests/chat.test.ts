import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crearRepoMemoria } from "@/src/repo/memoria";
import { devolverAlBot, manejarMensaje, mensajeHumano, type DepsChat, type Responder } from "@/src/servicio/chat";
import { almacenMemoria, crearLimitador, hashIp, limitesDesdeEntorno, type ConfigLimites } from "@/src/servicio/limites";

const ahora = new Date("2026-11-09T15:00:00Z"); // lunes 9:00 en CDMX
const HORA = 3_600_000;
const IP = "203.0.113.7"; // rango reservado para documentación
const MARTES_9 = "2026-11-10T15:00:00.000Z";
const SAL_DESARROLLO = "agenda-ia-sal-solo-desarrollo";
const POR_DEFECTO: ConfigLimites = {
  sesionPorHora: 20,
  ipPorHora: 40,
  mensajesPorConversacion: 30,
  conversacionesPorDia: 100,
  mensajesBotPorDia: 300,
  sesionesNuevasIpPorHora: 10,
  salIp: SAL_DESARROLLO,
};
const TEXTOS = {
  usted: {
    invalido: "Escriba un mensaje de 1 a 1000 caracteres.",
    limite: "Llegó al límite de la demo por ahora. Si quiere un bot así para su negocio, escríbale a Forge Studio.",
    enEspera: "Le atiende una persona; en un momento le contesta",
  },
  tu: {
    invalido: "Escribe un mensaje de 1 a 1000 caracteres.",
    limite: "Llegaste al límite de la demo por ahora. Si quieres un bot así para tu negocio, escríbele a Forge Studio.",
    enEspera: "Te atiende una persona; en un momento te contesta",
  },
};

// Los contadores usan el reloj: se fija para que ninguna prueba cruce un cambio de hora o de día.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(ahora);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Turno que agrega al historial el mensaje y la respuesta, como el responder real. */
const turno = (texto: string, pasoAHumano = false): Responder =>
  async ({ historialApi, mensaje }) => ({
    texto,
    historialApi: [...historialApi, { role: "user", content: mensaje }, { role: "assistant", content: texto }],
    pasoAHumano,
    uso: { entrada: 0, salida: 0, cacheLeida: 0 },
  });

const preparar = ({ limites = {}, negocioId = "dental" }: { limites?: Partial<ConfigLimites>; negocioId?: string } = {}) => {
  const repo = crearRepoMemoria();
  // Sin red: contesta con eco.
  const responder = vi.fn<Responder>((entrada) => turno(`Eco: ${entrada.mensaje}`)(entrada));
  const deps: DepsChat = {
    repo,
    limitador: crearLimitador(almacenMemoria(), { ...POR_DEFECTO, ...limites }),
    responder,
    ahora: () => ahora,
  };
  const sesionId = crypto.randomUUID();
  const enviar = (texto: string, de: { sesionId?: string; ip?: string } = {}) =>
    manejarMensaje(deps, { sesionId, ip: IP, negocioId, texto, ...de });
  const conversacion = (sesion = sesionId) => repo.conversaciones.obtenerOCrear(sesion, negocioId);
  /** Una persona del negocio contesta desde el panel, con la cookie de la misma sesión. */
  const panel = async (texto: string, ip = IP) =>
    mensajeHumano(deps, { sesionId, ip, conversacionId: (await conversacion()).id, texto });
  return { repo, responder, deps, sesionId, enviar, conversacion, panel };
};

describe("límites", () => {
  it("vienen de las variables de entorno, con los valores por defecto de las restricciones", () => {
    expect(limitesDesdeEntorno({})).toEqual(POR_DEFECTO);
    const vacias = {
      AGENDA_LIMITE_SESION_HORA: "",
      AGENDA_LIMITE_IP_HORA: "",
      AGENDA_MAX_MENSAJES_CONVERSACION: "",
      AGENDA_TOPE_DIARIO: "",
      AGENDA_TOPE_MENSAJES_DIA: "",
      AGENDA_LIMITE_SESIONES_IP_HORA: "",
    };
    expect(limitesDesdeEntorno(vacias)).toEqual(POR_DEFECTO);
    expect(
      limitesDesdeEntorno({
        AGENDA_LIMITE_SESION_HORA: "5",
        AGENDA_LIMITE_IP_HORA: "8",
        AGENDA_MAX_MENSAJES_CONVERSACION: "12",
        AGENDA_TOPE_DIARIO: "50",
        AGENDA_TOPE_MENSAJES_DIA: "120",
        AGENDA_LIMITE_SESIONES_IP_HORA: "3",
      }),
    ).toEqual({
      sesionPorHora: 5,
      ipPorHora: 8,
      mensajesPorConversacion: 12,
      conversacionesPorDia: 50,
      mensajesBotPorDia: 120,
      sesionesNuevasIpPorHora: 3,
      salIp: SAL_DESARROLLO,
    });
    for (const malo of ["0", "-3", "2.5", "veinte"]) {
      expect(() => limitesDesdeEntorno({ AGENDA_LIMITE_IP_HORA: malo }), malo).toThrow("AGENDA_LIMITE_IP_HORA");
      expect(() => limitesDesdeEntorno({ AGENDA_LIMITE_SESIONES_IP_HORA: malo }), malo).toThrow("AGENDA_LIMITE_SESIONES_IP_HORA");
      expect(() => limitesDesdeEntorno({ AGENDA_TOPE_MENSAJES_DIA: malo }), malo).toThrow("AGENDA_TOPE_MENSAJES_DIA");
    }
  });

  it("la sal de la IP viene de AGENDA_SAL_IP; sin ella, en producción no arranca", () => {
    expect(limitesDesdeEntorno({ AGENDA_SAL_IP: "sal-secreta" }).salIp).toBe("sal-secreta");
    expect(limitesDesdeEntorno({ NODE_ENV: "production", AGENDA_SAL_IP: "sal-secreta" }).salIp).toBe("sal-secreta");
    // En desarrollo y pruebas, sin sal (o vacía, como en .env.example) se usa la fija de desarrollo.
    expect(limitesDesdeEntorno({ NODE_ENV: "development", AGENDA_SAL_IP: "" }).salIp).toBe(SAL_DESARROLLO);
    expect(limitesDesdeEntorno({ NODE_ENV: "test" }).salIp).toBe(SAL_DESARROLLO);
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "production", AGENDA_SAL_IP: "" }]) {
      expect(() => limitesDesdeEntorno(env), JSON.stringify(env)).toThrow("Falta AGENDA_SAL_IP");
    }
  });

  it("la clave de IP lleva el SHA-256 de sal + IP en hexadecimal, nunca la IP en claro", async () => {
    // Calculado aparte: printf '%s' 'sal-de-prueba203.0.113.7' | sha256sum
    const esperado = "874df0b670b85b1e964ac294dc596618f8cfc41b80b6a6c5fb84b6d571d3753f";
    expect(hashIp(IP, "sal-de-prueba")).toBe(esperado);
    expect(hashIp(IP, "otra-sal")).not.toBe(esperado);
    expect(hashIp("203.0.113.8", "sal-de-prueba")).not.toBe(esperado);

    const claves: string[] = [];
    const almacen = {
      incrementar: async (clave: string) => {
        claves.push(clave);
        return 1;
      },
    };
    const limitador = crearLimitador(almacen, { ...POR_DEFECTO, salIp: "sal-de-prueba" });
    await limitador.verificar({ ip: IP, sesionId: "s", esNuevaConversacion: true, mensajesConversacion: 0, llamaAlBot: true });
    expect(claves).toEqual(["sesion:s", `ip:${esperado}`, "conversaciones-nuevas", "mensajes-dia"]);
    claves.length = 0;
    // Sin llamada al bot (modo humano o mensaje del panel) no se toca el contador de mensajes al modelo.
    await limitador.verificar({ ip: IP, sesionId: "s", esNuevaConversacion: false, mensajesConversacion: 0, llamaAlBot: false });
    expect(claves).toEqual(["sesion:s", `ip:${esperado}`]);
    await limitador.sesionNueva(IP);
    expect(claves.at(-1)).toBe(`sesion-nueva:${esperado}`);
    expect(claves.join(" ")).not.toContain(IP);
  });

  it("una IPv6 cuenta por su prefijo /64: quien cambia la segunda mitad de su dirección sigue en la misma clave", () => {
    const sal = "sal-de-prueba";
    // Calculado aparte: printf '%s' 'sal-de-prueba2001:db8:abcd:12::/64' | sha256sum
    const esperado = "039c20ac6d1a1870882aec8ffe013837fcf75af1e39b023df0b40e4cf270cfb2";
    const mismo64 = ["2001:db8:abcd:12::1", "2001:0DB8:ABCD:0012:ffff:eeee:dddd:cccc", "2001:db8:abcd:12:0:0:0:7", "2001:db8:abcd:12::9%eth0"];
    for (const ip of mismo64) expect(hashIp(ip, sal), ip).toBe(hashIp(mismo64[0], sal));
    expect(hashIp("2001:db8:abcd:12::1", sal)).toBe(esperado);
    // Otro /64 es otra clave, también cuando el «::» cae dentro del prefijo.
    expect(hashIp("2001:db8:abcd:13::1", sal)).not.toBe(esperado);
    expect(hashIp("2001:db8::1", sal)).toBe(hashIp("2001:db8:0:0:ffff::1", sal));
    expect(hashIp("2001:db8::1", sal)).not.toBe(hashIp("2001:db8:0:1::1", sal));
    expect(hashIp("::1", sal)).toBe(hashIp("0:0:0:0::2", sal));
    // Las IPv4 quedan igual que antes; una IPv4 escrita como IPv6 (::ffff:a.b.c.d) cuenta como su IPv4.
    expect(hashIp(IP, sal)).toBe("874df0b670b85b1e964ac294dc596618f8cfc41b80b6a6c5fb84b6d571d3753f");
    expect(hashIp(`::ffff:${IP}`, sal)).toBe(hashIp(IP, sal));
    expect(hashIp("203.0.113.8", sal)).not.toBe(hashIp(IP, sal));
  });

  it("el limitador da el motivo de cada límite", async () => {
    const limitador = crearLimitador(almacenMemoria(), POR_DEFECTO);
    const verificar = (cambios: Partial<Parameters<typeof limitador.verificar>[0]>) =>
      limitador.verificar({ ip: IP, sesionId: "s", esNuevaConversacion: false, mensajesConversacion: 0, llamaAlBot: false, ...cambios });

    expect(await verificar({ mensajesConversacion: 29 })).toEqual({ permitido: true });
    expect(await verificar({ mensajesConversacion: 30 })).toEqual({ permitido: false, motivo: "conversacion" });

    for (let i = 0; i < 20; i++) expect(await verificar({ sesionId: "una", ip: `ip-sesion-${i}` })).toEqual({ permitido: true });
    expect(await verificar({ sesionId: "una", ip: "ip-sesion-20" })).toEqual({ permitido: false, motivo: "sesion" });

    for (let i = 0; i < 40; i++) expect(await verificar({ sesionId: `ip-${i}`, ip: "compartida" })).toEqual({ permitido: true });
    expect(await verificar({ sesionId: "ip-40", ip: "compartida" })).toEqual({ permitido: false, motivo: "ip" });

    for (let i = 0; i < 100; i++) {
      expect(await verificar({ sesionId: `d-${i}`, ip: `ip-d-${i}`, esNuevaConversacion: true })).toEqual({ permitido: true });
    }
    expect(await verificar({ sesionId: "d-100", ip: "ip-d-100", esNuevaConversacion: true })).toEqual({
      permitido: false,
      motivo: "diario",
    });
    expect(await verificar({ sesionId: "d-100", ip: "ip-d-100" })).toEqual({ permitido: true }); // una que ya empezó sigue

    for (let i = 0; i < 300; i++) {
      expect(await verificar({ sesionId: `m-${i}`, ip: `ip-m-${i}`, llamaAlBot: true })).toEqual({ permitido: true });
    }
    expect(await verificar({ sesionId: "m-300", ip: "ip-m-300", llamaAlBot: true })).toEqual({ permitido: false, motivo: "mensajes-dia" });
    expect(await verificar({ sesionId: "m-300", ip: "ip-m-300" })).toEqual({ permitido: true }); // sin llamar al bot, sigue
  });

  it("las sesiones nuevas por IP tienen su propio tope por hora", async () => {
    const limitador = crearLimitador(almacenMemoria(), { ...POR_DEFECTO, sesionesNuevasIpPorHora: 2 });
    expect(await limitador.sesionNueva(IP)).toBe(true);
    expect(await limitador.sesionNueva(IP)).toBe(true);
    expect(await limitador.sesionNueva(IP)).toBe(false);
    expect(await limitador.sesionNueva("198.51.100.4")).toBe(true); // otra IP
    // No toca los contadores de mensajes: la IP sigue pudiendo escribir.
    expect(
      await limitador.verificar({ ip: IP, sesionId: "s", esNuevaConversacion: true, mensajesConversacion: 0, llamaAlBot: true }),
    ).toEqual({ permitido: true });
    vi.setSystemTime(ahora.getTime() + HORA); // la hora siguiente vuelve a empezar
    expect(await limitador.sesionNueva(IP)).toBe(true);
  });

  it("un mensaje rechazado por sesión o IP no gasta el tope diario", async () => {
    const limitador = crearLimitador(almacenMemoria(), { ...POR_DEFECTO, sesionPorHora: 1, ipPorHora: 2, conversacionesPorDia: 2 });
    const nueva = (sesionId: string, ip: string) =>
      limitador.verificar({ ip, sesionId, esNuevaConversacion: true, mensajesConversacion: 0, llamaAlBot: false });
    expect(await nueva("a", "ip-1")).toEqual({ permitido: true }); // diario: 1
    expect(await nueva("a", "ip-2")).toEqual({ permitido: false, motivo: "sesion" });
    expect(await nueva("b", "ip-1")).toEqual({ permitido: true }); // diario: 2
    expect(await nueva("c", "ip-1")).toEqual({ permitido: false, motivo: "ip" });
    expect(await nueva("d", "ip-3")).toEqual({ permitido: false, motivo: "diario" }); // los rechazos de arriba no contaron
  });

  it("el tope de mensajes al modelo se revisa al final: un rechazo anterior no lo gasta", async () => {
    const limitador = crearLimitador(almacenMemoria(), { ...POR_DEFECTO, sesionPorHora: 1, conversacionesPorDia: 1, mensajesBotPorDia: 2 });
    const alBot = (sesionId: string, esNuevaConversacion = false) =>
      limitador.verificar({ ip: IP, sesionId, esNuevaConversacion, mensajesConversacion: 0, llamaAlBot: true });
    expect(await alBot("a", true)).toEqual({ permitido: true }); // mensajes al modelo: 1
    expect(await alBot("a")).toEqual({ permitido: false, motivo: "sesion" });
    expect(await alBot("b", true)).toEqual({ permitido: false, motivo: "diario" });
    expect(await alBot("c")).toEqual({ permitido: true }); // mensajes al modelo: 2; los rechazos de arriba no contaron
    expect(await alBot("d")).toEqual({ permitido: false, motivo: "mensajes-dia" });
    vi.setSystemTime(ahora.getTime() + 24 * HORA); // al día siguiente vuelve a abrir
    expect(await alBot("e")).toEqual({ permitido: true });
  });
});

describe("manejarMensaje", () => {
  it("un turno con el bot guarda el mensaje, la respuesta y el historial", async () => {
    const { repo, enviar, responder, conversacion, sesionId } = preparar();
    expect(await enviar("  Hola, ¿tienen lugar mañana?  ")).toEqual({
      estado: 200,
      respuesta: "Eco: Hola, ¿tienen lugar mañana?",
      modo: "bot",
    });

    const [{ perfil, historialApi, mensaje, herramientas }] = responder.mock.calls[0];
    expect(perfil.id).toBe("dental");
    expect(historialApi).toEqual([]);
    expect(mensaje).toBe("Hola, ¿tienen lugar mañana?");
    const guardada = await conversacion();
    expect(guardada.mensajes).toEqual([
      { rol: "cliente", texto: "Hola, ¿tienen lugar mañana?", creadoEn: ahora.toISOString() },
      { rol: "bot", texto: "Eco: Hola, ¿tienen lugar mañana?", creadoEn: ahora.toISOString() },
    ]);
    expect(guardada.mensajesVisitante).toBe(1);
    expect(guardada.historialApi).toEqual([
      { role: "user", content: "Hola, ¿tienen lugar mañana?" },
      { role: "assistant", content: "Eco: Hola, ¿tienen lugar mañana?" },
    ]);
    expect(guardada.versionPrompt).toMatch(/^[0-9a-f]{64}$/);

    // Las herramientas que recibe el bot trabajan sobre la sesión del visitante y con el reloj de deps.
    const agendada = await herramientas.ejecutar("agendar_cita", {
      servicioId: "limpieza",
      inicio: MARTES_9,
      nombre: "Cliente Demo",
      telefono: "55 0000 0001",
    });
    expect(agendada.esError).toBe(false);
    expect(await repo.citas.listar(sesionId, "dental", MARTES_9, "2026-11-11T00:00:00.000Z")).toHaveLength(1);

    // El siguiente turno recibe el historial guardado.
    await enviar("¿Y el martes?");
    expect(responder.mock.calls[1][0].historialApi).toEqual(guardada.historialApi);
  });

  it("al pasar el límite no se llama al bot", async () => {
    const { enviar, responder, conversacion } = preparar();
    for (let i = 1; i <= 20; i++) expect((await enviar(`Mensaje ${i}`)).estado, `mensaje ${i}`).toBe(200);

    vi.setSystemTime(ahora.getTime() + 59 * 60_000); // la misma hora
    expect(await enviar("Mensaje 21")).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite, modo: "bot" });
    expect(responder).toHaveBeenCalledTimes(20);
    expect((await conversacion()).mensajesVisitante).toBe(20); // el mensaje rechazado no se guarda

    vi.setSystemTime(ahora.getTime() + HORA); // la hora siguiente vuelve a abrir
    expect((await enviar("Mensaje 22")).estado).toBe(200);
    expect(responder).toHaveBeenCalledTimes(21);
  });

  it("límite por IP y diario", async () => {
    // IP: 40 por hora, sumando todas las sesiones que la comparten.
    const porIp = preparar();
    const [a, b, c] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (let i = 0; i < 20; i++) {
      expect((await porIp.enviar("Hola", { sesionId: a })).estado).toBe(200);
      expect((await porIp.enviar("Hola", { sesionId: b })).estado).toBe(200);
    }
    expect(await porIp.enviar("Hola", { sesionId: c })).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite, modo: "bot" });
    expect((await porIp.enviar("Hola", { sesionId: c, ip: "203.0.113.8" })).estado).toBe(200); // otra IP sí pasa
    expect(porIp.responder).toHaveBeenCalledTimes(41);

    // Diario: cuenta conversaciones nuevas; las que ya empezaron siguen.
    const diario = preparar({ limites: { conversacionesPorDia: 2 } });
    const [s1, s2, s3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    expect((await diario.enviar("Hola", { sesionId: s1 })).estado).toBe(200);
    expect((await diario.enviar("Hola", { sesionId: s2 })).estado).toBe(200);
    expect((await diario.enviar("Hola", { sesionId: s3 })).estado).toBe(429);
    expect((await diario.enviar("¿Siguen ahí?", { sesionId: s1 })).estado).toBe(200);
    expect(diario.responder).toHaveBeenCalledTimes(3);
    expect((await diario.conversacion(s3)).mensajes).toEqual([]);

    vi.setSystemTime(ahora.getTime() + 24 * HORA); // al día siguiente vuelve a abrir
    expect((await diario.enviar("Hola", { sesionId: s3 })).estado).toBe(200);
  });

  it("tope diario de mensajes al modelo: al pasarlo no se llama al bot; el modo humano y el panel no lo gastan", async () => {
    const { deps, enviar, responder, conversacion, panel, sesionId } = preparar({ limites: { mensajesBotPorDia: 2 } });
    expect((await enviar("Hola")).estado).toBe(200);
    const { id } = await conversacion();
    await deps.repo.conversaciones.cambiarModo(sesionId, id, "humano");
    expect((await enviar("¿Hay alguien?")).estado).toBe(200); // modo humano: no llega al modelo
    expect(await panel("Hola, le atiende recepción.")).toEqual({ estado: 200 });
    await devolverAlBot(deps, { sesionId, conversacionId: id });
    expect((await enviar("¿Me agenda una limpieza?")).estado).toBe(200);
    expect(responder).toHaveBeenCalledTimes(2);

    // Cuenta entre todos los visitantes: otra sesión, desde otra IP, también se queda sin bot.
    const otra = crypto.randomUUID();
    expect(await enviar("Hola", { sesionId: otra, ip: "198.51.100.4" })).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite, modo: "bot" });
    expect(await enviar("¿Siguen ahí?")).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite, modo: "bot" });
    expect(responder).toHaveBeenCalledTimes(2);
    expect((await conversacion(otra)).mensajes).toEqual([]);

    vi.setSystemTime(ahora.getTime() + 24 * HORA); // al día siguiente vuelve a abrir
    expect((await enviar("Hola", { sesionId: otra, ip: "198.51.100.4" })).estado).toBe(200);
    expect(responder).toHaveBeenCalledTimes(3);
  });

  it("una conversación admite 30 mensajes del visitante", async () => {
    const { enviar, responder } = preparar();
    for (let i = 1; i <= 30; i++) {
      if (i === 21) vi.setSystemTime(ahora.getTime() + HORA); // el límite por sesión es de 20 por hora
      expect((await enviar(`Mensaje ${i}`)).estado, `mensaje ${i}`).toBe(200);
    }
    vi.setSystemTime(ahora.getTime() + 2 * HORA);
    expect(await enviar("Mensaje 31")).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite, modo: "bot" });
    expect(responder).toHaveBeenCalledTimes(30);
  });

  it("texto vacío o de más de 1000 da 400 sin crear la conversación", async () => {
    const { repo, enviar, responder, sesionId } = preparar();
    for (const texto of ["", "   \n\t ", "a".repeat(1001), 42 as unknown as string]) {
      expect(await enviar(texto), String(texto).slice(0, 10)).toEqual({ estado: 400, respuesta: TEXTOS.usted.invalido, modo: "bot" });
    }
    expect(responder).not.toHaveBeenCalled();
    expect(await repo.conversaciones.listar(sesionId, "dental")).toEqual([]);

    // 1000 caracteres sí caben, y un emoji cuenta como uno.
    expect((await enviar("a".repeat(1000))).estado).toBe(200);
    expect((await enviar("🦷".repeat(1000))).estado).toBe(200);
  });

  it("un texto con NUL u otro carácter de control C0 da 400, salvo \\n y \\t (chat y panel)", async () => {
    const { repo, enviar, panel, responder, conversacion, sesionId } = preparar();
    // Incluye controles en las orillas, que trim() quitaría (\v, \r): se rechazan igual.
    const malos = ["Hola\u0000", "\u0000", "a\u0001b", "Hola \u001b[31m", "línea\r\notra", "\u000bHola", "Hola\u001f"];
    for (const texto of malos) {
      expect(await enviar(texto), JSON.stringify(texto)).toEqual({ estado: 400, respuesta: TEXTOS.usted.invalido, modo: "bot" });
    }
    expect(responder).not.toHaveBeenCalled();
    expect(await repo.conversaciones.listar(sesionId, "dental")).toEqual([]);

    expect(await enviar("Hola\n\tquiero una cita")).toMatchObject({ estado: 200, modo: "bot" });
    const antes = await conversacion();
    for (const texto of malos) {
      expect(await panel(texto), JSON.stringify(texto)).toEqual({ estado: 400, respuesta: TEXTOS.usted.invalido });
    }
    expect(await conversacion()).toEqual(antes);
    expect(await panel("Con gusto.\n\tRecepción")).toEqual({ estado: 200 });
  });

  it("un negocio inexistente lanza DATOS_INVALIDOS sin crear conversación ni llamar al bot", async () => {
    const { deps, responder, sesionId } = preparar();
    await expect(manejarMensaje(deps, { sesionId, ip: IP, negocioId: "no-existe", texto: "Hola" })).rejects.toMatchObject({
      codigo: "DATOS_INVALIDOS",
    });
    expect(await deps.repo.conversaciones.listar(sesionId, "no-existe")).toEqual([]);
    expect(responder).not.toHaveBeenCalled();
  });

  it("en modo humano no se llama al bot", async () => {
    const { repo, enviar, responder, conversacion, sesionId } = preparar();
    await enviar("Hola");
    await repo.conversaciones.cambiarModo(sesionId, (await conversacion()).id, "humano");

    expect(await enviar("¿Me atiende alguien?")).toEqual({ estado: 200, respuesta: TEXTOS.usted.enEspera, modo: "humano" });
    expect(responder).toHaveBeenCalledTimes(1);
    const guardada = await conversacion();
    expect(guardada.mensajes.map((m) => [m.rol, m.texto])).toEqual([
      ["cliente", "Hola"],
      ["bot", "Eco: Hola"],
      ["cliente", "¿Me atiende alguien?"],
    ]);
    expect(guardada.mensajesVisitante).toBe(2);
    // También entra al historial de la API, para que el bot tenga el contexto al regresar.
    expect(guardada.historialApi.at(-1)).toEqual({ role: "user", content: "¿Me atiende alguien?" });
  });

  it("pasoAHumano cambia el modo", async () => {
    const { enviar, responder, conversacion } = preparar();
    responder.mockImplementationOnce(turno("Le comunico con una persona del equipo.", true));

    expect(await enviar("Quiero hablar con una persona")).toEqual({
      estado: 200,
      respuesta: "Le comunico con una persona del equipo.",
      modo: "humano",
    });
    const guardada = await conversacion();
    expect(guardada.modo).toBe("humano");
    expect(guardada.mensajes.at(-1)).toMatchObject({ rol: "bot", texto: "Le comunico con una persona del equipo." });
    expect(guardada.historialApi).toHaveLength(2);

    expect((await enviar("¿Hola?")).modo).toBe("humano");
    expect(responder).toHaveBeenCalledTimes(1);
  });

  it("si cambió el prompt o las herramientas arranca un historial nuevo y conserva los mensajes", async () => {
    const { repo, enviar, responder, conversacion, sesionId } = preparar();
    await enviar("Hola");
    const antes = await conversacion();
    // Así queda una conversación guardada antes de un despliegue que cambió el perfil o una herramienta.
    await repo.conversaciones.guardarHistorialApi(sesionId, antes.id, antes.historialApi, "version-anterior");

    await enviar("¿Siguen ahí?");
    expect(responder.mock.calls[1][0].historialApi).toEqual([]);
    const despues = await conversacion();
    expect(despues.versionPrompt).toBe(antes.versionPrompt);
    expect(despues.historialApi).toEqual([
      { role: "user", content: "¿Siguen ahí?" },
      { role: "assistant", content: "Eco: ¿Siguen ahí?" },
    ]);
    expect(despues.mensajes.map((m) => m.texto)).toEqual(["Hola", "Eco: Hola", "¿Siguen ahí?", "Eco: ¿Siguen ahí?"]);

    // La versión sale del prompt del negocio: otro negocio tiene otra.
    const barberia = preparar({ negocioId: "barberia" });
    await barberia.enviar("Hola");
    expect((await barberia.conversacion()).versionPrompt).not.toBe(antes.versionPrompt);
  });

  it("con un historial de más de 120 000 caracteres no se llama al bot ni se gastan los contadores", async () => {
    const { repo, enviar, responder, conversacion, sesionId } = preparar({ limites: { sesionPorHora: 3 } });
    await enviar("Hola"); // sesión: 1 de 3
    const { id, versionPrompt } = await conversacion();
    // Un historial que, serializado, mide exactamente `largo` caracteres.
    const vacio = JSON.stringify([{ role: "user", content: "" }]).length;
    const historialDe = (largo: number) => [{ role: "user", content: "a".repeat(largo - vacio) }];

    await repo.conversaciones.guardarHistorialApi(sesionId, id, historialDe(120_001), versionPrompt);
    // Si estos dos 429 gastaran contadores, la sesión llegaría a 3 y el siguiente 200 sería un 429.
    for (let i = 0; i < 2; i++) {
      expect(await enviar("¿Siguen ahí?")).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite, modo: "bot" });
    }
    expect(responder).toHaveBeenCalledTimes(1);
    const rechazada = await conversacion();
    expect(rechazada.mensajes).toHaveLength(2); // el mensaje no se guarda
    expect(rechazada.historialApi).toEqual(historialDe(120_001)); // y el historial no se recorta

    await repo.conversaciones.guardarHistorialApi(sesionId, id, historialDe(120_000), versionPrompt);
    expect((await enviar("¿Siguen ahí?")).estado).toBe(200); // sesión: 2 de 3
    expect(responder).toHaveBeenCalledTimes(2);

    // Cuenta lo que se mandaría: un historial de otra versión del prompt no se reenvía.
    await repo.conversaciones.guardarHistorialApi(sesionId, id, historialDe(120_001), "version-anterior");
    expect((await enviar("¿Y ahora?")).estado).toBe(200); // sesión: 3 de 3
    expect(responder.mock.calls[2][0].historialApi).toEqual([]);
  });

  it("un historial sin versión (solo texto del modo humano) se conserva al volver al bot", async () => {
    const { deps, enviar, responder, conversacion, panel, sesionId } = preparar();
    const { id } = await conversacion();
    await deps.repo.conversaciones.cambiarModo(sesionId, id, "humano"); // la persona toma el chat antes que el bot
    await enviar("Hola, ¿hay alguien?");
    await panel("Hola, le atiende recepción.");
    expect((await conversacion()).versionPrompt).toBeNull();

    await devolverAlBot(deps, { sesionId, conversacionId: id });
    expect((await enviar("¿Me agenda una limpieza?")).estado).toBe(200);
    expect(responder.mock.calls[0][0].historialApi).toEqual([
      { role: "user", content: "Hola, ¿hay alguien?" },
      { role: "user", content: "[Respuesta de una persona del negocio]: Hola, le atiende recepción." },
    ]);
  });

  it("si el bot falla, el error sube y no queda un turno a medias", async () => {
    const { enviar, responder, conversacion } = preparar();
    await enviar("Hola");
    responder.mockRejectedValueOnce(new Error("API caída"));

    await expect(enviar("¿Tienen lugar?")).rejects.toThrow("API caída");
    const guardada = await conversacion();
    expect(guardada.mensajes.map((m) => m.rol)).toEqual(["cliente", "bot", "cliente"]);
    expect(guardada.historialApi).toHaveLength(2);
    expect(guardada.modo).toBe("bot");
  });

  it("los textos fijos siguen el trato del negocio", async () => {
    const { repo, enviar, conversacion, sesionId } = preparar({ negocioId: "barberia", limites: { sesionPorHora: 2 } });
    expect(await enviar("")).toEqual({ estado: 400, respuesta: TEXTOS.tu.invalido, modo: "bot" });
    await enviar("Hola");
    await repo.conversaciones.cambiarModo(sesionId, (await conversacion()).id, "humano");
    expect(await enviar("¿Hay alguien?")).toEqual({ estado: 200, respuesta: TEXTOS.tu.enEspera, modo: "humano" });
    expect(await enviar(" ")).toEqual({ estado: 400, respuesta: TEXTOS.tu.invalido, modo: "humano" });
    expect(await enviar("¿Hola?")).toEqual({ estado: 429, respuesta: TEXTOS.tu.limite, modo: "humano" });
  });
});

describe("panel", () => {
  it("mensajeHumano queda en mensajes visibles y en el historial", async () => {
    const { deps, enviar, conversacion, sesionId } = preparar();
    await enviar("¿Hacen descuento a estudiantes?");
    const antes = await conversacion();
    await deps.repo.conversaciones.cambiarModo(sesionId, antes.id, "humano");

    expect(await mensajeHumano(deps, { sesionId, ip: IP, conversacionId: antes.id, texto: "  Sí, 10% con credencial vigente.  " })).toEqual({
      estado: 200,
    });

    const despues = await conversacion();
    expect(despues.mensajes.at(-1)).toEqual({ rol: "humano", texto: "Sí, 10% con credencial vigente.", creadoEn: ahora.toISOString() });
    expect(despues.mensajesVisitante).toBe(1);
    // Solo se agrega: lo anterior del historial queda igual.
    expect(despues.historialApi).toEqual([
      ...antes.historialApi,
      { role: "user", content: "[Respuesta de una persona del negocio]: Sí, 10% con credencial vigente." },
    ]);
    expect(despues.versionPrompt).toBe(antes.versionPrompt);

    for (const texto of ["", " ", "a".repeat(1001)]) {
      expect(await mensajeHumano(deps, { sesionId, ip: IP, conversacionId: antes.id, texto }), texto.slice(0, 5)).toEqual({
        estado: 400,
        respuesta: TEXTOS.usted.invalido,
      });
    }
    expect(await conversacion()).toEqual(despues);
  });

  it("mensajeHumano pasa por los límites: al pasarlos da 429 y no agrega nada", async () => {
    // Sesión: los mensajes de la persona cuentan junto con los del visitante.
    const porSesion = preparar({ limites: { sesionPorHora: 2 } });
    await porSesion.enviar("Hola");
    expect(await porSesion.panel("Hola, le atiende recepción.")).toEqual({ estado: 200 });
    const antes = await porSesion.conversacion();
    expect(await porSesion.panel("¿Sigue ahí?")).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite });
    expect(await porSesion.conversacion()).toEqual(antes); // ni mensaje visible ni historial

    // IP: cuenta la IP desde donde escribe la persona.
    const porIp = preparar({ limites: { ipPorHora: 2 } });
    await porIp.enviar("Hola");
    expect(await porIp.panel("Hola")).toEqual({ estado: 200 });
    expect(await porIp.panel("Hola")).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite });
    expect(await porIp.panel("Hola", "203.0.113.8")).toEqual({ estado: 200 });

    // Conversación: visitante y persona suman al mismo tope.
    const porConversacion = preparar({ limites: { mensajesPorConversacion: 3 } });
    await porConversacion.enviar("Hola");
    await porConversacion.panel("Hola, le atiende recepción.");
    await porConversacion.enviar("¿Me agenda una limpieza?");
    const llena = await porConversacion.conversacion();
    expect(await porConversacion.panel("Claro")).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite });
    expect(await porConversacion.enviar("¿Hola?")).toEqual({ estado: 429, respuesta: TEXTOS.usted.limite, modo: "bot" });
    expect(await porConversacion.conversacion()).toEqual(llena);
    expect(porConversacion.responder).toHaveBeenCalledTimes(2);
  });

  it("devolverAlBot regresa a modo bot", async () => {
    const { deps, enviar, responder, conversacion, sesionId } = preparar();
    await enviar("Hola");
    const { id } = await conversacion();
    await deps.repo.conversaciones.cambiarModo(sesionId, id, "humano");
    await mensajeHumano(deps, { sesionId, ip: IP, conversacionId: id, texto: "Hola, le atiende recepción." });

    await devolverAlBot(deps, { sesionId, conversacionId: id });
    expect((await conversacion()).modo).toBe("bot");
    expect(await enviar("Gracias, ¿me agenda una limpieza?")).toEqual({
      estado: 200,
      respuesta: "Eco: Gracias, ¿me agenda una limpieza?",
      modo: "bot",
    });
    expect(responder).toHaveBeenCalledTimes(2);
    // El bot regresa con el contexto de lo que respondió la persona.
    expect(responder.mock.calls[1][0].historialApi).toContainEqual({
      role: "user",
      content: "[Respuesta de una persona del negocio]: Hola, le atiende recepción.",
    });
  });

  it("no se puede tocar la conversación de otra sesión", async () => {
    const { deps, enviar, conversacion, sesionId } = preparar();
    await enviar("Hola");
    const { id } = await conversacion();
    await deps.repo.conversaciones.cambiarModo(sesionId, id, "humano");
    const intrusa = crypto.randomUUID();

    await expect(mensajeHumano(deps, { sesionId: intrusa, ip: IP, conversacionId: id, texto: "Hola" })).rejects.toMatchObject({
      codigo: "DATOS_INVALIDOS",
    });
    await expect(devolverAlBot(deps, { sesionId: intrusa, conversacionId: id })).rejects.toMatchObject({
      codigo: "DATOS_INVALIDOS",
    });
    const intacta = await conversacion();
    expect(intacta.modo).toBe("humano");
    expect(intacta.mensajes.map((m) => m.rol)).toEqual(["cliente", "bot"]);
    expect(intacta.historialApi).toHaveLength(2);

    // Con su propia cookie, la otra sesión solo llega a su propia conversación.
    expect(await enviar("Hola", { sesionId: intrusa })).toMatchObject({ estado: 200, modo: "bot" });
    expect((await conversacion(intrusa)).id).not.toBe(id);
    expect((await conversacion()).mensajes).toHaveLength(2);
  });
});
