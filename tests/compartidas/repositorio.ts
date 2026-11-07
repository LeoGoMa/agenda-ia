import { describe, expect, it } from "vitest";
import { agendar, buscarPorTelefono, cancelar, reprogramar } from "@/src/dominio/citas";
import { obtenerPerfil } from "@/src/dominio/perfiles";
import { ErrorDominio, type Cita } from "@/src/dominio/tipos";
import type { MensajeVisible, Repositorio } from "@/src/repo/tipos";

const ahora = new Date("2026-11-09T15:00:00Z"); // lunes 9:00 en CDMX
const despues = (horas: number) => new Date(ahora.getTime() + horas * 3_600_000);
const dental = obtenerPerfil("dental"); // capacidad 1, limpieza de 60 min, cancelar con 24 h
const barberia = obtenerPerfil("barberia");

// Martes 2026-11-10 y jueves 2026-11-12 en CDMX (UTC-6).
const MARTES_9 = "2026-11-10T15:00:00.000Z";
const MARTES_930 = "2026-11-10T15:30:00.000Z";
const MARTES_10 = "2026-11-10T16:00:00.000Z";
const MARTES_1030 = "2026-11-10T16:30:00.000Z";
const MARTES_11 = "2026-11-10T17:00:00.000Z";
const MARTES_12 = "2026-11-10T18:00:00.000Z";
const JUEVES_9 = "2026-11-12T15:00:00.000Z";
const JUEVES_11 = "2026-11-12T17:00:00.000Z";

const codigoDe = async (promesa: Promise<unknown>) => {
  try {
    await promesa;
  } catch (e) {
    return e instanceof ErrorDominio ? e.codigo : e;
  }
  return "no lanzó";
};

/**
 * Pruebas que todo repositorio debe pasar: memoria (tarea 3) y Supabase (tarea 6).
 * Cada prueba usa sesiones nuevas para que también corran contra una base compartida.
 */
