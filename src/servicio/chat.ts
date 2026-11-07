import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { crearHerramientas } from "../bot/herramientas";
import { promptDelSistema } from "../bot/prompt";
import type { RespuestaBot, responder } from "../bot/responder";
import { obtenerPerfil } from "../dominio/perfiles";
import type { PerfilNegocio } from "../dominio/tipos";
import type { Conversacion, Repositorio } from "../repo/tipos";
import type { Limitador } from "./limites";

const MAX_CARACTERES = 1000;
/** Tope del historial serializado que se manda a Claude: cada llamada paga todo el historial como entrada. */
const MAX_HISTORIAL_CARACTERES = 120_000;
const TEXTOS: Record<PerfilNegocio["trato"], { invalido: string; limite: string; enEspera: string }> = {
  tu: {
    invalido: "Escribe un mensaje de 1 a 1000 caracteres.",
    limite: "Llegaste al límite de la demo por ahora. Si quieres un bot así para tu negocio, escríbele a Forge Studio.",
    enEspera: "Te atiende una persona; en un momento te contesta",
  },
  usted: {
    invalido: "Escriba un mensaje de 1 a 1000 caracteres.",
    limite: "Llegó al límite de la demo por ahora. Si quiere un bot así para su negocio, escríbale a Forge Studio.",
    enEspera: "Le atiende una persona; en un momento le contesta",
  },
};

/** `responder` del bot con el cliente de Claude y la config ya puestos; en las pruebas, uno falso sin red. */
export type Responder = (entrada: Omit<Parameters<typeof responder>[0], "cliente" | "config">) => Promise<RespuestaBot>;

export interface DepsChat {
  repo: Repositorio;
  limitador: Limitador;
  responder: Responder;
  /** El modelo efectivo de Claude: entra en la versión del historial. */
  modelo: string;
  ahora: () => Date;
}

export interface RespuestaChat {
  estado: 200 | 400 | 429;
  respuesta: string;
  modo: Conversacion["modo"];
}

export type RespuestaPanel = { estado: 200 } | { estado: 400 | 429; respuesta: string };

/** NUL y los demás controles C0 salvo \t y \n: Postgres no guarda NUL en `text` y los otros no salen de un teclado. */
const CONTROL_C0 = /[\u0000-\u0008\u000b-\u001f]/;

/**
 * El texto sin espacios a los lados, o null si queda vacío, pasa de 1000 caracteres (un emoji cuenta como uno)
 * o trae un carácter de control. El control se busca antes de recortar: también se rechaza en las orillas.
 */
function textoValido(texto: unknown): string | null {
  const limpio = typeof texto === "string" && !CONTROL_C0.test(texto) ? texto.trim() : "";
  const largo = [...limpio].length;
  return largo >= 1 && largo <= MAX_CARACTERES ? limpio : null;
}

/** Con esta marca entran al historial de la API las respuestas de la persona del negocio (`mensajeHumano`). */
const MARCA_PERSONA = "[Respuesta de una persona del negocio]";
const MARCA_EN_TEXTO = /\[(\s*respuesta de una persona del negocio\s*)\]/gi;

/** El texto del visitante con la marca de la persona del negocio cambiada a paréntesis: así no se hace pasar por ella. */
const sinMarcaPersona = (texto: string) => texto.replace(MARCA_EN_TEXTO, "($1)");

/** Visitante y persona del negocio comparten el tope por conversación: los dos hacen crecer el historial. */
const mensajesConversacion = (conv: Conversacion) => conv.mensajes.filter((m) => m.rol === "cliente" || m.rol === "humano").length;

/**
 * Cambia si se edita el perfil o una herramienta, o cambia el modelo, y se redespliega. Un historial armado con otra
 * versión no se reenvía: sus bloques de pensamiento van atados al prompt y al modelo con que se generaron.
 */
function versionPrompt(perfil: PerfilNegocio, definiciones: Anthropic.Beta.BetaTool[], modelo: string): string {
  return createHash("sha256").update(JSON.stringify([promptDelSistema(perfil), definiciones, modelo])).digest("hex");
}

/**
 * Un mensaje del visitante: valida, revisa límites, lo guarda y, si la conversación está con el bot, le contesta.
 * Un texto inválido da 400 sin crear la conversación. Con un historial de más de 120 000 caracteres responde
 * el 429 sin llamar a Claude ni gastar contadores (el historial nunca se recorta).
 * Un negocio inexistente lanza `DATOS_INVALIDOS`; un error del bot sube a quien llama sin guardar el turno a medias.
 */
