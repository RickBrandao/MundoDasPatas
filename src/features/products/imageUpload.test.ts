import { afterEach, describe, expect, it, vi } from 'vitest';
import { UPLOAD_RULES, compressForUpload, validateImageFile } from './imageUpload';

/**
 * jsdom não tem canvas nem decodificador de imagens: `createImageBitmap` e o canvas são simulados.
 * `sizes` define o tamanho de cada arquivo gerado (em ordem), para exercitar a redução de qualidade/tamanho.
 */
function stubCanvas({ width = 4000, height = 3000, webp = true, sizes = [200_000] as number[] } = {}) {
  const drawn: { w: number; h: number }[] = [];
  const encoded: { type: string; quality: number }[] = [];
  let i = 0;
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width, height, close: vi.fn() })));
  const ctx = { drawImage: vi.fn(), fillRect: vi.fn(), fillStyle: '', imageSmoothingQuality: '' };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    drawn.push({ w: this.width, h: this.height });
    return ctx as unknown as CanvasRenderingContext2D;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb, type = 'image/png', quality = 1) => {
    encoded.push({ type, quality });
    const out = type === 'image/webp' && !webp ? 'image/png' : type;
    const size = sizes[Math.min(i++, sizes.length - 1)];
    cb(new Blob([new Uint8Array(size)], { type: out }));
  });
  return { drawn, encoded, ctx };
}

const file = (type = 'image/jpeg', size = 1000) => new File([new Uint8Array(size)], 'foto', { type });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('compressForUpload', () => {
  it('reduz para 1200 px no maior lado e gera WebP', async () => {
    const { drawn, encoded } = stubCanvas({ width: 4000, height: 3000 });
    const blob = await compressForUpload(file(), 2_000_000);
    expect(blob.type).toBe('image/webp');
    expect(drawn[0]).toEqual({ w: 1200, h: 900 });
    expect(encoded[0]).toEqual({ type: 'image/webp', quality: UPLOAD_RULES.qualities[0] });
  });

  it('não amplia imagens pequenas', async () => {
    const { drawn } = stubCanvas({ width: 300, height: 200 });
    await compressForUpload(file('image/png'), 2_000_000);
    expect(drawn[0]).toEqual({ w: 300, h: 200 });
  });

  it('baixa a qualidade e depois o tamanho até caber no limite', async () => {
    const { encoded, drawn } = stubCanvas({ sizes: [3_000_000, 2_500_000, 2_000_000, 500_000] });
    const blob = await compressForUpload(file(), 1_000_000);
    expect(blob.size).toBe(500_000);
    expect(encoded.map((e) => e.quality)).toEqual([...UPLOAD_RULES.qualities, UPLOAD_RULES.qualities[0]]);
    expect(drawn.at(-1)).toEqual({ w: 900, h: 675 });
  });

  it('desiste com mensagem clara quando nada cabe', async () => {
    stubCanvas({ sizes: [9_000_000] });
    await expect(compressForUpload(file(), 1_000_000)).rejects.toThrow('grande demais');
  });

  it('navegador sem WebP: usa JPEG com fundo branco', async () => {
    const { encoded, ctx } = stubCanvas({ webp: false });
    const blob = await compressForUpload(file(), 2_000_000);
    expect(blob.type).toBe('image/jpeg');
    expect(encoded.map((e) => e.type)).toEqual(['image/webp', 'image/jpeg']);
    expect(ctx.fillStyle).toBe('#fff');
  });

  it('arquivo que não é imagem (extensão falsa) é recusado na decodificação', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new DOMException('bad', 'InvalidStateError'))));
    await expect(compressForUpload(file(), 2_000_000)).rejects.toThrow('corrompida ou não é uma imagem válida');
  });

  it('tipo não aceito e original acima de 8 MB são recusados antes de decodificar', async () => {
    const decode = vi.fn();
    vi.stubGlobal('createImageBitmap', decode);
    await expect(compressForUpload(file('image/svg+xml'), 2_000_000)).rejects.toThrow('Formato não suportado');
    await expect(compressForUpload(file('image/gif'), 2_000_000)).rejects.toThrow('Formato não suportado');
    await expect(compressForUpload(file('image/jpeg', 8 * 1024 * 1024 + 1), 2_000_000)).rejects.toThrow('máx. 8 MB');
    expect(decode).not.toHaveBeenCalled();
    expect(validateImageFile({ type: 'image/webp', size: 10 })).toBeNull();
  });
});
