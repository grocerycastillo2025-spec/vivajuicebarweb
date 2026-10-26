/**
 * Panel · Estadisticas.
 *
 * Todo sale de `business_stats` (0023) en un solo viaje:
 *   - tarjetas: ventas, pedidos, ticket promedio, clientes, consultas,
 *     vistas de historias, visitas con QR;
 *   - ventas por dia (barras);
 *   - lo mas vendido, lo mas consultado y las historias mas vistas
 *     (barras horizontales, ordenadas).
 *
 * Una sola serie por grafica: un color (el principal de la marca), sin
 * leyenda; el titulo dice que es. Los numeros van en tinta de texto, no
 * del color de la barra. Al pasar el cursor por una barra de ventas se
 * ve el dia y el importe.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAdmin } from '../../src/admin/admin-context';
import { adminStrings } from '../../src/admin/strings';
import { AdminShell, Card, Notice, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import type { BrandColors } from '../../src/domain/branding';
import { dataError } from '../../src/domain/errors';
import { formatMoney, moneyDefaults } from '../../src/domain/money';
import { dayKey } from '../../src/domain/pickup';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { getSupabase } from '../../src/supabase';
import { radius, spacing, type as typography } from '../../src/theme';

const t = adminStrings.stats;

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

function shiftDay(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shortDay(key: string): string {
  return new Date(`${key}T12:00:00Z`).toLocaleDateString(moneyDefaults().locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export default function AdminStatsScreen(): ReactNode {
  const { restaurantId, store, isOwner } = useAdmin();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const [range, setRange] = useState<'7' | '30' | '90'>('7');

  const load = useCallback(async (): Promise<Stats> => {
    const to = dayKey(new Date(), store.timezone);
    const from = shiftDay(to, -(Number(range) - 1));
    const { data, error } = await getSupabase().rpc('business_stats', {
      p_restaurant_id: restaurantId,
      p_from: from,
      p_to: to,
    });
    if (error) throw dataError(error.message, error.code);
    return data as Stats;
  }, [range, restaurantId, store.timezone]);

  const { data, error, loading, reload } = useAsync(load, [range, restaurantId]);

  if (!isOwner) {
    return (
      <AdminShell>
        <Notice tone="error" text={adminStrings.ownerOnly} />
      </AdminShell>
    );
  }

  const ranges = (
    <View style={styles.rangeRow}>
      {(['7', '30', '90'] as const).map((r) => (
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

  if (data === null) {
    return (
      <AdminShell scroll={false}>
        {ranges}
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  const ticket = data.orders === 0 ? 0 : Math.round(data.revenue_cents / data.orders);

  return (
    <AdminShell>
      {ranges}

      <View style={styles.kpis}>
        <Kpi icon="cash-outline" label={t.revenue} value={formatMoney(data.revenue_cents)} big colors={colors} />
        <Kpi icon="receipt-outline" label={t.orders} value={String(data.orders)} colors={colors} />
        <Kpi icon="pricetag-outline" label={t.ticket} value={formatMoney(ticket)} colors={colors} />
        <Kpi icon="people-outline" label={t.customers} value={String(data.customers)} colors={colors} />
        <Kpi icon="eye-outline" label={t.itemViews} value={String(data.item_views)} colors={colors} />
        <Kpi icon="images-outline" label={t.storyViews} value={String(data.story_views)} colors={colors} />
        <Kpi icon="qr-code-outline" label={t.visits} value={String(data.loyalty_visits)} colors={colors} />
      </View>

      <Card title={t.salesByDay}>
        <SalesChart days={data.by_day} colors={colors} />
      </Card>

      <View style={styles.columns}>
        <View style={styles.column}>
          <Card title={t.topSold}>
            <BarList
              rows={data.top_sold.map((r) => ({
                key: r.name,
                label: r.name,
                value: r.quantity,
                detail: `${t.units(r.quantity)} · ${formatMoney(r.revenue_cents)}`,
              }))}
              colors={colors}
            />
          </Card>
        </View>
        <View style={styles.column}>
          <Card title={t.topViewed}>
            <BarList
              rows={data.top_viewed.map((r) => ({ key: r.name, label: r.name, value: r.views, detail: t.views(r.views) }))}
              colors={colors}
            />
          </Card>
        </View>
      </View>

      <Card title={t.topStories}>
        {data.top_stories.length === 0 ? <Text style={styles.hint}>{t.noData}</Text> : null}
        <View style={styles.storyRow}>
          {data.top_stories.map((s, i) => (
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
              <Text style={styles.storyViews}>
                <Ionicons name="eye-outline" size={12} color={colors.textMuted} /> {t.views(s.views)}
              </Text>
            </View>
          ))}
        </View>
      </Card>

      <Text style={styles.hint}>{t.note}</Text>
    </AdminShell>
  );
}

function Kpi({
  icon,
  label,
  value,
  big = false,
  colors,
}: {
  readonly icon: keyof typeof Ionicons.glyphMap;
  readonly label: string;
  readonly value: string;
  readonly big?: boolean;
  readonly colors: BrandColors;
}): ReactNode {
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={[styles.kpi, big && styles.kpiBig]}>
      <View style={[styles.kpiIcon, big && styles.kpiIconBig]}>
        <Ionicons name={icon} size={20} color={big ? colors.onPrimary : colors.primary} />
      </View>
      <Text style={[styles.kpiValue, big && styles.kpiValueBig]}>{value}</Text>
      <Text style={[styles.kpiLabel, big && styles.kpiLabelBig]}>{label}</Text>
    </View>
  );
}

function SalesChart({
  days,
  colors,
}: {
  readonly days: Stats['by_day'];
  readonly colors: BrandColors;
}): ReactNode {
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...days.map((d) => d.revenue_cents), 0);

  if (max === 0) return <Text style={styles.empty}>{t.noData}</Text>;

  const best = days.reduce((a, b, i) => (b.revenue_cents > (days[a]?.revenue_cents ?? 0) ? i : a), 0);
  const shown = hover ?? best;
  const point = days[shown];
  // Pocas etiquetas en el eje: la primera, la ultima y algunas en medio.
  const every = Math.max(1, Math.ceil(days.length / 7));

  return (
    <View style={styles.chart}>
      {point !== undefined ? (
        <Text style={styles.chartReadout}>
          {shortDay(point.day)} · {formatMoney(point.revenue_cents)} · {point.orders} {t.orders.toLowerCase()}
        </Text>
      ) : null}
      <View style={styles.chartPlot}>
        {days.map((d, i) => {
          const h = d.revenue_cents === 0 ? 0 : Math.max(4, (d.revenue_cents / max) * 100);
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
                  { height: `${h}%`, backgroundColor: colors.primary },
                  shown === i && styles.chartBarOn,
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
    </View>
  );
}

function BarList({
  rows,
  colors,
}: {
  readonly rows: { key: string; label: string; value: number; detail: string }[];
  readonly colors: BrandColors;
}): ReactNode {
  const styles = useMemo(() => createStyles(colors), [colors]);
  if (rows.length === 0) return <Text style={styles.empty}>{t.noData}</Text>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <View style={styles.barList}>
      {rows.map((row, i) => (
        <View key={row.key} style={styles.barRow}>
          <View style={styles.barHead}>
            <Text style={styles.barRank}>{i + 1}</Text>
            <Text style={styles.barLabel} numberOfLines={1}>
              {row.label}
            </Text>
            <Text style={styles.barDetail}>{row.detail}</Text>
          </View>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${(row.value / max) * 100}%`, backgroundColor: colors.primary }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    rangeRow: { flexDirection: 'row', gap: spacing.sm },
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

    kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    kpi: {
      flexGrow: 1,
      flexBasis: 140,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      gap: 4,
    },
    kpiBig: { backgroundColor: colors.primary, borderColor: colors.primary, flexBasis: 220 },
    kpiIcon: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
      marginBottom: 4,
    },
    kpiIconBig: { backgroundColor: 'rgba(255,255,255,0.2)' },
    kpiValue: { color: colors.text, fontSize: 24, fontWeight: '800' },
    kpiValueBig: { color: colors.onPrimary, fontSize: 30 },
    kpiLabel: { color: colors.textMuted, fontSize: typography.label.fontSize, fontWeight: '600' },
    kpiLabelBig: { color: colors.onPrimary, opacity: 0.9 },

    chart: { gap: spacing.sm },
    chartReadout: { color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize },
    chartPlot: {
      height: 180,
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 2,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    chartSlot: { flex: 1, height: '100%', justifyContent: 'flex-end', minWidth: 0 },
    chartBar: { width: '100%', maxWidth: 36, alignSelf: 'center', borderTopLeftRadius: 4, borderTopRightRadius: 4, opacity: 0.75 },
    chartBarOn: { opacity: 1 },
    chartAxis: { flexDirection: 'row', gap: 2 },
    chartTick: { flex: 1, minWidth: 0, color: colors.textFaint, fontSize: 10, textAlign: 'center' },
    empty: { color: colors.textFaint, fontSize: typography.label.fontSize, paddingVertical: spacing.md },

    columns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
    column: { flexGrow: 1, flexBasis: 320, minWidth: 0 },
    barList: { gap: spacing.md },
    barRow: { gap: 4 },
    barHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    barRank: { width: 18, color: colors.textFaint, fontWeight: '800', fontSize: typography.label.fontSize },
    barLabel: { flex: 1, minWidth: 0, color: colors.text, fontWeight: '700', fontSize: typography.label.fontSize + 1 },
    barDetail: { color: colors.textMuted, fontSize: typography.caption.fontSize, flexShrink: 0 },
    barTrack: { height: 10, marginLeft: 26, borderRadius: 5, backgroundColor: colors.background, overflow: 'hidden' },
    barFill: { height: 10, borderRadius: 5 },

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
