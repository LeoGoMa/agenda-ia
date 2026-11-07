const FORGE_SITIO = "https://leogoma.github.io/forge-studio/";
const FORGE_INSTAGRAM = "https://www.instagram.com/forgestudio.work.ai/";
const enlace = "font-medium text-marca underline underline-offset-2 hover:text-marca-fuerte";

/** «Negocio ficticio · Datos de demostración», pegado arriba en todas las páginas: siempre a la vista. */
export function AvisoFicticio() {
  return (
    <p className="sticky top-0 z-30 border-b border-amber-300 bg-aviso px-4 py-1.5 text-center text-sm font-medium text-amber-950">
      Negocio ficticio · Datos de demostración
    </p>
  );
}

/** El pie de la página y la salida de los límites de la demo: el sitio y el Instagram de Forge Studio. */
export function EnlacesForge({ prefijo = "Hecho por" }: { prefijo?: string }) {
  return (
    <span>
      {prefijo}{" "}
      <a href={FORGE_SITIO} target="_blank" rel="noopener noreferrer" translate="no" className={`${enlace} whitespace-nowrap`}>
        Forge Studio
      </a>{" "}
      ·{" "}
      <a href={FORGE_INSTAGRAM} target="_blank" rel="noopener noreferrer" className={enlace}>
        Instagram
      </a>
    </span>
  );
}
