import { useState } from 'react';
import { useStore, useToast } from '../../app/contexts';
import { Modal } from '../../components/Modal';
import type { Category } from '../../domain/types';

export function CategoryFormModal({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const { actions } = useStore();
  const toast = useToast();
  const [name, setName] = useState(category?.name ?? '');
  const [error, setError] = useState('');
  const title = category ? 'Editar categoria' : 'Nova categoria';

  const save = async () => {
    const r = await actions.saveCategory({ id: category?.id ?? null, name });
    if (!r.ok) return setError(r.error);
    onClose();
    toast(r.created ? 'Categoria criada.' : 'Categoria atualizada.');
  };

  return (
    <Modal label={title} onClose={onClose} className="dialog dialog--padded" style={{ maxWidth: 440 }}>
      <h2 className="dialog-title">{title}</h2>
      <form
        noValidate
        style={{ display: 'contents' }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          Nome da categoria
          <input
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError('');
            }}
            placeholder="Ex.: Aquarismo"
            aria-invalid={!!error}
          />
        </label>
        {error && (
          <div role="alert" className="field-error">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn--secondary btn--md" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn--primary btn--md" style={{ padding: '0 22px' }}>
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}
