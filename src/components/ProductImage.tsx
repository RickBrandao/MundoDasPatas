import { useState, type ImgHTMLAttributes } from 'react';
import type { Product } from '../domain/types';
import { artFor, imageFor } from './productArt';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'onError'> & {
  product: Pick<Product, 'id' | 'categoryId' | 'imageUrl'>;
  /** Avisado quando a foto não carrega e a ilustração passa a ser exibida. */
  onFallback?: () => void;
};

/**
 * Foto do produto; se o arquivo não carregar (removido, rede, link inválido), mostra a ilustração
 * da categoria em vez de uma imagem quebrada.
 */
export function ProductImage({ product, onFallback, alt = '', ...rest }: Props) {
  const { src, isArt } = imageFor(product);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const broken = !isArt && failedSrc === src;
  return (
    <img
      {...rest}
      alt={alt}
      src={broken ? artFor(product) : src}
      onError={() => {
        if (isArt || broken) return;
        setFailedSrc(src);
        onFallback?.();
      }}
    />
  );
}
