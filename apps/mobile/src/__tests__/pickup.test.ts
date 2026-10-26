/**
 * Franjas de recogida. Los datos son los de Freehold en el seed:
 * abre 06:00-21:00 (sabado 09:00), zona America/New_York, franjas de 15
 * minutos, 10 de antelacion, 8 pedidos por franja, 2 dias de margen.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPickupDays,
  canOrderAsap,
  dayKey,
  daysWithSlots,
  earliestPickup,
  firstAvailableSlot,
  formatSlotLabel,
  isClosedAt,
  minutesFromClock,
  partsInZone,
  validateChosenSlot,
  zonedTimeToInstant,
  type Closure,
  type DayHours,
  type PickupConfig,
} from '../domain/pickup.ts';

const TZ = 'America/New_York';

const FREEHOLD_HOURS: readonly DayHours[] = [
  { weekday: 0, opens_at: '06:00:00', closes_at: '21:00:00' },
  { weekday: 1, opens_at: '06:00:00', closes_at: '21:00:00' },
  { weekday: 2, opens_at: '06:00:00', closes_at: '21:00:00' },
  { weekday: 3, opens_at: '06:00:00', closes_at: '21:00:00' },
  { weekday: 4, opens_at: '06:00:00', closes_at: '21:00:00' },
  { weekday: 5, opens_at: '06:00:00', closes_at: '21:00:00' },
  { weekday: 6, opens_at: '09:00:00', closes_at: '21:00:00' },
];

const CONFIG: PickupConfig = {
  slot_minutes: 15,
  lead_time_minutes: 10,
  max_orders_per_slot: 8,
  max_days_ahead: 2,
  asap_enabled: true,
};

/** Miercoles 2 de septiembre de 2026, 10:03 en Nueva York (EDT, UTC-4). */
const WEDNESDAY_10_03 = new Date('2026-09-02T14:03:00Z');

function build(overrides: Partial<Parameters<typeof buildPickupDays>[0]> = {}) {
  return buildPickupDays({
    hours: FREEHOLD_HOURS,
    closures: [],
    config: CONFIG,
    timeZone: TZ,
    occupancy: [],
    now: WEDNESDAY_10_03,
    ...overrides,
  });
}

describe('utilidades de zona horaria', () => {
  it('lee la hora local de la sucursal, no la del telefono', () => {
    const parts = partsInZone(WEDNESDAY_10_03, TZ);
    assert.equal(parts.hour, 10);
    assert.equal(parts.minute, 3);
    assert.equal(parts.weekday, 3); // miercoles
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 9);
    assert.equal(parts.day, 2);
  });

  it('convierte una hora local en el instante correcto', () => {
    const instant = zonedTimeToInstant({ year: 2026, month: 9, day: 2 }, 10, 30, TZ);
    // EDT es UTC-4 en septiembre.
    assert.equal(instant.toISOString(), '2026-09-02T14:30:00.000Z');
  });

  it('acierta tambien en invierno, con EST (UTC-5)', () => {
    const instant = zonedTimeToInstant({ year: 2027, month: 1, day: 15 }, 10, 30, TZ);
    assert.equal(instant.toISOString(), '2027-01-15T15:30:00.000Z');
  });

  it('una zona horaria invalida no revienta', () => {
    assert.doesNotThrow(() => partsInZone(WEDNESDAY_10_03, 'No/Existe'));
  });

  it('dayKey da el dia local de la sucursal', () => {
    assert.equal(dayKey(WEDNESDAY_10_03, TZ), '2026-09-02');
    // 00:30 UTC del dia 3 son las 20:30 del dia 2 en Nueva York.
    assert.equal(dayKey(new Date('2026-09-03T00:30:00Z'), TZ), '2026-09-02');
  });
});

describe('minutesFromClock y formatSlotLabel', () => {
  it('convierte en los dos sentidos', () => {
    assert.equal(minutesFromClock('06:00:00'), 360);
    assert.equal(minutesFromClock('16:30'), 990);
    assert.equal(formatSlotLabel(990), '4:30 PM');
    assert.equal(formatSlotLabel(360), '6:00 AM');
    assert.equal(formatSlotLabel(720), '12:00 PM');
    assert.equal(formatSlotLabel(0), '12:00 AM');
  });
});

