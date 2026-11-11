export type Proveedor = "claude" | "gemini";

/**
 * Quién contesta: Claude si está su llave (gana si están las dos), Gemini si solo está la de Google. Sin ninguna
 * cuenta como Claude, como antes de que existiera Gemini. Lo usan deps, para armar el responder, y la página, para
 * el aviso de privacidad; aquí no se importa ningún SDK, así la página no los carga.
 */
export const proveedorDesdeEntorno = (env: Record<string, string | undefined> = process.env): Proveedor =>
  !env.ANTHROPIC_API_KEY && env.GEMINI_API_KEY ? "gemini" : "claude";
