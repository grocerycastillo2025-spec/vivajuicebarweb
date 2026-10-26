/**
 * Detalle de producto con grupos de modificadores.
 *
 * Todo lo que se ve aqui viene de la base:
 *  - precio base:            menu_items.price_cents
 *  - recargo por opcion:     catalog_modifiers.price_cents
 *                            (avena y coco = 100, por eso salen +$1.00)
 *  - obligatorio / opcional: catalog_modifier_groups.min_required / max_allowed
 *  - disponibilidad:         menu_items.is_available y catalog_modifiers.available
 *
 * En la app no hay ni un precio ni una regla de seleccion escrita a mano.
 */

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { trackEvent } from '../../src/analytics/track';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { fetchItemModifierGroups, fetchMenuItem } from '../../src/api/menu';
import type { MenuItemRow } from '../../src/api/types';
import { DataState, ErrorState } from '../../src/components/DataState';
import { ItemPhoto } from '../../src/components/ItemPhoto';
import { Screen, useScreenInsets } from '../../src/components/Screen';
import { Badge, Button } from '../../src/components/ui';
import { buildLine, previewUnitPriceCents, MAX_LINE_QUANTITY } from '../../src/domain/cart';
import { formatMoney, formatSurcharge } from '../../src/domain/money';
import {
  availableModifiers,
  optionState,
  defaultSelection,
  selectionToModifiers,
  sortGroups,
  toggleModifier,
  validateSelection,
  type GroupIssue,
  type ModifierGroup,
  type Selection,
} from '../../src/domain/modifiers';
import { useAsync } from '../../src/hooks/use-async';
import type { BrandColors } from '../../src/domain/branding';
import { useColors } from '../../src/state/branding-context';
import { useCart } from '../../src/state/cart-context';
import { radius, spacing, type as typography } from '../../src/theme';
import { strings } from '../../src/strings';

interface ItemDetail {
  readonly item: MenuItemRow | null;
  readonly groups: readonly ModifierGroup[];
}

/** El aviso del grupo en el idioma de la app (el dominio solo clasifica). */
function issueText(issue: GroupIssue, group: ModifierGroup, chosen: number): string {
  switch (issue.kind) {
    case 'too-few':
      return group.minRequired === 1
        ? strings.item.chooseOne(group.name)
        : strings.item.pickMore(group.minRequired - chosen);
    case 'too-many':
      return strings.item.tooMany(group.maxAllowed ?? 0, group.name);
    default:
      return strings.item.optionGone(group.name);
  }
}

function groupHint(group: ModifierGroup): string {
  if (group.minRequired > 0 && group.maxAllowed === 1) return strings.item.pickOne;
  if (group.minRequired > 0) {
    if (group.maxAllowed === null) return strings.item.pickAtLeast(group.minRequired);
    return group.maxAllowed === group.minRequired
      ? strings.item.pickExactly(group.minRequired)
      : strings.item.pickBetween(group.minRequired, group.maxAllowed);
  }
  if (group.maxAllowed === 1) return strings.item.atMostOne;
  if (group.maxAllowed !== null) return strings.item.atMost(group.maxAllowed);
  return strings.item.optional;
}

