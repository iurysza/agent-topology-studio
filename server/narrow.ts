// Narrowing for values whose type a catch clause or a Node API leaves open. Imports nothing.
import type { AddressInfo, Server } from 'node:net';

export type Hinted = Error & { readonly hint: string };

type WithMessage = { readonly message: string };

type Address = ReturnType<Server['address']>;

export const isErrno = (cause: unknown): cause is NodeJS.ErrnoException => cause instanceof Error && 'code' in cause;

export const isHinted = (cause: unknown): cause is Hinted => cause instanceof Error && 'hint' in cause && typeof cause.hint === 'string';

const hasMessage = (cause: unknown): cause is WithMessage => typeof cause === 'object' && cause !== null && 'message' in cause && typeof cause.message === 'string';

// The old `e.message`: the string when there is one, else undefined.
export const messageOf = (cause: unknown): string | undefined => hasMessage(cause) ? cause.message : undefined;

export const isAddressInfo = (address: Address): address is AddressInfo => typeof address === 'object' && address !== null;
