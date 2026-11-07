import type { DiaSemana } from "./tipos";

/** Fecha "YYYY-MM-DD", hora "HH:MM" y día de la semana de un instante, vistos en la zona IANA `zona`. */
export function partesLocales(d: Date, zona: string): { fecha: string; hora: string; dia: DiaSemana } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zona,
      hourCycle: "h23", // con hour12: false algunos motores escriben la medianoche como "24"
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(d)
      .map((parte) => [parte.type, parte.value]),
  );
  const fecha = `${p.year}-${p.month}-${p.day}`;
  return { fecha, hora: `${p.hour}:${p.minute}`, dia: new Date(`${fecha}T00:00:00Z`).getUTCDay() as DiaSemana };
}

/** Milisegundos que la zona va adelante de UTC en el instante `t`. */
function desfase(t: number, zona: string): number {
  const { fecha, hora } = partesLocales(new Date(t), zona);
  return Date.parse(`${fecha}T${hora}:00Z`) - t;
}

/** El instante en que el reloj de pared de `zona` marca `fecha` a la `hora`. */
export function aUtc(fecha: string, hora: string, zona: string): Date {
  const comoSiFueraUtc = Date.parse(`${fecha}T${hora}:00Z`);
  // Primero se mide el desfase cerca del resultado; la segunda vuelta lo corrige si entre ambos hay un cambio de horario.
  // shortcut: una hora que no existe por el salto de primavera (02:30 en Nueva York) cae en la anterior (01:30);
  // revisarlo si un negocio de una zona con horario de verano abre de madrugada.
  const aproximado = comoSiFueraUtc - desfase(comoSiFueraUtc, zona);
  return new Date(comoSiFueraUtc - desfase(aproximado, zona));
}
