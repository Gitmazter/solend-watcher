import { atom } from 'jotai';
import { getTokensInfo } from 'utils/metadata';
import { unqiueAssetsAtom } from './pools';

export type TokenMetadata = {
  [mintAddress: string]: {
    symbol: string;
    logoUri: string | null;
    decimals: number;
  };
};

export const metadataAtom = atom<TokenMetadata>({});

export const loadMetadataAtom = atom(
  (get) => {
    get(metadataAtom);
  },
  async (get, set) => {
    const mints = get(unqiueAssetsAtom);

    if (mints.length) {
      set(metadataAtom, await getTokensInfo(mints));
    }
  },
);