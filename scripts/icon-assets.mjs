import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const iconAssetsDir = path.join(projectRoot, 'assets', 'icons');

/** Source artwork checked into the repo (do not edit generated files by hand). */
export const iconSources = {
  extensionActive: path.join(iconAssetsDir, 'source-extension-active.png'),
  extensionInactive: path.join(iconAssetsDir, 'source-extension-inactive.png'),
};

/** Browser extension toolbar / manifest raster sizes. */
export const extensionIconSizes = [32, 48, 64, 128];
