/** Limites da demo: a foto vira data URL no localStorage, então precisa ser pequena. `maxBytes` é o arquivo original (vale também para o envio). */
export const IMAGE_RULES = {
  types: ['image/jpeg', 'image/png', 'image/webp'],
  maxBytes: 8 * 1024 * 1024,
  maxSide: 600,
  maxDataUrlLength: 450_000,
};

export function validateImageFile(file: Pick<File, 'type' | 'size'>): string | null {
  if (!IMAGE_RULES.types.includes(file.type)) return 'Formato não suportado. Use JPEG, PNG ou WebP.';
  if (file.size > IMAGE_RULES.maxBytes) return 'Arquivo muito grande (máx. 8 MB).';
  return null;
}

/** Lê, reduz para no máximo 600 px e comprime em JPEG. Rejeita com mensagem amigável. */
export function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const invalid = validateImageFile(file);
    if (invalid) return reject(new Error(invalid));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('A imagem parece corrompida. Tente outro arquivo.'));
      img.onload = () => {
        try {
          const k = Math.min(1, IMAGE_RULES.maxSide / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * k));
          canvas.height = Math.max(1, Math.round(img.height * k));
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error();
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          let url = canvas.toDataURL('image/jpeg', 0.8);
          if (url.length > 350_000) url = canvas.toDataURL('image/jpeg', 0.6);
          if (url.length > IMAGE_RULES.maxDataUrlLength) {
            return reject(new Error('Mesmo comprimida, a imagem ficou grande demais para a demonstração.'));
          }
          resolve(url);
        } catch {
          reject(new Error('Falha ao converter a imagem.'));
        }
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Painel com a API: a foto vai ao servidor (Cloud Storage) como arquivo, nunca como data URL.
 * Reduzida para no máximo 1200 px e comprimida em WebP (JPEG se o navegador não gerar WebP).
 * O servidor confere tudo de novo e recodifica; aqui o objetivo é enviar pouco (tipicamente 100–400 KB).
 */
export const UPLOAD_RULES = {
  maxSide: 1200,
  /** Alvo de tamanho; o limite real vem do servidor (`maxBytes`). */
  targetBytes: 900_000,
  qualities: [0.85, 0.75, 0.62],
};

export async function compressForUpload(file: File, maxBytes: number): Promise<Blob> {
  const invalid = validateImageFile(file);
  if (invalid) throw new Error(invalid);
  const source = await decode(file);
  try {
    const limit = Math.min(maxBytes, UPLOAD_RULES.targetBytes);
    let side = UPLOAD_RULES.maxSide;
    for (let round = 0; round < 3; round++) {
      const canvas = draw(source, side);
      for (const quality of UPLOAD_RULES.qualities) {
        const blob = await encode(canvas, quality);
        if (blob.size <= limit) return blob;
      }
      side = Math.round(side * 0.75);
    }
    throw new Error('Mesmo comprimida, a imagem ficou grande demais. Tente outro arquivo.');
  } finally {
    if ('close' in source) source.close();
  }
}

type Source = ImageBitmap | HTMLImageElement;
const sizeOf = (s: Source) => ('naturalWidth' in s ? { w: s.naturalWidth, h: s.naturalHeight } : { w: s.width, h: s.height });

/** Decodifica respeitando a orientação EXIF (fotos de celular). Falha = arquivo que não é imagem válida. */
async function decode(file: File): Promise<Source> {
  const corrupt = () => new Error('A imagem parece corrompida ou não é uma imagem válida. Tente outro arquivo.');
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw corrupt();
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(corrupt());
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function draw(source: Source, maxSide: number): HTMLCanvasElement {
  const { w, h } = sizeOf(source);
  if (!w || !h) throw new Error('A imagem parece corrompida ou não é uma imagem válida. Tente outro arquivo.');
  const k = Math.min(1, maxSide / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Falha ao converter a imagem.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

async function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const webp = await toBlob(canvas, 'image/webp', quality);
  // Navegadores sem codificador WebP devolvem PNG: usa JPEG (fundo branco no lugar da transparência).
  if (webp?.type === 'image/webp') return webp;
  const flat = document.createElement('canvas');
  flat.width = canvas.width;
  flat.height = canvas.height;
  const ctx = flat.getContext('2d');
  if (!ctx) throw new Error('Falha ao converter a imagem.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, flat.width, flat.height);
  ctx.drawImage(canvas, 0, 0);
  const jpeg = await toBlob(flat, 'image/jpeg', quality);
  if (!jpeg) throw new Error('Falha ao converter a imagem.');
  return jpeg;
}
