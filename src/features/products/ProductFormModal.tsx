import { useState } from 'react';
import { useStore, useToast } from '../../app/contexts';
import { Field } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { CloseButton, Modal } from '../../components/Modal';
import { artFor } from '../../components/productArt';
import { formatPriceInput } from '../../domain/money';
import type { ProductFormInput } from '../../domain/operations';
import type { FieldErrors, Product } from '../../domain/types';
import { compressImage } from './imageUpload';

interface Props {
  product: Product | null;
  onClose: () => void;
}

export function ProductFormModal({ product, onClose }: Props) {
  const { data, actions, source } = useStore();
  const toast = useToast();
  const isNew = !product;
  // Com a API, fotos dependem do Cloud Storage (etapa futura): sem envio, e data URLs nunca vão ao servidor.
  const uploadAvailable = source === 'local';
  const [form, setForm] = useState<ProductFormInput>(() =>
    product
      ? {
          id: product.id,
          name: product.name,
          categoryId: product.categoryId,
          brand: product.brand,
          description: product.description,
          imageUrl: product.imageUrl,
          price: formatPriceInput(product.priceCents),
          showPrice: product.showPrice,
          stock: String(product.stock),
          minStock: String(product.minStock),
          published: product.published,
          featured: product.featured,
        }
      : {
          id: null,
          name: '',
          categoryId: data.categories.find((c) => c.active)?.id ?? '',
          brand: '',
          description: '',
          imageUrl: '',
          price: '',
          showPrice: true,
          stock: '0',
          minStock: '2',
          published: true,
          featured: false,
        },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [imgError, setImgError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof ProductFormInput>(k: K, v: ProductFormInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const onFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const url = await compressImage(file);
      set('imageUrl', url);
      setImgError('');
    } catch (e) {
      setImgError((e as Error).message);
    } finally {
      input.value = '';
    }
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const r = await actions.saveProduct(form);
    setSaving(false);
    if (!r.ok) {
      if (r.storageFull) {
        setImgError(r.error);
        return toast('Produto não salvo: sem espaço para a imagem.');
      }
      setErrors(r.fieldErrors ?? {});
      if (r.fieldErrors?.image) setImgError(r.fieldErrors.image);
      return toast(r.error);
    }
    onClose();
    if (!r.persisted) return toast('Alterações aplicadas apenas nesta sessão: não foi possível salvar no navegador.');
    toast(isNew ? (r.product.published ? 'Produto cadastrado e publicado no catálogo.' : 'Produto cadastrado (oculto do catálogo).') : 'Alterações salvas.');
  };

  const title = isNew ? 'Novo produto' : 'Editar produto';
  const invalid = (k: string) => ({ 'aria-invalid': !!errors[k], 'aria-describedby': errors[k] ? `pf-${k}-err` : undefined });
  const keptImage = uploadAvailable || form.imageUrl.startsWith('https://') ? form.imageUrl : '';
  const preview = keptImage || artFor({ id: form.id ?? '', categoryId: form.categoryId });

  return (
    <Modal label={title} onClose={onClose} className="dialog pf-dialog">
      <div className="pf-dialog__head">
        <h2 className="dialog-title" style={{ flex: 1, fontSize: 24 }}>
          {title}
        </h2>
        <CloseButton onClick={onClose} />
      </div>

      <form
        className="pf-dialog__body"
        id="product-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Nome do produto *" full error={errors.name} errorId="pf-name-err">
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Ex.: Ração Adulto 15 kg" {...invalid('name')} />
        </Field>
        {data.categories.length === 0 && (
          <p className="notice notice--warn field--full" role="note" style={{ margin: 0 }}>
            Nenhuma categoria cadastrada. Cadastre a primeira categoria em <strong>Categorias</strong> antes de salvar o produto.
          </p>
        )}
        <Field label="Categoria *" error={errors.categoryId} errorId="pf-categoryId-err">
          <select className="select" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)} {...invalid('categoryId')}>
            <option value="">Selecione</option>
            {data.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.active ? '' : ' (inativa)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Marca">
          <input className="input" value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="Opcional" />
        </Field>
        <label className="field field--full">
          Descrição
          <textarea className="textarea" value={form.description} onChange={(e) => set('description', e.target.value)} rows={3} placeholder="Breve descrição para o catálogo" />
        </label>

        <div className="pf-image field--full">
          <div className="thumb pf-image__preview">
            <img src={preview} alt="Pré-visualização" />
          </div>
          <div className="pf-image__controls">
            <span style={{ fontSize: 14, fontWeight: 700 }}>Imagem do produto</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {uploadAvailable && (
                <label className="btn btn--secondary pf-image__pick">
                  <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => onFile(e.currentTarget)} />
                  <Icon name="upload" />
                  Escolher imagem
                </label>
              )}
              {keptImage && (
                <button type="button" className="btn btn--danger" onClick={() => set('imageUrl', '')}>
                  Remover
                </button>
              )}
            </div>
            {uploadAvailable ? (
              <span className="field-hint" style={{ fontWeight: 400 }}>
                JPEG, PNG ou WebP até 8 MB (reduzida para 600 px). Sem foto, o catálogo usa a ilustração demonstrativa.
              </span>
            ) : (
              <span className="field-hint" style={{ fontWeight: 400 }}>
                O envio de fotos ainda não está disponível nesta versão. O produto pode ser salvo normalmente e usa a ilustração padrão da categoria até lá.
              </span>
            )}
            {imgError && (
              <span role="alert" className="field-error">
                {imgError}
              </span>
            )}
          </div>
        </div>

        <Field label="Preço (R$)" error={errors.price} errorId="pf-price-err">
          <input className="input" value={form.price} onChange={(e) => set('price', e.target.value)} inputMode="decimal" placeholder="Ex.: 49,90" {...invalid('price')} />
        </Field>
        <label className="check" style={{ alignSelf: 'end' }}>
          <input type="checkbox" checked={form.showPrice} onChange={(e) => set('showPrice', e.target.checked)} />
          Exibir preço no catálogo
        </label>

        {isNew ? (
          <Field label="Quantidade inicial em estoque" error={errors.stock} errorId="pf-stock-err">
            <input className="input" value={form.stock} onChange={(e) => set('stock', e.target.value)} inputMode="numeric" {...invalid('stock')} />
          </Field>
        ) : (
          <div className="field">
            Estoque atual
            <div className="field-static">{product.stock} un. em estoque</div>
            <span className="field-hint">Altere pelo módulo Estoque para manter o histórico.</span>
          </div>
        )}
        <Field label="Estoque mínimo" error={errors.minStock} errorId="pf-minStock-err">
          <input className="input" value={form.minStock} onChange={(e) => set('minStock', e.target.value)} inputMode="numeric" {...invalid('minStock')} />
        </Field>

        <div className="pf-flags field--full">
          <label className="check">
            <input type="checkbox" checked={form.published} onChange={(e) => set('published', e.target.checked)} />
            Publicado no catálogo
          </label>
          <label className="check">
            <input type="checkbox" checked={form.featured} onChange={(e) => set('featured', e.target.checked)} />
            Produto em destaque
          </label>
        </div>
      </form>

      <div className="pf-dialog__foot">
        <button type="button" className="btn btn--secondary btn--md" onClick={onClose}>
          Cancelar
        </button>
        <button type="submit" form="product-form" className="btn btn--primary btn--md" style={{ fontSize: 15, padding: '0 22px' }} disabled={saving}>
          Salvar produto
        </button>
      </div>
    </Modal>
  );
}