export default function ItemDetailScreen(): ReactNode {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useScreenInsets();
  const { addLine } = useCart();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const load = useCallback(async (): Promise<ItemDetail> => {
    const [item, groups] = await Promise.all([fetchMenuItem(id), fetchItemModifierGroups(id)]);
    return { item, groups: sortGroups(groups) };
  }, [id]);

  const { data, error, loading, reload } = useAsync(load, [id]);

  const [selection, setSelection] = useState<Selection>({});
  const [quantity, setQuantity] = useState(1);
  const [note, setNote] = useState('');
  const [showIssues, setShowIssues] = useState(false);

  const groups = useMemo(() => data?.groups ?? [], [data]);

  // Preseleccion en cuanto llegan los grupos reales.
  // Consulta del producto (0023): una vez por visitante y dia en la base.
  useEffect(() => {
    if (typeof id === 'string' && id !== '') trackEvent('item_view', id);
  }, [id]);

  useEffect(() => {
    if (data !== null) setSelection(defaultSelection(data.groups));
  }, [data]);

  const issues = useMemo(() => validateSelection(groups, selection), [groups, selection]);

  const unitPriceCents = useMemo(
    () => previewUnitPriceCents(data?.item?.price_cents ?? 0, groups, selection),
    [data, groups, selection],
  );

  const onToggle = useCallback((group: ModifierGroup, modifierId: string) => {
    setSelection((current) => toggleModifier(group, current, modifierId));
  }, []);

  const onAdd = useCallback(() => {
    const item = data?.item;
    if (item === null || item === undefined) return;

    if (issues.length > 0) {
      setShowIssues(true);
      return;
    }

    addLine(
      buildLine(
        {
          id: item.id,
          cloverItemId: item.clover_item_id,
          name: item.name,
          imageUrl: item.image_url,
          priceCents: item.price_cents,
        },
        selectionToModifiers(groups, selection),
        quantity,
        note,
      ),
    );

    router.back();
  }, [addLine, data, groups, issues, note, quantity, router, selection]);

  if (loading || error !== null) {
    return (
      <Screen scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </Screen>
    );
  }

  const item = data?.item ?? null;

  if (item === null) {
    return (
      <Screen scroll={false}>
        <ErrorState error={new Error(strings.item.goneFromMenu)} onRetry={() => router.back()} />
      </Screen>
    );
  }

  const totalCents = unitPriceCents * quantity;

  return (
    <Screen scroll={false}>
      <View style={styles.topBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={strings.common.back}
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 140 }]}
        keyboardShouldPersistTaps="handled"
      >
        <ItemPhoto url={item.image_url} recyclingKey={item.id} glyphSize={56} style={styles.hero} />

        <View style={styles.headline}>
          <Text style={styles.name}>{item.name}</Text>
          {item.badge !== null ? <Badge label={item.badge} /> : null}
        </View>

        {item.description !== null && item.description !== '' ? (
          <Text style={styles.description}>{item.description}</Text>
        ) : null}

        <Text style={styles.basePrice}>{formatMoney(item.price_cents)}</Text>

        {!item.is_available ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              {item.unavailable_reason ?? strings.item.unavailableNow}
            </Text>
          </View>
        ) : null}

        {groups.map((group) => {
          const options = availableModifiers(group);
          const issue = showIssues ? issues.find((entry) => entry.groupId === group.id) : undefined;

          return (
            <View key={group.id} style={styles.group}>
              <View style={styles.groupHeader}>
                <Text style={styles.groupName}>{group.name}</Text>
                <Text style={styles.groupHint}>{groupHint(group)}</Text>
              </View>

              {issue !== undefined ? <Text style={styles.groupError}>{issueText(issue, group, selection[group.id]?.length ?? 0)}</Text> : null}

              <View style={styles.options}>
                {options.map((modifier) => {
                  // Del dominio, entero: la pantalla no deduce cuando se
                  // puede tocar una opcion. Deducirlo aqui es lo que dejo
                  // muerta la eleccion de leche.
                  const { checked, disabled: blocked } = optionState(
                    group,
                    selection,
                    modifier.id,
                  );
                  const surcharge = formatSurcharge(modifier.priceCents);

                  return (
                    <Pressable
                      key={modifier.id}
                      accessibilityRole={group.maxAllowed === 1 ? 'radio' : 'checkbox'}
                      accessibilityState={{ checked, disabled: blocked }}
                      accessibilityLabel={
                        surcharge === ''
                          ? modifier.name
                          : `${modifier.name}, ${surcharge.replace('+', 'plus ')}`
                      }
                      disabled={blocked}
                      onPress={() => onToggle(group, modifier.id)}
                      style={({ pressed }) => [
                        styles.option,
                        checked && styles.optionChecked,
                        blocked && styles.optionBlocked,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Ionicons
                        name={
                          group.maxAllowed === 1
                            ? checked
                              ? 'radio-button-on'
                              : 'radio-button-off'
                            : checked
                              ? 'checkbox'
                              : 'square-outline'
                        }
                        size={20}
                        color={checked ? colors.primary : colors.textFaint}
                      />
                      <Text style={[styles.optionName, checked && styles.optionNameChecked]}>
                        {modifier.name}
                      </Text>
                      {surcharge !== '' ? (
                        <Text style={styles.optionPrice}>{surcharge}</Text>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        })}

        <View style={styles.group}>
          <Text style={styles.groupName}>{strings.item.kitchenNote}</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={strings.item.kitchenNotePlaceholder}
            placeholderTextColor={colors.textFaint}
            style={styles.noteInput}
            multiline
            maxLength={240}
          />
        </View>

        <View style={styles.quantityRow}>
          <Text style={styles.groupName}>{strings.item.quantity}</Text>
          <View style={styles.stepper}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={strings.item.removeOne}
              onPress={() => setQuantity((current) => Math.max(1, current - 1))}
              disabled={quantity <= 1}
              hitSlop={8}
              style={({ pressed }) => [
                styles.stepperButton,
                pressed && styles.pressed,
                quantity <= 1 && styles.stepperDisabled,
              ]}
            >
              <Ionicons name="remove" size={20} color={colors.primary} />
            </Pressable>

            <Text style={styles.quantity}>{quantity}</Text>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={strings.item.addOne}
              onPress={() => setQuantity((current) => Math.min(MAX_LINE_QUANTITY, current + 1))}
              disabled={quantity >= MAX_LINE_QUANTITY}
              hitSlop={8}
              style={({ pressed }) => [
                styles.stepperButton,
                pressed && styles.pressed,
                quantity >= MAX_LINE_QUANTITY && styles.stepperDisabled,
              ]}
            >
              <Ionicons name="add" size={20} color={colors.primary} />
            </Pressable>
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
        <Button
          label={
            item.is_available ? strings.item.add(formatMoney(totalCents)) : strings.item.unavailable
          }
          onPress={onAdd}
          disabled={!item.is_available}
        />
      </View>
    </Screen>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    topBar: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    backButton: {
      width: 40,
      height: 40,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.border,
    },
    pressed: { opacity: 0.7 },

    content: { padding: spacing.lg, gap: spacing.lg },
    hero: {
      width: '100%',
      height: 200,
      borderRadius: radius.lg,
    },
    headline: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    name: {
      flex: 1,
      color: colors.text,
      fontSize: typography.display.fontSize,
      fontWeight: '800',
    },
    description: {
      color: colors.textMuted,
      fontSize: typography.body.fontSize,
      lineHeight: 22,
      marginTop: -spacing.sm,
    },
    basePrice: {
      color: colors.primary,
      fontSize: typography.title.fontSize,
      fontWeight: '800',
      marginTop: -spacing.sm,
    },

    notice: {
      backgroundColor: colors.danger,
      borderRadius: radius.md,
      padding: spacing.md,
    },
    noticeText: { color: '#FFFFFF', fontSize: typography.label.fontSize, fontWeight: '600' },

    group: { gap: spacing.sm },
    groupHeader: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    groupName: {
      color: colors.text,
      fontSize: typography.section.fontSize,
      fontWeight: '700',
    },
    groupHint: {
      color: colors.textFaint,
      fontSize: typography.caption.fontSize,
      fontWeight: '600',
    },
    groupError: {
      color: colors.danger,
      fontSize: typography.caption.fontSize,
      fontWeight: '600',
    },

    options: {
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
    },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    optionChecked: { backgroundColor: '#F3F8F4' },
    optionBlocked: { opacity: 0.4 },
    optionName: {
      flex: 1,
      color: colors.text,
      fontSize: typography.body.fontSize,
    },
    optionNameChecked: { fontWeight: '700' },
    optionPrice: {
      color: colors.accent,
      fontSize: typography.label.fontSize,
      fontWeight: '800',
    },

    noteInput: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      padding: spacing.md,
      minHeight: 76,
      color: colors.text,
      fontSize: typography.body.fontSize,
      textAlignVertical: 'top',
    },

    quantityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.lg,
      backgroundColor: colors.surface,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    stepperButton: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepperDisabled: { opacity: 0.35 },
    quantity: {
      color: colors.text,
      fontSize: typography.section.fontSize,
      fontWeight: '800',
      minWidth: 24,
      textAlign: 'center',
    },

    footer: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
    },
  });
}