export function pruebasDeRepositorio(nombre: string, crearRepo: () => Repositorio) {
  const preparar = () => {
    const repo = crearRepo();
    const sesionId = crypto.randomUUID();
    const agendarDental = (inicio: string, cliente = { nombre: "Cliente Demo", telefono: "55 0000 0001" }) =>
      agendar(repo.citas, { perfil: dental, sesionId, servicioId: "limpieza", inicio, cliente, ahora });
    const reprogramarDental = (citaId: string, nuevoInicio: string, momento = ahora) =>
      reprogramar(repo.citas, { perfil: dental, sesionId, citaId, nuevoInicio, ahora: momento });
    const cancelarDental = (citaId: string, momento = ahora) =>
      cancelar(repo.citas, { perfil: dental, sesionId, citaId, ahora: momento });
    const todas = (sesion = sesionId, negocioId = dental.id) =>
      repo.citas.listar(sesion, negocioId, "2026-11-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
    const nueva = (inicio: string, fin: string, cambios: Partial<Cita> = {}): Cita => ({
      id: crypto.randomUUID(),
      sesionId,
      negocioId: dental.id,
      servicioId: "limpieza",
      cliente: { nombre: "Cliente Demo", telefono: "5500000001" },
      inicio,
      fin,
      estado: "confirmada",
      creadaEn: ahora.toISOString(),
      ...cambios,
    });
    return { repo, sesionId, agendarDental, reprogramarDental, cancelarDental, todas, nueva };
  };

  describe(`citas con repositorio ${nombre}`, () => {
    it("agendar guarda y devuelve la cita con fin = inicio + duración", async () => {
      const { repo, sesionId } = preparar();
      const cita = await agendar(repo.citas, {
        perfil: dental,
        sesionId,
        servicioId: "limpieza",
        inicio: "2026-11-10T09:00:00-06:00",
        cliente: { nombre: "  Cliente Demo ", telefono: "55 0000 0001" },
        ahora,
      });
      expect(cita).toEqual({
        id: expect.any(String),
        sesionId,
        negocioId: "dental",
        servicioId: "limpieza",
        cliente: { nombre: "Cliente Demo", telefono: "5500000001" },
        inicio: MARTES_9,
        fin: MARTES_10,
        estado: "confirmada",
        creadaEn: expect.any(String),
      });
      expect(await repo.citas.obtener(sesionId, cita.id)).toEqual(cita);
    });

    it("agendar fuera de horario lanza HORARIO_NO_DISPONIBLE y no guarda", async () => {
      const { agendarDental, todas } = preparar();
      // 14:00 es la comida, 3:00 está cerrado y el domingo no abre.
      for (const inicio of ["2026-11-10T20:00:00.000Z", "2026-11-10T09:00:00.000Z", "2026-11-15T16:00:00.000Z"]) {
        expect(await codigoDe(agendarDental(inicio)), inicio).toBe("HORARIO_NO_DISPONIBLE");
      }
      expect(await todas()).toEqual([]);
    });

    it("agendar en paralelo el mismo horario: solo uno gana", async () => {
      const { agendarDental, todas } = preparar();
      const resultados = await Promise.allSettled([agendarDental(MARTES_9), agendarDental(MARTES_9)]);
      expect(resultados.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rechazados = resultados.filter((r) => r.status === "rejected");
      expect(rechazados).toHaveLength(1);
      expect(rechazados[0].reason).toMatchObject({ codigo: "HORARIO_NO_DISPONIBLE" });
      expect(await todas()).toHaveLength(1);
    });

    it("teléfono inválido lanza DATOS_INVALIDOS", async () => {
      const { agendarDental, todas } = preparar();
      for (const telefono of ["55 0000 001", "55 0000 00011", "sin número", ""]) {
        expect(await codigoDe(agendarDental(MARTES_9, { nombre: "Cliente Demo", telefono })), telefono).toBe(
          "DATOS_INVALIDOS",
        );
      }
      expect(await todas()).toEqual([]);
    });

    it("nombre de menos de 2 o más de 60 caracteres lanza DATOS_INVALIDOS", async () => {
      const { agendarDental, todas } = preparar();
      for (const nombre of ["A", "   A   ", "a".repeat(61)]) {
        expect(await codigoDe(agendarDental(MARTES_9, { nombre, telefono: "55 0000 0001" })), nombre).toBe(
          "DATOS_INVALIDOS",
        );
      }
      expect(await todas()).toEqual([]);
      await agendarDental(MARTES_9, { nombre: "Al", telefono: "55 0000 0001" });
      await agendarDental(MARTES_11, { nombre: "a".repeat(60), telefono: "55 0000 0001" });
      expect(await todas()).toHaveLength(2);
    });

    it("reprogramar mueve la cita y libera el horario anterior", async () => {
      const { agendarDental, reprogramarDental, todas } = preparar();
      const original = await agendarDental(MARTES_9);
      const movida = await reprogramarDental(original.id, MARTES_11);
      expect(movida).toEqual({ ...original, inicio: MARTES_11, fin: MARTES_12 });
      expect(await codigoDe(agendarDental(MARTES_11))).toBe("HORARIO_NO_DISPONIBLE");
      await agendarDental(MARTES_9); // el horario anterior quedó libre
      expect((await todas()).map((c) => c.inicio)).toEqual([MARTES_9, MARTES_11]);
    });

    it("reprogramar no choca consigo misma, pero sí con otras citas", async () => {
      const { repo, sesionId, agendarDental, reprogramarDental } = preparar();
      const cita = await agendarDental(MARTES_9);
      // Con capacidad 1, moverla 30 min la encima con su propio horario anterior.
      expect(await reprogramarDental(cita.id, MARTES_930)).toMatchObject({ inicio: MARTES_930, fin: MARTES_1030 });

      await agendarDental(MARTES_11);
      expect(await codigoDe(reprogramarDental(cita.id, MARTES_1030))).toBe("HORARIO_NO_DISPONIBLE"); // pisa la de 11:00
      expect(await codigoDe(reprogramarDental(cita.id, "2026-11-10T20:00:00.000Z"))).toBe("HORARIO_NO_DISPONIBLE"); // comida
      expect((await repo.citas.obtener(sesionId, cita.id))?.inicio).toBe(MARTES_930);
    });

    it("cancelar dentro de cancelacionMinHoras lanza FUERA_DE_POLITICA", async () => {
      const { repo, sesionId, agendarDental, reprogramarDental, cancelarDental } = preparar();
      const cita = await agendarDental(MARTES_10); // 25 h después de ahora

      // Faltan 23 h y la política pide 24, para cancelar y para cambiar.
      expect(await codigoDe(cancelarDental(cita.id, despues(2)))).toBe("FUERA_DE_POLITICA");
      expect(await codigoDe(reprogramarDental(cita.id, JUEVES_9, despues(2)))).toBe("FUERA_DE_POLITICA");
      expect(await repo.citas.obtener(sesionId, cita.id)).toEqual(cita);

      // Con 24 h exactas sí se puede, y una cita cancelada ya no se toca.
      expect(await cancelarDental(cita.id, despues(1))).toEqual({ ...cita, estado: "cancelada" });
      expect(await codigoDe(cancelarDental(cita.id))).toBe("CITA_NO_ENCONTRADA");
      expect(await codigoDe(reprogramarDental(cita.id, JUEVES_9))).toBe("CITA_NO_ENCONTRADA");
    });

    it("buscarPorTelefono no devuelve canceladas ni pasadas", async () => {
      const { repo, sesionId, agendarDental, cancelarDental } = preparar();
      await agendarDental(MARTES_9); // ya pasó cuando se busca
      const cancelada = await agendarDental(MARTES_11);
      await cancelarDental(cancelada.id);
      const futura = await agendarDental(JUEVES_9);
      await agendarDental(JUEVES_11, { nombre: "Otro Cliente", telefono: "55 0000 0002" });

      const buscar = (telefono: string) =>
        buscarPorTelefono(repo.citas, { sesionId, negocioId: dental.id, telefono, ahora: despues(25) }); // martes 10:00
      expect((await buscar("55-0000-0001")).map((c) => c.id)).toEqual([futura.id]);
      expect(await codigoDe(buscar("123"))).toBe("DATOS_INVALIDOS");
    });

    it("listar con otra sesión no devuelve nada", async () => {
      const { repo, sesionId, agendarDental, cancelarDental, todas } = preparar();
      const cita = await agendarDental(MARTES_9);
      const otra = crypto.randomUUID();

      expect(await todas(otra)).toEqual([]);
      expect(await todas(sesionId, barberia.id)).toEqual([]);
      expect(await repo.citas.obtener(otra, cita.id)).toBeNull();
      expect(await buscarPorTelefono(repo.citas, { sesionId: otra, negocioId: dental.id, telefono: "55 0000 0001", ahora })).toEqual([]);
      expect(await codigoDe(cancelar(repo.citas, { perfil: dental, sesionId: otra, citaId: cita.id, ahora }))).toBe(
        "CITA_NO_ENCONTRADA",
      );
      expect(await codigoDe(repo.citas.actualizar(otra, cita.id, { estado: "cancelada" }, 1))).toBe("CITA_NO_ENCONTRADA");
      expect(await codigoDe(cancelarDental(crypto.randomUUID()))).toBe("CITA_NO_ENCONTRADA");
      // El bot de otro negocio tampoco la toca, aunque sea la misma sesión.
      expect(await codigoDe(cancelar(repo.citas, { perfil: barberia, sesionId, citaId: cita.id, ahora }))).toBe(
        "CITA_NO_ENCONTRADA",
      );
      expect(await todas()).toEqual([cita]);
    });
  });

  describe(`regla de choque del repositorio ${nombre}`, () => {
    it("intervalos semiabiertos; solo cuentan confirmadas de la misma sesión y negocio", async () => {
      const { repo, sesionId, nueva } = preparar();
      const crear = (cita: Cita, capacidad = 1) => repo.citas.crearSiCabe(cita, capacidad);

      const base = await crear(nueva(MARTES_10, MARTES_11));
      await crear(nueva(MARTES_11, MARTES_12)); // empieza justo cuando termina la base
      await crear(nueva(MARTES_9, MARTES_10)); // termina justo cuando empieza la base
      const enMedio = nueva(MARTES_1030, "2026-11-10T17:30:00.000Z"); // pisa la base y la de 11:00
      expect(await codigoDe(crear(enMedio, 2))).toBe("HORARIO_NO_DISPONIBLE");
      await crear(enMedio, 3);

      await repo.citas.actualizar(sesionId, base.id, { estado: "cancelada" }, 1);
      await crear(nueva(MARTES_10, MARTES_1030)); // solo pisa la base, que ya está cancelada
      await crear(nueva(MARTES_10, MARTES_11, { sesionId: crypto.randomUUID() }));
      await crear(nueva(MARTES_10, MARTES_11, { negocioId: barberia.id, servicioId: "corte" }));
    });

    it("guarda y devuelve inicio y fin en UTC con Z", async () => {
      const { repo, sesionId, nueva } = preparar();
      const creada = await repo.citas.crearSiCabe(nueva("2026-11-10T09:00:00-06:00", "2026-11-10T10:00:00-06:00"), 1);
      expect([creada.inicio, creada.fin]).toEqual([MARTES_9, MARTES_10]);

      const cambios = { inicio: "2026-11-10T11:00:00-06:00", fin: "2026-11-10T12:00:00-06:00" };
      const movida = await repo.citas.actualizar(sesionId, creada.id, cambios, 1);
      expect([movida.inicio, movida.fin]).toEqual([MARTES_11, MARTES_12]);
      expect(await repo.citas.obtener(sesionId, creada.id)).toEqual(movida);
    });
  });

  describe(`conversaciones con repositorio ${nombre}`, () => {
    it("una conversación por sesión y negocio; otra sesión no la ve ni la cambia", async () => {
      const { repo, sesionId } = preparar();
      const conversacion = await repo.conversaciones.obtenerOCrear(sesionId, dental.id);
      expect(conversacion).toEqual({
        id: expect.any(String),
        sesionId,
        negocioId: dental.id,
        modo: "bot",
        mensajes: [],
        historialApi: [],
        mensajesVisitante: 0,
      });
      expect((await repo.conversaciones.obtenerOCrear(sesionId, dental.id)).id).toBe(conversacion.id);
      expect((await repo.conversaciones.obtenerOCrear(sesionId, barberia.id)).id).not.toBe(conversacion.id);

      const otra = crypto.randomUUID();
      expect(await repo.conversaciones.listar(otra, dental.id)).toEqual([]);
      expect(await codigoDe(repo.conversaciones.cambiarModo(otra, conversacion.id, "humano"))).toBe("DATOS_INVALIDOS");
      await repo.conversaciones.cambiarModo(sesionId, conversacion.id, "humano");
      expect((await repo.conversaciones.listar(sesionId, dental.id)).map((c) => [c.id, c.modo])).toEqual([
        [conversacion.id, "humano"],
      ]);
    });

    it("guarda mensajes, cuenta los del visitante y reemplaza el historial de la API", async () => {
      const { repo, sesionId } = preparar();
      const { id } = await repo.conversaciones.obtenerOCrear(sesionId, dental.id);
      const mensaje = (rol: MensajeVisible["rol"], texto: string) => ({ rol, texto, creadoEn: ahora.toISOString() });
      await repo.conversaciones.agregarMensaje(id, mensaje("cliente", "Hola"));
      await repo.conversaciones.agregarMensaje(id, mensaje("bot", "¿En qué le ayudo?"));
      await repo.conversaciones.agregarMensaje(id, mensaje("cliente", "Quiero una limpieza"));
      await repo.conversaciones.guardarHistorialApi(id, [{ role: "user", content: "viejo" }]);
      await repo.conversaciones.guardarHistorialApi(id, [{ role: "user", content: "Hola" }]);

      const guardada = await repo.conversaciones.obtenerOCrear(sesionId, dental.id);
      expect(guardada.mensajes.map((m) => [m.rol, m.texto])).toEqual([
        ["cliente", "Hola"],
        ["bot", "¿En qué le ayudo?"],
        ["cliente", "Quiero una limpieza"],
      ]);
      expect(guardada.mensajesVisitante).toBe(2);
      expect(guardada.historialApi).toEqual([{ role: "user", content: "Hola" }]);
      expect(await codigoDe(repo.conversaciones.agregarMensaje(crypto.randomUUID(), mensaje("cliente", "x")))).toBe(
        "DATOS_INVALIDOS",
      );
    });
  });
}
