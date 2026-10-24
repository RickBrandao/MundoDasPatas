import { useEffect, useRef, useState } from 'react';
import { useStore, useToast } from '../../app/contexts';
import { Field } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { CloseButton, Modal } from '../../components/Modal';
import { artFor } from '../../components/productArt';
import { formatPriceInput } from '../../domain/money';
import type { ProductFormInput } from '../../domain/operations';
import type { FieldErrors, Product } from '../../domain/types';
import type { ImageUploadConfig } from '../../services/storeApi';
import { compressForUpload, compressImage } from './imageUpload';

interface Props {
  product: Product | null;
  onClose: () => void;
}

/** Foto escolhida e comprimida no navegador, ainda não enviada (modo API). */
interface PendingImage {
  blob: Blob;
  previewUrl: string;
}

type Stage = 'idle' | 'compressing' | 'saving' | 'uploading' | 'removing';

const STAGE_LABEL: Partial<Record<Stage, string>> = {
  compressing: 'Preparando a foto…',
  saving: 'Salvando o produto…',
  uploading: 'Enviando a foto…',
  removing: 'Removendo a foto…',
};

export function ProductFormModal({ product, onClose }: Props) {
  const { data, actions, source } = useStore();
  const toast = useToast();
  // Demonstração: a foto vira data URL no próprio produto (navegador). API: arquivo no Cloud Storage,
  // enviado depois que o produto tem ID definitivo; data URLs nunca vão ao servidor.
  const local = source === 'local';
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
  // Depois de um cadastro cujo envio de foto falhou, o formulário passa a editar o produto já criado.
  const current = form.id ? (data.products.find((p) => p.id === form.id) ?? product) : null;
  const isNew = !current;
  const [errors, setErrors] = useState<FieldErrors>({});
  const [imgError, setImgError] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const busy = stage !== 'idle';

  const [upload, setUpload] = useState<ImageUploadConfig | null>(null);
  const [pending, setPending] = useState<PendingImage | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const alive = useRef(true);
  const pendingUrl = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    if (!local) {
      actions.imageUploadConfig().then((c) => alive.current && setUpload(c));
    }
    return () => {
      alive.current = false;
      if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    };
  }, [actions, local]);

  const replacePending = (next: PendingImage | null) => {
    if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    pendingUrl.current = next?.previewUrl ?? null;
    setPending(next);
  };

  const set = <K extends keyof ProductFormInput>(k: K, v: ProductFormInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const onFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (local) {
      try {
        set('imageUrl', await compressImage(file));
        setImgError('');
      } catch (e) {
        setImgError((e as Error).message);
      }
      return;
    }
    if (!upload?.available) return;
    setStage('compressing');
    try {
      const blob = await compressForUpload(file, upload.maxBytes);
      if (!alive.current) return;
      replacePending({ blob, previewUrl: URL.createObjectURL(blob) });
      setRemoveImage(false);
      setImgError('');
    } catch (e) {
      if (alive.current) setImgError((e as Error).message);
    } finally {
      if (alive.current) setStage('idle');
    }
  };

  const save = async () => {
    if (busy) return;
    setStage('saving');
    const r = await actions.saveProduct(form);
    // Sessão encerrada (logout) ou formulário fechado: nenhuma reação na tela.
    if (!alive.current || (!r.ok && r.aborted)) return;
    if (!r.ok) {
      setStage('idle');
      if (r.storageFull) {
        setImgError(r.error);
        return toast('Produto não salvo: sem espaço para a imagem.');
      }
      setErrors(r.fieldErrors ?? {});
      if (r.fieldErrors?.image) setImgError(r.fieldErrors.image);
      return toast(r.error);
    }
    if (local) {
      setStage('idle');
      onClose();
      if (!r.persisted) return toast('Alterações aplicadas apenas nesta sessão: não foi possível salvar no navegador.');
      return toast(isNew ? (r.product.published ? 'Produto cadastrado e publicado no catálogo.' : 'Produto cadastrado (oculto do catálogo).') : 'Alterações salvas.');
    }

    // API: o produto já tem ID definitivo; a foto é tratada à parte e só depois disso.
    const saved = r.product;
    setForm((f) => ({ ...f, id: saved.id, imageUrl: saved.imageUrl }));
    const savedMsg = isNew ? 'Produto cadastrado' : 'Alterações salvas';
    if (pending) {
      setStage('uploading');
      const u = await actions.uploadProductImage(saved.id, pending.blob);
      if (!alive.current || (!u.ok && u.aborted)) return;
      if (!u.ok) {
        setStage('idle');
        // A foto anterior (se houver) continua; a nova fica selecionada para tentar de novo.
        setImgError(`A foto não foi enviada: ${u.fieldErrors?.image ?? u.error} Clique em “Salvar produto” para tentar de novo.`);
        return toast(`${savedMsg}, mas a foto não foi enviada.`);
      }
      replacePending(null);
    } else if (removeImage && saved.imageUrl) {
      setStage('removing');
      const d = await actions.removeProductImage(saved.id);
      if (!alive.current || (!d.ok && d.aborted)) return;
      if (!d.ok) {
        setStage('idle');
        setImgError(`A foto não foi removida: ${d.error}`);
        return toast(`${savedMsg}, mas a foto não foi removida.`);
      }
    }
    setStage('idle');
    onClose();
    toast(isNew ? (saved.published ? `${savedMsg} e publicado no catálogo.` : `${savedMsg} (oculto do catálogo).`) : `${savedMsg}.`);
  };

  const title = isNew ? 'Novo produto' : 'Editar produto';
  const invalid = (k: string) => ({ 'aria-invalid': !!errors[k], 'aria-describedby': errors[k] ? `pf-${k}-err` : undefined });
  // Foto atual: na demo, a do formulário; na API, a URL vinda do servidor (nunca uma data URL).
  const serverImage = local ? '' : form.imageUrl.startsWith('data:') ? '' : form.imageUrl;
  const keptImage = local ? form.imageUrl : removeImage ? '' : serverImage;
  const preview = pending?.previewUrl || keptImage || artFor({ id: form.id ?? '', categoryId: form.categoryId });
  const canPick = local || !!upload?.available;
  const canRemove = !busy && (local ? !!form.imageUrl : !!pending || !!keptImage);

  const removeClick = () => {
    setImgError('');
    if (local) return set('imageUrl', '');
    if (pending) return replacePending(null);
    setRemoveImage(true);
  };

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
            <img src={preview} alt={pending ? 'Pré-visualização da nova foto' : 'Pré-visualização'} />
          </div>
          <div className="pf-image__controls">
            <span style={{ fontSize: 14, fontWeight: 700 }}>Imagem do produto</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {canPick && (
                <label className={`btn btn--secondary pf-image__pick${busy ? ' is-disabled' : ''}`} aria-disabled={busy || undefined}>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    disabled={busy}
                    onChange={(e) => onFile(e.currentTarget)}
                  />
                  <Icon name="upload" />
                  {keptImage || pending ? 'Trocar imagem' : 'Escolher imagem'}
                </label>
              )}
              {canRemove && (
                <button type="button" className="btn btn--danger" onClick={removeClick}>
                  {pending && !local ? 'Descartar nova foto' : 'Remover'}
                </button>
              )}
              {removeImage && !pending && (
                <button type="button" className="btn btn--secondary" onClick={() => setRemoveImage(false)} disabled={busy}>
                  Manter foto atual
                </button>
              )}
            </div>
            {STAGE_LABEL[stage] && stage !== 'saving' && (
              <div className="pf-image__progress" role="status">
                <progress aria-label={STAGE_LABEL[stage]} />
                <span>{STAGE_LABEL[stage]}</span>
              </div>
            )}
            {local ? (
              <span className="field-hint" style={{ fontWeight: 400 }}>
                JPEG, PNG ou WebP até 8 MB (reduzida para 600 px). Sem foto, o catálogo usa a ilustração demonstrativa.
              </span>
            ) : upload === null ? (
              <span className="field-hint" style={{ fontWeight: 400 }}>
                Verificando o envio de fotos…
              </span>
            ) : upload.available ? (
              <span className="field-hint" style={{ fontWeight: 400 }}>
                {pending
                  ? 'Nova foto pronta: será enviada ao salvar o produto.'
                  : removeImage
                    ? 'A foto será removida ao salvar o produto.'
                    : 'JPEG, PNG ou WebP até 8 MB (reduzida para 1200 px antes do envio). Sem foto, o catálogo usa a ilustração padrão.'}
              </span>
            ) : (
              <span className="field-hint" style={{ fontWeight: 400 }}>
                O envio de fotos ainda não está disponível neste ambiente. O produto pode ser salvo normalmente e usa a ilustração padrão da
                categoria até lá.
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
            <div className="field-static">{current.stock} un. em estoque</div>
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
        <button type="submit" form="product-form" className="btn btn--primary btn--md" style={{ fontSize: 15, padding: '0 22px' }} disabled={busy}>
          Salvar produto
        </button>
      </div>
    </Modal>
  );
}