export async function manejarMensaje(
  deps: DepsChat,
  { sesionId, ip, negocioId, texto }: { sesionId: string; ip: string; negocioId: string; texto: string },
): Promise<RespuestaChat> {
  const { repo, ahora } = deps;
  const perfil = obtenerPerfil(negocioId);
  const textos = TEXTOS[perfil.trato];

  const limpio = textoValido(texto);
  if (limpio === null) {
    const [existente] = await repo.conversaciones.listar(sesionId, negocioId);
    return { estado: 400, respuesta: textos.invalido, modo: existente?.modo ?? "bot" };
  }

  const conv = await repo.conversaciones.obtenerOCrear(sesionId, negocioId);
  const herramientas = crearHerramientas({
    repo,
    perfil,
    sesionId,
    conversacionId: conv.id,
    ahora,
    // El modo cambia al final, con `pasoAHumano` y junto con el historial: si el turno falla, no queda a medias.
    alPasarAHumano: async () => {},
  });
  const version = versionPrompt(perfil, herramientas.definiciones, deps.modelo);
  // Sin versión, el historial solo trae texto del modo humano, que se puede reenviar con cualquier prompt.
  const historialApi = conv.versionPrompt === null || conv.versionPrompt === version ? conv.historialApi : [];
  // Antes del limitador: un 429 por tamaño no gasta los contadores de sesión e IP.
  if (conv.modo === "bot" && JSON.stringify(historialApi).length > MAX_HISTORIAL_CARACTERES) {
    return { estado: 429, respuesta: textos.limite, modo: conv.modo };
  }

  const limite = await deps.limitador.verificar({
    ip,
    sesionId,
    esNuevaConversacion: conv.mensajesVisitante === 0,
    mensajesConversacion: mensajesConversacion(conv),
    llamaAlBot: conv.modo === "bot",
  });
  if (!limite.permitido) return { estado: 429, respuesta: textos.limite, modo: conv.modo };

  const mensajeCliente = { rol: "cliente" as const, texto: limpio, creadoEn: ahora().toISOString() };
  // El mensaje visible queda como lo escribió; al modelo le llega sin la marca de la persona del negocio.
  const paraApi = sinMarcaPersona(limpio);
  if (conv.modo === "humano") {
    await repo.conversaciones.agregarMensaje(sesionId, conv.id, mensajeCliente);
    // También va al historial de la API, para que el bot tenga el contexto si le regresan la conversación.
    const historial = [...conv.historialApi, { role: "user", content: paraApi }];
    await repo.conversaciones.guardarHistorialApi(sesionId, conv.id, historial, conv.versionPrompt);
    return { estado: 200, respuesta: textos.enEspera, modo: "humano" };
  }

  await repo.conversaciones.agregarMensaje(sesionId, conv.id, mensajeCliente);
  const bot = await deps.responder({ perfil, historialApi, mensaje: paraApi, herramientas });
  // shortcut: cada petición (aquí y en `mensajeHumano`) lee la conversación al inicio y al final reemplaza el historial
  // de la API, sin candado. Carreras conocidas: (1) en modo bot, un doble clic, mensajes en paralelo o una persona que
  // escribe desde el panel mientras el bot contesta: el último en guardar pisa al otro en historialApi (los mensajes
  // visibles y las citas sí quedan); (2) con peticiones simultáneas, el tope por conversación se revisa con el conteo
  // leído al inicio y se puede pasar por unas cuantas; (3) en modo humano, si el visitante y la persona escriben a la
  // vez, uno de los dos mensajes queda visible pero fuera de historialApi. La interfaz desactiva el envío mientras hay
  // una petición en curso; si hace falta más, un candado por conversación (advisory lock en una RPC).
  await repo.conversaciones.guardarHistorialApi(sesionId, conv.id, bot.historialApi, version);
  await repo.conversaciones.agregarMensaje(sesionId, conv.id, { rol: "bot", texto: bot.texto, creadoEn: ahora().toISOString() });
  if (bot.pasoAHumano) await repo.conversaciones.cambiarModo(sesionId, conv.id, "humano");
  return { estado: 200, respuesta: bot.texto, modo: bot.pasoAHumano ? "humano" : "bot" };
}

/**
 * Respuesta de una persona desde el panel. En la demo el panel lo maneja el mismo visitante, así que pasa por
 * los mismos límites (sesión, IP y conversación) y los mismos textos de 400 y 429 que sus mensajes.
 * Una conversación de otra sesión lanza `DATOS_INVALIDOS`.
 */
export async function mensajeHumano(
  { repo, ahora, limitador }: Pick<DepsChat, "repo" | "ahora" | "limitador">,
  { sesionId, ip, conversacionId, texto }: { sesionId: string; ip: string; conversacionId: string; texto: string },
): Promise<RespuestaPanel> {
  const conv = await repo.conversaciones.obtener(sesionId, conversacionId);
  const textos = TEXTOS[obtenerPerfil(conv.negocioId).trato];
  const limpio = textoValido(texto);
  if (limpio === null) return { estado: 400, respuesta: textos.invalido };
  const limite = await limitador.verificar({
    ip,
    sesionId,
    esNuevaConversacion: false,
    mensajesConversacion: mensajesConversacion(conv),
    llamaAlBot: false,
  });
  if (!limite.permitido) return { estado: 429, respuesta: textos.limite };

  await repo.conversaciones.agregarMensaje(sesionId, conv.id, { rol: "humano", texto: limpio, creadoEn: ahora().toISOString() });
  // Va como mensaje `user` marcado: el bot conserva el contexto si le regresan la conversación.
  const historial = [...conv.historialApi, { role: "user", content: `${MARCA_PERSONA}: ${limpio}` }];
  await repo.conversaciones.guardarHistorialApi(sesionId, conv.id, historial, conv.versionPrompt);
  return { estado: 200 };
}

/** Una conversación de otra sesión lanza `DATOS_INVALIDOS`. */
export async function devolverAlBot(
  { repo }: Pick<DepsChat, "repo">,
  { sesionId, conversacionId }: { sesionId: string; conversacionId: string },
): Promise<void> {
  await repo.conversaciones.cambiarModo(sesionId, conversacionId, "bot");
}