describe('earliestPickup', () => {
  it('suma la antelacion y redondea a la franja', () => {
    // 10:03 + 10 min = 10:13, redondeado hacia arriba -> 10:15
    const earliest = earliestPickup(WEDNESDAY_10_03, CONFIG);
    assert.equal(partsInZone(earliest, TZ).hour, 10);
    assert.equal(partsInZone(earliest, TZ).minute, 15);
  });

  it('sin antelacion sigue redondeando a la franja', () => {
    const earliest = earliestPickup(WEDNESDAY_10_03, { ...CONFIG, lead_time_minutes: 0 });
    assert.equal(partsInZone(earliest, TZ).minute, 15);
  });
});

describe('buildPickupDays', () => {
  it('cubre hoy y los dias de margen configurados', () => {
    const days = build();
    assert.equal(days.length, CONFIG.max_days_ahead + 1);
    assert.deepEqual(
      days.map((d) => d.day),
      ['2026-09-02', '2026-09-03', '2026-09-04'],
    );
  });

  it('la primera franja de hoy respeta la antelacion', () => {
    const today = build()[0];
    assert.ok(today);
    assert.equal(today.slots[0]?.label, '10:15 AM');
  });

  it('no ofrece franjas pasadas', () => {
    const today = build()[0];
    assert.ok(today);
    for (const slot of today.slots) {
      assert.ok(Date.parse(slot.startsAt) >= earliestPickup(WEDNESDAY_10_03, CONFIG).getTime());
    }
  });

  it('la ultima franja cabe entera antes de cerrar', () => {
    const tomorrow = build()[1];
    assert.ok(tomorrow);
    // Cierra a las 21:00 y las franjas son de 15: la ultima empieza 20:45.
    assert.equal(tomorrow.slots.at(-1)?.label, '8:45 PM');
  });

  it('un dia completo tiene todas las franjas de la jornada', () => {
    const tomorrow = build()[1];
    assert.ok(tomorrow);
    // 06:00 a 21:00 son 15 h = 900 min / 15 = 60 franjas.
    assert.equal(tomorrow.slots.length, 60);
    assert.equal(tomorrow.slots[0]?.label, '6:00 AM');
  });

  it('el sabado abre mas tarde, como dice el seed', () => {
    // Jueves 3 de septiembre -> el sabado es 2 dias despues.
    const days = buildPickupDays({
      hours: FREEHOLD_HOURS,
      closures: [],
      config: { ...CONFIG, max_days_ahead: 3 },
      timeZone: TZ,
      occupancy: [],
      now: new Date('2026-09-03T14:00:00Z'), // jueves
    });
    const saturday = days.find((d) => d.day === '2026-09-05');
    assert.ok(saturday);
    assert.equal(saturday.slots[0]?.label, '9:00 AM');
  });

  it('un dia sin horario no ofrece nada', () => {
    const days = build({ hours: FREEHOLD_HOURS.filter((h) => h.weekday !== 4) });
    const thursday = days.find((d) => d.day === '2026-09-03');
    assert.ok(thursday);
    assert.equal(thursday.slots.length, 0);
  });
});

describe('cierres puntuales', () => {
  const holiday: Closure = {
    starts_at: '2026-09-03T04:00:00Z', // todo el jueves en hora local
    ends_at: '2026-09-04T04:00:00Z',
    reason: 'Labor Day',
  };

  it('isClosedAt detecta el rango', () => {
    assert.equal(isClosedAt(new Date('2026-09-03T15:00:00Z'), [holiday]), true);
    assert.equal(isClosedAt(new Date('2026-09-02T15:00:00Z'), [holiday]), false);
    // El fin del rango es exclusivo.
    assert.equal(isClosedAt(new Date('2026-09-04T04:00:00Z'), [holiday]), false);
  });

  it('un feriado deja el dia sin franjas', () => {
    const days = build({ closures: [holiday] });
    const thursday = days.find((d) => d.day === '2026-09-03');
    assert.ok(thursday);
    assert.equal(thursday.slots.length, 0);
  });

  it('los otros dias siguen abiertos', () => {
    const days = build({ closures: [holiday] });
    assert.ok((days.find((d) => d.day === '2026-09-04')?.slots.length ?? 0) > 0);
  });

  it('un cierre con fechas corruptas se ignora en vez de cerrar la tienda', () => {
    const days = build({ closures: [{ starts_at: 'ayer', ends_at: 'manana' }] });
    assert.ok((days[0]?.slots.length ?? 0) > 0);
  });
});

