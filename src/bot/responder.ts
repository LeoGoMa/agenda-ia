import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { PerfilNegocio } from "../dominio/tipos";
import type { Herramientas } from "./herramientas";
import { promptDelSistema } from "./prompt";

type MensajeApi = Anthropic.Beta.Messages.BetaMessageParam;

const MAX_TOKENS = 4000;
const MAX_VUELTAS = 6;
const TEXTOS: Record<PerfilNegocio["trato"], { negativa: string; sinTerminar: string }> = {
  tu: {
    negativa: "Perdón, no puedo ayudarte con eso. ¿Quieres que te comunique con una persona?",
    sinTerminar: "Perdón, no alcancé a terminar de revisarlo. ¿Me lo repites o quieres que te comunique con una persona?",
  },
  usted: {
    negativa: "Perdón, no puedo ayudarle con eso. ¿Quiere que le comunique con una persona?",
    sinTerminar: "Perdón, no alcancé a terminar de revisarlo. ¿Me lo repite o quiere que le comunique con una persona?",
  },
};
const NO_EJECUTADA_TOPE = `No se ejecutó: se llegó al tope de ${MAX_VUELTAS} vueltas de herramientas de este mensaje.`;
const NO_EJECUTADA_CORTADA = "No se ejecutó: la respuesta se cortó antes de terminar.";

/** Lo único que el bot usa del SDK; en las pruebas se inyecta uno falso. */
export interface ClienteClaude {
  beta: {
    messages: {
      create(
        parametros: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      ): Promise<Anthropic.Beta.Messages.BetaMessage>;
    };
  };
}

const esquemaEsfuerzo = z.enum(["low", "medium", "high", "xhigh", "max"]);

export interface ConfigBot {
  modelo: string;
  esfuerzo: z.infer<typeof esquemaEsfuerzo>;
}

/** `||` y no `??`: una variable vacía, como las de `.env.example`, cuenta como no definida. */
export function configDesdeEntorno(env: Record<string, string | undefined> = process.env): ConfigBot {
  return {
    modelo: env.ANTHROPIC_MODEL || "claude-opus-5-5",
    esfuerzo: esquemaEsfuerzo.parse(env.AGENDA_EFFORT || "low"),
  };
}

export interface RespuestaBot {
  texto: string;
  /** El historial recibido más los mensajes de este turno; el recibido no se modifica. */
  historialApi: unknown[];
  pasoAHumano: boolean;
  /** Tokens del turno. `entrada` suma los de entrada sin caché y los que se escriben en caché. */
  uso: { entrada: number; salida: number; cacheLeida: number };
}

/**
 * Contesta un mensaje del visitante con un bucle manual de herramientas: hasta `end_turn`,
 * `refusal` o 6 llamadas a la API. Cada respuesta del asistente se guarda con su `content` completo
 * y sus herramientas se contestan en un solo mensaje `user`.
 */
export async function responder({
  cliente,
  perfil,
  historialApi,
  mensaje,
  herramientas,
  config,
}: {
  cliente: ClienteClaude;
  perfil: PerfilNegocio;
  historialApi: unknown[];
  mensaje: string;
  herramientas: Herramientas;
  config: ConfigBot;
}): Promise<RespuestaBot> {
  const mensajes: MensajeApi[] = [...(historialApi as MensajeApi[]), { role: "user", content: mensaje }];
  const uso = { entrada: 0, salida: 0, cacheLeida: 0 };
  const textos = TEXTOS[perfil.trato];
  // La marca explícita cachea herramientas + prompt, compartidos por todas las conversaciones del negocio;
  // la de nivel superior cachea además la conversación que va creciendo.
  const system: Anthropic.Beta.Messages.BetaTextBlockParam[] = [
    { type: "text", text: promptDelSistema(perfil), cache_control: { type: "ephemeral" } },
  ];
  let pasoAHumano = false;
  const terminar = (texto: string): RespuestaBot => ({ texto, historialApi: mensajes, pasoAHumano, uso });

  for (let vuelta = 1; ; vuelta++) {
    const respuesta = await cliente.beta.messages.create({
      model: config.modelo,
      max_tokens: MAX_TOKENS,
      output_config: { effort: config.esfuerzo },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      tool_choice: { type: "auto" },
      system,
      tools: herramientas.definiciones,
      messages: mensajes,
    });
    uso.entrada += respuesta.usage.input_tokens + (respuesta.usage.cache_creation_input_tokens ?? 0);
    uso.salida += respuesta.usage.output_tokens;
    uso.cacheLeida += respuesta.usage.cache_read_input_tokens ?? 0;

    // Se negó toda la cadena de modelos. La respuesta puede traer un tool_use cortado: ni se guarda ni se ejecuta.
    // Si se negó de entrada, tampoco se guarda el mensaje del visitante: reenviarlo en cada turno repetiría la negativa.
    // Si ya hubo vueltas, se conservan, porque sus herramientas pudieron cambiar datos, y la disculpa cierra el turno
    // para que el modelo vea lo mismo que el visitante.
    if (respuesta.stop_reason === "refusal") {
      if (vuelta === 1) mensajes.pop();
      else mensajes.push({ role: "assistant", content: textos.negativa });
      return terminar(textos.negativa);
    }

    mensajes.push({ role: "assistant", content: respuesta.content });
    const llamadas = respuesta.content.filter((b) => b.type === "tool_use");

    if (respuesta.stop_reason !== "tool_use" || vuelta === MAX_VUELTAS) {
      const texto = respuesta.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n")
        .trim();
      const visible = respuesta.stop_reason === "end_turn" && texto ? texto : textos.sinTerminar;
      // Sin otra vuelta nadie vería el resultado, así que no se ejecuta (no se agenda nada a ciegas);
      // aun así cada tool_use necesita su tool_result o el siguiente mensaje da 400. Después, el turno
      // cierra con el texto que vio el visitante, para que el modelo tenga el mismo contexto.
      if (llamadas.length > 0) {
        const motivo = respuesta.stop_reason === "tool_use" ? NO_EJECUTADA_TOPE : NO_EJECUTADA_CORTADA;
        mensajes.push({
          role: "user",
          content: llamadas.map((l) => ({
            type: "tool_result" as const,
            tool_use_id: l.id,
            is_error: true,
            content: JSON.stringify({ ok: false, codigo: "NO_EJECUTADA", mensaje: motivo }),
          })),
        });
        mensajes.push({ role: "assistant", content: visible });
      }
      return terminar(visible);
    }

    const resultados: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const llamada of llamadas) {
      const { contenido, esError } = await herramientas.ejecutar(llamada.name, llamada.input);
      if (llamada.name === "pasar_a_humano" && !esError) pasoAHumano = true;
      resultados.push({ type: "tool_result", tool_use_id: llamada.id, is_error: esError, content: contenido });
    }
    mensajes.push({ role: "user", content: resultados });
  }
}
