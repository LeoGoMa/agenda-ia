-- Agenda IA: esquema, reserva atómica de citas y contadores del limitador.
-- Solo el servidor entra, con la service role: RLS activada sin políticas, sin permisos para anon ni
-- authenticated, y las funciones solo se pueden ejecutar como service_role.

-- Tablas ------------------------------------------------------------------------------------------

-- La crea el servidor cuando pone la cookie; borrarla borra en cascada todo lo de esa sesión.
create table public.sesiones (
  id uuid primary key,
  creada timestamptz not null default now()
);

create table public.citas (
  id uuid primary key,
  sesion_id uuid not null references public.sesiones (id) on delete cascade,
  negocio_id text not null,
  servicio_id text not null,
  cliente_nombre text not null,
  cliente_telefono text not null,
  inicio timestamptz not null,
  fin timestamptz not null,
  estado text not null check (estado in ('confirmada', 'cancelada')),
  creada timestamptz not null default now(),
  check (inicio < fin)
);
create index citas_sesion_negocio_inicio on public.citas (sesion_id, negocio_id, inicio);

create table public.conversaciones (
  id uuid primary key default gen_random_uuid(),
  sesion_id uuid not null references public.sesiones (id) on delete cascade,
  negocio_id text not null,
  modo text not null default 'bot' check (modo in ('bot', 'humano')),
  -- json y no jsonb: json guarda el texto tal cual y conserva el orden de las llaves que devolvió la API
  -- de Claude; jsonb las reordena, y un tool_use reenviado con otro orden rompe el caché de prompts.
  historial_api json not null default '[]',
  -- Hash del prompt y las herramientas con que se armó historial_api; null si nunca habló el bot.
  version_prompt text,
  mensajes_visitante int not null default 0,
  actualizada timestamptz not null default now(),
  unique (sesion_id, negocio_id)
);

create table public.mensajes (
  id bigserial primary key,
  conversacion_id uuid not null references public.conversaciones (id) on delete cascade,
  rol text not null check (rol in ('cliente', 'bot', 'humano', 'sistema')),
  texto text not null,
  creado timestamptz not null default now()
);
create index mensajes_conversacion_id on public.mensajes (conversacion_id, id);

-- La clave nunca lleva la IP en claro: el limitador manda el SHA-256 de sal + IP.
create table public.contadores (
  clave text not null,
  ventana_inicio timestamptz not null,
  conteo int not null,
  primary key (clave, ventana_inicio)
);

-- Acceso: solo el servidor ------------------------------------------------------------------------

-- RLS sin políticas deja fuera a anon y authenticated; la service role la salta.
alter table public.sesiones enable row level security;
alter table public.citas enable row level security;
alter table public.conversaciones enable row level security;
alter table public.mensajes enable row level security;
alter table public.contadores enable row level security;
-- Además se quitan los permisos que Supabase da por defecto en public a los roles de la API.
revoke all on table public.sesiones, public.citas, public.conversaciones, public.mensajes, public.contadores
  from anon, authenticated;
revoke all on sequence public.mensajes_id_seq from anon, authenticated;
-- La service role (el servidor) los tiene por los privilegios por defecto de Supabase; se dan explícitos
-- para que la migración no dependa de ellos.
grant select, insert, update, delete on table public.sesiones, public.citas, public.conversaciones, public.mensajes, public.contadores to service_role;
grant usage, select on sequence public.mensajes_id_seq to service_role;

-- Conversaciones: contador de mensajes del visitante y fecha de actualización ---------------------

create function public.tocar_conversacion() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.actualizada := now();
  return new;
end;
$$;

create trigger conversaciones_actualizada
before update on public.conversaciones
for each row execute function public.tocar_conversacion();

-- En la misma transacción que el insert del mensaje: el conteo nunca se desfasa.
create function public.contar_mensaje() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  update conversaciones
     set mensajes_visitante = mensajes_visitante + (new.rol = 'cliente')::int
   where id = new.conversacion_id;
  return new;
end;
$$;

create trigger mensajes_contar
after insert on public.mensajes
for each row execute function public.contar_mensaje();

-- Citas: reserva atómica ---------------------------------------------------------------------------
-- Regla de choque, la misma del motor y del repositorio en memoria: intervalos semiabiertos
-- [inicio, fin), solo cuentan las citas confirmadas de la misma sesión y negocio, y se rechaza con
-- HORARIO_NO_DISPONIBLE si ya hay p_capacidad o más encimadas. El candado (pg_advisory_xact_lock)
-- serializa las reservas de la misma sesión y negocio hasta el fin de la transacción, así el conteo y
-- la escritura no se intercalan con otra reserva.

