-- =====================================================================
-- 0019_sin_absorb.sql
-- Se retira la politica `absorb` del recargo por tarjeta.
--
-- ─────────────────────────────────────────────────────────────────────
-- POR QUE SE QUITA: PROMETIA ALGO QUE NO PODIA CUMPLIR
-- ─────────────────────────────────────────────────────────────────────
--
-- `absorb` significaba "el restaurante asume el recargo, asi que al
-- cliente no se le enseña nada". La segunda mitad se cumplia —la app
-- callaba— y la primera no.
--
-- EL HALLAZGO QUE LO CIERRA, y es concreto: EL ENDPOINT DE COBRO NO TIENE
-- CAMPO PARA RENUNCIAR AL RECARGO. `POST /v1/orders/{id}/pay` acepta
-- `source`, `amount`, `tip_amount` y `currency`, y nada mas. El recargo lo
-- aplica Clover segun la configuracion del merchant y el BIN de la
-- tarjeta, y llega despues en `additionalCharges` del pago. No hay
-- parametro que mandar ni cabecera que poner: no es que no lo hubieramos
-- implementado, es que no se puede pedir.
--
-- Asi que una sucursal con `absorb` y recargo activo no absorbia nada:
--
--   el cliente pagaba el recargo igual...
--   ...y ademas EN SILENCIO, porque `absorb` suprimia el aviso.
--
-- Dos fallos a la vez, y el segundo es el caro:
--
--   1. faltaba un aviso obligatorio. En Nueva Jersey (P.L. 2023, c.146)
--      eso es LA infraccion, no un detalle de redaccion;
--   2. el restaurante se equivocaba sobre su propia economia, y en la
--      direccion que le hacia creer que estaba siendo generoso: creia
--      estar pagando un coste que pagaba su cliente.
--
-- Que el cliente pague el recargo en silencio es exactamente lo que el
-- aviso existe para evitar. Una politica que promete absorber y no
-- absorbe es peor que no tenerla.
--
-- LA UNICA FORMA REAL DE ABSORBER sigue existiendo y no es nuestra: que
-- el restaurante APAGUE el recargo en su cuenta de Clover. Entonces
-- `surcharge_rate` llega a 0 y no hace falta ninguna politica.
--
-- QUEDAN DOS: `show` (por defecto) y `block`.
--
-- MIGRACION NUEVA. Las 0001 a 0018 no se editan.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. LAS FILAS QUE YA ESTABAN EN `absorb` PASAN A `show`
--
-- Antes de tocar el tipo, porque despues el valor no existe.
--
-- A `show` y no a `block`: `block` dejaria esas sucursales sin vender por
-- un cambio nuestro, y el problema de `absorb` no era que vendieran — era
-- que callaban. `show` divulga, que es justo lo que faltaba.
--
-- CONSECUENCIA VISIBLE, y es la que se busca: a partir de aqui esas
-- sucursales ENSEÑAN el aviso de recargo en la app. Si alguien eligio
-- `absorb` creyendo que su local pagaba la diferencia, se va a encontrar
-- con que el cliente ve un aviso que antes no veia. Esa es la correccion,
-- no un efecto secundario.
-- ---------------------------------------------------------------------
do $$
declare
  v_afectadas int;
begin
  update public.stores set surcharge_policy = 'show'
   where surcharge_policy = 'absorb';
  get diagnostics v_afectadas = row_count;

  if v_afectadas > 0 then
    raise notice
      '% sucursal(es) pasaron de absorb a show. A partir de ahora ENSEÑAN el '
      'aviso de recargo en la app. Conviene avisar al restaurante: puede que '
      'creyera estar asumiendo un coste que en realidad pagaba su cliente.',
      v_afectadas;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 2. EL ENUM PIERDE EL VALOR
--
-- Postgres NO sabe quitar un valor de un enum: no hay `alter type ... drop
-- value`. El camino es cambiar de tipo, y son cinco pasos que hay que dar
-- en este orden.
--
-- El `using ...::text::...` pasa por texto a proposito: sin ese rodeo,
-- Postgres no sabe convertir entre dos tipos enum distintos aunque
-- compartan etiquetas. Y funciona porque el paso 1 ya dejo la tabla sin
-- ningun `absorb` — si quedara uno, esto fallaria aqui, que es donde hay
-- que fallar.
--
-- El `default` se quita y se vuelve a poner porque un default del tipo
-- viejo impide cambiar la columna de tipo.
-- ---------------------------------------------------------------------
alter type app.surcharge_policy rename to surcharge_policy_con_absorb;

