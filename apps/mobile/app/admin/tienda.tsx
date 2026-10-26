/**
 * Panel · Tienda: lo del día a día en el mostrador, para el dueño y para el
 * rol Tienda (0031), sin poder administrar.
 *
 *  - Recibir pedidos / pausar (stores.pickup_enabled).
 *  - Agotar y encender productos y opciones.
 *  - Últimos cambios: quién apagó qué y cuándo.
 *
 * Cada interruptor cambia al instante en pantalla y se guarda con una
 * función de la base (`set_item_available`, `set_modifier_available`,
 * `set_store_accepting_orders`). Si la base lo rechaza, vuelve a su estado
 * y lo dice.
 */

import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  fetchFloor,
  fetchStoreActivity,
  setAcceptingOrders,
  setItemAvailable,
  setOptionAvailable,
  type FloorData,
  type StoreActivity,
} from '../../src/api/admin';
import { useAdmin } from '../../src/admin/admin-context';
import { adminLocale, getAdminLanguage } from '../../src/admin/language';
import { adminStrings } from '../../src/admin/strings';
import { AdminShell, Card, Notice, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { itemsUsing, sameOptionElsewhere } from '../../src/domain/ingredients';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { radius, spacing, type as typography } from '../../src/theme';

const t = adminStrings.floor;

// Qué se apagó junto con cada opción ("Naranja" → Viva Juice, Anti Flu…),
// para que al volver a encenderla se sugiera re-encender ESO y no lo que
// estaba apagado por otra razón. Vive en este navegador.
type CascadeMemory = Record<string, string[]>;
function readMemory(storeId: string): CascadeMemory {
  try {
    const raw = globalThis.localStorage?.getItem(`juicebar.cascada.${storeId}`);
    return raw ? (JSON.parse(raw) as CascadeMemory) : {};
  } catch {
    return {};
  }
}
function writeMemory(storeId: string, memory: CascadeMemory): void {
  try {
    globalThis.localStorage?.setItem(`juicebar.cascada.${storeId}`, JSON.stringify(memory));
  } catch {
    // navegador privado: solo no se recuerda
  }
}

/** Sin acentos ni mayúsculas, para buscar "pina" y encontrar "Piña". */
function plain(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export default function AdminStoreScreen(): ReactNode {
  const { store, restaurantId, reloadStore } = useAdmin();
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);

  const load = useCallback(async () => {
    const [floor, activity] = await Promise.all([fetchFloor(store.id, getAdminLanguage()), fetchStoreActivity(restaurantId)]);
    return { floor, activity };
  }, [store.id, restaurantId]);
  const { data, error, loading, reload, refresh } = useAsync(load, [store.id]);

  // Lo que se cambió en esta pantalla, encima de lo leído.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  // Al apagar/encender una opción: qué más se sugiere cambiar (ingredientes).
  const [cascade, setCascade] = useState<{
    optionId: string;
    optionName: string;
    next: boolean;
    items: { id: string; name: string }[];
    options: { id: string; name: string; group: string }[];
    picked: Record<string, boolean>;
  } | null>(null);
  const [accepting, setAccepting] = useState<boolean>(store.pickup_enabled !== false);
  const [confirmingPause, setConfirmingPause] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const flip = async (key: string, next: boolean, save: () => Promise<void>): Promise<void> => {
    setFailure(null);
    setOverrides((o) => ({ ...o, [key]: next }));
    try {
      await save();
      refresh();
    } catch (cause) {
      setOverrides((o) => ({ ...o, [key]: !next }));
      setFailure(cause instanceof Error && cause.message.includes('.sql') ? cause.message : t.failed);
    }
  };

  const availableNow = (key: string, base: boolean): boolean => overrides[key] ?? base;

  const flipOption = (id: string, next: boolean): void => {
    void flip(`m:${id}`, next, () => setOptionAvailable(id, next));
    if (data === null) return;
    const option = data.floor.options.find((o) => o.id === id);
    if (option === undefined) return;
    const itemIds = new Set(itemsUsing(option, data.floor.items));
    const optionIds = new Set(sameOptionElsewhere(option, data.floor.options));
    // Solo lo que de verdad cambiaría (apagar lo encendido / encender lo apagado).
    const items = data.floor.items
      .filter((i) => itemIds.has(i.id) && availableNow(`i:${i.id}`, i.available) !== next)
      .map((i) => ({ id: i.id, name: i.name }));
    const options = data.floor.options
      .filter((o) => optionIds.has(o.id) && availableNow(`m:${o.id}`, o.available) !== next)
      .map((o) => ({ id: o.id, name: o.name, group: o.groupName }));
    if (items.length === 0 && options.length === 0) return;
    // Al apagar se marca todo; al encender, solo lo que se apagó junto con esta opción.
    const remembered = new Set(readMemory(store.id)[id] ?? []);
    const picked: Record<string, boolean> = {};
    for (const i of items) picked[`i:${i.id}`] = !next || remembered.has(`i:${i.id}`);
    for (const o of options) picked[`m:${o.id}`] = !next || remembered.has(`m:${o.id}`);
    setCascade({ optionId: id, optionName: option.name, next, items, options, picked });
  };

  const applyCascade = (): void => {
    if (cascade === null) return;
    const { next, picked, optionId } = cascade;
    const memory = readMemory(store.id);
    if (next) delete memory[optionId];
    else memory[optionId] = Object.entries(picked).filter(([, on]) => on).map(([key]) => key);
    writeMemory(store.id, memory);
    for (const [key, on] of Object.entries(picked)) {
      if (!on) continue;
      const id = key.slice(2);
      void flip(key, next, () => (key.startsWith('i:') ? setItemAvailable(id, next) : setOptionAvailable(id, next)));
    }
    setCascade(null);
  };

  // Cancelar = "me equivoqué": la opción vuelve como estaba y no se toca nada más.
  const cancelCascade = (): void => {
    if (cascade === null) return;
    const { optionId, next } = cascade;
    void flip(`m:${optionId}`, !next, () => setOptionAvailable(optionId, !next));
    setCascade(null);
  };

  const changeAccepting = async (next: boolean): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await setAcceptingOrders(store.id, next);
      setAccepting(next);
      setConfirmingPause(false);
      reloadStore();
      refresh();
    } catch (cause) {
      setFailure(cause instanceof Error && cause.message.includes('.sql') ? cause.message : t.failed);
    } finally {
      setBusy(false);
    }
  };

  if (data === null) {
    return (
      <AdminShell scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      {failure !== null ? <Notice tone="error" text={failure} /> : null}

      <View style={[styles.statusCard, accepting ? styles.statusOn : styles.statusOff]} testID="estado-tienda">
        <Ionicons name={accepting ? 'storefront' : 'pause-circle'} size={30} color={colors.onPrimary} />
        <View style={styles.statusText}>
          <Text style={styles.statusTitle}>{accepting ? t.accepting : t.paused}</Text>
          <Text style={styles.statusHint}>{accepting ? t.acceptingHint : t.pausedHint}</Text>
        </View>
        {accepting ? (
          confirmingPause ? null : (
            <Button label={t.pause} variant="outline" onPress={() => setConfirmingPause(true)} style={styles.statusButton} />
          )
        ) : (
          <Button label={t.resume} variant="accent" busy={busy} onPress={() => void changeAccepting(true)} />
        )}
      </View>
      {confirmingPause ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>{t.confirmPause}</Text>
          <View style={styles.confirmRow}>
            <Button label={t.confirm} busy={busy} onPress={() => void changeAccepting(false)} />
            <Button label={adminStrings.cancel} variant="outline" onPress={() => setConfirmingPause(false)} />
          </View>
        </View>
      ) : null}

      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t.search}
        placeholderTextColor={colors.textFaint}
        accessibilityLabel={t.search}
        style={styles.input}
      />

      <View style={styles.columns}>
        <View style={styles.column}>
          <Products data={data.floor} overrides={overrides} query={query} styles={styles}
            onFlip={(id, next) => void flip(`i:${id}`, next, () => setItemAvailable(id, next))} />
        </View>
        <View style={styles.column}>
          <Options data={data.floor} overrides={overrides} query={query} styles={styles}
            onFlip={flipOption} />
          <Activity rows={data.activity} styles={styles} />
        </View>
      </View>

      <Modal visible={cascade !== null} transparent animationType="fade" onRequestClose={cancelCascade}>
        <View style={styles.backdrop}>
          {cascade !== null ? (
            <View style={styles.sheet} testID="cascada">
              <View style={styles.sheetHead}>
                <Text style={[styles.sheetTitle, styles.grow]}>
                  {cascade.next ? t.cascadeOnTitle(cascade.optionName) : t.cascadeOffTitle(cascade.optionName)}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={adminStrings.cancel}
                  onPress={cancelCascade}
                  hitSlop={12}
                  style={styles.closeX}
                  testID="cascada-x"
                >
                  <Ionicons name="close" size={26} color={colors.textMuted} />
                </Pressable>
              </View>
              <Text style={styles.hint}>{t.cascadeHint}</Text>
              <ScrollView style={styles.sheetList}>
                {cascade.items.length > 0 ? <Text style={styles.groupTitle}>{t.products}</Text> : null}
                {cascade.items.map((i) => (
                  <Check key={i.id} label={i.name} checked={cascade.picked[`i:${i.id}`] === true} styles={styles}
                    onToggle={() => setCascade({ ...cascade, picked: { ...cascade.picked, [`i:${i.id}`]: !cascade.picked[`i:${i.id}`] } })} />
                ))}
                {cascade.options.length > 0 ? <Text style={styles.groupTitle}>{t.cascadeOptions}</Text> : null}
                {cascade.options.map((o) => (
                  <Check key={o.id} label={`${o.name} · ${o.group}`} checked={cascade.picked[`m:${o.id}`] === true} styles={styles}
                    onToggle={() => setCascade({ ...cascade, picked: { ...cascade.picked, [`m:${o.id}`]: !cascade.picked[`m:${o.id}`] } })} />
                ))}
              </ScrollView>
              <View style={styles.sheetActions}>
                <Button
                  label={(cascade.next ? t.cascadeOnYes : t.cascadeOffYes)(Object.values(cascade.picked).filter(Boolean).length)}
                  disabled={!Object.values(cascade.picked).some(Boolean)}
                  onPress={applyCascade}
                  testID="cascada-si"
                />
                <Button
                  label={t.cascadeOnlyThis}
                  variant="outline"
                  onPress={() => {
                    if (cascade.next) {
                      const memory = readMemory(store.id);
                      delete memory[cascade.optionId];
                      writeMemory(store.id, memory);
                    }
                    setCascade(null);
                  }}
                  testID="cascada-no"
                />
                <Pressable accessibilityRole="button" onPress={cancelCascade} style={styles.cancelLink} testID="cascada-cancelar">
                  <Text style={styles.cancelText}>{t.cascadeCancel(cascade.optionName, cascade.next)}</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      </Modal>
    </AdminShell>
  );
}

