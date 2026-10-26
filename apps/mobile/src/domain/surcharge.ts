/**
 * Recargo por tarjeta de credito: que se le dice al cliente, y cuando.
 *
 * ESTO NO ES UNA DECISION DE DISENO. ES NUEVA JERSEY.
 * P.L. 2023, c.146 (N.J.S.A. 56:8-156.1 y -156.2), tal y como la explica
 * la FAQ oficial de la NJ Division of Consumer Affairs. Cuatro reglas, y
 * las cuatro estan implementadas aqui o en las pantallas que usan esto:
 *
 *  1. HAY QUE DECIR EL IMPORTE, no que existe un recargo. La FAQ da el
 *     ejemplo de lo que NO vale: un cartel que dice "imponemos un recargo
 *     que no excede nuestros costes de procesamiento". Un aviso sin cifra
 *     no es una divulgacion incompleta: es un incumplimiento. Por eso
 *     `disclose` solo es `true` cuando hay un `percentLabel` que ensenar,
 *     y por eso nunca sale un aviso generico "esta sucursal aplica un
 *     recargo". Si no hay cifra, no hay aviso — y entonces tampoco
 *     deberia haber cobro (ver `unknownRate`).
 *
 *  2. EL PORCENTAJE VALE COMO IMPORTE. No hace falta la cifra en dolares
 *     antes de saber con que tarjeta va a pagar. Eso es lo que permite
 *     que esto funcione: `surcharge_rate` se ensena como porcentaje y ya
 *     esta divulgado. Ver abajo por que NO estimamos dolares.
 *
 *  3. NADA DE "HASTA UN 3 %". Un maximo no es un importe. Va "3 %". Por
 *     eso `formatRatePercent` redondea HACIA ARRIBA (ver alli): si el
 *     redondeo tuviera que mentir, que mienta cobrando menos de lo
 *     anunciado, nunca mas.
 *
 *  4. DONDE: aviso electronico claro y visible en la pantalla de checkout
 *     de la app. Y, por ser Viva un restaurante, tambien EN LA CARTA,
 *     incluidas las cartas en linea o por QR — que es exactamente lo que
 *     es la pestana de menu de esta app. De ahi que el aviso se pinte en
 *     menu, carrito, checkout y pago: todas las pantallas donde el
 *     cliente ve un precio antes de pagarlo.
 *
 * POR QUE NO SE ENSENA UNA ESTIMACION EN DOLARES
 * Podriamos: `subtotal * rate`. Seria un numero equivocado. El recargo se
 * aplica sobre el total cobrado, y el total lleva impuestos que esta app
 * no calcula a proposito (regla del proyecto: "no inventamos impuestos",
 * los calcula la caja). Una estimacion sobre el subtotal sale siempre por
 * DEBAJO de lo que se cobra, que es justo el error que la ley castiga.
 * Como la regla 2 dice que el porcentaje ya es divulgacion suficiente, la
 * cifra en dolares no aporta nada y solo puede restar. El importe exacto
 * sale de la caja, igual que los impuestos y el total.
 *
 * LA TASA VIENE DE CLOVER, NO DE UN CAMPO TECLEADO
 * La ley tambien dice que el recargo no puede superar el coste real de
 * procesamiento. Eso es responsabilidad del restaurante, no de la app,
 * pero la app no debe facilitar el incumplimiento: `surcharge_rate` es lo
 * ULTIMO LEIDO en `ecomm_payment_configs` (migracion 0011), no un valor
 * que alguien escribio. Este modulo no acepta otra fuente.
 *
 * Modulo puro: solo imports de tipo, para poder correrlo bajo
 * `node --test --experimental-strip-types`.
 */

import type { Cents } from './money';