create type app.surcharge_policy as enum (
  -- Mostrar el recargo al cliente antes de pagar. POR DEFECTO, y ahora
  -- ademas es la unica que deja vender: la otra no activa la sucursal.
  'show',
  -- No activar la sucursal mientras tenga recargo.
  'block'
);

alter table public.stores
  alter column surcharge_policy drop default;

alter table public.stores
  alter column surcharge_policy type app.surcharge_policy
    using surcharge_policy::text::app.surcharge_policy;

alter table public.stores
  alter column surcharge_policy set default 'show';

drop type app.surcharge_policy_con_absorb;

comment on column public.stores.surcharge_policy is
  'Que hacer si el merchant cobra recargo por tarjeta: mostrarlo al '
  'cliente (show, por defecto) o no activar la sucursal (block). Habia una '
  'tercera, absorb, y la 0019 la quito: prometia que el recargo lo asumia '
  'el restaurante y no podia cumplirlo — el endpoint de cobro de Clover no '
  'tiene campo para renunciar al recargo, asi que el cliente lo pagaba '
  'igual y sin aviso. El aviso al super admin sale con las dos.';


-- ---------------------------------------------------------------------
-- 3. LA CASILLA DEL CHECKLIST VUELVE A `false` PARA LAS AFECTADAS
--
-- Quien eligio `absorb` tomo una decision que ya no existe. Que vuelva a
-- mirarlo no es burocracia: es que su local puede estar cobrando un
-- recargo que el creia estar pagando.
--
-- NO DEJA A NADIE SIN SERVICIO, y conviene saber por que: el trigger
-- `trg_stores_activation` (0001) salta en `insert or update of status`, y
-- esta migracion no cambia el status de nadie. Una sucursal `active` sigue
-- activa y vendiendo; lo que cambia es que la proxima vez que alguien
-- toque su estado, tendra que repasar el recargo. Es la misma mecanica —y
-- la misma promesa— que uso la 0011 al crear la casilla.
--
-- Solo a las afectadas: marcar a todo el mundo convertiria un aviso en
-- ruido, y un checklist que siempre tiene casillas rojas deja de mirarse.
-- ---------------------------------------------------------------------
update public.stores
   set setup_checklist = setup_checklist || jsonb_build_object('surcharge_reviewed', false)
 where surcharge_rate > 0
   and setup_checklist ->> 'surcharge_reviewed' = 'true'
   -- La huella de haber estado en `absorb`: tiene recargo, alguien lo
   -- reviso, y sin embargo la politica es la de por defecto. Es lo mas
   -- cerca que se puede estar de "vengo de absorb" despues del paso 1.
   and surcharge_policy = 'show';


-- ---------------------------------------------------------------------
-- 4. LO QUE NO SE ARREGLA AQUI, Y HAY QUE DECIDIR ANTES DE PRODUCCION
--
-- CLOVER-PENDING (DECISION DE PRODUCTO, no de codigo ni de Clover):
-- cuando hay recargo, EL NUMERO QUE ENSEÑA LA APP NUNCA SERA EL QUE SE
-- COBRA.
--
-- El recargo cae solo sobre tarjetas de credito con BIN elegible: no
-- sobre debito, no sobre efectivo, y las reglas las ponen las redes de
-- tarjetas. Asi que el importe exacto no existe hasta conocer la tarjeta,
-- y "3,5 %" —que es divulgacion valida segun la FAQ de NJ— sigue siendo
-- un numero distinto del cobro.
--
-- Lo que hay que decidir, y no es una linea de codigo: como se le dice
-- eso al cliente sin que parezca que se le esta ocultando algo. Hoy la
-- app enseña el porcentaje y un subtotal, y dice que la caja calcula el
-- total. Falta la frase que explique que el recargo puede no aplicarse a
-- su tarjeta.
--
-- CUANDO: antes de abrir la primera sucursal con recargo activo. No
-- bloquea el sandbox, donde el recargo ni se puede encender.
-- ---------------------------------------------------------------------
