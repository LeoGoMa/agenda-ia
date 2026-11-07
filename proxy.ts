import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_SESION, DURACION_SESION_SEG, sesionDe } from "@/src/web/sesion";

/**
 * Da a cada visitante su sesión anónima: si la cookie falta o no es un uuid v4, pone una nueva.
 * Next.js 16 renombró `middleware.ts` a `proxy.ts` (y la función a `proxy`).
 * La API no pasa por aquí: sin cookie válida responde 401 y la siguiente carga de página la repone.
 */
export function proxy(peticion: NextRequest) {
  const respuesta = NextResponse.next();
  // Mismo criterio que las rutas (sesionDe), así nunca se acepta aquí una cookie que la API rechace.
  if (!sesionDe(peticion)) {
    respuesta.cookies.set(COOKIE_SESION, crypto.randomUUID(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: DURACION_SESION_SEG,
      path: "/",
    });
  }
  return respuesta;
}

export const config = {
  // Solo páginas: ni la API ni los archivos estáticos.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
