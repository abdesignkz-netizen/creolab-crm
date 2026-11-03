import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = await readFile(resolve(root, '../web/public/favicon-basqar.svg'));
const target = resolve(root, 'assets');
await mkdir(target, { recursive: true });
// Reuse the existing BasQar mark. No replacement brand or generated artwork.
await sharp(source).resize(1024, 1024).flatten({ background: '#FFFFFF' }).png().toFile(resolve(target, 'icon.png'));
await sharp(source).resize(512, 512).flatten({ background: '#FFFFFF' }).png().toFile(resolve(target, 'play-store-icon.png'));
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#FFFFFF' } })
  .composite([{ input: await sharp(source).resize(600, 600).png().toBuffer(), gravity: 'center' }])
  .png().toFile(resolve(target, 'adaptive-icon.png'));
await sharp(source).resize(512, 512).png().toFile(resolve(target, 'splash.png'));
const notification = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><path fill="white" d="M12 12h72v54H43L19 85V66h-7V12zm10 10v34h7v9l11-9h34V22H22z"/></svg>';
await sharp(Buffer.from(notification)).resize(96, 96).png().toFile(resolve(target, 'notification-icon.png'));
await writeFile(resolve(target, 'README.md'), '# BasQar assets\n\nThe application icon and splash reuse `apps/web/public/favicon-basqar.svg`.\nThe Android notification mark is a white silhouette on a transparent background.\nRegenerate with `node apps/mobile/scripts/generate-assets.mjs` (sharp required).\n');
