import Link from "next/link";
import { PERFILES } from "@/src/dominio/perfiles";

const PESOS = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });

export default function Inicio() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-12 sm:py-20">
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Agenda IA</h1>
      <p className="mt-4 max-w-2xl text-lg text-pretty text-tenue">
        Un bot que atiende el chat de un negocio: informa precios y horarios, agenda, cambia o cancela citas con la
        disponibilidad real y pasa la conversación a una persona cuando hace falta.
      </p>
      <p className="mt-2 max-w-2xl text-pretty text-tenue">
        Elige un negocio de ejemplo: chateas como cliente y al lado ves el panel del negocio con sus citas.
      </p>

      <ul className="mt-10 grid gap-4 md:grid-cols-3">
        {PERFILES.map(({ id, nombre, giro, servicios }) => (
          <li
            key={id}
            className="relative flex flex-col rounded-2xl border border-borde bg-white p-5 shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-marca hover:shadow-md"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-marca">{giro}</p>
              <span className="shrink-0 rounded-full bg-aviso px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-950">
                Negocio ficticio
              </span>
            </div>
            <h2 className="mt-2 text-xl font-semibold text-balance [overflow-wrap:anywhere]">
              {/* El enlace cubre la tarjeta entera; su nombre accesible es solo el del negocio. */}
              <Link href={`/demo/${id}`} translate="no" className="after:absolute after:inset-0 focus-visible:outline-none">
                {nombre}
              </Link>
            </h2>
            <ul className="mt-3 space-y-1 text-sm text-tenue">
              {servicios.slice(0, 3).map((s) => (
                <li key={s.id} className="flex justify-between gap-3">
                  <span className="min-w-0">{s.nombre}</span>
                  <span className="shrink-0 tabular-nums">{PESOS.format(s.precioMxn)}</span>
                </li>
              ))}
            </ul>
            <p aria-hidden="true" className="mt-auto pt-5 text-sm font-semibold text-marca">
              Probar el chat →
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
