import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  ThinkingLevel,
  type Content,
  type FunctionCall,
  type GenerateContentParameters,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import type { PerfilNegocio } from "../dominio/tipos";
import type { Herramientas } from "./herramientas";
import { promptDelSistema } from "./prompt";
import {
  MAX_HERRAMIENTAS_POR_VUELTA,
  MAX_TOKENS,
  MAX_VUELTAS,
  NO_EJECUTADA_CORTADA,
  NO_EJECUTADA_DEMASIADAS,
  NO_EJECUTADA_TOPE,
  TEXTOS,
  type RespuestaBot,
} from "./responder";

/** Lo único que el bot usa del SDK de Google; en las pruebas se inyecta uno falso. */
export interface ClienteGemini {
  models: { generateContent(parametros: GenerateContentParameters): Promise<GenerateContentResponse> };
}

/** `||` y no `??`: una variable vacía, como las de `.env.example`, cuenta como no definida. */
export const modeloGeminiDesdeEntorno = (env: Record<string, string | undefined> = process.env) =>
  env.GEMINI_MODEL || "gemini-3.5-flash-lite";

/** Google no contestó: en la primera vuelta todavía no pasó nada; después, alguna herramienta pudo guardar algo. */
const OCUPADO: Record<PerfilNegocio["trato"], { deEntrada: string; aMedias: string }> = {
  tu: {
    deEntrada: "Ahorita tengo demasiadas consultas y no puedo contestarte. Intenta de nuevo en un rato.",
    aMedias:
      "Se me juntaron muchas consultas antes de terminar. Parte de lo que pediste pudo quedar registrado: en un rato pregúntame qué citas tienes antes de repetirlo.",
  },
  usted: {
    deEntrada: "En este momento tengo demasiadas consultas y no puedo contestarle. Intente de nuevo en un rato.",
    aMedias:
      "Se me juntaron muchas consultas antes de terminar. Parte de lo que pidió pudo quedar registrado: en un rato pregúnteme qué citas tiene antes de repetirlo.",
  },
};

/** Respuestas que Google bloquea: valen lo mismo que la negativa de Claude. */
const BLOQUEOS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

/** 429: se acabó la cuota gratis, por minuto o por día; 503: el modelo está saturado. */
const esOcupado = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 429 || e.status === 503);

/** En modo humano el chat agrega `{ role, content: texto }` al historial; Gemini lo pide como `parts`. */
function aContenido(mensaje: unknown): Content {
  const { role, content } = mensaje as { role: string; content?: unknown };
  return typeof content === "string" ? { role: role === "assistant" ? "model" : "user", parts: [{ text: content }] } : (mensaje as Content);
}

const respuestaA = (llamada: FunctionCall, response: Record<string, unknown>): Part => ({
  functionResponse: { id: llamada.id, name: llamada.name, response },
});

/** Cada functionCall necesita su functionResponse, o la siguiente petición da 400. */
const noEjecutada = (llamada: FunctionCall, mensaje: string) => respuestaA(llamada, { error: { ok: false, codigo: "NO_EJECUTADA", mensaje } });

/**
 * El mismo turno que `responder` (Claude), con Gemini: bucle manual de herramientas hasta que el modelo contesta
 * con texto, lo bloquean o llega a 6 llamadas a la API. El content del modelo se guarda tal cual: con los modelos
 * 3.x, sus `thoughtSignature` deben volver intactas o la API responde 400.
 */
