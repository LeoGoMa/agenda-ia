import type { SupabaseClient } from "@supabase/supabase-js";
import type { AlmacenContadores } from "./limites";

/**
 * Contadores en la tabla `contadores`. La RPC suma y devuelve el conteo en un solo insert ... on conflict,
 * así dos peticiones a la vez nunca leen el mismo número. Si Supabase falla, el error sube y no se llama a Claude.
 */
export function almacenSupabase(cliente: SupabaseClient): AlmacenContadores {
  return {
    async incrementar(clave, ventanaSeg) {
      const { data, error } = await cliente.rpc("incrementar_contador", { p_clave: clave, p_ventana_seg: ventanaSeg });
      if (error) throw new Error(`Supabase: ${error.message}`, { cause: error });
      return data as number;
    },
  };
}