type Styles = ReturnType<typeof createStyles> & ReturnType<typeof createAdminStyles>;

function Check({
  label,
  checked,
  onToggle,
  styles,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly styles: Styles;
}): ReactNode {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={label} onPress={onToggle} style={styles.checkRow}>
      <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={24} color={checked ? colors.primary : colors.textMuted} />
      <Text style={styles.rowName}>{label}</Text>
    </Pressable>
  );
}

function Row({
  name,
  available,
  onChange,
  styles,
}: {
  readonly name: string;
  readonly available: boolean;
  readonly onChange: (next: boolean) => void;
  readonly styles: Styles;
}): ReactNode {
  const colors = useColors();
  return (
    <Pressable
      onPress={() => onChange(!available)}
      accessibilityRole="switch"
      accessibilityState={{ checked: available }}
      accessibilityLabel={`${name}: ${available ? t.available : t.soldOut}`}
      style={styles.row}
    >
      <Text style={[styles.rowName, !available && styles.rowNameOff]} numberOfLines={2}>
        {name}
      </Text>
      {!available ? <Text style={styles.soldOutTag}>{t.soldOut}</Text> : null}
      <Switch
        value={available}
        onValueChange={onChange}
        trackColor={{ false: colors.danger, true: colors.primary }}
        thumbColor="#FFFFFF"
        {...({ activeThumbColor: '#FFFFFF' } as object)}
      />
    </Pressable>
  );
}

