// Export SVG to PNG (sharp) and PDF (pdf-lib). Sheet units map ~1:1 to PostScript
// points (the standard frame is 1160x820 units ≈ A4 landscape in points).
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

export async function svgToPng(svgString, { scale = 4, background = '#FFFFFF' } = {}) {
  // scale: raster pixels per sheet unit (4 ≈ 288 DPI for a 1160-unit A4 sheet)
  return sharp(Buffer.from(svgString), { density: 72 * scale })
    .flatten({ background })
    .png()
    .toBuffer();
}

export async function svgToPdf(svgString, { scale = 4, title = 'LCEDA Schematic' } = {}) {
  const png = await svgToPng(svgString, { scale });
  const pdf = await PDFDocument.create();
  const img = await pdf.embedPng(png);
  // page size from the SVG viewBox (1:1 units -> points)
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svgString);
  let w = 1160, h = 820;
  if (vb) { w = parseFloat(vb[3]); h = parseFloat(vb[4]); }
  const page = pdf.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  page.drawText('', { size: 1 });
  pdf.setTitle(title);
  pdf.setProducer('lceda-ai');
  return Buffer.from(await pdf.save());
}