/**
 * Las DOS politicas de `app.surcharge_policy` (0011, reducida por la
 * 0019). El mismo enum vive en `@juicebar/clover-client`; se repite aqui
 * y no se importa porque la app movil no depende de ese paquete (ni debe:
 * arrastra el cliente HTTP de Clover a un bundle de telefono).
 *
 * ERAN TRES. `absorb` se quito en la 0019 porque prometia algo que no
 * podia cumplir: el recargo lo aplica Clover segun la configuracion del
 * merchant y el BIN de la tarjeta, y el endpoint de cobro NO TIENE CAMPO
 * para renunciar a el. Asi que con `absorb` el restaurante no absorbia
 * nada — el cliente pagaba igual, y en silencio, porque esa politica
 * suprimia el aviso. Ver docs/RECARGO-TARJETA.md.
 */
export type SurchargePolicy = 'show' | 'block';

const POLICIES: readonly SurchargePolicy[] = ['show', 'block'];

export const DEFAULT_SURCHARGE_POLICY: SurchargePolicy = 'show';

/**
 * Valida lo que venga de PostgREST.
 *
 * Un valor desconocido cae en `show`: si algun dia entra un valor nuevo
 * en el enum, el peor comportamiento posible es callarse mientras se
 * cobra de mas. Ensenarlo de sobra no hace dano a nadie.
 *
 * Un `absorb` de una fila vieja tambien cae aqui, y cae en `show`, que es
 * exactamente lo que hace la 0019 al migrar. Una app sin actualizar
 * contra una base ya migrada, o al reves, se comporta igual.
 */
export function toSurchargePolicy(value: unknown): SurchargePolicy {
  return POLICIES.includes(value as SurchargePolicy)
    ? (value as SurchargePolicy)
    : DEFAULT_SURCHARGE_POLICY;
}

/** Lo que la fila de `stores` aporta a esta decision. */
export interface SurchargeSource {
  readonly surcharge_policy?: unknown;
  /**
   * Fraccion, como la da Clover: 0.03 = 3 %. `null` = sin consultar.
   *
   * El `| undefined` es explicito y no solo por el `?`: con
   * `exactOptionalPropertyTypes` no son lo mismo, y una fila de
   * PostgREST a la que le falte la columna llega con la clave ausente,
   * que es exactamente el caso que hay que aceptar.
   */
  readonly surcharge_rate?: number | null | undefined;
}

export interface SurchargeDisclosure {
  readonly policy: SurchargePolicy;
  /** La fraccion validada, o `null` si no hay recargo del que hablar. */
  readonly rate: number | null;
  /** ¿Se pinta el aviso? Solo `true` si hay una cifra que ensenar. */
  readonly disclose: boolean;
  /** "3 %" o "3,46 %" en el formato del locale. `null` si no se divulga. */
  readonly percentLabel: string | null;
  /**
   * Hay recargo activo y NO sabemos cuanto es (`surcharge_rate` sin
   * consultar). No se puede pintar un aviso —seria el cartel sin cifra
   * que la FAQ pone de ejemplo de incumplimiento— y tampoco se deberia
   * cobrar. Hoy no puede llegar a una sucursal viva: la casilla
   * `surcharge_reviewed` del checklist (0011) impide activarla sin que
   * alguien haya mirado el recargo. Se expone para que el dia que ese
   * candado se afloje, esto no se caiga en silencio.
   */
  readonly unknownRate: boolean;
}

const NONE: SurchargeDisclosure = {
  policy: DEFAULT_SURCHARGE_POLICY,
  rate: null,
  disclose: false,
  percentLabel: null,
  unknownRate: false,
};

/**
 * `0.03` -> `"3%"`. `0.035` -> `"3.5%"`.
 *
 * DOS CUIDADOS, Y LOS DOS IMPORTAN:
 *
 * COMA FLOTANTE. `0.03 * 100` es `3.0000000000000004`, no `3`. Sin
 * normalizar, un recargo redondo se ensena como "3.01%" o como "3.0%".
 * `toPrecision(12)` quita el ruido sin tocar ninguna cifra real: ninguna
 * tasa de Clover tiene doce digitos significativos.
 *
 * REDONDEO HACIA ARRIBA. Se corta a dos decimales de porcentaje con
 * `ceil`, no con `round`. Anunciar 3,45 % y cobrar 3,456 % es cobrar mas
 * de lo divulgado, que es la infraccion; anunciar 3,46 % y cobrar 3,456 %
 * solo es ser conservador. Cuando el redondeo tiene que equivocarse, se
 * equivoca en contra del restaurante.
 *
 * El locale es el de la app (en-US por defecto): "3.5%", no "3,5 %". El
 * `formatSurchargeRate` de `@juicebar/clover-client` hace lo contrario a
 * proposito — aquel texto es para el panel del super admin, en espanol.
 */