function Products({
  data,
  overrides,
  query,
  styles,
  onFlip,
}: {
  readonly data: FloorData;
  readonly overrides: Readonly<Record<string, boolean>>;
  readonly query: string;
  readonly styles: Styles;
  readonly onFlip: (id: string, next: boolean) => void;
}): ReactNode {
  const q = plain(query.trim());
  const items = data.items
    .map((item) => ({ ...item, available: overrides[`i:${item.id}`] ?? item.available }))
    .filter((item) => q === '' || plain(item.name).includes(q));
  const off = items.filter((item) => !item.available).length;
  const groups = [...data.categories, { id: null, name: t.noCategory, sort: Number.MAX_SAFE_INTEGER }]
    .map((c) => ({ ...c, items: items.filter((item) => item.categoryId === c.id) }))
    .filter((c) => c.items.length > 0);

  return (
    <Card title={t.products} right={off > 0 ? <Text style={styles.offCount}>{t.soldOutCount(off)}</Text> : undefined}>
      <Text style={styles.hint}>{t.productsHint}</Text>
      {groups.map((group) => (
        <View key={group.id ?? 'none'} style={styles.group}>
          <Text style={styles.groupTitle}>{group.name}</Text>
          {group.items.map((item) => (
            <Row key={item.id} name={item.name} available={item.available} styles={styles}
              onChange={(next) => onFlip(item.id, next)} />
          ))}
        </View>
      ))}
    </Card>
  );
}

