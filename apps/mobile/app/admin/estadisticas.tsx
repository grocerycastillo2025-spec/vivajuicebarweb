/**
 * Panel · Estadísticas, para entender de un vistazo cómo va el negocio.
 *
 *  1. "En resumen": frases cortas (cuánto vendiste y si subió o bajó, tu
 *     mejor día, la hora pico, lo que más se vende, clientes nuevos).
 *  2. Cuatro números grandes con flecha ▲▼ contra el periodo anterior.
 *  3. Ventas por día (o pedidos por hora, en "Hoy") con línea de promedio.
 *  4. ¿Cuándo te piden? Mapa de calor día × hora.
 *  5. Lo más vendido · ¿Cómo pagan? · Tus clientes · Lealtad.
 *  6. Interés en la app: lo más consultado e historias más vistas.
 *
 * Sale de `business_stats` (0023) y `business_insights` (0033). Sin la
 * 0033 se ve lo de antes y un aviso de qué archivo correr.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MISSING_SQL_FILE } from '../../src/api/new-columns';
import { useAdmin } from '../../src/admin/admin-context';
import { adminLocale, getAdminLanguage } from '../../src/admin/language';
import { adminStrings } from '../../src/admin/strings';
import { AdminShell, Card, Notice, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import type { BrandColors } from '../../src/domain/branding';
import { dataError } from '../../src/domain/errors';
import {
  bestIndex,
  hourLabel,
  hourWindow,
  ordersByHour,
  peakHour,
  peakWeekday,
  percentChange,
  shares,
  type Change,
  type HeatCell,
} from '../../src/domain/insights';
import { formatMoney } from '../../src/domain/money';
import { dayKey } from '../../src/domain/pickup';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { getSupabase } from '../../src/supabase';
import { radius, spacing, type as typography } from '../../src/theme';

const t = adminStrings.stats;

type Range = '1' | '7' | '30' | '90';

interface Stats {
  orders: number;
  revenue_cents: number;
  customers: number;
  loyalty_visits: number;
  item_views: number;
  story_views: number;
  by_day: { day: string; orders: number; revenue_cents: number }[];
  top_sold: { name: string; quantity: number; revenue_cents: number }[];
  top_viewed: { name: string; views: number }[];
  top_stories: { id: string; name: string; media_url: string; media_type: string; views: number }[];
}

interface Insights {
  prev: { orders: number; revenue_cents: number; customers: number };
  new_customers: number;
  returning_customers: number;
  heat: HeatCell[];
  by_payment: { method: string; orders: number; revenue_cents: number }[];
  top_sold: { name: string; name_es: string | null; quantity: number; revenue_cents: number }[];
  top_viewed?: { name: string; name_es: string | null; views: number }[];
  loyalty_visits: number;
  rewards_given: number;
}

function shiftDay(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shortDay(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(adminLocale(), {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function longDay(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(adminLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function changeText(change: Change | null): string | null {
  if (change === null) return null;
  return change.dir === 'up' ? t.more(change.pct) : change.dir === 'down' ? t.less(-change.pct) : t.same;
}

// Colores de las formas de pago: distintos entre sí y legibles con texto
// oscuro al lado (la cifra va en tinta de texto, no en el color).
const PAY_COLORS = ['#1F6F4A', '#E07A1F', '#2F6FB0', '#8E5BB5', '#B23A48', '#6B7280', '#0F8B8D', '#C9A227'];

export default function AdminStatsScreen(): ReactNode {
  const { restaurantId, store, isOwner } = useAdmin();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [range, setRange] = useState<Range>('7');

  const load = useCallback(async () => {
    const to = dayKey(new Date(), store.timezone);
    const from = shiftDay(to, -(Number(range) - 1));
    const supabase = getSupabase();
    const args = { p_restaurant_id: restaurantId, p_from: from, p_to: to };
    const [base, extra] = await Promise.all([
      supabase.rpc('business_stats', args),
      supabase.rpc('business_insights', args),
    ]);
    if (base.error) throw dataError(base.error.message, base.error.code);
    const missing = extra.error?.code === 'PGRST202' || extra.error?.code === '42883';
    if (extra.error && !missing) throw dataError(extra.error.message, extra.error.code);
    return { stats: base.data as Stats, insights: missing ? null : (extra.data as Insights) };
  }, [range, restaurantId, store.timezone]);

  const { data, error, reload } = useAsync(load, [range, restaurantId]);

  if (!isOwner) {
    return (
      <AdminShell>
        <Notice tone="error" text={adminStrings.ownerOnly} />
      </AdminShell>
    );
  }

  const ranges = (
    <View style={styles.rangeRow}>
      {(['1', '7', '30', '90'] as const).map((r) => (
        <Pressable
          key={r}
          accessibilityRole="radio"
          accessibilityState={{ checked: range === r }}
          onPress={() => setRange(r)}
          style={[styles.rangeChip, range === r && styles.rangeChipOn]}
        >
          <Text style={[styles.rangeText, range === r && styles.rangeTextOn]}>{t.range[r]}</Text>
        </Pressable>
      ))}
    </View>
  );

  if (data === null && error !== null) {
    return (
      <AdminShell scroll={false}>
        {ranges}
        <DataState loading={false} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  // Mientras carga: la misma forma que la pantalla final (resumen, cuatro
  // números, gráfica), en gris. Así nada brinca cuando llegan los datos.
  if (data === null) {
    return (
      <AdminShell>
        {ranges}
        <View style={[styles.summary, styles.skeletonSummary]} accessibilityLabel={adminStrings.loading} />
        <View style={styles.kpis}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.kpi, styles.skeletonKpi]} />
          ))}
        </View>
        <View style={[styles.card, styles.skeletonChart]} />
      </AdminShell>
    );
  }

  const { stats, insights } = data;
  const ticket = stats.orders === 0 ? 0 : Math.round(stats.revenue_cents / stats.orders);
  const prev = insights?.prev ?? null;
  const prevTicket = prev === null || prev.orders === 0 ? 0 : Math.round(prev.revenue_cents / prev.orders);
  const salesChange = prev === null ? null : percentChange(stats.revenue_cents, prev.revenue_cents);
  const topSold = (insights?.top_sold ?? stats.top_sold.map((r) => ({ ...r, name_es: null }))).map((r) => ({
    ...r,
    label: (getAdminLanguage() === 'es' ? r.name_es : null) ?? r.name,
  }));

  return (
    <AdminShell>
      {ranges}
      {insights === null ? <Notice tone="info" text={t.missingSql(MISSING_SQL_FILE)} /> : null}

      <Summary stats={stats} insights={insights} topSold={topSold} salesChange={salesChange} styles={styles} colors={colors} />

      <View style={styles.kpis}>
        <Kpi icon="cash-outline" label={t.revenue} value={formatMoney(stats.revenue_cents)}
          change={prev === null ? null : salesChange} hint={t.vsPrevious[range] ?? ''} big styles={styles} colors={colors} />
        <Kpi icon="receipt-outline" label={t.orders} value={String(stats.orders)}
          change={prev === null ? null : percentChange(stats.orders, prev.orders)} hint={t.vsPrevious[range] ?? ''} styles={styles} colors={colors} />
        <Kpi icon="pricetag-outline" label={t.ticket} value={formatMoney(ticket)}
          change={prev === null ? null : percentChange(ticket, prevTicket)} hint={t.vsPrevious[range] ?? ''} styles={styles} colors={colors} />
        <Kpi icon="people-outline" label={t.customers} value={String(stats.customers)}
          change={prev === null ? null : percentChange(stats.customers, prev.customers)} hint={t.vsPrevious[range] ?? ''} styles={styles} colors={colors} />
      </View>

      {range === '1' && insights !== null ? (
        <Card title={t.salesByHour}>
          <HourChart heat={insights.heat} styles={styles} colors={colors} />
        </Card>
      ) : (
        <Card title={t.salesByDay}>
          <SalesChart days={stats.by_day} styles={styles} colors={colors} />
        </Card>
      )}

      {insights !== null && range !== '1' ? (
        <Card title={t.heatTitle}>
          <Text style={styles.hint}>{t.heatHint}</Text>
          <Heatmap heat={insights.heat} styles={styles} colors={colors} />
        </Card>
      ) : null}

      <View style={styles.columns}>
        <View style={styles.column}>
          <Card title={t.topSold}>
            <BarList
              rows={topSold.map((r) => ({
                key: r.name,
                label: r.label,
                value: r.quantity,
                detail: `${t.units(r.quantity)} · ${formatMoney(r.revenue_cents)}`,
              }))}
              styles={styles}
              colors={colors}
            />
          </Card>
        </View>
        {insights !== null ? (
          <View style={styles.column}>
            <Card title={t.payTitle}>
              <Payments rows={insights.by_payment} styles={styles} />
            </Card>
            <Card title={t.customersTitle}>
              <Split
                rows={[
                  { key: t.newCustomers, value: insights.new_customers, color: colors.accent },
                  { key: t.returning, value: insights.returning_customers, color: colors.primary },
                ]}
                styles={styles}
              />
            </Card>
            <Card title={t.loyaltyTitle}>
              <View style={styles.miniRow}>
                <Mini icon="qr-code-outline" label={t.visits} value={insights.loyalty_visits} styles={styles} colors={colors} />
                <Mini icon="gift-outline" label={t.rewardsGiven} value={insights.rewards_given} styles={styles} colors={colors} />
              </View>
            </Card>
          </View>
        ) : null}
      </View>

      <Card title={t.appTitle}>
        <View style={styles.miniRow}>
          <Mini icon="eye-outline" label={t.itemViews} value={stats.item_views} styles={styles} colors={colors} />
          <Mini icon="images-outline" label={t.storyViews} value={stats.story_views} styles={styles} colors={colors} />
        </View>
        <Text style={styles.subTitle}>{t.topViewed}</Text>
        <BarList
          rows={(insights?.top_viewed ?? stats.top_viewed.map((r) => ({ ...r, name_es: null }))).map((r) => ({
            key: r.name,
            label: (getAdminLanguage() === 'es' ? r.name_es : null) ?? r.name,
            value: r.views,
            detail: t.views(r.views),
          }))}
          styles={styles}
          colors={colors}
        />
        <Text style={styles.subTitle}>{t.topStories}</Text>
        {stats.top_stories.length === 0 ? <Text style={styles.empty}>{t.noData}</Text> : null}
        <View style={styles.storyRow}>
          {stats.top_stories.map((s, i) => (
            <View key={s.id} style={styles.storyCard}>
              <View style={styles.storyThumb}>
                {s.media_type === 'image' ? (
                  <Image source={{ uri: s.media_url }} style={styles.fill} contentFit="cover" />
                ) : (
                  <View style={[styles.fill, styles.videoThumb]}>
                    <Ionicons name="play-circle" size={30} color="#fff" />
                  </View>
                )}
                <View style={styles.rank}>
                  <Text style={styles.rankText}>{i + 1}</Text>
                </View>
              </View>
              <Text style={styles.storyName} numberOfLines={2}>
                {s.name}
              </Text>
              <Text style={styles.storyViews}>{t.views(s.views)}</Text>
            </View>
          ))}
        </View>
      </Card>

      <Text style={styles.hint}>{t.note}</Text>
    </AdminShell>
  );
}

type Styles = ReturnType<typeof createStyles> & ReturnType<typeof createAdminStyles>;

function Summary({
  stats,
  insights,
  topSold,
  salesChange,
  styles,
  colors,
}: {
  readonly stats: Stats;
  readonly insights: Insights | null;
  readonly topSold: readonly { label: string; quantity: number }[];
  readonly salesChange: Change | null;
  readonly styles: Styles;
  readonly colors: BrandColors;
}): ReactNode {
  const lines: { icon: keyof typeof Ionicons.glyphMap; text: string }[] = [];
  if (stats.orders === 0) {
    lines.push({ icon: 'hourglass-outline', text: t.sumNothing });
  } else {
    lines.push({
      icon: salesChange?.dir === 'down' ? 'trending-down' : 'trending-up',
      text: t.sumSales(formatMoney(stats.revenue_cents), changeText(salesChange)),
    });
    const best = bestIndex(stats.by_day.map((d) => d.revenue_cents));
    const bestDay = best === null ? undefined : stats.by_day[best];
    if (bestDay !== undefined && stats.by_day.length > 1) {
      lines.push({ icon: 'trophy-outline', text: t.sumBestDay(longDay(bestDay.day), formatMoney(bestDay.revenue_cents)) });
    }
    if (insights !== null) {
      const hour = peakHour(insights.heat);
      const dow = peakWeekday(insights.heat);
      if (hour !== null) {
        lines.push({
          icon: 'time-outline',
          text: t.sumPeak(
            `${hourLabel(hour, getAdminLanguage())} – ${hourLabel((hour + 1) % 24, getAdminLanguage())}`,
            stats.by_day.length >= 7 && dow !== null ? (t.weekdaysLong[dow] ?? null) : null,
          ),
        });
      }
    }
    const top = topSold[0];
    if (top !== undefined) lines.push({ icon: 'star-outline', text: t.sumTop(top.label, t.units(top.quantity)) });
    if (insights !== null) {
      lines.push({ icon: 'people-outline', text: t.sumCustomers(insights.new_customers, insights.returning_customers) });
    }
  }
  return (
    <View style={styles.summary} testID="resumen">
      <Text style={styles.summaryTitle}>{t.summary}</Text>
      {lines.map((line) => (
        <View key={line.text} style={styles.summaryLine}>
          <Ionicons name={line.icon} size={20} color={colors.onPrimary} />
          <Text style={styles.summaryText}>{line.text}</Text>
        </View>
      ))}
    </View>
  );
}

function Kpi({
  icon,
  label,
  value,
  change,
  hint,
  big = false,
  styles,
  colors,
}: {
  readonly icon: keyof typeof Ionicons.glyphMap;
  readonly label: string;
  readonly value: string;
  readonly change: Change | null;
  readonly hint: string;
  readonly big?: boolean;
  readonly styles: Styles;
  readonly colors: BrandColors;
}): ReactNode {
  const tone = change === null || change.dir === 'same' ? null : change.dir === 'up' ? colors.success : colors.danger;
  return (
    <View style={[styles.kpi, big && styles.kpiBig]}>
      <View style={styles.kpiHead}>
        <Ionicons name={icon} size={18} color={colors.textMuted} />
        <Text style={styles.kpiLabel}>{label}</Text>
      </View>
      <Text style={[styles.kpiValue, big && styles.kpiValueBig]}>{value}</Text>
      {change !== null ? (
        <View style={styles.kpiChangeRow}>
          <View style={[styles.kpiChange, { backgroundColor: tone ?? colors.border }]}>
            <Ionicons
              name={change.dir === 'up' ? 'arrow-up' : change.dir === 'down' ? 'arrow-down' : 'remove'}
              size={12}
              color={tone === null ? colors.text : '#FFFFFF'}
            />
            <Text style={[styles.kpiChangeText, tone === null && { color: colors.text }]}>{Math.abs(change.pct)}%</Text>
          </View>
          <Text style={styles.kpiHint}>{hint}</Text>
        </View>
      ) : null}
    </View>
  );
}

function SalesChart({
  days,
  styles,
  colors,
}: {
  readonly days: Stats['by_day'];
  readonly styles: Styles;
  readonly colors: BrandColors;
}): ReactNode {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.revenue_cents), 0);
  if (max === 0) return <Text style={styles.empty}>{t.noData}</Text>;

  const best = bestIndex(days.map((d) => d.revenue_cents)) ?? 0;
  const shown = hover ?? best;
  const point = days[shown];
  const avg = days.reduce((s, d) => s + d.revenue_cents, 0) / days.length;
  const every = Math.max(1, Math.ceil(days.length / 7));

  return (
    <View style={styles.chart}>
      {point !== undefined ? (
        <View style={styles.readout}>
          <Text style={styles.readoutValue}>{formatMoney(point.revenue_cents)}</Text>
          <Text style={styles.readoutHint}>
            {longDay(point.day)} · {t.ordersShort(point.orders)}
          </Text>
        </View>
      ) : null}
      <View style={styles.chartPlot}>
        <View style={[styles.avgLine, { bottom: `${(avg / max) * 100}%` }]} pointerEvents="none" />
        {days.map((d, i) => {
          const h = d.revenue_cents === 0 ? 0 : Math.max(3, (d.revenue_cents / max) * 100);
          return (
            <Pressable
              key={d.day}
              accessibilityLabel={`${shortDay(d.day)}: ${formatMoney(d.revenue_cents)}`}
              onHoverIn={() => setHover(i)}
              onHoverOut={() => setHover(null)}
              onPress={() => setHover(i)}
              style={styles.chartSlot}
            >
              <View
                style={[
                  styles.chartBar,
                  { height: `${h}%`, backgroundColor: i === shown ? colors.accent : colors.primary },
                ]}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.chartAxis}>
        {days.map((d, i) => (
          <Text key={d.day} style={styles.chartTick} numberOfLines={1}>
            {i % every === 0 || i === days.length - 1 ? shortDay(d.day) : ''}
          </Text>
        ))}
      </View>
      <View style={styles.legendRow}>
        <View style={styles.avgSwatch} />
        <Text style={styles.readoutHint}>{t.avgLine(formatMoney(Math.round(avg)))}</Text>
      </View>
    </View>
  );
}

function HourChart({
  heat,
  styles,
  colors,
}: {
  readonly heat: readonly HeatCell[];
  readonly styles: Styles;
  readonly colors: BrandColors;
}): ReactNode {
  const hours = ordersByHour(heat);
  const { from, to } = hourWindow(heat);
  const slice = hours.slice(from, to + 1);
  const max = Math.max(...slice, 0);
  if (max === 0) return <Text style={styles.empty}>{t.noData}</Text>;
  const peak = peakHour(heat);
  return (
    <View style={styles.chart}>
      <View style={styles.chartPlot}>
        {slice.map((n, i) => (
          <View key={from + i} style={styles.chartSlot} accessibilityLabel={`${hourLabel(from + i, getAdminLanguage())}: ${n}`}>
            {n > 0 ? <Text style={styles.barValue}>{n}</Text> : null}
            <View
              style={[
                styles.chartBar,
                { height: `${n === 0 ? 0 : Math.max(4, (n / max) * 85)}%` },
                { backgroundColor: from + i === peak ? colors.accent : colors.primary },
              ]}
            />
          </View>
        ))}
      </View>
      <View style={styles.chartAxis}>
        {slice.map((_, i) => (
          <Text key={from + i} style={styles.chartTick} numberOfLines={1}>
            {(from + i) % 3 === 0 ? hourLabel(from + i, getAdminLanguage()).replace(' ', ' ') : ''}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Heatmap({
  heat,
  styles,
  colors,
}: {
  readonly heat: readonly HeatCell[];
  readonly styles: Styles;
  readonly colors: BrandColors;
}): ReactNode {
  const { from, to } = hourWindow(heat);
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const max = Math.max(...heat.map((c) => c.orders), 0);
  if (max === 0) return <Text style={styles.empty}>{t.noData}</Text>;
  const value = (dow: number, hour: number): number =>
    heat.find((c) => c.dow === dow && c.hour === hour)?.orders ?? 0;

  return (
    <View style={styles.heat}>
      <View style={styles.heatRow}>
        <Text style={styles.heatDay} />
        {hours.map((h) => (
          <Text key={h} style={styles.heatHour} numberOfLines={1}>
            {h % 2 === 0 ? String(h % 12 === 0 ? 12 : h % 12) : ''}
          </Text>
        ))}
      </View>
      {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
        <View key={dow} style={styles.heatRow}>
          <Text style={styles.heatDay}>{t.weekdays[dow]}</Text>
          {hours.map((h) => {
            const n = value(dow, h);
            return (
              <View
                key={h}
                accessibilityLabel={`${t.weekdaysLong[dow]} ${hourLabel(h, getAdminLanguage())}: ${t.ordersShort(n)}`}
                style={[
                  styles.heatCell,
                  n > 0
                    ? { backgroundColor: colors.primary, opacity: 0.18 + 0.82 * (n / max) }
                    : { backgroundColor: colors.background },
                ]}
              />
            );
          })}
        </View>
      ))}
      <View style={styles.legendRow}>
        <Text style={styles.readoutHint}>{t.heatLess}</Text>
        {[0.2, 0.45, 0.7, 1].map((o) => (
          <View key={o} style={[styles.heatLegendCell, { backgroundColor: colors.primary, opacity: o }]} />
        ))}
        <Text style={styles.readoutHint}>{t.heatMore}</Text>
      </View>
    </View>
  );
}

function BarList({
  rows,
  styles,
  colors,
}: {
  readonly rows: { key: string; label: string; value: number; detail: string }[];
  readonly styles: Styles;
  readonly colors: BrandColors;
}): ReactNode {
  if (rows.length === 0) return <Text style={styles.empty}>{t.noData}</Text>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <View style={styles.barList}>
      {rows.map((row, i) => (
        <View key={row.key} style={styles.barRow}>
          <View style={styles.barHead}>
            <Text style={[styles.barRank, i === 0 && { color: colors.accent }]}>{i + 1}</Text>
            <Text style={styles.barLabel} numberOfLines={1}>
              {row.label}
            </Text>
            <Text style={styles.barDetail}>{row.detail}</Text>
          </View>
          <View style={styles.barTrack}>
            <View
              style={[
                styles.barFill,
                { width: `${(row.value / max) * 100}%`, backgroundColor: i === 0 ? colors.accent : colors.primary },
              ]}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

function Payments({ rows, styles }: { readonly rows: Insights['by_payment']; readonly styles: Styles }): ReactNode {
  if (rows.length === 0) return <Text style={styles.empty}>{t.noData}</Text>;
  const parts = shares(rows.map((r) => ({ key: r.method, value: r.revenue_cents })));
  return (
    <View style={styles.split}>
      <View style={styles.stack}>
        {parts.map((p, i) =>
          p.pct > 0 ? <View key={p.key} style={{ flex: p.pct, backgroundColor: PAY_COLORS[i % PAY_COLORS.length] }} /> : null,
        )}
      </View>
      {parts.map((p, i) => {
        const row = rows[i];
        return (
          <View key={p.key} style={styles.legendLine}>
            <View style={[styles.swatch, { backgroundColor: PAY_COLORS[i % PAY_COLORS.length] }]} />
            <Text style={styles.legendLabel}>{t.payMethods[p.key] ?? p.key}</Text>
            <Text style={styles.legendValue}>
              {p.pct}% · {formatMoney(row?.revenue_cents ?? 0)} · {t.ordersShort(row?.orders ?? 0)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function Split({
  rows,
  styles,
}: {
  readonly rows: { key: string; value: number; color: string }[];
  readonly styles: Styles;
}): ReactNode {
  const parts = shares(rows.map((r) => ({ key: r.key, value: r.value })));
  if (rows.every((r) => r.value === 0)) return <Text style={styles.empty}>{t.noData}</Text>;
  return (
    <View style={styles.split}>
      <View style={styles.stack}>
        {parts.map((p, i) => (p.pct > 0 ? <View key={p.key} style={{ flex: p.pct, backgroundColor: rows[i]?.color }} /> : null))}
      </View>
      {rows.map((r, i) => (
        <View key={r.key} style={styles.legendLine}>
          <View style={[styles.swatch, { backgroundColor: r.color }]} />
          <Text style={styles.legendLabel}>{r.key}</Text>
          <Text style={styles.legendValue}>
            {r.value} · {parts[i]?.pct ?? 0}%
          </Text>
        </View>
      ))}
    </View>
  );
}

function Mini({
  icon,
  label,
  value,
  styles,
  colors,
}: {
  readonly icon: keyof typeof Ionicons.glyphMap;
  readonly label: string;
  readonly value: number;
  readonly styles: Styles;
  readonly colors: BrandColors;
}): ReactNode {
  return (
    <View style={styles.mini}>
      <Ionicons name={icon} size={22} color={colors.primary} />
      <Text style={styles.miniValue}>{value}</Text>
      <Text style={styles.miniLabel}>{label}</Text>
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    rangeRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    rangeChip: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
    },
    rangeChipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    rangeText: { color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize },
    rangeTextOn: { color: colors.onPrimary },

    summary: { backgroundColor: colors.primary, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.sm },
    skeletonSummary: { minHeight: 196, opacity: 0.25 },
    skeletonKpi: { minHeight: 132, backgroundColor: colors.border, borderColor: colors.border, opacity: 0.5 },
    skeletonChart: { minHeight: 300, opacity: 0.6 },
    summaryTitle: {
      color: colors.onPrimary,
      fontSize: typography.caption.fontSize,
      fontWeight: '800',
      letterSpacing: 1,
      textTransform: 'uppercase',
      opacity: 0.85,
    },
    summaryLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    summaryText: { flex: 1, color: colors.onPrimary, fontSize: typography.body.fontSize, fontWeight: '600', lineHeight: 22 },

    kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    kpi: {
      flexGrow: 1,
      flexBasis: 170,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      gap: 6,
    },
    kpiBig: { borderColor: colors.primary, borderWidth: 2 },
    kpiHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    kpiLabel: { color: colors.textMuted, fontSize: typography.label.fontSize, fontWeight: '700' },
    kpiValue: { color: colors.text, fontSize: 28, fontWeight: '800' },
    kpiValueBig: { fontSize: 32 },
    kpiChangeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
    kpiChange: { flexDirection: 'row', alignItems: 'center', gap: 2, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
    kpiChangeText: { color: '#FFFFFF', fontSize: typography.caption.fontSize, fontWeight: '800' },
    kpiHint: { color: colors.textFaint, fontSize: typography.caption.fontSize },

    chart: { gap: spacing.sm },
    readout: { gap: 2 },
    readoutValue: { color: colors.text, fontSize: 22, fontWeight: '800' },
    readoutHint: { color: colors.textMuted, fontSize: typography.caption.fontSize + 1 },
    chartPlot: {
      height: 200,
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 3,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    chartSlot: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center', minWidth: 0 },
    chartBar: { width: '100%', maxWidth: 40, borderTopLeftRadius: 5, borderTopRightRadius: 5 },
    barValue: { color: colors.text, fontSize: 11, fontWeight: '700', marginBottom: 2 },
    avgLine: {
      position: 'absolute',
      left: 0,
      right: 0,
      borderTopWidth: 2,
      borderStyle: 'dashed',
      borderTopColor: colors.textMuted,
      zIndex: 1,
    },
    avgSwatch: { width: 18, borderTopWidth: 2, borderStyle: 'dashed', borderTopColor: colors.textMuted },
    chartAxis: { flexDirection: 'row', gap: 3 },
    chartTick: { flex: 1, minWidth: 0, color: colors.textFaint, fontSize: 10, textAlign: 'center' },
    legendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    empty: { color: colors.textFaint, fontSize: typography.label.fontSize, paddingVertical: spacing.md },

    heat: { gap: 3 },
    heatRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    heatDay: { width: 34, color: colors.textMuted, fontSize: 11, fontWeight: '700' },
    heatHour: { flex: 1, minWidth: 0, color: colors.textFaint, fontSize: 10, textAlign: 'center' },
    heatCell: { flex: 1, minWidth: 0, aspectRatio: 1, maxHeight: 34, borderRadius: 4 },
    heatLegendCell: { width: 16, height: 16, borderRadius: 4 },

    columns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
    column: { flexGrow: 1, flexBasis: 320, minWidth: 0, gap: spacing.lg },
    subTitle: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '800', marginTop: spacing.sm },
    barList: { gap: spacing.md },
    barRow: { gap: 4 },
    barHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    barRank: { width: 18, color: colors.textFaint, fontWeight: '800', fontSize: typography.label.fontSize },
    barLabel: { flex: 1, minWidth: 0, color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize + 1 },
    barDetail: { color: colors.textMuted, fontSize: typography.caption.fontSize, flexShrink: 0 },
    barTrack: { height: 12, marginLeft: 26, borderRadius: 6, backgroundColor: colors.background, overflow: 'hidden' },
    barFill: { height: 12, borderRadius: 6 },

    split: { gap: spacing.sm },
    stack: { flexDirection: 'row', height: 22, borderRadius: 11, overflow: 'hidden', backgroundColor: colors.background },
    legendLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    swatch: { width: 12, height: 12, borderRadius: 3 },
    legendLabel: { flex: 1, color: colors.text, fontSize: typography.label.fontSize, fontWeight: '700' },
    legendValue: { color: colors.textMuted, fontSize: typography.caption.fontSize + 1 },

    miniRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    mini: {
      flexGrow: 1,
      flexBasis: 130,
      alignItems: 'flex-start',
      gap: 2,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.background,
    },
    miniValue: { color: colors.text, fontSize: 24, fontWeight: '800' },
    miniLabel: { color: colors.textMuted, fontSize: typography.label.fontSize, fontWeight: '600' },

    storyRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    storyCard: { width: 110, gap: 4 },
    storyThumb: { width: 110, height: 170, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.background },
    fill: { width: '100%', height: '100%' },
    videoThumb: { backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
    rank: {
      position: 'absolute',
      top: 6,
      left: 6,
      width: 24,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rankText: { color: colors.onPrimary, fontWeight: '800', fontSize: 12 },
    storyName: { color: colors.text, fontSize: typography.caption.fontSize + 1, fontWeight: '600' },
    storyViews: { color: colors.textMuted, fontSize: typography.caption.fontSize },
  });
}
