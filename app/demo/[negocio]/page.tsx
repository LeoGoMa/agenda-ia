import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PERFILES } from "@/src/dominio/perfiles";
import { Demo } from "@/src/ui/Demo";

// Con Cache Components las tres demos se prerenderizan; un id desconocido da 404 al pedirlo. Solo ese caso
// espera a los params en la petición: `instant = false` lo permite y así el 404 sale con su código, no como 200.
export const instant = false;

export function generateStaticParams() {
  return PERFILES.map(({ id }) => ({ negocio: id }));
}

const perfilDe = async (params: PageProps<"/demo/[negocio]">["params"]) => {
  const { negocio } = await params;
  return PERFILES.find((p) => p.id === negocio);
};

export async function generateMetadata({ params }: PageProps<"/demo/[negocio]">): Promise<Metadata> {
  const perfil = await perfilDe(params);
  return { title: perfil ? `Demo de ${perfil.nombre}` : "Negocio no encontrado" };
}

export default async function PaginaDemo({ params }: PageProps<"/demo/[negocio]">) {
  const perfil = await perfilDe(params);
  if (!perfil) notFound();
  const { id, nombre, giro, zonaHoraria, servicios, trato } = perfil;

  return (
    <main className="flex flex-1 flex-col">
      <header className="border-b border-borde bg-white">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2.5">
          <Link href="/" className="shrink-0 rounded-md px-1 py-1 text-sm font-medium text-marca hover:text-marca-fuerte">
            ← Negocios
          </Link>
          <h1 className="min-w-0 truncate text-sm text-tenue">
            <span className="font-semibold text-tinta" translate="no">
              {nombre}
            </span>{" "}
            · {giro}
          </h1>
        </div>
      </header>
      {/* Al cliente solo va lo que se muestra del perfil (sin políticas, precios ni preguntas frecuentes). */}
      <Demo perfil={{ id, nombre, giro, zonaHoraria, trato, servicios: servicios.map((s) => ({ id: s.id, nombre: s.nombre })) }} />
    </main>
  );
}
