import { z } from "zod";
import barberia from "../datos/negocios/barberia.json";
import dental from "../datos/negocios/dental.json";
import taller from "../datos/negocios/taller.json";
import { ErrorDominio, type PerfilNegocio } from "./tipos";

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora en formato HH:MM");
const id = z.string().regex(/^[a-z0-9-]+$/, "Id en minúsculas, números y guiones");
const texto = z.string().trim().min(1);
const enteroPositivo = z.int().positive();
const sinRepetir = (valores: unknown[]) => new Set(valores).size === valores.length;

const zonaValida = (zona: string) => {
  try {
    new Intl.DateTimeFormat("es-MX", { timeZone: zona });
    return true;
  } catch {
    return false;
  }
};

const esquemaHorarioDia = z
  .object({
    dia: z.literal([0, 1, 2, 3, 4, 5, 6]),
    abre: hora,
    cierra: hora,
    descansos: z.array(z.object({ inicio: hora, fin: hora })),
  })
  .refine(
    // "HH:MM" con dos dígitos se ordena bien como texto.
    (h) =>
      h.abre < h.cierra &&
      h.descansos.every((d) => h.abre <= d.inicio && d.inicio < d.fin && d.fin <= h.cierra),
    "El horario debe abrir antes de cerrar y cada descanso debe quedar dentro",
  );

export const esquemaPerfil: z.ZodType<PerfilNegocio> = z.object({
  id,
  nombre: texto,
  giro: texto,
  zonaHoraria: z.string().refine(zonaValida, "Zona horaria IANA inválida").default("America/Mexico_City"),
  tono: texto,
  horario: z
    .array(esquemaHorarioDia)
    .refine((dias) => sinRepetir(dias.map((h) => h.dia)), "Día repetido en el horario"),
  servicios: z
    .array(
      z.object({
        id,
        nombre: texto,
        duracionMin: enteroPositivo,
        precioMxn: z.number().nonnegative(),
        descripcion: texto,
      }),
    )
    .min(1)
    .refine((servicios) => sinRepetir(servicios.map((s) => s.id)), "Servicio con id repetido"),
  politicas: z.object({
    intervaloMin: enteroPositivo,
    anticipacionMinMin: z.int().nonnegative(),
    anticipacionMaxDias: enteroPositivo,
    cancelacionMinHoras: z.number().nonnegative(),
    capacidadPorHorario: enteroPositivo,
  }),
  preguntasFrecuentes: z.array(z.object({ pregunta: texto, respuesta: texto })),
});

// Se validan al cargar el módulo: un perfil mal escrito falla al arrancar, no a media conversación.
export const PERFILES: PerfilNegocio[] = [dental, barberia, taller].map((perfil) => esquemaPerfil.parse(perfil));

export function obtenerPerfil(id: string): PerfilNegocio {
  const perfil = PERFILES.find((p) => p.id === id);
  if (!perfil) throw new ErrorDominio("DATOS_INVALIDOS", `No existe el negocio «${id}»`);
  return perfil;
}
