const HORA_SEG = 60 * 60;
const DIA_SEG = 24 * HORA_SEG;

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
}

export type Verificacion = { permitido: true } | { permitido: false; motivo: "sesion" | "ip" | "diario" | "conversacion" };

/** `||` y no `??`: una variable vacía, como las de `.env.example`, toma el valor por defecto. */
export function limitesDesdeEntorno(env: Record<string, string | undefined> = process.env): ConfigLimites {
  const leer = (nombre: string, porDefecto: number) => {
    const valor = Number(env[nombre] || porDefecto);
    if (!Number.isInteger(valor) || valor < 1) throw new Error(`${nombre} debe ser un entero positivo`);
    return valor;
  };
  return {
    sesionPorHora: leer("AGENDA_LIMITE_SESION_HORA", 20),
    ipPorHora: leer("AGENDA_LIMITE_IP_HORA", 40),
    mensajesPorConversacion: leer("AGENDA_MAX_MENSAJES_CONVERSACION", 30),
    conversacionesPorDia: leer("AGENDA_TOPE_DIARIO", 300),
  };
}

export function crearLimitador(almacen: AlmacenContadores, config: ConfigLimites) {
  return {
    /**
     * Cada mensaje del visitante o de la persona del negocio pasa por aquí antes de guardarse o de llamar a Claude.
     * El tope por conversación no gasta contadores, y cada contador solo se toca si pasaron los anteriores:
     * así un visitante rechazado por sesión o IP no se acaba el tope diario de todos.
     */
    async verificar({
      ip,
      sesionId,
      esNuevaConversacion,
      mensajesConversacion,
    }: {
      ip: string;
      sesionId: string;
      esNuevaConversacion: boolean;
      /** Mensajes del visitante y de la persona del negocio que ya tiene la conversación. */
      mensajesConversacion: number;
    }): Promise<Verificacion> {
      if (mensajesConversacion >= config.mensajesPorConversacion) return { permitido: false, motivo: "conversacion" };
      if ((await almacen.incrementar(`sesion:${sesionId}`, HORA_SEG)) > config.sesionPorHora) {
        return { permitido: false, motivo: "sesion" };
      }
      if ((await almacen.incrementar(`ip:${ip}`, HORA_SEG)) > config.ipPorHora) return { permitido: false, motivo: "ip" };
      if (esNuevaConversacion && (await almacen.incrementar("conversaciones-nuevas", DIA_SEG)) > config.conversacionesPorDia) {
        return { permitido: false, motivo: "diario" };
      }
      return { permitido: true };
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
