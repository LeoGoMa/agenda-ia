"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Cita } from "../dominio/tipos";
import type { Conversacion } from "../repo/tipos";
import { Chat } from "./Chat";
import { textoDeAviso } from "./formato";
import { Panel } from "./Panel";

const INTERVALO_MS = 4000;
const SIN_CONEXION = "No hay conexión. Revisa tu internet e inténtalo de nuevo.";

/** Lo que la página manda del perfil: solo lo que se muestra. */
export interface PerfilVista {
  id: string;
  nombre: string;
  giro: string;
  zonaHoraria: string;
  servicios: { id: string; nombre: string }[];
}

/** Lo que devuelve GET /api/panel. */
export interface DatosPanel {
  citas: Pick<Cita, "id" | "servicioId" | "cliente" | "inicio" | "fin" | "estado">[];
  conversaciones: Pick<Conversacion, "id" | "modo" | "mensajes">[];
}

export interface Resultado {
  ok: boolean;
  estado: number;
  cuerpo: unknown;
  /** Para mostrar si algo salió mal: `respuesta` del servicio o `error` de la ruta. */
  texto: string;
}

/** GET sin cuerpo y POST con JSON. Nunca lanza: sin red responde con estado 0. */
export async function pedir(url: string, cuerpo?: unknown): Promise<Resultado> {
  try {
    const r = await fetch(
      url,
      cuerpo === undefined
        ? { cache: "no-store" }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) },
    );
    const datos: unknown = await r.json().catch(() => null);
    return { ok: r.ok, estado: r.status, cuerpo: datos, texto: textoDeAviso(datos) };
  } catch {
    return { ok: false, estado: 0, cuerpo: null, texto: SIN_CONEXION };
  }
}

type Pestana = "chat" | "panel";
const PESTANAS: { id: Pestana; texto: string }[] = [
  { id: "chat", texto: "Chat" },
  { id: "panel", texto: "Panel" },
];

/** El chat y el panel del negocio comparten los datos: el panel se pide cada 4 s y tras cada acción. */
export function Demo({ perfil }: { perfil: PerfilVista }) {
  const [datos, setDatos] = useState<DatosPanel | null>(null);
  const [avisoCarga, setAvisoCarga] = useState<string | null>(null);
  const [pestana, setPestana] = useState<Pestana>("chat");
  const ultima = useRef(0);

  const refrescar = useCallback(async () => {
    // Solo cuenta la respuesta de la petición más reciente: una vieja no pisa datos más nuevos.
    const numero = ++ultima.current;
    const r = await pedir(`/api/panel?negocioId=${encodeURIComponent(perfil.id)}`);
    if (numero !== ultima.current) return;
    if (r.ok) {
      setDatos(r.cuerpo as DatosPanel);
      setAvisoCarga(null);
    } else {
      setAvisoCarga(r.texto);
    }
  }, [perfil.id]);

  useEffect(() => {
    const tic = () => {
      if (!document.hidden) void refrescar();
    };
    tic();
    const id = setInterval(tic, INTERVALO_MS);
    document.addEventListener("visibilitychange", tic);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tic);
    };
  }, [refrescar]);

  // Patrón de pestañas: las flechas cambian de pestaña y mueven el foco.
  const alTeclear = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const otra = pestana === "chat" ? "panel" : "chat";
    setPestana(otra);
    document.getElementById(`pestana-${otra}`)?.focus();
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-0 sm:px-4 lg:py-6">
      <div role="tablist" aria-label="Vista de la demo" onKeyDown={alTeclear} className="grid grid-cols-2 border-b border-borde bg-white lg:hidden">
        {PESTANAS.map(({ id, texto }) => (
          <button
            key={id}
            id={`pestana-${id}`}
            role="tab"
            type="button"
            aria-selected={pestana === id}
            aria-controls={`vista-${id}`}
            tabIndex={pestana === id ? 0 : -1}
            onClick={() => setPestana(id)}
            className={`min-h-11 border-b-2 text-sm font-semibold ${pestana === id ? "border-marca text-marca" : "border-transparent text-tenue"}`}
          >
            {texto}
          </button>
        ))}
      </div>

      <div className="flex-1 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-8">
        <div
          id="vista-chat"
          role="tabpanel"
          aria-labelledby="pestana-chat"
          className={`h-[calc(100dvh-8rem)] min-h-[28rem] lg:sticky lg:top-12 lg:h-[min(52rem,calc(100dvh-8rem))] ${pestana === "chat" ? "" : "max-lg:hidden"}`}
        >
          <Chat perfil={perfil} conversacion={datos?.conversaciones[0]} cargando={datos === null} alCambiar={refrescar} />
        </div>
        <div id="vista-panel" role="tabpanel" aria-labelledby="pestana-panel" className={`px-4 py-6 sm:px-0 lg:py-0 ${pestana === "panel" ? "" : "max-lg:hidden"}`}>
          <Panel perfil={perfil} datos={datos} avisoCarga={avisoCarga} alCambiar={refrescar} />
        </div>
      </div>
    </div>
  );
}
