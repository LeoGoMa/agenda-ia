import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { AvisoFicticio, EnlacesForge } from "@/src/ui/AvisoFicticio";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "Agenda IA: bot de citas por chat", template: "%s · Agenda IA" },
  description:
    "Demo de un bot que atiende el chat de un negocio: informa precios y horarios, agenda, cambia o cancela citas y pasa la conversación a una persona.",
};

// Del color de la franja de aviso, que es lo primero de cada página.
export const viewport: Viewport = { themeColor: "#fdf1c7", colorScheme: "light" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-MX" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <AvisoFicticio />
        <div className="flex flex-1 flex-col">{children}</div>
        <footer className="border-t border-borde px-4 py-6 text-center text-sm text-tenue">
          <EnlacesForge />
        </footer>
      </body>
    </html>
  );
}
