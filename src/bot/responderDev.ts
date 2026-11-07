import type { Responder } from "../servicio/chat";

/** Va al final de cada respuesta: quien prueba la demo sabe que no contestó Claude. */
export const MARCA_DEMO = "(modo de demostración sin IA)";

const DIA = 24 * 60 * 60_000;
const DIAS_A_BUSCAR = 14;
// Datos de demostración: teléfono en el formato reservado `55 0000 00xx`.
const CLIENTE = { nombre: "Cliente Demo", telefono: "55 0000 0001" };

/** "2026-11-09" → "lunes 9 de noviembre". */
const diaLargo = (fecha: string) =>
  new Intl.DateTimeFormat("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(`${fecha}T12:00:00Z`))
    .replace(",", "");

/** Sin acentos y en minúsculas, para reconocer palabras clave. */
const normal = (texto: string) => texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Responder guionado para desarrollo sin `ANTHROPIC_API_KEY`: no usa la red. Reconoce tres pedidos y para
 * cada uno llama a las herramientas reales (disponibilidad, agendar y pasar a humano), así el flujo de la demo
 * (chat → cita en el panel → paso a humano) funciona igual que con Claude. Lo demás recibe el saludo.
 * Siempre ofrece y agenda el primer servicio del perfil, a nombre de un cliente de demostración.
 */
export const responderDev: Responder = async ({ perfil, historialApi, mensaje, herramientas }) => {
  const usar = async <T>(nombre: string, entrada: object = {}) =>
    JSON.parse((await herramientas.ejecutar(nombre, entrada)).contenido) as T & { ok: boolean; mensaje?: string };
  const servicio = perfil.servicios[0];
  const sinHorarios = `No hay horarios libres para ${servicio.nombre} en los próximos ${DIAS_A_BUSCAR} días.`;

  /** El primer día, desde hoy (hora local del negocio), con horarios libres del servicio. */
  const primerDiaLibre = async () => {
    const { fecha: hoy } = await usar<{ fecha: string }>("obtener_fecha_hora");
    for (let i = 0; i < DIAS_A_BUSCAR; i++) {
      const fecha = new Date(Date.parse(`${hoy}T00:00:00Z`) + i * DIA).toISOString().slice(0, 10);
      // Fuera de la ventana de políticas la herramienta responde ok: false; ese día se salta.
      const r = await usar<{ horarios: { inicio: string; etiqueta: string }[] }>("ver_disponibilidad", { servicioId: servicio.id, fecha });
      if (r.ok && r.horarios.length > 0) return { fecha, horarios: r.horarios };
    }
    return null;
  };

  const pedido = normal(mensaje);
  let texto: string;
  let pasoAHumano = false;
  if (/humano|persona|asesor/.test(pedido)) {
    const r = await usar("pasar_a_humano", { motivo: "El cliente pidió hablar con una persona." });
    pasoAHumano = r.ok;
    texto = "Listo, una persona del negocio seguirá la conversación.";
  } else if (/agend|reserv|apart/.test(pedido)) {
    const dia = await primerDiaLibre();
    if (!dia) {
      texto = sinHorarios;
    } else {
      const r = await usar<{ cita: { fecha: string; hora: string } }>("agendar_cita", {
        servicioId: servicio.id,
        inicio: dia.horarios[0].inicio,
        ...CLIENTE,
      });
      texto = r.ok
        ? `Listo: quedó agendada la cita de ${servicio.nombre} el ${diaLargo(r.cita.fecha)} a las ${r.cita.hora}, a nombre de ${CLIENTE.nombre} (${CLIENTE.telefono}).`
        : `No se pudo agendar: ${r.mensaje}`;
    }
  } else if (/horario|disponib|cuando/.test(pedido)) {
    const dia = await primerDiaLibre();
    const lista = new Intl.ListFormat("es", { type: "conjunction" });
    texto = dia
      ? `Primeros horarios libres para ${servicio.nombre} el ${diaLargo(dia.fecha)}: ${lista.format(dia.horarios.slice(0, 3).map((h) => h.etiqueta))}. Para apartar el primero: «agenda el primero».`
      : sinHorarios;
  } else {
    texto = `Hola, soy el asistente de citas de ${perfil.nombre}. En este modo de prueba entiendo tres cosas: «horarios», «agenda el primero» y «pasar a humano».`;
  }

  texto = `${texto}\n\n${MARCA_DEMO}`;
  return {
    texto,
    // Mismo formato que el responder real: si después se pone la llave, Claude recibe este historial tal cual.
    historialApi: [...historialApi, { role: "user", content: mensaje }, { role: "assistant", content: [{ type: "text", text: texto }] }],
    pasoAHumano,
    uso: { entrada: 0, salida: 0, cacheLeida: 0 },
  };
};
