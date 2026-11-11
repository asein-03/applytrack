import { createLocalOcrWorker, matchVisualConfirmation } from '../../src/capture';

const button = document.querySelector<HTMLButtonElement>('button')!;
const status = document.querySelector<HTMLOutputElement>('output')!;
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const context = canvas.getContext('2d')!;
context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = 'black'; context.font = 'bold 52px Arial';
context.fillText('Your application has been received', 48, 90);
context.font = '44px Arial'; context.fillText('Example Labs', 48, 175); context.fillText('Product Designer', 48, 250);
button.addEventListener('click', async () => {
  button.disabled = true; status.value = 'Reading sample image';
  let worker;
  try {
    worker = await createLocalOcrWorker(error => { status.value = `OCR failed: ${String(error)}`; });
    const result = await worker.recognize(canvas);
    const finding = matchVisualConfirmation(result.data.text, []);
    document.querySelector<HTMLPreElement>('pre')!.textContent = result.data.text;
    status.value = finding ? 'Confirmation recognized' : 'No confirmation found';
  } catch { status.value = 'OCR failed'; }
  finally { await worker?.terminate(); button.disabled = false; }
});
