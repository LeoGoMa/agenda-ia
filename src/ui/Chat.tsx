"use client";

import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { MensajeVisible } from "../repo/tipos";
import { pedir, type DatosPanel, type PerfilVista, type Resultado } from "./api";
import { EnlacesForge } from "./AvisoFicticio";
import { etiquetaHora, separarMarcaDemo } from "./formato";

/** Frases que entienden Claude y el responder de demostración sin IA. */
const SUGERENCIAS = ["¿Qué horarios tienen?", "Quiero agendar una cita", "Quiero hablar con una persona"];
const QUIEN: Record<MensajeVisible["rol"], string> = { cliente: "Tú", bot: "Bot", humano: "Persona del negocio", sistema: "Aviso" };

interface Aviso {
  texto: string;
  /** 429: además del texto, la salida a Forge Studio. */
  limite: boolean;
  /** Mensajes de la conversación al ponerlo: se quita en cuanto llega uno nuevo, así nunca queda debajo de él. */
  base: number;
}

/**
 * Una burbuja: las del visitante a la derecha; las del bot y de la persona del negocio, a la izquierda.
 * memo: escribir en el campo no vuelve a formatear las horas de todas las burbujas en cada tecla.
 */
const Burbuja = memo(function Burbuja({ mensaje, zona }: { mensaje: MensajeVisible; zona: string }) {
  if (mensaje.rol === "sistema") return <NotaSistema texto={mensaje.texto} />;
  const propio = mensaje.rol === "cliente";
  const { texto, demo } = mensaje.rol === "bot" ? separarMarcaDemo(mensaje.texto) : { texto: mensaje.texto, demo: false };
  return (
    <li className={`flex ${propio ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 pt-2 pb-1.5 shadow-sm ${propio ? "rounded-br-md bg-saliente" : "rounded-bl-md bg-white"}`}
      >
        <span className="sr-only">{QUIEN[mensaje.rol]}: </span>
        {mensaje.rol === "humano" ? (
          <p aria-hidden="true" className="text-xs font-semibold text-amber-800">
            Persona del negocio
          </p>
        ) : null}
        <p dir="auto" className="text-[0.9375rem] leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]">
          {texto}
        </p>
        <p className="mt-1 flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[0.6875rem] text-tenue">
          {demo ? <span className="rounded-full bg-violet-100 px-1.5 py-px font-medium text-violet-800">demo sin IA</span> : null}
          <time dateTime={mensaje.creadoEn} className="tabular-nums">
            {etiquetaHora(mensaje.creadoEn, zona)}
          </time>
        </p>
      </div>
    </li>
  );
});

function NotaSistema({ texto, limite = false }: { texto: string; limite?: boolean }) {
  return (
    <li className="mx-auto max-w-[90%] rounded-xl bg-aviso px-3 py-2 text-center text-sm text-amber-950 shadow-sm [overflow-wrap:anywhere]">
      <span className="sr-only">Aviso: </span>
      {texto}
      {limite ? (
        <span className="mt-1 block">
          <EnlacesForge prefijo="Contacto:" />
        </span>
      ) : null}
    </li>
  );
}

