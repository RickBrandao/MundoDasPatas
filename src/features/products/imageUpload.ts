/** Limites da demo: a foto vira data URL no localStorage, então precisa ser pequena. */
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
