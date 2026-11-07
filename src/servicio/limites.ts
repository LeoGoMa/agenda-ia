import { createHash } from "node:crypto";

const HORA_SEG = 60 * 60;
const DIA_SEG = 24 * HORA_SEG;
/** Solo para desarrollo y pruebas: es pública (está en el repo), así que en producción se exige AGENDA_SAL_IP. */
const SAL_SOLO_DESARROLLO = "agenda-ia-sal-solo-desarrollo";

/** Contadores por ventana fija; en producción, la tabla `contadores` de Supabase (tarea 6). */
export interface AlmacenContadores {
  /** Suma uno al contador de `clave` en la ventana actual de `ventanaSeg` segundos y devuelve el conteo ya sumado. */
  incrementar(clave: string, ventanaSeg: number): Promise<number>;
}

export interface ConfigLimites {
  sesionPorHora: number;
  ipPorHora: number;
  /** Mensajes por conversación, del visitante y de la persona del negocio juntos: así el historial tiene tope. */
  mensajesPorConversacion: number;
  /** Conversaciones nuevas al día, entre todos los visitantes. */
  conversacionesPorDia: number;
  /** Mensajes al día que llegan al modelo, entre todos los visitantes: el tope del gasto diario de la API. */
  mensajesBotPorDia: number;
  /** Sesiones nuevas por IP y por hora: cada una crea una fila y siembra citas en la base. */
  sesionesNuevasIpPorHora: number;
  /** Sal del hash de la IP: los contadores nunca guardan la IP en claro. */
  salIp: string;
}

/**
 * Lo que identifica a un cliente en los contadores. Una IPv6 se agrupa por su prefijo /64, que suele ser de una
 * sola conexión: si no, quien tiene un /64 estrena dirección en cada petición y nunca llega a un límite.
 * Una IPv4 (también escrita como ::ffff:a.b.c.d) o cualquier otro texto queda tal cual.
 */
function clienteDe(ip: string): string {
  const mapeada = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapeada) return mapeada[1];
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [cabeza, cola] = ip.split("%")[0].split("::");
  const grupos = (parte = "") => (parte ? parte.split(":") : []);
  const ceros = Array(Math.max(0, 8 - grupos(cabeza).length - grupos(cola).length)).fill("0");
  const completa = cola === undefined ? grupos(cabeza) : [...grupos(cabeza), ...ceros, ...grupos(cola)];
  return `${completa.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** SHA-256 de sal + IP, en hexadecimal. La IP es dato personal; con sal secreta, el hash no se revierte probando todas las IPv4. */
export function hashIp(ip: string, sal: string): string {
  return createHash("sha256").update(sal + clienteDe(ip)).digest("hex");
}

export type Verificacion =
  | { permitido: true }
  | { permitido: false; motivo: "sesion" | "ip" | "diario" | "mensajes-dia" | "conversacion" };

/**
 * `||` y no `??`: una variable vacía, como las de `.env.example`, toma el valor por defecto.
 * Se llama al armar las dependencias: en producción sin `AGENDA_SAL_IP`, la app no arranca.
 */
export function limitesDesdeEntorno(env: Record<string, string | undefined> = process.env): ConfigLimites {
  const leer = (nombre: string, porDefecto: number) => {
    const valor = Number(env[nombre] || porDefecto);
    if (!Number.isInteger(valor) || valor < 1) throw new Error(`${nombre} debe ser un entero positivo`);
    return valor;
  };
  if (!env.AGENDA_SAL_IP && env.NODE_ENV === "production") {
    throw new Error("Falta AGENDA_SAL_IP: en producción la IP se guarda como hash con una sal secreta (ver .env.example)");
  }
  return {
    sesionPorHora: leer("AGENDA_LIMITE_SESION_HORA", 20),
    ipPorHora: leer("AGENDA_LIMITE_IP_HORA", 40),
    mensajesPorConversacion: leer("AGENDA_MAX_MENSAJES_CONVERSACION", 30),
    conversacionesPorDia: leer("AGENDA_TOPE_DIARIO", 100),
    mensajesBotPorDia: leer("AGENDA_TOPE_MENSAJES_DIA", 300),
    sesionesNuevasIpPorHora: leer("AGENDA_LIMITE_SESIONES_IP_HORA", 10),
    salIp: env.AGENDA_SAL_IP || SAL_SOLO_DESARROLLO,
  };
}

export function crearLimitador(almacen: AlmacenContadores, config: ConfigLimites) {
  return {
    /**
     * Cada mensaje del visitante o de la persona del negocio pasa por aquí antes de guardarse o de llamar a Claude.
     * El tope por conversación no gasta contadores, y cada contador solo se toca si pasaron los anteriores:
     * así un visitante rechazado por sesión o IP no se acaba los topes diarios de todos.
     */
    async verificar({
      ip,
      sesionId,
      esNuevaConversacion,
      mensajesConversacion,
      llamaAlBot,
    }: {
      ip: string;
      sesionId: string;
      esNuevaConversacion: boolean;
      /** Mensajes del visitante y de la persona del negocio que ya tiene la conversación. */
      mensajesConversacion: number;
      /** Si al pasar se llamará al modelo: solo entonces cuenta para el tope diario de mensajes al modelo. */
      llamaAlBot: boolean;
    }): Promise<Verificacion> {
      if (mensajesConversacion >= config.mensajesPorConversacion) return { permitido: false, motivo: "conversacion" };
      if ((await almacen.incrementar(`sesion:${sesionId}`, HORA_SEG)) > config.sesionPorHora) {
        return { permitido: false, motivo: "sesion" };
      }
      if ((await almacen.incrementar(`ip:${hashIp(ip, config.salIp)}`, HORA_SEG)) > config.ipPorHora) {
        return { permitido: false, motivo: "ip" };
      }
      if (esNuevaConversacion && (await almacen.incrementar("conversaciones-nuevas", DIA_SEG)) > config.conversacionesPorDia) {
        return { permitido: false, motivo: "diario" };
      }
      if (llamaAlBot && (await almacen.incrementar("mensajes-dia", DIA_SEG)) > config.mensajesBotPorDia) {
        return { permitido: false, motivo: "mensajes-dia" };
      }
      return { permitido: true };
    },

    /** Antes de crear (y sembrar) una sesión nueva: cuenta las de la IP en la hora; false si pasa del tope. */
    async sesionNueva(ip: string): Promise<boolean> {
      return (await almacen.incrementar(`sesion-nueva:${hashIp(ip, config.salIp)}`, HORA_SEG)) <= config.sesionesNuevasIpPorHora;
    },
  };
}

export type Limitador = ReturnType<typeof crearLimitador>;

/** Para pruebas y desarrollo. Las ventanas van alineadas al reloj (horas y días UTC) y cada clave guarda solo la actual. */
export function almacenMemoria(): AlmacenContadores {
  const contadores = new Map<string, { ventana: number; conteo: number }>();
  return {
    async incrementar(clave, ventanaSeg) {
      const ventana = Math.floor(Date.now() / (ventanaSeg * 1000));
      const actual = contadores.get(clave);
      const conteo = actual?.ventana === ventana ? actual.conteo + 1 : 1;
      contadores.set(clave, { ventana, conteo });
      return conteo;
    },
  };
}
