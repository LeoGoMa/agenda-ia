import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { crearHerramientas } from "../bot/herramientas";
import { promptDelSistema } from "../bot/prompt";
import type { RespuestaBot, responder } from "../bot/responder";
import { obtenerPerfil } from "../dominio/perfiles";
import { ErrorDominio, type PerfilNegocio } from "../dominio/tipos";
import type { Conversacion, Repositorio } from "../repo/tipos";
import type { Limitador } from "./limites";

const MAX_CARACTERES = 1000;
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
  ahora: () => Date;
}

export interface RespuestaChat {
  estado: 200 | 400 | 429;
  respuesta: string;
  modo: Conversacion["modo"];
}

/** El texto sin espacios a los lados, o null si queda vacío o pasa de 1000 caracteres (un emoji cuenta como uno). */
function textoValido(texto: unknown): string | null {
  const limpio = typeof texto === "string" ? texto.trim() : "";
  const largo = [...limpio].length;
  return largo >= 1 && largo <= MAX_CARACTERES ? limpio : null;
}

/**
 * Cambia si se edita el perfil o una herramienta y se redespliega. Un historial armado con otra versión
 * no se reenvía: sus bloques de pensamiento van atados al prompt con que se generaron.
 */
function versionPrompt(perfil: PerfilNegocio, definiciones: Anthropic.Beta.BetaTool[]): string {
  return createHash("sha256").update(JSON.stringify([promptDelSistema(perfil), definiciones])).digest("hex");
}

/**
 * Un mensaje del visitante: valida, revisa límites, lo guarda y, si la conversación está con el bot, le contesta.
 * Un negocio inexistente lanza `DATOS_INVALIDOS`; un error del bot sube a quien llama sin guardar el turno a medias.
 */
export async function manejarMensaje(
  deps: DepsChat,
  { sesionId, ip, negocioId, texto }: { sesionId: string; ip: string; negocioId: string; texto: string },
): Promise<RespuestaChat> {
  const { repo, ahora } = deps;
  const perfil = obtenerPerfil(negocioId);
  const textos = TEXTOS[perfil.trato];
  const conv = await repo.conversaciones.obtenerOCrear(sesionId, negocioId);

  const limpio = textoValido(texto);
  if (limpio === null) return { estado: 400, respuesta: textos.invalido, modo: conv.modo };

  const limite = await deps.limitador.verificar({
    ip,
    sesionId,
    esNuevaConversacion: conv.mensajesVisitante === 0,
    mensajesVisitante: conv.mensajesVisitante,
  });
  if (!limite.permitido) return { estado: 429, respuesta: textos.limite, modo: conv.modo };

  await repo.conversaciones.agregarMensaje(conv.id, { rol: "cliente", texto: limpio, creadoEn: ahora().toISOString() });

  if (conv.modo === "humano") {
    // También va al historial de la API, para que el bot tenga el contexto si le regresan la conversación.
    await repo.conversaciones.guardarHistorialApi(conv.id, [...conv.historialApi, { role: "user", content: limpio }], conv.versionPrompt);
    return { estado: 200, respuesta: textos.enEspera, modo: "humano" };
  }

  const herramientas = crearHerramientas({
    repo,
    perfil,
    sesionId,
    conversacionId: conv.id,
    ahora,
    // El modo cambia al final, con `pasoAHumano` y junto con el historial: si el turno falla, no queda a medias.
    alPasarAHumano: async () => {},
  });
  const version = versionPrompt(perfil, herramientas.definiciones);
  const bot = await deps.responder({
    perfil,
    historialApi: conv.versionPrompt === version ? conv.historialApi : [],
    mensaje: limpio,
    herramientas,
  });
  // shortcut: se reemplaza el historial leído al inicio del turno; si durante esos segundos una persona escribe
  // desde el panel, su mensaje queda visible pero sale del historial de la API. Revisar si el panel deja escribir en modo bot.
  await repo.conversaciones.guardarHistorialApi(conv.id, bot.historialApi, version);
  await repo.conversaciones.agregarMensaje(conv.id, { rol: "bot", texto: bot.texto, creadoEn: ahora().toISOString() });
  if (bot.pasoAHumano) await repo.conversaciones.cambiarModo(sesionId, conv.id, "humano");
  return { estado: 200, respuesta: bot.texto, modo: bot.pasoAHumano ? "humano" : "bot" };
}

/** Respuesta de una persona desde el panel. Un texto inválido o una conversación de otra sesión lanzan `DATOS_INVALIDOS`. */
export async function mensajeHumano(
  { repo, ahora }: Pick<DepsChat, "repo" | "ahora">,
  { sesionId, conversacionId, texto }: { sesionId: string; conversacionId: string; texto: string },
): Promise<void> {
  const limpio = textoValido(texto);
  if (limpio === null) throw new ErrorDominio("DATOS_INVALIDOS", `El mensaje debe tener de 1 a ${MAX_CARACTERES} caracteres`);
  const conv = await repo.conversaciones.obtener(sesionId, conversacionId);
  await repo.conversaciones.agregarMensaje(conv.id, { rol: "humano", texto: limpio, creadoEn: ahora().toISOString() });
  // Va como mensaje `user` marcado: el bot conserva el contexto si le regresan la conversación.
  const historial = [...conv.historialApi, { role: "user", content: `[Respuesta de una persona del negocio]: ${limpio}` }];
  await repo.conversaciones.guardarHistorialApi(conv.id, historial, conv.versionPrompt);
}

/** Una conversación de otra sesión lanza `DATOS_INVALIDOS`. */
export async function devolverAlBot(
  { repo }: Pick<DepsChat, "repo">,
  { sesionId, conversacionId }: { sesionId: string; conversacionId: string },
): Promise<void> {
  await repo.conversaciones.cambiarModo(sesionId, conversacionId, "bot");
}