/** El teléfono con el chat del visitante. Desactiva el envío mientras hay una petición en curso. */
export function Chat({
  perfil,
  conversacion,
  cargando,
  avisoCarga,
  alCambiar,
}: {
  perfil: PerfilVista;
  conversacion: DatosPanel["conversaciones"][number] | undefined;
  cargando: boolean;
  /** Si la primera carga falló, el chat dice por qué en vez de quedarse en «Cargando…». */
  avisoCarga: Resultado | null;
  alCambiar: () => Promise<Resultado>;
}) {
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  // El mensaje en camino, y cuántos había al mandarlo: se deja de mostrar cuando el servidor ya lo devuelve.
  const [pendiente, setPendiente] = useState<{ texto: string; base: number } | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const lista = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLInputElement>(null);
  const idCampo = useId();

  const mensajes = conversacion?.mensajes ?? [];
  const enHumano = conversacion?.modo === "humano";
  const mostrarPendiente = pendiente !== null && mensajes.length <= pendiente.base;

  // Al llegar algo nuevo, el chat baja hasta el final (el sondeo sin cambios no mueve nada).
  useEffect(() => {
    lista.current?.scrollTo({ top: lista.current.scrollHeight });
  }, [mensajes.length, mostrarPendiente, enviando, aviso]);

  async function enviar(contenido: string) {
    const limpio = contenido.trim();
    if (!limpio || enviando) return;
    const estabaEnHumano = enHumano;
    setEnviando(true);
    setAviso(null);
    setTexto("");
    setPendiente({ texto: limpio, base: mensajes.length });
    const r = await pedir("/api/chat", { negocioId: perfil.id, texto: limpio });
    const fresco = await alCambiar();
    setPendiente(null);
    setEnviando(false);
    // Lo que ya trae el panel tras este envío; si no cargó, los de antes de enviar.
    const base = fresco.ok ? ((fresco.cuerpo as DatosPanel).conversaciones[0]?.mensajes.length ?? 0) : mensajes.length;
    if (!r.ok) {
      setAviso({ texto: r.texto, limite: r.estado === 429, base });
      // Salvo en el 429, el texto vuelve al campo para corregirlo o reintentar.
      if (r.estado !== 429) setTexto((actual) => actual || limpio);
    } else if (estabaEnHumano) {
      // En modo humano el bot no contesta: la respuesta es el aviso de que una persona lo atiende.
      setAviso({ texto: r.texto, limite: false, base });
    }
    requestAnimationFrame(() => campo.current?.focus());
  }

  const alEnviar = (e: FormEvent) => {
    e.preventDefault();
    void enviar(texto);
  };

  const estado = enHumano ? "Atiende una persona del negocio" : enviando ? "escribiendo…" : "Asistente de citas";

  return (
    <section
      aria-label={`Chat con ${perfil.nombre}`}
      className="flex h-full flex-col overflow-hidden bg-chat lg:rounded-[2rem] lg:border-[6px] lg:border-stone-800 lg:shadow-xl"
    >
      <header className="flex shrink-0 items-center gap-3 bg-marca-fuerte px-4 py-3 text-white">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-white/15">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
        </span>
        <div className="min-w-0">
          <h2 className="truncate font-semibold" title={perfil.nombre} translate="no">
            {perfil.nombre}
          </h2>
          <p className="truncate text-xs text-white/85">{estado}</p>
        </div>
      </header>

      <div ref={lista} role="log" aria-live="polite" aria-label="Mensajes" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4">
        {cargando && !avisoCarga ? (
          <p className="pt-8 text-center text-sm text-tenue">Cargando la conversación…</p>
        ) : !cargando && mensajes.length === 0 && !mostrarPendiente ? (
          <div className="mx-auto max-w-xs pt-6 text-center">
            <p className="rounded-xl bg-white/70 px-3 py-2 text-sm text-tenue">
              Escribe como si fueras cliente de {perfil.nombre}. Puedes empezar con:
            </p>
            <div className="mt-3 flex flex-col items-center gap-2">
              {SUGERENCIAS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={enviando}
                  onClick={() => void enviar(s)}
                  className="min-h-11 rounded-full border border-marca/40 bg-white px-4 text-sm font-medium text-marca shadow-sm hover:bg-teal-50 disabled:opacity-60"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <ol className="flex flex-col gap-2">
          {cargando && avisoCarga ? <NotaSistema texto={avisoCarga.texto} limite={avisoCarga.estado === 429} /> : null}
          {mensajes.map((m, i) => (
            // Los mensajes solo se agregan al final: el índice es estable.
            <Burbuja key={i} mensaje={m} zona={perfil.zonaHoraria} />
          ))}
          {mostrarPendiente ? (
            <li className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-saliente/70 px-3 py-2 text-[0.9375rem] leading-snug whitespace-pre-wrap [overflow-wrap:anywhere]">
                <span className="sr-only">Tú, enviando: </span>
                {pendiente?.texto}
              </p>
            </li>
          ) : null}
          {enviando && !enHumano ? (
            <li className="flex justify-start">
              <p className="rounded-2xl rounded-bl-md bg-white px-3 py-2 text-sm text-tenue italic shadow-sm motion-safe:animate-pulse">escribiendo…</p>
            </li>
          ) : null}
          {aviso && mensajes.length <= aviso.base ? <NotaSistema texto={aviso.texto} limite={aviso.limite} /> : null}
        </ol>
      </div>

      <form onSubmit={alEnviar} className="flex shrink-0 items-center gap-2 px-3 pt-1 pb-3">
        <label htmlFor={idCampo} className="sr-only">
          Mensaje para {perfil.nombre}
        </label>
        <input
          id={idCampo}
          name="mensaje"
          ref={campo}
          value={texto}
          onChange={(e) => setTexto(e.target.value)}
          disabled={enviando}
          maxLength={1000}
          autoComplete="off"
          enterKeyHint="send"
          placeholder="Escribe un mensaje…"
          className="min-h-11 min-w-0 flex-1 rounded-full bg-white px-4 text-[1rem] shadow-sm placeholder:text-stone-500 disabled:bg-stone-100"
        />
        <button
          type="submit"
          disabled={enviando || !texto.trim()}
          className="grid size-11 shrink-0 place-items-center rounded-full bg-marca text-white shadow-sm hover:bg-marca-fuerte disabled:opacity-50"
        >
          <span className="sr-only">Enviar</span>
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="currentColor">
            <path d="M3.4 20.4 21 12 3.4 3.6l-.1 6.5L15 12 3.3 13.9z" />
          </svg>
        </button>
      </form>
    </section>
  );
}
