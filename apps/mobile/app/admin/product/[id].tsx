/**
 * Panel · Producto (nuevo o existente).
 *
 * El precio se teclea con IVA, como se ve en el menu. Se guarda en
 * centavos enteros (`parsePriceInput`) y la base lo vuelve a leer al
 * crear cada pedido: lo que ve el cliente y lo que se cobra salen de la
 * misma fila.
 */

import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  deleteProduct,
  fetchAdminCatalog,
  saveProduct,
  uploadImage,
  type AdminCatalog,
} from '../../../src/api/admin';
import { useAdmin } from '../../../src/admin/admin-context';
import { canPickImages, pickProductPhoto } from '../../../src/admin/pick-image';
import { adminStrings as t } from '../../../src/admin/strings';
import { AdminShell, Card, Field, Notice, Toggle, createAdminStyles } from '../../../src/admin/ui';
import { DataState } from '../../../src/components/DataState';
import { Button } from '../../../src/components/ui';
import { parsePriceInput, priceToInput } from '../../../src/domain/admin';
import type { BrandColors } from '../../../src/domain/branding';
import { useAsync } from '../../../src/hooks/use-async';
import { useColors } from '../../../src/state/branding-context';
import { radius, spacing, type as typography } from '../../../src/theme';

export default function AdminProductScreen(): ReactNode {
  const { id, category } = useLocalSearchParams<{ id: string; category?: string }>();
  const { store } = useAdmin();

  const load = useCallback(() => fetchAdminCatalog(store.id), [store.id]);
  const { data, error, loading, reload } = useAsync(load, [store.id]);

  if (data === null) {
    return (
      <AdminShell scroll={false}>
        <DataState loading={loading} error={error} empty={false} onRetry={reload} emptyTitle="">
          {null}
        </DataState>
      </AdminShell>
    );
  }

  return <ProductForm catalog={data} productId={id === 'new' ? null : id} initialCategory={category ?? null} />;
}

