import path from 'node:path';
import {Repository} from '@aiverse/core';

export interface RepositoryResolutionOptions { cwd?: string; initCwd?: string; explicitRoot?: string; autoInit?: boolean; }

export async function resolveRepository(options: RepositoryResolutionOptions = {}): Promise<{repo: Repository; initialized: boolean}> {
  const requested = path.resolve(options.explicitRoot ?? options.initCwd ?? options.cwd ?? process.cwd());
  try { return {repo: await Repository.open(requested), initialized: false}; }
  catch (error) {
    if (!options.autoInit) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nSet MINIGIT_REPO to an initialized repository or run "minigit init".`);
    }
    return {repo: await Repository.init(requested), initialized: true};
  }
}