describe('capacidad por franja', () => {
  it('descuenta los pedidos ya aceptados', () => {
    const target = zonedTimeToInstant({ year: 2026, month: 9, day: 2 }, 11, 0, TZ).toISOString();
    const days = build({ occupancy: [{ startsAt: target, count: 3 }] });
    const slot = days[0]?.slots.find((s) => s.startsAt === target);
    assert.ok(slot);
    assert.equal(slot.remaining, 5);
    assert.equal(slot.isFull, false);
  });

  it('una franja llena se marca, pero NO se esconde', () => {
    const target = zonedTimeToInstant({ year: 2026, month: 9, day: 2 }, 11, 0, TZ).toISOString();
    const days = build({ occupancy: [{ startsAt: target, count: 8 }] });
    const slot = days[0]?.slots.find((s) => s.startsAt === target);
    // Esconderla haria pensar que la tienda cierra antes de lo que cierra.
    assert.ok(slot, 'la franja llena tiene que seguir en la lista');
    assert.equal(slot.isFull, true);
    assert.equal(slot.remaining, 0);
  });

  it('mas pedidos que el tope no da capacidad negativa', () => {
    const target = zonedTimeToInstant({ year: 2026, month: 9, day: 2 }, 11, 0, TZ).toISOString();
    const days = build({ occupancy: [{ startsAt: target, count: 99 }] });
    assert.equal(days[0]?.slots.find((s) => s.startsAt === target)?.remaining, 0);
  });
});

describe('firstAvailableSlot y canOrderAsap', () => {
  it('la primera libre salta las llenas', () => {
    const first = zonedTimeToInstant({ year: 2026, month: 9, day: 2 }, 10, 15, TZ).toISOString();
    const days = build({ occupancy: [{ startsAt: first, count: 8 }] });
    assert.equal(firstAvailableSlot(days)?.label, '10:30 AM');
  });

  it('asap se apaga si la configuracion lo apaga', () => {
    const days = build();
    assert.equal(canOrderAsap(days, CONFIG), true);
    assert.equal(canOrderAsap(days, { ...CONFIG, asap_enabled: false }), false);
  });

  it('asap se apaga si lo primero libre ya es de otro dia', () => {
    // Casi cerrando: 20:50 local, no cabe ninguna franja mas hoy.
    const days = buildPickupDays({
      hours: FREEHOLD_HOURS,
      closures: [],
      config: CONFIG,
      timeZone: TZ,
      occupancy: [],
      now: new Date('2026-09-03T00:50:00Z'),
    });
    assert.equal(canOrderAsap(days, CONFIG), false);
  });
});

describe('validateChosenSlot', () => {
  it('acepta una franja libre', () => {
    const days = build();
    const slot = firstAvailableSlot(days);
    assert.ok(slot);
    assert.equal(validateChosenSlot(slot.startsAt, days, WEDNESDAY_10_03, CONFIG), null);
  });

  it('rechaza una que se lleno entre elegir y confirmar', () => {
    const target = zonedTimeToInstant({ year: 2026, month: 9, day: 2 }, 11, 0, TZ).toISOString();
    const days = build({ occupancy: [{ startsAt: target, count: 8 }] });
    assert.equal(validateChosenSlot(target, days, WEDNESDAY_10_03, CONFIG), 'full');
  });

  it('rechaza una que ya paso', () => {
    const days = build();
    const past = zonedTimeToInstant({ year: 2026, month: 9, day: 2 }, 8, 0, TZ).toISOString();
    assert.equal(validateChosenSlot(past, days, WEDNESDAY_10_03, CONFIG), 'too-soon');
  });

  it('rechaza una que no existe', () => {
    const days = build();
    const odd = zonedTimeToInstant({ year: 2026, month: 9, day: 2 }, 11, 7, TZ).toISOString();
    assert.equal(validateChosenSlot(odd, days, WEDNESDAY_10_03, CONFIG), 'not-found');
    assert.equal(validateChosenSlot('no es una fecha', days, WEDNESDAY_10_03, CONFIG), 'not-found');
  });
});

describe('daysWithSlots', () => {
  it('descarta los dias vacios', () => {
    const days = build({ hours: FREEHOLD_HOURS.filter((h) => h.weekday !== 4) });
    assert.equal(days.length, 3);
    assert.equal(daysWithSlots(days).length, 2);
  });
});
