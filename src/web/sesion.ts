// Sin imports: lo usa también proxy.ts, que corre antes de cada página.

export const COOKIE_SESION = "agenda_sesion";
/** Lo mismo que tarda la limpieza diaria en borrar la sesión. */
export const DURACION_SESION_SEG = 7 * 24 * 60 * 60;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EN_ENCABEZADO = new RegExp(`(?:^|;\\s*)${COOKIE_SESION}=([^;]*)`);

export const esSesionValida = (valor: string | undefined): valor is string => valor !== undefined && UUID_V4.test(valor);

/** El id de sesión sale solo de la cookie, nunca de la URL ni del cuerpo; null si falta o no es un uuid v4. */
export function sesionDe(peticion: Request): string | null {
  const valor = peticion.headers.get("cookie")?.match(EN_ENCABEZADO)?.[1];
  return esSesionValida(valor) ? valor : null;
}