create function public.crear_cita_si_cabe(
  p_id uuid,
  p_sesion_id uuid,
  p_negocio_id text,
  p_servicio_id text,
  p_cliente_nombre text,
  p_cliente_telefono text,
  p_inicio timestamptz,
  p_fin timestamptz,
  p_estado text,
  p_creada timestamptz,
  p_capacidad int
) returns public.citas
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  nueva citas;
begin
  perform pg_advisory_xact_lock(hashtext(p_sesion_id::text || p_negocio_id));

  if p_estado = 'confirmada' and (
    select count(*)
      from citas
     where sesion_id = p_sesion_id
       and negocio_id = p_negocio_id
       and estado = 'confirmada'
       and inicio < p_fin
       and fin > p_inicio
  ) >= p_capacidad then
    raise exception 'HORARIO_NO_DISPONIBLE';
  end if;

  insert into citas (id, sesion_id, negocio_id, servicio_id, cliente_nombre, cliente_telefono, inicio, fin, estado, creada)
  values (p_id, p_sesion_id, p_negocio_id, p_servicio_id, p_cliente_nombre, p_cliente_telefono, p_inicio, p_fin, p_estado, p_creada)
  returning * into nueva;
  return nueva;
end;
$$;

-- Un parámetro null deja ese campo como está. Lanza CITA_NO_ENCONTRADA si la cita no es de la sesión, o
-- si cambia inicio, fin o servicio de una cita no confirmada: reprogramar una cita que otra petición
-- acaba de cancelar falla en vez de dar un falso éxito. La cita no choca consigo misma.
create function public.actualizar_cita_si_cabe(
  p_sesion_id uuid,
  p_id uuid,
  p_inicio timestamptz,
  p_fin timestamptz,
  p_servicio_id text,
  p_estado text,
  p_capacidad int
) returns public.citas
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_negocio_id text;
  actual citas;
begin
  select negocio_id into v_negocio_id from citas where id = p_id and sesion_id = p_sesion_id;
  if not found then
    raise exception 'CITA_NO_ENCONTRADA';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_sesion_id::text || v_negocio_id));
  -- Con el candado se vuelve a leer: otra petición pudo cancelarla o moverla mientras se esperaba.
  select * into actual from citas where id = p_id for update;
  if not found
     or ((p_inicio is not null or p_fin is not null or p_servicio_id is not null) and actual.estado <> 'confirmada') then
    raise exception 'CITA_NO_ENCONTRADA';
  end if;

  actual.inicio := coalesce(p_inicio, actual.inicio);
  actual.fin := coalesce(p_fin, actual.fin);
  actual.servicio_id := coalesce(p_servicio_id, actual.servicio_id);
  actual.estado := coalesce(p_estado, actual.estado);

  if actual.estado = 'confirmada' and (
    select count(*)
      from citas
     where sesion_id = actual.sesion_id
       and negocio_id = actual.negocio_id
       and estado = 'confirmada'
       and id <> actual.id
       and inicio < actual.fin
       and fin > actual.inicio
  ) >= p_capacidad then
    raise exception 'HORARIO_NO_DISPONIBLE';
  end if;

  update citas
     set inicio = actual.inicio, fin = actual.fin, servicio_id = actual.servicio_id, estado = actual.estado
   where id = p_id
  returning * into actual;
  return actual;
end;
$$;

-- Limitador y limpieza -------------------------------------------------------------------------------

-- Suma uno en la ventana fija actual (alineada al reloj, como almacenMemoria) y devuelve el conteo ya
-- sumado. Un solo insert ... on conflict: dos peticiones a la vez nunca leen el mismo conteo.
create function public.incrementar_contador(p_clave text, p_ventana_seg int) returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conteo int;
begin
  insert into contadores (clave, ventana_inicio, conteo)
  values (p_clave, to_timestamp(floor(extract(epoch from now()) / p_ventana_seg) * p_ventana_seg), 1)
  on conflict (clave, ventana_inicio) do update set conteo = contadores.conteo + 1
  returning conteo into v_conteo;
  return v_conteo;
end;
$$;

-- La corre el cron diario. Devuelve cuántas sesiones borró.
create function public.limpiar_sesiones_viejas() returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_borradas int;
begin
  delete from sesiones where creada < now() - interval '7 days';
  get diagnostics v_borradas = row_count;
  -- Un contador solo sirve dentro de su ventana (a lo más un día): no se guardan hashes de IP de más.
  delete from contadores where ventana_inicio < now() - interval '2 days';
  return v_borradas;
end;
$$;

-- Postgres da EXECUTE a PUBLIC y Supabase a anon y authenticated: se quitan y solo queda service_role.
revoke all on function public.crear_cita_si_cabe(uuid, uuid, text, text, text, text, timestamptz, timestamptz, text, timestamptz, int)
  from public, anon, authenticated;
revoke all on function public.actualizar_cita_si_cabe(uuid, uuid, timestamptz, timestamptz, text, text, int)
  from public, anon, authenticated;
revoke all on function public.incrementar_contador(text, int) from public, anon, authenticated;
revoke all on function public.limpiar_sesiones_viejas() from public, anon, authenticated;
grant execute on function public.crear_cita_si_cabe(uuid, uuid, text, text, text, text, timestamptz, timestamptz, text, timestamptz, int)
  to service_role;
grant execute on function public.actualizar_cita_si_cabe(uuid, uuid, timestamptz, timestamptz, text, text, int) to service_role;
grant execute on function public.incrementar_contador(text, int) to service_role;
grant execute on function public.limpiar_sesiones_viejas() to service_role;