function Options({
  data,
  overrides,
  query,
  styles,
  onFlip,
}: {
  readonly data: FloorData;
  readonly overrides: Readonly<Record<string, boolean>>;
  readonly query: string;
  readonly styles: Styles;
  readonly onFlip: (id: string, next: boolean) => void;
}): ReactNode {
  const q = plain(query.trim());
  const options = data.options
    .map((o) => ({ ...o, available: overrides[`m:${o.id}`] ?? o.available }))
    .filter((o) => q === '' || plain(o.name).includes(q) || plain(o.groupName).includes(q));
  const groupNames = [...new Set(options.map((o) => o.groupName))];
  return (
    <Card title={t.options}>
      <Text style={styles.hint}>{t.optionsHint}</Text>
      {groupNames.map((name) => (
        <View key={name} style={styles.group}>
          <Text style={styles.groupTitle}>{name}</Text>
          {options
            .filter((o) => o.groupName === name)
            .map((o) => (
              <Row key={o.id} name={o.name} available={o.available} styles={styles} onChange={(next) => onFlip(o.id, next)} />
            ))}
        </View>
      ))}
    </Card>
  );
}

function Activity({ rows, styles }: { readonly rows: readonly StoreActivity[]; readonly styles: Styles }): ReactNode {
  return (
    <Card title={t.activity}>
      {rows.length === 0 ? <Text style={styles.hint}>{t.activityEmpty}</Text> : null}
      {rows.map((row, i) => (
        <Text key={`${row.created_at}-${i}`} style={styles.activityRow}>
          <Text style={styles.activityWhen}>
            {new Date(row.created_at).toLocaleString(adminLocale(), {
              weekday: 'short', hour: 'numeric', minute: '2-digit',
            })}
          </Text>
          {'  '}
          {row.who ?? '—'} {t.actions[row.action] ?? row.action}
          {row.entity_name !== null ? ` ${row.entity_name}` : ''}
        </Text>
      ))}
    </Card>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    statusCard: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.md,
      padding: spacing.lg,
      borderRadius: radius.lg,
    },
    statusOn: { backgroundColor: colors.primary },
    statusOff: { backgroundColor: colors.danger },
    statusText: { flex: 1, minWidth: 200, gap: 2 },
    statusTitle: { color: colors.onPrimary, fontSize: typography.title.fontSize, fontWeight: '800' },
    statusHint: { color: colors.onPrimary, opacity: 0.9, fontSize: typography.label.fontSize },
    statusButton: { backgroundColor: colors.surface },
    confirm: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.danger,
      backgroundColor: colors.surface,
    },
    confirmText: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '600' },
    confirmRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    columns: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
    column: { flexGrow: 1, flexBasis: 340, minWidth: 0, gap: spacing.lg },
    group: { gap: 2, marginTop: spacing.sm },
    groupTitle: { color: colors.textMuted, fontSize: typography.caption.fontSize, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.6 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 48,
      paddingVertical: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    rowName: { flex: 1, color: colors.text, fontSize: typography.body.fontSize, fontWeight: '600' },
    rowNameOff: { color: colors.textMuted, textDecorationLine: 'line-through' },
    soldOutTag: { color: colors.danger, fontSize: typography.caption.fontSize, fontWeight: '800' },
    offCount: { color: colors.danger, fontSize: typography.label.fontSize, fontWeight: '800' },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
    sheet: {
      width: '100%',
      maxWidth: 520,
      maxHeight: '90%',
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    grow: { flex: 1, minWidth: 0 },
    closeX: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', marginTop: -6, marginRight: -8 },
    cancelLink: { alignItems: 'center', paddingVertical: spacing.sm, minHeight: 44, justifyContent: 'center' },
    cancelText: { color: colors.textMuted, fontSize: typography.body.fontSize, fontWeight: '700', textDecorationLine: 'underline' },
    sheetTitle: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    sheetList: { flexGrow: 0, maxHeight: 360 },
    sheetActions: { gap: spacing.sm, marginTop: spacing.sm },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
    activityRow: { color: colors.text, fontSize: typography.label.fontSize, lineHeight: 20 },
    activityWhen: { color: colors.textMuted, fontWeight: '700' },
  });
}