function ProductForm({
  catalog,
  productId,
  initialCategory,
}: {
  readonly catalog: AdminCatalog;
  readonly productId: string | null;
  readonly initialCategory: string | null;
}): ReactNode {
  const colors = useColors();
  const styles = useMemo(() => ({ ...createAdminStyles(colors), ...createStyles(colors) }), [colors]);
  const router = useRouter();
  const { store } = useAdmin();

  const existing = productId === null ? undefined : catalog.products.find((p) => p.id === productId);
  const categories = catalog.categories;

  const [name, setName] = useState(existing?.name ?? '');
  const [price, setPrice] = useState(existing === undefined ? '' : priceToInput(existing.price_cents));
  const [categoryId, setCategoryId] = useState<string | null>(
    existing?.category_id ?? (initialCategory !== null && initialCategory !== '' ? initialCategory : (categories[0]?.id ?? null)),
  );
  const [description, setDescription] = useState(existing?.description ?? '');
  const [nameEs, setNameEs] = useState(existing?.name_es ?? '');
  const [descriptionEs, setDescriptionEs] = useState(existing?.description_es ?? '');
  const [imageUrl, setImageUrl] = useState<string | null>(existing?.image_url ?? null);
  const [available, setAvailable] = useState(existing?.available ?? true);
  const [featured, setFeatured] = useState(existing?.featured ?? false);
  const [badge, setBadge] = useState(existing?.badge ?? '');
  const [order, setOrder] = useState(String(existing?.sort_order ?? 0));

  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  // La vista previa local se libera al salir.
  useEffect(
    () => () => {
      if (preview !== null) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  if (productId !== null && existing === undefined) {
    return (
      <AdminShell>
        <Notice tone="error" text={t.product.notFound} />
        <Button label={t.tabs.menu} variant="outline" onPress={() => router.replace('/admin/menu')} />
      </AdminShell>
    );
  }

  const priceCents = parsePriceInput(price);
  const nameError = touched && name.trim() === '' ? t.product.nameRequired : null;
  const priceError = touched && priceCents === null ? t.product.priceInvalid : null;

  const choosePhoto = async (): Promise<void> => {
    setFailure(null);
    try {
      const picked = await pickProductPhoto();
      if (picked === null) return;
      setPreview(picked.previewUrl);
      setUploading(true);
      const url = await uploadImage('menu-images', store.id, picked.blob, picked.extension);
      setImageUrl(url);
    } catch (cause) {
      setPreview(null);
      setFailure(`${t.product.photoFailed}: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setUploading(false);
    }
  };

  const save = async (): Promise<void> => {
    setTouched(true);
    if (name.trim() === '' || priceCents === null) return;
    setSaving(true);
    setFailure(null);
    try {
      await saveProduct(store.id, {
        ...(existing !== undefined ? { id: existing.id, clover_item_id: existing.clover_item_id } : {}),
        category_id: categoryId,
        name,
        price_cents: priceCents,
        available,
        description,
        name_es: nameEs,
        description_es: descriptionEs,
        image_url: imageUrl,
        featured,
        badge,
        sort_order: Number.parseInt(order, 10) || 0,
      });
      router.replace('/admin/menu');
    } catch (cause) {
      setFailure(`${t.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}`);
      setSaving(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (existing === undefined) return;
    setSaving(true);
    try {
      await deleteProduct(existing.id);
      router.replace('/admin/menu');
    } catch (cause) {
      setFailure(`${t.saveFailed}: ${cause instanceof Error ? cause.message : String(cause)}`);
      setSaving(false);
    }
  };

  const shownImage = preview ?? imageUrl;

  return (
    <AdminShell>
      <Pressable accessibilityRole="link" onPress={() => router.replace('/admin/menu')} style={styles.back}>
        <Ionicons name="arrow-back" size={18} color={colors.primary} />
        <Text style={styles.backText}>{t.tabs.menu}</Text>
      </Pressable>

      <Text style={styles.heading}>{existing === undefined ? t.product.titleNew : t.product.titleEdit}</Text>

      <View style={styles.layout}>
        <View style={styles.main}>
          <Card>
            <Field
              label={t.product.name}
              value={name}
              onChangeText={setName}
              placeholder={t.product.namePlaceholder}
              error={nameError}
              autoCapitalize="sentences"
            />
            <Field
              label={t.product.price}
              value={price}
              onChangeText={setPrice}
              placeholder={t.product.pricePlaceholder}
              keyboardType="decimal-pad"
              error={priceError}
            />
            <Field
              label={t.product.description}
              value={description}
              onChangeText={setDescription}
              placeholder={t.product.descriptionPlaceholder}
              multiline
            />
            <Field
              label={t.product.nameEs}
              value={nameEs}
              onChangeText={setNameEs}
              placeholder={t.product.nameEsPlaceholder}
              autoCapitalize="sentences"
              hint={t.product.bilingualHint}
            />
            <Field
              label={t.product.descriptionEs}
              value={descriptionEs}
              onChangeText={setDescriptionEs}
              placeholder={t.product.descriptionEsPlaceholder}
              multiline
            />

            <View style={styles.field}>
              <Text style={styles.label}>{t.product.category}</Text>
              <View style={styles.chips}>
                {categories.map((c) => (
                  <Pressable
                    key={c.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: categoryId === c.id }}
                    onPress={() => setCategoryId(c.id)}
                    style={[styles.chip, categoryId === c.id && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, categoryId === c.id && styles.chipTextOn]}>{c.name}</Text>
                  </Pressable>
                ))}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: categoryId === null }}
                  onPress={() => setCategoryId(null)}
                  style={[styles.chip, categoryId === null && styles.chipOn]}
                >
                  <Text style={[styles.chipText, categoryId === null && styles.chipTextOn]}>
                    {t.menu.noCategory}
                  </Text>
                </Pressable>
              </View>
            </View>
          </Card>

          <Card>
            <Toggle
              label={t.product.available}
              hint={t.product.availableHint}
              value={available}
              onValueChange={setAvailable}
            />
            <Toggle
              label={t.product.featured}
              hint={t.product.featuredHint}
              value={featured}
              onValueChange={setFeatured}
            />
            <Field
              label={t.product.badge}
              value={badge}
              onChangeText={setBadge}
              placeholder={t.product.badgePlaceholder}
            />
            <Field
              label={t.product.order}
              value={order}
              onChangeText={setOrder}
              keyboardType="number-pad"
              hint={t.product.orderHint}
            />
          </Card>
        </View>

        <View style={styles.side}>
          <Card title={t.product.photo}>
            <View style={styles.photo}>
              {shownImage !== null ? (
                <Image source={{ uri: shownImage }} style={styles.photoImage} contentFit="cover" />
              ) : (
                <Ionicons name="image-outline" size={40} color={colors.textFaint} />
              )}
            </View>
            {uploading ? <Text style={styles.hint}>{t.product.uploading}</Text> : null}
            {canPickImages ? (
              <View style={styles.photoActions}>
                <Button
                  label={shownImage === null ? t.product.choosePhoto : t.product.changePhoto}
                  variant="outline"
                  busy={uploading}
                  onPress={() => void choosePhoto()}
                />
                {shownImage !== null && !uploading ? (
                  <Pressable
                    onPress={() => {
                      setImageUrl(null);
                      setPreview(null);
                    }}
                  >
                    <Text style={styles.removeText}>{t.product.removePhoto}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <Text style={styles.hint}>{t.product.photoNativeOnly}</Text>
            )}
          </Card>
        </View>
      </View>

      {failure !== null ? <Notice tone="error" text={failure} /> : null}

      <View style={styles.footer}>
        <Button
          label={saving ? t.saving : t.save}
          busy={saving}
          disabled={uploading}
          onPress={() => void save()}
          style={styles.saveButton}
        />
        {existing !== undefined && !confirmingDelete ? (
          <Pressable onPress={() => setConfirmingDelete(true)} style={styles.deleteLink}>
            <Text style={styles.removeText}>{t.delete}</Text>
          </Pressable>
        ) : null}
      </View>

      {confirmingDelete ? (
        <Card>
          <Text style={styles.confirmText}>{t.product.deleteConfirm}</Text>
          <View style={styles.photoActions}>
            <Button
              label={t.confirmDelete}
              busy={saving}
              onPress={() => void remove()}
              style={{ backgroundColor: colors.danger }}
            />
            <Button label={t.cancel} variant="outline" onPress={() => setConfirmingDelete(false)} />
          </View>
        </Card>
      ) : null}
    </AdminShell>
  );
}

function createStyles(colors: BrandColors) {
  return StyleSheet.create({
    back: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontWeight: '700', fontSize: typography.label.fontSize + 1 },
    heading: { color: colors.text, fontSize: typography.title.fontSize, fontWeight: '800' },
    layout: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.lg, alignItems: 'flex-start' },
    main: { flexGrow: 2, flexBasis: 360, minWidth: 0, gap: spacing.lg },
    side: { flexGrow: 1, flexBasis: 260, minWidth: 0 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.background,
    },
    chipOn: { backgroundColor: colors.primary, borderColor: colors.primary },
    chipText: { color: colors.text, fontWeight: '600', fontSize: typography.label.fontSize },
    chipTextOn: { color: colors.onPrimary },
    photo: {
      aspectRatio: 1,
      width: '100%',
      borderRadius: radius.md,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    },
    photoImage: { width: '100%', height: '100%' },
    photoActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' },
    removeText: { color: colors.danger, fontWeight: '700', fontSize: typography.label.fontSize },
    footer: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
    saveButton: { minWidth: 200 },
    deleteLink: { padding: spacing.sm },
    confirmText: { color: colors.text, fontSize: typography.body.fontSize },
  });
}
