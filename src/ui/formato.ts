import { MARCA_DEMO } from "../bot/responderDev";
import { partesLocales } from "../dominio/tiempo";
import type { Cita } from "../dominio/tipos";
import type { Conversacion } from "../repo/tipos";

const DIA = 24 * 60 * 60_000;
const GENERICO = "Algo salió mal. Inténtalo de nuevo en un momento.";
const DIA_LARGO = new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const PLURAL = new Intl.PluralRules("es-MX");
const NUMERO = new Intl.NumberFormat("es-MX");

export const ETIQUETA_MODO: Record<Conversacion["modo"], string> = { bot: "Bot", humano: "Persona" };
export const ETIQUETA_ESTADO: Record<Cita["estado"], string> = { confirmada: "Confirmada", cancelada: "Cancelada" };

/** "HH:MM" (24 horas) de un instante ISO, en la hora local de `zona`. */
export const etiquetaHora = (iso: string, zona: string) => partesLocales(new Date(iso), zona).hora;

/** "2026-11-09" → "lunes 9 de noviembre". Por partes: el texto no depende de la coma que ponga cada motor. */
function diaLargo(fecha: string): string {
  const p = Object.fromEntries(DIA_LARGO.formatToParts(new Date(`${fecha}T12:00:00Z`)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} de ${p.month}`;
}

/** Las citas por día local de `zona`, en orden; el título dice «Hoy» o «Mañana» según `ahora`. */
export function agruparPorDia<T extends { inicio: string }>(citas: T[], zona: string, ahora: Date = new Date()) {
  const hoy = partesLocales(ahora, zona).fecha;
  const manana = new Date(Date.parse(`${hoy}T00:00:00Z`) + DIA).toISOString().slice(0, 10);
  const grupos = new Map<string, T[]>();
  for (const cita of [...citas].sort((a, b) => Date.parse(a.inicio) - Date.parse(b.inicio))) {
    const { fecha } = partesLocales(new Date(cita.inicio), zona);
    grupos.set(fecha, [...(grupos.get(fecha) ?? []), cita]);
  }
  return [...grupos].map(([fecha, delDia]) => {
    const dia = diaLargo(fecha);
    const titulo = fecha === hoy ? `Hoy · ${dia}` : fecha === manana ? `Mañana · ${dia}` : dia[0].toUpperCase() + dia.slice(1);
    return { fecha, titulo, citas: delDia };
  });
}

/** 10 dígitos de México (con o sin lada 52) en grupos: 55, 33 y 81 van 2-4-4; las demás ladas, 3-3-4. */
export function formatoTelefono(telefono: string): string {
  const d = telefono.replace(/\D/g, "").replace(/^52(\d{10})$/, "$1");
  if (d.length !== 10) return telefono;
  return /^(55|33|81)/.test(d) ? `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}` : `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/** El responder de demostración firma al final; la interfaz quita la firma y muestra la etiqueta «demo sin IA». */
export function separarMarcaDemo(texto: string): { texto: string; demo: boolean } {
  return texto.endsWith(MARCA_DEMO) ? { texto: texto.slice(0, -MARCA_DEMO.length).trimEnd(), demo: true } : { texto, demo: false };
}

/** Lo que se le muestra a la persona cuando algo no salió bien: `respuesta` del servicio o `error` de la ruta. */
export function textoDeAviso(cuerpo: unknown): string {
  const { respuesta, error } = ((typeof cuerpo === "object" && cuerpo) || {}) as { respuesta?: unknown; error?: unknown };
  if (typeof respuesta === "string" && respuesta) return respuesta;
  if (typeof error === "string" && error) return error;
  return GENERICO;
}

export const contarCitas = (n: number) => `${NUMERO.format(n)} ${PLURAL.select(n) === "one" ? "cita" : "citas"}`;
