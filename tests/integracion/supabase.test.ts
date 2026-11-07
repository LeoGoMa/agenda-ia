import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";
import { obtenerPerfil } from "@/src/dominio/perfiles";
import { ErrorDominio } from "@/src/dominio/tipos";
import { crearRepoSupabase } from "@/src/repo/supabase";
import type { Repositorio } from "@/src/repo/tipos";
import { almacenSupabase } from "@/src/servicio/almacenSupabase";
import { armarDeps } from "@/src/servicio/deps";
import { pruebasDeRepositorio } from "../compartidas/repositorio";

/**
 * Corre contra un proyecto de Supabase de prueba con la migración de supabase/migrations aplicada.
 * Sin las dos variables se salta: hoy no hay credenciales en el repo ni en la máquina de desarrollo.
 */
const url = process.env.SUPABASE_URL;
const llave = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !llave) {
  const aviso = "Integración con Supabase saltada: faltan SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de un proyecto de prueba.";
  console.warn(aviso); // el reporte por defecto no muestra el nombre de lo saltado
  describe.skip(aviso, () => {
    it("pruebas de repositorio, contadores y limpieza contra Postgres", () => {});
  });
} else {
  // Cada prueba hace varias idas y vueltas por red a Supabase; los 5 s por defecto no alcanzan.
  vi.setConfig({ testTimeout: 30_000 });
  const cliente = createClient(url, llave, { auth: { persistSession: false } });
  const sesionesCreadas = new Set<string>();
  const crearSesion = async (id: string, creada?: string) => {
    sesionesCreadas.add(id);
    const { error } = await cliente.from("sesiones").upsert({ id, creada }, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw new Error(`No se pudo crear la sesión de prueba: ${error.message}`);
  };

  /** La suite compartida no crea sesiones: aquí se crea su fila antes de lo que la referencia (llave foránea). */
  const conSesion = (repo: Repositorio): Repositorio => ({
    citas: {
      ...repo.citas,
      async crearSiCabe(cita, capacidad) {
        await crearSesion(cita.sesionId);
        return repo.citas.crearSiCabe(cita, capacidad);
      },
    },
    conversaciones: {
      ...repo.conversaciones,
      async obtenerOCrear(sesionId, negocioId) {
        await crearSesion(sesionId);
        return repo.conversaciones.obtenerOCrear(sesionId, negocioId);
      },
    },
  });

  afterAll(async () => {
    // Borrar la sesión borra en cascada sus citas, conversaciones y mensajes.
    const { error } = await cliente.from("sesiones").delete().in("id", [...sesionesCreadas]);
    if (error) throw new Error(`No se pudieron borrar las sesiones de prueba: ${error.message}`);
  });

  pruebasDeRepositorio("Supabase", () => conSesion(crearRepoSupabase(cliente)));

  describe("solo de Supabase", () => {
    const codigoDe = (promesa: Promise<unknown>) =>
      promesa.then(
        () => "no lanzó",
        (e) => (e instanceof ErrorDominio ? e.codigo : e),
      );

    it("un id que no es uuid se trata como inexistente, igual que en memoria", async () => {
      const repo = conSesion(crearRepoSupabase(cliente));
      const sesionId = crypto.randomUUID();
      await repo.conversaciones.obtenerOCrear(sesionId, "dental");
      // El modelo o el cuerpo de una petición pueden traer cualquier texto como id.
      expect(await repo.citas.obtener(sesionId, "cita-1")).toBeNull();
      expect(await repo.citas.obtener("no-es-uuid", crypto.randomUUID())).toBeNull();
      expect(await repo.citas.listar("no-es-uuid", "dental", "2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toEqual([]);
      expect(await codigoDe(repo.citas.actualizar(sesionId, "cita-1", { estado: "cancelada" }, 1))).toBe("CITA_NO_ENCONTRADA");
      expect(await codigoDe(repo.conversaciones.obtener(sesionId, "conv-1"))).toBe("DATOS_INVALIDOS");
      expect(await codigoDe(repo.conversaciones.cambiarModo(sesionId, "conv-1", "humano"))).toBe("DATOS_INVALIDOS");
      expect(await codigoDe(repo.conversaciones.guardarHistorialApi("conv-1", [], null))).toBe("DATOS_INVALIDOS");
      expect(await codigoDe(repo.conversaciones.guardarHistorialApi(crypto.randomUUID(), [], null))).toBe("DATOS_INVALIDOS");
      expect(await repo.conversaciones.listar("no-es-uuid", "dental")).toEqual([]);
    });

    it("el historial de la API vuelve con las llaves en el mismo orden (el caché de prompts depende de eso)", async () => {
      const repo = conSesion(crearRepoSupabase(cliente));
      const sesionId = crypto.randomUUID();
      const { id } = await repo.conversaciones.obtenerOCrear(sesionId, "dental");
      // Orden que jsonb cambiaría (ordena las llaves por largo): servicioId iría al final.
      const input = { servicioId: "limpieza", inicio: "2026-11-10T15:00:00.000Z", nombre: "Cliente Demo", telefono: "5500000001" };
      const historial = [
        { role: "user", content: "Agéndeme el martes" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "agendar_cita", input }] },
      ];
      await repo.conversaciones.guardarHistorialApi(id, historial, "v1");
      const guardada = await repo.conversaciones.obtener(sesionId, id);
      expect(JSON.stringify(guardada.historialApi)).toBe(JSON.stringify(historial));
    });

    it("asegurarSesion crea la sesión y siembra sus citas ficticias solo la primera vez", async () => {
      const deps = armarDeps({ NODE_ENV: "test", SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: llave });
      const sesionId = crypto.randomUUID();
      sesionesCreadas.add(sesionId);
      const listar = () => deps.repo.citas.listar(sesionId, "dental", "2000-01-01T00:00:00.000Z", "9999-12-31T00:00:00.000Z");
      // IP de documentación en un /64 al azar (el limitador agrupa las IPv6 por /64): el contador de sesiones
      // nuevas de la base no se acumula entre corridas.
      const ip = `2001:db8:${crypto.randomUUID().slice(0, 4)}::1`;
      expect(await deps.asegurarSesion(sesionId, ip)).toBe(true);
      const primera = await listar();
      expect(primera.length).toBeGreaterThanOrEqual(3);
      expect(await deps.asegurarSesion(sesionId, ip)).toBe(true);
      expect(await listar()).toEqual(primera);
    });

    it("incrementar_contador suma en la ventana actual de forma atómica", async () => {
      const almacen = almacenSupabase(cliente);
      const clave = `prueba:${crypto.randomUUID()}`;
      try {
        const conteos = await Promise.all(Array.from({ length: 10 }, () => almacen.incrementar(clave, 3600)));
        expect(conteos.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(await almacen.incrementar(`${clave}:otra`, 3600)).toBe(1);
      } finally {
        await cliente.from("contadores").delete().like("clave", `${clave}%`);
      }
    });

    it("limpiar_sesiones_viejas borra las sesiones de más de 7 días con todo lo suyo", async () => {
      const repo = crearRepoSupabase(cliente);
      const vieja = crypto.randomUUID();
      const nueva = crypto.randomUUID();
      await crearSesion(vieja, new Date(Date.now() - 8 * 24 * 3_600_000).toISOString());
      await crearSesion(nueva);
      const dental = obtenerPerfil("dental");
      const deVieja = await repo.conversaciones.obtenerOCrear(vieja, dental.id);
      await repo.conversaciones.agregarMensaje(deVieja.id, { rol: "cliente", texto: "Hola", creadoEn: new Date().toISOString() });
      await repo.conversaciones.obtenerOCrear(nueva, dental.id);

      const { error } = await cliente.rpc("limpiar_sesiones_viejas");
      expect(error).toBeNull();
      expect(await repo.conversaciones.listar(vieja, dental.id)).toEqual([]);
      expect(await repo.conversaciones.listar(nueva, dental.id)).toHaveLength(1);
      const mensajes = await cliente.from("mensajes").select("id").eq("conversacion_id", deVieja.id);
      expect(mensajes.data).toEqual([]);
    });
  });
}
