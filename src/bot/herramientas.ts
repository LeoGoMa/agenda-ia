import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { agendar, buscarPorTelefono, cancelar, reprogramar } from "../dominio/citas";
import { horariosLibres } from "../dominio/disponibilidad";
import { NOMBRE_DIA, partesLocales } from "../dominio/tiempo";
import { ErrorDominio, type Cita, type PerfilNegocio } from "../dominio/tipos";
import type { Repositorio } from "../repo/tipos";

const DIA = 24 * 60 * 60_000;

export interface ContextoHerramientas {
  repo: Repositorio;
  perfil: PerfilNegocio;
  /** Sale de la cookie, nunca del modelo: acota todo lo que las herramientas leen o cambian. */
  sesionId: string;
  conversacionId: string;
  ahora: () => Date;
  alPasarAHumano: () => Promise<void>;
}

export interface Herramientas {
  definiciones: Anthropic.Beta.BetaTool[];
  /** Resultado en JSON; un error de dominio o de esquema va como `{ ok: false, codigo, mensaje }` con `esError`. */
  ejecutar(nombre: string, entrada: unknown): Promise<{ contenido: string; esError: boolean }>;
}

// Todas las entradas son texto, así un solo mapa da el esquema zod y el JSON Schema estricto.
type Campos = Record<string, z.ZodType<string>>;

function herramienta<C extends Campos>(
  name: string,
  description: string,
  campos: C,
  correr: (entrada: z.infer<z.ZodObject<C>>) => Promise<object>,
) {
  const esquema = z.object(campos);
  const validarYCorrer = (entrada: unknown) => {
    const validada = esquema.safeParse(entrada);
    if (!validada.success) {
      const problemas = validada.error.issues.map((i) => `${i.path.join(".") || "entrada"}: ${i.message}`);
      throw new ErrorDominio("DATOS_INVALIDOS", problemas.join("; "));
    }
    return correr(validada.data);
  };
  const definicion: Anthropic.Beta.BetaTool = {
    name,
    description,
    strict: true,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(campos).map(([campo, tipo]) => [campo, { type: "string", description: tipo.description }]),
      ),
      required: Object.keys(campos),
      additionalProperties: false,
    },
  };
  return { definicion, validarYCorrer };
}

const texto = (descripcion: string) => z.string().describe(descripcion);
const inicioIso = (descripcion: string) =>
  z.iso
    .datetime({
      offset: true,
      error: "Debe ser ISO 8601 con Z o desfase: copia tal cual un `inicio` que haya devuelto ver_disponibilidad",
    })
    .describe(descripcion);

