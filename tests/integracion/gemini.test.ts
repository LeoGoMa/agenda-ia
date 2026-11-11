import { describe, expect, it, vi } from "vitest";
import { partesLocales } from "@/src/dominio/tiempo";
import { manejarMensaje } from "@/src/servicio/chat";
import { armarDeps } from "@/src/servicio/deps";

/**
 * Prueba de humo con Gemini real: una conversación corta con la barbería, de la pregunta a la cita, con la base en
 * memoria y el reloj de verdad. Sin GEMINI_API_KEY se salta. Gasta unas 10 consultas de la cuota gratis del día y lo
 * que contesta el modelo varía, así que solo revisa lo que no debe variar: que cada turno conteste con texto propio
 * (no con un texto de respaldo) y que al final quede la cita de corte y barba, en la tarde, a nombre del visitante.
 */
const llave = process.env.GEMINI_API_KEY;

if (!llave) {
  const aviso = "Humo con Gemini saltado: falta GEMINI_API_KEY.";
  console.warn(aviso); // el reporte por defecto no muestra el nombre de lo saltado
  describe.skip(aviso, () => {
    it("agenda una cita en la barbería con Gemini real", () => {});
  });
} else {
  // Cada mensaje hace de 2 a 4 llamadas al modelo.
  vi.setConfig({ testTimeout: 180_000 });

  describe("Gemini real", () => {
    it("agenda una cita en la barbería con Gemini real", async () => {
      const deps = armarDeps({ NODE_ENV: "test", GEMINI_API_KEY: llave, GEMINI_MODEL: process.env.GEMINI_MODEL });
      const sesionId = crypto.randomUUID();
      const ip = "203.0.113.7"; // rango reservado para documentación
      await deps.asegurarSesion(sesionId, ip);
      const TELEFONO = "5500000099"; // formato reservado de la demo
      const deJuan = async () =>
        (await deps.repo.citas.listar(sesionId, "barberia", "2026-01-01T00:00:00.000Z", "2028-01-01T00:00:00.000Z")).filter(
          (c) => c.cliente.telefono.replace(/\D/g, "").endsWith(TELEFONO) && c.estado === "confirmada",
        );
      const respaldo = /no alcancé a terminar|no puedo ayudarte|demasiadas consultas/i;

      const turnos = [
        "¿Tienes lugar mañana en la tarde para corte y barba?",
        "El primero que tengas en la tarde. Soy Juan Demo y mi teléfono es 55 0000 0099.",
        "Sí, confírmala por favor.",
      ];
      for (const texto of turnos) {
        if ((await deJuan()).length > 0) break;
        const r = await manejarMensaje(deps, { sesionId, ip, negocioId: "barberia", texto });
        console.info(`Visitante: ${texto}\nBot: ${r.respuesta}\n`);
        expect(r.estado).toBe(200);
        expect(r.respuesta).not.toMatch(respaldo);
      }

      const [cita, ...otras] = await deJuan();
      expect(otras).toEqual([]);
      expect(cita).toMatchObject({ servicioId: "corte-barba", estado: "confirmada" });
      expect(partesLocales(new Date(cita.inicio), "America/Mexico_City").hora >= "12:00").toBe(true);
    });
  });
}