export async function responderGemini({
  cliente,
  modelo,
  perfil,
  historialApi,
  mensaje,
  herramientas,
}: {
  cliente: ClienteGemini;
  modelo: string;
  perfil: PerfilNegocio;
  historialApi: unknown[];
  mensaje: string;
  herramientas: Herramientas;
}): Promise<RespuestaBot> {
  const contenidos: Content[] = [...historialApi.map(aContenido), { role: "user", parts: [{ text: mensaje }] }];
  const uso = { entrada: 0, salida: 0, cacheLeida: 0 };
  const textos = TEXTOS[perfil.trato];
  const config: GenerateContentParameters["config"] = {
    systemInstruction: promptDelSistema(perfil),
    // Las mismas definiciones que usa Claude; `strict` se queda fuera porque Gemini no lo conoce.
    tools: [
      {
        functionDeclarations: herramientas.definiciones.map((d) => ({
          name: d.name,
          description: d.description,
          parametersJsonSchema: d.input_schema,
        })),
      },
    ],
    toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
    maxOutputTokens: MAX_TOKENS,
    thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
  };
  let pasoAHumano = false;
  const terminar = (texto: string): RespuestaBot => ({ texto, historialApi: contenidos, pasoAHumano, uso });
  /** Cierra el turno con el texto que vio el visitante, para que el modelo tenga el mismo contexto. */
  const cerrarCon = (visible: string) => contenidos.push({ role: "model", parts: [{ text: visible }] });
  /**
   * Sin respuesta que guardar (bloqueo o Google ocupado). De entrada tampoco se guarda el mensaje del visitante:
   * reenviarlo en cada turno repetiría el problema. Si ya hubo vueltas se conservan, porque sus herramientas
   * pudieron cambiar datos, y el turno cierra con el texto visible.
   */
  const cortar = (vuelta: number, visible: string) => {
    if (vuelta === 1) contenidos.pop();
    else cerrarCon(visible);
    return terminar(visible);
  };

  for (let vuelta = 1; ; vuelta++) {
    let respuesta: GenerateContentResponse;
    try {
      respuesta = await cliente.models.generateContent({ model: modelo, contents: contenidos, config });
    } catch (e) {
      if (!esOcupado(e)) throw e;
      // Solo el código: el visitante ve 200 con el aviso, y sin esta línea una cuota diaria agotada no dejaría rastro.
      console.warn(`Gemini respondió ${e.status} (cuota agotada o modelo saturado); se avisó al visitante.`);
      const { deEntrada, aMedias } = OCUPADO[perfil.trato];
      return cortar(vuelta, vuelta === 1 ? deEntrada : aMedias);
    }
    const medida = respuesta.usageMetadata;
    const deCache = medida?.cachedContentTokenCount ?? 0;
    uso.entrada += (medida?.promptTokenCount ?? 0) - deCache;
    uso.salida += (medida?.candidatesTokenCount ?? 0) + (medida?.thoughtsTokenCount ?? 0);
    uso.cacheLeida += deCache;

    const candidato = respuesta.candidates?.[0];
    const motivo = candidato?.finishReason;
    // Una respuesta bloqueada puede traer un functionCall a medias: ni se guarda ni se ejecuta.
    if (respuesta.promptFeedback?.blockReason || (motivo && BLOQUEOS.has(motivo))) return cortar(vuelta, textos.negativa);

    const partes = candidato?.content?.parts ?? [];
    // Un model con parts vacío da 400 al reenviar el historial.
    if (partes.length > 0) contenidos.push({ role: "model", parts: partes });
    const llamadas = partes.flatMap((p) => (p.functionCall ? [p.functionCall] : []));
    const completa = motivo === FinishReason.STOP;

    if (!completa || llamadas.length === 0 || vuelta === MAX_VUELTAS) {
      const texto = partes
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      const visible = completa && llamadas.length === 0 && texto ? texto : textos.sinTerminar;
      // Sin otra vuelta nadie vería el resultado, así que no se ejecuta (no se agenda nada a ciegas).
      if (llamadas.length > 0) {
        const motivoNoEjecutada = completa ? NO_EJECUTADA_TOPE : NO_EJECUTADA_CORTADA;
        contenidos.push({ role: "user", parts: llamadas.map((l) => noEjecutada(l, motivoNoEjecutada)) });
      }
      if (llamadas.length > 0 || visible !== texto) cerrarCon(visible);
      return terminar(visible);
    }

    const resultados: Part[] = [];
    for (const [i, llamada] of llamadas.entries()) {
      if (i >= MAX_HERRAMIENTAS_POR_VUELTA) {
        resultados.push(noEjecutada(llamada, NO_EJECUTADA_DEMASIADAS));
        continue;
      }
      // Las herramientas sin parámetros llegan sin `args`.
      const { contenido, esError } = await herramientas.ejecutar(llamada.name ?? "", llamada.args ?? {});
      if (llamada.name === "pasar_a_humano" && !esError) pasoAHumano = true;
      const datos = JSON.parse(contenido) as Record<string, unknown>;
      resultados.push(respuestaA(llamada, esError ? { error: datos } : { output: datos }));
    }
    contenidos.push({ role: "user", parts: resultados });
  }
}
