const pdfAssets = new URL('./node_modules/pdfjs-dist/', import.meta.url);
const pdfModule = new URL('legacy/build/pdf.mjs', pdfAssets);
const pdfjsLib = await import(pdfModule.href);

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('legacy/build/pdf.worker.min.mjs', pdfAssets).href;

export function openPricePdf(buffer) {
  return pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    enableScripting: false,
    useWasm: false,
    cMapPacked: true,
    cMapUrl: new URL('cmaps/', pdfAssets).href,
    standardFontDataUrl: new URL('standard_fonts/', pdfAssets).href
  });
}