export function crearHerramientas(ctx: ContextoHerramientas): Herramientas {
  const { repo, perfil, sesionId, ahora } = ctx;

  // La fecha y hora locales van ya calculadas: el modelo no tiene que convertir desde UTC.
  const vista = (cita: Cita) => {
    const { fecha, hora, dia } = partesLocales(new Date(cita.inicio), perfil.zonaHoraria);
    const servicio = perfil.servicios.find((s) => s.id === cita.servicioId)?.nombre ?? cita.servicioId;
    const { id, servicioId, inicio, cliente, estado } = cita;
    return { id, servicioId, servicio, inicio, fecha, dia: NOMBRE_DIA[dia], hora, cliente, estado };
  };

  const lista = [
    herramienta(
      "obtener_fecha_hora",
      "Fecha (AAAA-MM-DD), hora (HH:MM) y día de la semana actuales en la zona del negocio. Úsala antes de interpretar «hoy», «mañana» o un día de la semana.",
      {},
      async () => {
        const { fecha, hora, dia } = partesLocales(ahora(), perfil.zonaHoraria);
        return { fecha, hora, dia: NOMBRE_DIA[dia], zonaHoraria: perfil.zonaHoraria };
      },
    ),
    herramienta(
      "ver_servicios",
      "Servicios del negocio con su id, duración en minutos, precio en pesos y descripción.",
      {},
      async () => ({ servicios: perfil.servicios }),
    ),
    herramienta(
      "ver_disponibilidad",
      "Horarios libres de un servicio en una fecha local. Cada horario trae `inicio` (ISO 8601 en UTC, para agendar_cita o reprogramar_cita) y `etiqueta` (HH:MM en hora local, para mostrar al cliente).",
      {
        servicioId: texto("Id del servicio, por ejemplo el que da ver_servicios."),
        fecha: z.iso.date({ error: "La fecha debe ser AAAA-MM-DD y existir en el calendario" }).describe("Fecha local, AAAA-MM-DD."),
      },
      async ({ servicioId, fecha }) => {
        const momento = ahora();
        // Fuera de [hoy, hoy + anticipacionMaxDias] (días locales) nunca hay horarios: se rechaza sin ir al repositorio.
        const hoy = partesLocales(momento, perfil.zonaHoraria).fecha;
        const { anticipacionMaxDias } = perfil.politicas;
        const tope = new Date(Date.parse(`${hoy}T00:00:00Z`) + anticipacionMaxDias * DIA).toISOString().slice(0, 10);
        if (fecha < hoy || fecha > tope) {
          throw new ErrorDominio(
            "FUERA_DE_POLITICA",
            `Solo se puede consultar del ${hoy} al ${tope}: hoy y hasta ${anticipacionMaxDias} días adelante`,
          );
        }
        const dia = Date.parse(`${fecha}T00:00:00Z`);
        // Un día más por lado cubre cualquier desfase de zona y las citas que se enciman con el borde del día.
        const desde = new Date(dia - DIA).toISOString();
        const hasta = new Date(dia + 2 * DIA).toISOString();
        const citas = await repo.citas.listar(sesionId, perfil.id, desde, hasta);
        const horarios = horariosLibres({ perfil, servicioId, fecha, citas, ahora: momento });
        return { servicioId, fecha, dia: NOMBRE_DIA[new Date(dia).getUTCDay()], horarios };
      },
    ),
    herramienta(
      "agendar_cita",
      "Agenda una cita. Pide antes el nombre y el teléfono del cliente. La cita solo existe si la respuesta trae ok: true.",
      {
        servicioId: texto("Id del servicio."),
        inicio: inicioIso("Inicio copiado tal cual de un `inicio` de ver_disponibilidad (ISO 8601 con Z o desfase)."),
        nombre: texto("Nombre del cliente."),
        telefono: texto("Teléfono del cliente, 10 dígitos."),
      },
      async ({ servicioId, inicio, nombre, telefono }) => ({
        cita: vista(
          await agendar(repo.citas, { perfil, sesionId, servicioId, inicio, cliente: { nombre, telefono }, ahora: ahora() }),
        ),
      }),
    ),
    herramienta(
      "reprogramar_cita",
      "Cambia una cita a otro horario del mismo servicio. Solo cambia si la respuesta trae ok: true.",
      {
        citaId: texto("Id de la cita, como lo da buscar_mis_citas o agendar_cita."),
        nuevoInicio: inicioIso("Nuevo inicio copiado tal cual de un `inicio` de ver_disponibilidad (ISO 8601 con Z o desfase)."),
      },
      async ({ citaId, nuevoInicio }) => ({
        cita: vista(await reprogramar(repo.citas, { perfil, sesionId, citaId, nuevoInicio, ahora: ahora() })),
      }),
    ),
    herramienta(
      "cancelar_cita",
      "Cancela una cita. Solo se cancela si la respuesta trae ok: true.",
      { citaId: texto("Id de la cita, como lo da buscar_mis_citas o agendar_cita.") },
      async ({ citaId }) => ({ cita: vista(await cancelar(repo.citas, { perfil, sesionId, citaId, ahora: ahora() })) }),
    ),
    herramienta(
      "buscar_mis_citas",
      "Citas vigentes y futuras del cliente con ese teléfono.",
      { telefono: texto("Teléfono del cliente, 10 dígitos.") },
      async ({ telefono }) => ({
        citas: (await buscarPorTelefono(repo.citas, { sesionId, negocioId: perfil.id, telefono, ahora: ahora() })).map(vista),
      }),
    ),
    herramienta(
      "pasar_a_humano",
      "Pasa la conversación a una persona del negocio. Úsala si el cliente lo pide o si no puedes resolver lo que necesita.",
      { motivo: texto("Por qué pasa la conversación, en una frase.") },
      async () => {
        await ctx.alPasarAHumano();
        return { mensaje: "Una persona del negocio seguirá la conversación. Avísale al cliente." };
      },
    ),
  ];
  const porNombre = new Map(lista.map((h) => [h.definicion.name, h]));

  return {
    definiciones: lista.map((h) => h.definicion),

    async ejecutar(nombre, entrada) {
      try {
        const h = porNombre.get(nombre);
        if (!h) throw new ErrorDominio("DATOS_INVALIDOS", `No existe la herramienta «${nombre}»`);
        return { contenido: JSON.stringify({ ok: true, ...(await h.validarYCorrer(entrada)) }), esError: false };
      } catch (e) {
        // Solo los errores esperados vuelven al modelo; uno inesperado (la base caída) sube a quien llama.
        if (!(e instanceof ErrorDominio)) throw e;
        return { contenido: JSON.stringify({ ok: false, codigo: e.codigo, mensaje: e.message }), esError: true };
      }
    },
  };
}
