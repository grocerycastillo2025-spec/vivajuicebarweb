/**
 * Panel · Menú.
 *
 * Categorias (crear, renombrar, ordenar, eliminar) y sus productos. Lo que
 * mas se toca en el dia —"se acabo el mango"— esta a un toque: el
 * interruptor de disponible en la propia fila. Para todo lo demas se abre
 * el producto.
 *
 * Solo para catalogo propio (`catalog_source = 'own'`). Con Clover el
 * menu se edita en Clover y aqui no hay nada que tocar.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  deleteCategory,
  fetchAdminCatalog,
  saveCategory,
  setProductAvailable,
  type AdminCategory,
  type AdminProduct,
} from '../../src/api/admin';
import { useAdmin } from '../../src/admin/admin-context';
import { adminStrings as t } from '../../src/admin/strings';
import { AdminShell, Card, IconButton, Notice, createAdminStyles } from '../../src/admin/ui';
import { DataState } from '../../src/components/DataState';
import { Button } from '../../src/components/ui';
import type { BrandColors } from '../../src/domain/branding';
import { formatMoney } from '../../src/domain/money';
import { useAsync } from '../../src/hooks/use-async';
import { useColors } from '../../src/state/branding-context';
import { radius, spacing, type as typography } from '../../src/theme';

const NO_CATEGORY = '__none__';

export default function AdminMenuScreen(): ReactNode {
  const colors = useColors();
  const styles = useStyles(colors);
  const router = useRouter();
  const { store, isOwner } = useAdmin();

  const load = useCallback(() => fetchAdminCatalog(store.id), [store.id]);
  const { data, error, loading, refresh, reload } = useAsync(load, [store.id]);

  const [newName, setNewName] = useState('');
  const [newNameEs, setNewNameEs] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attempt = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setFailure(null);
      try {
        await work();
        refresh();
      } catch (cause) {
        setFailure(`${t.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const sections = useMemo(() => {
    if (data === null) return [];
    const list: { category: AdminCategory | null; products: AdminProduct[] }[] = data.categories.map(
      (category) => ({
        category,
        products: data.products.filter((product) => product.category_id === category.id),
      }),
    );
    const known = new Set(data.categories.map((c) => c.id));
    const orphans = data.products.filter((p) => p.category_id === null || !known.has(p.category_id));
    if (orphans.length > 0) list.push({ category: null, products: orphans });
    return list;
  }, [data]);

  if (!isOwner) {
    return (
      <AdminShell>
        <Notice tone="error" text={t.ownerOnly} />
      </AdminShell>
    );
  }

  if (data === null) {
    return (
      <AdminShell scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  const categories = data.categories;
  const addCategory = (): void => {
    const name = newName.trim();
    if (name === '') return;
    const last = categories[categories.length - 1];
    void attempt(async () => {
      await saveCategory(store.id, { name, name_es: newNameEs, sort_order: (last?.sort_order ?? 0) + 10 });
      setNewName('');
      setNewNameEs('');
    });
  };

  // Subir o bajar = intercambiar el orden con la vecina.
  const swap = (index: number, delta: -1 | 1): void => {
    const a = categories[index];
    const b = categories[index + delta];
    if (a === undefined || b === undefined) return;
    const aSort = a.sort_order === b.sort_order ? index * 10 : a.sort_order;
    const bSort = a.sort_order === b.sort_order ? (index + delta) * 10 : b.sort_order;
    void attempt(async () => {
      await saveCategory(store.id, { id: a.id, name: a.name, sort_order: bSort });
      await saveCategory(store.id, { id: b.id, name: b.name, sort_order: aSort });
    });
  };

  return (
    <AdminShell>
      {failure !== null ? <Notice tone="error" text={failure} /> : null}

      <Card title={t.menu.newCategory}>
        <View style={styles.inlineForm}>
          <TextInput
            value={newName}
            onChangeText={setNewName}
            placeholder={t.menu.categoryPlaceholder}
            placeholderTextColor={colors.textFaint}
            onSubmitEditing={addCategory}
            accessibilityLabel={t.menu.categoryName}
            style={[styles.input, styles.inlineInput]}
          />
          <TextInput
            value={newNameEs}
            onChangeText={setNewNameEs}
            placeholder={t.menu.categoryPlaceholderEs}
            placeholderTextColor={colors.textFaint}
            onSubmitEditing={addCategory}
            accessibilityLabel={t.menu.categoryNameEs}
            style={[styles.input, styles.inlineInput]}
          />
          <Button label={t.add} onPress={addCategory} disabled={busy || newName.trim() === ''} />
        </View>
      </Card>

      {sections.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="leaf-outline" size={40} color={colors.textFaint} />
          <Text style={styles.emptyTitle}>{t.menu.emptyTitle}</Text>
          <Text style={styles.emptyBody}>{t.menu.emptyBody}</Text>
        </View>
      ) : null}

      {sections.map(({ category, products }, index) => (
        <CategorySection
          key={category?.id ?? NO_CATEGORY}
          category={category}
          products={products}
          first={index === 0}
          last={category === null || index === categories.length - 1}
          busy={busy}
          onRename={(name) =>
            category !== null &&
            void attempt(() => saveCategory(store.id, { id: category.id, name, sort_order: category.sort_order }))
          }
          onDelete={() => category !== null && void attempt(() => deleteCategory(category.id))}
          onMove={(delta) => swap(index, delta)}
          onToggle={(product, available) =>
            void attempt(() => setProductAvailable(product.id, available))
          }
          onOpen={(product) =>
            router.push({ pathname: '/admin/product/[id]', params: { id: product.id } })
          }
          onNew={() =>
            router.push({
              pathname: '/admin/product/[id]',
              params: { id: 'new', category: category?.id ?? '' },
            })
          }
        />
      ))}
    </AdminShell>
  );
}

function CategorySection({
  category,
  products,
  first,
  last,
  busy,
  onRename,
  onDelete,
  onMove,
  onToggle,
  onOpen,
  onNew,
}: {
  readonly category: AdminCategory | null;
  readonly products: readonly AdminProduct[];
  readonly first: boolean;
  readonly last: boolean;
  readonly busy: boolean;
  readonly onRename: (name: string, nameEs: string) => void;
  readonly onDelete: () => void;
  readonly onMove: (delta: -1 | 1) => void;
  readonly onToggle: (product: AdminProduct, available: boolean) => void;
  readonly onOpen: (product: AdminProduct) => void;
  readonly onNew: () => void;
}): ReactNode {
  const colors = useColors();
  const styles = useStyles(colors);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [name, setName] = useState(category?.name ?? '');
  const [nameEs, setNameEs] = useState(category?.name_es ?? '');
  const submitRename = (): void => {
    setEditing(false);
    if (category === null || name.trim() === '') return;
    if (name !== category.name || nameEs !== (category.name_es ?? '')) onRename(name.trim(), nameEs);
  };

  return (
    <View style={styles.card}>
      <View style={styles.categoryHead}>
        {editing && category !== null ? (
          <View style={[styles.inlineForm, styles.grow]}>
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              accessibilityLabel={t.menu.categoryName}
              style={[styles.input, styles.inlineInput]}
              onSubmitEditing={submitRename}
            />
            <TextInput
              value={nameEs}
              onChangeText={setNameEs}
              placeholder={t.menu.categoryPlaceholderEs}
              accessibilityLabel={t.menu.categoryNameEs}
              style={[styles.input, styles.inlineInput]}
              onSubmitEditing={submitRename}
            />
            <Button label={t.save} onPress={submitRename} />
          </View>
        ) : (
          <Text style={styles.categoryName}>
            {category?.name ?? t.menu.noCategory}
            {category?.name_es ? <Text style={styles.categoryNameEs}>{`  ·  ${category.name_es}`}</Text> : null}
          </Text>
        )}

        {category !== null && !editing ? (
          <View style={styles.rowActions}>
            <IconButton icon="arrow-up" label={t.menu.moveUp} disabled={busy || first} onPress={() => onMove(-1)} />
            <IconButton icon="arrow-down" label={t.menu.moveDown} disabled={busy || last} onPress={() => onMove(1)} />
            <IconButton icon="pencil" label={t.edit} onPress={() => setEditing(true)} />
            <IconButton icon="trash-outline" label={t.delete} tone="danger" onPress={() => setConfirming(true)} />
          </View>
        ) : null}
      </View>

      {confirming && category !== null ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>{t.menu.deleteCategoryConfirm(category.name)}</Text>
          <View style={styles.inlineForm}>
            <Button
              label={t.confirmDelete}
              onPress={() => {
                setConfirming(false);
                onDelete();
              }}
              style={{ backgroundColor: colors.danger }}
            />
            <Button label={t.cancel} variant="outline" onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : null}

      {products.length === 0 ? <Text style={styles.muted}>{t.menu.emptyCategory}</Text> : null}

      {products.map((product) => (
        <View key={product.id} style={styles.productRow}>
          <View style={styles.thumb}>
            {product.image_url !== null ? (
              <Image source={{ uri: product.image_url }} style={styles.thumbImage} contentFit="cover" />
            ) : (
              <Ionicons name="image-outline" size={22} color={colors.textFaint} />
            )}
          </View>
          <View style={styles.productBody}>
            <Text style={[styles.productName, !product.available && styles.soldOut]} numberOfLines={1}>
              {product.featured ? '★ ' : ''}
              {product.name}
            </Text>
            <Text style={styles.productMeta}>
              {formatMoney(product.price_cents)}
              {product.available ? '' : ` · ${t.menu.soldOut}`}
            </Text>
          </View>
          <View style={styles.availability}>
            <Switch
              value={product.available}
              onValueChange={(value) => onToggle(product, value)}
              disabled={busy}
              accessibilityLabel={`${t.menu.available}: ${product.name}`}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#FFFFFF"
              {...({ activeThumbColor: '#FFFFFF' } as object)}
            />
          </View>
          <IconButton icon="create-outline" label={`${t.edit} ${product.name}`} onPress={() => onOpen(product)} />
        </View>
      ))}

      <Button label={`+ ${t.menu.newProduct}`} variant="outline" onPress={onNew} style={styles.newProduct} />
    </View>
  );
}

function useStyles(colors: BrandColors) {
  return useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    inlineForm: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', flexWrap: 'wrap' },
    inlineInput: { flex: 1, minWidth: 180 },
    grow: { flex: 1, minWidth: 0 },
    empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
    emptyTitle: { color: colors.text, fontSize: typography.section.fontSize, fontWeight: '800' },
    emptyBody: { color: colors.textMuted, fontSize: typography.body.fontSize, textAlign: 'center', maxWidth: 380 },
    categoryHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    categoryNameEs: { color: colors.textMuted, fontSize: typography.body.fontSize, fontWeight: '600' },
    categoryName: { flex: 1, minWidth: 0, color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
    rowActions: { flexDirection: 'row', gap: spacing.xs },
    confirm: { gap: spacing.sm, backgroundColor: colors.background, padding: spacing.md, borderRadius: radius.md },
    confirmText: { color: colors.text, fontSize: typography.label.fontSize },
    muted: { color: colors.textFaint, fontSize: typography.label.fontSize },
    productRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    thumb: {
      width: 52,
      height: 52,
      borderRadius: radius.sm,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      flexShrink: 0,
    },
    thumbImage: { width: 52, height: 52 },
    productBody: { flex: 1, minWidth: 0, gap: 2 },
    productName: { color: colors.text, fontSize: typography.body.fontSize, fontWeight: '700' },
    soldOut: { color: colors.textFaint, textDecorationLine: 'line-through' },
    productMeta: { color: colors.textMuted, fontSize: typography.label.fontSize },
    availability: { flexShrink: 0 },
    newProduct: { alignSelf: 'flex-start', minHeight: 40 },
  });
}
