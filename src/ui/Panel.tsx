"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import type { MensajeVisible } from "../repo/tipos";
import { pedir, type DatosPanel, type PerfilVista, type Resultado } from "./api";
import { EnlacesForge } from "./AvisoFicticio";
import { agruparPorDia, contarCitas, ETIQUETA_ESTADO, ETIQUETA_MODO, etiquetaHora, formatoTelefono, separarMarcaDemo } from "./formato";

type ConversacionVista = DatosPanel["conversaciones"][number];
const AUTOR: Record<MensajeVisible["rol"], string> = { cliente: "Cliente", bot: "Bot", humano: "Tú (persona)", sistema: "Aviso" };
const boton =
  "min-h-11 rounded-lg px-4 text-sm font-semibold shadow-sm disabled:opacity-60 disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:cursor-not-allowed";

/**
 * Texto del resultado de una acción del panel; el 429 trae además la salida a Forge Studio. La región está
 * siempre en el DOM, aun vacía: si aparece junto con su texto, el lector de pantalla puede no anunciarlo.
 */
function AvisoAccion({ resultado }: { resultado: Resultado | null }) {
  return (
    <div role="status" className="text-sm text-amber-900">
      {resultado && !resultado.ok ? (
        <p className="mt-2">
          {resultado.texto}
          {resultado.estado === 429 ? (
            <span className="mt-1 block">
              <EnlacesForge prefijo="Contacto:" />
            </span>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function TarjetaConversacion({ conversacion, zona, alCambiar }: { conversacion: ConversacionVista; zona: string; alCambiar: () => Promise<Resultado> }) {
  const [ocupado, setOcupado] = useState(false);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [texto, setTexto] = useState("");
  const campo = useRef<HTMLInputElement>(null);
  const idCampo = useId();
  const { id, modo, mensajes } = conversacion;
  const ultimo = mensajes.at(-1);
  const enHumano = modo === "humano";

  // Mientras hay una acción en curso los controles quedan con aria-disabled y no con disabled: un control
  // desactivado suelta el foco (se va a <body>) y quien usa teclado o lector de pantalla pierde su lugar.
  async function accion(hacer: () => Promise<Resultado>, alSalirBien?: () => void) {
    if (ocupado) return;
    setOcupado(true);
    setResultado(null);
    const r = await hacer();
    if (r.ok) alSalirBien?.();
    await alCambiar();
    setResultado(r);
    setOcupado(false);
  }

  const cambiarModo = () => accion(() => pedir("/api/panel/modo", { conversacionId: id, modo: enHumano ? "bot" : "humano" }));
  const responder = (e: FormEvent) => {
    e.preventDefault();
    const limpio = texto.trim();
    if (!limpio) return;
    void accion(
      () => pedir("/api/panel/mensaje", { conversacionId: id, texto: limpio }),
      () => {
        // Con el campo vacío, «Enviar» se desactiva: el foco vuelve al campo antes de que lo suelte.
        campo.current?.focus();
        setTexto("");
      },
    );
  };

  return (
    <article className="rounded-2xl border border-borde bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold">Visitante de la demo</h4>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${enHumano ? "bg-amber-100 text-amber-900" : "bg-teal-50 text-marca-fuerte"}`}
        >
          Modo: {ETIQUETA_MODO[modo]}
        </span>
      </div>
      {ultimo ? (
        <p className="mt-2 line-clamp-2 text-sm text-tenue [overflow-wrap:anywhere]" title={ultimo.texto}>
          <span className="font-medium text-tinta">{AUTOR[ultimo.rol]}:</span>{" "}
          <bdi>{ultimo.rol === "bot" ? separarMarcaDemo(ultimo.texto).texto : ultimo.texto}</bdi>{" "}
          <time dateTime={ultimo.creadoEn} className="tabular-nums">
            · {etiquetaHora(ultimo.creadoEn, zona)}
          </time>
        </p>
      ) : null}
      <p className="mt-1 text-xs text-tenue">
        {mensajes.length} {mensajes.length === 1 ? "mensaje" : "mensajes"}
      </p>

      {enHumano ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
          El bot no contesta mientras una persona atiende. Responde aquí o devuelve la conversación al bot.
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void cambiarModo()}
          aria-disabled={ocupado}
          className={`${boton} ${enHumano ? "border border-borde bg-white text-tinta hover:bg-stone-50" : "bg-marca text-white hover:bg-marca-fuerte"}`}
        >
          {enHumano ? "Devolver al bot" : "Tomar el chat"}
        </button>
      </div>

      {enHumano ? (
        <form onSubmit={responder} className="mt-3 flex flex-col gap-2">
          <label htmlFor={idCampo} className="text-sm font-medium">
            Responder como persona del negocio
          </label>
          <div className="flex gap-2">
            <input
              id={idCampo}
              ref={campo}
              name="respuesta"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              readOnly={ocupado}
              maxLength={1000}
              autoComplete="off"
              className="min-h-11 min-w-0 flex-1 rounded-lg border border-borde bg-white px-3 text-[1rem] read-only:bg-stone-100"
            />
            <button
              type="submit"
              disabled={!texto.trim()}
              aria-disabled={ocupado}
              className={`${boton} shrink-0 bg-marca text-white hover:bg-marca-fuerte`}
            >
              Enviar
            </button>
          </div>
        </form>
      ) : null}
      <AvisoAccion resultado={resultado} />
    </article>
  );
}

/** El panel del negocio: conversaciones con su modo y citas de los próximos días por día, en hora local. */
export function Panel({
  perfil,
  datos,
  avisoCarga,
  alCambiar,
}: {
  perfil: PerfilVista;
  datos: DatosPanel | null;
  avisoCarga: Resultado | null;
  alCambiar: () => Promise<Resultado>;
}) {
  const servicio = new Map(perfil.servicios.map((s) => [s.id, s.nombre]));
  const zona = perfil.zonaHoraria;
  // Solo con datos: llegan del navegador, así la hora actual nunca se lee al prerenderizar.
  const dias = datos ? agruparPorDia(datos.citas, zona, new Date()) : [];

  return (
    <section aria-labelledby="titulo-panel" className="flex flex-col gap-6">
      <header>
        <h2 id="titulo-panel" className="text-2xl font-semibold tracking-tight">
          Panel del negocio
        </h2>
        <p className="mt-1 text-sm text-tenue">Lo que ve el negocio. Se actualiza solo cada 4 segundos.</p>
        <AvisoAccion resultado={avisoCarga} />
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:items-start">
        <section aria-labelledby="titulo-conversaciones" className="flex flex-col gap-3">
          <h3 id="titulo-conversaciones" className="text-lg font-semibold">
            Conversaciones
          </h3>
          {datos === null ? (
            <p className="text-sm text-tenue">Cargando…</p>
          ) : datos.conversaciones.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-borde px-4 py-6 text-center text-sm text-tenue">
              Todavía no hay conversaciones. Escribe en el chat para empezar una.
            </p>
          ) : (
            datos.conversaciones.map((c) => <TarjetaConversacion key={c.id} conversacion={c} zona={zona} alCambiar={alCambiar} />)
          )}
        </section>

        <section aria-labelledby="titulo-citas" className="flex flex-col gap-3">
          <h3 id="titulo-citas" className="text-lg font-semibold">
            Citas de los próximos días
          </h3>
          {datos === null ? (
            <p className="text-sm text-tenue">Cargando…</p>
          ) : dias.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-borde px-4 py-6 text-center text-sm text-tenue">
              No hay citas en los próximos 14 días.
            </p>
          ) : (
            <ol className="flex flex-col gap-4">
              {dias.map(({ fecha, titulo, citas }) => (
                <li key={fecha} className="rounded-2xl border border-borde bg-white shadow-sm">
                  <h4 className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-borde px-4 py-2.5 font-semibold">
                    {titulo}
                    <span className="text-sm font-normal text-tenue">{contarCitas(citas.length)}</span>
                  </h4>
                  <ul className="divide-y divide-borde">
                    {citas.map((c) => {
                      const cancelada = c.estado === "cancelada";
                      return (
                        <li key={c.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                          <p className={`text-sm font-semibold tabular-nums ${cancelada ? "text-tenue line-through" : ""}`}>
                            <time dateTime={c.inicio}>{etiquetaHora(c.inicio, zona)}</time>–<time dateTime={c.fin}>{etiquetaHora(c.fin, zona)}</time>
                          </p>
                          <div className="min-w-0">
                            <p className={`text-sm font-medium [overflow-wrap:anywhere] ${cancelada ? "text-tenue line-through" : ""}`}>
                              {servicio.get(c.servicioId) ?? c.servicioId}
                            </p>
                            <p className="text-sm text-tenue [overflow-wrap:anywhere]">
                              {/* bdi: un nombre en árabe o hebreo no voltea el orden del teléfono que va después. */}
                              <bdi>{c.cliente.nombre}</bdi>
                              {c.cliente.telefono ? (
                                <>
                                  {" · "}
                                  <span className="whitespace-nowrap tabular-nums">{formatoTelefono(c.cliente.telefono)}</span>
                                </>
                              ) : null}
                            </p>
                          </div>
                          {/* Casi todas están confirmadas: solo la excepción lleva etiqueta. */}
                          {cancelada ? (
                            <p className="col-start-2 sm:col-start-auto sm:text-right">
                              <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-stone-700">
                                {ETIQUETA_ESTADO.cancelada}
                              </span>
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </section>
  );
}