export function formatRatePercent(rate: number, locale = 'en-US'): string {
  const clean = Number((rate * 100).toPrecision(12));
  const percent = Math.ceil(clean * 100) / 100;

  return new Intl.NumberFormat(locale, {
    style: 'percent',
    // Sin decimales de mas: nadie anuncia un "3.00%".
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(percent / 100);
}

/**
 * Decide si esta sucursal le ensena un recargo al cliente, y con que cifra.
 *
 * Las cuatro salidas posibles, y por que:
 *
 *   rate null            no se ha consultado Clover. No sabemos si hay
 *                        recargo. Silencio, y `unknownRate` si la
 *                        politica dice que habria que ensenarlo.
 *   rate 0               consultado: no hay recargo. Silencio, correcto.
 *   rate > 0, `show`     se divulga con su porcentaje. El caso normal.
 *   rate > 0, `block`    la sucursal no se activa: no hay pedido. Silencio.
 *
 * SON TRES SALIDAS Y NO CUATRO desde la 0019. Habia una cuarta,
 * `absorb`, que callaba porque "lo paga el restaurante". No lo pagaba: el
 * recargo lo aplica Clover y el endpoint de cobro no tiene campo para
 * renunciar a el, asi que el cliente lo pagaba igual y sin aviso. Una
 * politica que promete absorber y no absorbe es peor que no tenerla.
 *
 * CLOVER-PENDING (decision de PRODUCTO, no de codigo): cuando hay
 * recargo, el numero que ensena la app NUNCA sera el que se cobra. El
 * recargo cae solo sobre credito con BIN elegible —no sobre debito, no
 * sobre efectivo— asi que el importe exacto no existe hasta conocer la
 * tarjeta. "3,5 %" es lo mejor que se puede divulgar por adelantado y
 * aun asi es un numero distinto del cobro. Hay que decidir como se
 * redacta ANTES de abrir una sucursal con recargo activo. Ver
 * docs/RECARGO-TARJETA.md, "El numero que se ensena no es el que se
 * cobra".
 */
export function surchargeDisclosure(
  source: SurchargeSource | null | undefined,
  locale = 'en-US',
): SurchargeDisclosure {
  if (source === null || source === undefined) return NONE;

  const policy = toSurchargePolicy(source.surcharge_policy);
  const raw = source.surcharge_rate;

  // `null` y `undefined` son "sin consultar". Un `NaN` o un negativo que
  // se colara por PostgREST tambien: no son una tasa, y tratarlos como 0
  // seria afirmar que no hay recargo sin saberlo.
  const known = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;

  if (!known) {
    return { ...NONE, policy, unknownRate: policy === 'show' };
  }

  if (raw === 0) return { ...NONE, policy };

  if (policy !== 'show') {
    return { ...NONE, policy, rate: raw };
  }

  return {
    policy,
    rate: raw,
    disclose: true,
    percentLabel: formatRatePercent(raw, locale),
    unknownRate: false,
  };
}

/**
 * Lo que se cobraria de recargo sobre un importe dado.
 *
 * NO SE USA EN NINGUNA PANTALLA, y es a proposito: ver la cabecera de
 * este modulo. Existe para el dia que la app conozca el TOTAL real (con
 * impuestos) que devuelve Clover, que es el unico importe sobre el que
 * esta cuenta no miente. Sobre un subtotal da de menos, siempre.
 *
 * Redondea hacia arriba por la misma razon que `formatRatePercent`.
 */
export function surchargeOnCents(totalCents: Cents, rate: number): Cents {
  if (!Number.isFinite(totalCents) || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.ceil(Math.trunc(totalCents) * rate);
}
