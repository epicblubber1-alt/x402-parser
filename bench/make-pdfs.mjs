// Generates the three benchmark documents into bench/samples/.
// All are born-digital text PDFs (no scans — OCR is out of scope at the edge).
import { PDFDocument, StandardFonts } from "pdf-lib";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");

const LOREM =
  "Speed is the product. This synthetic paragraph exists to give the parser " +
  "honest work: glyph positioning, line assembly, and page-level text flow. ";

async function makeTextPdf(pageCount) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([612, 792]); // US Letter
    for (let line = 0; line < 40; line++) {
      page.drawText(`p${p + 1}/${pageCount} L${line + 1}: ${LOREM}`.slice(0, 110), {
        x: 36,
        y: 756 - line * 18,
        size: 10,
        font,
      });
    }
  }
  return doc;
}

async function main() {
  await mkdir(SAMPLES_DIR, { recursive: true });

  const two = await makeTextPdf(2);
  await writeFile(path.join(SAMPLES_DIR, "text-2p.pdf"), await two.save());

  const fifty = await makeTextPdf(50);
  await writeFile(path.join(SAMPLES_DIR, "text-50p.pdf"), await fifty.save());

  // ~5MB: a normal text PDF padded with an incompressible attachment, so the
  // byte size is real but the text content stays parseable.
  const big = await makeTextPdf(10);
  await big.attach(randomBytes(4_900_000), "ballast.bin", {
    mimeType: "application/octet-stream",
    description: "incompressible padding to reach ~5MB",
  });
  const bigBytes = await big.save();
  await writeFile(path.join(SAMPLES_DIR, "text-5mb.pdf"), bigBytes);

  console.log(`Wrote samples to ${SAMPLES_DIR}`);
  console.log(`  text-5mb.pdf is ${(bigBytes.length / 1048576).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
